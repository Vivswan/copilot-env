// The float installs the proxy into a dedicated Deno npm cache under the root home, never into
// node_modules. The successful resolution is recorded in <rootHome>/proxy/resolved-version.json:
// the freshness oracle every status here reads, and the record src/copilot_api/process.ts turns
// into the daemon's entry.
//
// npm lifecycle scripts never run for global-cache `npm:` execution, so a target declaring them
// would misbehave silently at runtime: the default float REFUSES it (a recorded in-bounds version
// is kept; otherwise it fails loud), while an explicit COPILOT_API_VERSION or `proxy-version` pin
// installs it with a warning. The cache warm passes the cooldown as --minimum-dependency-age, so
// TRANSITIVE deps get the window too.

import "./utils/dotenv.ts";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createConsola } from "consola";
import * as v from "valibot";
import { proxyUnusedEverywhere } from "./agents/wiring.ts";
import { atomicWriteFile, removeTreeReported } from "./utils/report_write.ts";
import { configDefaultNumber, CopilotEnvConfig } from "./copilot_api/env_config.ts";
import { resolveRootHome } from "./copilot_api/paths.ts";
import { allShimPaths } from "./copilot_api/shims.ts";
import { resolveDenoBin } from "./copilot_api/sidecar.ts";
import {
  installedProxyVersion,
  PROXY_PACKAGE_NAME,
  proxyVersionBoundsStatus,
  proxyVersionFloorStatus,
} from "./copilot_api/version.ts";
import { pickAgedVersion } from "./utils/aged_version.ts";
import { assertNever } from "./utils/assert.ts";
import { errMessage } from "./utils/error.ts";
import { entryAbsent, readTextOrNull, readTextResult } from "./utils/fs.ts";
import { parseJsonRecord } from "./utils/json.ts";
import { type ProjectConfig, readProjectConfig } from "./utils/project_config.ts";
import { ASSET_ROOT } from "./utils/root.ts";
import { versionLessThan } from "./utils/semver.ts";
import { SECONDS_PER_DAY } from "./utils/time.ts";

const PROXY_PKG = PROXY_PACKAGE_NAME;
const PROXY_VERSION_ENV = "COPILOT_API_VERSION";
const MIN_RELEASE_AGE_ENV = "COPILOT_API_MIN_RELEASE_AGE";
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export const DEFAULT_RELEASE_COOLDOWN_SECONDS = configDefaultNumber("release-cooldown");

/** The full document: its `time` map carries the publish times the cooldown needs; the abbreviated
 *  install doc lacks it. */
export const PROXY_REGISTRY_URL = `https://registry.npmjs.org/${PROXY_PKG.replaceAll("/", "%2F")}`;

/** The config read is the store's STRICT one: an unreadable prefs store throws rather than read as
 *  "no pin", because floating past a supply-chain pin on an unproven empty is exactly what the pin
 *  exists to prevent. An env pin short-circuits before the store is consulted, so it keeps working
 *  even then. */
export function resolveProxyVersionOverride(): string | undefined {
  return process.env[PROXY_VERSION_ENV]?.trim() || new CopilotEnvConfig().read().proxyVersion;
}

type ProxyConsolaOptions = NonNullable<Parameters<typeof createConsola>[0]> & {
  fancy?: boolean;
};

const loggerOptions: ProxyConsolaOptions = {
  "stdout": process.stderr,
  "stderr": process.stderr,
  "fancy": false,
  "formatOptions": { "date": false },
};
const logger = createConsola(loggerOptions);

/** The single source the float, the verify status, and health all read; 0 disables. */
export function resolveMinimumReleaseAgeSeconds(): number {
  const raw = process.env[MIN_RELEASE_AGE_ENV]?.trim();
  if (raw) {
    if (!/^\d+$/.test(raw)) {
      throw new Error(`${MIN_RELEASE_AGE_ENV} must be a whole number of seconds (got '${raw}')`);
    }
    return Number.parseInt(raw, 10);
  }
  // Strict config read, like the version pin: a stored cooldown must not be shortened to the
  // default by an unreadable store.
  return new CopilotEnvConfig().read().releaseCooldown ?? DEFAULT_RELEASE_COOLDOWN_SECONDS;
}

function formatReleaseAge(seconds: number): string {
  if (seconds % SECONDS_PER_DAY === 0) return `${seconds / SECONDS_PER_DAY} days old`;
  return `${seconds} seconds old`;
}

// --- Registry document: fetch + parse boundary --------------------------------

/** npm's install-time scripts, which never run for global-cache `npm:` execution. External
 *  contract. */
export const NPM_LIFECYCLE_SCRIPT_KEYS = ["preinstall", "install", "postinstall"] as const;

export interface ProxyRelease {
  version: string;
  publishedAtMs: number;
  lifecycleScripts: string[];
}

export interface ProxyRegistryDoc {
  releases: ReadonlyMap<string, ProxyRelease>;
  distTags: Readonly<Record<string, string>>;
}

const REGISTRY_SCHEMA = v.object({
  "dist-tags": v.optional(v.record(v.string(), v.string()), {}),
  "versions": v.record(
    v.string(),
    v.looseObject({
      "scripts": v.optional(v.record(v.string(), v.unknown())),
      "hasInstallScript": v.optional(v.boolean()),
    }),
  ),
  "time": v.record(v.string(), v.string()),
});

/** A malformed document is rejected whole, never partially trusted. A version without a parseable
 *  publish time can never prove it clears the cooldown, so it is dropped here. */
export function parseRegistryDoc(raw: unknown): ProxyRegistryDoc {
  const parsed = v.safeParse(REGISTRY_SCHEMA, raw);
  if (!parsed.success) {
    throw new Error(
      `npm registry document for ${PROXY_PKG} did not match the expected shape (versions/time/dist-tags); refusing to select from it`,
    );
  }
  const releases = new Map<string, ProxyRelease>();
  for (const [version, manifest] of Object.entries(parsed.output.versions)) {
    const iso = parsed.output.time[version];
    if (iso === undefined) continue;
    const publishedAtMs = Date.parse(iso);
    if (Number.isNaN(publishedAtMs)) continue;
    const scripts = manifest.scripts ?? {};
    const lifecycleScripts: string[] = NPM_LIFECYCLE_SCRIPT_KEYS.filter((k) => k in scripts);
    // hasInstallScript is npm's own summary flag, trusted even when the per-version manifest omits
    // the scripts map.
    if (manifest.hasInstallScript === true && lifecycleScripts.length === 0) {
      lifecycleScripts.push("install");
    }
    releases.set(version, { version, publishedAtMs, lifecycleScripts });
  }
  return { "releases": releases, "distTags": parsed.output["dist-tags"] };
}

export type FetchLike = (url: string) => Promise<Response>;

export async function fetchRegistryDoc(fetchLike: FetchLike = fetch): Promise<ProxyRegistryDoc> {
  let response: Response;
  try {
    response = await fetchLike(PROXY_REGISTRY_URL);
  } catch (e) {
    throw new Error(`npm registry unreachable (${errMessage(e)})`);
  }
  if (!response.ok) {
    throw new Error(`npm registry responded HTTP ${response.status} for ${PROXY_PKG}`);
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new Error(`npm registry response for ${PROXY_PKG} was not valid JSON`);
  }
  return parseRegistryDoc(raw);
}

// --- Target selection ----------------------------------------------------------

/** `pinned` is only minted by the pin path; `selectProxyVersion` returns the other three. */
export type ProxySelection =
  | { kind: "pinned"; version: string }
  | { kind: "resolved"; version: string; publishedAtMs: number; reason: string }
  | { kind: "refused"; version: string; lifecycleScripts: string[]; reason: string }
  | { kind: "unavailable"; reason: string };

type RegistrySelection = Exclude<ProxySelection, { kind: "pinned" }>;

/** A candidate that declares lifecycle scripts is `refused`, never silently swapped for an older
 *  one: the window or a reviewed pin is the escape hatch, not an implicit downgrade. */
export function selectProxyVersion(
  doc: ProxyRegistryDoc,
  config: ProjectConfig,
  cooldownSeconds: number,
  nowMs: number,
): RegistrySelection {
  const timeMap: Record<string, string> = {};
  for (const release of doc.releases.values()) {
    timeMap[release.version] = new Date(release.publishedAtMs).toISOString();
  }
  const aged = pickAgedVersion(timeMap, cooldownSeconds * 1000, nowMs);

  let candidate: string;
  let reason: string;
  if (aged === null) {
    candidate = config.proxyMinVersion;
    reason = `no ${formatReleaseAge(cooldownSeconds)} release -> floor ${config.proxyMinVersion}`;
  } else if (versionLessThan(aged, config.proxyMinVersion)) {
    candidate = config.proxyMinVersion;
    reason = `${aged} < floor ${config.proxyMinVersion}`;
  } else if (config.proxyMaxVersion !== null && versionLessThan(config.proxyMaxVersion, aged)) {
    candidate = config.proxyMaxVersion;
    reason = `${aged} > ceiling ${config.proxyMaxVersion}`;
  } else {
    candidate = aged;
    reason = `latest >=${formatReleaseAge(cooldownSeconds)} release ${aged}`;
  }

  const release = doc.releases.get(candidate);
  if (release === undefined) {
    return {
      "kind": "unavailable",
      "reason": `target ${candidate} (${reason}) is not published in the npm registry`,
    };
  }
  if (release.lifecycleScripts.length > 0) {
    return {
      "kind": "refused",
      "version": candidate,
      "lifecycleScripts": release.lifecycleScripts,
      "reason": reason,
    };
  }
  return {
    "kind": "resolved",
    "version": candidate,
    "publishedAtMs": release.publishedAtMs,
    "reason": reason,
  };
}

function refusalMessage(sel: Extract<ProxySelection, { kind: "refused" }>): string {
  return (
    `${PROXY_PKG}@${sel.version} declares npm lifecycle scripts (${
      sel.lifecycleScripts.join(", ")
    }), ` +
    `which never run for global-cache execution and would misbehave silently; refusing it. ` +
    `Review the release, then pin it (${PROXY_VERSION_ENV} or \`agent config --set proxy-version\`) ` +
    `or cap PROXY_MAX_VERSION in copilot-env.config below it.`
  );
}

// --- The resolved-version record (the freshness oracle) -------------------------

export interface ResolvedVersionRecord {
  version: string;
  resolvedAtMs: number;
  denoDir: string;
  /** daemonConfigFingerprint() of the build that stamped the record. */
  buildFingerprint?: string;
}

const RECORD_SCHEMA = v.object({
  "version": v.pipe(v.string(), v.regex(SEMVER_RE)),
  "resolved_at_ms": v.pipe(v.number(), v.finite(), v.minValue(0)),
  "deno_dir": v.pipe(v.string(), v.minLength(1)),
  // Lenient on purpose: an absent or malformed fingerprint reads as "regenerate the config once,
  // then stamp", never invalidating the resolution.
  "build_fingerprint": v.optional(v.unknown()),
});

export function proxyDenoDir(rootHome: string): string {
  return join(rootHome, "deno", "cache");
}

export function resolvedVersionFile(rootHome: string): string {
  return join(rootHome, "proxy", "resolved-version.json");
}

export function daemonConfigFile(rootHome: string): string {
  return join(rootHome, "proxy", "deno.json");
}

/** A float-time artifact only: the daemon run never takes it, so a read-only install or two
 *  concurrent daemons cannot trip over it. It pins TRANSITIVE resolution between floats (the
 *  proxy's own ranges would otherwise re-resolve on every warm) and is the baseline
 *  `trust-policy=no-downgrade` compares against. */
export function proxyLockFile(rootHome: string): string {
  return join(rootHome, "proxy", "deno.lock");
}

/** This build's import map and compiler options, with `lock` and `nodeModulesDir` dropped on
 *  purpose: `lock: {frozen: true}` would reject `npm:<proxy>@<floated>` (the frozen lock is a DEV
 *  contract), and `nodeModulesDir` would resolve through a node_modules tree a compiled install
 *  lacks. The source is read through ASSET_ROOT because a compiled install root carries no
 *  deno.json on disk. */
export function writeDaemonConfig(rootHome: string, sourceRoot: string = ASSET_ROOT): void {
  atomicWriteFile(daemonConfigFile(rootHome), renderDaemonConfig(sourceRoot));
}

function renderDaemonConfig(sourceRoot: string): string {
  const source = parseJsonRecord(readTextOrNull(join(sourceRoot, "deno.json")) ?? "");
  if (source === null) {
    throw new Error(`could not read the import map from ${join(sourceRoot, "deno.json")}`);
  }
  const config = {
    "imports": source.imports ?? {},
    "compilerOptions": source.compilerOptions ?? {},
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** A content hash rather than the copilot-env version, so it moves exactly when the generated
 *  config would: it covers deno.json's `imports` and `compilerOptions`, so an update that touches
 *  neither regenerates nothing, and a dev checkout's edits are caught. */
export function daemonConfigFingerprint(sourceRoot: string = ASSET_ROOT): string {
  return createHash("sha256").update(renderDaemonConfig(sourceRoot)).digest("hex");
}

/** Malformed reads as null, the caller's "install needed" path: a corrupt record must never brick.
 */
export function readResolvedVersionRecord(rootHome: string): ResolvedVersionRecord | null {
  const text = readTextOrNull(resolvedVersionFile(rootHome));
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = v.safeParse(RECORD_SCHEMA, raw);
  if (!parsed.success) return null;
  const fingerprint = parsed.output.build_fingerprint;
  return {
    "version": parsed.output.version,
    "resolvedAtMs": parsed.output.resolved_at_ms,
    "denoDir": parsed.output.deno_dir,
    ...(typeof fingerprint === "string" ? { "buildFingerprint": fingerprint } : {}),
  };
}

/** The version the NEXT launch runs, in resolveCopilotApiEntry's precedence, but read-only (the
 *  entry resolution may write the daemon config), so a version gate on a read path (`agent config`)
 *  can use it. Null when unknowable: a tag pin (only the start path resolves tags), a
 *  COPILOT_API_ENTRY override, or nothing resolved or installed. */
export function nextProxyVersion(rootHome: string = resolveRootHome()): string | null {
  if (process.env.COPILOT_API_ENTRY?.trim()) return null;
  const recorded = readResolvedVersionRecord(rootHome)?.version;
  const pin = resolveProxyVersionOverride();
  if (pin !== undefined && pin !== recorded) return SEMVER_RE.test(pin) ? pin : null;
  return recorded ?? installedProxyVersion();
}

/** A timestamp refresh passes the record's own `denoDir` through, so the pointer never drifts from
 *  where the cache lives. An omitted `buildFingerprint` stays omitted: only a caller that just
 *  wrote the daemon config may claim the config is this build's. */
export function writeResolvedVersionRecord(
  rootHome: string,
  version: string,
  nowMs: number,
  denoDir: string = proxyDenoDir(rootHome),
  buildFingerprint?: string,
): void {
  const record = {
    "version": version,
    "resolved_at_ms": nowMs,
    "deno_dir": denoDir,
    ...(buildFingerprint === undefined ? {} : { "build_fingerprint": buildFingerprint }),
  };
  atomicWriteFile(resolvedVersionFile(rootHome), `${JSON.stringify(record, null, 2)}\n`);
}

/** The resolution timestamp stays untouched: build identity and freshness are separate questions,
 *  and this must never extend the cooldown window. Runs ahead of every verify and float so a young
 *  record from an older build cannot keep an outdated import map steering daemon spawns until it
 *  ages out. */
function ensureDaemonConfigCurrent(rootHome: string): void {
  const record = readResolvedVersionRecord(rootHome);
  if (record === null) return; // nothing resolved -> the resolve-time paths own the config
  const fingerprint = daemonConfigFingerprint();
  if (record.buildFingerprint === fingerprint && existsSync(daemonConfigFile(rootHome))) return;
  writeDaemonConfig(rootHome);
  writeResolvedVersionRecord(
    rootHome,
    record.version,
    record.resolvedAtMs,
    record.denoDir,
    fingerprint,
  );
}

// --- .npmrc trust policy ---------------------------------------------------------

/** Its presence marks the .npmrc as ours. */
export const NPMRC_MARKER = "# managed by copilot-env (proxy float); do not edit";

const NPMRC_CONTENT = `${NPMRC_MARKER}\ntrust-policy=no-downgrade\n`;

export type NpmrcStatus =
  | { kind: "written"; path: string }
  | { kind: "current"; path: string }
  | { kind: "kept-foreign"; path: string };

/** A user-authored .npmrc (no marker) is never clobbered. An UNREADABLE file is kept the same way:
 *  ownership was not proven, so the write would clobber content we never saw. */
export function ensureProxyNpmrc(rootHome: string): NpmrcStatus {
  const path = join(rootHome, ".npmrc");
  const read = readTextResult(path);
  if (read.kind === "unreadable") {
    return { "kind": "kept-foreign", "path": path };
  }
  const existing = read.kind === "text" ? read.text : null;
  if (existing !== null && !existing.includes(NPMRC_MARKER)) {
    return { "kind": "kept-foreign", "path": path };
  }
  if (existing === NPMRC_CONTENT) {
    return { "kind": "current", "path": path };
  }
  atomicWriteFile(path, NPMRC_CONTENT);
  return { "kind": "written", "path": path };
}

// --- Deno cache commands ----------------------------------------------------------

/** `launchFailed` marks a spawn that never completed (the same mark as runCaptured in
 *  src/utils/command.ts), so a failed look at the cache never reads as deno's own "cannot resolve".
 */
export interface DenoRunResult {
  status: number;
  stdout: string;
  stderr: string;
  launchFailed?: true;
}

/** `env` is an OVERLAY the runner merges over the process env. */
export type DenoRunner = (
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string> },
) => DenoRunResult;

function defaultDenoRunner(
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string> },
): DenoRunResult {
  const result = spawnSync(command, args, {
    "cwd": options.cwd,
    "env": { ...process.env, ...options.env },
    "stdio": ["ignore", "pipe", "pipe"],
  });
  return {
    "status": result.status ?? 1,
    "stdout": result.stdout?.toString() ?? "",
    "stderr": result.stderr?.toString() ?? "",
    // A spawn error or a null status (killed): deno itself never answered.
    ...(result.error || result.status === null ? { "launchFailed": true as const } : {}),
  };
}

interface FloatContext {
  rootHome: string;
  config: ProjectConfig;
  denoBin: string;
  fetchLike: FetchLike;
  runner: DenoRunner;
  nowMs: number;
}

export interface ProxyFloatDeps {
  rootHome?: string;
  config?: ProjectConfig;
  /** Seconds; unset defers to env > config > built-in default. */
  cooldownSeconds?: number;
  denoBin?: string;
  fetchLike?: FetchLike;
  runner?: DenoRunner;
  nowMs?: number;
}

function floatContext(deps: ProxyFloatDeps): FloatContext {
  // The sidecar resolves under the SAME home the float warms, so a caller passing only rootHome
  // never warms one home while spawning another home's sidecar.
  const rootHome = deps.rootHome ?? resolveRootHome();
  return {
    "rootHome": rootHome,
    "config": deps.config ?? readProjectConfig(),
    "denoBin": deps.denoBin ?? resolveDenoBin(process.env, rootHome),
    "fetchLike": deps.fetchLike ?? fetch,
    "runner": deps.runner ?? defaultDenoRunner,
    "nowMs": deps.nowMs ?? Date.now(),
  };
}

/** No package.json discovery: npm-specifier entrypoints fail under a discovered node-modules
 *  config, so with cwd=rootHome the spawns are location-independent. */
function denoEnv(denoDir: string): Record<string, string> {
  return { "DENO_DIR": denoDir, "DENO_NO_UPDATE_CHECK": "1", "DENO_NO_PACKAGE_JSON": "1" };
}

/** deno's flag takes minutes, ISO-8601 durations, or timestamps; `0` disables. */
export function minimumDependencyAgeArg(cooldownSeconds: number): string {
  return cooldownSeconds === 0 ? "0" : `PT${cooldownSeconds}S`;
}

/** Warms TWO graphs, the proxy package and the preload shims, because the daemon spawn resolves
 *  both under `--cached-only` and a miss on either is a hard launch failure. */
function denoCacheVersion(ctx: FloatContext, version: string, cooldownSeconds: number): number {
  dropSupersededCache(ctx, version);
  writeDaemonConfig(ctx.rootHome);
  const pinned = [
    "--config",
    daemonConfigFile(ctx.rootHome),
    "--lock",
    proxyLockFile(ctx.rootHome),
    "--node-modules-dir=none",
    `--minimum-dependency-age=${minimumDependencyAgeArg(cooldownSeconds)}`,
  ];
  const env = denoEnv(proxyDenoDir(ctx.rootHome));

  const proxy = ctx.runner(ctx.denoBin, ["cache", ...pinned, `npm:${PROXY_PKG}@${version}`], {
    "cwd": ctx.rootHome,
    "env": env,
  });
  if (proxy.status !== 0) {
    if (proxy.stderr.trim()) logger.warn(proxy.stderr.trimEnd());
    return proxy.status;
  }

  const shims = ctx.runner(ctx.denoBin, ["cache", ...pinned, ...allShimPaths()], {
    "cwd": ctx.rootHome,
    "env": env,
  });
  if (shims.status !== 0 && shims.stderr.trim()) logger.warn(shims.stderr.trimEnd());
  return shims.status;
}

/** The whole cache goes, not a prune: `deno clean --except` retains the graphs of FILES, so it
 *  cannot keep an npm specifier, and a prune "keeping" the proxy deletes the very tree the float
 *  just warmed. */
function dropSupersededCache(ctx: FloatContext, version: string): void {
  const record = readResolvedVersionRecord(ctx.rootHome);
  if (record === null || record.version === version) return;
  removeTreeReported(proxyDenoDir(ctx.rootHome));
}

/** "unproven" is a look that FAILED (the deno spawn itself). A string union rather than a boolean
 *  so no call site can flatten it by truthiness. */
type CacheLook = "resolves" | "missing" | "unproven";

/** Checks the preload shims' graph too: a half-warmed cache would otherwise read as up to date and
 *  the daemon die at launch on a missing import-map package. A `deno info` that never ran is
 *  "unproven" while the cache dir is there: the missing arm feeds recoveries that drop or
 *  re-warm the cache. */
function cacheResolves(ctx: FloatContext, version: string, denoDir: string): CacheLook {
  const config = daemonConfigFile(ctx.rootHome);
  if (!existsSync(config)) return "missing";
  const pinned = ["--json", "--config", config, "--lock", proxyLockFile(ctx.rootHome)];
  const options = { "cwd": ctx.rootHome, "env": denoEnv(denoDir) };

  for (const target of [[`npm:${PROXY_PKG}@${version}`], allShimPaths()]) {
    const result = ctx.runner(
      ctx.denoBin,
      ["info", ...pinned, "--node-modules-dir=none", ...target],
      options,
    );
    if (result.launchFailed) {
      // A dir PROVEN absent is "missing" by direct observation (dropSupersededCache may have
      // removed it this invocation), and the keep paths must never vouch for a cache that is gone;
      // any other stat error is itself a failed look.
      try {
        return statSync(denoDir, { "throwIfNoEntry": false }) === undefined
          ? "missing"
          : "unproven";
      } catch {
        return "unproven";
      }
    }
    if (result.status !== 0) return "missing";
  }
  return "resolves";
}

function warnCacheUnverified(version: string): void {
  logger.warn(
    `could not verify the ${PROXY_PKG}@${version} cache (deno info failed to run); keeping it`,
  );
}

/** The one notion of "a usable installed proxy" every keep and fallback path shares. An UNPROVEN
 *  look keeps the record too: the null arm feeds destructive recoveries, and a genuinely broken
 *  cache still fails honestly at daemon launch. */
function usableRecord(ctx: FloatContext): ResolvedVersionRecord | null {
  const record = readResolvedVersionRecord(ctx.rootHome);
  if (record === null) return null;
  const look = cacheResolves(ctx, record.version, record.denoDir);
  if (look === "unproven") {
    warnCacheUnverified(record.version);
    return record;
  }
  return look === "resolves" ? record : null;
}

/** The cache the record points at may sit OUTSIDE the root home, so deleting the home alone would
 *  miss it. An .npmrc without our marker is the user's: the float refused to write it, so the
 *  uninstall refuses to delete it. */
export function removeProxyFloatArtifacts(
  rootHome: string = resolveRootHome(),
  paths: readonly string[] = proxyFloatArtifactPaths(rootHome),
): void {
  for (const path of paths) removeTreeReported(path);
}

/** The uninstall plan resolves this once and renders it both as the dry run and the live removal.
 */
export function proxyFloatArtifactPaths(rootHome: string): string[] {
  const record = readResolvedVersionRecord(rootHome);
  const npmrc = join(rootHome, ".npmrc");
  const candidates = [
    ...(record === null ? [] : [record.denoDir]),
    proxyDenoDir(rootHome),
    join(rootHome, "proxy"),
    ...(readTextOrNull(npmrc)?.includes(NPMRC_MARKER) ? [npmrc] : []),
  ];
  return [...new Set(candidates)].filter((path) => !entryAbsent(path));
}

// --- Float actions -----------------------------------------------------------------

/** Always stamped with this build's fingerprint: the daemon config beside it was just written, or
 *  ensured current, by this build. */
function recordFloatResolution(
  ctx: FloatContext,
  version: string,
  denoDir: string = proxyDenoDir(ctx.rootHome),
): void {
  writeResolvedVersionRecord(ctx.rootHome, version, ctx.nowMs, denoDir, daemonConfigFingerprint());
}

function logNowUsing(ctx: FloatContext): void {
  const record = readResolvedVersionRecord(ctx.rootHome);
  logger.success(`now using ${PROXY_PKG}@${record?.version ?? "unknown"}`);
}

/** The pin BYPASSES the refusal, so it only warns; the doc may be absent when the registry is
 *  unreachable. */
function warnPinnedLifecycleScripts(doc: ProxyRegistryDoc | null, version: string): void {
  const scripts = doc?.releases.get(version)?.lifecycleScripts ?? [];
  if (scripts.length > 0) {
    logger.warn(
      `pinned ${PROXY_PKG}@${version} declares npm lifecycle scripts (${
        scripts.join(", ")
      }); they will NOT run under global-cache execution`,
    );
  }
}

async function handlePinnedOverride(ctx: FloatContext, override: string): Promise<void> {
  const record = readResolvedVersionRecord(ctx.rootHome);
  let target = override;
  let doc: ProxyRegistryDoc | null = null;

  if (SEMVER_RE.test(override)) {
    // Only a PROVEN "resolves" earns the fast path; an unproven look falls through to the
    // non-destructive re-warm.
    if (
      record?.version === override &&
      cacheResolves(ctx, override, record.denoDir) === "resolves"
    ) {
      logger.success(`up to date: ${PROXY_PKG}@${override} pinned; no install`);
      return;
    }
    try {
      doc = await fetchRegistryDoc(ctx.fetchLike);
    } catch {
      doc = null; // the scripts warning is best-effort
    }
  } else {
    try {
      doc = await fetchRegistryDoc(ctx.fetchLike);
    } catch (e) {
      if (usableRecord(ctx) !== null) {
        logger.warn(
          `could not resolve the '${override}' tag pin (${
            errMessage(e)
          }); keeping ${PROXY_PKG}@${record?.version}`,
        );
        return;
      }
      throw new Error(
        `failed to resolve ${PROXY_PKG}@${override} (pinned via ${PROXY_VERSION_ENV}): ${
          errMessage(e)
        }`,
      );
    }
    const tagged = doc.distTags[override];
    if (tagged === undefined) {
      throw new Error(
        `the '${override}' tag does not exist for ${PROXY_PKG} (pinned via ${PROXY_VERSION_ENV})`,
      );
    }
    target = tagged;
  }

  logger.info(`installing pinned ${PROXY_PKG}@${override} (cooldown bypassed)`);
  warnPinnedLifecycleScripts(doc, target);
  const status = denoCacheVersion(ctx, target, 0);
  if (status === 0) {
    recordFloatResolution(ctx, target);
    logNowUsing(ctx);
    return;
  }
  if (usableRecord(ctx) !== null) {
    logger.warn(`pin failed for ${PROXY_PKG}@${override}; keeping ${PROXY_PKG}@${record?.version}`);
    return;
  }
  throw new Error(
    `failed to install ${PROXY_PKG}@${override} (pinned via ${PROXY_VERSION_ENV}); check the version/tag exists (offline?)`,
  );
}

function handleUnavailable(ctx: FloatContext, reason: string, cooldownSeconds: number): void {
  const record = usableRecord(ctx);
  if (record !== null && proxyVersionFloorStatus(record.version, ctx.config).ok) {
    logger.warn(`update check failed (${reason}); keeping ${PROXY_PKG}@${record.version}`);
    return;
  }

  const floor = ctx.config.proxyMinVersion;
  logger.warn(`update check failed (${reason}); installing floor ${PROXY_PKG}@${floor}`);
  const status = denoCacheVersion(ctx, floor, cooldownSeconds);
  if (status === 0) {
    recordFloatResolution(ctx, floor);
    logNowUsing(ctx);
    return;
  }
  throw new Error(
    `could not install ${PROXY_PKG}@${floor} (offline?); recorded ${
      record?.version ?? "none"
    } < floor ${floor}`,
  );
}

/** Never installs the refused version. The kept record is re-warmed when its cache no longer
 *  resolves (a build change may need packages the old warm never cached), but only when the doc
 *  CONFIRMS it is script-free: a scripted record left by an explicit pin must not be reinstalled
 *  without the pin's consent. */
function handleRefused(
  ctx: FloatContext,
  sel: Extract<ProxySelection, { kind: "refused" }>,
  cooldownSeconds: number,
  doc: ProxyRegistryDoc,
): void {
  const record = readResolvedVersionRecord(ctx.rootHome);
  if (record !== null && proxyVersionBoundsStatus(record.version, ctx.config).ok) {
    const look = cacheResolves(ctx, record.version, record.denoDir);
    // An UNPROVEN look keeps too rather than re-warming: the re-warm's failure arm is the loud
    // refusal throw, and a failed look must not brick a possibly-working install.
    if (look !== "missing") {
      if (look === "unproven") warnCacheUnverified(record.version);
      logger.warn(`${refusalMessage(sel)} Keeping ${PROXY_PKG}@${record.version}.`);
      return;
    }
    if (
      doc.releases.get(record.version)?.lifecycleScripts.length === 0 &&
      denoCacheVersion(ctx, record.version, cooldownSeconds) === 0
    ) {
      recordFloatResolution(ctx, record.version); // the re-warm lands in the default cache dir
      logger.warn(`${refusalMessage(sel)} Keeping ${PROXY_PKG}@${record.version}.`);
      return;
    }
  }
  throw new Error(refusalMessage(sel));
}

function handleResolved(
  ctx: FloatContext,
  sel: Extract<ProxySelection, { kind: "resolved" }>,
  cooldownSeconds: number,
): void {
  const record = readResolvedVersionRecord(ctx.rootHome);
  // Only a PROVEN "resolves" earns the fast path; an unproven look falls through to the
  // non-destructive re-warm, whose failure arm keeps the record via usableRecord.
  const recordedLook: CacheLook = record?.version === sel.version
    ? cacheResolves(ctx, sel.version, record.denoDir)
    : "missing";
  if (record?.version === sel.version && recordedLook === "resolves") {
    // Refresh the record's timestamp so proxyFloatVerifyStatus stays on its offline fast path.
    recordFloatResolution(ctx, sel.version, record.denoDir);
    logger.success(`up to date: ${PROXY_PKG}@${sel.version} (${sel.reason}); no install`);
    return;
  }

  if (recordedLook === "unproven") {
    // The version already matches and only its cache could not be verified: never the confident
    // "update needed".
    logger.info(
      `re-warming ${PROXY_PKG}@${sel.version}: could not verify its cache (deno info failed to run)`,
    );
  } else {
    logger.info(
      `update needed: ${PROXY_PKG} ${record?.version ?? "none"} -> ${sel.version} (${sel.reason})`,
    );
  }
  const status = denoCacheVersion(ctx, sel.version, cooldownSeconds);
  if (status === 0) {
    recordFloatResolution(ctx, sel.version);
    logNowUsing(ctx);
    return;
  }

  const kept = usableRecord(ctx);
  if (kept !== null && proxyVersionFloorStatus(kept.version, ctx.config).ok) {
    logger.warn(`update failed; keeping ${PROXY_PKG}@${kept.version}`);
    return;
  }
  throw new Error(
    `could not install ${PROXY_PKG}@${sel.version} (offline?); recorded ${
      kept?.version ?? "none"
    } < floor ${ctx.config.proxyMinVersion}`,
  );
}

// --- Public float / verify API -----------------------------------------------

export async function floatProxy(deps: ProxyFloatDeps = {}): Promise<void> {
  const ctx = floatContext(deps);
  ensureDaemonConfigCurrent(ctx.rootHome);
  const npmrc = ensureProxyNpmrc(ctx.rootHome);
  if (npmrc.kind === "kept-foreign") {
    logger.warn(`${npmrc.path} exists without the copilot-env marker; leaving it untouched`);
  }

  // The cooldown is resolved only on the float path: a bad COPILOT_API_MIN_RELEASE_AGE must not
  // block a pin.
  const override = resolveProxyVersionOverride();
  if (override) {
    await handlePinnedOverride(ctx, override);
    return;
  }

  const cooldownSeconds = deps.cooldownSeconds ?? resolveMinimumReleaseAgeSeconds();
  const range = ctx.config.proxyMaxVersion === null
    ? `>=${ctx.config.proxyMinVersion}`
    : `>=${ctx.config.proxyMinVersion} <=${ctx.config.proxyMaxVersion}`;
  logger.info(`checking for proxy update (${range}, >=${formatReleaseAge(cooldownSeconds)})`);

  let doc: ProxyRegistryDoc;
  try {
    doc = await fetchRegistryDoc(ctx.fetchLike);
  } catch (e) {
    handleUnavailable(ctx, errMessage(e), cooldownSeconds);
    return;
  }

  const selection = selectProxyVersion(doc, ctx.config, cooldownSeconds, ctx.nowMs);
  switch (selection.kind) {
    case "resolved":
      handleResolved(ctx, selection, cooldownSeconds);
      break;
    case "refused":
      handleRefused(ctx, selection, cooldownSeconds, doc);
      break;
    case "unavailable":
      handleUnavailable(ctx, selection.reason, cooldownSeconds);
      break;
    default:
      assertNever(selection);
  }
}

export type ProxyFloatVerifyStatus = {
  upToDate: boolean;
  message: string;
};
export type ProxyInstallAssertStatus = {
  ok: boolean;
  message: string;
};

/** Offline while the record is younger than the cooldown window; once stale the registry is
 *  re-consulted. Read-only by contract with ONE self-heal (ensureDaemonConfigCurrent); the record's
 *  timestamp only refreshes when the float itself runs. */
export async function proxyFloatVerifyStatus(
  deps: ProxyFloatDeps = {},
): Promise<ProxyFloatVerifyStatus> {
  const ctx = floatContext(deps);
  ensureDaemonConfigCurrent(ctx.rootHome);
  const record = readResolvedVersionRecord(ctx.rootHome);

  const override = resolveProxyVersionOverride();
  if (override) {
    if (!SEMVER_RE.test(override)) {
      return {
        "upToDate": false,
        "message":
          `update needed: ${PROXY_VERSION_ENV}=${override} is a tag pin; it re-resolves on every float`,
      };
    }
    if (record?.version !== override) {
      return {
        "upToDate": false,
        "message": `update needed: ${PROXY_VERSION_ENV}=${override}; recorded ${
          record?.version ?? "none"
        }`,
      };
    }
    const look = cacheResolves(ctx, override, record.denoDir);
    if (look === "unproven") {
      // A failed look is never "not in the cache"; upToDate:false still hands the decision to the
      // float, whose failure arms keep rather than discard.
      return {
        "upToDate": false,
        "message":
          `install unverified: could not verify ${PROXY_PKG}@${override} in the deno cache (${record.denoDir}); deno info failed to run`,
      };
    }
    if (look === "missing") {
      return {
        "upToDate": false,
        "message":
          `install needed: ${PROXY_PKG}@${override} is not in the deno cache (${record.denoDir})`,
      };
    }
    return { "upToDate": true, "message": `up to date: ${PROXY_PKG}@${override} pinned` };
  }

  if (record === null) {
    return {
      "upToDate": false,
      "message": "install needed: no resolved proxy version is recorded",
    };
  }

  const bounds = proxyVersionBoundsStatus(record.version, ctx.config);
  if (!bounds.ok) {
    const detail = bounds.reason === "belowFloor"
      ? `recorded ${record.version} < floor ${ctx.config.proxyMinVersion}`
      : bounds.reason === "aboveCeiling"
      ? `recorded ${record.version} > ceiling ${bounds.ceiling}`
      : `recorded version unreadable`;
    return { "upToDate": false, "message": `update needed: ${detail}` };
  }

  const recordedLook = cacheResolves(ctx, record.version, record.denoDir);
  if (recordedLook === "unproven") {
    // Same arm as the pin path above: never "not in the cache" off a look that failed.
    return {
      "upToDate": false,
      "message":
        `install unverified: could not verify ${PROXY_PKG}@${record.version} in the deno cache (${record.denoDir}); deno info failed to run`,
    };
  }
  if (recordedLook === "missing") {
    return {
      "upToDate": false,
      "message":
        `install needed: ${PROXY_PKG}@${record.version} is not in the deno cache (${record.denoDir})`,
    };
  }

  const cooldownSeconds = deps.cooldownSeconds ?? resolveMinimumReleaseAgeSeconds();
  const ageMs = ctx.nowMs - record.resolvedAtMs;
  if (ageMs >= 0 && ageMs <= cooldownSeconds * 1000) {
    return {
      "upToDate": true,
      "message": `up to date: ${PROXY_PKG}@${record.version} (recorded within the cooldown window)`,
    };
  }

  let doc: ProxyRegistryDoc;
  try {
    doc = await fetchRegistryDoc(ctx.fetchLike);
  } catch (e) {
    return {
      "upToDate": true,
      "message": `no update check: ${errMessage(e)}; keeping ${PROXY_PKG}@${record.version}`,
    };
  }

  const selection = selectProxyVersion(doc, ctx.config, cooldownSeconds, ctx.nowMs);
  switch (selection.kind) {
    case "resolved":
      return selection.version === record.version
        ? {
          "upToDate": true,
          "message": `up to date: ${PROXY_PKG}@${record.version} (${selection.reason})`,
        }
        : {
          "upToDate": false,
          "message":
            `update needed: ${PROXY_PKG} ${record.version} -> ${selection.version} (${selection.reason})`,
        };
    case "refused":
      return {
        "upToDate": true,
        "message": `no update: ${
          refusalMessage(selection)
        } Keeping ${PROXY_PKG}@${record.version}.`,
      };
    case "unavailable":
      return {
        "upToDate": true,
        "message": `no update check: ${selection.reason}; keeping ${PROXY_PKG}@${record.version}`,
      };
    default:
      return assertNever(selection);
  }
}

/** The float inside `agent start` is best-effort, so this is what makes silent failure visible: it
 *  asks whether the float left the record and cache as intended, since a satisfied version window
 *  alone would hide a failed cache write. Tests only: in CI it would float first and hit the npm
 *  registry on every runner.
 *
 *  exact semver pin                -> cached and EQUAL to the pin (bounds bypassed)
 *  tag pin                         -> cached; equality not verified (bounds bypassed)
 *  float target resolved           -> in bounds, cached, and EQUAL to the target
 *  target refused or unresolvable  -> in bounds and cached only */
export async function proxyInstallAssertStatus(
  deps: ProxyFloatDeps = {},
): Promise<ProxyInstallAssertStatus> {
  const ctx = floatContext(deps);
  const record = readResolvedVersionRecord(ctx.rootHome);

  const override = resolveProxyVersionOverride();
  if (override) {
    if (record === null) {
      return {
        "ok": false,
        "message":
          `proxy float did not install the pinned ${PROXY_PKG}@${override}; check the version/tag exists (offline?)`,
      };
    }
    const pinLook = cacheResolves(ctx, record.version, record.denoDir);
    if (pinLook === "unproven") {
      // A hard check must not claim OK off a failed look, nor the specific "not in the cache" it
      // never proved.
      return {
        "ok": false,
        "message":
          `could not verify ${PROXY_PKG}@${record.version} in the deno cache (${record.denoDir}); deno info failed to run`,
      };
    }
    if (pinLook === "missing") {
      return {
        "ok": false,
        "message":
          `recorded ${PROXY_PKG}@${record.version} is not in the deno cache (${record.denoDir})`,
      };
    }
    if (!SEMVER_RE.test(override)) {
      return {
        "ok": true,
        "message":
          `proxy float OK: ${PROXY_PKG} ${record.version} is cached; equality is not verified for the '${override}' tag pin (only exact semver pins are equality-checked)`,
      };
    }
    if (record.version === override) {
      return {
        "ok": true,
        "message": `proxy float OK: ${PROXY_PKG} ${record.version} matches the ${override} pin`,
      };
    }
    return {
      "ok": false,
      "message":
        `recorded ${PROXY_PKG} ${record.version} does not match the pinned ${override} (${PROXY_VERSION_ENV} or the proxy-version config) - the proxy float failed to apply the pin.`,
    };
  }

  if (record === null) {
    return {
      "ok": false,
      "message":
        `proxy float did not record a resolved ${PROXY_PKG} version - the float (src/proxy_float.ts) is broken.`,
    };
  }
  const bounds = proxyVersionBoundsStatus(record.version, ctx.config);
  if (!bounds.ok) {
    switch (bounds.reason) {
      case "missing":
        return {
          "ok": false,
          "message":
            `proxy float recorded an unreadable ${PROXY_PKG} version - the float (src/proxy_float.ts) is broken.`,
        };
      case "belowFloor":
        return {
          "ok": false,
          "message":
            `recorded ${PROXY_PKG} ${bounds.version} is below the ${bounds.floor} floor - the proxy float failed to reach the floor.`,
        };
      case "aboveCeiling":
        return {
          "ok": false,
          "message":
            `recorded ${PROXY_PKG} ${bounds.version} is above the ${bounds.ceiling} ceiling - the proxy float overshot PROXY_MAX_VERSION.`,
        };
      default:
        return assertNever(bounds);
    }
  }
  const recordedLook = cacheResolves(ctx, record.version, record.denoDir);
  if (recordedLook === "unproven") {
    // Same arm as the pin path above: the could-not-verify reason, never the "did not land" it
    // never proved.
    return {
      "ok": false,
      "message":
        `could not verify ${PROXY_PKG}@${record.version} in the deno cache (${record.denoDir}); deno info failed to run`,
    };
  }
  if (recordedLook === "missing") {
    return {
      "ok": false,
      "message":
        `recorded ${PROXY_PKG}@${record.version} is not in the deno cache (${record.denoDir}) - the proxy float cache write did not land.`,
    };
  }

  const window = ctx.config.proxyMaxVersion === null
    ? `>= ${ctx.config.proxyMinVersion} floor`
    : `within [${ctx.config.proxyMinVersion}, ${ctx.config.proxyMaxVersion}]`;
  const cooldownSeconds = deps.cooldownSeconds ?? resolveMinimumReleaseAgeSeconds();
  let doc: ProxyRegistryDoc;
  try {
    doc = await fetchRegistryDoc(ctx.fetchLike);
  } catch (e) {
    return {
      "ok": true,
      "message":
        `proxy float OK (bounds only, ${window}): ${PROXY_PKG} ${record.version}; float target unresolved (${
          errMessage(e)
        })`,
    };
  }
  const selection = selectProxyVersion(doc, ctx.config, cooldownSeconds, ctx.nowMs);
  switch (selection.kind) {
    case "resolved":
      if (record.version !== selection.version) {
        return {
          "ok": false,
          "message":
            `recorded ${PROXY_PKG} ${record.version} does not match the float target ${selection.version} (${selection.reason}) - the proxy float did not land its target.`,
        };
      }
      return {
        "ok": true,
        "message":
          `proxy float OK: ${PROXY_PKG} ${record.version} matches the float target (${selection.reason}; ${window})`,
      };
    case "refused":
      return {
        "ok": true,
        "message":
          `proxy float OK (bounds only, ${window}): ${PROXY_PKG} ${record.version}; newest target refused (${
            refusalMessage(selection)
          })`,
      };
    case "unavailable":
      return {
        "ok": true,
        "message":
          `proxy float OK (bounds only, ${window}): ${PROXY_PKG} ${record.version}; float target unresolved (${selection.reason})`,
      };
    default:
      return assertNever(selection);
  }
}

// --- the Direct-only skip predicate -------------------------------------------

/** An env pin is per-invocation intent and forces the normal path; a stored `proxy-version` pin
 *  does NOT, since the config only matters once an agent is wired to the proxy again.
 *  src/health/probe.ts reports a skipped float instead of a stale one. */
export function proxyFloatSkips(codexHome?: string, claudeHome?: string): boolean {
  const envPinned = Boolean(process.env[PROXY_VERSION_ENV]?.trim());
  return !envPinned && proxyUnusedEverywhere({ codexHome, claudeHome });
}
