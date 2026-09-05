// Patched Codex model catalog: the bundled `codex debug models` catalog with
// GitHub Copilot's live context-window limits overlaid per model slug.
//
// Codex's bundled catalog understates Copilot's serving limits (e.g. gpt-5.5
// ships as 272k while Copilot serves a 1.05M window with a 922k prompt cap),
// and limits differ per model, so Codex's single global `model_context_window`
// override cannot express them. Codex's top-level `model_catalog_json` config
// key points at a JSON catalog that REPLACES the bundled one wholesale -- a
// missing or unparseable file is a Codex startup error -- so the generated file
// must always be complete (every bundled model, patched or not) and valid, and
// the managed config only references it when it exists (src/codex/config.ts).
//
// Generation is best-effort and never throws: it runs at config-wiring time
// (the seed, `applyCodexConfig`) and at auth time (`agent auth --get` /
// `--print-proxy-token`, which Codex re-runs every 300s) throttled to one
// ATTEMPT per day -- attempt, not success, so a broken upstream cannot retry
// inside every Codex auth refresh and its bounded auth timeout budget
// (DIRECT_AUTH_TIMEOUT_MS, src/codex/config.ts).
//
// The whole feature is OPT-IN (`agent config --set codex-model-catalog true`):
// when disabled, generation and refresh are no-ops here, and the config writer
// / auth-time sync (src/codex/config.ts) remove the artifacts.
//
// Codex parses the file strictly (a missing required field is a startup error)
// but ignored unknown fields in every public version checked (0.152.0 through
// main), so the file is a SUPERSET of the installed CLI's dump, and that CLI is
// asked to parse it before it is used -- the probe governs the versions to come.
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { stringify } from "smol-toml";
import { isDue } from "../autoupdate/due.ts";
import { BOUNDED_LOCK_POLICY } from "../utils/file_lock.ts";
import { type CatalogSource, fetchRawModels } from "../copilot_api/catalog.ts";
import { atomicWriteFile } from "../copilot_api/config.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { CopilotEnvState } from "../copilot_api/env_state.ts";
import { ONE_M_SUFFIX } from "../copilot_api/models.ts";
import { CopilotApiPaths } from "../copilot_api/paths.ts";
import { childEnvWithPath, cliSpawn, resolveCommand } from "../utils/command.ts";
import { errMessage } from "../utils/error.ts";
import { isRecord } from "../utils/json.ts";
import { createStderrLogger } from "../utils/logger.ts";

const logger = createStderrLogger();

/**
 * Bump when patchModelCatalog's OUTPUT changes shape (fields patched or stripped):
 * a recorded mismatch bypasses the daily refresh throttle once, so an existing
 * catalog picks up the new patch on the next refresh instead of serving the old
 * shape for up to a day after a copilot-env update.
 */
export const CATALOG_PATCH_VERSION = 3;

// The codex runs below are local-only (no network) but may cold-start the CLI.
const CODEX_VERSION_TIMEOUT_MS = 1000;
const BUNDLED_DUMP_TIMEOUT_MS = 5000;
// One budget for EVERY probe spawn in this process (candidate runs and their
// controls, across generation and the auth-time sync); see probeBudget below.
const CATALOG_PROBE_TIMEOUT_MS = 5000;
// One deadline over the whole Copilot fetch, identity probes included (a PAT can
// chain several probes before the GET); past it the fetch is aborted.
const COPILOT_FETCH_BUDGET_MS = 5000;
// The refresh's end-to-end deadline: its bounded steps, summed. Past it, the cache
// writes (acceptance memo, ownership ledger) are skipped -- they are caches.
const REFRESH_DEADLINE_MS = CODEX_VERSION_TIMEOUT_MS + COPILOT_FETCH_BUDGET_MS +
  BUNDLED_DUMP_TIMEOUT_MS + CATALOG_PROBE_TIMEOUT_MS;

/** The longest a due refresh can hold up `agent auth --get`: the attempt write's lock
 *  wait, the deadline, and one cache write that began just before the deadline. The
 *  direct provider's auth timeout (DIRECT_AUTH_TIMEOUT_MS) must stay above it. */
export const AUTH_REFRESH_WORST_CASE_MS = BOUNDED_LOCK_POLICY.waitMs + REFRESH_DEADLINE_MS +
  BOUNDED_LOCK_POLICY.waitMs;

// The running refresh's deadline and clock (null outside a refresh: writes allowed).
let refreshDeadline: { at: number; clock: () => number } | null = null;

/** False once the running refresh has passed its deadline: bookkeeping writes
 *  (acceptance memo, ownership ledger) are skipped rather than waiting on a lock. */
export function catalogBookkeepingAllowed(): boolean {
  return refreshDeadline === null || refreshDeadline.clock() < refreshDeadline.at;
}

/** Run `work` (the refresh AND the reference sync that follows it) under one
 *  deadline, so every bookkeeping write along the way answers to the same clock. */
export async function withCatalogRefreshDeadline<T>(
  deps: CodexCatalogDeps,
  work: () => Promise<T>,
): Promise<T> {
  const clock = deps.nowMs ?? Date.now;
  refreshDeadline = { at: clock() + REFRESH_DEADLINE_MS, clock };
  try {
    return await work();
  } finally {
    refreshDeadline = null;
  }
}

/**
 * Set (to any non-empty value) to disable this module's best-effort live
 * lookups -- the installed codex's version, the npm codex-version query, and
 * the installed-codex catalog probe -- which then read as unavailable /
 * unverifiable. The test suite sets it so no test depends on the developer's
 * network or codex install.
 */
export const CI_NO_LIVE_LOOKUPS_ENV = "COPILOT_ENV_CI_NO_LIVE_LOOKUPS";

function liveLookupsDisabled(): boolean {
  return Boolean(process.env[CI_NO_LIVE_LOOKUPS_ENV]);
}

// Where the limits come from; the shared fetch (copilot_api/catalog.ts) owns
// the two roads to the raw `/models` body.
export type { CatalogSource } from "../copilot_api/catalog.ts";

function parseCodexVersion(output: string): string | null {
  return output.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0] ?? null;
}

let cachedCodexVersion: string | null | undefined;

/** The installed codex CLI's version (cached per process), or null when unavailable. */
export function installedCodexVersion(): string | null {
  if (liveLookupsDisabled()) return null;
  if (cachedCodexVersion !== undefined) return cachedCodexVersion;
  // cliSpawn routes through cmd.exe on Windows so a codex.cmd shim is launchable.
  const s = cliSpawn("codex", ["--version"]);
  const result = spawnSync(s.file, s.args, {
    encoding: "utf8",
    timeout: CODEX_VERSION_TIMEOUT_MS,
    windowsHide: true,
    shell: s.shell,
  });
  cachedCodexVersion = result.error || result.status !== 0
    ? null
    : parseCodexVersion(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  return cachedCodexVersion;
}

let cachedNpmCodexVersion: string | null | undefined;

/** The newest @openai/codex release on npm (cached per process), or null when
 *  npm is missing/unreachable. */
function latestNpmCodexVersion(): string | null {
  // A live npm query: off under the suite's seam (tests stay network-free).
  if (liveLookupsDisabled()) return null;
  if (cachedNpmCodexVersion !== undefined) return cachedNpmCodexVersion;
  const s = cliSpawn("npm", ["view", "@openai/codex", "version"]);
  const result = spawnSync(s.file, s.args, {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
    shell: s.shell,
  });
  cachedNpmCodexVersion = result.error || result.status !== 0
    ? null
    : parseCodexVersion(result.stdout ?? "");
  return cachedNpmCodexVersion;
}

/**
 * The codex version to advertise in the managed `codex_exec` User-Agent: the
 * installed CLI's, else the newest npm release, else null (versionless UA).
 * Copilot Direct gates on an editor-client identity, and a real current version
 * is a stronger identity than a bare `codex_exec` -- so a machine without the
 * codex CLI (e.g. Claude-only Direct) still advertises a plausible one. Both
 * lookups are best-effort and cached per process; fully offline stays null,
 * exactly the pre-fallback behavior.
 */
export function codexUserAgentVersion(): string | null {
  return installedCodexVersion() ?? latestNpmCodexVersion();
}

export interface CopilotModelLimits {
  maxContextWindowTokens: number;
  maxPromptTokens: number;
}

/** A list the parser guarantees non-empty (an empty list reads as "unadvertised"). */
export type NonEmpty<T> = [T, ...T[]];

function nonEmpty<T>(list: T[]): NonEmpty<T> | null {
  const [first, ...rest] = list;
  return first === undefined ? null : [first, ...rest];
}

/** One Copilot `/models` entry as the patcher consumes it (parseCopilotModels). */
export interface CopilotCatalogModel {
  limits: CopilotModelLimits;
  /** Copilot's display name, or null when absent. */
  name: string | null;
  /** The reasoning efforts Copilot accepts, or null when not advertised. */
  reasoningEfforts: NonEmpty<string> | null;
  /** Copilot's `supports.parallel_tool_calls`, or null when not advertised. */
  parallelToolCalls: boolean | null;
  /** Codex can drive it: a chat model served on `/responses` and in Copilot's picker. */
  codexServable: boolean;
}

/** Injectable seams for tests (mirrors the DirectProbeDeps DI style). */
export interface CodexCatalogDeps {
  /** `codex debug models --bundled` stdout, or null on failure. */
  bundledCatalog?: () => string | null;
  /** Copilot's catalog by model id, or null on failure. */
  fetchCopilotModels?: (source: CatalogSource) => Promise<Map<string, CopilotCatalogModel> | null>;
  /**
   * Whether the installed codex CLI parses `catalogJson` as a model catalog:
   * false on a schema rejection, null when it cannot be verified (no codex, or
   * a failure unrelated to the catalog). Defaults to the live probe.
   */
  acceptsCatalog?: (catalogJson: string) => boolean | null;
  /**
   * An already-resolved GitHub credential for the direct fetch. `auth --get` has
   * just resolved one; re-resolving inside the refresh would re-run `gh auth token`
   * (up to 5s) and eat into Codex's auth timeout budget for nothing.
   */
  directToken?: string;
  /** The installed codex CLI version (spawned by default; injected in tests). */
  codexVersion?: () => string | null;
  nowMs?: () => number;
}

/** Deps that always fail generation -- for tests that must not spawn or fetch. */
export const NOOP_CATALOG_DEPS: CodexCatalogDeps = {
  bundledCatalog: () => null,
  fetchCopilotModels: async () => null,
  acceptsCatalog: () => null,
  codexVersion: () => null,
};

// Copilot's `/responses` endpoint marker: the only wire Codex speaks.
const RESPONSES_ENDPOINT = "/responses";

/**
 * Read the Codex-relevant facts from a raw Copilot `/models` body -- the same
 * shape upstream and via the proxy. Entries missing either limit number are
 * skipped (the limits are what the overlay exists for); a display-only `[1m]` id
 * suffix is stripped; on duplicate ids the larger window wins.
 */
export function parseCopilotModels(body: unknown): Map<string, CopilotCatalogModel> {
  const out = new Map<string, CopilotCatalogModel>();
  const data = isRecord(body) && Array.isArray(body.data) ? body.data : [];
  for (const entry of data) {
    if (!isRecord(entry) || typeof entry.id !== "string") continue;
    const id = entry.id.endsWith(ONE_M_SUFFIX) ? entry.id.slice(0, -ONE_M_SUFFIX.length) : entry.id;
    const capabilities = entry.capabilities;
    if (!isRecord(capabilities) || !isRecord(capabilities.limits)) continue;
    const window = capabilities.limits.max_context_window_tokens;
    const prompt = capabilities.limits.max_prompt_tokens;
    if (typeof window !== "number" || !Number.isFinite(window) || window <= 0) continue;
    if (typeof prompt !== "number" || !Number.isFinite(prompt) || prompt <= 0) continue;
    const supports = isRecord(capabilities.supports) ? capabilities.supports : {};
    // An empty (or all ill-typed) list says nothing: unadvertised, like an absent one.
    const efforts = Array.isArray(supports.reasoning_effort)
      ? supports.reasoning_effort.filter((e): e is string => typeof e === "string")
      : [];
    const endpoints = Array.isArray(entry.supported_endpoints) ? entry.supported_endpoints : [];
    const parsed: CopilotCatalogModel = {
      limits: { maxContextWindowTokens: window, maxPromptTokens: prompt },
      name: typeof entry.name === "string" ? entry.name : null,
      reasoningEfforts: nonEmpty(efforts),
      parallelToolCalls: typeof supports.parallel_tool_calls === "boolean"
        ? supports.parallel_tool_calls
        : null,
      codexServable: capabilities.type === "chat" && entry.model_picker_enabled === true &&
        endpoints.includes(RESPONSES_ENDPOINT),
    };
    const existing = out.get(id);
    out.set(id, existing === undefined ? parsed : mergeCopilotModels(existing, parsed));
  }
  return out;
}

/** Two `/models` entries for one id (a base and its `[1m]` twin): the larger
 *  window's entry speaks first on every fact, the other fills what it left
 *  null, and servable when either is -- so input order cannot decide what
 *  survives (twins with equal windows, which Copilot does not serve, keep the
 *  first seen). */
function mergeCopilotModels(a: CopilotCatalogModel, b: CopilotCatalogModel): CopilotCatalogModel {
  const [first, second] = b.limits.maxContextWindowTokens > a.limits.maxContextWindowTokens
    ? [b, a]
    : [a, b];
  return {
    limits: first.limits,
    name: first.name ?? second.name,
    reasoningEfforts: first.reasoningEfforts ?? second.reasoningEfforts,
    parallelToolCalls: first.parallelToolCalls ?? second.parallelToolCalls,
    codexServable: first.codexServable || second.codexServable,
  };
}

/**
 * Fields a Codex consumer is known to require that no public dump carries, and
 * the value written when the dump lacks them (a dump value always wins).
 * `supports_parallel_tool_calls`: required at startup by a codex-core build
 * sharing ~/.codex (seen 2026-09-04), absent from ModelInfo in every public tag
 * 0.152.0..main; Copilot advertises the same capability, false when unknown.
 */
function requiredExtras(copilot: CopilotCatalogModel | undefined): Record<string, unknown> {
  return { "supports_parallel_tool_calls": copilot?.parallelToolCalls ?? false };
}

// The Codex catalog's numbered OpenAI family, `gpt-<major>[.<minor>[.<patch>]]`
// with an optional `-<variant>`: the only entries a Copilot-only model can be
// cloned from, and the only Copilot ids cloned (a codename like gpt-daybreak-*
// has no version to place it by).
const GPT_SLUG = /^gpt-(\d+(?:\.\d+){0,2})(?=-|$)/;

/** The gpt slug's version as one ordered integer (5.6 -> 5006000, 5.10 ->
 *  5010000, 5.3.1 -> 5003001), or null outside the numbered family -- including
 *  a minor or patch segment past 999, which the encoding could not keep apart. */
function gptVersion(slug: string): number | null {
  const match = GPT_SLUG.exec(slug);
  if (match === null) return null;
  const [major = 0, minor = 0, patch = 0] = (match[1] ?? "").split(".").map(Number);
  if (minor > 999 || patch > 999) return null;
  return major * 1_000_000 + minor * 1000 + patch;
}

function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * The bundled gpt-* entry a Copilot-only `id` is cloned from: the same version
 * with the longest shared slug prefix (gpt-5.6-sol-fast -> gpt-5.6-sol), else
 * the nearest version, newer on a tie (gpt-6-astra -> gpt-5.6-*, gpt-5.3-codex ->
 * gpt-5.4); dump order breaks remaining ties. Null when no gpt-* entry exists.
 */
function pickDonor(
  id: string,
  donors: { slug: string; model: Record<string, unknown> }[],
): Record<string, unknown> | null {
  const version = gptVersion(id);
  if (version === null) return null;
  let best: { distance: number; tieBreak: number; model: Record<string, unknown> } | null = null;
  for (const donor of donors) {
    const donorVersion = gptVersion(donor.slug);
    if (donorVersion === null) continue;
    const distance = Math.abs(version - donorVersion);
    // Lower wins on both: closest version first, then the longest shared prefix
    // (same version) or the newest donor (different version).
    const tieBreak = distance === 0 ? -commonPrefixLength(id, donor.slug) : -donorVersion;
    if (
      best === null || distance < best.distance ||
      (distance === best.distance && tieBreak < best.tieBreak)
    ) {
      best = { distance, tieBreak, model: donor.model };
    }
  }
  return best?.model ?? null;
}

/**
 * Write Copilot's limits onto `model`: `context_window`/`max_context_window`
 * become the total window, and `effective_context_window_percent` becomes
 * floor(prompt/window * 100) -- Codex compacts at that fraction of the window,
 * and Copilot rejects prompts over its per-request cap, so the default 95% of a
 * 1.05M window would 413 upstream before Codex ever auto-compacts. False (no
 * write) on a degenerate ratio.
 */
function applyLimits(model: Record<string, unknown>, limits: CopilotModelLimits): boolean {
  const percent = Math.min(
    100,
    Math.floor((limits.maxPromptTokens / limits.maxContextWindowTokens) * 100),
  );
  if (percent < 1) return false;
  model.context_window = limits.maxContextWindowTokens;
  model.max_context_window = limits.maxContextWindowTokens;
  model.effective_context_window_percent = percent;
  return true;
}

// Bundled fields that advertise service tiers: they make Codex send
// `service_tier`, which Copilot's /responses endpoint rejects outright, and this
// catalog only ever wires Codex at Copilot. Emptied, never deleted, so the
// generated entry keeps every key the dump has.
const TIER_FIELDS = ["service_tiers", "additional_speed_tiers"] as const;

/**
 * A Copilot-only model as a Codex entry: `donor` cloned whole (instructions,
 * tools, modalities -- the family's Codex-side shape), then Copilot's identity
 * and limits written over it. Donor-specific claims are dropped: no `upgrade`
 * target, no availability notice, no `comp_hash` (compaction compatibility is
 * the donor's, not this model's); it is listed and API-served in its own right. Reasoning levels narrow to the efforts
 * Copilot lists for the model (unadvertised keeps the donor's); null (no clone)
 * when a listed set shares none.
 */
function cloneForCopilotModel(
  donor: Record<string, unknown>,
  id: string,
  copilot: CopilotCatalogModel,
  priority: number,
): Record<string, unknown> | null {
  const model = structuredClone(donor);
  if (!applyLimits(model, copilot.limits)) return null;
  const name = copilot.name ?? id;
  model.slug = id;
  model.display_name = name;
  model.description = `${name}, served by GitHub Copilot (not bundled with Codex)`;
  model.visibility = "list";
  // Copilot serves it on the API by construction (codexServable), whatever the donor says.
  model.supported_in_api = true;
  model.priority = priority;
  model.upgrade = null;
  model.availability_nux = null;
  // comp_hash hashes the DONOR's own content; copying it would misdescribe the clone.
  delete model.comp_hash;
  Object.assign(model, requiredExtras(copilot));
  const efforts = copilot.reasoningEfforts;
  if (efforts !== null) {
    const donorLevels = Array.isArray(model.supported_reasoning_levels)
      ? model.supported_reasoning_levels
      : [];
    const levels = donorLevels.filter(
      (level) =>
        isRecord(level) && typeof level.effort === "string" && efforts.includes(level.effort),
    );
    // No shared level (none advertised, or the donor lists none): every effort the
    // clone could offer would be one Copilot rejects for this model -- not cloned.
    if (levels.length === 0) return null;
    model.supported_reasoning_levels = levels;
    const kept = levels.map((level) => (level as Record<string, unknown>).effort);
    if (!kept.includes(model.default_reasoning_level)) model.default_reasoning_level = kept[0];
  }
  return model;
}

/**
 * The Copilot-shaped catalog from a bundled dump: every entry kept with every
 * field (tiers emptied, limits overlaid, known extras filled), then the servable
 * Copilot-only models appended in id order as clones. Null on a bad dump.
 */
export function patchModelCatalog(
  bundledJson: string,
  copilotModels: Map<string, CopilotCatalogModel>,
): Record<string, unknown> | null {
  let doc: unknown;
  try {
    doc = JSON.parse(bundledJson);
  } catch {
    return null;
  }
  if (!isRecord(doc) || !Array.isArray(doc.models) || doc.models.length === 0) return null;
  const bundledSlugs = new Set<string>();
  const donors: { slug: string; model: Record<string, unknown> }[] = [];
  let maxPriority = 0;
  for (const model of doc.models) {
    if (!isRecord(model)) continue;
    for (const field of TIER_FIELDS) if (field in model) model[field] = [];
    if (typeof model.priority === "number") maxPriority = Math.max(maxPriority, model.priority);
    const slug = typeof model.slug === "string" ? model.slug : null;
    const copilot = slug === null ? undefined : copilotModels.get(slug);
    for (const [key, value] of Object.entries(requiredExtras(copilot))) {
      if (!(key in model)) model[key] = value;
    }
    if (slug === null) continue;
    bundledSlugs.add(slug);
    if (gptVersion(slug) !== null) donors.push({ slug, model });
    if (copilot !== undefined) applyLimits(model, copilot.limits);
  }
  const additions = [...copilotModels.entries()]
    .filter(([id, copilot]) => copilot.codexServable && !bundledSlugs.has(id))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [id, copilot] of additions) {
    const donor = pickDonor(id, donors);
    if (donor === null) continue;
    const clone = cloneForCopilotModel(donor, id, copilot, maxPriority + 1);
    if (clone === null) continue;
    maxPriority += 1;
    doc.models.push(clone);
  }
  return doc;
}

let cachedCodexCliPath: string | null | undefined;

/** The codex CLI on PATH, resolved once per process (the PATH look is a shell
 *  spawn of its own, and the several runs below all want the same answer). */
function codexCliPath(): string | null {
  if (cachedCodexCliPath === undefined) cachedCodexCliPath = resolveCommand("codex");
  return cachedCodexCliPath;
}

/** Run `codex debug models <args>` under a throwaway CODEX_HOME populated by
 *  `prepareHome`; the spawn result, or null when codex is not installed or the
 *  home cannot be created. The throwaway home keeps a user's existing
 *  `model_catalog_json` (our own output) from feeding back into the run. */
function runCodexDebugModels(
  args: string[],
  prepareHome: (home: string) => void,
  budgetMs: number,
): SpawnSyncReturns<string> | null {
  // The budget covers this whole call: whatever resolving codex and preparing
  // the home consume comes off the child's timeout, never on top of it.
  const deadline = Date.now() + budgetMs;
  const cliPath = codexCliPath();
  if (cliPath === null) return null;
  let tmpHome: string;
  try {
    tmpHome = fs.mkdtempSync(path.join(tmpdir(), "copilot-env-codex-catalog-"));
  } catch {
    return null;
  }
  try {
    prepareHome(tmpHome);
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) return null;
    const s = cliSpawn(cliPath, ["debug", "models", ...args]);
    // The catalog is hundreds of KB; the default 1 MB maxBuffer risks ENOBUFS
    // (same sizing rationale as the direct probe's runner). On Windows
    // resolveCommand returns the bare command name (no directory) -- don't
    // prepend "." to PATH.
    const cliDir = path.dirname(cliPath);
    // cwd is the throwaway home too: codex reads project-level config from the
    // working directory, and a caller's project must not colour the verdict.
    return spawnSync(s.file, s.args, {
      cwd: tmpHome,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: timeoutMs,
      // A hard kill: a codex that ignores SIGTERM must not outlive the budget.
      killSignal: "SIGKILL",
      windowsHide: true,
      shell: s.shell,
      env: childEnvWithPath([cliDir === "." ? null : cliDir], {
        extra: { CODEX_HOME: tmpHome },
      }),
    });
  } catch {
    return null;
  } finally {
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch (e) {
      // Never fails the config write this probe serves; the leftover is named.
      logger.warn(`codex model catalog: throwaway home kept at ${tmpHome}: ${errMessage(e)}`);
    }
  }
}

/** `codex debug models --bundled` stdout, or null on any failure. */
function defaultBundledCatalog(): string | null {
  const result = runCodexDebugModels(["--bundled"], () => {}, BUNDLED_DUMP_TIMEOUT_MS);
  if (result === null || result.error || result.status !== 0) return null;
  return result.stdout;
}

/** The sorted model slugs of `raw` when it parses as a catalog Codex accepts at
 *  the JSON level (an object with a non-empty `models` array), else null. */
function catalogSlugs(raw: string): string[] | null {
  try {
    const doc: unknown = JSON.parse(raw);
    if (!isRecord(doc) || !Array.isArray(doc.models) || doc.models.length === 0) return null;
    return doc.models
      .map((model) => (isRecord(model) && typeof model.slug === "string" ? model.slug : ""))
      .sort();
  } catch {
    return null;
  }
}

function parsesAsCatalog(raw: string): boolean {
  return catalogSlugs(raw) !== null;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// Verdicts by catalog content, per process: generation and the auth-time sync
// judge the same bytes, and the codex binary does not change under one run.
const probeVerdicts = new Map<string, boolean | null>();

// What is left of CATALOG_PROBE_TIMEOUT_MS for this process: every probe spawn
// draws on it, so however many files are judged, probing costs at most one
// budget per `agent auth --get`. Exhausted, verdicts are null (unverifiable).
let probeBudgetLeftMs = CATALOG_PROBE_TIMEOUT_MS;

/** Test hook: restore (or shrink) the per-process probe budget and forget the
 *  per-process probe caches (the resolved codex path, the verdicts by content). */
export function resetCatalogProbeState(budgetMs: number = CATALOG_PROBE_TIMEOUT_MS): void {
  probeBudgetLeftMs = budgetMs;
  cachedCodexCliPath = undefined;
  probeVerdicts.clear();
}

/** A probe spawn charged to the process budget; null without spawning once it is spent. */
function runProbeSpawn(prepareHome: (home: string) => void): SpawnSyncReturns<string> | null {
  if (probeBudgetLeftMs <= 0) return null;
  const started = Date.now();
  try {
    return runCodexDebugModels([], prepareHome, probeBudgetLeftMs);
  } finally {
    probeBudgetLeftMs -= Date.now() - started;
  }
}

/**
 * The installed codex CLI's verdict on `catalogJson`: `codex debug models` under
 * a throwaway home whose config.toml references the candidate is the exact parse
 * a real startup performs (offline). Accepted only when the dump lists exactly
 * the candidate's models AND the same run over an unparseable catalog fails
 * (proof the key is read, not ignored); a failure is the catalog's only when the
 * same run WITHOUT a catalog dumps one. Every spawn draws on the process budget;
 * anything short of proof is null, unverifiable. Off under the suite's seam.
 */
function defaultAcceptsCatalog(catalogJson: string): boolean | null {
  if (liveLookupsDisabled()) return null;
  const key = sha256(catalogJson);
  const memoized = probeVerdicts.get(key);
  if (memoized !== undefined) return memoized;
  const verdict = probeCatalog(catalogJson);
  probeVerdicts.set(key, verdict);
  return verdict;
}

function probeCatalog(catalogJson: string): boolean | null {
  const referencing = (content: string) => (home: string): void => {
    const file = path.join(home, "candidate-catalog.json");
    fs.writeFileSync(file, content);
    fs.writeFileSync(path.join(home, "config.toml"), stringify({ "model_catalog_json": file }));
  };
  // A run that never reported an exit code (spawn error, or killed -- the budget's
  // timeout kill included) proves nothing either way; only a real exit counts.
  const exitOf = (run: SpawnSyncReturns<string> | null): number | null =>
    run === null || run.error || run.status === null ? null : run.status;
  const candidate = runProbeSpawn(referencing(catalogJson));
  const candidateExit = exitOf(candidate);
  if (candidateExit === null) return null;
  if (candidateExit === 0) {
    const expected = catalogSlugs(catalogJson);
    const dumped = catalogSlugs(candidate?.stdout ?? "");
    if (expected === null || dumped === null || dumped.join("\n") !== expected.join("\n")) {
      return null;
    }
    // Negative control: a CLI that ignores the key would also "accept" garbage.
    const garbageExit = exitOf(runProbeSpawn(referencing("not a catalog")));
    if (garbageExit === null) return null;
    return garbageExit === 0 ? null : true;
  }
  const control = runProbeSpawn((home) => {
    fs.writeFileSync(path.join(home, "config.toml"), "");
  });
  if (exitOf(control) !== 0) return null;
  return parsesAsCatalog(control?.stdout ?? "") ? false : null;
}

async function defaultFetchCopilotModels(
  source: CatalogSource,
  directToken?: string,
): Promise<Map<string, CopilotCatalogModel> | null> {
  // The deadline aborts the requests themselves (identity probes included), so a
  // slow Copilot cannot keep the auth process alive past the budget.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), COPILOT_FETCH_BUDGET_MS);
  try {
    return parseCopilotModels(
      await fetchRawModels(source, { directToken, signal: deadline.signal }),
    );
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Generate the patched catalog file. Best-effort: returns false (never throws)
 * on any miss, and never deletes or truncates an existing file -- a stale
 * catalog keeps serving until a refresh succeeds. Copilot's catalog is fetched
 * FIRST (cheap fail: no credential / proxy down skips the codex spawn entirely),
 * and the candidate is written only when the installed CLI does not reject it.
 * A no-op unless the opt-in `codex-model-catalog` preference is enabled.
 */
export async function generateCodexModelCatalog(
  source: CatalogSource,
  deps: CodexCatalogDeps = {},
): Promise<boolean> {
  try {
    if (!new CopilotEnvConfig().codexModelCatalogEnabled()) return false;
    const fetchCopilotModels = deps.fetchCopilotModels ??
      ((s: CatalogSource) => defaultFetchCopilotModels(s, deps.directToken));
    const copilotModels = await fetchCopilotModels(source);
    if (copilotModels === null || copilotModels.size === 0) return false;
    const bundledCatalog = deps.bundledCatalog ?? defaultBundledCatalog;
    const bundled = bundledCatalog();
    if (bundled === null) return false;
    const patched = patchModelCatalog(bundled, copilotModels);
    if (patched === null) return false;
    // The exact bytes written are the bytes judged (and later re-judged by file).
    const bytes = `${JSON.stringify(patched, null, 2)}\n`;
    if (judgeCatalog(bytes, deps) === false) {
      logger.warn("codex model catalog not written: the installed codex rejects its schema");
      return false;
    }
    // 0600 like every file the store writes beside it (the home's own policy).
    atomicWriteFile(new CopilotApiPaths().codexModelCatalogFile, bytes, 0o600);
    return true;
  } catch (e) {
    logger.warn(`codex model catalog generation failed: ${errMessage(e)}`);
    return false;
  }
}

/**
 * The installed codex's verdict on `catalogJson` (true / false / null as
 * CodexCatalogDeps.acceptsCatalog), consulting and keeping the persisted
 * acceptance first: a (content, codex version) pair this codex already parsed is
 * accepted without a spawn, so the auth-time sync asks again only when the
 * file or the codex changed. Recorded only on a positive verdict with a known
 * version -- a rejection is re-asked, since the next regeneration replaces it.
 */
function judgeCatalog(catalogJson: string, deps: CodexCatalogDeps): boolean | null {
  const version = (deps.codexVersion ?? installedCodexVersion)();
  const digest = sha256(catalogJson);
  // The record is a cache: unreadable means "not recorded", unwritable is
  // ignored -- a proven verdict is never lost to the cache that would keep it.
  const state = new CopilotEnvState();
  let recorded: { sha256: string; codexVersion: string } | null = null;
  try {
    recorded = state.read().codexCatalogAccepted;
  } catch {
    recorded = null;
  }
  if (
    version !== null && recorded !== null && recorded.sha256 === digest &&
    recorded.codexVersion === version
  ) {
    return true;
  }
  const verdict = (deps.acceptsCatalog ?? defaultAcceptsCatalog)(catalogJson);
  if (verdict === true && version !== null && catalogBookkeepingAllowed()) {
    try {
      state.set({ codexCatalogAccepted: { sha256: digest, codexVersion: version } });
    } catch (e) {
      logger.warn(`codex model catalog: acceptance not recorded: ${errMessage(e)}`);
    }
  }
  return verdict;
}

/**
 * What a reference to the generated catalog would mean for Codex's startup:
 * `unusable` (missing, unreadable, or not a catalog at the JSON level) and
 * `rejected` (the installed codex fails to parse it) are startup errors and must
 * not be referenced; `accepted` and `unverifiable` (no codex to ask) may be.
 */
export type CatalogFileVerdict = "unusable" | "rejected" | "accepted" | "unverifiable";

/** One read, one verdict (see CatalogFileVerdict): the bytes judged at the JSON
 *  level are the bytes the installed codex is asked about, so no second read can
 *  see a different file. A file this codex already accepted is not re-asked
 *  (judgeCatalog); a codex upgrade or a changed file is. */
export function inspectCatalogFile(
  filePath: string,
  deps: CodexCatalogDeps = {},
): CatalogFileVerdict {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return "unusable";
  }
  if (!parsesAsCatalog(raw)) return "unusable";
  const accepted = judgeCatalog(raw, deps);
  return accepted === null ? "unverifiable" : accepted ? "accepted" : "rejected";
}

/** Auth-time refresh: at most one ATTEMPT per day (recorded before generating, so a
 *  failure cannot retry every 300s), bypassed by a codex version or patch change
 *  (the file REPLACES the bundled catalog). True when regenerated; never throws. */
export async function refreshCodexModelCatalogIfStale(
  source: CatalogSource,
  deps: CodexCatalogDeps = {},
): Promise<boolean> {
  try {
    if (!new CopilotEnvConfig().codexModelCatalogEnabled()) return false;
    const now = deps.nowMs?.() ?? Date.now();
    const state = new CopilotEnvState();
    const recorded = state.read();
    const version = (deps.codexVersion ?? installedCodexVersion)();
    // An unresolvable version (codex missing / --version failed) never counts as
    // a change -- generation needs the codex CLI anyway, and flapping between
    // null and a version must not defeat the throttle.
    const versionChanged = version !== null && version !== recorded.codexCatalogCodexVersion;
    // A patch-logic change (CATALOG_PATCH_VERSION bump) also bypasses the daily
    // throttle: the on-disk catalog was generated by the OLD patch and may carry
    // exactly what the new one exists to remove.
    const patchChanged = recorded.codexCatalogPatchVersion !== CATALOG_PATCH_VERSION;
    if (!versionChanged && !patchChanged && !isDue(recorded.codexCatalogLastAttemptMs, now)) {
      return false;
    }
    state.set({
      codexCatalogLastAttemptMs: now,
      codexCatalogCodexVersion: version,
      codexCatalogPatchVersion: CATALOG_PATCH_VERSION,
    });
    return await generateCodexModelCatalog(source, deps);
  } catch (e) {
    logger.warn(`codex model catalog refresh failed: ${errMessage(e)}`);
    return false;
  }
}
