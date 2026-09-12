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

// resolveTarget is shared with the autoupdate preflight so the release-pick logic has one home.

export interface UpdateArgs {
  check?: boolean;
  force?: boolean;
  autoStatus?: boolean;
  /** Commander folds `--verify`/`--no-verify` into one option (last wins), so it arrives as one
   *  optional boolean; absent defers to the stored `verify-provenance` key. */
  verify?: boolean;
}

export type UpdateAction =
  | { kind: "check" }
  | { kind: "auto-status" }
  | { kind: "apply"; force: boolean; verify: boolean | undefined };

/**
 * resolveTarget swallows a failed look (API error, offline) into the same null as "no eligible
 * release". The pre-lock resolve already proved a release exists, so under the lock null can only
 * be the failed look: `unproven`, never a green "already up to date" over a skipped update. Falling
 * back to the pre-lock target would defeat the downgrade guard the re-check exists for.
 */
export type RecheckVerdict =
  | { kind: "apply"; target: Release }
  | { kind: "up-to-date" }
  | { kind: "unproven" };

export function recheckVerdict(currentNow: string, targetNow: Release | null): RecheckVerdict {
  if (targetNow === null) return { kind: "unproven" };
  if (isUpToDate(currentNow, targetNow.tag)) return { kind: "up-to-date" };
  return { kind: "apply", target: targetNow };
}

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
  // `v` prefix to match the upstream tag format.
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

  // A source checkout may hold uncommitted work, so refuse unless --force. The distinction is the
  // RootMode this process was started in, not a file probe.
  if (!args.force && isProtectedRoot()) {
    throw new Error(
      "This is a source checkout and `agent update` writes a versioned install layout " +
        "into the root; update a checkout via git, or re-run with --force.",
    );
  }

  consola.start(`Updating copilot-env ${current} -> ${target.tag} ...`);
  // The autoupdate preflight (`agent start` in another shell) takes the same lock; two simultaneous
  // applies would corrupt the tree.
  await withUpdateLock(Date.now(), async (outcome) => {
    if (!outcome.held) {
      consola.warn(
        "Could not take the update lock (another update in progress?); skipping this run.",
      );
      process.exitCode = 1;
      return;
    }
    // A concurrent preflight may have applied a newer release between the resolve above and the
    // lock, and releases only move forward, so the target is re-resolved under the lock before
    // anything is applied.
    const currentNow = `v${packageVersion()}`;
    const verdict = recheckVerdict(currentNow, await resolveTarget(args.cooldown));
    if (verdict.kind === "unproven") {
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
