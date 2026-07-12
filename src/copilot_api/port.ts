// Port selection and discovery helpers for the local copilot-api proxy.
import * as net from "node:net";

import { CopilotEnvConfig } from "./env_config.ts";
import { CopilotEnvRunState } from "./state.ts";

/** The built-in proxy port when nothing (config `port`, a running daemon, or `--port`) overrides it. */
export const BUILTIN_PROXY_PORT = 4141;

/** Built-in bounds of the allowed proxy port range, used when the `min-port`/`max-port` config
 *  keys are unset. Privileged ports (<1024) are excluded by default. */
export const DEFAULT_MIN_PROXY_PORT = 1024;
export const DEFAULT_MAX_PROXY_PORT = 65535;

/** The configured lower bound of the allowed proxy port range (`agent config --set min-port`),
 *  else the built-in default. */
export function minProxyPort(): number {
  return new CopilotEnvConfig().read().minPort ?? DEFAULT_MIN_PROXY_PORT;
}

/** The configured upper bound of the allowed proxy port range (`agent config --set max-port`),
 *  else the built-in default. */
export function maxProxyPort(): number {
  return new CopilotEnvConfig().read().maxPort ?? DEFAULT_MAX_PROXY_PORT;
}

/** Whether `port` is within the allowed proxy range [min-port, max-port] (config-driven). */
export function proxyPortInRange(port: number): boolean {
  return Number.isInteger(port) && port >= minProxyPort() && port <= maxProxyPort();
}

/** The default proxy port: the configured `port` (`agent config --set port`), else the built-in. */
export function defaultProxyPort(): number {
  return new CopilotEnvConfig().read().port ?? BUILTIN_PROXY_PORT;
}

export async function copilotApiPortAvailable(port: number): Promise<boolean> {
  // An out-of-range port is never "available" to us: the proxy runs unprivileged (so binding
  // <1024 fails anyway) and the range is a deliberate policy. Callers that surface a busy
  // message should check proxyPortInRange first to distinguish "outside the allowed range" from
  // "held by another process" -- the two are different user problems.
  if (!proxyPortInRange(port)) {
    return false;
  }
  return new Promise<boolean>((resolve) => {
    const s = new net.Socket();
    let settled = false;
    const done = (available: boolean): void => {
      if (settled) return;
      settled = true;
      s.destroy();
      resolve(available);
    };
    s.once("connect", () => done(false));
    s.once("error", () => done(true));
    s.connect(port, "127.0.0.1");
  });
}

export async function copilotApiFindPort(start: number = defaultProxyPort()): Promise<number> {
  const maxAttempts = 50;
  // Search only within the configured range: clamp the base into [min, max] and never scan past
  // the ceiling, so the automatic search can't wander outside the allowed range.
  const min = minProxyPort();
  const max = maxProxyPort();
  const from = Math.min(Math.max(start, min), max);
  const to = Math.min(from + maxAttempts, max + 1);
  for (let port = from; port < to; port++) {
    if (await copilotApiPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(
    `no free port found in range ${from}-${to - 1}; free a port or run \`agent config --set port <n>\` to start the search elsewhere`,
  );
}

export function copilotApiResolvePort(): string {
  // The port is recorded in our state file by `start` and removed by `stop`; otherwise the
  // configured/built-in default (so config wiring matches what a fresh `start` would bind).
  const statePort = new CopilotEnvRunState().read().port;
  return statePort !== undefined ? String(statePort) : String(defaultProxyPort());
}

/** The OpenAI-wire proxy base URL for `port` (single source for the emitted string). Uses the
 *  127.0.0.1 literal, not `localhost`: the daemon binds IPv4, and on Windows `localhost` resolves
 *  to ::1 first with no IPv4 fallback -- so a `localhost` base_url would make the agent CLI
 *  ECONNREFUSED against the proxy. Matches the 127.0.0.1 the liveness probes already use. */
export function openaiBaseUrl(port: string): string {
  return `http://127.0.0.1:${port}/v1`;
}
