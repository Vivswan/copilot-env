// Port selection and discovery helpers for the local copilot-api gateway.
import * as net from "node:net";

import { CopilotApiState } from "./state.ts";

export const COPILOT_API_PORT_DEFAULT: string = process.env.COPILOT_API_PORT_DEFAULT || "4141";

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

export async function copilotApiFindPort(
  start: number = Number(COPILOT_API_PORT_DEFAULT),
): Promise<number> {
  const maxAttempts = 50;
  for (let port = start; port < Math.min(start + maxAttempts, 65536); port++) {
    if (await copilotApiPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`no free port found in range ${start}-${start + maxAttempts}`);
}

export function copilotApiResolvePort(): string {
  // The port is recorded in our state file by `start` and removed by `stop`.
  const statePort = new CopilotApiState().read().port;
  return statePort !== undefined ? String(statePort) : COPILOT_API_PORT_DEFAULT;
}

/** The OpenAI-wire gateway base URL for `port` (single source for the emitted string). */
export function openaiBaseUrl(port: string): string {
  return `http://localhost:${port}/v1`;
}
