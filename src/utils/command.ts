// The command look and the child environment every CLI probe and launch share. Its own module
// because importing setup.ts here would close a cycle (setup -> codex/claude config ->
// agents/live_probe -> setup).
import { type ChildProcess, execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { deadline } from "@std/async/deadline";
import * as fs from "./fs_facade.ts";

/** Mostly startup: PowerShell 5.1 takes seconds cold or under load; the work takes milliseconds. */
export const POWERSHELL_COMMAND_TIMEOUT_MS = 10_000;

/** Not TERM: a child ignoring it holds a sync spawn forever; the runtime waits for the exit. */
export const LOOK_KILL_SIGNAL = "SIGKILL";

/** `found` carries the path Bun.which resolved (a relative PATH entry answers relative on Windows,
 *  joined with cwd elsewhere); `absent` is proven: an in-process PATH walk cannot fail to look. */
export type CommandLook = { kind: "found"; path: string } | { kind: "absent" };

/** `powershell -File` passes argv literally: the one spelling for launching a `.ps1` with the
 *  caller's args verbatim (the agent launcher). */
export function powershellFileArgs(ps1: string, args: readonly string[]): string[] {
  return ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, ...args];
}

export type PowershellExe = "powershell" | "pwsh";

/** Windows PowerShell 5.1 spawned from pwsh 7 inherits pwsh's PSModulePath and its in-box cmdlets
 *  fail to autoload, so a `powershell` child gets the variable under no casing and `pwsh` keeps
 *  its own. */
export function withPowershellChildEnv<T>(
  exe: PowershellExe,
  spawn: (env: Record<string, string>) => T,
): T {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (exe === "powershell" && key.toUpperCase() === "PSMODULEPATH") continue;
    env[key] = value;
  }
  return spawn(env);
}

/** A PowerShell process writes its profile scaffolding (AppData\\Roaming, the PSReadLine history)
 *  under the profile directories it inherits, so every `powershell` spawn of ours that launches
 *  nothing for the user runs under a scratch profile: the user's HOME (or a test's fingerprinted
 *  one) sees none of it. `env` is the override to spread over withPowershellChildEnv's; `dispose`
 *  removes the profile once the spawn has returned. */
export function scratchPowershellProfile(): {
  env: Record<string, string>;
  dispose(): void;
} {
  const profile = fs.scratchDir(join(tmpdir(), "copilot-env-ps-"));
  return {
    env: {
      USERPROFILE: profile,
      APPDATA: join(profile, "AppData", "Roaming"),
      LOCALAPPDATA: join(profile, "AppData", "Local"),
    },
    dispose: () => fs.removeScratchDir(profile),
  };
}

export function currentPath(): string {
  return process.env.PATH ?? process.env.Path ?? "";
}

/** Bun.which over `path`: this process's PATH, or the one an installer just changed in the
 *  registry. On Windows it tries .exe, .cmd, .bat, then .com for a bare name, reading no PATHEXT. */
export function findCommand(command: string, path: string = currentPath()): CommandLook {
  const found = Bun.which(command, { PATH: path });
  return found === null ? { kind: "absent" } : { kind: "found", path: found };
}

export function resolveCommand(command: string): string | null {
  const look = findCommand(command);
  return look.kind === "found" ? look.path : null;
}

/** A child's environment: the parent's minus the keys `omit` names, then `extra` on top, with
 *  PATH replaced by `path` (the registry-refreshed one after a Windows install) or led by
 *  `leadPath`. `omit` sees each key upper-cased, since Windows env names are case-insensitive and a
 *  scrub of `CODEX_HOME` must catch an inherited `Codex_Home` too; for the same reason a PATH
 *  override drops every inherited casing first, or the child would get both `Path` and `PATH`. */
export function childEnv(
  opts: {
    path?: string;
    leadPath?: readonly string[];
    extra?: Record<string, string>;
    omit?: (upperKey: string) => boolean;
  } = {},
): Record<string, string> {
  const { path, leadPath = [], extra, omit } = opts;
  const overridesPath = path !== undefined || leadPath.length > 0;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (overridesPath && upper === "PATH") continue;
    if (omit?.(upper)) continue;
    out[key] = value;
  }
  if (overridesPath) out.PATH = [...leadPath, path ?? currentPath()].join(delimiter);
  if (extra) Object.assign(out, extra);
  return out;
}

export interface CapturedRun {
  exitCode: number;
  stdout: string;
  launchFailed?: true;
}

/** Never rejects, and never outlives `timeoutMs`. A spawn failure (ENOENT, a killing signal, the
 *  bound) maps to exit 1, the same code many scans use for a real "ran, found nothing", so that case
 *  also carries `launchFailed`; a completed run never does. */
export async function runCaptured(
  file: string,
  args: readonly string[],
  opts: { timeoutMs: number; maxBuffer?: number; env?: Record<string, string | undefined> },
): Promise<CapturedRun> {
  let child: ChildProcess | undefined;
  const run = new Promise<CapturedRun>((resolve) => {
    // `windowsHide` keeps a no-console Windows parent from flashing a console window. An overflow
    // of `maxBuffer` (16 MiB here, past node's 1 MiB) kills the child and reads as a marked launch
    // failure.
    child = execFile(
      file,
      args,
      {
        windowsHide: true,
        maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
        env: opts.env,
        timeout: opts.timeoutMs,
        killSignal: LOOK_KILL_SIGNAL,
      },
      (error, stdout) => {
        if (error === null) return resolve({ exitCode: 0, stdout });
        if (typeof error.code === "number" && error.code !== 0) {
          return resolve({ exitCode: error.code, stdout });
        }
        resolve({ exitCode: 1, stdout, launchFailed: true });
      },
    );
  });
  try {
    return await deadline(run, opts.timeoutMs);
  } catch {
    // Bun on macOS can drop a child's exit notification (oven-sh/bun#41024): the child is gone,
    // yet the callback never comes, and the library's own timeout only kills and then waits for
    // that same exit.
    child?.unref();
    return { exitCode: 1, stdout: "", launchFailed: true };
  }
}

/** Only an absolute answer is a stable binary for another process to spawn: a relative PATH entry
 *  answers relative on Windows. Null never renders a verdict. */
export function resolveExecutablePath(command: string): string | null {
  const path = resolveCommand(command);
  return path !== null && isAbsolute(path) ? path : null;
}
