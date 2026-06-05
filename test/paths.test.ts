import { afterEach, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { CopilotApiPaths, DEFAULT_HOME } from "../src/copilot_api/paths.ts";
import { getSanitizedHostname } from "../src/utils/hostname.ts";

const SAVED_HOME = process.env.COPILOT_API_HOME;

afterEach(() => {
  if (SAVED_HOME === undefined) {
    delete process.env.COPILOT_API_HOME;
  } else {
    process.env.COPILOT_API_HOME = SAVED_HOME;
  }
});

test("DEFAULT_HOME mirrors the gateway's default data dir", () => {
  expect(DEFAULT_HOME).toBe(join(homedir(), ".local", "share", "copilot-api"));
});

test("CopilotApiPaths composes per-host run files under COPILOT_API_HOME", () => {
  const home = join("/tmp", "copilot-env-paths-test");
  process.env.COPILOT_API_HOME = home;

  const paths = new CopilotApiPaths();
  const runDir = join(home, ".run", getSanitizedHostname());

  expect(paths.home).toBe(home);
  expect(paths.configFile).toBe(join(home, "config.json"));
  expect(paths.runDir).toBe(runDir);
  expect(paths.stateFile).toBe(join(runDir, ".state.json"));
  expect(paths.logFile).toBe(join(runDir, ".log"));
  expect(paths.sqliteDb).toBe(join(runDir, "copilot-api.sqlite"));
});
