// The proxy float -- how the runtime version of @jeffreycao/copilot-api is
// chosen and provisioned. The proxy is not installed into node_modules: it lives
// in a dedicated Deno npm cache under the copilot-api root home
// (<rootHome>/deno/cache), and the successful resolution is recorded in
// <rootHome>/proxy/resolved-version.json -- the freshness oracle every check
// below reads, and the record src/copilot_api/process.ts turns into the daemon's
// entry.
//
// Consumers (this module is import-only; it has no CLI entry):
//   - ensureProxyFloor (src/copilot_api/launch.ts, behind `agent start`): checks
//     proxyFloatVerifyStatus -- offline while the record is younger than the
//     cooldown -- and runs floatProxy once it goes stale.
//   - src/copilot_api/process.ts turns the recorded resolution into the daemon's
//     entry; src/commands/uninstall.ts removes the float's artifacts.
//   - The health engine reads the statuses and the skip predicate
//     (src/health/probe.ts).
//   - scripts/warm-proxy-cache.ts runs floatProxy while building the test container.
//   - proxyInstallAssertStatus, the hard end-state check, is exercised by tests
//     only today: wiring it into CI would float first and hit the npm registry
//     on every runner (see .github/workflows/checks.yml).
//
// Runtime knobs are environment variables, not CLI flags: COPILOT_API_VERSION
// pins an exact proxy version/tag, and COPILOT_API_MIN_RELEASE_AGE overrides
// the cooldown window (in seconds; default 7 days, config `releaseCooldown`
// in between -- env > stored config > built-in default).
//
// Resolution:
// 1. Both Codex and Claude wired Direct (no local proxy) -> the skip predicate
//    (proxyFloatSkips) reports the float unnecessary. An explicit
//    COPILOT_API_VERSION env pin overrides this and forces the normal path.
// 2. COPILOT_API_VERSION (or config `proxy-version`) set -> cache exactly that
//    version/tag, bypassing copilot-env.config bounds, the cooldown, and the
//    lifecycle-script preflight (with a warning for the latter).
// 3. Default float -> fetch the package's full npm registry document, parse it
//    at the boundary (versions + publish times + dist-tags), pick the newest
//    stable release at least the cooldown window old, clamp it to
//    [PROXY_MIN_VERSION, PROXY_MAX_VERSION] from copilot-env.config, and REFUSE
//    a target that declares npm lifecycle scripts: scripts never run for
//    global-cache npm: execution, so such a release would misbehave silently at
//    runtime (an existing in-bounds recorded version is kept instead; a fresh
//    install fails loud).
//
// The cache write delegates to the deno sidecar (`deno cache npm:...@<v>` with
// DENO_DIR pinned under the root home) and passes the same cooldown as
// --minimum-dependency-age, so TRANSITIVE dependencies get the supply-chain
// window too, not just the proxy itself. An exact target older than the window
// always clears its own gate.

import "./utils/dotenv.ts";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { createConsola } from "consola";
import * as v from "valibot";
import { proxyUnusedEverywhere } from "./agents/wiring.ts";
import { atomicWriteFile } from "./copilot_api/config.ts";
import { CopilotEnvConfig } from "./copilot_api/env_config.ts";
import { resolveRootHome } from "./copilot_api/paths.ts";
import { allShimPaths } from "./copilot_api/shims.ts";
import { resolveDenoBin } from "./copilot_api/sidecar.ts";
import {
  PROXY_PACKAGE_NAME,
  proxyVersionBoundsStatus,
  proxyVersionFloorStatus,
} from "./copilot_api/version.ts";
import { pickAgedVersion } from "./utils/aged_version.ts";
import { assertNever } from "./utils/assert.ts";
import { errMessage } from "./utils/error.ts";
import { readTextOrNull, readTextResult } from "./utils/fs.ts";
import { parseJsonRecord } from "./utils/json.ts";
import { type ProjectConfig, readProjectConfig } from "./utils/project_config.ts";
import { ASSET_ROOT } from "./utils/root.ts";
import { versionLessThan } from "./utils/semver.ts";
import { SECONDS_PER_DAY } from "./utils/time.ts";

const PROXY_PKG = PROXY_PACKAGE_NAME;
const PROXY_VERSION_ENV = "COPILOT_API_VERSION";
const MIN_RELEASE_AGE_ENV = "COPILOT_API_MIN_RELEASE_AGE";
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** Built-in supply-chain cooldown (seconds) when neither the env nor the config sets one. */
export const DEFAULT_RELEASE_COOLDOWN_SECONDS = 7 * SECONDS_PER_DAY;

/** The npm registry document for the proxy package (full doc: `time` carries
 *  the publish times the cooldown needs; the abbreviated install doc lacks it). */
export const PROXY_REGISTRY_URL = `https://registry.npmjs.org/${PROXY_PKG.replaceAll("/", "%2F")}`;

/** Proxy-version override: an explicit env pin wins over the config pin (undefined if
 *  neither). The config read is the store's STRICT one: an unreadable prefs store
 *  throws rather than reading as "no pin" -- floating past a supply-chain pin on an
 *  unproven empty is exactly what the pin exists to prevent (junk content still
 *  degrades per-field via the lenient schema). An env pin short-circuits before the
 *  store is consulted, so it keeps working even then. Exported for the test that pins
 *  exactly that refusal. */
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

/**
 * The effective cooldown window in seconds. Precedence: COPILOT_API_MIN_RELEASE_AGE env (a
 * whole number of seconds; 0 disables) > config `releaseCooldown` > the built-in 7-day
 * default. The single source the float, the verify status, and health all read.
 */
export function resolveMinimumReleaseAgeSeconds(): number {
  const raw = process.env[MIN_RELEASE_AGE_ENV]?.trim();
  if (raw) {
    if (!/^\d+$/.test(raw)) {
      throw new Error(`${MIN_RELEASE_AGE_ENV} must be a whole number of seconds (got '${raw}')`);
    }
    return Number.parseInt(raw, 10);
  }
  // Strict config read, like the version pin above: a stored cooldown must not be
  // shortened to the default by an unreadable store (env wins before the read).
  return new CopilotEnvConfig().read().releaseCooldown ?? DEFAULT_RELEASE_COOLDOWN_SECONDS;
}

function formatReleaseAge(seconds: number): string {
  if (seconds % SECONDS_PER_DAY === 0) return `${seconds / SECONDS_PER_DAY} days old`;
  return `${seconds} seconds old`;
}

// --- Registry document: fetch + parse boundary --------------------------------

/** npm's lifecycle scripts that would run at install time -- and therefore NEVER
 *  run for global-cache npm: execution (the refusal below). External contract. */
export const NPM_LIFECYCLE_SCRIPT_KEYS = ["preinstall", "install", "postinstall"] as const;

/** One published release, joined from the registry doc's `versions` + `time` maps. */
export interface ProxyRelease {
  version: string;
  publishedAtMs: number;
  /** The install-time lifecycle scripts this version declares (empty = clean). */
  lifecycleScripts: string[];
}

/** The parsed registry document: only what selection needs, nothing half-trusted. */
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

/**
 * Parse boundary for the raw registry JSON. Malformed documents are rejected
 * whole -- never partially trusted. Versions whose publish time is missing or
 * unparseable are dropped here: without a time they can never prove they clear
 * the cooldown, so they are not selectable.
 */
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
    // hasInstallScript is npm's own summary flag; trust it even when the
    // per-version manifest omits the scripts map.
    if (manifest.hasInstallScript === true && lifecycleScripts.length === 0) {
      lifecycleScripts.push("install");
    }
    releases.set(version, { version, publishedAtMs, lifecycleScripts });
  }
  return { "releases": releases, "distTags": parsed.output["dist-tags"] };
}

/** Injectable fetch (tests); the default is the global. */
export type FetchLike = (url: string) => Promise<Response>;

/** Fetch + parse the proxy's registry document (throws with an actionable message). */
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

/**
 * The selection outcome. `pinned` is only minted by the pin path (env/config
 * override); `selectProxyVersion` itself returns the other three.
 */
export type ProxySelection =
  | { kind: "pinned"; version: string }
  | { kind: "resolved"; version: string; publishedAtMs: number; reason: string }
  | { kind: "refused"; version: string; lifecycleScripts: string[]; reason: string }
  | { kind: "unavailable"; reason: string };

type RegistrySelection = Exclude<ProxySelection, { kind: "pinned" }>;

/**
 * Pick the float target from a parsed registry doc: the newest stable release
 * at least `cooldownSeconds` old, clamped to the copilot-env.config window
 * (floor when nothing aged qualifies). A candidate that declares lifecycle
 * scripts is `refused`, never silently swapped for an older one -- the window
 * (or a reviewed pin) is the escape hatch, not an implicit downgrade.
 */
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

/** The recorded successful resolution: what is cached, when, and into which DENO_DIR. */
export interface ResolvedVersionRecord {
  version: string;
  resolvedAtMs: number;
  denoDir: string;
  /** daemonConfigFingerprint() of the build that stamped the record; absent on
   *  records written by builds that predate the fingerprint. */
  buildFingerprint?: string;
}

const RECORD_SCHEMA = v.object({
  "version": v.pipe(v.string(), v.regex(SEMVER_RE)),
  "resolved_at_ms": v.pipe(v.number(), v.finite(), v.minValue(0)),
  "deno_dir": v.pipe(v.string(), v.minLength(1)),
  // Lenient on purpose: an absent (old-format) or malformed fingerprint reads as
  // "regenerate the config once, then stamp", never invalidating the resolution.
  "build_fingerprint": v.optional(v.unknown()),
});

/** The DENO_DIR holding the proxy's npm cache, under the root copilot-api home. */
export function proxyDenoDir(rootHome: string): string {
  return join(rootHome, "deno", "cache");
}

/** Path of the resolved-version record under the root copilot-api home. */
export function resolvedVersionFile(rootHome: string): string {
  return join(rootHome, "proxy", "resolved-version.json");
}

/** Path of the daemon's OWN deno config under the root copilot-api home. */
export function daemonConfigFile(rootHome: string): string {
  return join(rootHome, "proxy", "deno.json");
}

/**
 * Path of the proxy's OWN lockfile, written and re-read by the float's cache warms.
 *
 * Two jobs, and it is a float-time artifact for both -- the daemon run never takes it,
 * so a read-only install or two concurrent daemons can never trip over it:
 *   - it pins TRANSITIVE resolution between floats. The proxy's own dependency ranges
 *     would otherwise re-resolve on every warm, so the same proxy version could sit on
 *     different transitive trees, and each entry carries an integrity hash.
 *   - it is the baseline `trust-policy=no-downgrade` compares against. Deno records the
 *     publishing-trust level in the lockfile, so with no lockfile there is definitionally
 *     nothing to compare and the policy can never fire.
 */
export function proxyLockFile(rootHome: string): string {
  return join(rootHome, "proxy", "deno.lock");
}

/**
 * Write the config the floated daemon runs under: this build's import map and
 * compiler options, with `lock` and `nodeModulesDir` DELIBERATELY dropped.
 *
 * The source is the build's OWN deno.json, read through ASSET_ROOT: the embedded
 * VFS in a compiled binary, the checkout root in dev. A compiled install root
 * deliberately carries no deno.json on disk (there it is a checkout marker the
 * install refusal reads), so a disk read under the install root can never work.
 *
 * The daemon cannot use that deno.json as-is, for two independent reasons:
 *   - `lock: {frozen: true}` rejects `npm:<proxy>@<floated version>` outright, because
 *     that exact specifier is not in deno.lock. Any version the float actually floats
 *     to would fail -- the frozen lock is a DEV contract, and the whole point of the
 *     float is that the runtime version moves independently of it.
 *   - `nodeModulesDir` would send resolution through a node_modules tree that a
 *     compiled install does not have; the daemon resolves purely from the float's
 *     DENO_DIR (`--node-modules-dir=none`).
 *
 * The import map itself is still needed: the preload shims resolve their own imports
 * through it, which is why the daemon spawn passes a `--config` at all.
 */
export function writeDaemonConfig(rootHome: string, sourceRoot: string = ASSET_ROOT): void {
  atomicWriteFile(daemonConfigFile(rootHome), renderDaemonConfig(sourceRoot));
}

/** The exact daemon-config text writeDaemonConfig writes (and the fingerprint hashes). */
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

/**
 * The build-identity fingerprint stamped into the resolved-version record: a hash of
 * the daemon config THIS build writes. A content hash rather than the copilot-env
 * version, so it moves exactly when the generated config would -- an update that
 * leaves the import map alone regenerates nothing, and a dev checkout's deno.json
 * edits are caught without a release.
 */
export function daemonConfigFingerprint(sourceRoot: string = ASSET_ROOT): string {
  return createHash("sha256").update(renderDaemonConfig(sourceRoot)).digest("hex");
}

/** Read the record back through its schema; absent or malformed reads as null
 *  (the caller's "install needed" path -- a corrupt record must never brick). */
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

/** Atomically (tmp+rename) write the record for a just-verified cache entry.
 *  `denoDir` defaults to the current cache dir (fresh installs); a timestamp
 *  refresh of an existing record passes the record's own dir through, so the
 *  pointer never drifts away from where the cache actually lives. An omitted
 *  `buildFingerprint` stays omitted: only the float, which just wrote the daemon
 *  config, may claim the config is this build's. */
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

/**
 * Regenerate the daemon config when the record was stamped by a DIFFERENT build (or
 * never stamped), then restamp -- the resolution timestamp stays untouched, because
 * build identity and freshness are separate questions and this must never extend the
 * cooldown window. Runs ahead of every verify/float so a young record from an older
 * build cannot keep an outdated import map steering daemon spawns until it ages out;
 * when the new map needs packages the recorded cache never warmed, the cacheResolves
 * that follows fails and the float re-warms both graphs.
 */
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

/** First line of the .npmrc copilot-env owns; its presence marks the file ours. */
export const NPMRC_MARKER = "# managed by copilot-env (proxy float); do not edit";

const NPMRC_CONTENT = `${NPMRC_MARKER}\ntrust-policy=no-downgrade\n`;

export type NpmrcStatus =
  | { kind: "written"; path: string }
  | { kind: "current"; path: string }
  | { kind: "kept-foreign"; path: string };

/**
 * Ensure `<rootHome>/.npmrc` carries the no-downgrade trust policy. A
 * user-authored .npmrc (no marker) is NEVER clobbered -- it is kept and the
 * caller surfaces a note instead. An UNREADABLE file is kept the same way:
 * ownership (the marker) was not proven, so the write below would clobber
 * content we never saw -- the same never-act-on-an-unproven-empty rule the
 * JSON store's loadStrict applies.
 */
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

/** Result of one spawned deno command. `launchFailed` marks a spawn that never
 *  completed (an error, or killed -- no status of deno's own): the same mark
 *  contract as runCaptured in src/utils/command.ts, so a failed look at the
 *  cache never has to read as deno's own "cannot resolve". */
export interface DenoRunResult {
  status: number;
  stdout: string;
  stderr: string;
  launchFailed?: true;
}

/** Injectable deno-subprocess seam. `env` is an OVERLAY the runner merges over
 *  the process env (DENO_DIR + DENO_NO_UPDATE_CHECK). */
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
    // A spawn error or a null status (killed) means deno itself never answered.
    ...(result.error || result.status === null ? { "launchFailed": true as const } : {}),
  };
}

/** Everything one float/verify/assert invocation runs with, resolved up front. */
interface FloatContext {
  rootHome: string;
  config: ProjectConfig;
  denoBin: string;
  fetchLike: FetchLike;
  runner: DenoRunner;
  nowMs: number;
}

/** Optional seams/overrides; anything omitted resolves to the live default. */
export interface ProxyFloatDeps {
  rootHome?: string;
  config?: ProjectConfig;
  /** Cooldown override in seconds (else env > config > built-in default). */
  cooldownSeconds?: number;
  denoBin?: string;
  fetchLike?: FetchLike;
  runner?: DenoRunner;
  nowMs?: number;
}

function floatContext(deps: ProxyFloatDeps): FloatContext {
  // The sidecar resolves under the SAME home the float warms: a caller passing only
  // rootHome must never warm one home while spawning another home's sidecar.
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

/** The env overlay every deno subprocess gets: the pinned cache dir, no update
 *  nags, and no package.json discovery -- npm-specifier entrypoints fail under a
 *  discovered manual/auto node-modules config, so together with --no-config and
 *  cwd=rootHome the spawns are location-independent. */
function denoEnv(denoDir: string): Record<string, string> {
  return { "DENO_DIR": denoDir, "DENO_NO_UPDATE_CHECK": "1", "DENO_NO_PACKAGE_JSON": "1" };
}

/** `--minimum-dependency-age` value for a cooldown in seconds: an ISO-8601
 *  duration (deno's flag takes minutes, durations, or timestamps; `0` disables). */
export function minimumDependencyAgeArg(cooldownSeconds: number): string {
  return cooldownSeconds === 0 ? "0" : `PT${cooldownSeconds}S`;
}

/**
 * Populate the proxy's DENO_DIR for an exact version. Warms TWO graphs, because the
 * daemon spawn resolves both under `--cached-only` and a miss on either is a hard
 * launch failure: the proxy package itself, and the preload shims (whose own imports
 * come from the map the daemon config carries). Both share the proxy lockfile, so the
 * transitive tree is pinned across floats. Returns the exit status.
 */
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

/**
 * Drop the whole proxy cache when the target differs from what is recorded. The old
 * version's tree is dead weight the moment we move off it, and `deno clean --except`
 * cannot take its place: `--except` retains the graphs of FILES, so an npm specifier is
 * not a thing it can keep -- a prune "keeping" the proxy deletes the very tree the float
 * just warmed. Re-warming from empty is the only sweep that cannot corrupt the cache.
 */
function dropSupersededCache(ctx: FloatContext, version: string): void {
  const record = readResolvedVersionRecord(ctx.rootHome);
  if (record === null || record.version === version) return;
  rmSync(proxyDenoDir(ctx.rootHome), { "recursive": true, "force": true });
}

/** A look at the cache: "resolves"/"missing" are PROVEN readings (deno info ran
 *  and answered), "unproven" is a look that FAILED (the deno spawn itself). A
 *  string union rather than a boolean so no call site can flatten it by
 *  truthiness -- every consumer must pick an arm (the failed-look discipline of
 *  classifyPidFromScan in src/copilot_api/process.ts). */
type CacheLook = "resolves" | "missing" | "unproven";

/**
 * Whether `denoDir` holds EVERYTHING a floated launch resolves offline: the proxy
 * package AND the preload shims' own graph.
 *
 * Checking only the proxy is what makes a half-warmed cache read as up to date -- the
 * float then skips its warm, and the daemon dies at launch on a missing import-map
 * package instead. Both graphs are warmed together, so both are checked together.
 *
 * Without the daemon config there is no floated launch to verify at all, so that reads
 * "missing" rather than falling back to a laxer check. A `deno info` that never ran
 * (launchFailed) is "unproven", never "missing": the missing arm feeds recoveries
 * that drop or re-warm the cache, and a failed look must not trigger those.
 */
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
      // A failed look may only read "unproven" while there is a cache dir it
      // could be vouching for: a dir PROVEN absent (ENOENT, via throwIfNoEntry)
      // is a "missing" by direct observation (dropSupersededCache may have
      // removed it this very invocation), and the keep paths must never vouch
      // for a cache that is gone. Any other stat error (permissions, I/O) is
      // itself a failed look and stays unproven.
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

/** The one honest warn for a cache look that failed -- shared by every keep path. */
function warnCacheUnverified(version: string): void {
  logger.warn(
    `could not verify the ${PROXY_PKG}@${version} cache (deno info failed to run); keeping it`,
  );
}

/** The record, but only when its cache entry still resolves -- the one notion of
 *  "a usable installed proxy" every keep/fallback path shares. An UNPROVEN look
 *  keeps the record too, with a warning: the null arm feeds destructive
 *  recoveries (a floor install drops the recorded cache; several callers fail
 *  loud), a failed look must never trigger those, and a genuinely broken cache
 *  still fails honestly at daemon launch. */
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

/**
 * Remove everything the float owns, for `agent uninstall`: the cache the record points
 * at (which may sit OUTSIDE the root home, so deleting the root home alone would miss
 * it), the record's own directory, and the .npmrc -- but only when it still carries our
 * marker. An .npmrc without it is the user's; the float refused to write it, so the
 * uninstall refuses to delete it.
 */
export function removeProxyFloatArtifacts(rootHome: string = resolveRootHome()): void {
  const record = readResolvedVersionRecord(rootHome);
  if (record !== null) rmSync(record.denoDir, { "recursive": true, "force": true });
  rmSync(proxyDenoDir(rootHome), { "recursive": true, "force": true });
  rmSync(join(rootHome, "proxy"), { "recursive": true, "force": true });

  const npmrc = join(rootHome, ".npmrc");
  if (readTextOrNull(npmrc)?.includes(NPMRC_MARKER)) rmSync(npmrc, { "force": true });
}

// --- Float actions -----------------------------------------------------------------

/** The float's own record write, always stamped with the running build's fingerprint:
 *  the daemon config beside it was just written (or ensured) by this build. */
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

/** Best-effort lifecycle-script warning for a pinned version (the pin BYPASSES
 *  the refusal; the doc may be absent when the registry is unreachable). */
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
    // Only a PROVEN "resolves" earns the no-install fast path: an unproven look
    // falls through to the (same-version, non-destructive) re-warm below.
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
      doc = null; // the scripts warning is best-effort; the pin itself needs no doc
    }
  } else {
    // A dist-tag pin: resolve it to a concrete version via the registry.
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

/** Registry unreachable / target unpublished: keep a floor-satisfying usable
 *  record, else try the floor directly, else fail loud. */
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

/** Newest eligible release refuses on lifecycle scripts: keep a usable in-bounds
 *  record (loudly), re-warming it first when its cache no longer resolves (a build
 *  change regenerates the daemon config, and the new map may need packages the old
 *  warm never cached); else fail loud -- never install the refused version. The
 *  re-warm only runs when the registry doc CONFIRMS the recorded version is
 *  script-free: a scripted record (left behind by an explicit pin, which bypasses
 *  the refusal) must not be reinstalled without the pin's explicit consent. */
function handleRefused(
  ctx: FloatContext,
  sel: Extract<ProxySelection, { kind: "refused" }>,
  cooldownSeconds: number,
  doc: ProxyRegistryDoc,
): void {
  const record = readResolvedVersionRecord(ctx.rootHome);
  if (record !== null && proxyVersionBoundsStatus(record.version, ctx.config).ok) {
    const look = cacheResolves(ctx, record.version, record.denoDir);
    // "resolves" keeps; an UNPROVEN look keeps too (with the honest warn) rather
    // than re-warming: the re-warm's failure arm is the loud refusal throw, and
    // a failed look must not brick a possibly-working install.
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
  // Only a PROVEN "resolves" earns the up-to-date fast path: an unproven look
  // falls through to the (same-version, non-destructive) re-warm below, whose own
  // failure arm keeps the record via usableRecord.
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
    // The honest wording for the fallthrough: the version already matches, only
    // its cache could not be verified -- never the confident "update needed".
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

/**
 * Float the proxy: resolve the target (pin, else registry selection), populate
 * the proxy's DENO_DIR, and record the resolution.
 */
export async function floatProxy(deps: ProxyFloatDeps = {}): Promise<void> {
  const ctx = floatContext(deps);
  ensureDaemonConfigCurrent(ctx.rootHome);
  const npmrc = ensureProxyNpmrc(ctx.rootHome);
  if (npmrc.kind === "kept-foreign") {
    logger.warn(`${npmrc.path} exists without the copilot-env marker; leaving it untouched`);
  }

  // An exact pin bypasses the cooldown entirely, so resolve the cooldown window
  // ONLY on the float path -- a bad COPILOT_API_MIN_RELEASE_AGE must not block a pin.
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

/**
 * Read-only freshness check behind ensureProxyFloor (`agent start`).
 * Offline while the record is younger than the cooldown window (record parse +
 * bounds + cache check only); once stale, the registry is re-consulted. An
 * exact COPILOT_API_VERSION semver pin never needs the network. Read-only by
 * contract with ONE self-heal: a record stamped by a different build regenerates
 * the daemon config (and restamps) first, so a young record can never keep an
 * old build's import map steering daemon spawns until it ages out. The record's
 * timestamp only refreshes when the float itself runs.
 */
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
      // A failed look is never "not in the cache"; upToDate:false still hands the
      // decision to the float, whose failure arms now keep rather than discard.
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
    // Same honest arm as the pin path above: never claim "not in the cache" off a
    // look that failed; the float's failure arms keep rather than discard.
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

/**
 * A hard check of the float's end state (the float inside `agent start` is
 * best-effort, so this is what makes silent failure visible). Exercised by
 * tests only today: wiring it into CI would float first and hit the npm
 * registry on every runner (see .github/workflows/checks.yml). It answers a
 * different question than the verify status: not "can the float be skipped?",
 * but "did the float leave the record + cache in the state it intended?". The
 * recorded version must equal the float's own resolved target, not merely
 * clear the bounds -- otherwise a silently failed cache write hides behind a
 * window that happens to be satisfied. A pin must be the recorded version
 * (exact semver pins only; tag pins are not equality-checked, and bounds do
 * not apply because a pin bypasses them in the float too). When target
 * resolution fails (npm unreachable) the assert falls back to the bounds-only
 * check so a consumer does not flake on npm outages.
 */
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
      // A hard check must not claim OK off a failed look -- nor the specific
      // "not in the cache" it never proved.
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
    // Same honest arm as the pin path above: fail the hard check, but with the
    // could-not-verify reason, never the "did not land" it never proved.
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

/**
 * True when the float is pointless: nothing uses the local proxy
 * (proxyUnusedEverywhere) and no COPILOT_API_VERSION env pin. An explicit env
 * pin is per-invocation intent, so it always forces the normal path; a stored
 * `proxy-version` config pin does NOT force it (the config only matters once an
 * agent is wired to the proxy again). Consumed by the health engine
 * (src/health/probe.ts), which reports the float as skipped instead of stale.
 */
export function proxyFloatSkips(codexHome?: string, claudeHome?: string): boolean {
  const envPinned = Boolean(process.env[PROXY_VERSION_ENV]?.trim());
  return !envPinned && proxyUnusedEverywhere({ codexHome, claudeHome });
}
