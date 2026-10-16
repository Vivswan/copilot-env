/** The kill the host's own shell has: cmd.exe knows only taskkill (PowerShell aliases `kill` too),
 *  and a daemon detached with a hidden window is reached by the forced form alone. Read at render
 *  time, so advice names the command of the host that prints it. */
export function killCommand(pid: number): string {
  return process.platform === "win32" ? `taskkill /F /PID ${pid}` : `kill ${pid}`;
}
