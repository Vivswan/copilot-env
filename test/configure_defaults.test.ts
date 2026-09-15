// The record's store-level semantics are pinned in test/state.test.ts.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { recordDefaultModeFromWiring } from "../src/agents/configure_defaults.ts";
import { directHelperCommand, proxyHelperCommand } from "../src/claude/config.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { runCli } from "./helpers/run.ts";
import { afterEach, beforeEach, expect, removeDir, test } from "./helpers/testing.ts";
import {
  envSnapshot,
  isolateProxyHome,
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

function makeCodexHome(mode: WiredMode): string {
  const home = join(dir, "codex-home");
  mkdirSync(home, { recursive: true });
  if (mode === "direct") writeCodexConfigToml(home, { baseUrl: DIRECT_BASE });
  if (mode === "proxy") {
    writeCodexConfigToml(home, { baseUrl: PROXY_CODEX_BASE, envKey: "OPENAI_API_KEY" });
  }
  return home;
}

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
// Each test hand-wires the OTHER agent first, so the child's rewire is the transition that
// creates agreement. A forced-proxy wire needs no probe or network, so the children run offline
// on a stored token.

function childCliEnv(codexHome: string, claudeHome: string): Record<string, string | undefined> {
  return {
    ...process.env,
    CONSOLA_LEVEL: "5",
    COPILOT_API_HOME: dir,
    HOME: dir,
    USERPROFILE: dir,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeHome,
    // No credential may leak in from the shell: the store alone decides what the children see.
    COPILOT_GITHUB_TOKEN: undefined,
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
  };
}

function recordedMode(): string | undefined {
  const statePath = join(dir, "credentials.json");
  if (!existsSync(statePath)) return undefined;
  const state = JSON.parse(readFileSync(statePath, "utf8")) as {
    profiles?: { default?: { mode?: string } };
  };
  return state.profiles?.default?.mode;
}

/** The wiring commands log in first; a stored token satisfies the gate headless. */
function storeCredential(): void {
  new CopilotEnvState().setCredential(null, {
    kind: "stored",
    provider: "gh-token",
    token: "ghu_test",
  });
}

test("`agent codex --proxy` lands the pair on agreement and records it", () => {
  storeCredential();
  const claudeHome = makeClaudeHome("proxy");
  const run = runCli(["codex", "--proxy"], { env: childCliEnv(join(dir, ".codex"), claudeHome) });
  expect(run.exitCode).toBe(0);
  expect(recordedMode()).toBe("proxy");
});

test("`agent claude --proxy` lands the pair on agreement and records it", () => {
  storeCredential();
  const codexHome = makeCodexHome("proxy");
  const run = runCli(["claude", "--proxy"], { env: childCliEnv(codexHome, join(dir, ".claude")) });
  expect(run.exitCode).toBe(0);
  expect(recordedMode()).toBe("proxy");
});

// The gap this pins: `agent claude` on a fresh machine used to write proxy wiring that could
// serve nothing, and only `agent init` asked for a login (and not for `--proxy`).
test("a wiring command with no credential refuses headless and writes nothing", () => {
  const codexHome = join(dir, ".codex");
  const claudeHome = join(dir, ".claude");
  const env = childCliEnv(codexHome, claudeHome);
  for (const argv of [["claude", "--proxy"], ["codex"], ["init", "--proxy"]]) {
    const run = runCli(argv, { env });
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("Not authenticated yet");
  }
  expect(existsSync(join(claudeHome, "settings.json"))).toBe(false);
  expect(existsSync(join(codexHome, "config.toml"))).toBe(false);
  expect(recordedMode()).toBeUndefined();
});
