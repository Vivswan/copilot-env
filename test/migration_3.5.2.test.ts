import { afterEach, expect, test } from "bun:test";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { configureClaudeConfig, WEBSEARCH_DENY_RULE } from "../src/claude/config.ts";
import { claudeJsonPath } from "../src/claude/mcp_registration.ts";
import { Credential } from "../src/copilot_api/credential.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { migration } from "../src/migrations/3.5.2.ts";
import { envSnapshot, isolateAgentHomes, removeDir } from "./helpers.ts";

// The 3.5.2 migration wires the web-search pair (MCP registration + WebSearch deny)
// into existing DIRECT Claude installs, which only rewire on init/claude/profile and
// would otherwise never gain it from a plain `agent update`.
const restoreEnv = envSnapshot();
let dir = "";

afterEach(() => {
  restoreEnv();
  dir = removeDir(dir);
});

/** A temp HOME with Claude wired the pre-3.5.3 way: `mode`, no pair artifacts. */
function isolate(mode: "direct" | "proxy"): string {
  const homes = isolateAgentHomes("copilot-mig352-", { mkdirs: true });
  dir = homes.dir;
  const claudeHome = homes.claudeHome;
  new Credential().store("gh-token", "gho_x");
  configureClaudeConfig(claudeHome, mode, { quiet: true });
  // A CURRENT write applies the pair itself; strip it to simulate a pre-3.5.3 install.
  const settingsPath = join(claudeHome, "settings.json");
  const doc = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  delete doc.permissions;
  writeFileSync(settingsPath, `${JSON.stringify(doc, null, 2)}\n`);
  rmSync(claudeJsonPath(), { force: true });
  new CopilotEnvState().set({ webSearchDenyOwnedPaths: null });
  return claudeHome;
}

function settings(claudeHome: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8"));
}

test("a direct install gains the pair; a second run is byte-stable", async () => {
  const claudeHome = isolate("direct");

  await migration.run();
  const permissions = settings(claudeHome).permissions as Record<string, unknown>;
  expect(permissions.deny).toEqual([WEBSEARCH_DENY_RULE]);
  const servers = (JSON.parse(readFileSync(claudeJsonPath(), "utf8")) as Record<string, unknown>)
    .mcpServers as Record<string, unknown>;
  expect(servers["copilot-env"]).toMatchObject({ "type": "stdio" });

  const settingsBefore = statSync(join(claudeHome, "settings.json")).mtimeMs;
  const claudeJsonBefore = statSync(claudeJsonPath()).mtimeMs;
  await migration.run();
  expect(statSync(join(claudeHome, "settings.json")).mtimeMs).toBe(settingsBefore);
  expect(statSync(claudeJsonPath()).mtimeMs).toBe(claudeJsonBefore);
});

test("a proxy install is untouched", async () => {
  const claudeHome = isolate("proxy");
  const before = readFileSync(join(claudeHome, "settings.json"), "utf8");

  await migration.run();
  expect(readFileSync(join(claudeHome, "settings.json"), "utf8")).toBe(before);
  expect(() => statSync(claudeJsonPath())).toThrow(); // never created
});

test("wire-mcp false makes the migration a no-op", async () => {
  const claudeHome = isolate("direct");
  new CopilotEnvConfig().set({ wireMcp: false });

  await migration.run();
  expect(settings(claudeHome).permissions).toBeUndefined();
  expect(() => statSync(claudeJsonPath())).toThrow();
});

test("a foreign (unmanaged) settings.json is never touched", async () => {
  const homes = isolateAgentHomes("copilot-mig352-", { mkdirs: true });
  dir = homes.dir;
  const claudeHome = homes.claudeHome;
  const foreign = `${JSON.stringify({ apiKeyHelper: "/somewhere/else.sh" }, null, 2)}\n`;
  writeFileSync(join(claudeHome, "settings.json"), foreign);

  await migration.run();
  expect(readFileSync(join(claudeHome, "settings.json"), "utf8")).toBe(foreign);
  expect(() => statSync(claudeJsonPath())).toThrow();
});
