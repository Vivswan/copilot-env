// The record's store-level semantics are pinned in test/state.test.ts.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { type AgentAdapter, directWiring, type ManagedAgentId } from "../src/agents/configure.ts";
import { configureDefaultAgents, runAgentConfig } from "../src/agents/configure_defaults.ts";
import { bothAgents } from "../src/agents/profile_wiring.ts";
import { AUTH_TOKEN_ENV, claudeAdapter, proxyHelperCommand } from "../src/claude/config.ts";
import { NOOP_CATALOG_DEPS } from "../src/codex/catalog.ts";
import { CopilotApiConfig } from "../src/copilot_api/config.ts";
import { CopilotEnvConfig, type StaticKeyScope } from "../src/copilot_api/env_config.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { proxyTokenCommand } from "../src/utils/root.ts";
import { runCli } from "./helpers/run.ts";
import { afterEach, beforeEach, expect, removeDir, test } from "./helpers/testing.ts";
import { envSnapshot, isolateAgentHomes, isolateProxyHome } from "./helpers.ts";

const restoreEnv = envSnapshot(["PATH"]);
let dir = "";

beforeEach(() => {
  dir = isolateProxyHome("copilot-recordmode-");
});

afterEach(() => {
  restoreEnv();
  dir = removeDir(dir);
});

// --- the CLI dispatch hooks, end-to-end (src/cli.ts) -------------------------------
// A forced-proxy wire needs no probe or network, so the children run offline on a stored token.

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
  const statePath = join(dir, "state.json");
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

// Profiles are atomic units, the default included: on a fresh default (no recorded mode) a
// single-agent command is the first landing and wires BOTH agents, as `agent init --proxy` would.
test("`agent codex --proxy` on a fresh default lands both agents and records the mode they share", () => {
  storeCredential();
  const codexHome = join(dir, ".codex");
  const claudeHome = join(dir, ".claude");
  const run = runCli(["codex", "--proxy"], { env: childCliEnv(codexHome, claudeHome) });
  expect(run.exitCode).toBe(0);
  // consola keeps or strips the backticks by reporter, so the match allows both.
  expect(run.stderr).toMatch(/wiring both, as `?agent init --proxy`? would/);
  expect(existsSync(join(codexHome, "config.toml"))).toBe(true);
  expect(existsSync(join(claudeHome, "settings.json"))).toBe(true);
  expect(recordedMode()).toBe("proxy");
});

// The default is one mode for both agents: only the both-agents write moves a recorded mode.
test("the both-agents write moves a recorded default; a single-agent write onto another mode is refused", async () => {
  dir = removeDir(dir);
  const homes = isolateAgentHomes("copilot-move-mode-", { mkdirs: true });
  dir = homes.dir;
  storeCredential();
  const state = new CopilotEnvState();
  state.recordDefaultMode("direct");
  const single = await configureDefaultAgents(
    { codex: "proxy", claude: null, ghToken: "ghu_test" },
    bothAgents(NOOP_CATALOG_DEPS),
  );
  expect(single.failedAgents).toEqual(["codex"]);
  expect(existsSync(join(homes.codexHome, "config.toml"))).toBe(false);
  expect(state.readProfileSlot(null).mode).toBe("direct");
  const both = await configureDefaultAgents(
    { codex: "proxy", claude: "proxy", ghToken: "ghu_test" },
    bothAgents(NOOP_CATALOG_DEPS),
  );
  expect(both.failures).toEqual([]);
  expect(existsSync(join(homes.codexHome, "config.toml"))).toBe(true);
  expect(state.readProfileSlot(null).mode).toBe("proxy");
});

// --- `agent init` (auto): one probe pass decides one mode for both agents ------------------------

/** One ordered trace of what the landing did: `probe:<id>` events, then `write:<id>:<mode>`. */
function probeAdapter(id: ManagedAgentId, verdict: boolean, trace: string[]): AgentAdapter {
  return {
    id,
    label: id,
    check: () => {},
    detectDirect: () => {
      trace.push(`probe:${id}`);
      return Promise.resolve(verdict);
    },
    resolveDirectWiring: () =>
      Promise.resolve(directWiring("copilot-developer-cli", "https://api.githubcopilot.com")),
    configureDefault(write) {
      trace.push(`write:${id}:${write.mode}`);
      return Promise.resolve();
    },
    configureProfile: () => {},
    removeProfile: () => {},
  };
}

test("`agent init` (auto) probes both agents BEFORE any write and lands one mode; disagreeing probes put both on the proxy", async () => {
  const state = new CopilotEnvState();
  for (const c of [{ codex: false, expected: "proxy" }, { codex: true, expected: "direct" }]) {
    const trace: string[] = [];
    state.recordDefaultMode("direct"); // whatever the record says, init never refuses itself
    const out = await configureDefaultAgents(
      { codex: "auto", claude: "auto", ghToken: "ghu_test" },
      [probeAdapter("claude", true, trace), probeAdapter("codex", c.codex, trace)],
    );
    expect({ codexProbe: c.codex, ...out, trace, recorded: state.readProfileSlot(null).mode })
      .toEqual({
        codexProbe: c.codex,
        codex: c.expected,
        claude: c.expected,
        failures: [],
        failedAgents: [],
        trace: [
          "probe:claude",
          "probe:codex",
          `write:claude:${c.expected}`,
          `write:codex:${c.expected}`,
        ],
        recorded: c.expected,
      });
  }
});

// The record is the mode both agents share, so it is committed only once both writes succeeded
// (commitDefaultWiring): a move one agent did not make leaves the previous record.
test("a failed write in a both-agents landing leaves the previous record, and names the agent that did not move", async () => {
  const state = new CopilotEnvState();
  state.recordDefaultMode("direct");
  const trace: string[] = [];
  const failing: AgentAdapter = {
    ...probeAdapter("codex", false, trace),
    configureDefault: () => Promise.reject(new Error("disk full")),
  };
  const out = await configureDefaultAgents(
    { codex: "proxy", claude: "proxy", ghToken: "ghu_test" },
    [probeAdapter("claude", false, trace), failing],
  );
  expect({ ...out, trace, recorded: state.readProfileSlot(null).mode }).toEqual({
    codex: "none",
    claude: "proxy",
    failures: ["codex: disk full"],
    failedAgents: ["codex"],
    trace: ["write:claude:proxy"],
    recorded: "direct",
  });
});

// A selection made without a credential runs no request and hands back the fallback pair; stored,
// every re-render would replay it. So a Direct landing with no resolvable credential is refused at
// the owner (resolveDefaultMode, probeDirectWiring) before any write.
test("a Direct landing with no resolvable credential is refused before any write: nothing written, nothing stored", async () => {
  dir = removeDir(dir);
  const homes = isolateAgentHomes("copilot-no-credential-", { mkdirs: true });
  dir = homes.dir;
  // A gh-cli slot whose `gh` is not on PATH resolves to null, never a throw.
  const state = new CopilotEnvState();
  state.setCredential(null, { kind: "gh-cli", ghUser: null });
  const emptyBin = join(dir, "empty-bin");
  mkdirSync(emptyBin, { recursive: true });
  process.env.PATH = emptyBin;
  const direct = await configureDefaultAgents(
    { codex: "direct", claude: "direct" },
    bothAgents(NOOP_CATALOG_DEPS),
  );
  expect(direct.failures.map((f) => f.includes("run `agent auth` first"))).toEqual([true, true]);
  // `auto` is refused the same way: a proxy landing on that credential would serve nothing.
  await expect(
    configureDefaultAgents({ codex: "auto", claude: "auto" }, bothAgents(NOOP_CATALOG_DEPS)),
  ).rejects.toThrow("run `agent auth` first");
  // The re-render gap takes the same refusal: a Direct record whose slot holds no pair.
  state.recordDefaultMode("direct");
  await expect(runAgentConfig(claudeAdapter(), { kind: "configure", mode: "auto" })).rejects
    .toThrow("run `agent auth` first");
  expect({
    codexFile: existsSync(join(homes.codexHome, "config.toml")),
    claudeFile: existsSync(join(homes.claudeHome, "settings.json")),
    pair: state.readProfileDirectPair(null),
  }).toEqual({ codexFile: false, claudeFile: false, pair: {} });
});

// --- the `static-key` scope: WHICH agent's config carries the value -----------------------------

type Shape = "static" | "command";
const SCOPE_CASES: { scope: StaticKeyScope; claude: Shape; codex: Shape }[] = [
  { scope: "none", claude: "command", codex: "command" },
  { scope: "claude", claude: "static", codex: "command" },
  { scope: "codex", claude: "command", codex: "static" },
  { scope: "all", claude: "static", codex: "static" },
];

test("static-key scopes the baked value to the named agent; the other keeps its resolver command", async () => {
  // A proxy wire needs no probe: the daemon's own API key is what a static shape bakes.
  dir = removeDir(dir);
  const homes = isolateAgentHomes("copilot-static-scope-", { mkdirs: true });
  dir = homes.dir;
  storeCredential();
  const apiKey = CopilotApiConfig.forProfile(null).ensureApiKey();
  const record = (v: unknown) => v as Record<string, unknown>;
  for (const c of SCOPE_CASES) {
    new CopilotEnvConfig().setProfile(null, { "static-key": c.scope });
    const out = await configureDefaultAgents(
      { codex: "proxy", claude: "proxy", ghToken: "ghu_test" },
      bothAgents(NOOP_CATALOG_DEPS),
    );
    const settings = record(
      JSON.parse(readFileSync(join(homes.claudeHome, "settings.json"), "utf8")),
    );
    const provider = record(
      record(
        record(parse(readFileSync(join(homes.codexHome, "config.toml"), "utf8")).model_providers)[
          "copilot-env"
        ],
      ),
    );
    expect({
      scope: c.scope,
      failures: out.failures,
      claude: {
        token: record(settings.env)[AUTH_TOKEN_ENV],
        apiKeyHelper: settings.apiKeyHelper,
      },
      codex: {
        authorization: record(provider.http_headers ?? {})["Authorization"],
        authCommand: record(provider.auth ?? {}).command,
      },
    }).toEqual({
      scope: c.scope,
      failures: [],
      claude: c.claude === "static"
        ? { token: apiKey, apiKeyHelper: undefined }
        : { token: undefined, apiKeyHelper: proxyHelperCommand() },
      codex: c.codex === "static"
        ? { authorization: `Bearer ${apiKey}`, authCommand: undefined }
        : { authorization: undefined, authCommand: proxyTokenCommand().command },
    });
  }
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
