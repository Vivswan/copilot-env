// Away from 5.0.1, two fix-ups.
//
// The file lock (src/utils/file_lock.ts) held an OS advisory lock on a permanent `<lock>.oslock`
// sidecar beside every marker, never unlinked by design. The lock is the marker file itself now,
// so every sidecar is debris: swept out of the root home (the store locks, each profile home's
// daemon.lock, the run dirs' start locks, the usage index) and the install's `.autoupdate/`, each
// named as it goes.
//
// The proxy daemon ran on a deno the binary downloaded under `<rootHome>/deno/`, with the float's
// cache beside it, its import map and lockfile in the proxy home, and a marked `.npmrc` at the
// root. The daemon runs from the binary itself now and the float installs with bun, so all of it
// is debris; the proxy home's record stays and the next `agent start` reinstalls the recorded
// version. A daemon that release left running still holds its home's daemon.lock, and the new
// classifier (which gates on the bun runtime) reads it as a foreign process: `agent stop` would
// refuse it and the next start's own daemon would fail the lock, so it is stopped first, judged by
// the lock and the pid's command line (a reboot reuses pid numbers).

import { join } from "node:path";
import { consola } from "consola";
import { autoupdateDir } from "../autoupdate/state.ts";
import { clearDeadDaemonLock, daemonLockHold, daemonLockPath } from "../copilot_api/daemon_lock.ts";
import { allDaemonHomes, resolveRootHome } from "../copilot_api/paths.ts";
import { classifyDaemonPid } from "../copilot_api/process.ts";
import { assertNever } from "../utils/assert.ts";
import { readTextOrNull } from "../utils/fs.ts";
import * as fs from "../utils/fs_facade.ts";
import type { Migration } from "./index.ts";
import {
  foreignHolderWarning,
  type LockedDaemonOutcome,
  stopLockedDaemon,
} from "./legacy_daemon.ts";

const OS_LOCK_SUFFIX = ".oslock";

/** Whether `pid` is this release's daemon: "no" is the previous release's, "unknown" no verdict. */
type DaemonClassifier = (pid: number) => Promise<"yes" | "no" | "unknown">;

/** The stop by the lock and the pid's command line (./legacy_daemon.ts). */
type DaemonStopper = (home: string) => Promise<LockedDaemonOutcome>;

/** What stopping one home's daemon leaves the lock sweep: the marker to judge (`sweep`), nothing
 *  (`left`: the daemon is ours, or the stop was only previewed), or a daemon that may still run
 *  (`unclear`: named, and the deno-era files stay). */
type StopVerdict = "sweep" | "left" | "unclear";

/** Every `*.oslock` under `dir`, through links never (a link is the link). */
function osLockSidecarsUnder(dir: string): string[] {
  let entries: ReturnType<typeof fs.readdirEntries>;
  try {
    entries = fs.readdirEntries(dir);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return osLockSidecarsUnder(path);
    return entry.isFile() && entry.name.endsWith(OS_LOCK_SUFFIX) ? [path] : [];
  });
}

/** Exported for the migration test; `roots` isolates. */
export function removeOsLockSidecars(roots: readonly string[]): void {
  for (const path of roots.flatMap(osLockSidecarsUnder)) {
    fs.rm(path, { force: true });
    consola.info(`  removed ${path} (the lock is the marker file itself now)`);
  }
}

/** Clears the root home and the install's `.autoupdate/` of sidecars; silent when none is left. */
export const v501OsLockSidecars: Migration = {
  version: "5.0.1",
  description: "remove the file locks' retired .oslock sidecars",
  run: (installRoot) => removeOsLockSidecars([resolveRootHome(), autoupdateDir(installRoot)]),
};

/** The marker the float wrote into its `.npmrc`; an unmarked file is the user's and stays. */
const NPMRC_MARKER = "# managed by copilot-env (proxy float); do not edit";

/** Exported for the migration test; `rootHome` isolates. */
export function removeDenoLeftovers(rootHome: string): void {
  const paths = [
    join(rootHome, "deno"),
    join(rootHome, "proxy", "deno.json"),
    join(rootHome, "proxy", "deno.lock"),
  ];
  const npmrc = join(rootHome, ".npmrc");
  if (readTextOrNull(npmrc)?.includes(NPMRC_MARKER)) paths.push(npmrc);
  for (const path of paths) {
    if (fs.readTextResult(path).kind === "absent") continue;
    fs.rm(path, { recursive: true, force: true });
    consola.info(`  removed ${path} (the proxy daemon runs from the binary itself now)`);
  }
}

/** The stop's outcome narrated, and the verdict it leaves the sweep. */
function reportStopOutcome(home: string, outcome: LockedDaemonOutcome): StopVerdict {
  switch (outcome.kind) {
    case "would-stop":
      consola.info(
        `  would stop the previous release's proxy daemon (pid ${outcome.pid}) in ${home}`,
      );
      return "left";
    case "stopped":
      if (outcome.stillRunning) {
        consola.warn(
          `  the previous release's proxy daemon (pid ${outcome.pid}) in ${home} would not stop (${outcome.verdict}); left as it is`,
        );
        return "unclear";
      }
      consola.info(
        `  stopped the previous release's proxy daemon (pid ${outcome.pid}) in ${home}: ${outcome.verdict}`,
      );
      return "sweep";
    case "unjudged":
      consola.warn(
        `  could not judge the daemon holding ${daemonLockPath(home)}: ${outcome.reason}; left as it is`,
      );
      return "unclear";
    case "foreign":
      consola.warn(foreignHolderWarning(home, outcome));
      return "unclear";
    case "none":
      // The holder went between the two looks: the sweep judges the marker as it is now.
      return "sweep";
    default:
      return assertNever(outcome);
  }
}

/** The daemon holding `home`'s lock judged, and stopped when it is the previous release's. */
async function stopHeldDaemon(
  home: string,
  pid: number,
  classify: DaemonClassifier,
  stop: DaemonStopper,
): Promise<StopVerdict> {
  const verdict = await classify(pid);
  if (verdict === "unknown") {
    consola.warn(
      `  could not judge the daemon holding ${daemonLockPath(home)} (pid ${pid}); left as it is: stop it yourself if it is the previous release's`,
    );
    return "unclear";
  }
  if (verdict === "yes") return "left";
  return reportStopOutcome(home, await stop(home));
}

/** The marker a daemon that is gone left, removed and named. A preview names a free marker still
 *  on disk instead: the removal is a raw unlink outside the write seam. */
function sweepDeadLock(home: string, free: boolean, preview: boolean): void {
  const lock = daemonLockPath(home);
  if (preview) {
    if (free && fs.exists(lock)) consola.info(`  would remove ${lock}`);
    return;
  }
  if (clearDeadDaemonLock(home)) consola.info(`  removed ${lock} (left by a daemon that is gone)`);
}

/**
 * The previous release's daemon reads "no" under the new classifier and ours "yes"; "unknown" is
 * left alone rather than taken as licence. Exported for the migration test; `homes`, `classify`,
 * and `stop` isolate.
 *
 *   explicit dry run -> the marker removal is a raw unlink outside the write seam, and a signal
 *                       has no overlay
 *   `clear` false    -> a daemon may still run, so retireDenoDaemon keeps the files it may run from
 */
export async function stopPreviousDaemons(
  homes: readonly string[],
  classify: DaemonClassifier = classifyDaemonPid,
  stop: DaemonStopper = stopLockedDaemon,
): Promise<{ clear: boolean }> {
  const preview = fs.dryRunActive();
  let clear = true;
  for (const home of homes) {
    const hold = daemonLockHold(home);
    if (hold.kind === "unreadable") {
      consola.warn(`  could not read ${daemonLockPath(home)}; left as it is`);
      clear = false;
      continue;
    }
    if (hold.kind === "held" && hold.pid !== null) {
      const verdict = await stopHeldDaemon(home, hold.pid, classify, stop);
      if (verdict === "unclear") clear = false;
      if (verdict !== "sweep") continue;
    }
    sweepDeadLock(home, hold.kind === "free", preview);
  }
  return { clear };
}

/** The deno-era files go only once every daemon that may run from them is confirmed stopped or
 *  absent; otherwise they stay, and the warning is the record of the step left undone: the user
 *  stops the daemon and re-runs `agent migrate` (safe to re-run). Exported for the migration test. */
export async function retireDenoDaemon(
  rootHome: string,
  homes: readonly string[],
  classify: DaemonClassifier = classifyDaemonPid,
  stop: DaemonStopper = stopLockedDaemon,
): Promise<void> {
  const { clear } = await stopPreviousDaemons(homes, classify, stop);
  if (!clear) {
    consola.warn(
      `  the deno-era files under ${rootHome} stay: a daemon above is still running or could not be judged. Stop it, then re-run \`agent migrate <from> <to>\` with the versions this update named (safe to re-run)`,
    );
    return;
  }
  removeDenoLeftovers(rootHome);
}

export const v501DenoLeftovers: Migration = {
  version: "5.0.1",
  description:
    "stop the retired deno daemon, then remove the sidecar, its cache, and the float's deno files",
  run: () => {
    // The root home itself too: before 4.0.9 the default daemon ran there, and an install updating
    // across both releases still has that daemon's lock at the root.
    const rootHome = resolveRootHome();
    return retireDenoDaemon(rootHome, [rootHome, ...allDaemonHomes()]);
  },
};
