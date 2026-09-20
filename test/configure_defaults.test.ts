// The record's store-level semantics are pinned in test/env_state.test.ts.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { type AgentAdapter, directWiring, type ManagedAgentId } from "../src/agents/configure.ts";
import { configureDefaultAgents, runAgentConfig } from "../src/agents/configure_defaults.ts";
import { CLAUDE_PROBE, CliTooOldError } from "../src/agents/live_probe.ts";
import { bothAgents } from "../src/agents/profile_wiring.ts";
import { AUTH_TOKEN_ENV, claudeAdapter, proxyHelperCommand } from "../src/claude/config.ts";
import { type AddArgs, addProfile } from "../src/commands/profile.ts";
import { CopilotApiConfig } from "../src/copilot_api/config.ts";
import type { StaticKeyScope } from "../src/copilot_api/config_registry.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { setIntegrationProbeFetch } from "../src/copilot_api/integration_identity.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import { proxyTokenCommand } from "../src/utils/root.ts";
import { captureAllWrites } from "./helpers/output.ts";
import { runCli } from "./helpers/run.ts";
import { afterEach, beforeEach, expect, removeDir, test } from "./helpers/testing.ts";
import { agentHomeEnv, envSnapshot, isolateAgentHomes, isolateProxyHome } from "./helpers/env.ts";

const restoreEnv = envSnapshot(["PATH"]);
let dir = "";

beforeEach(() => {
  dir = isolateProxyHome("copilot-recordmode-");
});

afterEach(() => {
  restoreEnv();
});

// --- the CLI dispatch hooks, end-to-end (src/cli.ts) -------------------------------
// A forced-proxy wire needs no probe or network, so the children run offline on a stored token.

function childCliEnv(codexHome: string, claudeHome: string): Record<string, string | undefined> {
  return {
    ...process.env,
    CONSOLA_LEVEL: "5",
    ...agentHomeEnv(dir, { codexHome, claudeHome }),
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

// Profiles are atomic units, the default included: a mode flag on a fresh default (no recorded
// mode) is the first landing and wires BOTH agents, recording the mode they share.
test("`agent init --proxy` on a fresh default lands both agents and records the mode they share", () => {
  storeCredential();
  const codexHome = join(dir, ".codex");
  const claudeHome = join(dir, ".claude");
  const run = runCli(["init", "--proxy"], { env: childCliEnv(codexHome, claudeHome) });
  expect(run.exitCode).toBe(0);
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
    bothAgents(),
  );
  expect(single.failedAgents).toEqual(["codex"]);
  expect(existsSync(join(homes.codexHome, "config.toml"))).toBe(false);
  expect(state.readProfileSlot(null).mode).toBe("direct");
  const both = await configureDefaultAgents(
    { codex: "proxy", claude: "proxy", ghToken: "ghu_test" },
    bothAgents(),
  );
  expect(both.failures).toEqual([]);
  expect(existsSync(join(homes.codexHome, "config.toml"))).toBe(true);
  expect(state.readProfileSlot(null).mode).toBe("proxy");
});

// --- `agent init` (auto): one probe pass decides one mode for both agents ------------------------

/** One ordered trace of what the landing did: `probe:<id>:<credential>` events (the credential the
 *  throwaway config authenticates with: `command`, or `static:<token>`), then `write:<id>:<mode>`. */
function probeAdapter(id: ManagedAgentId, verdict: boolean, trace: string[]): AgentAdapter {
  return {
    id,
    label: id,
    check: () => {},
    detectDirect: (_direct, _ghToken, credential) => {
      trace.push(
        `probe:${id}:${credential.kind === "static" ? `static:${credential.token}` : "command"}`,
      );
      return Promise.resolve(verdict);
    },
    resolveDirectWiring: () =>
      Promise.resolve(directWiring("copilot-developer-cli", "https://api.githubcopilot.com")),
    configureProfile(_profile, write) {
      trace.push(`write:${id}:${write.mode}`);
      return Promise.resolve();
    },
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
          "probe:claude:command",
          "probe:codex:command",
          `write:claude:${c.expected}`,
          `write:codex:${c.expected}`,
        ],
        recorded: c.expected,
      });
  }
});

// The record and the Direct pair are what both agents share, so they land only once both writes
// succeeded (commitDefaultWiring, AFTER the writes; a named profile stores its pair before them):
// a move one agent did not make leaves the previous record and stores no pair.
test("a failed write in a both-agents landing leaves the previous record and no pair, and names the agent that did not move", async () => {
  const state = new CopilotEnvState();
  state.recordDefaultMode("proxy");
  const trace: string[] = [];
  const failing: AgentAdapter = {
    ...probeAdapter("codex", true, trace),
    configureProfile: () => Promise.reject(new Error("disk full")),
  };
  const out = await configureDefaultAgents(
    { codex: "direct", claude: "direct", ghToken: "ghu_test" },
    [probeAdapter("claude", true, trace), failing],
  );
  expect({
    ...out,
    trace,
    recorded: state.readProfileSlot(null).mode,
    pair: state.readProfileDirectPair(null),
  }).toEqual({
    codex: "none",
    claude: "direct",
    failures: ["codex: disk full"],
    failedAgents: ["codex"],
    trace: ["write:claude:direct"],
    recorded: "proxy",
    pair: {},
  });
});

// A selection made without a credential runs no request and hands back the fallback pair; stored,
// every re-render would replay it. So a Direct landing with no resolvable credential is refused at
// the owner (resolveDefaultMode, directWiringFor) before any write.
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
    bothAgents(),
  );
  expect(direct.failures.map((f) => f.includes("run `agent auth` first"))).toEqual([
    true,
    true,
  ]);
  // `auto` is refused the same way: a proxy landing on that credential would serve nothing.
  await expect(
    configureDefaultAgents({ codex: "auto", claude: "auto" }, bothAgents()),
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
      bothAgents(),
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

// The gap this pins: a single-agent re-render on a fresh machine used to write proxy wiring that
// could serve nothing, and only the both-agents landing asked for a login (and not for `--proxy`).
// --- the probe every run: the verdict against the record ----------------------------------------

/** Both fake agents answering the one verdict, tracing into `trace`. */
function probePair(verdict: boolean, trace: string[]): AgentAdapter[] {
  return [probeAdapter("claude", verdict, trace), probeAdapter("codex", verdict, trace)];
}

/** The default's `add` on fake adapters: what the landing said (stderr), did (trace), recorded. */
async function initOn(
  args: AddArgs,
  verdict: boolean,
): Promise<{ said: string; trace: string[]; recorded: string | null }> {
  const trace: string[] = [];
  const said = await captureAllWrites(() => addProfile(null, args, probePair(verdict, trace)));
  return { said, trace, recorded: new CopilotEnvState().readProfileSlot(null).mode };
}

/** The default's probe runs against the resolver command; a named profile's against its token. */
const PROBED = ["probe:claude:command", "probe:codex:command"];
const PROBED_AS = (
  token: string,
) => [`probe:claude:static:${token}`, `probe:codex:static:${token}`];
const WROTE = (mode: string) => [`write:claude:${mode}`, `write:codex:${mode}`];

test("`agent init` probes every run: an agreeing verdict re-wires, a differing one keeps the record headless (with the hint) and moves with --yes; no flag is --auto", async () => {
  const homes = isolateAgentHomes("copilot-init-probe-", { mkdirs: true });
  dir = homes.dir;
  storeCredential();
  const hadTty = process.stdin.isTTY;
  process.stdin.isTTY = false;
  try {
    // A fresh default records the verdict, no question.
    const fresh = await initOn({ mode: "unflagged" }, true);
    expect([fresh.trace, fresh.recorded]).toEqual([[...PROBED, ...WROTE("direct")], "direct"]);
    expect(fresh.said).not.toContain("The probe says");
    // Recorded direct, probed direct: the probe still ran, then a plain re-wire.
    const agree = await initOn({ mode: "auto" }, true);
    expect([agree.trace, agree.said.includes("The probe says")]).toEqual([fresh.trace, false]);
    // Recorded direct, probed proxy, no terminal: the record stands and the hint names the flag.
    const kept = await initOn({ mode: "unflagged" }, false);
    expect([kept.trace, kept.recorded]).toEqual([[...PROBED, ...WROTE("direct")], "direct"]);
    expect(kept.said).toContain("The probe says proxy; the default profile records direct.");
    expect(kept.said).toContain(
      "Keeping direct (not a terminal); pass --proxy to switch, or --yes to follow the probe.",
    );
    // --auto is the same path as no flag.
    const keptAuto = await initOn({ mode: "auto" }, false);
    expect([keptAuto.trace, keptAuto.recorded]).toEqual([kept.trace, "direct"]);
    expect(keptAuto.said).toContain("Keeping direct (not a terminal)");
    // --yes follows the probe: both agents move, and the record with them.
    const moved = await initOn({ mode: "unflagged", yes: true }, false);
    expect([moved.trace, moved.recorded]).toEqual([[...PROBED, ...WROTE("proxy")], "proxy"]);
    expect(moved.said).not.toContain("Keeping");
  } finally {
    process.stdin.isTTY = hadTty;
  }
});

test("`agent profile <name> add --auto` probes under the profile's own credential and asks the same way; with no flag a named profile never probes, and with no credential there is nothing to probe with", async () => {
  const homes = isolateAgentHomes("copilot-named-probe-", { mkdirs: true });
  dir = homes.dir;
  // The Direct selection under the profile's token, offline: every identity accepted.
  setIntegrationProbeFetch(() =>
    Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }))
  );
  const hadTty = process.stdin.isTTY;
  process.stdin.isTTY = false;
  try {
    const work = parseProfileName("work");
    const state = new CopilotEnvState();
    const credential = { kind: "stored", provider: "gh-token", token: "ghu_work" } as const;
    // Fresh: --no-auth leaves no credential to probe with, and a script cannot log in.
    await expect(addProfile(work, { mode: "auto", noAuth: true }, probePair(true, []))).rejects
      .toThrow("no credential to probe with; pass --direct or --proxy, or run without --no-auth");
    await expect(addProfile(work, { mode: "auto" }, probePair(true, []))).rejects.toThrow(
      "not a terminal - pass --direct or --proxy with --no-auth to record the mode alone",
    );
    expect(state.profileSlotStatus(work).exists).toBe(false);
    // A proxy profile with a credential, probed direct: the probe authenticates as THIS profile
    // (its token baked into the throwaway config, never the default's resolver); headless keeps
    // proxy, --yes moves it.
    state.commitProfile(work, { credential, mode: "proxy" });
    const trace: string[] = [];
    const kept = await captureAllWrites(() =>
      addProfile(work, { mode: "auto" }, probePair(true, trace))
    );
    expect([trace, state.readProfileSlot(work).mode]).toEqual([
      [...PROBED_AS("ghu_work"), ...WROTE("proxy")],
      "proxy",
    ]);
    expect(kept).toContain("The probe says direct; profile 'work' records proxy.");
    expect(kept).toContain("Keeping proxy (not a terminal); pass --direct to switch");
    trace.length = 0;
    const moved = await captureAllWrites(() =>
      addProfile(work, { mode: "auto", yes: true }, probePair(true, trace))
    );
    expect(trace).toEqual([...PROBED_AS("ghu_work"), ...WROTE("direct")]);
    expect(state.readProfileSlot(work)).toEqual({ kind: "complete", credential, mode: "direct" });
    expect(moved).toContain("profile 'work' is ready (switched from proxy).");
    // No flag never probes a named profile: the recorded mode is re-wired as it is.
    trace.length = 0;
    await captureAllWrites(() => addProfile(work, { mode: "unflagged" }, probePair(false, trace)));
    expect(trace).toEqual(WROTE("direct"));
  } finally {
    process.stdin.isTTY = hadTty;
    setIntegrationProbeFetch(null);
  }
});

test("a probe that throws (an outdated CLI) aborts the landing before any write: nothing written, the record unchanged", async () => {
  storeCredential();
  const state = new CopilotEnvState();
  state.recordDefaultMode("proxy");
  const trace: string[] = [];
  const tooOld: AgentAdapter = {
    ...probeAdapter("claude", true, trace),
    detectDirect: () => Promise.reject(new CliTooOldError(CLAUDE_PROBE, "2.1.181", "2.1.251")),
  };
  await expect(configureDefaultAgents(
    { codex: "auto", claude: "auto", ghToken: "ghu_test" },
    [tooOld, probeAdapter("codex", true, trace)],
  )).rejects.toThrow("claude is too old for Copilot Direct");
  expect([trace, state.readProfileSlot(null).mode]).toEqual([[], "proxy"]);
});

test("a wiring command with no credential refuses headless and writes nothing", () => {
  const codexHome = join(dir, ".codex");
  const claudeHome = join(dir, ".claude");
  const env = childCliEnv(codexHome, claudeHome);
  // The re-renders reach the login gate; `init` refuses before its mode lands and names the flag
  // that records the mode alone.
  for (
    const [argv, refusal] of [
      [["profile", "sync", "--claude"], "Not authenticated yet"],
      [["profile", "sync", "--codex"], "Not authenticated yet"],
      [["init", "--proxy"], "pass --no-auth to record the mode alone"],
    ] as const
  ) {
    const run = runCli([...argv], { env });
    expect(run.exitCode, argv.join(" ")).toBe(1);
    expect(run.stderr, argv.join(" ")).toContain(refusal);
  }
  expect(existsSync(join(claudeHome, "settings.json"))).toBe(false);
  expect(existsSync(join(codexHome, "config.toml"))).toBe(false);
  expect(recordedMode()).toBeUndefined();
});
