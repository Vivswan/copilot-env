// Port selection and discovery helpers for the local copilot-api proxy.
import * as net from "node:net";

import { CopilotEnvConfig } from "./env_config.ts";
import { CopilotEnvRunState } from "./state.ts";

/** The built-in proxy port when nothing (config `port`, a running daemon, or `--port`) overrides it. */
export const BUILTIN_PROXY_PORT = 4141;

/** The default proxy port: the configured `port` (`agent config --set port`), else the built-in. */
export function defaultProxyPort(): number {
  return new CopilotEnvConfig().read().port ?? BUILTIN_PROXY_PORT;
}

export async function copilotApiPortAvailable(port: number): Promise<boolean> {
  if (port < 1024 || port > 65535) {
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
  for (let port = start; port < Math.min(start + maxAttempts, 65536); port++) {
    if (await copilotApiPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(
    `no free port found in range ${start}-${start + maxAttempts}; free a port or run \`agent config --set port <n>\` to start the search elsewhere`,
  );
}

export function copilotApiResolvePort(): string {
  // The port is recorded in our state file by `start` and removed by `stop`; otherwise the
  // configured/built-in default (so config wiring matches what a fresh `start` would bind).
  const statePort = new CopilotEnvRunState().read().port;
  return statePort !== undefined ? String(statePort) : String(defaultProxyPort());
}

/** The OpenAI-wire proxy base URL for `port` (single source for the emitted string). */
export function openaiBaseUrl(port: string): string {
  return `http://localhost:${port}/v1`;
}
