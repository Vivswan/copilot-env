// PATH command resolution with an nvm fallback, shared by setup, health probes,
// and the direct probe. NOT the `which` npm package: this also sources nvm.sh so a
// freshly nvm-installed binary (codex/claude/gh/node) resolves in the SAME process
// that installed it, and uses Get-Command on Windows. Kept in its own module (not
// commands/setup.ts) so lower-level utilities can resolve binaries without
// importing the heavier setup module -- which would form an import cycle
// (setup -> codex/claude config -> agents/live_probe -> setup).
import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, win32 } from "node:path";

// `command -v` first, then a best-effort nvm fallback so a freshly nvm-installed
// Node/CLI resolves in the same process that installed it (PATH not yet reloaded).
const POSIX_NVM_SH = '"$' + '{NVM_DIR:-$HOME/.nvm}/nvm.sh"';

/**
 * One look for a command. `path` is the resolution (the bare name on Windows,
 * where Get-Command probes but the spawn recipe stays the name); null means the
 * probe RAN and found nothing. A probe that never completed (the `sh`/
 * `powershell` spawn itself erroring or killed) additionally carries
 * `launchFailed: true` -- the same mark contract as runCaptured below -- so a
 * failed look never has to read as a proven "command missing".
 */
export interface CommandLook {
  path: string | null;
  launchFailed?: true;
}

/** Pure verdict over a finished probe spawn (exported for tests): a spawn error
 *  or a null status (killed, never ran) is the marked failed look; exit 0 asks
 *  `resolvedPath` for the resolution; any other exit is a proven absence. */
export function commandLookFromSpawn(
  result: { status: number | null; error?: unknown },
  resolvedPath: () => string | null,
): CommandLook {
  if (result.error || result.status === null) return { path: null, launchFailed: true };
  if (result.status !== 0) return { path: null };
  return { path: resolvedPath() };
}

/** Look for `command` (PATH, or via the nvm fallback on POSIX) with the failure
 *  arm kept: consumers that render a "missing" verdict key on the mark to say
 *  "could not check" instead. */
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

/** True when `command` is runnable (PATH, or via the nvm fallback on POSIX).
 *  Accepted flatten: a FAILED look (findCommand's launchFailed) reads false here,
 *  for boolean consumers whose miss action is non-destructive (an abort, a skip
 *  warn, a proxy fallback) -- a machine that cannot spawn `sh`/`powershell` fails
 *  those follow-ups loudly on its own. Sites that render a "missing" verdict or
 *  would MUTATE on the miss (setup's installs, the launch gate) go through
 *  findCommand instead and treat the mark honestly. */
export function commandExists(command: string): boolean {
  return findCommand(command).path !== null;
}

/** Resolve `command` to its path (PATH, or via the nvm fallback on POSIX); null
 *  if absent -- the same accepted flatten as commandExists (see there). */
export function resolveCommand(command: string): string | null {
  return findCommand(command).path;
}

/**
 * Build a PATH with `dirs` prepended to the current process PATH (deduped, in
 * order). Used when spawning a binary that resolveCommand found via the nvm
 * fallback: the resolved path may be a `#!/usr/bin/env node` shim (and may itself
 * shell out to `gh`/`node` by name), so the child needs those bin dirs on PATH
 * even when the parent process never sourced nvm.
 */
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

/**
 * A child environment derived from the current process env with `dirs` prepended to PATH and
 * any case-variant PATH key removed, then `opts.extra` applied. On Windows env names are
 * case-insensitive, so a plain `{ ...process.env, PATH: ... }` yields BOTH the inherited `Path`
 * AND the new `PATH`; which one the spawned child sees is then undefined. Stripping every
 * `toUpperCase() === "PATH"` key before setting the single canonical `PATH` makes the child's
 * PATH deterministic on every platform. This is the ONE way to build a PATH-overriding child
 * env -- callers that also need to drop keys (e.g. provider env stripping) pass `opts.omit`
 * rather than hand-rolling the copy loop.
 */
export function childEnvWithPath(
  dirs: (string | null | undefined)[],
  opts: { extra?: Record<string, string>; omit?: (upperKey: string) => boolean } = {},
): Record<string, string> {
  const { extra, omit } = opts;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (upper === "PATH") continue; // drop every PATH casing; the canonical PATH is set below
    if (omit?.(upper)) continue;
    out[key] = value;
  }
  if (extra) Object.assign(out, extra);
  out.PATH = childPathPrepending(dirs);
  return out;
}

/**
 * Run `file` with `args` and capture stdout, never rejecting: a nonzero exit
 * reports through `exitCode`, and a spawn failure (ENOENT, a killing signal)
 * maps to a nonzero `exitCode` too, so `exitCode === 0` always means "ran and
 * succeeded". That mapping synthesizes exit 1 -- the same code many scans use
 * for a REAL "ran, found nothing" -- so the synthesized case additionally carries
 * `launchFailed: true`: the child never reported an exit code of its own, and a
 * consumer that must not read a failed look as a proven absence keys on the mark
 * (a completed run, zero or nonzero, never carries it).
 */
export function runCaptured(
  file: string,
  args: readonly string[],
  opts: { maxBuffer?: number } = {},
): Promise<{ exitCode: number; stdout: string; launchFailed?: true }> {
  return new Promise((resolve) => {
    // `windowsHide` keeps a no-console Windows parent from flashing a console window.
    // `maxBuffer` defaults to 16 MiB (well past node's 1 MiB); callers that collect
    // large listings raise it -- an overflow kills the child and reads as a marked
    // launch failure, silently degrading unmarked-only scans.
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

/** Quote a single arg for a cmd.exe command line (only when it needs it). */
function quoteCmdArg(arg: string): string {
  if (arg !== "" && !/[\s"&|<>^()]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

/** The cmd.exe hop: Node joins program and args into ONE command line that cmd.exe
 *  re-parses (`/s /c "<line>"`), so the program is quoted like every arg; unquoted,
 *  a path with a space (`C:\Program Files\...`) splits at it and nothing launches. */
export function cmdSpawn(
  file: string,
  args: string[],
): { file: string; args: string[]; shell: true } {
  return { file: quoteCmdArg(file), args: args.map(quoteCmdArg), shell: true };
}

/**
 * Spawn parameters for invoking an agent CLI cross-platform. On Windows, npm-
 * installed CLIs (codex/claude) are `.cmd`/`.ps1` shims that Node cannot spawn
 * directly -- it blocks `.cmd`/`.bat` without a shell -- so run them through the
 * cmd.exe hop. On POSIX, spawn the (resolved) file directly with no shell. ONLY for
 * program-controlled args: cmd.exe expands `%VAR%` even inside double quotes, so an
 * arbitrary string cannot be passed through it verbatim. User-typed args go through
 * verbatimCliSpawn.
 */
export function cliSpawn(
  file: string,
  args: string[],
): { file: string; args: string[]; shell: boolean } {
  if (process.platform !== "win32") return { file, args, shell: false };
  return cmdSpawn(file, args);
}

/** A resolved agent-CLI invocation: what to spawn (`shell` only for the cmd.exe
 *  fallback) and the resolved CLI's own bin dir, for callers that prepend it to the
 *  child PATH (an npm/nvm shim needs node beside it). */
export interface VerbatimCliSpawn {
  file: string;
  args: string[];
  shell: boolean;
  binDir: string | null;
}

/** where.exe resolutions for `pattern`, in search order; empty when absent or
 *  where.exe fails. The pattern is where.exe's own vocabulary: a bare name
 *  (searches the cwd first, then PATH -- the agent-CLI launch keeps that,
 *  matching what a user's own shell would run), or `$ENV:name` to scope the
 *  search to that env var's directories. */
function windowsWhereCandidates(pattern: string): string[] {
  const result = spawnSync("where.exe", [pattern], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return [];
  return (result.stdout ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** The first DIRECT executable (.exe/.com) among Windows PATH candidates (pure,
 *  exported for tests): a shim script cannot stand in for a binary another
 *  process spawns as its runtime. */
export function pickWindowsExecutable(candidates: string[]): string | null {
  return candidates.find((candidate) => {
    const lower = candidate.toLowerCase();
    return lower.endsWith(".exe") || lower.endsWith(".com");
  }) ?? null;
}

/**
 * The ABSOLUTE path of `command`'s first PATH resolution, or null. POSIX answers
 * from findCommand (`command -v` prints the resolution -- absolute unless the
 * matching PATH entry was itself relative, which reads as null here: a
 * cwd-dependent resolution is not a stable binary for another process to spawn).
 * Accepted flatten (the ghAuthToken precedent): a look that never RAN reads as
 * null too, because every caller's miss action is a non-destructive fallback
 * (the provisioned sidecar, or a fresh install) -- null never renders a verdict.
 */
export function resolveExecutablePath(command: string): string | null {
  if (process.platform !== "win32") {
    const path = findCommand(command).path;
    return path !== null && isAbsolute(path) ? path : null;
  }
  // The `$PATH:` pattern scopes where.exe to PATH's directories: a bare `where.exe`
  // searches the CURRENT DIRECTORY first, and a cwd-local binary is the same
  // unstable resolution the POSIX arm rejects.
  return pickWindowsExecutable(windowsWhereCandidates(`$PATH:${command}`));
}

/**
 * Pick the VERBATIM Windows invocation from `candidates` (PATH-ordered): the first
 * actionable resolution wins, dispatched on its extension so user-typed args never
 * pass through cmd.exe's parser (which expands `%VAR%` even inside quotes). An
 * extensionless candidate (npm's sh script) is not spawnable on Windows and is
 * skipped; its `.cmd`/`.ps1` siblings are their own candidates. Pure (the sibling
 * probe is injected) and exported for tests; verbatimCliSpawn feeds it the real
 * where.exe candidates.
 */
export function pickVerbatimWindowsSpawn(
  command: string,
  candidates: string[],
  args: string[],
  siblingExists: (path: string) => boolean,
): VerbatimCliSpawn {
  // `.ps1` (the npm shim) runs through `powershell -File`, which passes argv literally.
  // win32.dirname explicitly: this picker reasons about Windows paths even when
  // its pure tests run on POSIX (where plain dirname would not split backslashes).
  const psFile = (ps1: string): VerbatimCliSpawn => ({
    file: "powershell",
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, ...args],
    shell: false,
    binDir: win32.dirname(ps1),
  });
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    // `.exe`/`.com`: spawn directly (plain argv).
    if (lower.endsWith(".exe") || lower.endsWith(".com")) {
      return { file: candidate, args, shell: false, binDir: win32.dirname(candidate) };
    }
    if (lower.endsWith(".ps1")) return psFile(candidate);
    // `.cmd`/`.bat`: prefer the sibling `.ps1` npm always ships beside its `.cmd`; a
    // batch-ONLY shim falls back to cliSpawn's cmd.exe hop -- its parsing (and `%`
    // expansion) is that shim's own semantics, unavoidable for a bare batch file.
    if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
      const sibling = `${candidate.slice(0, -4)}.ps1`;
      if (siblingExists(sibling)) return psFile(sibling);
      return { ...cmdSpawn(candidate, args), binDir: win32.dirname(candidate) };
    }
  }
  return { ...cmdSpawn(command, args), binDir: null };
}

/**
 * Spawn parameters for an agent CLI whose args are USER-TYPED and must arrive
 * verbatim -- the launch contract ("passed through verbatim"). POSIX resolves the
 * command (PATH + nvm fallback) and spawns it directly; Windows dispatches per
 * pickVerbatimWindowsSpawn, so no cmd.exe hop touches the args unless the CLI is
 * a batch-only shim. The fixed-arg callers keep using cliSpawn.
 */
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
