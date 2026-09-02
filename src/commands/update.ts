// `agent update`: resolves a release, applies it, refreshes deps, and runs migrations.
import { consola } from "consola";
import { applyUpdate } from "../autoupdate/apply.ts";
import { withUpdateLock } from "../autoupdate/lock.ts";
import { runPreflight } from "../autoupdate/preflight.ts";
import { AutoupdateState, effectiveUpdateCooldownDays } from "../autoupdate/state.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { resolveTarget } from "../install/resolve-release.ts";
import { assertNever } from "../utils/assert.ts";
import { isProtectedRoot } from "../utils/root.ts";
import { isUpToDate } from "../utils/semver.ts";
import { assertNonNegativeDays } from "../utils/time.ts";
import { packageVersion } from "../utils/version.ts";

// `agent update` moves this install to the newest GitHub release WITHOUT git:
//  - discovery (which release) is resolveTarget() from
//    ../install/resolve-release.ts, shared with the autoupdate preflight so the
//    release-pick logic has one home. Then
//  - apply (../autoupdate/apply.ts) downloads that release's binary for this
//    platform, verifies it against the release checksums.txt, swaps it in, and
//    lets the new binary lay down its own runtime files and run migrations.

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

/**
 * What ONE `agent update` invocation does -- a status report (`--check` /
 * `--auto-status`), an autoupdate toggle, or the manual apply -- parsed ONCE by
 * `parseUpdateAction` at the CLI boundary. `--force` lives on the apply arm
 * alone, so `--auto-status --check` (or a report combined with `--force`) is a
 * rejection instead of whichever flag the old if-chain reached first.
 */
export type UpdateAction =
  | { kind: "check" }
  | { kind: "auto-status" }
  | { kind: "enable-auto" }
  | { kind: "disable-auto" }
  | { kind: "apply"; force: boolean };

/** Parse the raw `agent update` flags into an UpdateAction (the CLI boundary). */
export function parseUpdateAction(args: UpdateArgs): UpdateAction {
  const reports = [args.check, args.auto, args.noAuto, args.autoStatus].filter(Boolean).length;
  if (reports > 1) {
    throw new Error("--check, --auto, --no-auto, and --auto-status are mutually exclusive");
  }
  if (args.force && reports > 0) {
    throw new Error(
      "--force only applies to the manual update; it does not combine with --check/--auto/--no-auto/--auto-status",
    );
  }
  if (args.autoStatus) return { kind: "auto-status" };
  if (args.noAuto) return { kind: "disable-auto" };
  if (args.auto) return { kind: "enable-auto" };
  if (args.check) return { kind: "check" };
  return { kind: "apply", force: Boolean(args.force) };
}

export async function runUpdate(args: UpdateArgs): Promise<void> {
  const action = parseUpdateAction(args);
  // The update/autoupdate cooldown is the stored config `update-cooldown` (set via
  // `agent config --set update-cooldown <days>`), else null (immediate). The config key is the
  // single knob -- there is no per-invocation flag.
  const cooldown = new CopilotEnvConfig().updateCooldownDays();
  assertNonNegativeDays(cooldown, "update-cooldown");

  switch (action.kind) {
    case "auto-status":
      return runAutoStatus();
    case "disable-auto":
      return runDisableAuto();
    case "enable-auto":
      return runEnableAuto();
    case "check":
      return runManualUpdate({ check: true, cooldown, force: false });
    case "apply":
      return runManualUpdate({ check: false, cooldown, force: action.force });
    default:
      assertNever(action);
  }
}

function runAutoStatus(): void {
  const s = new AutoupdateState().read();
  const cooldown = effectiveUpdateCooldownDays();
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

async function runEnableAuto(): Promise<void> {
  const cooldownDays = effectiveUpdateCooldownDays();
  const state = new AutoupdateState();
  state.set({ enabled: true });
  consola.success(`Autoupdate enabled (cooldown ${cooldownDays}d). Checking now ...`);
  // Enable + apply now: run the daily routine once immediately, forcing past the
  // once-per-day gate. Failures are recorded in state and never throw out.
  await runPreflight({ nowMs: Date.now(), force: true, state });
}

async function runManualUpdate(args: {
  check: boolean;
  cooldown: number | null;
  force: boolean;
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

  // The sync overwrites/prunes the install root in place. Running from source means a
  // dev clone that may hold uncommitted or untracked work -- refuse unless --force so an
  // update can't silently destroy it. (The distinction is the RootMode this process was
  // started in, not a file probe: an installed binary is freely replaceable.)
  if (!args.force && isProtectedRoot()) {
    throw new Error(
      "This is a source checkout and `agent update` overwrites files in place; " +
        "commit or stash your changes and re-run with --force (or update via git).",
    );
  }

  consola.start(`Updating copilot-env ${current} -> ${target.tag} ...`);
  // Take the autoupdate lock so a manual update can't race a concurrent autoupdate preflight
  // (triggered by `agent start` in another shell) applying a release onto the same checkout --
  // two simultaneous mirrors/migrations would corrupt the tree.
  await withUpdateLock(Date.now(), async (outcome) => {
    if (!outcome.held) {
      consola.warn(
        "Could not take the update lock (another update in progress?); skipping this run.",
      );
      process.exitCode = 1;
      return;
    }
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
    await applyUpdate(currentNow, targetNow, outcome);
  });
}
