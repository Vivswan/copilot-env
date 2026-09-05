// `agent update`: resolves a release, applies it, refreshes deps, and runs migrations.
import { consola } from "consola";
import {
  applyUpdate,
  type ProvenanceDecision,
  resolveProvenanceDecision,
} from "../autoupdate/apply.ts";
import { withUpdateLock } from "../autoupdate/lock.ts";
import { AutoupdateState, effectiveUpdateCooldownDays } from "../autoupdate/state.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { type Release, resolveTarget } from "../install/resolve-release.ts";
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
//    platform, verifies it against the release checksums.txt and (unless opted
//    out) the release's build-provenance attestation, swaps it in, and lets
//    the new binary lay down its own runtime files and run migrations.

export interface UpdateArgs {
  check?: boolean;
  force?: boolean;
  /** Print autoupdate status and exit. */
  autoStatus?: boolean;
  /** The --verify/--no-verify toggle: Commander folds the pair into ONE option (last
   *  one wins), so it arrives as one optional boolean -- true
   *  forces the build-provenance check on, false skips it for this run, absent
   *  defers to the stored `verify-provenance` config (default: verify). */
  verify?: boolean;
}

/**
 * What ONE `agent update` invocation does -- a status report (`--check` /
 * `--auto-status`) or the manual apply -- parsed ONCE by `parseUpdateAction` at
 * the CLI boundary. `--force` lives on the apply arm alone, so `--auto-status
 * --check` (or a report combined with `--force`) is a rejection instead of
 * whichever flag the old if-chain reached first. The autoupdate preference is the
 * `auto-update` config key, not a flag here.
 */
export type UpdateAction =
  | { kind: "check" }
  | { kind: "auto-status" }
  | { kind: "apply"; force: boolean; verify: boolean | undefined };

/**
 * The under-lock re-validate judgment, pure for testing. `targetNow` is
 * resolveTarget's SECOND look, taken after the update lock is held, and its null
 * unions two different facts: "no eligible release" and "the look failed" (an API
 * error or an offline read, swallowed into null by resolve-release.ts). By the time
 * this runs, the pre-lock resolve has ALREADY proved an eligible release exists, so
 * a null here can only be the failed look -- `unproven`, never the confident
 * `up-to-date`. Keeping the two apart is what stops a transient 5xx from rendering a
 * green "already up to date" over a skipped update; falling back to the pre-lock
 * target instead would defeat the downgrade guard the re-validate exists to be.
 */
export type RecheckVerdict =
  | { kind: "apply"; target: Release }
  | { kind: "up-to-date" }
  | { kind: "unproven" };

/** The pure judgment over the under-lock re-check (see RecheckVerdict). */
export function recheckVerdict(currentNow: string, targetNow: Release | null): RecheckVerdict {
  if (targetNow === null) return { kind: "unproven" };
  if (isUpToDate(currentNow, targetNow.tag)) return { kind: "up-to-date" };
  return { kind: "apply", target: targetNow };
}

/** Parse the raw `agent update` flags into an UpdateAction (the CLI boundary). */
export function parseUpdateAction(args: UpdateArgs): UpdateAction {
  const reports = [args.check, args.autoStatus].filter(Boolean).length;
  if (reports > 1) throw new Error("--check and --auto-status are mutually exclusive");
  if (args.force && reports > 0) {
    throw new Error(
      "--force only applies to the manual update; it does not combine with --check/--auto-status",
    );
  }
  if (args.verify !== undefined && reports > 0) {
    throw new Error(
      "--verify/--no-verify only apply to the manual update; they do not combine with --check/--auto-status",
    );
  }
  if (args.autoStatus) return { kind: "auto-status" };
  if (args.check) return { kind: "check" };
  return { kind: "apply", force: Boolean(args.force), verify: args.verify };
}

export async function runUpdate(args: UpdateArgs): Promise<void> {
  const action = parseUpdateAction(args);
  // The update/autoupdate cooldown is the stored config `update-cooldown` (set via
  // `agent config --set update-cooldown <days>`), else null (immediate). The config key is the
  // single knob -- there is no per-invocation flag.
  const config = new CopilotEnvConfig();
  const cooldown = config.updateCooldownDays();
  assertNonNegativeDays(cooldown, "update-cooldown");

  switch (action.kind) {
    case "auto-status":
      return runAutoStatus(config);
    case "check":
      return runManualUpdate({ check: true, cooldown, force: false });
    case "apply":
      return runManualUpdate({
        check: false,
        cooldown,
        force: action.force,
        // flag > stored config > default, resolved ONCE here (the boundary).
        provenance: resolveProvenanceDecision(action.verify, config.verifyProvenanceEnabled()),
      });
    default:
      assertNever(action);
  }
}

function runAutoStatus(config: CopilotEnvConfig): void {
  const s = new AutoupdateState().read();
  const cooldown = effectiveUpdateCooldownDays();
  const last = s.lastCheckMs > 0 ? new Date(s.lastCheckMs).toISOString() : "never";
  consola.info(
    `Autoupdate: ${
      config.autoUpdateEnabled() ? "enabled" : "disabled"
    } (the auto-update config key) | cooldown ${cooldown}d | ` +
      `last check ${last} | last result: ${s.lastResult || "(none)"}`,
  );
}

async function runManualUpdate(
  args: { check: true; cooldown: number | null; force: false } | {
    check: false;
    cooldown: number | null;
    force: boolean;
    provenance: ProvenanceDecision;
  },
): Promise<void> {
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

  // Running from source means a dev clone that may hold uncommitted or untracked
  // work -- refuse unless --force so an update can't silently touch it. (The
  // distinction is the RootMode this process was started in, not a file probe:
  // an installed binary is freely replaceable.)
  if (!args.force && isProtectedRoot()) {
    throw new Error(
      "This is a source checkout and `agent update` writes a versioned install layout " +
        "into the root; update a checkout via git, or re-run with --force.",
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
    const verdict = recheckVerdict(currentNow, await resolveTarget(args.cooldown));
    if (verdict.kind === "unproven") {
      // A failed re-check, not an up-to-date verdict (see RecheckVerdict): say so
      // and refuse, rather than claim a check that did not happen.
      consola.warn("Could not re-check the latest release under the update lock; not updating.");
      process.exitCode = 2; // same code the pre-lock resolve failure reports
      return;
    }
    if (verdict.kind === "up-to-date") {
      consola.success(`copilot-env is already up to date (${currentNow}).`);
      return;
    }
    await applyUpdate(currentNow, verdict.target, outcome, { provenance: args.provenance });
  });
}
