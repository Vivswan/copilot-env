// Three-state process scans for the desktop apps copilot-env writes config for (the Codex app,
// Claude Desktop). "present" and "absent" are PROVEN readings (the scan ran to completion and
// emitted its verdict); "unproven" is a look that FAILED (pgrep/PowerShell erroring or missing, or
// the spawn itself failing) and never reads as a confident absence, as in classifyPidFromScan
// (src/copilot_api/process.ts).
import { runCaptured } from "./command.ts";

export type AppScan = "present" | "absent" | "unproven";

export type ScanExec = (
  file: string,
  args: string[],
) => Promise<{ exitCode: number; stdout: string; launchFailed?: true }>;

/** The exit-0 guard is LOAD-BEARING beside the word check: a scan killed AFTER printing its verdict
 *  (a timeout kill, OOM, a user interrupt) exits nonzero with a valid word already on stdout, and
 *  on the Windows path this guard is the sole protection against minting a proven reading from it.
 */
export function appScanVerdict(result: { exitCode: number; stdout: string }): AppScan {
  if (result.exitCode !== 0) return "unproven";
  const verdict = result.stdout.trim();
  return verdict === "present" || verdict === "absent" ? verdict : "unproven";
}

/** For tools that already speak a three-state exit vocabulary (pgrep, `open -Ra`: 0 match, 1
 *  ran-no-match, anything else an error). runCaptured synthesizes the same exit 1 for a look that
 *  never ran, so a proven absence also requires no launch-failure mark. */
export function appScanFromExit(result: { exitCode: number; launchFailed?: true }): AppScan {
  if (result.launchFailed) return "unproven";
  if (result.exitCode === 0) return "present";
  return result.exitCode === 1 ? "absent" : "unproven";
}

/** 'absent' ONLY on the SPECIFIC no-match error id, a nonzero verdict-less exit for every other
 *  failure, so no real Get-Process error can flatten into a proven reading. */
export function processScanScript(appName: string): string {
  return `try { $null = Get-Process -Name '${appName}' -ErrorAction Stop; 'present' } ` +
    "catch { if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenName*') { 'absent' } else { exit 1 } }";
}

/** Whether a desktop app is running now, by its process name. */
export async function appRunning(
  appName: string,
  exec: ScanExec = runCaptured,
  platform: string = process.platform,
): Promise<AppScan> {
  if (platform === "win32") {
    return appScanVerdict(
      await exec("powershell", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        processScanScript(appName),
      ]),
    );
  }
  // pgrep's exit vocabulary is already three-state; the launch-failure mark separates a REAL exit 1
  // from the one runCaptured synthesizes for a pgrep that never ran.
  return appScanFromExit(await exec("pgrep", ["-x", appName]));
}
