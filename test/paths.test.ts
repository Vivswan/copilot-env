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

test("DEFAULT_HOME mirrors the proxy's default data dir", () => {
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

test("account-wide files resolve to the home root, not under .run/<host>/", () => {
  const home = join("/tmp", "copilot-env-paths-root-test");
  process.env.COPILOT_API_HOME = home;

  const paths = new CopilotApiPaths();
  const runDir = join(home, ".run", getSanitizedHostname());

  // Load-bearing invariant: the credential store, the preferences store, and
  // the proxy's own device-login token all live at the HOME ROOT (account/
  // machine-wide), never inside the per-host runDir. A regression moving any of
  // them into .run/<host>/ must fail here.
  expect(paths.sharedStateFile).toBe(join(home, ".copilot-env-state.json"));
  expect(paths.envConfigFile).toBe(join(home, ".copilot-env-config.json"));
  expect(paths.githubTokenFile).toBe(join(home, "github_token"));

  for (const rootFile of [paths.sharedStateFile, paths.envConfigFile, paths.githubTokenFile]) {
    expect(rootFile.startsWith(runDir)).toBe(false);
    expect(rootFile.startsWith(home)).toBe(true);
  }
});

test("resolveHome falls back to DEFAULT_HOME when COPILOT_API_HOME is unset", () => {
  delete process.env.COPILOT_API_HOME;

  const paths = new CopilotApiPaths();

  expect(paths.home).toBe(DEFAULT_HOME);
});

test("resolveHome falls back to DEFAULT_HOME when COPILOT_API_HOME is empty", () => {
  process.env.COPILOT_API_HOME = "";

  const paths = new CopilotApiPaths();

  expect(paths.home).toBe(DEFAULT_HOME);
});
