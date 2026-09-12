// Not the `which` npm package: this also sources nvm.sh so a freshly nvm-installed binary resolves
// in the same process that installed it. Its own module because importing setup.ts here would close
// a cycle (setup -> codex/claude config -> agents/live_probe -> setup).
import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, win32 } from "node:path";

const POSIX_NVM_SH = '"$' + '{NVM_DIR:-$HOME/.nvm}/nvm.sh"';

/** `path` is the bare name on Windows (Get-Command probes, the spawn recipe stays the name). null
 *  means the probe ran and found nothing; a probe that never completed carries `launchFailed`
 *  instead (the same mark as runCaptured), so a failed look never reads as a proven "command
 *  missing". */
export interface CommandLook {
  path: string | null;
  launchFailed?: true;
}

/** Exported for tests. */
export function commandLookFromSpawn(
  result: { status: number | null; error?: unknown },
  resolvedPath: () => string | null,
): CommandLook {
  if (result.error || result.status === null) return { path: null, launchFailed: true };
  if (result.status !== 0) return { path: null };
  return { path: resolvedPath() };
}

export function findCommand(command: string): CommandLook {
  if (process.platform === "win32") {
    const result = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `if (Get-Command ${command} -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }`,
      ],
      { stdio: "ignore" },
    );
    return commandLookFromSpawn(result, () => command);
  }

  const result = spawnSync(
    "sh",
    [
      "-c",
      `command -v "$1" 2>/dev/null || { [ -s ${POSIX_NVM_SH} ] && . ${POSIX_NVM_SH} >/dev/null 2>&1 && command -v "$1" 2>/dev/null; }`,
      "sh",
      command,
    ],
    { encoding: "utf8" },
  );
  return commandLookFromSpawn(result, () => result.stdout.trim() || null);
}

/** A failed look reads false here, which is safe only for consumers whose miss action is
 *  non-destructive (an abort, a skip warn, a proxy fallback). Sites that render a "missing" verdict
 *  or would mutate on the miss go through findCommand and honor the mark. */
export function commandExists(command: string): boolean {
  return findCommand(command).path !== null;
}

/** The same flatten as commandExists: a failed look reads null. */
export function resolveCommand(command: string): string | null {
  return findCommand(command).path;
}

/** A binary found via the nvm fallback may be a `#!/usr/bin/env node` shim that shells out to
 *  `gh`/`node` by name, so the child needs those bin dirs on PATH even when the parent never
 *  sourced nvm. */
export function childPathPrepending(dirs: (string | null | undefined)[]): string {
  const separator = process.platform === "win32" ? ";" : ":";
  const base = process.env.PATH ?? process.env.Path ?? "";
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const part of [...dirs.filter((d): d is string => Boolean(d)), ...base.split(separator)]) {
    if (part && !seen.has(part)) {
      seen.add(part);
      parts.push(part);
    }
  }
  return parts.join(separator);
}

/** On Windows env names are case-insensitive, so `{ ...process.env, PATH }` yields both the
 *  inherited `Path` and the new `PATH`, and which one the child sees is undefined; every PATH
 *  casing is dropped first. The one way to build a PATH-overriding child env: callers that also
 *  drop keys pass `opts.omit`. */
export function childEnvWithPath(
  dirs: (string | null | undefined)[],
  opts: { extra?: Record<string, string>; omit?: (upperKey: string) => boolean } = {},
): Record<string, string> {
  const { extra, omit } = opts;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (upper === "PATH") continue;
    if (omit?.(upper)) continue;
    out[key] = value;
  }
  if (extra) Object.assign(out, extra);
  out.PATH = childPathPrepending(dirs);
  return out;
}

/** Never rejects. A spawn failure (ENOENT, a killing signal) maps to exit 1, the same code many
 *  scans use for a real "ran, found nothing", so that case also carries `launchFailed`; a completed
 *  run never does. */
export function runCaptured(
  file: string,
  args: readonly string[],
  opts: { maxBuffer?: number } = {},
): Promise<{ exitCode: number; stdout: string; launchFailed?: true }> {
  return new Promise((resolve) => {
    // `windowsHide` keeps a no-console Windows parent from flashing a console window. An overflow
    // of `maxBuffer` (16 MiB here, past node's 1 MiB) kills the child and reads as a marked launch
    // failure.
    execFile(
      file,
      args,
      { windowsHide: true, maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error === null) return resolve({ exitCode: 0, stdout });
        if (typeof error.code === "number" && error.code !== 0) {
          return resolve({ exitCode: error.code, stdout });
        }
        resolve({ exitCode: 1, stdout, launchFailed: true });
      },
    );
  });
}

function quoteCmdArg(arg: string): string {
  if (arg !== "" && !/[\s"&|<>^()]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

/** Node joins program and args into one command line that cmd.exe re-parses, so the program is
 *  quoted like every arg; unquoted, `C:\Program Files\...` splits at the space and nothing
 *  launches. */
export function cmdSpawn(
  file: string,
  args: string[],
): { file: string; args: string[]; shell: true } {
  return { file: quoteCmdArg(file), args: args.map(quoteCmdArg), shell: true };
}

/** On Windows the npm-installed CLIs are `.cmd` shims Node refuses to spawn without a shell, hence
 *  the cmd.exe hop. Program-controlled args only: cmd.exe expands `%VAR%` even inside double
 *  quotes, so user-typed args go through verbatimCliSpawn. */
export function cliSpawn(
  file: string,
  args: string[],
): { file: string; args: string[]; shell: boolean } {
  if (process.platform !== "win32") return { file, args, shell: false };
  return cmdSpawn(file, args);
}

/** `binDir` is for callers that prepend it to the child PATH: an npm/nvm shim needs node beside it.
 */
export interface VerbatimCliSpawn {
  file: string;
  args: string[];
  shell: boolean;
  binDir: string | null;
}

/** `pattern` is where.exe's own vocabulary: a bare name searches the cwd first, then PATH (the
 *  agent-CLI launch keeps that, matching what the user's own shell would run); `$ENV:name` scopes
 *  the search to that var. */
function windowsWhereCandidates(pattern: string): string[] {
  const result = spawnSync("where.exe", [pattern], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return [];
  return (result.stdout ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** A shim script cannot stand in for a binary another process spawns as its runtime. Exported for
 *  tests. */
export function pickWindowsExecutable(candidates: string[]): string | null {
  return candidates.find((candidate) => {
    const lower = candidate.toLowerCase();
    return lower.endsWith(".exe") || lower.endsWith(".com");
  }) ?? null;
}

/** A relative PATH entry makes `command -v` print a relative path, which reads null here: a
 *  cwd-dependent resolution is not a stable binary for another process to spawn. A look that never
 *  ran reads null too; every caller's miss action is a non-destructive fallback and null never
 *  renders a verdict. */
export function resolveExecutablePath(command: string): string | null {
  if (process.platform !== "win32") {
    const path = findCommand(command).path;
    return path !== null && isAbsolute(path) ? path : null;
  }
  // `$PATH:` scopes where.exe to PATH: a bare pattern searches the current directory first, the
  // same unstable resolution the POSIX arm rejects.
  return pickWindowsExecutable(windowsWhereCandidates(`$PATH:${command}`));
}

/** Dispatched on extension so user-typed args skip cmd.exe's parser (it expands `%VAR%` even inside
 *  quotes) wherever a direct route exists; a batch-only shim or an unresolved command still takes
 *  the cmd.exe hop. An extensionless candidate (npm's sh script) is not spawnable on Windows and is
 *  skipped; its `.cmd`/`.ps1` siblings are their own candidates. Pure, with the sibling probe
 *  injected, for tests. */
export function pickVerbatimWindowsSpawn(
  command: string,
  candidates: string[],
  args: string[],
  siblingExists: (path: string) => boolean,
): VerbatimCliSpawn {
  // `powershell -File` passes argv literally. win32.dirname explicitly: the pure tests run on
  // POSIX, where plain dirname would not split backslashes.
  const psFile = (ps1: string): VerbatimCliSpawn => ({
    file: "powershell",
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, ...args],
    shell: false,
    binDir: win32.dirname(ps1),
  });
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    if (lower.endsWith(".exe") || lower.endsWith(".com")) {
      return { file: candidate, args, shell: false, binDir: win32.dirname(candidate) };
    }
    if (lower.endsWith(".ps1")) return psFile(candidate);
    // npm always ships a `.ps1` beside its `.cmd`; a batch-only shim falls back to the cmd.exe hop,
    // whose `%` expansion is unavoidable for a bare batch file.
    if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
      const sibling = `${candidate.slice(0, -4)}.ps1`;
      if (siblingExists(sibling)) return psFile(sibling);
      return { ...cmdSpawn(candidate, args), binDir: win32.dirname(candidate) };
    }
  }
  return { ...cmdSpawn(command, args), binDir: null };
}

/** For user-typed args, which the launch contract passes through verbatim: no cmd.exe hop touches
 *  them unless the CLI is a batch-only shim or never resolved. Fixed-arg callers keep using
 *  cliSpawn. */
export function verbatimCliSpawn(command: string, args: string[]): VerbatimCliSpawn {
  if (process.platform !== "win32") {
    const resolved = resolveCommand(command) ?? command;
    return {
      file: resolved,
      args,
      shell: false,
      binDir: resolved.includes("/") ? dirname(resolved) : null,
    };
  }
  return pickVerbatimWindowsSpawn(command, windowsWhereCandidates(command), args, existsSync);
}
