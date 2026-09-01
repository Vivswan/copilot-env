// Credential-helper BODY builders shared by the Claude Code wiring (src/claude/config.ts,
// legacy helper-file tolerance) and the Claude Desktop wiring (src/claude/desktop.ts,
// which writes real helper files -- Desktop's inferenceCredentialHelper is a file path,
// not an inline command). Lives apart from config.ts so desktop.ts can import the
// builders without a config-module cycle.

/** Single-quote a string for safe embedding in a /bin/sh command line. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Quote an argument for a Windows `.cmd` line: bare for plain flags/words, else double-quoted
 *  (paths carry `:` and `\`). cmd.exe runs a quoted path fine; our args never contain a `"`. */
export function winQuote(s: string): string {
  return /^[-A-Za-z0-9_.]+$/.test(s) ? s : `"${s}"`;
}

/** A Windows `.cmd` helper body: run `command args...` so its stdout is the credential. `@echo
 *  off` keeps the command itself off stdout; CRLF endings so cmd.exe parses it reliably. Literal
 *  `%` is doubled to `%%` -- in a batch file `%` triggers variable expansion even inside quotes,
 *  so a checkout path containing `%` would otherwise be mangled. (`!` needs no escaping: we never
 *  `setlocal enabledelayedexpansion`, so delayed expansion is off.) */
export function cmdHelperBody(command: string, args: readonly string[]): string {
  const line = [command, ...args].map(winQuote).join(" ").replace(/%/g, "%%");
  return `@echo off\r\n${line}\r\n`;
}

/** A POSIX helper body: exec `command args...` so its stdout is the credential and no
 *  intermediate shell lingers. Every token single-quoted -- paths carry spaces. */
export function posixExecBody(command: string, args: readonly string[]): string {
  const line = [command, ...args].map(shQuote).join(" ");
  return `#!/bin/sh\nexec ${line}\n`;
}
