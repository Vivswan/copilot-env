// Shared by the Claude Code wiring (config.ts, whose inline command reuses the quoting) and the
// Desktop wiring (desktop.ts writes real helper files: Desktop's inferenceCredentialHelper is a
// file path, not a command). Apart from config.ts so desktop.ts imports it without a module cycle.

export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** cmd.exe runs a quoted path fine, and our args never contain a `"`. */
export function winQuote(s: string): string {
  return /^[-A-Za-z0-9_.]+$/.test(s) ? s : `"${s}"`;
}

/** A batch file expands `%` even inside quotes, so a checkout path carrying one would be mangled.
 *    @echo off  -> keeps the command line itself off stdout (stdout IS the credential)
 *    CRLF       -> cmd.exe parses it reliably
 *    `!`        -> untouched: delayed expansion is never enabled */
export function cmdHelperBody(command: string, args: readonly string[]): string {
  const line = [command, ...args].map(winQuote).join(" ").replace(/%/g, "%%");
  return `@echo off\r\n${line}\r\n`;
}

/** exec, so no intermediate shell lingers; every token quoted, since paths carry spaces. */
export function posixExecBody(command: string, args: readonly string[]): string {
  const line = [command, ...args].map(shQuote).join(" ");
  return `#!/bin/sh\nexec ${line}\n`;
}
