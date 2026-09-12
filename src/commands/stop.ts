import { consola } from "consola";
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

export interface StopArgs {
  profile?: string;
  all?: boolean;
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

async function stopOne(profile: Profile): Promise<boolean> {
  const { trackedPid, signalled, stopped } = await stopTrackedProxy(0, profile);
  const what = profile === null ? "proxy" : `${profileLabel(profile)} proxy`;
  if (trackedPid === undefined) {
    consola.info(`The ${what} is not running on this host (nothing to stop).`);
    return false;
  }
  if (!signalled) {
    if (!stopped) {
      // stopTrackedProxy already warned why the pid was not signalled; the summary must agree
      // nothing changed.
      consola.info(`The ${what} (PID ${trackedPid}) was left running; tracking kept.`);
    } else {
      consola.info(`The ${what} (PID ${trackedPid}) was already stopped; cleared stale tracking.`);
    }
    return false;
  }
  consola.info(`Stopped the ${what} (PID ${trackedPid})`);
  return true;
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
  let stoppedAny = false;
  for (const profile of stopTargets(action)) {
    if (await stopOne(profile)) stoppedAny = true;
  }
  if (!stoppedAny) {
    // Non-zero without a throw: scripts can tell "stopped" from "nothing running" and nobody sees a
    // stack trace.
    process.exitCode = 1;
    return;
  }
  consola.info(`   Install root: ${PROJECT_ROOT}`);
}
