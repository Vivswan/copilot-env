import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../src/commands/init.ts";
import { readStoredGithubToken } from "../src/copilot_api/gh_token.ts";

// These exercise runInit's early flag validation, which throws BEFORE any config
// I/O, so they need no filesystem/network isolation (except the last, which
// asserts no token was persisted).

test("init: --direct and --proxy are mutually exclusive", () => {
  expect(() => runInit({ direct: true, proxy: true })).toThrow(
    "--direct and --proxy are mutually exclusive",
  );
});

test("init --remove-gh-token cannot combine with --gh-token or --proxy", () => {
  expect(() => runInit({ "remove-gh-token": true, "gh-token": "x" })).toThrow("mutually exclusive");
  expect(() => runInit({ "remove-gh-token": true, proxy: true })).toThrow("cannot be combined");
});

test("init validates before mutating state: --gh-token + --proxy never stores the token", () => {
  const home = mkdtempSync(join(tmpdir(), "copilot-init-"));
  const saved = process.env.COPILOT_API_HOME;
  process.env.COPILOT_API_HOME = home;
  try {
    // --gh-token implies Direct, so combining with --proxy is rejected — and the
    // rejection must fire before the token is persisted to the shared store.
    expect(() => runInit({ "gh-token": "ghu_should_not_persist", proxy: true })).toThrow(
      "cannot be combined with --proxy",
    );
    expect(readStoredGithubToken()).toBeNull();
  } finally {
    if (saved === undefined) delete process.env.COPILOT_API_HOME;
    else process.env.COPILOT_API_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  }
});
