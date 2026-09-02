// `agent stop`: terminates the tracked local proxy daemon(s).
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
  /** `--profile <name>`: stop that named profile's daemon instead of the default. */
  profile?: string;
  /** `--all`: stop the default daemon AND every named profile's daemon. */
  all?: boolean;
}

/**
 * What ONE `agent stop` invocation addresses -- every daemon, one named
 * profile's, or the default's -- parsed ONCE by `parseStopAction` at the CLI
 * boundary, where `--all --profile` is rejected instead of one flag winning.
 */
export type StopAction =
  | { kind: "all" }
  | { kind: "profile"; name: ProfileName }
  | { kind: "default" };

/** Parse the raw `agent stop` flags into a StopAction (the CLI boundary). */
export function parseStopAction(args: StopArgs): StopAction {
  if (args.all && args.profile !== undefined) {
    throw new Error("--all stops every daemon; it does not combine with --profile");
  }
  if (args.all) return { kind: "all" };
  const named = parseProfileFlag(args.profile);
  return named === null ? { kind: "default" } : { kind: "profile", name: named };
}

/** Stop one daemon and report the outcome. Returns true when something was stopped. */
async function stopOne(profile: Profile): Promise<boolean> {
  const { trackedPid, signalled } = await stopTrackedProxy(0, profile);
  const what = profile === null ? "proxy" : `${profileLabel(profile)} proxy`;
  if (trackedPid === undefined) {
    consola.info(`The ${what} is not running on this host (nothing to stop).`);
    return false;
  }
  if (!signalled) {
    consola.info(`The ${what} (PID ${trackedPid}) was already stopped; cleared stale tracking.`);
    return false;
  }
  consola.info(`Stopped the ${what} (PID ${trackedPid})`);
  return true;
}

/** The daemons one StopAction addresses (`null` = the default daemon). */
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

/** `stop`: terminate the proxy daemon(s) tracked on this host. */
export async function runStop(args: StopArgs = {}): Promise<void> {
  const action = parseStopAction(args);
  let stoppedAny = false;
  for (const profile of stopTargets(action)) {
    if (await stopOne(profile)) stoppedAny = true;
  }
  if (!stoppedAny) {
    // Not a crash -- just nothing to do. Friendly note, no stack trace, but a
    // non-zero exit so scripts can still tell "stopped" from "nothing running".
    process.exitCode = 1;
    return;
  }
  consola.info(`   Install root: ${PROJECT_ROOT}`);
}
