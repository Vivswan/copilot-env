import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../src/commands/init.ts";
import { runStart } from "../src/commands/start.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { CopilotEnvRunState } from "../src/copilot_api/state.ts";

// The lifecycle primitives the proxy-token resolver orchestrates: `start --record-event`
// (heartbeat), `start --check` (is-it-up probe), `init --get-auto-start` (the gate). Each
// is isolated in a temp COPILOT_API_HOME and resets the shared process.exitCode.
const SAVED_HOME = process.env.COPILOT_API_HOME;
let dir = "";

afterEach(() => {
  if (SAVED_HOME === undefined) delete process.env.COPILOT_API_HOME;
  else process.env.COPILOT_API_HOME = SAVED_HOME;
  process.exitCode = undefined;
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

function tmpHome(): void {
  dir = mkdtempSync(join(tmpdir(), "copilot-lifecycle-"));
  process.env.COPILOT_API_HOME = dir;
}

test("start --record-event writes the lastEnsureAt heartbeat and never launches", async () => {
  tmpHome();
  expect(new CopilotEnvRunState().read().lastEnsureAt).toBeUndefined();

  await runStart({ recordEvent: true });

  expect(typeof new CopilotEnvRunState().read().lastEnsureAt).toBe("number");
  expect(new CopilotEnvRunState().read().pid).toBeUndefined(); // no daemon was started
});

test("start --check exits non-zero when no proxy is tracked/running", async () => {
  tmpHome();
  await runStart({ check: true });
  expect(process.exitCode).toBe(1);
});

test("init --get-auto-start exits non-zero when the flag is off (default)", async () => {
  tmpHome();
  await runInit({ getAutoStart: true });
  expect(process.exitCode).toBe(1);
});

test("init --get-auto-start exits zero when the flag is on, without configuring agents", async () => {
  tmpHome();
  new CopilotEnvState().set({ autoStart: true });
  await runInit({ getAutoStart: true });
  expect(process.exitCode).toBe(0);
  // It short-circuited: no agent config dirs were created under the temp home.
  expect(new CopilotEnvRunState().read().pid).toBeUndefined();
});
