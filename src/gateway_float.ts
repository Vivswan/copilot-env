// The gateway float — the one dependency copilot-env tracks to "latest" (clamped
// to releases >=7 days old by bunfig's minimumReleaseAge). This module IS the
// `bun install` postinstall hook (package.json: "bun src/gateway_float.ts &&
// patch-package"): main() — guarded by import.meta.main — floats the gateway in the
// package root bun just installed into. src/user_cache.ts is independent: it only
// mirrors caches and runs `bun install`, so the install is the sole handoff and
// the two files never import each other.
//
// Uses only node builtins (+ the dep-free ./project_config.ts), so it has no
// install-order constraints and tests can import floatGateway directly without the
// postinstall main() running.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ProjectConfig, readProjectConfig } from "./project_config.ts";
import { versionLessThan } from "./utils/semver.ts";

const GATEWAY_PKG = "@jeffreycao/copilot-api";

/** Default float re-check cadence: re-resolve from the registry at most weekly. */
export const GATEWAY_CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

// Override: set COPILOT_API_VERSION to a specific version (e.g. "1.10.30") or a
// dist-tag to pin the gateway, bypassing both the floor and the 7-day cooldown.
// Lets you adopt a fresh release immediately when you trust it. Unset = float
// per GATEWAY_MIN_VERSION in copilot-env.config.
const GATEWAY_VERSION_ENV = "COPILOT_API_VERSION";

const SECONDS_PER_DAY = 24 * 60 * 60;
// bunfig.toml's minimumReleaseAge expressed in days — the window the float probe
// uses when no COPILOT_API_COOLDOWN_DAYS override is set; shown in the ">=N-day-old" line.
const BUNFIG_COOLDOWN_DAYS = 7;

// Float failures throw rather than process.exit: the postinstall entry (main,
// below) catches them so a transient registry/offline hiccup never fails the whole
// `bun install`, and tests can import floatGateway without aborting the runner.
function fail(msg: string): never {
  throw new Error(msg);
}

function gatewayInstalled(cache: string): boolean {
  return existsSync(join(cache, "node_modules", "@jeffreycao", "copilot-api", "package.json"));
}

/** Installed gateway version (from its package.json), or null if unresolved. */
function installedGatewayVersion(cache: string): string | null {
  try {
    const pkgPath = join(cache, "node_modules", "@jeffreycao", "copilot-api", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/** Full semver shape (core + optional prerelease/build), anchored. */
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** The version recorded in the float stamp (its content), or null if absent/legacy. */
function readRecordedVersion(stamp: string): string | null {
  try {
    const content = readFileSync(stamp, "utf-8").trim();
    return SEMVER_RE.test(content) ? content : null;
  } catch {
    return null;
  }
}

/** True if `v` is within the configured [floor, max] window (max optional, inclusive). */
function withinGatewayWindow(v: string, config: ProjectConfig): boolean {
  if (versionLessThan(v, config.gatewayMinVersion)) return false;
  if (config.gatewayMaxVersion !== null && versionLessThan(config.gatewayMaxVersion, v))
    return false;
  return true;
}

function applyPatches(cache: string, bun: string): number {
  const result = spawnSync(bun, [join(cache, "node_modules", "patch-package", "index.js")], {
    cwd: cache,
    stdio: ["ignore", process.stderr, "inherit"],
  });
  return result.status ?? 1;
}

/**
 * Float the gateway, overlaying the runtime root's node_modules via `bun add
 * --no-save` so the read-only package.json / bun.lock are never written — only
 * the gateway moves; every other dep stays at its locked version.
 *
 * Resolution order:
 *   1. COPILOT_API_VERSION set  -> pin exactly that, cooldown bypassed.
 *   2. default                  -> newest release in [GATEWAY_MIN_VERSION,
 *                                  GATEWAY_MAX_VERSION] and >=7 days old (bunfig
 *                                  cooldown). Floats forward as releases age in,
 *                                  never below the floor or above the cap.
 *   3. (2) finds nothing yet    -> pin exactly GATEWAY_MIN_VERSION, cooldown
 *                                  bypassed, so the floor is always available.
 *
 * `cooldownSeconds` (the COPILOT_API_COOLDOWN_DAYS override, in seconds; null = absent) overrides the
 * release-age window for the FLOAT PROBE only (path 2). The floor pin (path 3) and
 * the COPILOT_API_VERSION override (path 1) still bypass the cooldown, so the floor
 * stays installable and a trusted override is always adopted (priority MIN >
 * cooldown > MAX).
 *
 * The resolved version is recorded in the `.gateway-checked` stamp (its content
 * is the version; its mtime is the weekly throttle). A registry re-resolution
 * runs only when forced (a baseline (re)install just happened), the gateway is
 * missing, no version is recorded yet, the recorded version falls outside the
 * [floor, max] window, or the last check was over `checkIntervalMs` ago. Otherwise
 * it self-heals: if the installed gateway drifted from the recorded target (e.g. a
 * plain `bun install` reinstalled a different release into the same node_modules),
 * it pins that exact version back + repatches. Offline policy: if a refresh fails
 * but a >=floor gateway is installed, we warn, keep it, and back off; if only a
 * sub-floor (or no) gateway is available, we fail loudly rather than run an
 * out-of-contract gateway.
 */
export function floatGateway(
  cache: string,
  bun: string,
  force: boolean,
  config: ProjectConfig,
  cooldownSeconds: number | null,
  checkIntervalMs: number = GATEWAY_CHECK_INTERVAL_MS,
): void {
  const stamp = join(cache, ".gateway-checked");
  const present = gatewayInstalled(cache);
  const override = process.env[GATEWAY_VERSION_ENV]?.trim();
  // Display window for the "≥N-day-old" messages: the explicit cooldown-override
  // days when set, else bunfig's default (7).
  const cooldownDays =
    cooldownSeconds !== null ? cooldownSeconds / SECONDS_PER_DAY : BUNFIG_COOLDOWN_DAYS;

  // Misconfiguration guard: a ceiling below the floor can never be satisfied.
  if (
    config.gatewayMaxVersion !== null &&
    versionLessThan(config.gatewayMaxVersion, config.gatewayMinVersion)
  ) {
    fail(
      `GATEWAY_MAX_VERSION (${config.gatewayMaxVersion}) is below GATEWAY_MIN_VERSION (${config.gatewayMinVersion})`,
    );
  }

  const run = (spec: string, bypassCooldown: boolean, quiet = false): number => {
    const args = ["add", `${GATEWAY_PKG}@${spec}`, "--no-save", "--ignore-scripts"];
    if (bypassCooldown) {
      // Floor pin, COPILOT_API_VERSION override, and self-heal reinstall always
      // bypass the cooldown: the floor must stay installable (MIN outranks the
      // cooldown) and an explicit override is a trusted "adopt now" escape hatch.
      args.push("--minimum-release-age=0");
    } else if (cooldownSeconds !== null) {
      // The float probe: the cooldown override beats bunfig's default release-age window.
      // Otherwise the probe relies on bunfig.toml's minimumReleaseAge default.
      args.push(`--minimum-release-age=${cooldownSeconds}`);
    }
    const result = spawnSync(bun, args, {
      cwd: cache,
      // Route bun's stdout to our stderr so it doesn't pollute the cache-path
      // capture in the bin shims (`CACHE="$(...)"`). `quiet` captures stderr so
      // an *expected* failure (e.g. the cooldown blocking the >=floor probe)
      // stays silent; we re-emit it only when the error is unexpected.
      stdio: ["ignore", process.stderr, quiet ? "pipe" : "inherit"],
    });
    if (quiet && result.status !== 0) {
      const err = result.stderr?.toString() ?? "";
      // The cooldown blocking the probe is the normal "nothing aged in yet"
      // case — swallow it. Surface anything else (real network/registry errors).
      if (!err.includes("minimum-release-age")) {
        process.stderr.write(err);
      }
    }
    const status = result.status ?? 1;
    return status === 0 ? applyPatches(cache, bun) : status;
  };

  if (override) {
    // An exact pin already installed is a no-op (dist-tags always re-resolve).
    if (SEMVER_RE.test(override) && installedGatewayVersion(cache) === override) {
      return;
    }
    process.stderr.write(`==> Pinning ${GATEWAY_PKG}@${override} (cooldown bypassed) ...\n`);
    const code = run(override, true);
    if (code !== 0 && !present) {
      fail(`failed to install ${GATEWAY_PKG}@${override} (exit ${code})`);
    }
    if (code !== 0) {
      process.stderr.write(
        `user-cache: WARNING: could not pin ${GATEWAY_PKG}@${override} (offline?); using installed version\n`,
      );
    }
    return; // override never stamps — next unset run should re-check immediately
  }

  // Re-resolve from the registry only when forced (a baseline (re)install just
  // happened), the gateway is missing, no target is recorded yet, or the weekly
  // stamp has aged out. Otherwise we hold the recorded target and self-heal.
  const recorded = readRecordedVersion(stamp);
  let due = force || !present || recorded === null;
  // Re-resolve if the recorded target now falls outside the [floor, max] window
  // (e.g. the floor was raised, or a ceiling added/lowered, since it was recorded).
  if (!due && recorded !== null && !withinGatewayWindow(recorded, config)) {
    due = true;
  }
  if (!due) {
    try {
      due = Date.now() - statSync(stamp).mtimeMs > checkIntervalMs;
    } catch {
      due = true; // no stamp yet — check now
    }
  }

  // Target range: >=floor, and <=max when a ceiling is configured.
  const rangeSpec = config.gatewayMaxVersion
    ? `>=${config.gatewayMinVersion} <=${config.gatewayMaxVersion}`
    : `>=${config.gatewayMinVersion}`;

  if (due) {
    // Newest in-range release past the 7-day cooldown. Quiet: a cooldown block
    // here just means "nothing aged in yet" and is handled below.
    process.stderr.write(
      `==> Checking ${GATEWAY_PKG} for updates (${rangeSpec}, >=${cooldownDays}-day-old) ...\n`,
    );
    let code = run(rangeSpec, false, true);

    // Nothing in range has cleared the cooldown yet — guarantee the floor itself.
    // Quiet too: if the probe already failed for a real reason (e.g. offline) it
    // printed once; the WARNING/die below conveys the final outcome.
    if (code !== 0) {
      process.stderr.write(
        `==> No ${rangeSpec} release is ${cooldownDays} days old yet; pinning the ${config.gatewayMinVersion} floor (cooldown bypassed) ...\n`,
      );
      code = run(config.gatewayMinVersion, true, true);
    }

    if (code === 0) {
      // Record the resolved version (content); mtime = now is the weekly
      // throttle. We hold this exact version until the next resolution.
      try {
        writeFileSync(stamp, `${installedGatewayVersion(cache) ?? config.gatewayMinVersion}\n`);
      } catch {
        // non-fatal; we just re-check on the next run
      }
      return;
    }

    // Resolution failed (e.g. offline). Never run a sub-floor gateway: if the
    // installed version is below the floor (or absent), fail loudly. Otherwise
    // keep the installed >=floor gateway; back off (re-stamp with it) when it's
    // in-window so we don't re-probe the registry on every bootstrap.
    const installedOnFail = installedGatewayVersion(cache);
    if (installedOnFail === null || versionLessThan(installedOnFail, config.gatewayMinVersion)) {
      fail(
        `could not install ${GATEWAY_PKG} ${rangeSpec} (offline?) and the installed version (${installedOnFail ?? "none"}) is below the ${config.gatewayMinVersion} floor`,
      );
    }
    process.stderr.write(
      `user-cache: WARNING: could not refresh ${GATEWAY_PKG} (offline?); keeping installed ${installedOnFail}\n`,
    );
    if (withinGatewayWindow(installedOnFail, config)) {
      try {
        writeFileSync(stamp, `${installedOnFail}\n`);
      } catch {
        // non-fatal; we just re-check on the next run
      }
    }
    return;
  }

  // Not due: hold the recorded target. If the installed gateway drifted from it
  // (e.g. a plain `bun install` pulled a different >=7-day-old release into the
  // same node_modules), pin that exact version back + repatch — no registry
  // round-trip, since `recorded` was already vetted by a prior resolution.
  const installed = installedGatewayVersion(cache);
  if (recorded !== null && installed !== recorded) {
    process.stderr.write(
      `==> Installed ${GATEWAY_PKG}@${installed ?? "none"} != pinned ${recorded}; reinstalling + repatching ...\n`,
    );
    const code = run(recorded, true);
    if (code !== 0 && !present) {
      fail(`failed to reinstall ${GATEWAY_PKG}@${recorded} (exit ${code})`);
    }
    if (code !== 0) {
      const subFloor = installed !== null && versionLessThan(installed, config.gatewayMinVersion);
      process.stderr.write(
        `user-cache: WARNING: could not reinstall ${GATEWAY_PKG}@${recorded} (offline?); using installed ${installed ?? "none"}${subFloor ? ` — BELOW the ${config.gatewayMinVersion} floor` : ""}\n`,
      );
    }
  }
}

// --- Postinstall entry --------------------------------------------------------
// `bun install` runs this via the package.json "postinstall" hook, right after it
// (re)lays node_modules. The float lives entirely here; src/user_cache.ts just
// mirrors caches and runs `bun install`, so the two files are independent and only
// meet through this hook. Best-effort: a registry/offline hiccup never fails the
// install (runtime visibility comes from start.ts logging the resolved version).
//
// The cooldown/cadence CLI flags were dropped in favor of env vars, inherited
// straight through `bun install` (so `COPILOT_API_COOLDOWN_DAYS=14 ./bin/agent …`
// just works), alongside the existing COPILOT_API_VERSION:
//   COPILOT_API_COOLDOWN_DAYS        float-probe release-age window, in days
//   COPILOT_API_FLOAT_INTERVAL_DAYS  re-check cadence, in days
//   COPILOT_API_NO_FLOAT             set (non-empty) to skip the float entirely
const COOLDOWN_DAYS_ENV = "COPILOT_API_COOLDOWN_DAYS";
const FLOAT_INTERVAL_DAYS_ENV = "COPILOT_API_FLOAT_INTERVAL_DAYS";
const NO_FLOAT_ENV = "COPILOT_API_NO_FLOAT";

/** Parse a whole-number-of-days env var, or null when unset/empty. Throws on junk. */
function envDays(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return null;
  const n = Number.parseInt(raw, 10);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n)) {
    fail(`${name} must be a whole number of days (got '${raw}')`);
  }
  return n;
}

function main(): void {
  if (process.env[NO_FLOAT_ENV]?.trim()) return; // float disabled via env

  // During a postinstall lifecycle script, cwd is the package root bun installed
  // into — the runtime root (the checkout in-place, or a per-user cache).
  const root = process.cwd();

  try {
    const config = readProjectConfig(root);
    const cooldownDays = envDays(COOLDOWN_DAYS_ENV);
    const cooldownSeconds = cooldownDays === null ? null : cooldownDays * SECONDS_PER_DAY;
    const intervalDays = envDays(FLOAT_INTERVAL_DAYS_ENV);
    const checkIntervalMs =
      intervalDays === null ? GATEWAY_CHECK_INTERVAL_MS : intervalDays * SECONDS_PER_DAY * 1000;

    // process.execPath is the running bun, reused for the inner `bun add`.
    // force=false: lean on the .gateway-checked weekly stamp + self-heal so running
    // on every `bun install` doesn't re-probe the registry each time.
    floatGateway(root, process.execPath, false, config, cooldownSeconds, checkIntervalMs);
  } catch (error) {
    // Best-effort: never fail `bun install` over the float.
    process.stderr.write(
      `user-cache: WARNING: gateway float skipped: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

// Run as a script (the postinstall hook), but not when imported (tests).
if (import.meta.main) {
  main();
}
