import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { CopilotEnvRunState } from "../src/copilot_api/state.ts";

// CopilotEnvState reads/writes the SHARED store under COPILOT_API_HOME, so isolate
// each test in a temp home (not the per-host .run state).
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
  dir = mkdtempSync(join(tmpdir(), "copilot-envstate-"));
  process.env.COPILOT_API_HOME = dir;
}

test("the provisioned GitHub token round-trips through the shared store and clears", () => {
  tmpHome();
  const state = new CopilotEnvState();
  expect(state.read().githubToken).toBeNull();

  // Written by `agent auth`, read by every config write + `agent start`.
  state.set({ githubToken: "ghu_provisioned" });
  expect(state.read().githubToken).toBe("ghu_provisioned");

  // `agent auth --del` clears it (revert to the gh CLI / proxy device login).
  state.set({ githubToken: null });
  expect(state.read().githubToken).toBeNull();
});

test("set() trims; a blank/whitespace value reads back as null", () => {
  tmpHome();
  const state = new CopilotEnvState();
  state.set({ githubToken: "  ghu_trimmed  " });
  expect(state.read().githubToken).toBe("ghu_trimmed");

  state.set({ githubToken: "   " });
  expect(state.read().githubToken).toBeNull();
});

test("the auth provider round-trips and clears alongside the token", () => {
  tmpHome();
  const state = new CopilotEnvState();
  expect(state.read().authProvider).toBeNull();

  state.set({ githubToken: "ghu_x", authProvider: "gh-token" });
  expect(state.read().authProvider).toBe("gh-token");

  // `--del` clears both keys at once.
  state.set({ githubToken: null, authProvider: null });
  expect(state.read()).toEqual({
    githubToken: null,
    authProvider: null,
    codexCatalogLastAttemptMs: 0,
    codexCatalogCodexVersion: null,
  });
});

test("the state lives in the shared home, independent of per-host .run state", () => {
  tmpHome();
  new CopilotEnvState().set({ githubToken: "ghu_shared" });
  // Stored beside config.json at the home root, not under .run/<host>/.
  expect(new CopilotEnvState().read().githubToken).toBe("ghu_shared");
});

test("run-state clearIfPid clears the daemon tracking ONLY when the tracked pid matches", () => {
  tmpHome();
  const run = new CopilotEnvRunState();
  run.set({ pid: 4242, port: 5151, lastEnsureAt: 123 });

  // A different pid (a newer daemon replaced us) -> leave everything intact, so an old
  // idle watchdog can't clobber the successor's freshly written pid/port.
  run.clearIfPid(9999);
  expect(run.read().pid).toBe(4242);
  expect(run.read().port).toBe(5151);
  expect(run.read().lastEnsureAt).toBe(123);

  // The matching pid -> clears pid/port/lastEnsureAt together.
  run.clearIfPid(4242);
  const after = run.read();
  expect(after.pid).toBeUndefined();
  expect(after.port).toBeUndefined();
  expect(after.lastEnsureAt).toBeUndefined();
});
