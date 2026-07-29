import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    profiles: {},
    codexCatalogLastAttemptMs: 0,
    codexCatalogCodexVersion: null,
    webSearchDenyOwnedPaths: [],
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

test("a named profile's integrationIdentity is a credential-derived cache: setCredential clears it", () => {
  tmpHome();
  const state = new CopilotEnvState();
  state.setProfileMode("work", "direct");
  state.setCredential("work", { githubToken: "github_pat_x", authProvider: "gh-token" });
  state.setProfileIntegrationIdentity("work", "copilot-developer-cli");
  expect(state.readProfileSlot("work").integrationIdentity).toBe("copilot-developer-cli");

  // Re-auth (any credential write) invalidates the derived identity, so a stale id can
  // never outlive the credential it was probed for -- the next wiring re-derives it.
  state.setCredential("work", { githubToken: "github_pat_y", authProvider: "gh-token" });
  expect(state.readProfileSlot("work").integrationIdentity).toBeNull();
  expect(state.readProfileSlot("work").mode).toBe("direct"); // mode is untouched

  // Clearing the credential (deletion path) with the mode also cleared empties the slot.
  state.setProfileMode("work", null);
  state.setCredential("work", { githubToken: null, authProvider: null });
  expect(state.profileNames()).toEqual([]);
});

test("webSearchDenyOwnedPaths drops junk entries individually and trims survivors", () => {
  tmpHome();
  // Hand-edited state: junk siblings must not nuke the real entry, and a padded
  // path must read back trimmed so exact-path ownership checks still match.
  writeFileSync(
    join(dir, ".copilot-env-state.json"),
    `${JSON.stringify({ webSearchDenyOwnedPaths: ["/a/settings.json", 123, "", null, "  /b/settings.json  "] })}\n`,
  );
  expect(new CopilotEnvState().read().webSearchDenyOwnedPaths).toEqual([
    "/a/settings.json",
    "/b/settings.json",
  ]);
});
