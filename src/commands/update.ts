// `agent update`: resolves a release, applies it, refreshes deps, and runs migrations.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { consola } from "consola";
import { acquireLock, releaseLock } from "../autoupdate/lock.ts";
import { runPreflight } from "../autoupdate/preflight.ts";
import { AutoupdateState, DEFAULT_AUTOUPDATE_COOLDOWN_DAYS } from "../autoupdate/state.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { resolveTarget } from "../install/resolve-release.ts";
import { PROJECT_ROOT } from "../utils/root.ts";
import { isUpToDate } from "../utils/semver.ts";
import { assertNonNegativeDays } from "../utils/time.ts";
import { packageVersion } from "../utils/version.ts";
import { applyUpdate } from "./apply_update.ts";

// `agent update` brings the checkout up to the newest GitHub release WITHOUT git:
//  - discovery (which release, and its tarball URL) is resolveTarget() from
//    ../install/resolve-release.ts -- the SAME module the installers download + run,
//    so the release-pick logic has one home. Then
//  - apply downloads that release's `tarball_url` and SYNCS it onto the checkout:
//    tracked files are replaced, files the release no longer ships (and OS junk)
//    are pruned, and node_modules/.git are preserved; then `bun install`.

export interface UpdateArgs {
  check?: boolean;
  force?: boolean;
  /** Enable autoupdate (and apply once immediately). */
  auto?: boolean;
  /** Disable autoupdate. */
  noAuto?: boolean;
  /** Print autoupdate status and exit. */
  autoStatus?: boolean;
}

export async function runUpdate(args: UpdateArgs): Promise<void> {
  // The update/autoupdate cooldown is the stored config `update-cooldown` (set via
  // `agent config --set update-cooldown <days>`), else null (immediate). The config key is the
  // single knob -- there is no per-invocation flag.
  const cooldown = new CopilotEnvConfig().read().updateCooldown ?? null;
  assertNonNegativeDays(cooldown, "update-cooldown");

  // Autoupdate management flags short-circuit the manual update flow.
  if (args.autoStatus) return runAutoStatus();
  if (args.noAuto) return runDisableAuto();
  if (args.auto) return runEnableAuto(cooldown);

  await runManualUpdate({ check: args.check, cooldown, force: args.force });
}

function runAutoStatus(): void {
  const s = new AutoupdateState().read();
  // The cooldown ACTUALLY used is the live `update-cooldown` config (see preflight), so show
  // that rather than the value snapshotted into state when autoupdate was last enabled.
  const cooldown = new CopilotEnvConfig().read().updateCooldown ?? DEFAULT_AUTOUPDATE_COOLDOWN_DAYS;
  const last = s.lastCheckMs > 0 ? new Date(s.lastCheckMs).toISOString() : "never";
  consola.info(
    `Autoupdate: ${s.enabled ? "enabled" : "disabled"} | cooldown ${cooldown}d | ` +
      `last check ${last} | last result: ${s.lastResult || "(none)"}`,
  );
}

function runDisableAuto(): void {
  new AutoupdateState().set({ enabled: false });
  consola.success("Autoupdate disabled.");
}

async function runEnableAuto(cooldown: number | null): Promise<void> {
  const cooldownDays = cooldown ?? DEFAULT_AUTOUPDATE_COOLDOWN_DAYS;
  const state = new AutoupdateState();
  state.set({ enabled: true, cooldownDays });
  consola.success(`Autoupdate enabled (cooldown ${cooldownDays}d). Checking now ...`);
  // Enable + apply now: run the daily routine once immediately, forcing past the
  // once-per-day gate. Failures are recorded in state and never throw out.
  await runPreflight({ nowMs: Date.now(), force: true, state });
}

async function runManualUpdate(args: {
  check?: boolean;
  cooldown: number | null;
  force?: boolean;
}): Promise<void> {
  // Current checkout version as `vX.Y.Z`, to match the upstream tag format for display.
  const current = `v${packageVersion()}`;
  const target = await resolveTarget(args.cooldown);
  if (!target) {
    consola.warn("No copilot-env release found upstream (or the network is unavailable).");
    process.exitCode = 2; // distinct from "update available" (1) and "up to date" (0)
    return;
  }

  if (isUpToDate(current, target.tag)) {
    consola.success(`copilot-env is up to date (${current}).`);
    return;
  }

  consola.info(`Update available: ${current} -> ${target.tag}`);
  if (args.check) {
    process.exitCode = 1; // an update is available
    return;
  }

  // The sync overwrites/prunes the checkout in place. A `.git` dir means this is a git
  // checkout (a dev/manual clone, not a tarball install) that may hold uncommitted or
  // untracked work -- refuse unless --force so an update can't silently destroy it.
  // (existsSync is a file probe, not a git command; tarball installs have no .git and
  // update freely.)
  if (!args.force && existsSync(join(PROJECT_ROOT, ".git"))) {
    throw new Error(
      "This is a git checkout (.git present) and `agent update` overwrites files in place; " +
        "commit or stash your changes and re-run with --force (or update via git).",
    );
  }

  consola.start(`Updating copilot-env ${current} -> ${target.tag} ...`);
  // Take the autoupdate lock so a manual update can't race a concurrent autoupdate preflight
  // (triggered by `agent start` in another shell) applying a release onto the same checkout --
  // two simultaneous mirrors/migrations would corrupt the tree.
  if (!acquireLock(Date.now())) {
    consola.warn("Another update is already in progress (autoupdate); skipping this run.");
    process.exitCode = 1;
    return;
  }
  try {
    // Re-validate UNDER the lock: a concurrent preflight may have applied a NEWER release
    // between our resolve above and acquiring the lock. Re-read the on-disk version (fresh --
    // packageVersion() is not cached) and re-resolve, so we never apply a now-stale target
    // that would DOWNGRADE the checkout (releases only ever move forward).
    const currentNow = `v${packageVersion()}`;
    const targetNow = await resolveTarget(args.cooldown);
    if (!targetNow || isUpToDate(currentNow, targetNow.tag)) {
      consola.success(`copilot-env is already up to date (${currentNow}).`);
      return;
    }
    await applyUpdate(currentNow, targetNow);
  } finally {
    releaseLock();
  }
}
