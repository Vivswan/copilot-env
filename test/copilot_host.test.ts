// The `copilot-host` key end to end: what the writers bake, what the inspectors recognise, what the
// daemon spawn receives, and how a profile slot caches the resolved host. The auto rule itself is
// pinned in integration_identity.test.ts, the survey render in auth.test.ts, the shim's rewrite in
// copilot_host_preload.test.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { runAgentConfig } from "../src/agents/configure.ts";
import { resolveAndPersistDirectWiring } from "../src/agents/profile_wiring.ts";
import { bakedClaudeDirectIntegrationId, claudeAdapter } from "../src/claude/config.ts";
import { NOOP_CATALOG_DEPS } from "../src/codex/catalog.ts";
import { codexAdapter, inspectCodexWiring } from "../src/codex/config.ts";
import { copilotHostGrantWarning, runConfig } from "../src/commands/config.ts";
import { Credential } from "../src/copilot_api/credential.ts";
import { configKeyDef, CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import {
  COPILOT_CLI_INTEGRATION_ID,
  COPILOT_PLAN_API_BASES,
  DEFAULT_COPILOT_API_BASE,
  INTEGRATION_ID_HEADER,
  setIntegrationProbeFetch,
  VSCODE_CHAT_INTEGRATION_ID,
} from "../src/copilot_api/integration_identity.ts";
import { resolveDaemonHost } from "../src/copilot_api/launch.ts";
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
  for (const base of [DEFAULT_COPILOT_API_BASE, ...COPILOT_PLAN_API_BASES]) {
    expect(copilotHostGrantWarning(base, granted)).toBeNull();
  }
  expect(copilotHostGrantWarning(GHE, granted)).toContain(
    "not permitted by this build's network policy",
  );
});

test("a Direct wiring bakes the copilot-host into both agents' base URLs; only a Copilot host reads back as Direct", async () => {
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
  // Recognised as Direct while the literal stands, "other" once it is gone: the base URL is now a
  // host copilot-env does not know.
  const codexToml = readFileSync(join(homes.codexHome, "config.toml"), "utf8");
  const claudeJson = readFileSync(join(homes.claudeHome, "settings.json"), "utf8");
  expect(inspectCodexWiring(codexToml, null, 4141, false).providerMode).toBe("direct");
  expect(bakedClaudeDirectIntegrationId({ kind: "text", text: claudeJson }, 4141)).toEqual({
    kind: "direct",
    integrationId: null,
    baseUrl: GHE,
  });
  new CopilotEnvConfig().del("copilotHost");
  // An unrecognised copilot-env table is the inspector's UNWIRED proxy, never Direct.
  const stale = inspectCodexWiring(codexToml, null, 4141, false);
  expect([stale.providerMode, stale.providerWired]).toEqual(["proxy", false]);
  expect(bakedClaudeDirectIntegrationId({ kind: "text", text: claudeJson }, 4141)).toEqual({
    kind: "not-direct",
  });

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
  const foreign = inspectCodexWiring(
    codexConfigToml({ baseUrl: "https://elsewhere.example" }),
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
  // The CLI identity is accepted on the generic host; the default (no header) and the sandbox are
  // rejected there and sent to the account's host.
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
    if (id === COPILOT_CLI_INTEGRATION_ID || !generic) {
      return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    }
    return Promise.resolve(new Response("forbidden", { status: 403 }));
  });

  // Under a literal the identity is probed (a PAT) and cached; no host is cached for a literal.
  new CopilotEnvConfig().set({ copilotHost: GHE });
  expect(await resolveAndPersistDirectWiring(null)).toEqual({
    directIntegrationId: COPILOT_CLI_INTEGRATION_ID,
    directBaseUrl: GHE,
  });
  expect(state.readProfileSlot(null).integrationIdentity).toBe(COPILOT_CLI_INTEGRATION_ID);
  expect(state.readProfileCopilotHost(null, null)).toBeNull();
  expect(seen.every((s) => s.host === DEFAULT_COPILOT_API_BASE)).toBe(true);

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
  // The pin is configuration: the slot keeps its own verdict pair.
  expect(state.readProfileSlot(null).integrationIdentity).toBe(COPILOT_CLI_INTEGRATION_ID);
  expect(state.readProfileCopilotHost(null, null)).toBe(DEFAULT_COPILOT_API_BASE);

  // A credential change clears both halves.
  new Credential(state).store("gh-token", "ghp_rotated");
  expect(state.readProfileSlot(null).integrationIdentity).toBeNull();
  expect(state.readProfileCopilotHost(null, null)).toBeNull();
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
