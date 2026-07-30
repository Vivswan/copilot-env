// The ONE pid-liveness primitive. Both the daemon lifecycle (copilot_api/process.ts,
// which re-exports it) and the file-lock staleness judgment (utils/file_lock.ts) key
// off this decision, so they can never disagree about whether the same pid is alive.
// It lives in utils because file_lock cannot import copilot_api/process.ts (that
// would drag execa/ps-list into the lock's import graph).

/** Check if a process is alive via a null signal. EPERM means the process EXISTS but
 *  this (restricted/sandboxed) token can't signal it -- e.g. Codex's packaged app
 *  spawning our probe. That is still "alive"; only ESRCH is dead. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
