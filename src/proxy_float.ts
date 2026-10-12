// The float installs the proxy into `<rootHome>/proxy/install/`: a package.json naming the proxy
// at the resolved version (and the preload shims' own npm dependencies), the bun.lock `bun
// install` resolves from it, and the node_modules it populates; every install is built in a
// sibling stage, verified, and swapped in, so that directory is only ever a complete install, and
// the one truth for the version that runs: floatedProxyEntry reads it, and so do the spawn
// (src/copilot_api/process.ts) and health. <rootHome>/proxy/resolved-version.json records when it
// was resolved, the freshness oracle every status here reads, and names the version as a cache the
// tree overrides at every float entry.
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
import { daemonLockHold } from "./copilot_api/daemon_lock.ts";
import { CopilotEnvConfig, configSetCommand } from "./copilot_api/env_config.ts";
import { allDaemonHomes, resolveRootHome } from "./copilot_api/paths.ts";
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
import { pickAgedVersion, toSemverString, versionLessThan } from "./utils/semver.ts";
import { SECONDS_PER_DAY } from "./utils/time.ts";
import { stringify as stringifyToml } from "./utils/toml.ts";
import { packageDependencies } from "./utils/version.ts";

const PROXY_PKG = PROXY_PACKAGE_NAME;
const PROXY_VERSION_ENV = "COPILOT_API_VERSION";
const MIN_RELEASE_AGE_ENV = "COPILOT_API_MIN_RELEASE_AGE";

/** One published version, spelled canonically: what a record holds and what an exact pin is. A
 *  `v` prefix or a ragged core is a tag or a typo, never silently normalized into a version. */
function isExactVersion(value: string): boolean {
  return toSemverString(value) === value;
}

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

/** fetch's shape, narrowed to what the float and the start summary call: the one seam a test
 *  replaces to keep every registry read offline. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

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
  version: v.pipe(v.string(), v.check(isExactVersion)),
  resolved_at_ms: v.pipe(v.number(), v.finite(), v.minValue(0)),
});

/** The float's home, `<rootHome>/proxy/`: the record, and the install tree the daemon runs from.
 *  The daemon's cwd (src/copilot_api/process.ts): bun's own discovery then finds nothing of the
 *  caller's, and a running daemon never pins the tree that a later float swaps out. */
export function proxyHome(rootHome: string): string {
  return join(rootHome, "proxy");
}

/**
 * The installed tree: package.json, bunfig.toml, bun.lock, node_modules. A directory that exists
 * only because an install COMPLETED and was verified: every install is built beside it
 * (`install.next`), checked, and swapped in by rename, so no half-state ever carries this name
 * (installIntoProxyHome). `install.prev` is the tree a swap retired, removed after it.
 */
export function proxyInstallDir(rootHome: string): string {
  return join(proxyHome(rootHome), "install");
}

function stagingDir(rootHome: string): string {
  return join(proxyHome(rootHome), "install.next");
}

function retiredDir(rootHome: string): string {
  return join(proxyHome(rootHome), "install.prev");
}

/** bun's download caches for the proxy home's installs, one per installed version (the shims-only
 *  tree under `shims`), under the root home so no float writes into the user's own `~/.bun`. A
 *  completed install prunes every other version's. */
export function proxyBunCacheDir(rootHome: string): string {
  return join(rootHome, "bun", "cache");
}

function installCacheDir(rootHome: string, version: string | null): string {
  return join(proxyBunCacheDir(rootHome), version ?? "shims");
}

export function resolvedVersionFile(rootHome: string): string {
  return join(proxyHome(rootHome), "resolved-version.json");
}

export function proxyManifestFile(rootHome: string): string {
  return join(proxyInstallDir(rootHome), "package.json");
}

/** `bun install` writes it; it pins TRANSITIVE resolution between floats (the proxy's own ranges
 *  would otherwise re-resolve on every warm), which is why a reinstall of the tree in place copies
 *  it into the stage and runs `--frozen-lockfile` against it. */
export function proxyLockFile(rootHome: string): string {
  return join(proxyInstallDir(rootHome), "bun.lock");
}

/** The install's own bunfig: `[install] minimumReleaseAge` is how the cooldown reaches bun's
 *  resolver, and `auto = "disable"` keeps bun from fetching a missing import on its own. */
export function daemonBunfigFile(rootHome: string): string {
  return join(proxyInstallDir(rootHome), "bunfig.toml");
}

function renderDaemonBunfig(cooldownSeconds: number): string {
  return stringifyToml({
    install: { auto: "disable", minimumReleaseAge: cooldownSeconds },
  });
}

/** The proxy home's package.json: the proxy at one EXACT version (none for a daemon whose entry
 *  is a file of its own, which still needs the shims' packages), plus the preload shims'
 *  dependencies at this build's ranges (`dependencies` is the test seam; the default is the
 *  embedded manifest's). An aliased entry (`"semver": "npm:@jsr/std__semver@^1"`) is taken as
 *  written: the alias is the name the shims import. */
export function renderProxyManifest(
  version: string | null,
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
    dependencies: { ...(version === null ? {} : { [PROXY_PKG]: version }), ...shimDependencies },
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

interface InstallRunResult {
  status: number;
  stderr: string;
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
  return { status: result.status ?? 1, stderr: result.stderr?.toString() ?? "" };
}

interface FloatContext {
  rootHome: string;
  config: ProjectConfig;
  fetchLike: FetchLike;
  runner: InstallRunner;
  nowMs: number;
}

export interface ProxyFloatDeps {
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

/** "unproven" is a look that FAILED (a file this process could not read). A string union rather
 *  than a boolean so no call site can flatten it by truthiness. */
type InstallLook = "resolves" | "missing" | "unproven";

/**
 * Whether `dir` is a complete install for `version` (null: the shims-only tree): this build's
 * manifest for it, the proxy's own manifest at that version naming an entry file on disk, and
 * every shim package present. The float verifies a staged tree with it before the swap, so for
 * the tree in place it is a sanity read of a tree that already passed; health and the spawn read
 * through floatedProxyEntry.
 */
function treeLook(dir: string, version: string | null): InstallLook {
  const manifest = fs.readTextResult(join(dir, "package.json"));
  if (manifest.kind === "unreadable") return "unproven";
  if (manifest.kind !== "text" || manifest.text !== renderProxyManifest(version)) return "missing";
  if (version !== null) {
    const installed = installedProxyPackage(dir);
    if (installed === null || installed.version !== version || !fs.exists(installed.entry)) {
      return "missing";
    }
  }
  return shimDependenciesInstalled(dir) ? "resolves" : "missing";
}

function installResolves(ctx: FloatContext, version: string): InstallLook {
  return treeLook(proxyInstallDir(ctx.rootHome), version);
}

/** Every package the preload shims import, present in `dir`'s node_modules. */
function shimDependenciesInstalled(dir: string): boolean {
  return DAEMON_SHIM_DEPENDENCIES.every((name) =>
    fs.exists(join(dir, "node_modules", name, "package.json")),
  );
}

/** The version the tree in place holds, when it holds it complete (treeLook for the version its own
 *  package names): the one truth for what runs. Null for no tree, an incomplete one, or one this
 *  process cannot read. */
function installedTreeVersion(dir: string): string | null {
  const version = installedProxyPackage(dir)?.version ?? null;
  if (version === null) return null;
  return treeLook(dir, version) === "resolves" ? version : null;
}

/** The daemon's floated entry: the install tree in place, complete for the version its own package
 *  names. Null is "nothing floated to run": no tree, or one not complete (the float gate ahead of
 *  every start reinstalls it). The ONE verifier health and the spawn share; the record plays no
 *  part, so a record the swap outran, or one this process could not write, never hides a runnable
 *  tree. */
export function floatedProxyEntry(
  rootHome: string,
): { version: string; entry: string; nodeModules: string } | null {
  const dir = proxyInstallDir(rootHome);
  const version = installedTreeVersion(dir);
  if (version === null) return null;
  const installed = installedProxyPackage(dir);
  if (installed === null) return null;
  return { version, entry: installed.entry, nodeModules: join(dir, "node_modules") };
}

/** A swap that died between its two renames left the tree aside: put it back before anything
 *  judges the install dir, so every float entry runs this first (the looks that decide whether to
 *  install at all read the tree in place, and a refusal path may never install). Then the record
 *  follows the tree: one that names another version keeps its resolution time; none at all (a
 *  write the swap outran) gets the tree's version with no known time, so the next verify look
 *  re-checks; one this process cannot write is named and left. Debris goes last and best-effort: the stage of an interrupted attempt, and a
 *  retired tree still beside a complete one (kept only until the record was written), neither of
 *  which may stand between the tree and a record that agrees with it. */
function recoverInterruptedSwap(rootHome: string): void {
  const current = proxyInstallDir(rootHome);
  const retired = retiredDir(rootHome);
  if (!fs.exists(current) && fs.exists(retired)) fs.rename(retired, current);
  const record = readResolvedVersionRecord(rootHome);
  const inPlace = installedTreeVersion(current);
  if (inPlace !== null && record?.version !== inPlace) {
    if (recordResolution(rootHome, inPlace, record?.resolvedAtMs ?? 0)) {
      logger.info(
        record === null
          ? `no record, but the install holds ${PROXY_PKG}@${inPlace}: the record now names it`
          : `the record named ${PROXY_PKG}@${record.version} but the install holds ${inPlace}: the record now follows the install`,
      );
    }
  }
  removeDebris(stagingDir(rootHome));
  removeDebris(retired);
}

/** Every record write the float makes, best effort: the tree in place is what runs whether or not
 *  the record can say so (every reader takes the version from the tree, resolutionInPlace), so a
 *  record this process cannot write is named and never stops the float. False when it failed. */
function recordResolution(rootHome: string, version: string, atMs: number): boolean {
  try {
    writeResolvedVersionRecord(rootHome, version, atMs);
    return true;
  } catch (e) {
    logger.warn(
      `the install holds ${PROXY_PKG}@${version}, but could not write ${resolvedVersionFile(rootHome)}: ${errMessage(e)}; the install is the version that runs`,
    );
    return false;
  }
}

/** The resolution as every float decision reads it: a complete tree in place IS the version, and
 *  the record lends its time when it names that version (else the time is unknown, 0, so the next
 *  look re-checks); with no complete tree, the record alone, which the looks then judge. */
function resolutionInPlace(ctx: FloatContext): ResolvedVersionRecord | null {
  const record = readResolvedVersionRecord(ctx.rootHome);
  const inPlace = installedTreeVersion(proxyInstallDir(ctx.rootHome));
  if (inPlace === null) return record;
  return { version: inPlace, resolvedAtMs: record?.version === inPlace ? record.resolvedAtMs : 0 };
}

/** Best effort: a removal the OS refuses (an open handle on Windows) is debris the next float entry
 *  sweeps; it never blocks the tree in place or its record. */
function removeDebris(dir: string): void {
  try {
    fs.rm(dir, { recursive: true, force: true });
  } catch (e) {
    logger.warn(`could not remove ${dir} yet: ${errMessage(e)}`);
  }
}

/**
 * Everything happens in the stage, so a failure before the swap leaves the tree in place runnable.
 * The lock rides along only when the manifest is unchanged: `--frozen-lockfile` then moves no
 * transitive pin and the cache serves the reinstall offline. `version` null builds the shims-only
 * tree.
 */
function installIntoProxyHome(
  ctx: FloatContext,
  version: string | null,
  cooldownSeconds: number,
): boolean {
  const rootHome = ctx.rootHome;
  const current = proxyInstallDir(rootHome);
  const next = stagingDir(rootHome);
  try {
    recoverInterruptedSwap(rootHome);
    fs.mkdir(next);
    const manifest = renderProxyManifest(version);
    const inPlace = fs.readTextResult(join(current, "package.json"));
    const frozen =
      inPlace.kind === "text" && inPlace.text === manifest && fs.exists(join(current, "bun.lock"));
    if (frozen) fs.copyFile(join(current, "bun.lock"), join(next, "bun.lock"));
    fs.writeText(join(next, "package.json"), manifest, { secretKeys: [] });
    fs.writeText(join(next, "bunfig.toml"), renderDaemonBunfig(cooldownSeconds), {
      secretKeys: [],
    });
    const result = ctx.runner(["install", ...(frozen ? ["--frozen-lockfile"] : [])], {
      cwd: next,
      env: { BUN_BE_BUN: "1", BUN_INSTALL_CACHE_DIR: installCacheDir(rootHome, version) },
    });
    if (result.status !== 0) {
      if (result.stderr.trim()) logger.warn(result.stderr.trimEnd());
      return false;
    }
    if (treeLook(next, version) !== "resolves") {
      logger.warn(
        `bun install reported success, but ${next} is not a complete install; not using it`,
      );
      return false;
    }
    const running = runningDaemon(rootHome);
    if (running !== null) {
      logger.warn(
        `not swapping in the new install: a daemon is running from the one in place (${running}); stop it (\`agent stop\`) and start again`,
      );
      return false;
    }
    swapInstallDir(rootHome);
    // The record follows the swap, and the retired tree stays beside the new one until it has: a
    // record this process cannot write leaves the tree as the version that runs (every reader takes
    // the version from the tree), and the next float entry rewrites the record from it.
    const recorded = version === null || recordResolution(rootHome, version, ctx.nowMs);
    if (recorded) removeDebris(retiredDir(rootHome));
    pruneCaches(rootHome, installCacheDir(rootHome, version));
    return true;
  } catch (e) {
    logger.warn(`could not install into ${next}: ${errMessage(e)}`);
    return false;
  } finally {
    fs.rm(next, { recursive: true, force: true });
  }
}

/** A daemon of this root home still running from the tree in place: on POSIX it would lazily import
 *  from the new tree after a swap, on Windows the rename itself fails on its open handles, so the
 *  swap waits until the daemon is gone (`agent stop`; `agent start` runs the floor gate before it
 *  stops daemons and once more after, so a start that replaces the daemon lands the update in that
 *  start). Judged by THIS root home's daemon locks, the liveness signal every stop path reads; a
 *  lock this process cannot read counts as running, since the swap is the irreversible step. */
function runningDaemon(rootHome: string): string | null {
  for (const home of allDaemonHomes(rootHome)) {
    const hold = daemonLockHold(home);
    if (hold.kind === "held") return `pid ${hold.pid ?? "unknown"}, ${home}`;
    if (hold.kind === "unreadable") return `an unreadable daemon.lock in ${home}`;
  }
  return null;
}

/** The retired tree is renamed aside and left there until the record is written (removeDebris in
 *  installIntoProxyHome); a second rename that fails puts the old tree straight back, so the install
 *  dir never stays empty. */
function swapInstallDir(rootHome: string): void {
  const current = proxyInstallDir(rootHome);
  const next = stagingDir(rootHome);
  const retired = retiredDir(rootHome);
  const hadCurrent = fs.exists(current);
  if (hadCurrent) fs.rename(current, retired);
  try {
    fs.rename(next, current);
  } catch (e) {
    if (hadCurrent) fs.rename(retired, current);
    throw e;
  }
}

/** Every other version's cache goes once an install completed: bun's caches are content-addressed
 *  and keep every tarball they ever fetched, so a superseded version's would otherwise stay behind
 *  for good. Best effort throughout: the install is already in place, so a cache the OS will not
 *  remove is named and left, never a failed install. */
function pruneCaches(rootHome: string, keep: string): void {
  let entries: string[];
  try {
    entries = fs.readdir(proxyBunCacheDir(rootHome));
  } catch {
    return;
  }
  for (const name of entries) {
    const dir = join(proxyBunCacheDir(rootHome), name);
    if (dir === keep) continue;
    try {
      fs.rm(dir, { recursive: true, force: true });
    } catch (e) {
      logger.warn(`could not remove the superseded cache ${dir} yet: ${errMessage(e)}`);
    }
  }
}

/**
 * A daemon whose entry is a file of its own (COPILOT_API_ENTRY) skips the float, but its preload
 * shims still import the packages only an install puts in the proxy home: on a compiled install
 * nothing else holds them (a checkout resolves them from its own node_modules). Installs them
 * alone, once; the next real float's tree supersedes it.
 */
export async function ensureShimDependencies(deps: ProxyFloatDeps = {}): Promise<void> {
  const ctx = floatContext(deps);
  recoverInterruptedSwap(ctx.rootHome);
  if (shimDependenciesInstalled(proxyInstallDir(ctx.rootHome))) return;
  const cooldownSeconds = deps.cooldownSeconds ?? resolveMinimumReleaseAgeSeconds();
  logger.info(`installing the daemon shims' dependencies into ${proxyInstallDir(ctx.rootHome)}`);
  if (!installIntoProxyHome(ctx, null, cooldownSeconds)) {
    throw new Error(
      `could not install the daemon shims' dependencies into ${proxyInstallDir(ctx.rootHome)} (offline?)`,
    );
  }
}

function warnInstallUnverified(version: string): void {
  logger.warn(
    `could not verify the ${PROXY_PKG}@${version} install (its manifest could not be read); keeping it`,
  );
}

/** The one notion of "a usable installed proxy" every keep and fallback path shares. An UNPROVEN
 *  look keeps the record too: the null arm feeds destructive recoveries, and a genuinely broken
 *  install still fails honestly at daemon launch. */
/** The version a failed or refused float keeps: the tree in place (resolutionInPlace), or a record
 *  whose tree could not be verified (an unreadable manifest keeps too, rather than reinstalling
 *  over a possibly-working install). Null when nothing complete stands. */
function usableRecord(ctx: FloatContext): ResolvedVersionRecord | null {
  const resolution = resolutionInPlace(ctx);
  if (resolution === null) return null;
  const look = installResolves(ctx, resolution.version);
  if (look === "unproven") {
    warnInstallUnverified(resolution.version);
    return resolution;
  }
  return look === "resolves" ? resolution : null;
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
  recordResolution(ctx.rootHome, version, ctx.nowMs);
}

/** On a failed install (false) the caller decides what is kept; the install wrote the record. */
function installVersion(ctx: FloatContext, version: string, cooldownSeconds: number): boolean {
  if (!installIntoProxyHome(ctx, version, cooldownSeconds)) return false;
  logger.success(`now using ${PROXY_PKG}@${version}`);
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
  let target = override;
  let doc: ProxyRegistryDoc | null = null;

  if (isExactVersion(override)) {
    // The tree in place is judged for the pin itself. Only a PROVEN "resolves" earns the fast
    // path; an unproven look falls through to the non-destructive re-warm.
    if (installResolves(ctx, override) === "resolves") {
      recordFloatResolution(ctx, override);
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
      const kept = usableRecord(ctx);
      if (kept !== null) {
        logger.warn(
          `could not resolve the '${override}' tag pin (${errMessage(e)}); keeping ${PROXY_PKG}@${kept.version}`,
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
  const kept = usableRecord(ctx);
  if (kept !== null) {
    logger.warn(`pin failed for ${PROXY_PKG}@${override}; keeping ${PROXY_PKG}@${kept.version}`);
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
  // The tree in place, or a record whose tree could not be verified, is kept (usableRecord: a
  // failed look must not brick a possibly-working install); a recorded version whose tree is
  // gone is reinstalled, the reinstall's failure arm being the loud refusal throw. One resolution
  // policy throughout (resolutionInPlace): a tree in place out of bounds never falls back to a
  // record that lagged it.
  const kept = usableRecord(ctx);
  if (kept !== null && proxyVersionBoundsStatus(kept.version, ctx.config).ok) {
    logger.warn(`${refusalMessage(sel)} Keeping ${PROXY_PKG}@${kept.version}.`);
    return;
  }
  const inPlace = resolutionInPlace(ctx);
  if (
    inPlace !== null &&
    proxyVersionBoundsStatus(inPlace.version, ctx.config).ok &&
    doc.releases.get(inPlace.version)?.lifecycleScripts.length === 0 &&
    installIntoProxyHome(ctx, inPlace.version, cooldownSeconds)
  ) {
    logger.warn(`${refusalMessage(sel)} Keeping ${PROXY_PKG}@${inPlace.version}.`);
    return;
  }
  throw new Error(refusalMessage(sel));
}

function handleResolved(
  ctx: FloatContext,
  sel: Extract<ProxySelection, { kind: "resolved" }>,
  cooldownSeconds: number,
): void {
  const inPlace = resolutionInPlace(ctx);
  // The tree in place is judged for the selected version itself, whatever the record names: the
  // tree is the version that runs. Only a PROVEN "resolves" earns the fast path; an unproven look
  // falls through to the non-destructive reinstall, whose failure arm keeps the record via
  // usableRecord.
  const recordedLook: InstallLook = installResolves(ctx, sel.version);
  if (recordedLook === "resolves") {
    // Refresh the record's timestamp (and its version, should it have lagged the tree) so
    // proxyFloatVerifyStatus stays on its offline fast path.
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
      `update needed: ${PROXY_PKG} ${inPlace?.version ?? "none"} -> ${sel.version} (${sel.reason})`,
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
  recoverInterruptedSwap(ctx.rootHome);

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
  const dir = proxyInstallDir(ctx.rootHome);
  if (look === "unproven") {
    return {
      upToDate: false,
      message: `install unverified: could not verify ${PROXY_PKG}@${version} in ${dir}; its manifest could not be read`,
    };
  }
  if (look === "missing") {
    return {
      upToDate: false,
      message: `install needed: ${PROXY_PKG}@${version} is not installed in ${dir}`,
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
  const record = resolutionInPlace(ctx);

  const override = resolveProxyVersionOverride();
  if (override) {
    if (!isExactVersion(override)) {
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
