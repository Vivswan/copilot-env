// Shell single-quoting helpers shared by the env exporter, shell-integration
// block writers, and setup PATH wiring -- so the two escaping rules live in one
// place. Both wrap the value in single quotes (a literal string in each shell).

/** POSIX single-quote: only `'` is special inside single quotes -> close/escape/reopen. */
export function quotePosix(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** PowerShell single-quote: literal (no interpolation); escape `'` by doubling it. */
export function quotePowerShell(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
