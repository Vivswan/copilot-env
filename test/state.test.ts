import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CopilotApiState } from "../src/copilot_api/state.ts";

let dir = "";

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

function tmpState(): CopilotApiState {
  dir = mkdtempSync(join(tmpdir(), "copilot-state-"));
  return new CopilotApiState(join(dir, ".state.json"));
}

test("githubToken round-trips, merges alongside pid/port, and clears on null", () => {
  const state = tmpState();

  // Stored by `--gh-token` and read back by `start`.
  state.set({ githubToken: "ghu_provisioned" });
  expect(state.read().githubToken).toBe("ghu_provisioned");

  // A pid/port write (what start does) must NOT drop the token — set() merges.
  state.set({ pid: 1234, port: 4141 });
  const after = state.read();
  expect(after.githubToken).toBe("ghu_provisioned");
  expect(after.pid).toBe(1234);
  expect(after.port).toBe(4141);

  // `--remove-gh-token` clears just the token, leaving pid/port intact.
  state.set({ githubToken: null });
  const cleared = state.read();
  expect(cleared.githubToken).toBeUndefined();
  expect(cleared.pid).toBe(1234);
  expect(cleared.port).toBe(4141);
});

test("an empty-string or non-string githubToken reads back as undefined", () => {
  const state = tmpState();
  state.set({ githubToken: "" });
  expect(state.read().githubToken).toBeUndefined();
});
