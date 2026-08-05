// Matrix tests for src/agents/wiring.ts -- the single source of truth for
// "how are the agents wired?". The two predicates answer different questions:
// defaultSetupNeedsProxy ignores named profiles (health's default-daemon
// question), proxyUnusedEverywhere counts them (the float's npm-work question).
// The proxyUnusedEverywhere cases moved here from test/proxy_float.test.ts
// when the predicate moved into this module.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  defaultSetupNeedsProxy,
  proxyUnusedEverywhere,
  readAgentModes,
} from "../src/agents/wiring.ts";
import { DIRECT_HELPER_NAME, PROXY_HELPER_NAME } from "../src/claude/paths.ts";
import {
  envSnapshot,
  isolateProxyHome,
  removeDir,
  writeClaudeSettings,
  writeCodexConfigToml,
  writeRunState,
} from "./helpers.ts";

const restoreEnv = envSnapshot();
let dir = "";

beforeEach(() => {
  dir = isolateProxyHome("copilot-wiring-");
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
    writeClaudeSettings(home, {
      apiKeyHelper: join(home, DIRECT_HELPER_NAME),
      baseUrl: DIRECT_BASE,
    });
  }
  if (mode === "proxy") {
    writeClaudeSettings(home, {
      apiKeyHelper: join(home, PROXY_HELPER_NAME),
      baseUrl: PROXY_CLAUDE_BASE,
    });
  }
  return home;
}

/** A named profile's daemon home -- created only by proxy wiring or `agent
 *  start --profile`, so its presence means a local proxy is in use. */
function addProfileHome(): void {
  mkdirSync(join(dir, "profiles", "work"), { recursive: true });
}

describe("mode matrix: codex x claude x profile home", () => {
  const MODES: WiredMode[] = ["direct", "proxy", "none"];
  for (const codex of MODES) {
    for (const claude of MODES) {
      for (const profilePresent of [false, true]) {
        const bothDirect = codex === "direct" && claude === "direct";
        test(`codex=${codex} claude=${claude} profileHome=${profilePresent}`, () => {
          const opts = { codexHome: makeCodexHome(codex), claudeHome: makeClaudeHome(claude) };
          if (profilePresent) addProfileHome();
          expect(readAgentModes(opts)).toEqual({ codex, claude });
          // Health's question ignores profile homes: a named proxy profile runs
          // its own daemon and never makes the DEFAULT setup need one.
          expect(defaultSetupNeedsProxy(opts)).toBe(!bothDirect);
          // The float's question counts them: any profile daemon uses the package.
          expect(proxyUnusedEverywhere(opts)).toBe(bothDirect && !profilePresent);
        });
      }
    }
  }
});

test("driving bug: both defaults Direct while a proxy profile home exists", () => {
  // The configuration health once misdiagnosed: the DEFAULT setup needs no
  // proxy (both agents Direct), yet the proxy package is NOT unused -- the
  // profile's own daemon still runs on it, so the float must keep floating.
  const opts = { codexHome: makeCodexHome("direct"), claudeHome: makeClaudeHome("direct") };
  addProfileHome();
  expect(defaultSetupNeedsProxy(opts)).toBe(false);
  expect(proxyUnusedEverywhere(opts)).toBe(false);
});

describe("proxyUnusedEverywhere edge cases", () => {
  test("true when Codex is direct-wired and Claude points at the direct helper", () => {
    const opts = { codexHome: makeCodexHome("direct"), claudeHome: makeClaudeHome("direct") };
    expect(proxyUnusedEverywhere(opts)).toBe(true);
  });

  test("false on a mixed Claude config (direct helper but a proxy ANTHROPIC_BASE_URL)", () => {
    const codexHome = makeCodexHome("direct");
    const claudeHome = join(dir, "claude-home");
    writeClaudeSettings(claudeHome, {
      apiKeyHelper: join(claudeHome, DIRECT_HELPER_NAME),
      baseUrl: PROXY_CLAUDE_BASE,
    });
    // The MODE alone keys off the helper path and still reads direct -- which
    // is exactly why the float's predicate must also check the base URL.
    expect(readAgentModes({ codexHome, claudeHome }).claude).toBe("direct");
    expect(defaultSetupNeedsProxy({ codexHome, claudeHome })).toBe(false);
    expect(proxyUnusedEverywhere({ codexHome, claudeHome })).toBe(false);
  });

  test("false when the Claude direct base URL is missing (partially managed config)", () => {
    const codexHome = makeCodexHome("direct");
    const claudeHome = join(dir, "claude-home");
    writeClaudeSettings(claudeHome, { apiKeyHelper: join(claudeHome, DIRECT_HELPER_NAME) });
    expect(proxyUnusedEverywhere({ codexHome, claudeHome })).toBe(false);
  });

  test("false on unparseable configs (uncertain wiring floats normally)", () => {
    const codexHome = join(dir, "codex-home");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "config.toml"), "model_provider = [broken");
    const claudeHome = makeClaudeHome("direct");
    expect(proxyUnusedEverywhere({ codexHome, claudeHome })).toBe(false);
  });
});

test("unparseable Claude settings read as 'other' (a config we must not clobber)", () => {
  const codexHome = makeCodexHome("direct");
  const claudeHome = join(dir, "claude-home");
  mkdirSync(claudeHome, { recursive: true });
  writeFileSync(join(claudeHome, "settings.json"), "{broken");
  const opts = { codexHome, claudeHome };
  expect(readAgentModes(opts)).toEqual({ codex: "direct", claude: "other" });
  expect(defaultSetupNeedsProxy(opts)).toBe(true);
  expect(proxyUnusedEverywhere(opts)).toBe(false);
});

describe("default home resolution", () => {
  test("codex follows the run-state codexHome override; claude follows $CLAUDE_CONFIG_DIR", () => {
    // The effective-home precedence every caller shares: a `--host` farm records
    // the active Codex home in run state, which wins over $CODEX_HOME; Claude's
    // one knob is $CLAUDE_CONFIG_DIR.
    const farmHome = join(dir, "farm-codex");
    writeCodexConfigToml(farmHome, { baseUrl: DIRECT_BASE });
    process.env.CODEX_HOME = join(dir, "empty-codex"); // must lose to run state
    writeRunState({ codexHome: farmHome });

    const claudeHome = join(dir, "claude-env-home");
    writeClaudeSettings(claudeHome, {
      apiKeyHelper: join(claudeHome, DIRECT_HELPER_NAME),
      baseUrl: DIRECT_BASE,
    });
    process.env.CLAUDE_CONFIG_DIR = claudeHome;

    expect(readAgentModes()).toEqual({ codex: "direct", claude: "direct" });
    expect(defaultSetupNeedsProxy()).toBe(false);
    expect(proxyUnusedEverywhere()).toBe(true);
  });
});
