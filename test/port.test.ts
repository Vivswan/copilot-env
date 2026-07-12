import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import {
  DEFAULT_MAX_PROXY_PORT,
  DEFAULT_MIN_PROXY_PORT,
  maxProxyPort,
  minProxyPort,
  proxyPortInRange,
} from "../src/copilot_api/port.ts";

const SAVED_HOME = process.env.COPILOT_API_HOME;
let dir = "";

afterEach(() => {
  if (SAVED_HOME === undefined) delete process.env.COPILOT_API_HOME;
  else process.env.COPILOT_API_HOME = SAVED_HOME;
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

function tmpHome(): void {
  dir = mkdtempSync(join(tmpdir(), "copilot-port-"));
  process.env.COPILOT_API_HOME = dir;
}

test("the range defaults to [1024, 65535] and excludes privileged/out-of-range ports", () => {
  tmpHome();
  expect(minProxyPort()).toBe(DEFAULT_MIN_PROXY_PORT); // 1024
  expect(maxProxyPort()).toBe(DEFAULT_MAX_PROXY_PORT); // 65535
  expect(proxyPortInRange(443)).toBe(false); // privileged
  expect(proxyPortInRange(1023)).toBe(false);
  expect(proxyPortInRange(1024)).toBe(true);
  expect(proxyPortInRange(4141)).toBe(true);
  expect(proxyPortInRange(65535)).toBe(true);
  expect(proxyPortInRange(65536)).toBe(false);
  expect(proxyPortInRange(4141.5)).toBe(false); // non-integer
});

test("min-port / max-port config narrow the allowed range", () => {
  tmpHome();
  new CopilotEnvConfig().set({ minPort: 4000, maxPort: 5000 });
  expect(minProxyPort()).toBe(4000);
  expect(maxProxyPort()).toBe(5000);
  // 4141 (the built-in default) stays valid; ports outside the narrowed range do not.
  expect(proxyPortInRange(4141)).toBe(true);
  expect(proxyPortInRange(3999)).toBe(false);
  expect(proxyPortInRange(5001)).toBe(false);
  expect(proxyPortInRange(8080)).toBe(false);
});

test("an inverted range (min > max) admits no port", () => {
  tmpHome();
  new CopilotEnvConfig().set({ minPort: 5000, maxPort: 4000 });
  // proxyPortInRange is vacuously false for every port; resolveStartPort surfaces a clear
  // "min-port > max-port" error (exercised in the start flow, not here).
  for (const p of [3999, 4000, 4500, 5000, 5001]) {
    expect(proxyPortInRange(p)).toBe(false);
  }
});
