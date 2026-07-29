// Shared consola configuration for copilot-env. Two things every logger here
// wants: no right-aligned wall-clock timestamp (noise for short-lived CLI output,
// and it wraps awkwardly), and -- for the per-module loggers -- stderr only, so the
// machine-readable `agent env` stdout is never polluted.
import { type ConsolaInstance, consola, createConsola } from "consola";

const NO_DATE = { date: false } as const;

/** Strip the timestamp from the shared global `consola`. Call once per entry point. */
export function disableConsolaTimestamps(): void {
  consola.options.formatOptions = { ...consola.options.formatOptions, ...NO_DATE };
}

/**
 * Route the shared global `consola` to stderr. The MCP stdio server owns stdout as a
 * JSON-RPC stream, and library code it calls logs through the global consola (e.g.
 * the integration-identity narration) -- one stray info line would corrupt the
 * protocol, so the server redirects everything before its first request.
 */
export function redirectConsolaToStderr(): void {
  consola.options.stdout = process.stderr;
}

/** A consola that writes to stderr (keeping stdout machine-readable), no timestamp. */
export function createStderrLogger(): ConsolaInstance {
  return createConsola({
    stdout: process.stderr,
    stderr: process.stderr,
    formatOptions: NO_DATE,
  });
}
