// The float installs the proxy into the proxy home, `<rootHome>/proxy/`: a package.json naming the
// proxy at the resolved version (and the preload shims' own npm dependencies), the bun.lock `bun
// install` resolves from it, and the node_modules it populates. The successful resolution is
// recorded in <rootHome>/proxy/resolved-version.json: the freshness oracle every status here
// reads, and the record src/copilot_api/process.ts turns into the daemon's entry.
//
// npm lifecycle scripts never run for the proxy home's install (bun runs none for a dependency it
// does not trust), so a target declaring them would misbehave silently at runtime: the default
// float REFUSES it (a recorded in-bounds version is kept; otherwise it fails loud), while an
// explicit COPILOT_API_VERSION or `daemon.version` pin installs it with a warning. The cooldown is
// written as the proxy home's bunfig `[install] minimumReleaseAge`, so TRANSITIVE deps get the
// window too.

import "./utils/dotenv.ts";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createConsola } from "consola";
import * as v from "valibot";
import { proxyUnusedEverywhere } from "./agents/wiring.ts";
import { CopilotEnvConfig, configSetCommand } from "./copilot_api/env_config.ts";
import { resolveRootHome } from "./copilot_api/paths.ts";
import { DAEMON_SHIM_DEPENDENCIES } from "./copilot_api/shims.ts";
import {
  installedProxyPackage,
  PROXY_PACKAGE_NAME,
  proxyVersionBoundsStatus,
  proxyVersionFloorStatus,
} from "./copilot_api/version.ts";
import { assertNever } from "./utils/assert.ts";
import { readInstallMinimumReleaseAge } from "./utils/bunfig.ts";
import { errMessage } from "./utils/error.ts";
import { readTextOrNull } from "./utils/fs.ts";
import * as fs from "./utils/fs_facade.ts";
import { type ConsolaCreateOptions, wrapToTerminal } from "./utils/logger.ts";
import { type ProjectConfig, readProjectConfig } from "./utils/project_config.ts";
import { pickAgedVersion, versionLessThan } from "./utils/semver.ts";
import { SECONDS_PER_DAY } from "./utils/time.ts";
import { stringify as stringifyToml } from "./utils/toml.ts";
import { packageDependencies } from "./utils/version.ts";

const PROXY_PKG = PROXY_PACKAGE_NAME;
const PROXY_VERSION_ENV = "COPILOT_API_VERSION";
const MIN_RELEASE_AGE_ENV = "COPILOT_API_MIN_RELEASE_AGE";
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** The full document: its `time` map carries the publish times the cooldown needs; the abbreviated
 *  install doc lacks it. */
const PROXY_REGISTRY_URL = `https://registry.npmjs.org/${PROXY_PKG.replaceAll("/", "%2F")}`;

/** The config read is the store's STRICT one: an unreadable prefs store throws rather than read as
 *  "no pin", because floating past a supply-chain pin on an unproven empty is exactly what the pin
 *  exists to prevent. An env pin short-circuits before the store is consulted, so it keeps working
 *  even then. */
export function resolveProxyVersionOverride(): string | undefined {
  return process.env[PROXY_VERSION_ENV]?.trim() || new CopilotEnvConfig().proxyVersionPin();
}

const loggerOptions: ConsolaCreateOptions = {
  stdout: process.stderr,
  stderr: process.stderr,
  fancy: false,
  formatOptions: { date: false },
};
const logger = wrapToTerminal(createConsola(loggerOptions));

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
  // default by an unreadable store. The default is bunfig.toml's `[install] minimumReleaseAge`,
  // the floor `bun install` itself applies, so the float never selects a proxy younger than the
  // checkout's own dependencies may be.
  return new CopilotEnvConfig().storedReleaseCooldownSeconds() ?? readInstallMinimumReleaseAge();
}

function formatReleaseAge(seconds: number): string {
  if (seconds % SECONDS_PER_DAY === 0) return `${seconds / SECONDS_PER_DAY} days old`;
  return `${seconds} seconds old`;
}

// --- Registry document: fetch + parse boundary --------------------------------

/** npm's install-time scripts, which the proxy home's `bun install` never runs. External
 *  contract. */
const NPM_LIFECYCLE_SCRIPT_KEYS = ["preinstall", "install", "postinstall"] as const;

interface ProxyRelease {
  version: string;
  publishedAtMs: number;
  lifecycleScripts: string[];
}

interface ProxyRegistryDoc {
  releases: ReadonlyMap<string, ProxyRelease>;
  distTags: Readonly<Record<string, string>>;
}

const REGISTRY_SCHEMA = v.object({
  "dist-tags": v.optional(v.record(v.string(), v.string()), {}),
  versions: v.record(
    v.string(),
    v.looseObject({
      scripts: v.optional(v.record(v.string(), v.unknown())),
      hasInstallScript: v.optional(v.boolean()),
    }),
  ),
  time: v.record(v.string(), v.string()),
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
  return { releases: releases, distTags: parsed.output["dist-tags"] };
}

export type FetchLike = (url: string) => Promise<Response>;

async function fetchRegistryDoc(fetchLike: FetchLike = fetch): Promise<ProxyRegistryDoc> {
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
type ProxySelection =
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
  const publishedAtMs = new Map<string, number>();
  for (const release of doc.releases.values()) {
    publishedAtMs.set(release.version, release.publishedAtMs);
  }
  const aged = pickAgedVersion(publishedAtMs, cooldownSeconds * 1000, nowMs);

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
      kind: "unavailable",
      reason: `target ${candidate} (${reason}) is not published in the npm registry`,
    };
  }
  if (release.lifecycleScripts.length > 0) {
    return {
      kind: "refused",
      version: candidate,
      lifecycleScripts: release.lifecycleScripts,
      reason: reason,
    };
  }
  return {
    kind: "resolved",
    version: candidate,
    publishedAtMs: release.publishedAtMs,
    reason: reason,
  };
}

function refusalMessage(sel: Extract<ProxySelection, { kind: "refused" }>): string {
  return (
    `${PROXY_PKG}@${sel.version} declares npm lifecycle scripts (${sel.lifecycleScripts.join(
      ", ",
    )}), ` +
    `which never run in the proxy home's install and would misbehave silently; refusing it. ` +
    `Review the release, then pin it (${PROXY_VERSION_ENV} or \`${configSetCommand(
      "daemon.version",
      "<version>",
    )}\`) ` +
    `or cap PROXY_MAX_VERSION in copilot-env.config below it.`
  );
}

// --- The resolved-version record (the freshness oracle) -------------------------

interface ResolvedVersionRecord {
  version: string;
  resolvedAtMs: number;
}

const RECORD_SCHEMA = v.object({
  version: v.pipe(v.string(), v.regex(SEMVER_RE)),
  resolved_at_ms: v.pipe(v.number(), v.finite(), v.minValue(0)),
});

/** The one tree the float installs into and the daemon runs from: its package.json, bun.lock,
 *  bunfig.toml, and node_modules. The daemon's cwd too (src/copilot_api/process.ts), so bun's
 *  own discovery finds this bunfig and this package.json, never the caller's. */
export function proxyHome(rootHome: string): string {
  return join(rootHome, "proxy");
}

/** bun's download cache for the proxy home's installs, pinned under the root home so no float
 *  writes into the user's own `~/.bun`. */
export function proxyBunCacheDir(rootHome: string): string {
  return join(rootHome, "bun", "cache");
}

export function resolvedVersionFile(rootHome: string): string {
  return join(proxyHome(rootHome), "resolved-version.json");
}

export function proxyManifestFile(rootHome: string): string {
  return join(proxyHome(rootHome), "package.json");
}

/** `bun install` writes it; it pins TRANSITIVE resolution between floats (the proxy's own ranges
 *  would otherwise re-resolve on every warm), which is why a re-warm of the recorded version runs
 *  `--frozen-lockfile` against it. */
export function proxyLockFile(rootHome: string): string {
  return join(proxyHome(rootHome), "bun.lock");
}

/** The proxy home's own bunfig: `[install] minimumReleaseAge` is how the cooldown reaches bun's
 *  resolver, and `auto = "disable"` keeps a daemon started from this cwd from fetching a missing
 *  import on its own. */
export function daemonBunfigFile(rootHome: string): string {
  return join(proxyHome(rootHome), "bunfig.toml");
}

function renderDaemonBunfig(cooldownSeconds: number): string {
  return stringifyToml({
    install: { auto: "disable", minimumReleaseAge: cooldownSeconds },
  });
}

/** The proxy home's package.json: the proxy at one EXACT version, plus the preload shims'
 *  dependencies at this build's ranges (`dependencies` is the test seam; the default is the
 *  embedded manifest's). An aliased entry (`"semver": "npm:@jsr/std__semver@^1"`) is taken as
 *  written: the alias is the name the shims import. */
export function renderProxyManifest(
  version: string,
  dependencies: Record<string, string> = packageDependencies(),
): string {
  const shimDependencies: Record<string, string> = {};
  for (const name of DAEMON_SHIM_DEPENDENCIES) {
    const range = dependencies[name];
    if (range === undefined) {
      throw new Error(
        `package.json does not list ${name} under dependencies, which the daemon's preload shims import`,
      );
    }
    shimDependencies[name] = range;
  }
  const manifest = {
    name: "copilot-env-proxy",
    private: true,
    dependencies: { [PROXY_PKG]: version, ...shimDependencies },
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
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
  return { version: parsed.output.version, resolvedAtMs: parsed.output.resolved_at_ms };
}

export function writeResolvedVersionRecord(rootHome: string, version: string, nowMs: number): void {
  const record = { version: version, resolved_at_ms: nowMs };
  fs.writeText(resolvedVersionFile(rootHome), `${JSON.stringify(record, null, 2)}\n`, {
    secretKeys: [],
  });
}

// --- bun install ------------------------------------------------------------------

/** `launchFailed` marks a spawn that never completed (the same mark as runCaptured in
 *  src/utils/command.ts), so a failed look never reads as bun's own verdict. */
interface InstallRunResult {
  status: number;
  stdout: string;
  stderr: string;
  launchFailed?: true;
}

/** Runs the bun CLI the running binary carries (`BUN_BE_BUN=1` makes a compiled binary one;
 *  a checkout's execPath is bun already). `env` is an OVERLAY the runner merges over the
 *  process env. */
export type InstallRunner = (
  args: string[],
  options: { cwd: string; env: Record<string, string> },
) => InstallRunResult;

function defaultInstallRunner(
  args: string[],
  options: { cwd: string; env: Record<string, string> },
): InstallRunResult {
  const result = spawnSync(process.execPath, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
    // A spawn error or a null status (killed): bun itself never answered.
    ...(result.error || result.status === null ? { launchFailed: true as const } : {}),
  };
}

interface FloatContext {
  rootHome: string;
  config: ProjectConfig;
  fetchLike: FetchLike;
  runner: InstallRunner;
  nowMs: number;
}

interface ProxyFloatDeps {
  rootHome?: string;
  config?: ProjectConfig;
  /** Seconds; unset defers to env > config > built-in default. */
  cooldownSeconds?: number;
  fetchLike?: FetchLike;
  runner?: InstallRunner;
  nowMs?: number;
}

function floatContext(deps: ProxyFloatDeps): FloatContext {
  return {
    rootHome: deps.rootHome ?? resolveRootHome(),
    config: deps.config ?? readProjectConfig(),
    fetchLike: deps.fetchLike ?? fetch,
    runner: deps.runner ?? defaultInstallRunner,
    nowMs: deps.nowMs ?? Date.now(),
  };
}

/** The manifest on disk against the one this build renders for `version`: a tree installed from
 *  any other manifest (an older build's shim dependencies, another version) is not this
 *  version's install. An unreadable file is a failed look, not a stale manifest. */
function manifestLook(ctx: FloatContext, version: string): "current" | "stale" | "unproven" {
  const read = fs.readTextResult(proxyManifestFile(ctx.rootHome));
  if (read.kind === "unreadable") return "unproven";
  if (read.kind === "absent") return "stale";
  return read.text === renderProxyManifest(version) ? "current" : "stale";
}

/**
 * Writes the manifest and the bunfig, then `bun install` in the proxy home. The lockfile is
 * frozen whenever the manifest it was resolved from is the one being installed again (a re-warm
 * of the recorded version): the install then restores node_modules from the lock and the cache,
 * offline if need be, and never moves a transitive pin. A changed manifest resolves afresh and
 * rewrites the lock.
 */
function installIntoProxyHome(ctx: FloatContext, version: string, cooldownSeconds: number): number {
  dropSupersededCache(ctx, version);
  const frozen = manifestLook(ctx, version) === "current" && fs.exists(proxyLockFile(ctx.rootHome));
  fs.writeText(proxyManifestFile(ctx.rootHome), renderProxyManifest(version), { secretKeys: [] });
  fs.writeText(daemonBunfigFile(ctx.rootHome), renderDaemonBunfig(cooldownSeconds), {
    secretKeys: [],
  });
  const result = ctx.runner(["install", ...(frozen ? ["--frozen-lockfile"] : [])], {
    cwd: proxyHome(ctx.rootHome),
    env: { BUN_BE_BUN: "1", BUN_INSTALL_CACHE_DIR: proxyBunCacheDir(ctx.rootHome) },
  });
  if (result.status !== 0 && result.stderr.trim()) logger.warn(result.stderr.trimEnd());
  return result.status;
}

/** The whole cache goes on a version change, not a prune: bun's cache is content-addressed and
 *  keeps every tarball it ever fetched, so the superseded proxy's tree would otherwise stay
 *  behind for good. */
function dropSupersededCache(ctx: FloatContext, version: string): void {
  const record = readResolvedVersionRecord(ctx.rootHome);
  if (record === null || record.version === version) return;
  fs.rm(proxyBunCacheDir(ctx.rootHome), { recursive: true, force: true });
}

/** "unproven" is a look that FAILED (a file this process could not read). A string union rather
 *  than a boolean so no call site can flatten it by truthiness. */
type InstallLook = "resolves" | "missing" | "unproven";

/** The proxy home holds `version` when its manifest is this build's manifest for it, the
 *  installed proxy's own manifest says that version and names an entry file on disk, and every
 *  shim dependency is installed: a half-installed tree would otherwise read as up to date and the
 *  daemon die at launch on a missing import. */
function installResolves(ctx: FloatContext, version: string): InstallLook {
  const manifest = manifestLook(ctx, version);
  if (manifest !== "current") return manifest === "stale" ? "missing" : "unproven";
  const home = proxyHome(ctx.rootHome);
  const installed = installedProxyPackage(home);
  if (installed === null || installed.version !== version || !fs.exists(installed.entry)) {
    return "missing";
  }
  for (const name of DAEMON_SHIM_DEPENDENCIES) {
    if (!fs.exists(join(home, "node_modules", name, "package.json"))) return "missing";
  }
  return "resolves";
}

function warnInstallUnverified(version: string): void {
  logger.warn(
    `could not verify the ${PROXY_PKG}@${version} install (its manifest could not be read); keeping it`,
  );
}

/** The one notion of "a usable installed proxy" every keep and fallback path shares. An UNPROVEN
 *  look keeps the record too: the null arm feeds destructive recoveries, and a genuinely broken
 *  install still fails honestly at daemon launch. */
function usableRecord(ctx: FloatContext): ResolvedVersionRecord | null {
  const record = readResolvedVersionRecord(ctx.rootHome);
  if (record === null) return null;
  const look = installResolves(ctx, record.version);
  if (look === "unproven") {
    warnInstallUnverified(record.version);
    return record;
  }
  return look === "resolves" ? record : null;
}

export function removeProxyFloatArtifacts(
  rootHome: string = resolveRootHome(),
  paths: readonly string[] = proxyFloatArtifactPaths(rootHome),
): void {
  for (const path of paths) fs.rm(path, { recursive: true, force: true });
}

/** The uninstall plan resolves this once and renders it both as the dry run and the live removal.
 */
export function proxyFloatArtifactPaths(rootHome: string): string[] {
  return [proxyBunCacheDir(rootHome), proxyHome(rootHome)].filter(
    (path) => fs.readTextResult(path).kind !== "absent",
  );
}

// --- Float actions -----------------------------------------------------------------

function recordFloatResolution(ctx: FloatContext, version: string): void {
  writeResolvedVersionRecord(ctx.rootHome, version, ctx.nowMs);
}

function logNowUsing(ctx: FloatContext): void {
  const record = readResolvedVersionRecord(ctx.rootHome);
  logger.success(`now using ${PROXY_PKG}@${record?.version ?? "unknown"}`);
}

/** On a failed install (false) the caller decides what is kept. */
function installVersion(ctx: FloatContext, version: string, cooldownSeconds: number): boolean {
  if (installIntoProxyHome(ctx, version, cooldownSeconds) !== 0) return false;
  recordFloatResolution(ctx, version);
  logNowUsing(ctx);
  return true;
}

function installFailure(
  ctx: FloatContext,
  version: string,
  kept: ResolvedVersionRecord | null,
): Error {
  return new Error(
    `could not install ${PROXY_PKG}@${version} (offline?); recorded ${
      kept?.version ?? "none"
    } < floor ${ctx.config.proxyMinVersion}`,
  );
}

/** The pin BYPASSES the refusal, so it only warns; the doc may be absent when the registry is
 *  unreachable. */
function warnPinnedLifecycleScripts(doc: ProxyRegistryDoc | null, version: string): void {
  const scripts = doc?.releases.get(version)?.lifecycleScripts ?? [];
  if (scripts.length > 0) {
    logger.warn(
      `pinned ${PROXY_PKG}@${version} declares npm lifecycle scripts (${scripts.join(
        ", ",
      )}); they will NOT run in the proxy home's install`,
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
    if (record?.version === override && installResolves(ctx, override) === "resolves") {
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
          `could not resolve the '${override}' tag pin (${errMessage(
            e,
          )}); keeping ${PROXY_PKG}@${record?.version}`,
        );
        return;
      }
      throw new Error(
        `failed to resolve ${PROXY_PKG}@${override} (pinned via ${PROXY_VERSION_ENV}): ${errMessage(
          e,
        )}`,
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
  if (installVersion(ctx, target, 0)) return;
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
  if (installVersion(ctx, floor, cooldownSeconds)) return;
  throw installFailure(ctx, floor, record);
}

/** Never installs the refused version. The kept record is reinstalled when its install no longer
 *  resolves (a build change may need packages the old install never had), but only when the doc
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
    const look = installResolves(ctx, record.version);
    // An UNPROVEN look keeps too rather than reinstalling: the reinstall's failure arm is the
    // loud refusal throw, and a failed look must not brick a possibly-working install.
    if (look !== "missing") {
      if (look === "unproven") warnInstallUnverified(record.version);
      logger.warn(`${refusalMessage(sel)} Keeping ${PROXY_PKG}@${record.version}.`);
      return;
    }
    if (
      doc.releases.get(record.version)?.lifecycleScripts.length === 0 &&
      installIntoProxyHome(ctx, record.version, cooldownSeconds) === 0
    ) {
      recordFloatResolution(ctx, record.version);
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
  // non-destructive reinstall, whose failure arm keeps the record via usableRecord.
  const recordedLook: InstallLook =
    record?.version === sel.version ? installResolves(ctx, sel.version) : "missing";
  if (record?.version === sel.version && recordedLook === "resolves") {
    // Refresh the record's timestamp so proxyFloatVerifyStatus stays on its offline fast path.
    recordFloatResolution(ctx, sel.version);
    logger.success(`up to date: ${PROXY_PKG}@${sel.version} (${sel.reason}); no install`);
    return;
  }

  if (recordedLook === "unproven") {
    // The version already matches and only its install could not be verified: never the
    // confident "update needed".
    logger.info(
      `reinstalling ${PROXY_PKG}@${sel.version}: could not verify its install (its manifest could not be read)`,
    );
  } else {
    logger.info(
      `update needed: ${PROXY_PKG} ${record?.version ?? "none"} -> ${sel.version} (${sel.reason})`,
    );
  }
  if (installVersion(ctx, sel.version, cooldownSeconds)) return;

  const kept = usableRecord(ctx);
  if (kept !== null && proxyVersionFloorStatus(kept.version, ctx.config).ok) {
    logger.warn(`update failed; keeping ${PROXY_PKG}@${kept.version}`);
    return;
  }
  throw installFailure(ctx, sel.version, kept);
}

// --- Public float / verify API -----------------------------------------------

export async function floatProxy(deps: ProxyFloatDeps = {}): Promise<void> {
  const ctx = floatContext(deps);

  // The cooldown is resolved only on the float path: a bad COPILOT_API_MIN_RELEASE_AGE must not
  // block a pin.
  const override = resolveProxyVersionOverride();
  if (override) {
    await handlePinnedOverride(ctx, override);
    return;
  }

  const cooldownSeconds = deps.cooldownSeconds ?? resolveMinimumReleaseAgeSeconds();
  const range =
    ctx.config.proxyMaxVersion === null
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

type ProxyFloatVerifyStatus = {
  upToDate: boolean;
  message: string;
};

/** The two verdicts an install look forces, the same for a pin and for the recorded version. A
 *  failed look is never "not installed"; upToDate:false still hands the decision to the float,
 *  whose failure arms keep rather than discard. */
function installLookStatus(
  ctx: FloatContext,
  look: InstallLook,
  version: string,
): ProxyFloatVerifyStatus | null {
  const home = proxyHome(ctx.rootHome);
  if (look === "unproven") {
    return {
      upToDate: false,
      message: `install unverified: could not verify ${PROXY_PKG}@${version} in ${home}; its manifest could not be read`,
    };
  }
  if (look === "missing") {
    return {
      upToDate: false,
      message: `install needed: ${PROXY_PKG}@${version} is not installed in ${home}`,
    };
  }
  return null;
}

/** Offline while the record is younger than the cooldown window; once stale the registry is
 *  re-consulted. Read-only: the record's timestamp only refreshes when the float itself runs. */
export async function proxyFloatVerifyStatus(
  deps: ProxyFloatDeps = {},
): Promise<ProxyFloatVerifyStatus> {
  const ctx = floatContext(deps);
  const record = readResolvedVersionRecord(ctx.rootHome);

  const override = resolveProxyVersionOverride();
  if (override) {
    if (!SEMVER_RE.test(override)) {
      return {
        upToDate: false,
        message: `update needed: ${PROXY_VERSION_ENV}=${override} is a tag pin; it re-resolves on every float`,
      };
    }
    if (record?.version !== override) {
      return {
        upToDate: false,
        message: `update needed: ${PROXY_VERSION_ENV}=${override}; recorded ${
          record?.version ?? "none"
        }`,
      };
    }
    return (
      installLookStatus(ctx, installResolves(ctx, override), override) ?? {
        upToDate: true,
        message: `up to date: ${PROXY_PKG}@${override} pinned`,
      }
    );
  }

  if (record === null) {
    return {
      upToDate: false,
      message: "install needed: no resolved proxy version is recorded",
    };
  }

  const bounds = proxyVersionBoundsStatus(record.version, ctx.config);
  if (!bounds.ok) {
    const detail =
      bounds.reason === "belowFloor"
        ? `recorded ${record.version} < floor ${ctx.config.proxyMinVersion}`
        : bounds.reason === "aboveCeiling"
          ? `recorded ${record.version} > ceiling ${bounds.ceiling}`
          : `recorded version unreadable`;
    return { upToDate: false, message: `update needed: ${detail}` };
  }

  const recordedLook = installLookStatus(ctx, installResolves(ctx, record.version), record.version);
  if (recordedLook !== null) return recordedLook;

  const cooldownSeconds = deps.cooldownSeconds ?? resolveMinimumReleaseAgeSeconds();
  const ageMs = ctx.nowMs - record.resolvedAtMs;
  if (ageMs >= 0 && ageMs <= cooldownSeconds * 1000) {
    return {
      upToDate: true,
      message: `up to date: ${PROXY_PKG}@${record.version} (recorded within the cooldown window)`,
    };
  }

  let doc: ProxyRegistryDoc;
  try {
    doc = await fetchRegistryDoc(ctx.fetchLike);
  } catch (e) {
    return {
      upToDate: true,
      message: `no update check: ${errMessage(e)}; keeping ${PROXY_PKG}@${record.version}`,
    };
  }

  const selection = selectProxyVersion(doc, ctx.config, cooldownSeconds, ctx.nowMs);
  switch (selection.kind) {
    case "resolved":
      return selection.version === record.version
        ? {
            upToDate: true,
            message: `up to date: ${PROXY_PKG}@${record.version} (${selection.reason})`,
          }
        : {
            upToDate: false,
            message: `update needed: ${PROXY_PKG} ${record.version} -> ${selection.version} (${selection.reason})`,
          };
    case "refused":
      return {
        upToDate: true,
        message: `no update: ${refusalMessage(selection)} Keeping ${PROXY_PKG}@${record.version}.`,
      };
    case "unavailable":
      return {
        upToDate: true,
        message: `no update check: ${selection.reason}; keeping ${PROXY_PKG}@${record.version}`,
      };
    default:
      return assertNever(selection);
  }
}

// --- the Direct-only skip predicate -------------------------------------------

/** An env pin is per-invocation intent and forces the normal path; a stored `daemon.version` pin
 *  does NOT, since the config only matters once an agent is wired to the proxy again.
 *  src/health/probe.ts reports a skipped float instead of a stale one. */
export function proxyFloatSkips(codexHome?: string, claudeHome?: string): boolean {
  const envPinned = Boolean(process.env[PROXY_VERSION_ENV]?.trim());
  return !envPinned && proxyUnusedEverywhere({ codexHome, claudeHome });
}
