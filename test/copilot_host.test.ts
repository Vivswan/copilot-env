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
import { copilotHostGrantWarning, runConfig } from "../src/commands/config.ts";
import { Credential } from "../src/copilot_api/credential.ts";
import { configKeyDef, CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { CopilotEnvState, expectedDirectHost } from "../src/copilot_api/env_state.ts";
import {
  COPILOT_CLI_INTEGRATION_ID,
  DEFAULT_COPILOT_API_BASE,
  INTEGRATION_ID_HEADER,
  setIntegrationProbeFetch,
  VSCODE_CHAT_INTEGRATION_ID,
} from "../src/copilot_api/integration_identity.ts";
import { resolveDaemonHost } from "../src/copilot_api/launch.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import { checkClaude } from "../src/health/checks_agents.ts";
import { ROOT } from "./helpers/run.ts";
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

test("agent config: copilot-host takes `auto` or an https origin, refuses anything else, and warns outside the network grant", () => {
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
  expect(() => runConfig({ set: ["copilot-host", "https://localhost:8443"] })).toThrow(
    /not loopback/,
  );
  expect(new CopilotEnvConfig().copilotHost()).toBeNull();
  runConfig({ set: ["copilot-host", GHE] });
  expect(new CopilotEnvConfig().copilotHost()).toBe(GHE);
  runConfig({ set: ["copilot-host", "auto"] });
  expect(new CopilotEnvConfig().copilotHost()).toBeNull();
  // The warning is the grant's verdict on the host alone; the auto plan hosts sit inside the
  // compiled grant (deno.json `cli`: githubcopilot.com and *.githubcopilot.com), a GHE host does not.
  const grant = (JSON.parse(readFileSync(join(ROOT, "deno.json"), "utf8")) as {
    permissions: { cli: { net: string[] } };
  }).permissions.cli.net;
  const granted = (origin: string): boolean => {
    const host = new URL(origin).host;
    return grant.some((entry) =>
      entry.startsWith("*.") ? host.endsWith(entry.slice(1)) : entry === host
    );
  };
  const planHosts = ["individual", "business", "enterprise"].map((p) =>
    `https://api.${p}.githubcopilot.com`
  );
  for (const base of [DEFAULT_COPILOT_API_BASE, ...planHosts]) {
    expect(copilotHostGrantWarning(base, granted)).toBeNull();
  }
  expect(copilotHostGrantWarning(GHE, granted)).toContain(
    "not permitted by this build's network policy",
  );
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
  // Only the shape gates: an http base that is not the proxy is the inspector's UNWIRED proxy.
  const foreign = inspectCodexWiring(
    codexConfigToml({ baseUrl: "http://elsewhere.example" }),
    null,
    4141,
    false,
  );
  expect([foreign.providerMode, foreign.providerWired]).toEqual(["proxy", false]);

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

  // Under a literal the identity is probed (a PAT) ON THE LITERAL and cached; no host is cached.
  new CopilotEnvConfig().set({ copilotHost: GHE });
  expect(await resolveAndPersistDirectWiring(null)).toEqual({
    directIntegrationId: COPILOT_CLI_INTEGRATION_ID,
    directBaseUrl: GHE,
  });
  expect(state.readProfileSlot(null).integrationIdentity).toBe(COPILOT_CLI_INTEGRATION_ID);
  expect(state.readProfileCopilotHost(null, null)).toBeNull();
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((s) => s.host === GHE)).toBe(true);

  // Dropping the literal probes the host ONCE, under the cached identity (never the identity
  // again), persists it, and replays it offline from then on.
  new CopilotEnvConfig().del("copilotHost");
  seen.length = 0;
  expect(await resolveAndPersistDirectWiring(null)).toEqual({
    directIntegrationId: COPILOT_CLI_INTEGRATION_ID,
    directBaseUrl: DEFAULT_COPILOT_API_BASE,
  });
  expect(seen).toEqual([{ host: DEFAULT_COPILOT_API_BASE, id: COPILOT_CLI_INTEGRATION_ID }]);
  expect(state.readProfileCopilotHost(null, null)).toBe(DEFAULT_COPILOT_API_BASE);
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
  // The pin is configuration: the slot keeps its own verdict, and the host now cached is the pin's
  // (readable under it, not under the verdict), so `--identity auto` re-probes the host, never
  // the identity.
  expect(state.readProfileSlot(null).integrationIdentity).toBe(COPILOT_CLI_INTEGRATION_ID);
  expect(state.readProfileCopilotHost(null, "copilot-developer-sandbox")).toBe(ENTERPRISE);
  expect(state.readProfileCopilotHost(null, null)).toBeNull();
  new CopilotEnvConfig().set({ integrationId: "auto" });
  expect(await resolveAndPersistDirectWiring(null)).toEqual({
    directIntegrationId: COPILOT_CLI_INTEGRATION_ID,
    directBaseUrl: DEFAULT_COPILOT_API_BASE,
  });
  // (The slot cache read null above; the process memo answered the CLI host probe, same token
  // and identity as the dropped-literal probe, so no request is counted here.)
  expect(state.readProfileCopilotHost(null, null)).toBe(DEFAULT_COPILOT_API_BASE);

  // A credential change clears both halves.
  new Credential(state).store("gh-token", "ghp_rotated");
  expect(state.readProfileSlot(null).integrationIdentity).toBeNull();
  expect(state.readProfileCopilotHost(null, null)).toBeNull();

  // A fresh slot under a pin caches the host resolved under the pin WITHOUT writing the pin as its
  // verdict, so the launcher hot path replays offline and `--identity auto` still probes afresh.
  new CopilotEnvConfig().set({ integrationId: COPILOT_CLI_INTEGRATION_ID });
  seen.length = 0;
  expect(await resolveAndPersistDirectWiring(null)).toEqual({
    directIntegrationId: COPILOT_CLI_INTEGRATION_ID,
    directBaseUrl: DEFAULT_COPILOT_API_BASE,
  });
  expect(seen).toEqual([{ host: DEFAULT_COPILOT_API_BASE, id: COPILOT_CLI_INTEGRATION_ID }]);
  expect(state.readProfileSlot(null).integrationIdentity).toBeNull();
  expect(state.readProfileCopilotHost(null, COPILOT_CLI_INTEGRATION_ID)).toBe(
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
  // reaches the generic host (which would 403 and read as "rejected under every identity").
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
    await probeDirectWiring(null, "github_pat_x", {
      directIntegrationId: "copilot-developer-sandbox",
    }),
  ).toEqual({ directIntegrationId: COPILOT_CLI_INTEGRATION_ID, directBaseUrl: ENTERPRISE });
});

test("resolveDaemonHost: the daemon is pinned under the identity it will send; a credential-less daemon is pinned only by a literal", async () => {
  dir = isolateAgentHomes("copilot-host-daemon-").dir;
  const seen: { host: string; id: string | null }[] = [];
  stubHosts(403, seen);
  const config = new CopilotEnvConfig();
  expect(await resolveDaemonHost({ kind: "none" }, config)).toBeNull();
  expect(
    await resolveDaemonHost({
      kind: "pat",
      token: "ghp_x",
      integrationId: "copilot-developer-cli",
    }),
  ).toBe(ENTERPRISE);
  expect(await resolveDaemonHost({ kind: "token", token: "gho_x" }, config)).toBe(ENTERPRISE);
  expect(seen).toEqual([
    { host: DEFAULT_COPILOT_API_BASE, id: "copilot-developer-cli" },
    { host: DEFAULT_COPILOT_API_BASE, id: VSCODE_CHAT_INTEGRATION_ID },
  ]);
  config.set({ copilotHost: GHE });
  seen.length = 0;
  expect(await resolveDaemonHost({ kind: "none" }, config)).toBe(GHE);
  expect(await resolveDaemonHost({ kind: "token", token: "gho_x" }, config)).toBe(GHE);
  expect(seen).toEqual([]);
});
