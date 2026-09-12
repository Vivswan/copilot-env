/** Only `'` is special inside POSIX single quotes: close, escape, reopen. */
export function quotePosix(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** PowerShell single quotes never interpolate; a literal `'` is doubled. */
export function quotePowerShell(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
