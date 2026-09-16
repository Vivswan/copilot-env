// The `copilot-host` key end to end: what the writers bake, what the inspectors recognise, what the
// daemon spawn receives, and how a profile slot caches the resolved host. The auto rule itself is
// pinned in integration_identity.test.ts, the survey render in auth.test.ts, the shim's rewrite in
// copilot_host_preload.test.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { runAgentConfig } from "../src/agents/configure.ts";
import { resolveAndPersistDirectWiring } from "../src/agents/profile_wiring.ts";
import {
  bakedClaudeDirectIntegrationId,
  claudeAdapter,
  configureClaudeConfig,
} from "../src/claude/config.ts";
import { NOOP_CATALOG_DEPS } from "../src/codex/catalog.ts";
import { codexAdapter, inspectCodexWiring, probeDirectWiring } from "../src/codex/config.ts";
import { runConfig } from "../src/commands/config.ts";
import { Credential } from "../src/copilot_api/credential.ts";
import { configKeyDef, CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { CopilotEnvState, expectedDirectHost } from "../src/copilot_api/env_state.ts";
import {
  COPILOT_CLI_INTEGRATION_ID,
  COPILOT_SANDBOX_INTEGRATION_ID,
  DEFAULT_COPILOT_API_BASE,
  INTEGRATION_ID_HEADER,
  resetIntegrationIdentityCache,
  setIntegrationProbeFetch,
  VSCODE_CHAT_INTEGRATION_ID,
} from "../src/copilot_api/integration_identity.ts";
import { resolveLaunchCredential } from "../src/copilot_api/launch.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import { checkClaude } from "../src/health/checks_agents.ts";
import { afterEach, expect, removeDir, test } from "./helpers/testing.ts";
import { codexConfigToml, envSnapshot, isolateAgentHomes } from "./helpers.ts";

const restoreEnv = envSnapshot();
let dir = "";

afterEach(() => {
  restoreEnv();
  setIntegrationProbeFetch(null);
  dir = removeDir(dir);
});

const ENTERPRISE = "https://api.enterprise.githubcopilot.com";
const GHE = "https://copilot-api.ghe.example";

/** Every /models answers `generic` on the generic host and 200 elsewhere; the account lookup names
 *  the enterprise host. `seen` records each probe's host and identity header. */
function stubHosts(
  generic: number,
  seen: { host: string; id: string | null }[] = [],
): void {
  setIntegrationProbeFetch((input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/copilot_internal/user")) {
      return Promise.resolve(
        new Response(JSON.stringify({ endpoints: { api: ENTERPRISE } }), { status: 200 }),
      );
    }
    seen.push({
      host: new URL(url).origin,
      id: new Headers(init?.headers).get(INTEGRATION_ID_HEADER),
    });
    const status = new URL(url).origin === DEFAULT_COPILOT_API_BASE ? generic : 200;
    return Promise.resolve(
      new Response(status === 200 ? JSON.stringify({ data: [] }) : "forbidden", { status }),
    );
  });
}

function codexBaseUrl(codexHome: string): unknown {
  const doc = parse(readFileSync(join(codexHome, "config.toml"), "utf8"));
  const providers = doc.model_providers as Record<string, Record<string, unknown>>;
  return providers["copilot-env"]?.base_url;
}

function claudeBaseUrl(claudeHome: string): unknown {
  const doc = JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8"));
  return (doc.env as Record<string, unknown>).ANTHROPIC_BASE_URL;
}

test("agent config: copilot-host takes `auto` or an https origin and refuses anything else", () => {
  dir = isolateAgentHomes("copilot-host-config-").dir;
  const def = configKeyDef("copilot-host");
  expect(def?.parse("AUTO")).toBe("auto");
  // Canonical origin: scheme and host lowercased, the trailing slash dropped.
  expect(def?.parse("HTTPS://API.Business.githubcopilot.com/")).toBe(
    "https://api.business.githubcopilot.com",
  );
  for (const bad of ["http://api.githubcopilot.com", "api.githubcopilot.com", "", "ftp://x"]) {
    expect(() => runConfig({ set: ["copilot-host", bad] })).toThrow(
      /expected `auto` or an https:\/\/ origin/,
    );
  }
  expect(() => runConfig({ set: ["copilot-host", `${ENTERPRISE}/models`] })).toThrow(
    /without a path or query/,
  );
  // Every loopback spelling, not three: the whole 127/8 block, IPv4-mapped ::1, a trailing dot.
  for (
    const loopback of [
      "https://localhost:8443",
      "https://127.0.0.2",
      "https://localhost.",
      "https://[::ffff:127.0.0.1]",
      "https://[::1]:8443",
    ]
  ) {
    expect(() => runConfig({ set: ["copilot-host", loopback] })).toThrow(/not loopback/);
  }
  expect(new CopilotEnvConfig().copilotHost()).toBeNull();
  runConfig({ set: ["copilot-host", GHE] });
  expect(new CopilotEnvConfig().copilotHost()).toBe(GHE);
  runConfig({ set: ["copilot-host", "auto"] });
  expect(new CopilotEnvConfig().copilotHost()).toBeNull();
});

test("a Direct wiring bakes the copilot-host into both agents' base URLs; detection keys on our markers, not the host", async () => {
  const homes = isolateAgentHomes("copilot-host-wiring-");
  dir = homes.dir;
  const seen: { host: string; id: string | null }[] = [];
  stubHosts(403, seen);
  const wire = async (): Promise<void> => {
    for (const adapter of [codexAdapter(NOOP_CATALOG_DEPS), claudeAdapter()]) {
      await runAgentConfig(adapter, { kind: "configure", mode: "direct" }, { ghToken: "ghu_x" });
    }
  };

  // A literal: nothing probed, both configs carry it.
  new CopilotEnvConfig().set({ copilotHost: GHE });
  await wire();
  expect(seen).toEqual([]);
  expect(codexBaseUrl(homes.codexHome)).toBe(GHE);
  expect(claudeBaseUrl(homes.claudeHome)).toBe(GHE);
  // Recognised as Direct by our markers and the https shape, with the literal standing OR gone: a
  // past host never orphans a wiring; the baked host reads back so a rewire can move it.
  const codexToml = readFileSync(join(homes.codexHome, "config.toml"), "utf8");
  const claudeJson = readFileSync(join(homes.claudeHome, "settings.json"), "utf8");
  for (const literal of [GHE, null]) {
    new CopilotEnvConfig().set({ copilotHost: literal });
    expect(inspectCodexWiring(codexToml, null, 4141, false).providerMode).toBe("direct");
    expect(bakedClaudeDirectIntegrationId({ kind: "text", text: claudeJson }, 4141)).toEqual({
      kind: "direct",
      integrationId: null,
      baseUrl: GHE,
    });
  }

  // `auto` with the generic host blocked: one probe under the identity the wiring bakes (no header,
  // the codex identity), then the account's host lands in both configs and reads as Direct.
  await wire();
  expect(seen).toEqual([{ host: DEFAULT_COPILOT_API_BASE, id: null }]);
  expect(codexBaseUrl(homes.codexHome)).toBe(ENTERPRISE);
  expect(claudeBaseUrl(homes.claudeHome)).toBe(ENTERPRISE);
  expect(
    inspectCodexWiring(
      readFileSync(join(homes.codexHome, "config.toml"), "utf8"),
      null,
      4141,
      false,
    )
      .providerMode,
  ).toBe("direct");
  // Only the shape gates: an http base that is not the proxy, an https base with a path (some other
  // API), or an https loopback the validator also refuses, is the inspector's UNWIRED proxy.
  for (
    const baseUrl of ["http://elsewhere.example", "https://api.openai.com/v1", "https://127.0.0.2"]
  ) {
    const foreign = inspectCodexWiring(codexConfigToml({ baseUrl }), null, 4141, false);
    expect([foreign.providerMode, foreign.providerWired]).toEqual(["proxy", false]);
  }

  // `auto` with the generic host serving: today's bytes.
  seen.length = 0;
  stubHosts(200, seen);
  await wire();
  expect(codexBaseUrl(homes.codexHome)).toBe(DEFAULT_COPILOT_API_BASE);
  expect(claudeBaseUrl(homes.claudeHome)).toBe(DEFAULT_COPILOT_API_BASE);
});

test("a profile slot caches the resolved host beside its identity: replayed offline, re-probed under a new pin or a dropped literal", async () => {
  dir = isolateAgentHomes("copilot-host-slot-").dir;
  const state = new CopilotEnvState();
  new Credential(state).store("gh-token", "ghp_x");
  const seen: { host: string; id: string | null }[] = [];
  // The CLI identity is accepted everywhere; the default (no header) and the sandbox are rejected
  // on the generic host (sent to the account's host, which accepts them) and on the GHE literal.
  setIntegrationProbeFetch((input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/copilot_internal/user")) {
      return Promise.resolve(
        new Response(JSON.stringify({ endpoints: { api: ENTERPRISE } }), { status: 200 }),
      );
    }
    const id = new Headers(init?.headers).get(INTEGRATION_ID_HEADER);
    seen.push({ host: new URL(url).origin, id });
    const generic = new URL(url).origin === DEFAULT_COPILOT_API_BASE;
    const enterprise = new URL(url).origin === ENTERPRISE;
    if (id === COPILOT_CLI_INTEGRATION_ID || enterprise) {
      return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    }
    return Promise.resolve(
      generic
        ? new Response("forbidden", { status: 403 })
        : new Response("Personal Access Tokens are not supported", { status: 400 }),
    );
  });

  // Under a literal the identity is probed (a PAT) ON THE LITERAL and the pair is cached as the
  // literal's: it replays under that literal alone, not under `auto`.
  new CopilotEnvConfig().set({ copilotHost: GHE });
  expect(await resolveAndPersistDirectWiring(null)).toEqual({
    directIntegrationId: COPILOT_CLI_INTEGRATION_ID,
    directBaseUrl: GHE,
  });
  expect(state.slotIdentityForDisplay(null)).toBe(COPILOT_CLI_INTEGRATION_ID);
  expect(state.readProfileCopilotHost(null, null, GHE)).toBe(GHE);
  expect(state.readProfileCopilotHost(null, null, null)).toBeNull();
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((s) => s.host === GHE)).toBe(true);
  seen.length = 0;
  await resolveAndPersistDirectWiring(null);
  expect(seen).toEqual([]);

  // Dropping the literal re-probes BOTH (an identity accepted on the literal says nothing about
  // the generic host), persists the `auto` pair, and replays it offline from then on.
  new CopilotEnvConfig().del("copilotHost");
  seen.length = 0;
  expect(await resolveAndPersistDirectWiring(null)).toEqual({
    directIntegrationId: COPILOT_CLI_INTEGRATION_ID,
    directBaseUrl: DEFAULT_COPILOT_API_BASE,
  });
  // One request: the identity probe under the CLI id, whose memoized verdict the host rule reads too.
  expect(seen).toEqual([{ host: DEFAULT_COPILOT_API_BASE, id: COPILOT_CLI_INTEGRATION_ID }]);
  expect(state.readProfileCopilotHost(null, null, null)).toBe(DEFAULT_COPILOT_API_BASE);
  seen.length = 0;
  await resolveAndPersistDirectWiring(null);
  expect(seen).toEqual([]);

  // A pin naming another identity invalidates the cached host: it was resolved under the CLI id,
  // and under the sandbox id the generic host is blocked.
  new CopilotEnvConfig().set({ integrationId: "copilot-developer-sandbox" });
  expect(await resolveAndPersistDirectWiring(null)).toEqual({
    directIntegrationId: "copilot-developer-sandbox",
    directBaseUrl: ENTERPRISE,
  });
  expect(seen).toEqual([{ host: DEFAULT_COPILOT_API_BASE, id: "copilot-developer-sandbox" }]);
  // The pin is configuration: the slot keeps its own verdict, and the pair now cached is the pin's
  // (readable under it, not under the verdict). `--identity auto` then finds a STALE pair and
  // re-probes both identity and host (the memo answers them here, so no request is counted).
  expect(state.slotIdentityForDisplay(null)).toBe(COPILOT_CLI_INTEGRATION_ID);
  expect(state.readProfileCopilotHost(null, "copilot-developer-sandbox", null)).toBe(ENTERPRISE);
  expect(state.readProfileCopilotHost(null, null, null)).toBeNull();
  new CopilotEnvConfig().set({ integrationId: "auto" });
  expect(await resolveAndPersistDirectWiring(null)).toEqual({
    directIntegrationId: COPILOT_CLI_INTEGRATION_ID,
    directBaseUrl: DEFAULT_COPILOT_API_BASE,
  });
  // (The slot cache read null above; the process memo answered the CLI host probe, same token
  // and identity as the dropped-literal probe, so no request is counted here.)
  expect(state.readProfileCopilotHost(null, null, null)).toBe(DEFAULT_COPILOT_API_BASE);

  // A credential change clears both halves.
  new Credential(state).store("gh-token", "ghp_rotated");
  expect(state.slotIdentityForDisplay(null)).toBeNull();
  expect(state.readProfileCopilotHost(null, null, null)).toBeNull();

  // A fresh slot under a pin caches the host resolved under the pin WITHOUT writing the pin as its
  // verdict, so the launcher hot path replays offline and `--identity auto` still probes afresh.
  new CopilotEnvConfig().set({ integrationId: COPILOT_CLI_INTEGRATION_ID });
  seen.length = 0;
  expect(await resolveAndPersistDirectWiring(null)).toEqual({
    directIntegrationId: COPILOT_CLI_INTEGRATION_ID,
    directBaseUrl: DEFAULT_COPILOT_API_BASE,
  });
  expect(seen).toEqual([{ host: DEFAULT_COPILOT_API_BASE, id: COPILOT_CLI_INTEGRATION_ID }]);
  expect(state.slotIdentityForDisplay(null)).toBeNull();
  expect(state.readProfileCopilotHost(null, COPILOT_CLI_INTEGRATION_ID, null)).toBe(
    DEFAULT_COPILOT_API_BASE,
  );
  seen.length = 0;
  await resolveAndPersistDirectWiring(null);
  expect(seen).toEqual([]);
});

test("a wiring baked for one host stays ours after the copilot-host literal changes: the rewire moves it, health notes the move", async () => {
  const homes = isolateAgentHomes("copilot-host-move-");
  dir = homes.dir;
  const work = parseProfileName("work");
  new CopilotEnvState().commitProfile(work, {
    credential: { kind: "stored", provider: "gh-token", token: "ghu_work" },
    mode: "direct",
  });
  const other = "https://copilot-api.other.example";
  configureClaudeConfig(homes.claudeHome, {
    mode: "direct",
    profile: work,
    directIntegrationId: null,
    directBaseUrl: GHE,
    credential: { kind: "command" },
  });
  new CopilotEnvConfig().set({ copilotHost: other });
  // The named-profile guard refuses only a FOREIGN file; ours, on a past host, is rewired.
  configureClaudeConfig(homes.claudeHome, {
    mode: "direct",
    profile: work,
    directIntegrationId: null,
    directBaseUrl: other,
    credential: { kind: "command" },
  });
  const settings = JSON.parse(
    readFileSync(join(homes.claudeHome, "settings-work.json"), "utf8"),
  ) as { env: Record<string, string> };
  expect(settings.env.ANTHROPIC_BASE_URL).toBe(other);
  // The expected host is the one rule (literal, else the slot's cached host); health renders the
  // move beside a config still on the old host and keeps it green.
  expect(expectedDirectHost(work)).toBe(other);
  const verdict = checkClaude({
    home: homes.claudeHome,
    settingsPath: join(homes.claudeHome, "settings.json"),
    settingsExists: true,
    wired: true,
    credential: "command",
    helperPath: join(homes.claudeHome, "copilot-token.sh"),
    baseUrl: GHE,
    baseUrlMatches: false,
    providerMode: "direct",
    otherReason: null,
    directAuth: { command: null, authenticated: false },
    directUsesToken: true,
    provider: "gh-token",
    expectedDirectHost: other,
  });
  expect(verdict.status).toBe("ok");
  expect(verdict.detail).toContain(
    `ANTHROPIC_BASE_URL → ${GHE} (the next rewire moves it to ${other})`,
  );
});

test("a literal change re-probes a cached identity: a verdict from one host is never baked on another", async () => {
  dir = isolateAgentHomes("copilot-host-literal-change-").dir;
  const state = new CopilotEnvState();
  new Credential(state).store("gh-token", "github_pat_x");
  const seen: { host: string; id: string | null }[] = [];
  // The generic host accepts the sandbox id alone; the literal accepts the CLI id alone.
  setIntegrationProbeFetch((input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/copilot_internal/user")) {
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    }
    const id = new Headers(init?.headers).get(INTEGRATION_ID_HEADER);
    const origin = new URL(url).origin;
    seen.push({ host: origin, id });
    const accepted = origin === GHE
      ? id === COPILOT_CLI_INTEGRATION_ID
      : id === "copilot-developer-sandbox";
    return Promise.resolve(
      accepted
        ? new Response(JSON.stringify({ data: [] }), { status: 200 })
        : new Response("Personal Access Tokens are not supported", { status: 400 }),
    );
  });
  expect(await resolveAndPersistDirectWiring(null)).toEqual({
    directIntegrationId: "copilot-developer-sandbox",
    directBaseUrl: DEFAULT_COPILOT_API_BASE,
  });
  // The literal changes the host in use: the cached (generic, sandbox) pair is not this host's, so
  // the identity is probed again on the literal, where sandbox 400s and the CLI id is accepted.
  new CopilotEnvConfig().set({ copilotHost: GHE });
  seen.length = 0;
  expect(await resolveAndPersistDirectWiring(null)).toEqual({
    directIntegrationId: COPILOT_CLI_INTEGRATION_ID,
    directBaseUrl: GHE,
  });
  expect(seen.every((s) => s.host === GHE)).toBe(true);
  expect(seen.some((s) => s.id === COPILOT_CLI_INTEGRATION_ID)).toBe(true);
});

test("the replay rule, one table: a cached identity is baked as a valid pair or once accepted on the host in use, never on trust", async () => {
  dir = isolateAgentHomes("copilot-host-replay-rule-").dir;
  const state = new CopilotEnvState();
  const CACHED = COPILOT_SANDBOX_INTEGRATION_ID;
  const OTHER = COPILOT_CLI_INTEGRATION_ID;
  const hostInUse = {
    "auto-generic": DEFAULT_COPILOT_API_BASE,
    "auto-moved": ENTERPRISE,
    literal: GHE,
  };
  type Host = keyof typeof hostInUse;
  type Cache = "none" | "hostless" | "stale" | "valid";
  type Row = {
    cell: string;
    identity: string;
    host: string;
    probed: boolean;
    /** The persisted half of the rule: the slot's identity and pair standing after the call. */
    slot: { identity: string | null; pair: "none" | "stale" | "valid" };
  };
  const table: Row[] = [];
  const expected: typeof table = [];
  let n = 0;
  for (const cache of ["none", "hostless", "stale", "valid"] as Cache[]) {
    for (const host of Object.keys(hostInUse) as Host[]) {
      for (const accepts of [true, false]) {
        n += 1;
        const cell = `${cache} / ${host} / host ${accepts ? "accepts" : "400s"} the cached id`;
        const token = `ghp_cell${n}`;
        resetIntegrationIdentityCache();
        new Credential(state).store("gh-token", token);
        const credential = { kind: "stored", provider: "gh-token", token } as const;
        if (cache !== "none") {
          state.setProfileIntegrationIdentity(
            null,
            CACHED,
            credential,
            cache === "hostless" ? undefined : cache === "stale"
              // A pair for another identity never reads back for CACHED, whatever the host.
              ? { host: hostInUse[host], identity: VSCODE_CHAT_INTEGRATION_ID, source: "auto" }
              : {
                host: hostInUse[host],
                identity: CACHED,
                source: host === "literal" ? "literal" : "auto",
              },
          );
        }
        if (host === "literal") new CopilotEnvConfig().set({ copilotHost: GHE });
        else new CopilotEnvConfig().del("copilotHost");
        const seen: string[] = [];
        // OTHER is accepted everywhere; the default (no header) is rejected everywhere; CACHED
        // per `accepts`. `auto-moved`: the generic host is blocked (403) for every identity.
        setIntegrationProbeFetch((input, init) => {
          const url = typeof input === "string"
            ? input
            : input instanceof URL
            ? input.href
            : input.url;
          // Every request counts, the account lookup included: a valid pair makes none, and a
          // literal makes none off the literal (the lookup lives on api.github.com).
          const origin = new URL(url).origin;
          seen.push(origin);
          if (url.includes("/copilot_internal/user")) {
            return Promise.resolve(
              new Response(JSON.stringify({ endpoints: { api: ENTERPRISE } }), { status: 200 }),
            );
          }
          if (host === "auto-moved" && origin === DEFAULT_COPILOT_API_BASE) {
            return Promise.resolve(new Response("forbidden", { status: 403 }));
          }
          const id = new Headers(init?.headers).get(INTEGRATION_ID_HEADER);
          return Promise.resolve(
            id === OTHER || (id === CACHED && accepts)
              ? new Response(JSON.stringify({ data: [] }), { status: 200 })
              : new Response("Personal Access Tokens are not supported", { status: 400 }),
          );
        });
        const result = await resolveAndPersistDirectWiring(null);
        const literal = host === "literal" ? GHE : null;
        const identity = cache === "valid" ? CACHED : cache !== "none" && accepts ? CACHED : OTHER;
        table.push({
          cell,
          identity: result.directIntegrationId ?? "codex",
          host: result.directBaseUrl,
          probed: seen.length > 0,
          slot: {
            identity: state.slotIdentityForDisplay(null),
            pair: state.readProfileCopilotHostCache(null, null, literal).kind,
          },
        });
        expected.push({
          cell,
          // A valid pair replays; anything else selects on the host in use, the cached id first.
          identity,
          host: hostInUse[host],
          probed: cache !== "valid",
          // The accepted identity replaces the slot's, and its pair is written for the host in use,
          // so the next call replays it: the persisted half of the rule.
          slot: { identity, pair: "valid" },
        });
        // Under a literal nothing reaches any other host.
        if (host === "literal") expect(seen.every((o) => o === GHE)).toBe(true);
      }
    }
  }
  expect(table).toEqual(expected);
});

test("a preferred identity the host rejects never returns through the transient fallback", async () => {
  dir = isolateAgentHomes("copilot-host-preferred-fallback-").dir;
  // The literal 400s the cached sandbox id and 503s every other candidate: nothing is accepted, the
  // run is inconclusive, and the fallback is the built-in default, not the rejected preference.
  new CopilotEnvConfig().set({ copilotHost: GHE });
  setIntegrationProbeFetch((_input, init) => {
    const id = new Headers(init?.headers).get(INTEGRATION_ID_HEADER);
    return Promise.resolve(
      id === COPILOT_SANDBOX_INTEGRATION_ID
        ? new Response("Personal Access Tokens are not supported", { status: 400 })
        : new Response("upstream", { status: 503 }),
    );
  });
  expect(await probeDirectWiring(null, "github_pat_z", COPILOT_SANDBOX_INTEGRATION_ID)).toEqual({
    directIntegrationId: null,
    directBaseUrl: GHE,
  });
});

test("probeDirectWiring: under auto, a PAT moved off a blocked generic host is probed again on the host that serves it", async () => {
  dir = isolateAgentHomes("copilot-host-reprobe-").dir;
  const seen: { host: string; id: string | null }[] = [];
  // The generic host is blocked for every identity (403 -> inconclusive, so the identity probe
  // keeps its default); the account's host accepts the CLI id alone.
  setIntegrationProbeFetch((input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/copilot_internal/user")) {
      return Promise.resolve(
        new Response(JSON.stringify({ endpoints: { api: ENTERPRISE } }), { status: 200 }),
      );
    }
    const id = new Headers(init?.headers).get(INTEGRATION_ID_HEADER);
    seen.push({ host: new URL(url).origin, id });
    if (new URL(url).origin === DEFAULT_COPILOT_API_BASE) {
      return Promise.resolve(new Response("forbidden", { status: 403 }));
    }
    return Promise.resolve(
      id === COPILOT_CLI_INTEGRATION_ID
        ? new Response(JSON.stringify({ data: [] }), { status: 200 })
        : new Response("Personal Access Tokens are not supported", { status: 400 }),
    );
  });
  expect(await probeDirectWiring(null, "github_pat_x")).toEqual({
    directIntegrationId: COPILOT_CLI_INTEGRATION_ID,
    directBaseUrl: ENTERPRISE,
  });
  // Without the second pass the default identity (no header) would be baked for a host that 400s it.
  expect(seen.filter((s) => s.host === ENTERPRISE).map((s) => s.id)).toEqual([
    null,
    COPILOT_CLI_INTEGRATION_ID,
  ]);
  // A literal skips the HOST probe only: the identity is probed on the literal host, and nothing
  // reaches the generic host (whose 403 would leave the probe inconclusive, baking the default).
  new CopilotEnvConfig().set({ copilotHost: GHE });
  seen.length = 0;
  expect(await probeDirectWiring(null, "github_pat_y")).toEqual({
    directIntegrationId: COPILOT_CLI_INTEGRATION_ID,
    directBaseUrl: GHE,
  });
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((s) => s.host === GHE)).toBe(true);
  new CopilotEnvConfig().del("copilotHost");
  // A replayed slot verdict was probed on the generic host too: it is re-checked the same way (the
  // process memo answers the second pass here, so no request is counted).
  expect(
    await probeDirectWiring(null, "github_pat_x", "copilot-developer-sandbox"),
  ).toEqual({ directIntegrationId: COPILOT_CLI_INTEGRATION_ID, directBaseUrl: ENTERPRISE });
});

test("a daemon launch resolves its identity and host as one pair: re-selected where auto moves, judged under vscode-chat without passthrough, unpinned without a credential", async () => {
  dir = isolateAgentHomes("copilot-host-daemon-").dir;
  const state = new CopilotEnvState();
  const seen: { host: string; id: string | null }[] = [];
  const launch = () =>
    resolveLaunchCredential(null, new CopilotEnvConfig(), {
      interactiveLogin: () => Promise.reject(new Error("no login in this test")),
      isTTY: false,
    });
  // No credential: nothing to probe with, so the daemon is not pinned (GitHub's login answer stands).
  expect(await launch()).toEqual({ credential: { kind: "none" }, copilotHost: null });
  // A PAT with the generic host blocked: identity and host are one pair, selected again where the
  // account is served, so the daemon sends the id THAT host accepts.
  new Credential(state).store("gh-token", "github_pat_x");
  setIntegrationProbeFetch((input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/copilot_internal/user")) {
      return Promise.resolve(
        new Response(JSON.stringify({ endpoints: { api: ENTERPRISE } }), { status: 200 }),
      );
    }
    const id = new Headers(init?.headers).get(INTEGRATION_ID_HEADER);
    seen.push({ host: new URL(url).origin, id });
    if (new URL(url).origin === DEFAULT_COPILOT_API_BASE) {
      return Promise.resolve(new Response("forbidden", { status: 403 }));
    }
    return Promise.resolve(
      id === COPILOT_CLI_INTEGRATION_ID
        ? new Response(JSON.stringify({ data: [] }), { status: 200 })
        : new Response("Personal Access Tokens are not supported", { status: 400 }),
    );
  });
  expect(await launch()).toEqual({
    credential: { kind: "pat", token: "github_pat_x", integrationId: COPILOT_CLI_INTEGRATION_ID },
    copilotHost: ENTERPRISE,
  });
  expect(seen.filter((s) => s.host === ENTERPRISE).map((s) => s.id)).toEqual([
    VSCODE_CHAT_INTEGRATION_ID,
    COPILOT_CLI_INTEGRATION_ID,
  ]);
  // Passthrough off: the daemon sends its own vscode-chat whatever the pin, so only the host is
  // judged, under that identity.
  seen.length = 0;
  new Credential(state).store("copilot", "gho_x");
  expect(await launch()).toEqual({
    credential: { kind: "token", token: "gho_x" },
    copilotHost: ENTERPRISE,
  });
  expect(seen.map((s) => s.id)).toEqual([VSCODE_CHAT_INTEGRATION_ID]);
  // A literal pins every kind; the PAT's identity selection probes the literal and nothing else.
  new CopilotEnvConfig().set({ copilotHost: GHE });
  seen.length = 0;
  expect((await launch()).copilotHost).toBe(GHE);
  new Credential(state).store("gh-token", "github_pat_x");
  expect(await launch()).toEqual({
    credential: { kind: "pat", token: "github_pat_x", integrationId: COPILOT_CLI_INTEGRATION_ID },
    copilotHost: GHE,
  });
  expect(seen.every((s) => s.host === GHE)).toBe(true);
});
