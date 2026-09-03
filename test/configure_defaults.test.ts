// recordDefaultModeFromWiring (src/agents/configure_defaults.ts): the read-back +
// record step the single-agent rewires (`agent codex` / `agent claude`) run after
// a successful default wire, keeping the default slot's recorded mode fresh.
// Wiring fixtures mirror test/agents_wiring.test.ts; the record's store-level
// semantics live in test/state.test.ts.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { recordDefaultModeFromWiring } from "../src/agents/configure_defaults.ts";
import { directHelperCommand, proxyHelperCommand } from "../src/claude/config.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { runCli } from "./helpers/run.ts";
import { afterEach, beforeEach, expect, test } from "./helpers/testing.ts";
import {
  envSnapshot,
  isolateProxyHome,
  removeDir,
  writeClaudeSettings,
  writeCodexConfigToml,
} from "./helpers.ts";

const restoreEnv = envSnapshot();
let dir = "";

beforeEach(() => {
  dir = isolateProxyHome("copilot-recordmode-");
});

afterEach(() => {
  restoreEnv();
  dir = removeDir(dir);
});

const DIRECT_BASE = "https://api.githubcopilot.com";
const PROXY_CODEX_BASE = "http://127.0.0.1:4141/v1";
const PROXY_CLAUDE_BASE = "http://127.0.0.1:4141";

type WiredMode = "direct" | "proxy" | "none";

/** A Codex home wired to `mode` ("none" = an empty home, no config.toml). */
function makeCodexHome(mode: WiredMode): string {
  const home = join(dir, "codex-home");
  mkdirSync(home, { recursive: true });
  if (mode === "direct") writeCodexConfigToml(home, { baseUrl: DIRECT_BASE });
  if (mode === "proxy") {
    writeCodexConfigToml(home, { baseUrl: PROXY_CODEX_BASE, envKey: "OPENAI_API_KEY" });
  }
  return home;
}

/** A Claude home wired to `mode` ("none" = an empty home, no settings.json). */
function makeClaudeHome(mode: WiredMode): string {
  const home = join(dir, "claude-home");
  mkdirSync(home, { recursive: true });
  if (mode === "direct") {
    writeClaudeSettings(home, { apiKeyHelper: directHelperCommand(), baseUrl: DIRECT_BASE });
  }
  if (mode === "proxy") {
    writeClaudeSettings(home, { apiKeyHelper: proxyHelperCommand(), baseUrl: PROXY_CLAUDE_BASE });
  }
  return home;
}

test("records the agreed managed mode when both agents match", () => {
  recordDefaultModeFromWiring({
    codexHome: makeCodexHome("proxy"),
    claudeHome: makeClaudeHome("proxy"),
  });
  expect(new CopilotEnvState().readProfileSlot(null).mode).toBe("proxy");

  // A rewire of ONE agent onto the other's mode lands on the new agreement.
  recordDefaultModeFromWiring({
    codexHome: makeCodexHome("direct"),
    claudeHome: makeClaudeHome("direct"),
  });
  expect(new CopilotEnvState().readProfileSlot(null).mode).toBe("direct");
});

test("a one-agent rewire that diverges the pair clears the stale record", () => {
  // The bug this step closes: the record says proxy, then `agent codex --direct`
  // rewires ONE agent -- the pair diverges, so the record must clear, not stay.
  new CopilotEnvState().recordDefaultMode("proxy");
  recordDefaultModeFromWiring({
    codexHome: makeCodexHome("direct"),
    claudeHome: makeClaudeHome("proxy"),
  });
  expect(new CopilotEnvState().readProfileSlot(null).mode).toBeNull();
});

test("an unmanaged pair (none/none) records null, never a managed mode", () => {
  new CopilotEnvState().recordDefaultMode("direct");
  recordDefaultModeFromWiring({
    codexHome: makeCodexHome("none"),
    claudeHome: makeClaudeHome("none"),
  });
  expect(new CopilotEnvState().readProfileSlot(null).mode).toBeNull();
});

// --- the CLI dispatch hooks, end-to-end (src/cli.ts) -------------------------------
// Each test hand-wires the OTHER agent first, so the spawned child's rewire is
// the transition that creates agreement: the assertion fails if that agent's
// dispatch hook is missing. A forced-proxy wire needs no credential, probe, or
// network (the catalog seed is best-effort), so the children run offline.

/** The child env for one CLI spawn, everything isolated under `dir`. */
function childCliEnv(codexHome: string, claudeHome: string): Record<string, string | undefined> {
  return {
    ...process.env,
    CONSOLA_LEVEL: "5",
    COPILOT_API_HOME: dir,
    HOME: dir,
    USERPROFILE: dir,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeHome,
    // No credential may leak in: the children must resolve auth to none.
    COPILOT_GITHUB_TOKEN: undefined,
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
  };
}

/** The default slot's recorded mode, read raw from the isolated state store. */
function recordedMode(): string | undefined {
  const statePath = join(dir, ".copilot-env-state.json");
  if (!existsSync(statePath)) return undefined;
  const state = JSON.parse(readFileSync(statePath, "utf8")) as {
    profiles?: { default?: { mode?: string } };
  };
  return state.profiles?.default?.mode;
}

test("`agent codex --proxy` lands the pair on agreement and records it", () => {
  const claudeHome = makeClaudeHome("proxy");
  const run = runCli(["codex", "--proxy"], { env: childCliEnv(join(dir, ".codex"), claudeHome) });
  expect(run.exitCode).toBe(0);
  expect(recordedMode()).toBe("proxy");
});

test("`agent claude --proxy` lands the pair on agreement and records it", () => {
  const codexHome = makeCodexHome("proxy");
  const run = runCli(["claude", "--proxy"], { env: childCliEnv(codexHome, join(dir, ".claude")) });
  expect(run.exitCode).toBe(0);
  expect(recordedMode()).toBe("proxy");
});
