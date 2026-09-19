// Shared by the Claude Code wiring (config.ts, whose inline command reuses winQuote) and the
// Desktop wiring (the helper-script writer produces real files: Desktop's inferenceCredentialHelper
// is a file path, not a command). Apart from config.ts so the Desktop side imports it without a
// module cycle.
import { quotePosix } from "../utils/shell_quote.ts";

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
  const line = [command, ...args].map(quotePosix).join(" ");
  return `#!/bin/sh\nexec ${line}\n`;
}
