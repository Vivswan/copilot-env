import { consola } from "consola";
import { COLOR_ENABLED, statusPaint } from "../utils/ansi.ts";
import { stopTrackedProxy } from "../copilot_api/daemon.ts";
import { profileHomeNames } from "../copilot_api/paths.ts";
import {
  parseProfileFlag,
  type Profile,
  profileLabel,
  type ProfileName,
} from "../copilot_api/profile.ts";
import { assertNever } from "../utils/assert.ts";
import { PROJECT_ROOT } from "../utils/root.ts";
import { dryRunActive } from "../utils/fs_facade.ts";
import { runDryRun } from "./dry_run.ts";

/** A status word in its tone, the edge's COLOR_ENABLED resolved once here. */
const status = (word: string): string => statusPaint(word, COLOR_ENABLED);

export interface StopArgs {
  profile?: string;
  all?: boolean;
  /** Print the daemon the stop would signal and the tracking rows it would clear; signal nothing. */
  dryRun?: boolean;
}

export type StopAction =
  | { kind: "all" }
  | { kind: "profile"; name: ProfileName }
  | { kind: "default" };

export function parseStopAction(args: StopArgs): StopAction {
  if (args.all && args.profile !== undefined) {
    throw new Error("--all stops every daemon; it does not combine with --profile");
  }
  if (args.all) return { kind: "all" };
  const named = parseProfileFlag(args.profile);
  return named === null ? { kind: "default" } : { kind: "profile", name: named };
}

/** The stop's outcome and what to say about it once it is real; a dry run prints the plan and
 *  drops the narration (stopTrackedProxy itself says which daemon it would signal). */
async function stopOne(profile: Profile): Promise<{ stopped: boolean; narrate: () => void }> {
  const { trackedPid, signalled, stopped } = await stopTrackedProxy(0, profile);
  const what = profile === null ? "proxy" : `${profileLabel(profile)} proxy`;
  if (trackedPid === undefined) {
    return {
      stopped: false,
      narrate: () =>
        consola.info(`The ${what} is ${status("not running")} on this host (nothing to stop).`),
    };
  }
  if (!signalled) {
    return {
      stopped: false,
      narrate: () =>
        consola.info(
          stopped
            ? `The ${what} (PID ${trackedPid}) was already ${
              status("stopped")
            }; cleared stale tracking.`
            // stopTrackedProxy already warned why the pid was not signalled; the summary must
            // agree nothing changed.
            : `The ${what} (PID ${trackedPid}) was left ${status("running")}; tracking kept.`,
        ),
    };
  }
  return {
    stopped: true,
    narrate: () => consola.info(`${status("Stopped")} the ${what} (PID ${trackedPid})`),
  };
}

function stopTargets(action: StopAction): Profile[] {
  switch (action.kind) {
    case "all":
      return [null, ...profileHomeNames()];
    case "profile":
      return [action.name];
    case "default":
      return [null];
    default:
      return assertNever(action);
  }
}

export async function runStop(args: StopArgs = {}): Promise<void> {
  const action = parseStopAction(args);
  const run = async (): Promise<() => void> => {
    const outcomes: Awaited<ReturnType<typeof stopOne>>[] = [];
    for (const profile of stopTargets(action)) {
      const outcome = await stopOne(profile);
      // Said as it lands, so a later profile's failure (`--all`) never hides a stop that happened;
      // a dry run says nothing here (its plan is the stdout).
      if (!dryRunActive()) outcome.narrate();
      outcomes.push(outcome);
    }
    const stoppedAny = outcomes.some((o) => o.stopped);
    // Non-zero without a throw: scripts can tell "stopped" from "nothing running" and nobody sees a
    // stack trace.
    if (!stoppedAny) process.exitCode = 1;
    return () => {
      if (stoppedAny) consola.info(`   Install root: ${PROJECT_ROOT}`);
    };
  };
  if (args.dryRun) {
    await runDryRun(run);
    return;
  }
  (await run())();
}
