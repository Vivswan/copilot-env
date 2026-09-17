// The `copilot-host` key end to end: what the writers bake, what the inspectors recognise, what the
// daemon spawn receives. The auto rule itself is
// pinned in integration_identity.test.ts, the survey render in auth.test.ts, the shim's rewrite in
// copilot_host_preload.test.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { directWiring } from "../src/agents/configure.ts";
import { configureDefaultAgents, runAgentConfig } from "../src/agents/configure_defaults.ts";
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
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import {
  COPILOT_CLI_INTEGRATION_ID,
  DEFAULT_COPILOT_API_BASE,
  INTEGRATION_ID_HEADER,
  setIntegrationProbeFetch,
  VSCODE_CHAT_INTEGRATION_ID,
} from "../src/copilot_api/integration_identity.ts";
import { resolveLaunchCredential } from "../src/copilot_api/launch.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
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
  const def = configKeyDef("host");
  expect(def?.parse("AUTO")).toBe("auto");
  // Canonical origin: scheme and host lowercased, the trailing slash dropped.
  expect(def?.parse("HTTPS://API.Business.githubcopilot.com/")).toBe(
    "https://api.business.githubcopilot.com",
  );
  for (const bad of ["http://api.githubcopilot.com", "api.githubcopilot.com", "", "ftp://x"]) {
    expect(() => runConfig({ set: ["host", bad] })).toThrow(
      /expected `auto` or an https:\/\/ origin/,
    );
  }
  expect(() => runConfig({ set: ["host", `${ENTERPRISE}/models`] })).toThrow(
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
    expect(() => runConfig({ set: ["host", loopback] })).toThrow(/not loopback/);
  }
  expect(new CopilotEnvConfig().copilotHost(null)).toBeNull();
  runConfig({ set: ["host", GHE] });
  expect(new CopilotEnvConfig().copilotHost(null)).toBe(GHE);
  runConfig({ set: ["host", "auto"] });
  expect(new CopilotEnvConfig().copilotHost(null)).toBeNull();
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
  new CopilotEnvConfig().setProfile(null, { host: GHE });
  await wire();
  expect(seen).toEqual([]);
  expect(codexBaseUrl(homes.codexHome)).toBe(GHE);
  expect(claudeBaseUrl(homes.claudeHome)).toBe(GHE);
  // Recognised as Direct by our markers and the https shape, with the literal standing OR gone: a
  // past host never orphans a wiring; the baked host reads back so a rewire can move it.
  const codexToml = readFileSync(join(homes.codexHome, "config.toml"), "utf8");
  const claudeJson = readFileSync(join(homes.claudeHome, "settings.json"), "utf8");
  for (const literal of [GHE, null]) {
    new CopilotEnvConfig().setProfile(null, { host: literal });
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

  // `auto` with the generic host serving: a re-render keeps the slot's stored host (the slot is
  // state), so moving it back takes a landing, `agent init --direct`: one probe, today's bytes.
  seen.length = 0;
  stubHosts(200, seen);
  const landing = await configureDefaultAgents(
    { codex: "direct", claude: "direct", ghToken: "ghu_x" },
    [codexAdapter(NOOP_CATALOG_DEPS), claudeAdapter()],
  );
  expect(landing.failures).toEqual([]);
  expect(codexBaseUrl(homes.codexHome)).toBe(DEFAULT_COPILOT_API_BASE);
  expect(claudeBaseUrl(homes.claudeHome)).toBe(DEFAULT_COPILOT_API_BASE);
});

test("a wiring baked for one host stays ours after the copilot-host literal changes: the rewire moves it", async () => {
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
    direct: directWiring(null, GHE),
    credential: { kind: "command" },
  });
  // The host follows the credential: the literal is the PROFILE's, not the default's.
  new CopilotEnvConfig().setProfile(work, { host: other });
  // The named-profile guard refuses only a FOREIGN file; ours, on a past host, is rewired.
  configureClaudeConfig(homes.claudeHome, {
    mode: "direct",
    profile: work,
    direct: directWiring(null, other),
    credential: { kind: "command" },
  });
  const settings = JSON.parse(
    readFileSync(join(homes.claudeHome, "settings-work.json"), "utf8"),
  ) as { env: Record<string, string> };
  expect(settings.env.ANTHROPIC_BASE_URL).toBe(other);
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
  expect(await probeDirectWiring(null, "github_pat_x")).toEqual(
    directWiring(COPILOT_CLI_INTEGRATION_ID, ENTERPRISE),
  );
  // Without the second pass the default identity (no header) would be baked for a host that 400s it.
  expect(seen.filter((s) => s.host === ENTERPRISE).map((s) => s.id)).toEqual([
    null,
    COPILOT_CLI_INTEGRATION_ID,
  ]);
  // A literal skips the HOST probe only: the identity is probed on the literal host, and nothing
  // reaches the generic host (whose 403 would leave the probe inconclusive, baking the default).
  new CopilotEnvConfig().setProfile(null, { host: GHE });
  seen.length = 0;
  expect(await probeDirectWiring(null, "github_pat_y")).toEqual(
    directWiring(COPILOT_CLI_INTEGRATION_ID, GHE),
  );
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((s) => s.host === GHE)).toBe(true);
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
  new CopilotEnvConfig().setProfile(null, { host: GHE });
  seen.length = 0;
  expect((await launch()).copilotHost).toBe(GHE);
  new Credential(state).store("gh-token", "github_pat_x");
  expect(await launch()).toEqual({
    credential: { kind: "pat", token: "github_pat_x", integrationId: COPILOT_CLI_INTEGRATION_ID },
    copilotHost: GHE,
  });
  expect(seen.every((s) => s.host === GHE)).toBe(true);
});
