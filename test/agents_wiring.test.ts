// The two predicates answer different questions, and the matrix pins the split:
//   defaultSetupNeedsProxy -> health's question; ignores profile homes (they run their own daemon)
//   proxyUnusedEverywhere  -> the float's question; counts them (a profile daemon uses the package)

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  defaultSetupNeedsProxy,
  proxyUnusedEverywhere,
  readAgentWirings,
} from "../src/agents/wiring.ts";

import { directHelperCommand, proxyHelperCommand } from "../src/claude/config.ts";
import { getHostLocalCodexHome } from "../src/codex/host.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { afterEach, beforeEach, describe, expect, removeDir, test } from "./helpers/testing.ts";
import {
  envSnapshot,
  isolateProxyHome,
  writeClaudeSettings,
  writeCodexConfigToml,
} from "./helpers.ts";

/** The two default modes as the classifiers read them (a test-side view: src reads no agent file
 *  as truth, so this helper exists here alone). */
function readAgentModes(opts: Parameters<typeof readAgentWirings>[0] = {}) {
  const { codex, claude } = readAgentWirings(opts);
  return { codex: codex.providerMode, claude: claude.providerMode };
}

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

/** Only proxy wiring or `agent profile <name> start` creates a profile's daemon home, so its presence
 *  means a local proxy is in use. */
function addProfileHome(): void {
  mkdirSync(join(dir, "profiles", "work"), { recursive: true });
}

describe("mode matrix: codex x claude x profile home", () => {
  // Health once misdiagnosed the direct/direct/profileHome=true row: the DEFAULT setup needs no
  // proxy, yet the profile's own daemon still runs on the package, so the float must keep floating.
  const MODES: WiredMode[] = ["direct", "proxy", "none"];
  for (const codex of MODES) {
    for (const claude of MODES) {
      for (const profilePresent of [false, true]) {
        const bothDirect = codex === "direct" && claude === "direct";
        test(`codex=${codex} claude=${claude} profileHome=${profilePresent}`, () => {
          const opts = { codexHome: makeCodexHome(codex), claudeHome: makeClaudeHome(claude) };
          if (profilePresent) addProfileHome();
          expect(readAgentModes(opts)).toEqual({ codex, claude });
          expect(defaultSetupNeedsProxy(opts)).toBe(!bothDirect);
          expect(proxyUnusedEverywhere(opts)).toBe(bothDirect && !profilePresent);
        });
      }
    }
  }
});

describe("Claude's base URL against its helper: the route decides, not the mode alone", () => {
  // Claude's mode keys off apiKeyHelper alone, so the base URL decides whether a mode-direct Claude
  // still routes to OUR daemon. A daemon that is not in the path can neither fix nor break the
  // agent, so health must not demand it; the float skips only for a Direct-shaped https host (the
  // generic one or a `host` literal), never a loopback or missing URL. (The mixed shape's
  // needsProxy once said false: the bug health inherited.)
  const cases: {
    name: string;
    codex: WiredMode;
    helper: "direct" | "proxy";
    baseUrl?: string;
    claudeMode: "direct" | "proxy";
    needsProxy: boolean;
    unused: boolean;
  }[] = [
    {
      name: "the local proxy origin (mixed: direct helper, proxy URL)",
      codex: "direct",
      helper: "direct",
      baseUrl: PROXY_CLAUDE_BASE,
      claudeMode: "direct",
      needsProxy: true,
      unused: false,
    },
    {
      name: "the local proxy origin, localhost spelling",
      codex: "direct",
      helper: "direct",
      baseUrl: "http://localhost:4141",
      claudeMode: "direct",
      needsProxy: true,
      unused: false,
    },
    {
      name: "the local proxy origin, trailing slash",
      codex: "direct",
      helper: "direct",
      baseUrl: "http://127.0.0.1:4141/",
      claudeMode: "direct",
      needsProxy: true,
      unused: false,
    },
    {
      name: "a foreign https gateway (routes elsewhere: Direct on another host)",
      codex: "direct",
      helper: "direct",
      baseUrl: "https://some-gateway.example",
      claudeMode: "direct",
      needsProxy: false,
      unused: true,
    },
    {
      name: "a loopback service on a DIFFERENT port (not our daemon)",
      codex: "direct",
      helper: "direct",
      baseUrl: "http://127.0.0.1:5000",
      claudeMode: "direct",
      needsProxy: false,
      unused: false,
    },
    {
      name: "the managed Direct URL",
      codex: "direct",
      helper: "direct",
      baseUrl: DIRECT_BASE,
      claudeMode: "direct",
      needsProxy: false,
      unused: true,
    },
    {
      name: "no base URL at all (partially managed config)",
      codex: "direct",
      helper: "direct",
      claudeMode: "direct",
      needsProxy: false,
      unused: false,
    },
    {
      name: "the reverse mixed shape (proxy helper, direct base URL) stays true via the mode",
      codex: "direct",
      helper: "proxy",
      baseUrl: DIRECT_BASE,
      claudeMode: "proxy",
      needsProxy: true,
      unused: false,
    },
    {
      name: "codex proxy + claude direct stays true regardless of Claude's base URL",
      codex: "proxy",
      helper: "direct",
      baseUrl: DIRECT_BASE,
      claudeMode: "direct",
      needsProxy: true,
      unused: false,
    },
  ];
  for (const c of cases) {
    test(`${c.name} => needsProxy ${c.needsProxy}, unused ${c.unused}`, () => {
      const codexHome = makeCodexHome(c.codex);
      const claudeHome = join(dir, "claude-home");
      writeClaudeSettings(claudeHome, {
        apiKeyHelper: c.helper === "direct" ? directHelperCommand() : proxyHelperCommand(),
        ...(c.baseUrl === undefined ? {} : { baseUrl: c.baseUrl }),
      });
      const opts = { codexHome, claudeHome };
      expect(readAgentModes(opts)).toEqual({ codex: c.codex, claude: c.claudeMode });
      expect(defaultSetupNeedsProxy(opts)).toBe(c.needsProxy);
      expect(proxyUnusedEverywhere(opts)).toBe(c.unused);
    });
  }
});

describe("a config that cannot be read as ours reads 'other', never unconfigured 'none'", () => {
  // The classifier mints the not-ours verdict itself (other/malformed or read-error), so a
  // best-effort caller never mistakes a broken config for an unwired one: uncertain wiring floats
  // normally and health keeps asking for the proxy. A directory at the config path is the
  // portable stand-in for a permission failure (a non-ENOENT error everywhere).
  type Broken = "unparseable" | "unreadable";
  const breakCodex = (how: Broken): string => {
    const home = join(dir, "codex-home");
    if (how === "unreadable") mkdirSync(join(home, "config.toml"), { recursive: true });
    else {
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, "config.toml"), "model_provider = [broken");
    }
    return home;
  };
  const breakClaude = (how: Broken): string => {
    const home = join(dir, "claude-home");
    if (how === "unreadable") mkdirSync(join(home, "settings.json"), { recursive: true });
    else {
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, "settings.json"), "{broken");
    }
    return home;
  };
  const cases: { codex: Broken | "direct"; claude: Broken | "direct" }[] = [
    { codex: "unparseable", claude: "direct" },
    { codex: "unreadable", claude: "direct" },
    { codex: "direct", claude: "unparseable" },
    { codex: "unreadable", claude: "unreadable" },
  ];
  for (const c of cases) {
    test(`codex=${c.codex} claude=${c.claude}`, () => {
      const opts = {
        codexHome: c.codex === "direct" ? makeCodexHome("direct") : breakCodex(c.codex),
        claudeHome: c.claude === "direct" ? makeClaudeHome("direct") : breakClaude(c.claude),
      };
      expect(readAgentModes(opts)).toEqual({
        codex: c.codex === "direct" ? "direct" : "other",
        claude: c.claude === "direct" ? "direct" : "other",
      });
      expect(defaultSetupNeedsProxy(opts)).toBe(true);
      expect(proxyUnusedEverywhere(opts)).toBe(false);
    });
  }
});

describe("default home resolution", () => {
  // The farm is POSIX-only: the `codex-host` key always reads off on Windows.
  test.skipIf(process.platform === "win32")(
    "codex follows the farm the keys derive; claude follows $CLAUDE_CONFIG_DIR",
    () => {
      // HOME stays real here, so the farm is rooted under the fixture through `codex-home`.
      new CopilotEnvConfig().set({ "codex.home": join(dir, "codex-root"), "codex.host": true });
      const farmHome = getHostLocalCodexHome();
      expect(farmHome.startsWith(dir)).toBe(true);
      writeCodexConfigToml(farmHome, { baseUrl: DIRECT_BASE });
      process.env.CODEX_HOME = join(dir, "empty-codex"); // must lose to the keys

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
