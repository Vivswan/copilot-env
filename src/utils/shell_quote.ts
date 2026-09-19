/** Only `'` is special inside POSIX single quotes: close, escape, reopen. */
export function quotePosix(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** PowerShell single quotes never interpolate; a literal `'` is doubled. */
export function quotePowerShell(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** A directive `agent profile env` prints for one variable: set it, clear it, or (null) leave what
 *  the shell has. Read by both agents' managed-value readers and rendered by the env command. */
export type ManagedEnvValue = { value: string } | { unset: true } | null;
