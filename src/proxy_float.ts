// The proxy float -- the one dependency whose RUNTIME version bun.lock does not
// govern. package.json keeps @jeffreycao/copilot-api at a caret-range baseline
// for reproducible installs, then this postinstall overlays the exact runtime
// target into node_modules with `bun add --no-save`.
//
// Direct run:
//   bun src/proxy_float.ts
//     Repair/float the installed proxy. Used by package.json postinstall.
//   bun src/proxy_float.ts --verify
//     Read-only freshness check used by bin/agent before deciding whether to run
//     `bun install --frozen-lockfile`.
//   bun src/proxy_float.ts --assert-installed
//     CI/dev guard: assert the postinstall float actually installed its resolved
//     target (or the exact pin), falling back to copilot-env.config's
//     floor/ceiling window when the registry is unreachable.
//
// Runtime knobs are environment variables, not CLI flags: COPILOT_API_VERSION
// pins an exact proxy version/tag, and COPILOT_API_MIN_RELEASE_AGE overrides the
// cooldown window (in seconds) from bunfig.toml's install.minimumReleaseAge.
//
// Current resolution:
// 1. Both Codex and Claude wired Direct (GitHub Copilot, no local proxy) -> the
//    float, --verify, and --assert-installed are no-ops: the proxy is unused, so
//    checking npm for updates is wasted network/install work. An explicit
//    COPILOT_API_VERSION env pin overrides this and forces the normal path.
// 2. COPILOT_API_VERSION set -> install exactly that version/tag. This bypasses
//    copilot-env.config bounds and the cooldown.
// 3. Default float -> read npm publish-time metadata (`bun pm view ... time`),
//    pick the newest stable x.y.z release at least the cooldown window old
//    (COPILOT_API_MIN_RELEASE_AGE seconds if set, else bunfig.toml
//    install.minimumReleaseAge; 0 disables the cooldown), then clamp it to
//    [PROXY_MIN_VERSION, PROXY_MAX_VERSION] from copilot-env.config
//    (PROXY_MAX_VERSION may be empty). If no aged release exists, the floor is
//    used directly so a required minimum is still installable.
//
// The actual overlay installs an exact version with `--minimum-release-age=0`
// because the age check already happened above; relying on Bun's range resolver
// with minimumReleaseAge can reject a range when a newer ineligible release
// exists, even if an older eligible release would satisfy it.
//
// `--verify` is read-only for bin/agent: it recomputes the same target and exits
// 0 only when node_modules is fresh and the installed proxy already matches the
// target. Otherwise bin/agent runs `bun install --frozen-lockfile`, whose
// postinstall runs this file without --verify to repair/float the proxy.
//
// Tests can import floatProxy directly without the postinstall main() running.

import "./utils/dotenv.ts";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createConsola } from "consola";
import { parse } from "smol-toml";
import { proxyUnusedEverywhere } from "./agents/wiring.ts";
import { CopilotEnvConfig, type CopilotEnvConfigData } from "./copilot_api/env_config.ts";
import {
  installedProxyVersion,
  PROXY_PACKAGE_NAME,
  proxyVersionBoundsStatus,
  proxyVersionFloorStatus,
} from "./copilot_api/version.ts";
import { pickAgedVersion } from "./utils/aged_version.ts";
import { assertNever } from "./utils/assert.ts";
import { errMessage } from "./utils/error.ts";
import { isRecord, parseJsonRecord } from "./utils/json.ts";
import { type ProjectConfig, readProjectConfig } from "./utils/project_config.ts";
import { PROJECT_ROOT } from "./utils/root.ts";
import { versionLessThan } from "./utils/semver.ts";
import { SECONDS_PER_DAY } from "./utils/time.ts";

const PROXY_PKG = PROXY_PACKAGE_NAME;
const PROXY_VERSION_ENV = "COPILOT_API_VERSION";
const MIN_RELEASE_AGE_ENV = "COPILOT_API_MIN_RELEASE_AGE";
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

// The float runs at `bun install` postinstall, so config reads are best-effort: any failure
// (missing/corrupt file) falls back to env/bunfig. `agent config` is the persistent home for
// the proxy-version pin and the release-cooldown window (env still overrides per-invocation).
function configRead(): CopilotEnvConfigData | undefined {
  try {
    return new CopilotEnvConfig().read();
  } catch {
    return undefined;
  }
}

/** Proxy-version override: an explicit env pin wins over the config pin (undefined if neither). */
function resolveProxyVersionOverride(): string | undefined {
  return process.env[PROXY_VERSION_ENV]?.trim() || configRead()?.proxyVersion;
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

export type SpawnSyncRunner = (
  command: string,
  args: string[],
  options: Parameters<typeof spawnSync>[2],
) => ReturnType<typeof spawnSync>;

export type ProxyFloatVerifyStatus = {
  upToDate: boolean;
  message: string;
};
export type ProxyInstallAssertStatus = {
  ok: boolean;
  message: string;
};

type Result<T> = { ok: true; value: T } | { ok: false; message: string };
type ProxyTarget = { version: string; reason: string };
type FloatContext = {
  root: string;
  bun: string;
  config: ProjectConfig;
  minimumReleaseAgeSeconds: number;
  spawnRunner: SpawnSyncRunner;
  nowMs: number;
};

export function readBunMinimumReleaseAgeSeconds(root: string): number {
  const bunfig = join(root, "bunfig.toml");
  if (!existsSync(bunfig)) return 0;

  const doc = parse(readFileSync(bunfig, "utf-8"));
  const install = doc.install;
  if (install === undefined) return 0;
  if (!isRecord(install)) throw new Error("bunfig.toml install must be a table");

  const minimumReleaseAge = install.minimumReleaseAge;
  if (minimumReleaseAge === undefined) return 0;
  if (
    typeof minimumReleaseAge !== "number" ||
    !Number.isSafeInteger(minimumReleaseAge) ||
    minimumReleaseAge < 0
  ) {
    throw new Error("bunfig.toml install.minimumReleaseAge must be a whole number of seconds");
  }
  return minimumReleaseAge;
}

/**
 * The effective cooldown window in seconds. Precedence: COPILOT_API_MIN_RELEASE_AGE env (a
 * whole number of seconds; 0 disables) > config `releaseCooldown` > bunfig.toml's
 * install.minimumReleaseAge. The single source the float and `--verify` read.
 */
export function resolveMinimumReleaseAgeSeconds(root: string): number {
  const raw = process.env[MIN_RELEASE_AGE_ENV]?.trim();
  if (raw) {
    if (!/^\d+$/.test(raw)) {
      throw new Error(`${MIN_RELEASE_AGE_ENV} must be a whole number of seconds (got '${raw}')`);
    }
    return Number.parseInt(raw, 10);
  }
  const configured = configRead()?.releaseCooldown;
  if (configured !== undefined) {
    return configured;
  }
  return readBunMinimumReleaseAgeSeconds(root);
}

function formatReleaseAge(seconds: number): string {
  if (seconds % SECONDS_PER_DAY === 0) return `${seconds / SECONDS_PER_DAY} days old`;
  return `${seconds} seconds old`;
}

// --- Registry target resolution ---------------------------------------------

function parseNpmTimeMap(stdout: string): Record<string, string> | null {
  const parsed = parseJsonRecord(stdout);
  if (parsed === null) return null;

  const timeMap: Record<string, string> = {};
  for (const [version, publishedAt] of Object.entries(parsed)) {
    if (typeof publishedAt === "string") timeMap[version] = publishedAt;
  }
  return timeMap;
}

function fetchProxyTimeMap(ctx: FloatContext): Result<Record<string, string>> {
  const result = ctx.spawnRunner(ctx.bun, ["pm", "view", PROXY_PKG, "time", "--json"], {
    cwd: ctx.root,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const status = result.status ?? 1;
  if (status !== 0) {
    const stderr = result.stderr?.toString().trim();
    return {
      "ok": false,
      "message": `npm publish-time metadata unavailable (exit ${status})${stderr ? `: ${stderr}` : ""}`,
    };
  }

  const timeMap = parseNpmTimeMap(result.stdout?.toString() ?? "");
  return timeMap === null
    ? { "ok": false, "message": "npm publish-time metadata was not valid JSON" }
    : { "ok": true, "value": timeMap };
}

function clampProxyTarget(ctx: FloatContext, cooldownVersion: string | null): ProxyTarget {
  if (cooldownVersion === null) {
    return {
      "version": ctx.config.proxyMinVersion,
      "reason": `no ${formatReleaseAge(ctx.minimumReleaseAgeSeconds)} release -> floor ${ctx.config.proxyMinVersion}`,
    };
  }

  if (versionLessThan(cooldownVersion, ctx.config.proxyMinVersion)) {
    return {
      "version": ctx.config.proxyMinVersion,
      "reason": `${cooldownVersion} < floor ${ctx.config.proxyMinVersion}`,
    };
  }

  if (
    ctx.config.proxyMaxVersion !== null &&
    versionLessThan(ctx.config.proxyMaxVersion, cooldownVersion)
  ) {
    return {
      "version": ctx.config.proxyMaxVersion,
      "reason": `${cooldownVersion} > ceiling ${ctx.config.proxyMaxVersion}`,
    };
  }

  return {
    "version": cooldownVersion,
    "reason": `latest >=${formatReleaseAge(ctx.minimumReleaseAgeSeconds)} release ${cooldownVersion}`,
  };
}

function resolveProxyTarget(ctx: FloatContext): Result<ProxyTarget> {
  const metadata = fetchProxyTimeMap(ctx);
  if (!metadata.ok) return metadata;

  const cooldownVersion = pickAgedVersion(
    metadata.value,
    ctx.minimumReleaseAgeSeconds * 1000,
    ctx.nowMs,
  );
  return { "ok": true, "value": clampProxyTarget(ctx, cooldownVersion) };
}

// --- Install actions ----------------------------------------------------------

function installProxySpec(ctx: FloatContext, spec: string, quiet = false): number {
  const result = ctx.spawnRunner(
    ctx.bun,
    ["add", `${PROXY_PKG}@${spec}`, "--no-save", "--ignore-scripts", "--minimum-release-age=0"],
    {
      cwd: ctx.root,
      stdio: ["ignore", process.stderr, quiet ? "pipe" : "inherit"],
    },
  );

  if (quiet && result.status !== 0) {
    const err = result.stderr?.toString().trimEnd();
    if (err) logger.warn(err);
  }

  return result.status ?? 1;
}

/** Log the proxy version now on disk after a (re)install. */
function logNowUsing(ctx: FloatContext): void {
  logger.success(`now using ${PROXY_PKG}@${installedProxyVersion(ctx.root) ?? "unknown"}`);
}

function handlePinnedOverride(ctx: FloatContext, override: string): void {
  const installedBefore = installedProxyVersion(ctx.root);
  if (SEMVER_RE.test(override) && installedBefore === override) {
    logger.success(`up to date: ${PROXY_PKG}@${override} pinned; no install`);
    return;
  }

  logger.info(`installing pinned ${PROXY_PKG}@${override} (cooldown bypassed)`);
  const code = installProxySpec(ctx, override);
  if (code !== 0 && installedBefore === null)
    throw new Error(
      `failed to install ${PROXY_PKG}@${override} (pinned via ${PROXY_VERSION_ENV}); check the version/tag exists (offline?)`,
    );

  if (code === 0) logNowUsing(ctx);
  else logger.warn(`pin failed for ${PROXY_PKG}@${override}; keeping installed version`);
}

function handleResolveFailure(ctx: FloatContext, message: string): void {
  const installed = installedProxyVersion(ctx.root);
  if (proxyVersionFloorStatus(installed, ctx.config).ok) {
    logger.warn(`update check failed (${message}); keeping ${PROXY_PKG}@${installed}`);
    return;
  }

  logger.warn(
    `update check failed (${message}); installing floor ${PROXY_PKG}@${ctx.config.proxyMinVersion}`,
  );
  const code = installProxySpec(ctx, ctx.config.proxyMinVersion, true);
  if (code === 0) {
    logNowUsing(ctx);
    return;
  }

  throw new Error(
    `could not install ${PROXY_PKG}@${ctx.config.proxyMinVersion} (offline?); installed ${installed ?? "none"} < floor ${ctx.config.proxyMinVersion}`,
  );
}

function handleResolvedTarget(ctx: FloatContext, target: ProxyTarget): void {
  const installed = installedProxyVersion(ctx.root);
  if (installed === target.version) {
    logger.success(`up to date: ${PROXY_PKG}@${target.version} (${target.reason}); no install`);
    return;
  }

  logger.info(
    `update needed: ${PROXY_PKG} ${installed ?? "none"} -> ${target.version} (${target.reason})`,
  );
  const code = installProxySpec(ctx, target.version);
  if (code === 0) {
    logNowUsing(ctx);
    return;
  }

  const installedAfterFailure = installedProxyVersion(ctx.root);
  if (!proxyVersionFloorStatus(installedAfterFailure, ctx.config).ok) {
    throw new Error(
      `could not install ${PROXY_PKG}@${target.version} (offline?); installed ${installedAfterFailure ?? "none"} < floor ${ctx.config.proxyMinVersion}`,
    );
  }
  logger.warn(`update failed; keeping ${PROXY_PKG}@${installedAfterFailure}`);
}

// --- Public float / verify API -----------------------------------------------

/**
 * Float the proxy, overlaying the runtime root's node_modules via `bun add
 * --no-save` so the read-only package.json / bun.lock are never written -- only
 * the proxy moves; every other dep stays at its locked version.
 */
export function floatProxy(
  root: string,
  bun: string,
  config: ProjectConfig,
  minimumReleaseAgeSeconds?: number,
  spawnRunner: SpawnSyncRunner = spawnSync,
  nowMs: number = Date.now(),
): void {
  const override = resolveProxyVersionOverride();

  // An exact pin bypasses the cooldown entirely, so resolve the cooldown window
  // ONLY on the float path -- a bad COPILOT_API_MIN_RELEASE_AGE must not block a pin.
  if (override) {
    handlePinnedOverride(
      { root, bun, config, minimumReleaseAgeSeconds: 0, spawnRunner, nowMs },
      override,
    );
    return;
  }

  const effectiveAge = minimumReleaseAgeSeconds ?? resolveMinimumReleaseAgeSeconds(root);
  const ctx: FloatContext = {
    root,
    bun,
    config,
    minimumReleaseAgeSeconds: effectiveAge,
    spawnRunner,
    nowMs,
  };
  const range =
    config.proxyMaxVersion === null
      ? `>=${config.proxyMinVersion}`
      : `>=${config.proxyMinVersion} <=${config.proxyMaxVersion}`;
  logger.info(`checking for proxy update (${range}, >=${formatReleaseAge(effectiveAge)})`);
  const target = resolveProxyTarget(ctx);
  if (target.ok) handleResolvedTarget(ctx, target.value);
  else handleResolveFailure(ctx, target.message);
}

/**
 * Read-only check for the bin shims (`proxy_float.ts --verify`). Normal floating
 * reads npm publish-time metadata so newly cooldown-aged releases are adopted
 * immediately, but it skips `bun install` when the computed exact target is already
 * installed. An exact `COPILOT_API_VERSION` semver pin is a pure fs check.
 */
export function proxyFloatUpToDate(
  root: string,
  bun: string = process.execPath,
  config?: ProjectConfig,
  minimumReleaseAgeSeconds?: number,
  spawnRunner: SpawnSyncRunner = spawnSync,
  nowMs: number = Date.now(),
): boolean {
  return proxyFloatVerifyStatus(root, bun, config, minimumReleaseAgeSeconds, spawnRunner, nowMs)
    .upToDate;
}

export function proxyFloatVerifyStatus(
  root: string,
  bun: string = process.execPath,
  config?: ProjectConfig,
  minimumReleaseAgeSeconds?: number,
  spawnRunner: SpawnSyncRunner = spawnSync,
  nowMs: number = Date.now(),
): ProxyFloatVerifyStatus {
  if (!nodeModulesFresh(root)) {
    return {
      "upToDate": false,
      "message": "install needed: node_modules is missing or older than bun.lock",
    };
  }

  const installed = installedProxyVersion(root);
  if (installed === null) {
    return {
      "upToDate": false,
      "message": `install needed: ${PROXY_PKG} is missing or unreadable`,
    };
  }

  const override = resolveProxyVersionOverride();
  if (override) return verifyPinnedOverride(installed, override);

  const effectiveConfig = config ?? readProjectConfig(root);
  const effectiveMinimumReleaseAgeSeconds =
    minimumReleaseAgeSeconds ?? resolveMinimumReleaseAgeSeconds(root);

  const target = resolveProxyTarget({
    "root": root,
    "bun": bun,
    "config": effectiveConfig,
    "minimumReleaseAgeSeconds": effectiveMinimumReleaseAgeSeconds,
    "spawnRunner": spawnRunner,
    "nowMs": nowMs,
  });
  return target.ok
    ? verifyResolvedTarget(installed, target.value)
    : verifyResolveFailure(installed, effectiveConfig, target.message);
}

function verifyPinnedOverride(installed: string, override: string): ProxyFloatVerifyStatus {
  if (SEMVER_RE.test(override) && installed === override) {
    return { "upToDate": true, "message": `up to date: ${PROXY_PKG}@${override} pinned` };
  }
  return {
    "upToDate": false,
    "message": `update needed: ${PROXY_VERSION_ENV}=${override}; installed ${installed}`,
  };
}

function verifyResolvedTarget(installed: string, target: ProxyTarget): ProxyFloatVerifyStatus {
  return installed === target.version
    ? {
        "upToDate": true,
        "message": `up to date: ${PROXY_PKG}@${target.version} (${target.reason})`,
      }
    : {
        "upToDate": false,
        "message": `update needed: ${PROXY_PKG} ${installed} -> ${target.version} (${target.reason})`,
      };
}

function verifyResolveFailure(
  installed: string,
  config: ProjectConfig,
  message: string,
): ProxyFloatVerifyStatus {
  const status = proxyVersionFloorStatus(installed, config);
  return !status.ok
    ? {
        "upToDate": false,
        "message": `update needed: update check failed (${message}); installed ${installed} < floor ${config.proxyMinVersion}`,
      }
    : {
        "upToDate": true,
        "message": `no update check: ${message}; keeping ${PROXY_PKG}@${installed}`,
      };
}

/**
 * True when node_modules exists and is at least as new as bun.lock -- i.e. no
 * dependency change has landed since the last install. bun.lock is the source of
 * truth for the installed dependency set, and git only rewrites it on a content
 * change, so "lock newer than node_modules" reliably means the locked deps changed
 * and a reinstall is due. (package.json is intentionally NOT compared: tooling
 * bumps its mtime without touching deps -- a false "stale" -- and any real dependency
 * change updates bun.lock anyway.) A missing/unstattable bun.lock is ignored.
 */
export function nodeModulesFresh(root: string): boolean {
  let nodeModulesMtime: number;
  try {
    nodeModulesMtime = statSync(join(root, "node_modules")).mtimeMs;
  } catch {
    return false; // node_modules absent
  }
  try {
    return statSync(join(root, "bun.lock")).mtimeMs <= nodeModulesMtime;
  } catch {
    return true; // no bun.lock to compare against -- don't force an install on its absence
  }
}

/**
 * CI/dev assertion after `bun install`: the postinstall float is best-effort, so
 * this makes the final installed proxy a hard check. It intentionally answers a
 * different question than --verify: not "can bin/agent skip install?", but "did
 * install leave node_modules in the state the float intended?". The installed
 * version must equal the float's own resolved target, not merely clear the
 * copilot-env.config bounds -- otherwise a silently failed overlay hides behind a
 * lockfile baseline that happens to satisfy the window. A COPILOT_API_VERSION /
 * `proxy-version` config pin must be the installed version (exact semver pins
 * only; tag pins are not equality-checked, and bounds do not apply because a pin
 * bypasses them in the float too). When target resolution fails (npm unreachable)
 * the assert falls back to the bounds-only check so CI does not flake on npm
 * outages; that fallback is deliberately stricter than the float's own failure
 * path (handleResolveFailure enforces only the floor) in that it enforces the
 * ceiling as well.
 */
export function proxyInstallAssertStatus(
  root: string,
  bun: string = process.execPath,
  config?: ProjectConfig,
  minimumReleaseAgeSeconds?: number,
  spawnRunner: SpawnSyncRunner = spawnSync,
  nowMs: number = Date.now(),
): ProxyInstallAssertStatus {
  const installed = installedProxyVersion(root);

  const override = resolveProxyVersionOverride();
  if (override) {
    if (installed === null) {
      return {
        "ok": false,
        "message": `proxy float did not install the pinned ${PROXY_PKG}@${override}; check the version/tag exists (offline?)`,
      };
    }
    return assertPinnedOverride(installed, override);
  }

  const effectiveConfig = config ?? readProjectConfig(root);
  const status = proxyVersionBoundsStatus(installed, effectiveConfig);
  if (!status.ok) {
    switch (status.reason) {
      case "missing":
        return {
          "ok": false,
          "message": `proxy float did not install ${PROXY_PKG} (module resolution failed) - the \`bun install\` postinstall (src/proxy_float.ts) is broken.`,
        };
      case "belowFloor":
        return {
          "ok": false,
          "message": `installed ${PROXY_PKG} ${status.version} is below the ${status.floor} floor - the postinstall proxy float failed to reach the floor.`,
        };
      case "aboveCeiling":
        return {
          "ok": false,
          "message": `installed ${PROXY_PKG} ${status.version} is above the ${status.ceiling} ceiling - the postinstall proxy float overshot PROXY_MAX_VERSION.`,
        };
      default:
        return assertNever(status);
    }
  }

  const window =
    effectiveConfig.proxyMaxVersion === null
      ? `>= ${effectiveConfig.proxyMinVersion} floor`
      : `within [${effectiveConfig.proxyMinVersion}, ${effectiveConfig.proxyMaxVersion}]`;
  const target = resolveProxyTarget({
    "root": root,
    "bun": bun,
    "config": effectiveConfig,
    "minimumReleaseAgeSeconds": minimumReleaseAgeSeconds ?? resolveMinimumReleaseAgeSeconds(root),
    "spawnRunner": spawnRunner,
    "nowMs": nowMs,
  });
  if (!target.ok) {
    return {
      "ok": true,
      "message": `proxy float OK (bounds only, ${window}): ${PROXY_PKG} ${status.version}; float target unresolved (${target.message})`,
    };
  }
  if (status.version !== target.value.version) {
    return {
      "ok": false,
      "message": `installed ${PROXY_PKG} ${status.version} does not match the float target ${target.value.version} (${target.value.reason}) - the postinstall proxy float overlay did not land its target.`,
    };
  }
  return {
    "ok": true,
    "message": `proxy float OK: ${PROXY_PKG} ${status.version} matches the float target (${target.value.reason}; ${window})`,
  };
}

function assertPinnedOverride(installed: string, override: string): ProxyInstallAssertStatus {
  if (!SEMVER_RE.test(override)) {
    return {
      "ok": true,
      "message": `proxy float OK: ${PROXY_PKG} ${installed} is installed; equality is not verified for the '${override}' tag pin (only exact semver pins are equality-checked)`,
    };
  }
  if (installed === override) {
    return {
      "ok": true,
      "message": `proxy float OK: ${PROXY_PKG} ${installed} matches the ${override} pin`,
    };
  }
  return {
    "ok": false,
    "message": `installed ${PROXY_PKG} ${installed} does not match the pinned ${override} (${PROXY_VERSION_ENV} or the proxy-version config) - the postinstall proxy float failed to apply the pin.`,
  };
}

// --- Postinstall / verify/assert entry ---------------------------------------

const DIRECT_ONLY_SKIP_MESSAGE =
  "proxy float skipped: Codex and Claude are both wired Direct; the local proxy is unused";

type ProxyFloatMode = "float" | "verify" | "assert";

/** Parse argv into the one mode this invocation runs in; anything else is a usage error. */
function parseMode(args: string[]): ProxyFloatMode {
  if (args.length === 0) return "float";
  if (args.length === 1) {
    if (args[0] === "--verify") return "verify";
    if (args[0] === "--assert-installed") return "assert";
  }
  logger.error("usage: bun src/proxy_float.ts [--verify | --assert-installed]");
  process.exit(2);
}

/**
 * True when the float's entry points skip: nothing uses the local proxy
 * (proxyUnusedEverywhere) and no COPILOT_API_VERSION env pin. An explicit env
 * pin is per-invocation intent, so it always forces the normal path; a stored
 * `proxy-version` config pin does NOT force it (the config only matters once an
 * agent is wired to the proxy again).
 */
export function proxyFloatSkips(codexHome?: string, claudeHome?: string): boolean {
  const envPinned = Boolean(process.env[PROXY_VERSION_ENV]?.trim());
  return !envPinned && proxyUnusedEverywhere({ codexHome, claudeHome });
}

function mainAssertInstalled(root: string): never {
  if (proxyFloatSkips()) {
    console.log(DIRECT_ONLY_SKIP_MESSAGE);
    process.exit(0);
  }
  try {
    const status = proxyInstallAssertStatus(root, process.execPath, readProjectConfig(root));
    if (status.ok) {
      console.log(status.message);
    } else {
      console.error(`::error::${status.message}`);
    }
    process.exit(status.ok ? 0 : 1);
  } catch (error) {
    console.error(`::error::${errMessage(error)}`);
    process.exit(1);
  }
}

function mainVerify(root: string): never {
  try {
    // The freshness check still gates a real dependency install; only the
    // proxy-target resolution (the npm metadata read) is skipped when Direct-only.
    if (nodeModulesFresh(root) && proxyFloatSkips()) {
      logger.success(`up to date: ${DIRECT_ONLY_SKIP_MESSAGE}`);
      process.exit(0);
    }
    const config = readProjectConfig(root);
    // Don't pre-resolve the cooldown: proxyFloatVerifyStatus resolves it
    // internally AFTER its pin check, so a COPILOT_API_VERSION pin (which
    // bypasses the cooldown) isn't blocked by a bad COPILOT_API_MIN_RELEASE_AGE.
    const status = proxyFloatVerifyStatus(root, process.execPath, config);
    status.upToDate ? logger.success(status.message) : logger.info(status.message);
    process.exit(status.upToDate ? 0 : 1);
  } catch (error) {
    logger.warn(`install needed: verify failed: ${errMessage(error)}`);
    process.exit(1); // uncertain -> install
  }
}

function mainFloat(root: string): void {
  try {
    if (proxyFloatSkips()) {
      logger.info(DIRECT_ONLY_SKIP_MESSAGE);
      return;
    }
    const config = readProjectConfig(root);
    floatProxy(root, process.execPath, config);
  } catch (error) {
    logger.warn(`proxy float skipped: ${errMessage(error)}`);
  }
}

function main(): void {
  const root = PROJECT_ROOT;
  const mode = parseMode(process.argv.slice(2));

  switch (mode) {
    case "assert":
      mainAssertInstalled(root);
      break;
    case "verify":
      mainVerify(root);
      break;
    case "float":
      mainFloat(root);
      break;
    default:
      assertNever(mode);
  }
}

if (import.meta.main) {
  main();
}
