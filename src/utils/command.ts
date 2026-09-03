// PATH command resolution with an nvm fallback, shared by setup, health probes,
// and the direct probe. NOT the `which` npm package: this also sources nvm.sh so a
// freshly nvm-installed binary (codex/claude/gh/node) resolves in the SAME process
// that installed it, and uses Get-Command on Windows. Kept in its own module (not
// commands/setup.ts) so lower-level utilities can resolve binaries without
// importing the heavier setup module -- which would form an import cycle
// (setup -> codex/claude config -> agents/live_probe -> setup).
import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, win32 } from "node:path";

// `command -v` first, then a best-effort nvm fallback so a freshly nvm-installed
// Node/CLI resolves in the same process that installed it (PATH not yet reloaded).
const POSIX_NVM_SH = '"$' + '{NVM_DIR:-$HOME/.nvm}/nvm.sh"';

/** True when `command` is runnable (PATH, or via the nvm fallback on POSIX). */
export function commandExists(command: string): boolean {
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
    return result.status === 0;
  }

  const result = spawnSync(
    "sh",
    [
      "-c",
      `command -v "$1" >/dev/null 2>&1 || { [ -s ${POSIX_NVM_SH} ] && . ${POSIX_NVM_SH} >/dev/null 2>&1 && command -v "$1" >/dev/null 2>&1; }`,
      "sh",
      command,
    ],
    { stdio: "ignore" },
  );
  return result.status === 0;
}

/** Resolve `command` to its path (PATH, or via the nvm fallback on POSIX); null if absent. */
export function resolveCommand(command: string): string | null {
  if (process.platform === "win32") return commandExists(command) ? command : null;
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
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
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
 * (a completed run, zero or nonzero, never carries it). `windowsHide` keeps a
 * no-console Windows parent from flashing a console window. `maxBuffer` defaults
 * to 16 MiB (well past node's 1 MiB); callers that collect large listings raise
 * it -- an overflow kills the child and reads as a marked launch failure,
 * silently degrading unmarked-only scans.
 */
export function runCaptured(
  file: string,
  args: readonly string[],
  opts: { maxBuffer?: number } = {},
): Promise<{ exitCode: number; stdout: string; launchFailed?: true }> {
  return new Promise((resolve) => {
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

/**
 * Spawn parameters for invoking an agent CLI cross-platform. On Windows, npm-
 * installed CLIs (codex/claude) are `.cmd`/`.ps1` shims that Node cannot spawn
 * directly -- it blocks `.cmd`/`.bat` without a shell -- so run them through cmd.exe
 * (`shell: true`) with args quoted so whitespace survives the shell join. On POSIX,
 * spawn the (resolved) file directly with no shell. Pass the result to
 * spawn/spawnSync: `const s = cliSpawn(file, args); spawnSync(s.file, s.args, { shell: s.shell, ... })`.
 *
 * ONLY for program-controlled args: cmd.exe expands `%VAR%` even inside double
 * quotes, so an arbitrary string cannot be passed through it verbatim. User-typed
 * args go through verbatimCliSpawn below instead.
 */
export function cliSpawn(
  file: string,
  args: string[],
): { file: string; args: string[]; shell: boolean } {
  if (process.platform !== "win32") return { file, args, shell: false };
  return { file, args: args.map(quoteCmdArg), shell: true };
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

/** Windows PATH resolutions of `command` in search order (where.exe walks PATH with
 *  PATHEXT, plus exact-name matches). Empty when absent or where.exe fails. */
function windowsCliCandidates(command: string): string[] {
  const result = spawnSync("where.exe", [command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return [];
  return (result.stdout ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/**
 * Pick the VERBATIM Windows invocation from `candidates` (PATH-ordered): the first
 * actionable resolution wins, dispatched on its extension so user-typed args never
 * pass through cmd.exe's parser (which expands `%VAR%` even inside quotes):
 *   - `.exe`/`.com`: spawn directly (plain argv).
 *   - `.ps1` (the npm shim): `powershell -File`, which passes argv literally.
 *   - `.cmd`/`.bat`: prefer the sibling `.ps1` npm always ships beside its `.cmd`;
 *     a batch-ONLY shim falls back to cliSpawn -- cmd.exe parsing (and its `%`
 *     expansion) is that shim's own semantics, unavoidable for a bare batch file.
 *   - extensionless (npm's sh script): not spawnable on Windows; skipped, its
 *     `.cmd`/`.ps1` siblings are their own candidates.
 * Pure (the sibling probe is injected) and exported for tests; verbatimCliSpawn
 * feeds it the real where.exe candidates.
 */
export function pickVerbatimWindowsSpawn(
  command: string,
  candidates: string[],
  args: string[],
  siblingExists: (path: string) => boolean,
): VerbatimCliSpawn {
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
    if (lower.endsWith(".exe") || lower.endsWith(".com")) {
      return { file: candidate, args, shell: false, binDir: win32.dirname(candidate) };
    }
    if (lower.endsWith(".ps1")) return psFile(candidate);
    if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
      const sibling = `${candidate.slice(0, -4)}.ps1`;
      if (siblingExists(sibling)) return psFile(sibling);
      return {
        file: candidate,
        args: args.map(quoteCmdArg),
        shell: true,
        binDir: win32.dirname(candidate),
      };
    }
  }
  return { file: command, args: args.map(quoteCmdArg), shell: true, binDir: null };
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
  return pickVerbatimWindowsSpawn(command, windowsCliCandidates(command), args, existsSync);
}
