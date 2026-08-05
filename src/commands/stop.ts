// `agent stop`: terminates the tracked local proxy daemon(s).
import { consola } from "consola";
import { stopTrackedProxy } from "../copilot_api/daemon.ts";
import { profileHomeNames } from "../copilot_api/paths.ts";
import { type Profile, parseProfileName, profileLabel } from "../copilot_api/profile.ts";
import { PROJECT_ROOT } from "../utils/root.ts";

export interface StopArgs {
  /** `--profile <name>`: stop that named profile's daemon instead of the default. */
  profile?: string;
  /** `--all`: stop the default daemon AND every named profile's daemon. */
  all?: boolean;
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

/** `stop`: terminate the proxy daemon(s) tracked on this host. */
export async function runStop(args: StopArgs = {}): Promise<void> {
  if (args.all && args.profile !== undefined) {
    throw new Error("--all stops every daemon; it does not combine with --profile");
  }
  const named: Profile = args.profile === undefined ? null : parseProfileName(args.profile);
  const profiles: Profile[] = args.all ? [null, ...profileHomeNames()] : [named];
  let stoppedAny = false;
  for (const profile of profiles) {
    if (await stopOne(profile)) stoppedAny = true;
  }
  if (!stoppedAny) {
    // Not a crash -- just nothing to do. Friendly note, no stack trace, but a
    // non-zero exit so scripts can still tell "stopped" from "nothing running".
    process.exitCode = 1;
    return;
  }
  consola.info(`   Bun env: ${PROJECT_ROOT}`);
}
