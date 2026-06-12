import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { CopilotApiPaths } from "../src/copilot_api/paths.ts";
import { migration } from "../src/migrations/3.3.3.ts";

// The 3.3.3 migration has filesystem side effects (state store + copilot-api's
// github_token file), so it is isolated here under a temp copilot-api home —
// separate from migrations.test.ts, which covers the pure selection logic.
const SAVED = { HOME: process.env.HOME, COPILOT_API_HOME: process.env.COPILOT_API_HOME };
let dir = "";

afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

function isolate(): void {
  dir = mkdtempSync(join(tmpdir(), "copilot-mig-"));
  process.env.HOME = dir;
  process.env.COPILOT_API_HOME = join(dir, "proxy-home");
}

function state(): CopilotEnvState {
  return new CopilotEnvState();
}

test("3.3.3 (a): backfills gh-token for a stored token with no recorded provider", () => {
  isolate();
  state().set({ githubToken: "ghu_legacy" }); // unreleased --gh-token shape: token, no provider
  void migration.run();
  expect(state().read()).toEqual({ githubToken: "ghu_legacy", authProvider: "gh-token" });
});

test("3.3.3 (b): imports copilot-api's token as copilot and scrubs its file", () => {
  isolate();
  const tokenFile = new CopilotApiPaths().githubTokenFile;
  mkdirSync(dirname(tokenFile), { recursive: true });
  writeFileSync(tokenFile, "ghu_from_copilot_api\n");
  void migration.run();
  expect(state().read()).toEqual({ githubToken: "ghu_from_copilot_api", authProvider: "copilot" });
  expect(existsSync(tokenFile)).toBe(false); // scrubbed
});

test("3.3.3 is idempotent: a chosen gh-cli provider (no token) is never overwritten", () => {
  isolate();
  state().set({ githubToken: null, authProvider: "gh-cli" });
  const tokenFile = new CopilotApiPaths().githubTokenFile;
  mkdirSync(dirname(tokenFile), { recursive: true });
  writeFileSync(tokenFile, "ghu_should_not_import\n");
  void migration.run();
  // gh-cli holds no token of its own and must not be clobbered by the import.
  expect(state().read()).toEqual({ githubToken: null, authProvider: "gh-cli" });
});
