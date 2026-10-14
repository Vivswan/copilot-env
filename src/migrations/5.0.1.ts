// Away from 5.0.1, two fix-ups: the deno-era daemon and files go, then the file locks' sidecars.
//
// The proxy daemon ran on a deno under `<rootHome>/deno/` with the float's deno files beside it;
// it runs from the binary now, so all of it is debris. A daemon that release left running holds
// its home's daemon.lock and reads as foreign to this release's classifier, so it is proved and
// stopped first (legacy_daemon.ts). The file locks' `.oslock` sidecars are debris too, swept AFTER
// the daemon step (index.ts registry order): the sidecar beside a daemon.lock is its proof.

import { dirname, join } from "node:path";
import { poll } from "@std/async";
import { consola } from "consola";
import { autoupdateDir } from "../autoupdate/state.ts";
import { daemonLockPath } from "../copilot_api/daemon_lock.ts";
import { allDaemonHomes, resolveRootHome } from "../copilot_api/paths.ts";
import {
  listenerLookCommand,
  listUserProcessRows,
  lookupProcess,
  type ProcessLook,
  type ProcessRow,
  processLookCommand,
  stopPidCommand,
} from "../copilot_api/process.ts";
import { assertNever } from "../utils/assert.ts";
import { readTextOrNull } from "../utils/fs.ts";
import * as fs from "../utils/fs_facade.ts";
import type { Migration } from "./index.ts";
import {
  argvPort,
  type DenoStopOutcome,
  denoLockSidecarPath,
  isDenoRuntimeRow,
  type LockVerdict,
  type ProvenDaemon,
  ProvenLock,
  prove,
  removeLockPair,
  stopProvenDaemon,
} from "./legacy_daemon.ts";

const OS_LOCK_SUFFIX = ".oslock";

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

/** A daemon.lock's sidecar is the daemon step's evidence that the lock is the deno release's
 *  (legacy_daemon.ts), so it goes only on that step's own verdict: the author gone (a leftover)
 *  or no marker at all. A live daemon, an unjudged marker, or one this process cannot read keeps
 *  it for the re-run the step asked for. */
async function keepsDenoLockSidecar(path: string): Promise<boolean> {
  if (path !== denoLockSidecarPath(dirname(path))) return false;
  const verdict = await prove(dirname(path));
  if (verdict instanceof ProvenLock) return verdict.isDaemon();
  return verdict.kind !== "none";
}

/** Exported for the migration test; `roots` isolates. */
export async function removeOsLockSidecars(roots: readonly string[]): Promise<void> {
  for (const path of roots.flatMap(osLockSidecarsUnder)) {
    if (await keepsDenoLockSidecar(path)) {
      consola.info(
        `  kept ${path}: its daemon.lock is not proved free (the daemon step owns both)`,
      );
      continue;
    }
    fs.rm(path, { force: true });
    consola.info(`  removed ${path} (the lock is the marker file itself now)`);
  }
}

export const v501OsLockSidecars: Migration = {
  version: "5.0.1",
  description: "remove the file locks' retired .oslock sidecars",
  run: (installRoot) => removeOsLockSidecars([resolveRootHome(), autoupdateDir(installRoot)]),
};

/** The marker the float wrote into its `.npmrc`; an unmarked file is the user's and stays. */
const NPMRC_MARKER = "# managed by copilot-env (proxy float); do not edit";

/** Reached only through retireDenoDaemon, once every daemon that may run from the files is proved
 *  stopped or gone. */
function removeDenoLeftovers(rootHome: string): void {
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

/** The shape of every warning here: a headline, the evidence indented under it, then the commands,
 *  each on its own line, so the eye finds the pid and the command without reading a paragraph. */
function scannable(headline: string, evidence: string, ...commands: string[]): string {
  return [`  ${headline}`, `    ${evidence}`, ...commands.map((command) => `    ${command}`)].join(
    "\n",
  );
}

/** The migrate command the runner's own retry line names; a step does not know the versions. */
const MIGRATE_AGAIN = "agent migrate <from> <to>   (the two versions this update printed)";

/** The seams the migration test replaces: the proof (`prove` with staged reads, or a verdict that
 *  licenses nothing; the classes have one builder), the stop, and the table scan behind the
 *  files' clearance. */
export interface DaemonStepSeams {
  prove: (home: string) => Promise<LockVerdict>;
  stop: (daemon: ProvenDaemon) => Promise<DenoStopOutcome>;
  scan: () => Promise<ProcessRow[] | "unproven">;
  /** The re-read of one deno row the scan could not read. */
  relook: (pid: number) => Promise<ProcessLook>;
}

const REAL_SEAMS: DaemonStepSeams = {
  prove,
  stop: stopProvenDaemon,
  scan: listUserProcessRows,
  relook: lookupProcess,
};

/** A deno row with no command line is re-read in these steps before it is judged: Win32_Process
 *  reports a null CommandLine for a process on its way out, which is no stray. */
const UNREADABLE_ROW_RECHECK_MS = 1_000;
const UNREADABLE_ROW_STEP_MS = 100;

/**
 * Each home's lock is proved against the live table (`prove`) and only a proof licenses a signal
 * or a delete; every other verdict narrates and, unless it is ours or a bystander, keeps the
 * files. Exported for the migration test.
 *
 *   `clear` false -> a daemon may still run, so retireDenoDaemon keeps the files it may run from
 */
export async function stopPreviousDaemons(
  homes: readonly string[],
  seams: Partial<DaemonStepSeams> = {},
): Promise<{ clear: boolean; wouldStop: Set<number> }> {
  const { prove, stop } = { ...REAL_SEAMS, ...seams };
  let clear = true;
  const wouldStop = new Set<number>();
  for (const home of homes) {
    const lock = daemonLockPath(home);
    const verdict = await prove(home);
    if (verdict instanceof ProvenLock) {
      if (verdict.isDaemon()) {
        const outcome = await stopDenoHolder(verdict, stop);
        if (outcome === "may-run") clear = false;
        if (outcome === "would-stop") wouldStop.add(verdict.pid);
      } else {
        removeLockPair(verdict);
        consola.info(`  removed ${lock} and its .oslock sidecar (${leftoverReason(verdict)})`);
      }
      continue;
    }
    switch (verdict.kind) {
      case "none":
      case "ours":
        continue;
      case "bystander":
        consola.info(
          `  left ${lock} alone: pid ${verdict.pid} is not the deno-era daemon (${verdict.command})`,
        );
        continue;
      case "unreadable":
        consola.warn(scannable("left a home as it is: its daemon.lock cannot be read", lock));
        clear = false;
        continue;
      case "unjudged":
        consola.warn(
          verdict.pid === null
            ? scannable(`left a home as it is: ${verdict.reason}`, lock)
            : verdict.command === ""
              ? scannable(
                  `left a daemon running: this host cannot read what pid ${verdict.pid} is`,
                  `${lock} names pid ${verdict.pid}, alive; ${verdict.reason}`,
                  `if it is the deno-era proxy daemon, on its host:  ${stopPidCommand(verdict.pid)}`,
                )
              : scannable(
                  `left a daemon running: pid ${verdict.pid} is a deno, but ${verdict.reason}`,
                  `${lock} names pid ${verdict.pid}: ${verdict.command}`,
                  `if it is the deno-era proxy daemon:  ${stopPidCommand(verdict.pid)}`,
                ),
        );
        clear = false;
        continue;
      default:
        assertNever(verdict);
    }
  }
  return { clear, wouldStop };
}

function leftoverReason(lock: ProvenLock): string {
  switch (lock.reason) {
    case null:
      return "";
    case "dead":
      return "left by a daemon that is gone";
    case "malformed":
      return "a marker naming no pid";
    case "zombie":
      return `pid ${lock.pid} is a zombie awaiting its parent: it holds no port and nothing stops it`;
    case "recycled":
      return `the deno release's lock; pid ${lock.pid} is now ${lock.command}`;
    case "stranger":
      return `the deno release's lock; pid ${lock.pid} started after it was written: ${lock.command}`;
    default:
      return assertNever(lock.reason);
  }
}

/** Narrates the stop of a proven daemon: "may-run" when it may still run, "would-stop" in a dry
 *  run (the table still shows it; the plan reads it as gone). */
async function stopDenoHolder(
  daemon: ProvenDaemon,
  stop: (daemon: ProvenDaemon) => Promise<DenoStopOutcome>,
): Promise<"stopped" | "may-run" | "would-stop"> {
  const { pid, home } = daemon;
  const lock = daemonLockPath(home);
  const outcome = await stop(daemon);
  switch (outcome.kind) {
    case "would-stop":
      // Staged on the overlay, as the real stop removes them: the plan lists every removal.
      removeLockPair(daemon);
      consola.info(
        `  would stop the deno-era proxy daemon (pid ${pid}) in ${home} and remove ${lock} and its .oslock sidecar`,
      );
      return "would-stop";
    case "still-running":
      consola.warn(
        outcome.identity === "same"
          ? scannable(
              `the deno-era proxy daemon (pid ${pid}) did not stop: ${outcome.verdict}`,
              `pid ${pid} is still that daemon after the SIGKILL grace; ${lock} may be gone`,
              `stop it by hand:  ${stopPidCommand(pid, true)}`,
            )
          : scannable(
              `the deno-era proxy daemon (pid ${pid}) may not have stopped: ${outcome.verdict}`,
              `pid ${pid} is alive after the SIGKILL grace, and this host can no longer read what it is`,
              `look first:  ${processLookCommand(pid)}`,
            ),
      );
      return "may-run";
    case "port-still-busy":
      consola.warn(
        scannable(
          `the deno-era proxy daemon (pid ${pid}) stopped, but port ${outcome.port} is still busy`,
          `127.0.0.1:${outcome.port} still answers; whatever listens there is not the daemon of ${home}`,
          `find it:  ${listenerLookCommand(outcome.port)}`,
        ),
      );
      return "may-run";
    case "stopped":
      removeLockPair(daemon);
      consola.info(
        `  stopped the deno-era proxy daemon (pid ${pid}) in ${home}: ${outcome.verdict}; removed ${lock} and its .oslock sidecar`,
      );
      return "stopped";
    default:
      return assertNever(outcome);
  }
}

/** The process table's spelling of a path, for the provenance match below. */
function argvSpelling(path: string): string {
  const slashed = path.replace(/\\/g, "/");
  return process.platform === "win32" ? slashed.toLowerCase() : slashed;
}

/** What the table says of this root home's deno processes, the locks apart. */
type StrayScan =
  | { kind: "unproven" }
  /** `strays` ran from this root home (argv names its proxy/deno.json, with or without a port:
   *  the clearance is wider than the signal path's shape); `unreadable` are denos whose argv the
   *  table would not show, which could be strays. */
  | { kind: "rows"; strays: ProcessRow[]; unreadable: ProcessRow[] };

/**
 * The deno processes of THIS root home still alive whatever their locks say. The deno release's
 * spawn put `<rootHome>/proxy/deno.json` (its `--config`) on every argv: that is the provenance,
 * port or no port. A zombie's argv is gone and matches nothing.
 *
 *   ignore -> the pids a dry run would have stopped: the plan reads them as gone
 */
async function strayDenoDaemons(
  rootHome: string,
  seams: Pick<DaemonStepSeams, "scan" | "relook">,
  ignore: ReadonlySet<number>,
): Promise<StrayScan> {
  const rows = await seams.scan();
  if (rows === "unproven") return { kind: "unproven" };
  const config = argvSpelling(join(rootHome, "proxy", "deno.json"));
  const denos = rows.filter(
    (row) => isDenoRuntimeRow(row) && row.pid !== process.pid && !ignore.has(row.pid),
  );
  const settled: ProcessRow[] = [];
  for (const row of denos) settled.push(...(await rereadUnreadable(row, seams.relook)));
  return {
    kind: "rows",
    strays: settled.filter((row) => argvSpelling(row.command).includes(config)),
    unreadable: settled.filter((row) => row.command === ""),
  };
}

/** The re-read asks one thing of a row with no command line: is the pid still there? What it
 *  shows meanwhile is never read (the listing's owner judgment does not travel with a re-read). */
async function rereadUnreadable(
  row: ProcessRow,
  relook: (pid: number) => Promise<ProcessLook>,
): Promise<ProcessRow[]> {
  if (row.command !== "") return [row];
  try {
    await poll(
      () => relook(row.pid),
      (seen) => seen.kind === "gone",
      {
        interval: UNREADABLE_ROW_STEP_MS,
        signal: AbortSignal.timeout(UNREADABLE_ROW_RECHECK_MS),
      },
    );
    return [];
  } catch (error) {
    if (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name)) {
      return [row];
    }
    throw error;
  }
}

/** The deno-era files go only once every daemon that may run from them is proved stopped or gone
 *  AND the table shows no daemon of this root home at all; otherwise they stay and the warning is
 *  the record of the step left undone (re-run `agent migrate`). Exported for the migration test. */
export async function retireDenoDaemon(
  rootHome: string,
  homes: readonly string[],
  seams: Partial<DaemonStepSeams> = {},
): Promise<void> {
  const stops = await stopPreviousDaemons(homes, seams);
  let { clear } = stops;
  const scan = await strayDenoDaemons(rootHome, { ...REAL_SEAMS, ...seams }, stops.wouldStop);
  if (scan.kind === "unproven") {
    consola.warn(
      scannable(
        "could not scan the process table for a deno-era daemon of this root home",
        "a daemon that dropped its lock would go unseen",
        "re-run where the table reads",
      ),
    );
    clear = false;
  } else {
    for (const row of scan.unreadable) {
      consola.warn(
        scannable(
          `a deno runs whose command line this host cannot read: pid ${row.pid}`,
          "it may be the deno-era proxy daemon of this root home",
          `look first:  ${processLookCommand(row.pid)}`,
        ),
      );
      clear = false;
    }
    for (const row of scan.strays) {
      const port = argvPort(row.command);
      consola.warn(
        scannable(
          `a deno of this root home still runs: pid ${row.pid}${port === null ? "" : ` on port ${port}`}`,
          row.command,
          `if it is that daemon:  ${stopPidCommand(row.pid)}`,
        ),
      );
      clear = false;
    }
  }
  if (!clear) {
    consola.warn(
      scannable(
        "the deno-era files stay: a daemon above still runs or could not be judged",
        `${join(rootHome, "deno")} and the float's deno files go on the next run`,
        `after it is stopped:  ${MIGRATE_AGAIN}`,
      ),
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
