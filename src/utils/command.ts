// PATH command resolution with an nvm fallback, shared by setup, health probes,
// and the direct probe. NOT the `which` npm package: this also sources nvm.sh so a
// freshly nvm-installed binary (codex/claude/gh/node) resolves in the SAME process
// that installed it, and uses Get-Command on Windows. Kept in its own module (not
// commands/setup.ts) so lower-level utilities can resolve binaries without
// importing the heavier setup module -- which would form an import cycle
// (setup -> codex/claude config -> direct_probe -> setup).
import { spawnSync } from "node:child_process";

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
 */
export function cliSpawn(
  file: string,
  args: string[],
): { file: string; args: string[]; shell: boolean } {
  if (process.platform !== "win32") return { file, args, shell: false };
  return { file, args: args.map(quoteCmdArg), shell: true };
}
