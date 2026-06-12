import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearGithubToken,
  readStoredGithubToken,
  storeGithubToken,
} from "../src/copilot_api/gh_token.ts";

// gh_token reads/writes the SHARED store under COPILOT_API_HOME, so isolate each
// test in a temp home (not the per-host .run state).
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
  dir = mkdtempSync(join(tmpdir(), "copilot-ghtoken-"));
  process.env.COPILOT_API_HOME = dir;
}

test("the provisioned GitHub token round-trips through the shared store and clears", () => {
  tmpHome();
  expect(readStoredGithubToken()).toBeNull();

  // Written by `agent init --gh-token`, read by every config write + `agent start`.
  storeGithubToken("ghu_provisioned");
  expect(readStoredGithubToken()).toBe("ghu_provisioned");

  // `--remove-gh-token` clears it (revert to the gh CLI / proxy device login).
  clearGithubToken();
  expect(readStoredGithubToken()).toBeNull();
});

test("storeGithubToken trims; a blank/whitespace value reads back as null", () => {
  tmpHome();
  storeGithubToken("  ghu_trimmed  ");
  expect(readStoredGithubToken()).toBe("ghu_trimmed");

  storeGithubToken("   ");
  expect(readStoredGithubToken()).toBeNull();
});

test("the token lives in the shared home, independent of per-host .run state", () => {
  tmpHome();
  storeGithubToken("ghu_shared");
  // Stored beside config.json at the home root, not under .run/<host>/.
  expect(readStoredGithubToken()).toBe("ghu_shared");
});
