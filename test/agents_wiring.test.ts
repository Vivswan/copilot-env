// Matrix tests for src/agents/wiring.ts -- the single source of truth for
// "how are the agents wired?". The two predicates answer different questions:
// defaultSetupNeedsProxy ignores named profiles (health's default-daemon
// question), proxyUnusedEverywhere counts them (the float's npm-work question).
// The proxyUnusedEverywhere cases moved here from test/proxy_float.test.ts
// when the predicate moved into this module.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  defaultSetupNeedsProxy,
  proxyUnusedEverywhere,
  readAgentModes,
} from "../src/agents/wiring.ts";
import { directHelperCommand, proxyHelperCommand } from "../src/claude/config.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { afterEach, beforeEach, describe, expect, test } from "./helpers/testing.ts";
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
      apiKeyHelper: directHelperCommand(),
      baseUrl: DIRECT_BASE,
    });
  }
  if (mode === "proxy") {
    writeClaudeSettings(home, {
      apiKeyHelper: proxyHelperCommand(),
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
      apiKeyHelper: directHelperCommand(),
      baseUrl: PROXY_CLAUDE_BASE,
    });
    // The MODE alone keys off apiKeyHelper and still reads direct -- which
    // is exactly why BOTH predicates must also check the base URL: Claude's
    // traffic genuinely goes to the local daemon, so the default setup needs
    // the proxy (this assertion once said false -- that WAS the bug health
    // inherited) and the float must keep floating.
    expect(readAgentModes({ codexHome, claudeHome }).claude).toBe("direct");
    expect(defaultSetupNeedsProxy({ codexHome, claudeHome })).toBe(true);
    expect(proxyUnusedEverywhere({ codexHome, claudeHome })).toBe(false);
  });

  test("false when the Claude direct base URL is missing (partially managed config)", () => {
    const codexHome = makeCodexHome("direct");
    const claudeHome = join(dir, "claude-home");
    writeClaudeSettings(claudeHome, { apiKeyHelper: directHelperCommand() });
    // The float refuses to skip on ANY deviation from the managed Direct URL,
    // but health's question is narrower: no base URL means no route to the
    // local daemon, so the default setup still needs no proxy.
    expect(proxyUnusedEverywhere({ codexHome, claudeHome })).toBe(false);
    expect(defaultSetupNeedsProxy({ codexHome, claudeHome })).toBe(false);
  });

  test("false on unparseable configs (uncertain wiring floats normally)", () => {
    const codexHome = join(dir, "codex-home");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "config.toml"), "model_provider = [broken");
    const claudeHome = makeClaudeHome("direct");
    expect(proxyUnusedEverywhere({ codexHome, claudeHome })).toBe(false);
    // The classifier mints the not-ours verdict itself (other/malformed), so a
    // best-effort caller never mistakes an unparseable config for an unwired one.
    expect(readAgentModes({ codexHome, claudeHome }).codex).toBe("other");
  });

  test("an UNREADABLE codex config reads other, never none (nothing synthesizes it)", () => {
    // config.toml as a DIRECTORY: the entry exists but cannot be read as text,
    // the portable stand-in for a permission failure. The classifier itself
    // (not a caller-side seam) must report present-but-unknown.
    const codexHome = join(dir, "codex-home");
    mkdirSync(join(codexHome, "config.toml"), { recursive: true });
    const claudeHome = makeClaudeHome("direct");
    expect(readAgentModes({ codexHome, claudeHome }).codex).toBe("other");
    expect(proxyUnusedEverywhere({ codexHome, claudeHome })).toBe(false);
  });
});

describe("defaultSetupNeedsProxy base-URL matrix (codex direct + Claude direct helper)", () => {
  // Claude's mode keys off apiKeyHelper alone, so the base URL decides whether
  // a mode-direct Claude still routes to OUR daemon. Only a URL the proxy-mode
  // matcher accepts (loopback host, the resolved port, bare origin) counts;
  // anything routed elsewhere leaves the daemon out of the path -- its state
  // can neither fix nor break the agent, so health must not demand it.
  const cases: { name: string; baseUrl?: string; needsProxy: boolean }[] = [
    { name: "the local proxy origin", baseUrl: PROXY_CLAUDE_BASE, needsProxy: true },
    {
      name: "the local proxy origin, localhost spelling",
      baseUrl: "http://localhost:4141",
      needsProxy: true,
    },
    {
      name: "the local proxy origin, trailing slash",
      baseUrl: "http://127.0.0.1:4141/",
      needsProxy: true,
    },
    {
      name: "a foreign gateway (routes elsewhere)",
      baseUrl: "https://some-gateway.example",
      needsProxy: false,
    },
    {
      name: "a loopback service on a DIFFERENT port (not our daemon)",
      baseUrl: "http://127.0.0.1:5000",
      needsProxy: false,
    },
    { name: "the managed Direct URL", baseUrl: DIRECT_BASE, needsProxy: false },
    { name: "no base URL at all", needsProxy: false },
  ];
  for (const { name, baseUrl, needsProxy } of cases) {
    test(`${name} => ${needsProxy}`, () => {
      const codexHome = makeCodexHome("direct");
      const claudeHome = join(dir, "claude-home");
      writeClaudeSettings(claudeHome, {
        apiKeyHelper: directHelperCommand(),
        ...(baseUrl === undefined ? {} : { baseUrl }),
      });
      expect(defaultSetupNeedsProxy({ codexHome, claudeHome })).toBe(needsProxy);
    });
  }

  test("the reverse mixed shape stays true via the mode (proxy helper, direct base URL)", () => {
    const codexHome = makeCodexHome("direct");
    const claudeHome = join(dir, "claude-home");
    writeClaudeSettings(claudeHome, {
      apiKeyHelper: proxyHelperCommand(),
      baseUrl: DIRECT_BASE,
    });
    expect(defaultSetupNeedsProxy({ codexHome, claudeHome })).toBe(true);
  });

  test("codex proxy + claude direct stays true regardless of Claude's base URL", () => {
    const opts = { codexHome: makeCodexHome("proxy"), claudeHome: makeClaudeHome("direct") };
    expect(defaultSetupNeedsProxy(opts)).toBe(true);
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

test("unreadable configs read as 'other', never as unconfigured 'none'", () => {
  // A directory at each config path EXISTS but cannot be read as text (a
  // non-ENOENT error on every platform) -- the cross-platform unreadable fixture.
  const codexHome = join(dir, "codex-home");
  mkdirSync(join(codexHome, "config.toml"), { recursive: true });
  const claudeHome = join(dir, "claude-home");
  mkdirSync(join(claudeHome, "settings.json"), { recursive: true });
  const opts = { codexHome, claudeHome };
  expect(readAgentModes(opts)).toEqual({ codex: "other", claude: "other" });
  expect(defaultSetupNeedsProxy(opts)).toBe(true);
  expect(proxyUnusedEverywhere(opts)).toBe(false);
});

describe("default home resolution", () => {
  // The farm (and so its run-state record) is POSIX-only: the `codex-host` key always
  // reads off on Windows, so the record is never honored there.
  test.skipIf(process.platform === "win32")(
    "codex follows the run-state codexHome override; claude follows $CLAUDE_CONFIG_DIR",
    () => {
      // The effective-home precedence every caller shares: with the `codex-host` key
      // on, the run-state record its derivation wrote wins over $CODEX_HOME; Claude's
      // one knob is $CLAUDE_CONFIG_DIR.
      const farmHome = join(dir, "farm-codex");
      writeCodexConfigToml(farmHome, { baseUrl: DIRECT_BASE });
      process.env.CODEX_HOME = join(dir, "empty-codex"); // must lose to run state
      new CopilotEnvConfig().set({ codexHost: true });
      writeRunState({ codexHome: farmHome });

      const claudeHome = join(dir, "claude-env-home");
      writeClaudeSettings(claudeHome, {
        apiKeyHelper: directHelperCommand(),
        baseUrl: DIRECT_BASE,
      });
      process.env.CLAUDE_CONFIG_DIR = claudeHome;

      expect(readAgentModes()).toEqual({ codex: "direct", claude: "direct" });
      expect(defaultSetupNeedsProxy()).toBe(false);
      expect(proxyUnusedEverywhere()).toBe(true);
    },
  );
});
