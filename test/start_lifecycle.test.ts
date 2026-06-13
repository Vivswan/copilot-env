import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStart } from "../src/commands/start.ts";
import { CopilotEnvRunState } from "../src/copilot_api/state.ts";

// The lifecycle primitives the proxy-token resolver orchestrates: `start --record-event`
// (heartbeat) and `start --check` (is-it-up probe). Each is isolated in a temp
// COPILOT_API_HOME and resets the shared process.exitCode.
const SAVED_HOME = process.env.COPILOT_API_HOME;
let dir = "";

afterEach(() => {
  if (SAVED_HOME === undefined) delete process.env.COPILOT_API_HOME;
  else process.env.COPILOT_API_HOME = SAVED_HOME;
  // Reset to 0 (NOT undefined -- bun's process.exitCode setter ignores undefined and keeps
  // the last value, which would leak a test's exit 1 to the whole `bun test` run).
  process.exitCode = 0;
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
