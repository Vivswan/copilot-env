// No wall-clock timestamp (noise on short-lived CLI output that wraps awkwardly), and stderr for
// the per-module loggers so the eval'd `agent env` stdout is never polluted.
import { consola, type ConsolaInstance, createConsola } from "consola";

const NO_DATE = { date: false } as const;

/** Call once per entry point. */
export function disableConsolaTimestamps(): void {
  consola.options.formatOptions = { ...consola.options.formatOptions, ...NO_DATE };
}

/** The MCP stdio server owns stdout as JSON-RPC and library code it calls logs through the global
 *  consola; one stray info line would corrupt the protocol. */
export function redirectConsolaToStderr(): void {
  consola.options.stdout = process.stderr;
}

/** For a scope whose narration must stay off the command's stdout, such as the self-update
 *  preflight inside `agent start`. */
export async function withConsolaOnStderr<T>(fn: () => Promise<T>): Promise<T> {
  const previous = consola.options.stdout;
  consola.options.stdout = process.stderr;
  try {
    return await fn();
  } finally {
    consola.options.stdout = previous;
  }
}

export function createStderrLogger(): ConsolaInstance {
  return createConsola({
    stdout: process.stderr,
    stderr: process.stderr,
    formatOptions: NO_DATE,
  });
}
