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
// inside every Codex auth refresh and its bounded auth timeout budget (the
// managed direct provider allows 30s per auth call).
//
// The whole feature is OPT-IN (`agent config --set codex-model-catalog true`):
// when disabled, generation and refresh are no-ops here, and the config writer
// / auth-time sync (src/codex/config.ts) remove the artifacts.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { isDue } from "../autoupdate/due.ts";
import { CopilotAdminClient } from "../copilot_api/admin.ts";
import { CopilotApiConfig } from "../copilot_api/config.ts";
import { Credential } from "../copilot_api/credential.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { CopilotEnvState } from "../copilot_api/env_state.ts";
import { ONE_M_SUFFIX } from "../copilot_api/models.ts";
import { CopilotApiPaths } from "../copilot_api/paths.ts";
import { copilotApiResolvePort } from "../copilot_api/port.ts";
import { childEnvWithPath, cliSpawn, resolveCommand } from "../utils/command.ts";
import { errMessage } from "../utils/error.ts";
import { isRecord } from "../utils/json.ts";
import { createStderrLogger } from "../utils/logger.ts";

const logger = createStderrLogger();

// Copilot Direct accepts a bearer under the vscode-chat integration (the same
// integration the proxy uses upstream); /models returns the live catalog.
const DIRECT_MODELS_URL = "https://api.githubcopilot.com/models";
const DIRECT_FETCH_TIMEOUT_MS = 5000;
// The bundled dump is local-only (no network) but may cold-start the codex CLI.
const BUNDLED_DUMP_TIMEOUT_MS = 8000;

/** Where the limits come from: upstream Copilot (direct) or the running local proxy. */
export type CatalogSource = "direct" | "proxy";

function parseCodexVersion(output: string): string | null {
  return output.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0] ?? null;
}

let cachedCodexVersion: string | null | undefined;

/** The installed codex CLI's version (cached per process), or null when unavailable. */
export function installedCodexVersion(): string | null {
  if (cachedCodexVersion !== undefined) return cachedCodexVersion;
  // cliSpawn routes through cmd.exe on Windows so a codex.cmd shim is launchable.
  const s = cliSpawn("codex", ["--version"]);
  const result = spawnSync(s.file, s.args, {
    encoding: "utf8",
    timeout: 1000,
    windowsHide: true,
    shell: s.shell,
  });
  cachedCodexVersion =
    result.error || result.status !== 0
      ? null
      : parseCodexVersion(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  return cachedCodexVersion;
}

export interface CopilotModelLimits {
  maxContextWindowTokens: number;
  maxPromptTokens: number;
}

/** Injectable seams for tests (mirrors the DirectProbeDeps DI style). */
export interface CodexCatalogDeps {
  /** `codex debug models --bundled` stdout, or null on failure. */
  bundledCatalog?: () => string | null;
  /** Copilot limits by model id, or null on failure. */
  fetchLimits?: (source: CatalogSource) => Promise<Map<string, CopilotModelLimits> | null>;
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
  fetchLimits: async () => null,
  codexVersion: () => null,
};

/**
 * Read `data[].capabilities.limits` (max_context_window_tokens + max_prompt_tokens)
 * from a raw Copilot `/models` body -- the same shape upstream and via the proxy.
 * Entries missing either number are skipped; a display-only `[1m]` id suffix is
 * stripped; on duplicate ids the larger window wins.
 */
export function parseCopilotLimits(body: unknown): Map<string, CopilotModelLimits> {
  const out = new Map<string, CopilotModelLimits>();
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
    const existing = out.get(id);
    if (existing && existing.maxContextWindowTokens >= window) continue;
    out.set(id, { maxContextWindowTokens: window, maxPromptTokens: prompt });
  }
  return out;
}

/**
 * Overlay `limits` onto a bundled catalog dump. For each model whose `slug`
 * matches a Copilot id: `context_window`/`max_context_window` become Copilot's
 * total window, and `effective_context_window_percent` becomes
 * floor(prompt/window * 100) -- Codex compacts at that fraction of the window,
 * and Copilot rejects prompts over its per-request cap, so the default 95% of a
 * 1.05M window would 413 upstream before Codex ever auto-compacts. Everything
 * else (fields and non-matching models) is preserved verbatim. Returns null on
 * any parse problem so a bad dump can never produce a catalog Codex rejects.
 */
export function patchModelCatalog(
  bundledJson: string,
  limits: Map<string, CopilotModelLimits>,
): Record<string, unknown> | null {
  let doc: unknown;
  try {
    doc = JSON.parse(bundledJson);
  } catch {
    return null;
  }
  if (!isRecord(doc) || !Array.isArray(doc.models) || doc.models.length === 0) return null;
  for (const model of doc.models) {
    if (!isRecord(model) || typeof model.slug !== "string") continue;
    const limit = limits.get(model.slug);
    if (limit === undefined) continue;
    const percent = Math.min(
      100,
      Math.floor((limit.maxPromptTokens / limit.maxContextWindowTokens) * 100),
    );
    if (percent < 1) continue;
    model.context_window = limit.maxContextWindowTokens;
    model.max_context_window = limit.maxContextWindowTokens;
    model.effective_context_window_percent = percent;
  }
  return doc;
}

/** `codex debug models --bundled` stdout, or null on any failure. Spawned with a
 *  throwaway CODEX_HOME so a user's existing `model_catalog_json` (our own output)
 *  can never feed back into generation. */
function defaultBundledCatalog(): string | null {
  const cliPath = resolveCommand("codex");
  if (cliPath === null) return null;
  let tmpHome: string;
  try {
    tmpHome = fs.mkdtempSync(path.join(tmpdir(), "copilot-env-codex-catalog-"));
  } catch {
    return null;
  }
  try {
    const s = cliSpawn(cliPath, ["debug", "models", "--bundled"]);
    // The catalog is tens of KB; the default 1 MB maxBuffer risks ENOBUFS (same
    // sizing rationale as the direct probe's runner). On Windows resolveCommand
    // returns the bare command name (no directory) -- don't prepend "." to PATH.
    const cliDir = path.dirname(cliPath);
    const result = spawnSync(s.file, s.args, {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: BUNDLED_DUMP_TIMEOUT_MS,
      windowsHide: true,
      shell: s.shell,
      env: childEnvWithPath([cliDir === "." ? null : cliDir], {
        extra: { CODEX_HOME: tmpHome },
      }),
    });
    if (result.error || result.status !== 0) return null;
    return result.stdout;
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

async function defaultFetchLimits(
  source: CatalogSource,
  directToken?: string,
): Promise<Map<string, CopilotModelLimits> | null> {
  try {
    if (source === "proxy") {
      const config = new CopilotApiConfig();
      const admin = new CopilotAdminClient({
        port: Number(copilotApiResolvePort()),
        apiKey: config.ensureApiKey(),
        adminKey: config.ensureAdminApiKey(),
      });
      return parseCopilotLimits(await admin.getRawModels());
    }
    const token = directToken ?? new Credential().resolve();
    if (token === null) return null;
    const res = await fetch(DIRECT_MODELS_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Copilot-Integration-Id": "vscode-chat",
      },
      signal: AbortSignal.timeout(DIRECT_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return parseCopilotLimits(await res.json());
  } catch {
    return null;
  }
}

/**
 * Generate the patched catalog file. Best-effort: returns false (never throws)
 * on any miss, and never deletes or truncates an existing file -- a stale
 * catalog keeps serving until a refresh succeeds. Limits are fetched FIRST
 * (cheap fail: no credential / proxy down skips the codex spawn entirely).
 * A no-op unless the opt-in `codex-model-catalog` preference is enabled.
 */
export async function generateCodexModelCatalog(
  source: CatalogSource,
  deps: CodexCatalogDeps = {},
): Promise<boolean> {
  try {
    if (!new CopilotEnvConfig().codexModelCatalogEnabled()) return false;
    const fetchLimits =
      deps.fetchLimits ?? ((s: CatalogSource) => defaultFetchLimits(s, deps.directToken));
    const limits = await fetchLimits(source);
    if (limits === null || limits.size === 0) return false;
    const bundledCatalog = deps.bundledCatalog ?? defaultBundledCatalog;
    const bundled = bundledCatalog();
    if (bundled === null) return false;
    const patched = patchModelCatalog(bundled, limits);
    if (patched === null) return false;
    new CopilotApiConfig(new CopilotApiPaths().codexModelCatalogFile).save(patched);
    return true;
  } catch (e) {
    logger.warn(`codex model catalog generation failed: ${errMessage(e)}`);
    return false;
  }
}

/**
 * True when the generated catalog file exists AND parses as a catalog Codex
 * will accept (JSON with a non-empty `models` array). The config writer keys on
 * this, not bare existence: a corrupt/empty file referenced from config.toml is
 * a Codex STARTUP error, exactly like a dangling path.
 */
export function isCatalogFileUsable(filePath: string): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return false;
  }
  try {
    const doc: unknown = JSON.parse(raw);
    return isRecord(doc) && Array.isArray(doc.models) && doc.models.length > 0;
  } catch {
    return false;
  }
}

/**
 * Auth-time refresh: regenerate at most once per day, counting ATTEMPTS (the
 * timestamp is recorded before generating) so a persistent failure cannot retry
 * on every 300s Codex auth refresh. A codex CLI VERSION CHANGE bypasses the
 * daily throttle: `model_catalog_json` replaces Codex's bundled catalog
 * wholesale, so a freshly upgraded codex would otherwise hide its new models
 * (or reject a stale schema) for up to a day -- regenerating from the new
 * binary on the first auth call closes that window to one refresh cycle. The
 * throttle lives in the shared `.copilot-env-state.json` (CopilotEnvState)
 * beside the credential -- one account-wide state file, not a second store, and
 * exactly ONE write per due refresh (the store has no cross-process lock, so
 * extra writes widen the lost-update window with concurrent credential writes).
 * Returns true when a catalog was regenerated this call. All errors swallowed;
 * stderr-only narration. A no-op -- BEFORE any state write, so a disabled
 * install never re-creates the throttle fields cleanup deleted -- unless the
 * opt-in `codex-model-catalog` preference is enabled.
 */
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
    if (!versionChanged && !isDue(recorded.codexCatalogLastAttemptMs, now)) return false;
    state.set({ codexCatalogLastAttemptMs: now, codexCatalogCodexVersion: version });
    return await generateCodexModelCatalog(source, deps);
  } catch (e) {
    logger.warn(`codex model catalog refresh failed: ${errMessage(e)}`);
    return false;
  }
}
