import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { NOOP_CATALOG_DEPS } from "../src/codex/catalog.ts";
import {
  codexUserAgent,
  configureCodexConfig,
  detectCodexDirect,
  DIRECT_ENV_KEY,
  DIRECT_SERVICE_TIER,
  FALLBACK_CODEX_UA_VERSION,
  inspectCodexWiring,
  removeCodexDefaultWiring,
  removeCodexProfile,
  runCodex,
  syncCodexCatalogReference,
  syncCodexServiceTier,
} from "../src/codex/config.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { OwnershipLedger } from "../src/copilot_api/ownership.ts";
import { CopilotApiPaths } from "../src/copilot_api/paths.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import { agentLauncherCommand, PROJECT_ROOT, proxyTokenCommand } from "../src/utils/root.ts";
import { afterEach, expect, test } from "./helpers/testing.ts";
import { envSnapshot, isolateAgentHomes, removeDir } from "./helpers.ts";

const restoreEnv = envSnapshot();
let dir = "";

afterEach(() => {
  restoreEnv();
  dir = removeDir(dir);
});

// Fresh isolated homes for one test; the proxy home exists (catalog tests write
// the generated JSON straight into it).
function isolate(): void {
  dir = isolateAgentHomes("copilot-codex-", { mkdirs: true }).dir;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error("expected an object");
  }
  return value as Record<string, unknown>;
}

// The catalog is opt-in (default false); tests exercising the enabled paths
// flip it on in the isolated COPILOT_API_HOME first.
function enableCatalog(): void {
  new CopilotEnvConfig().set({ codexModelCatalog: true });
}

test("enforces every managed field while preserving unknown user keys", () => {
  isolate();
  const codexHome = join(dir, ".codex");
  mkdirSync(codexHome, { recursive: true });

  writeFileSync(
    join(codexHome, "config.toml"),
    [
      'model_provider = "openai"',
      "",
      "[my_custom]",
      'keep = "me"',
      "",
      "[features]",
      "image_generation = false",
      "",
      "[model_providers.copilot-env]",
      'base_url = "https://stale.example"',
      'user_extra = "kept"',
      "",
      "[model_providers.other]",
      'base_url = "http://other/v1"',
      'env_key = "OTHER_KEY"',
      "",
    ].join("\n"),
  );
  writeFileSync(join(codexHome, ".env"), "OPENAI_API_KEY=user\nCOPILOT_ENV_GH_TOKEN=ghp_legacy\n");

  configureCodexConfig(codexHome, { mode: "direct", codexExecVersion: "0.139.0" });

  const doc = asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8")));
  expect(asRecord(doc.my_custom).keep).toBe("me");
  expect(doc.model_provider).toBe("copilot-env");
  expect(doc.web_search).toBe("live");
  // [features] is user content the writer never touches (the 3.3.17 migration heals
  // the managed image-generation disable older releases wrote).
  expect(asRecord(doc.features).image_generation).toBe(false);
  // Direct talks to a public host, not the loopback proxy, so it does NOT open the sandbox.
  expect(doc.sandbox_workspace_write).toBeUndefined();

  const provider = asRecord(asRecord(doc.model_providers)["copilot-env"]);
  expect(provider.name).toBe("copilot-env");
  expect(provider.base_url).toBe("https://api.githubcopilot.com");
  expect(provider.wire_api).toBe("responses");
  expect(provider.supports_websockets).toBe(false);
  expect(provider.requires_openai_auth).toBe(false);
  expect(provider.user_extra).toBe("kept");

  const headers = asRecord(provider.http_headers);
  expect(headers["Openai-Intent"]).toBe("conversation-edits");
  expect(headers["User-Agent"]).toBe("codex_exec/0.139.0");
  // No probed identity passed -> no Copilot-Integration-Id header (default identity).
  expect(headers["Copilot-Integration-Id"]).toBeUndefined();

  // Direct fetches the bearer via `auth.command` -> the agent launcher `auth --get`.
  const auth = asRecord(provider.auth);
  const expected = agentLauncherCommand(["auth", "--get"]);
  expect(auth.command).toBe(expected.command);
  expect(auth.args).toEqual(expected.args);
  expect(auth.timeout_ms).toBe(30000);
  expect(auth.refresh_interval_ms).toBe(300000);
  // No baked token at rest.
  expect(provider.env_key).toBeUndefined();

  const other = asRecord(asRecord(doc.model_providers).other);
  expect(other.base_url).toBe("http://other/v1");
  expect(other.env_key).toBe("OTHER_KEY");

  // Direct resolves via auth.command. The user's OPENAI_API_KEY is preserved (its name
  // collides with copilot-env's legacy key, so we never scrub it); only the copilot-env-owned
  // COPILOT_ENV_GH_TOKEN is removed.
  expect(readFileSync(join(codexHome, ".env"), "utf8")).toBe("OPENAI_API_KEY=user\n");
});

test("direct bakes a probed Copilot-Integration-Id into http_headers when passed", () => {
  isolate();
  const codexHome = join(dir, ".codex");
  mkdirSync(codexHome, { recursive: true });

  configureCodexConfig(codexHome, {
    mode: "direct",
    codexExecVersion: "0.139.0",
    directIntegrationId: "copilot-developer-cli",
  });
  const doc = asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8")));
  const headers = asRecord(asRecord(asRecord(doc.model_providers)["copilot-env"]).http_headers);
  expect(headers["Copilot-Integration-Id"]).toBe("copilot-developer-cli");
  expect(headers["User-Agent"]).toBe("codex_exec/0.139.0");
});

test("direct uses the launcher auth.command (no env_key, no token at rest), classified direct", () => {
  isolate();
  const codexHome = join(dir, ".codex");

  configureCodexConfig(codexHome, { mode: "direct", codexExecVersion: "0.139.0" });

  const doc = asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8")));
  expect(doc.model_provider).toBe("copilot-env");
  const provider = asRecord(asRecord(doc.model_providers)["copilot-env"]);
  // The bearer is fetched at runtime via `agent auth --get`; nothing is baked.
  expect(provider.env_key).toBeUndefined();
  const auth = asRecord(provider.auth);
  const expected = agentLauncherCommand(["auth", "--get"]);
  expect(auth.command).toBe(expected.command);
  expect(auth.args).toEqual(expected.args);

  // No .env token at rest (the scrub may leave no .env at all).
  if (existsSync(join(codexHome, ".env"))) {
    expect(readFileSync(join(codexHome, ".env"), "utf8")).not.toContain(DIRECT_ENV_KEY);
  }

  // Wiring classifies as direct and flags the managed auth.command.
  const wiring = inspectCodexWiring(
    readFileSync(join(codexHome, "config.toml"), "utf8"),
    null,
    4141,
    false,
  );
  expect(wiring.providerMode).toBe("direct");
  expect(wiring.directUsesToken).toBe(true);
});

test("gh-direct .env scrub preserves other keys and never creates a .env when absent", () => {
  isolate();
  const codexHome = join(dir, ".codex");
  mkdirSync(codexHome, { recursive: true });
  // A user-maintained .env with our baked token plus an unrelated key.
  writeFileSync(join(codexHome, ".env"), `MY_VAR=keep\n${DIRECT_ENV_KEY}=ghu_old\n`);

  configureCodexConfig(codexHome, { mode: "direct" }); // gh-direct

  const env = readFileSync(join(codexHome, ".env"), "utf8");
  expect(env).toContain("MY_VAR=keep");
  expect(env).not.toContain(DIRECT_ENV_KEY);

  // A second gh-direct home with no .env at all: the scrub must not create one.
  const codexHome2 = join(dir, ".codex2");
  configureCodexConfig(codexHome2, { mode: "direct" });
  expect(existsSync(join(codexHome2, ".env"))).toBe(false);
});

test("proxy mode enforces every managed field while preserving unknown user keys", () => {
  isolate();
  const codexHome = join(dir, ".codex");
  mkdirSync(codexHome, { recursive: true });

  // Seed a STALE existing config: a user-added section to preserve, plus our
  // provider table with an old env_key, a stale base_url, a user-added key, and
  // several managed fields missing entirely.
  writeFileSync(
    join(codexHome, "config.toml"),
    [
      'model_provider = "openai"',
      "",
      "[my_custom]",
      'keep = "me"',
      "",
      "[features]",
      "image_generation = false",
      "user_feature = true",
      "",
      "[model_providers.copilot-env]",
      'base_url = "http://stale:1/v1"',
      'env_key = "COPILOT_API_KEY"',
      'user_extra = "kept"',
      "",
      "[model_providers.other]",
      'base_url = "http://other/v1"',
      'env_key = "OTHER_KEY"',
      "",
    ].join("\n"),
  );

  configureCodexConfig(codexHome, {
    mode: "proxy",
    baseUrl: "http://localhost:4141/v1",
  });

  const doc = asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8")));
  // Unknown user content survives, and our proxy is reselected as default.
  expect(asRecord(doc.my_custom).keep).toBe("me");
  expect(doc.model_provider).toBe("copilot-env");
  expect(doc.web_search).toBe("live");
  // [features] is user content the writer never touches, in proxy mode too.
  expect(asRecord(doc.features).image_generation).toBe(false);
  expect(asRecord(doc.features).user_feature).toBe(true);

  const provider = asRecord(asRecord(doc.model_providers)["copilot-env"]);
  expect(provider.base_url).toBe("http://localhost:4141/v1");
  expect(provider.name).toBe("copilot-env");
  // Proxy resolves its key via auth.command (the shared proxy-token script: ensure +
  // print); the stale env_key is scrubbed (Codex forbids auth + env_key together).
  expect(provider.env_key).toBeUndefined();
  const proxyAuthCmd = proxyTokenCommand();
  expect(asRecord(provider.auth).command).toBe(proxyAuthCmd.command);
  expect(asRecord(provider.auth).args).toEqual(proxyAuthCmd.args);
  expect(String(asRecord(provider.auth).args)).toContain("proxy-token");
  // A generous timeout so the first auth attempt outlasts a proxy cold start.
  expect(asRecord(provider.auth).timeout_ms).toBe(180000);
  expect(provider.wire_api).toBe("responses"); // missing managed field filled
  expect(provider.requires_openai_auth).toBe(false);
  expect(provider.supports_websockets).toBe(false);
  expect(provider.user_extra).toBe("kept"); // user-added key in the table survives

  // The proxy is on loopback; codex's sandbox blocks loopback unless workspace-write network
  // access is granted, so proxy mode enables it (the auth.command's liveness probe needs it).
  expect(asRecord(doc.sandbox_workspace_write).network_access).toBe(true);

  // A second, unrelated provider table is left fully intact.
  const other = asRecord(asRecord(doc.model_providers).other);
  expect(other.base_url).toBe("http://other/v1");
  expect(other.env_key).toBe("OTHER_KEY");

  // No key is baked into .env (resolved at runtime by auth.command).
  expect(existsSync(join(codexHome, ".env"))).toBe(false);
});

test("refuses to overwrite an unparseable config.toml (preserves the user's file)", () => {
  isolate();
  const codexHome = join(dir, ".codex");
  mkdirSync(codexHome, { recursive: true });

  // Real user content plus one TOML syntax error (an unbalanced quote from a hand edit).
  const original = [
    "[mcp_servers.mine]",
    'command = "my-server',
    "",
    "[model_providers.myopenai]",
    'base_url = "https://api.openai.com/v1"',
    "",
  ].join("\n");
  const configPath = join(codexHome, "config.toml");
  writeFileSync(configPath, original);

  // The write must throw rather than clobber the file with the default template.
  expect(() =>
    configureCodexConfig(codexHome, { mode: "proxy", baseUrl: "http://localhost:4141/v1" })
  ).toThrow(/not valid TOML|refusing to overwrite/);
  // The user's file is left exactly as it was.
  expect(readFileSync(configPath, "utf8")).toBe(original);
});

test("proxy mode preserves the user's OPENAI_API_KEY but scrubs the copilot-env legacy key", () => {
  isolate();
  const codexHome = join(dir, ".codex");
  mkdirSync(codexHome, { recursive: true });

  // OPENAI_API_KEY is the standard name a Codex user keeps for their OWN OpenAI provider;
  // its name collides with copilot-env's old env_key wiring, so it must NOT be scrubbed
  // (a leftover managed value is harmless -- the managed provider uses auth.command). Only
  // the copilot-env-OWNED legacy key (COPILOT_ENV_GH_TOKEN) is scrubbed.
  writeFileSync(
    join(codexHome, ".env"),
    [
      "# my secrets",
      "FOO=bar",
      "OPENAI_API_KEY=sk-user-personal",
      "export OPENAI_API_KEY=sk-user-export",
      "COPILOT_ENV_GH_TOKEN=ghp_legacy",
      "",
    ].join("\n"),
  );

  configureCodexConfig(codexHome, { mode: "proxy", baseUrl: "http://localhost:4141/v1" });

  // The user's OPENAI_API_KEY lines survive; the copilot-env legacy token is removed.
  expect(readFileSync(join(codexHome, ".env"), "utf8")).toBe(
    [
      "# my secrets",
      "FOO=bar",
      "OPENAI_API_KEY=sk-user-personal",
      "export OPENAI_API_KEY=sk-user-export",
      "",
    ].join("\n"),
  );
});

test("writes the managed direct default config when no provider section exists", () => {
  isolate();
  const codexHome = join(dir, ".codex");

  configureCodexConfig(codexHome, { mode: "direct", codexExecVersion: "0.139.0" });

  const doc = asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8")));
  expect(doc.model_provider).toBe("copilot-env");
  expect(doc.web_search).toBe("live");
  expect(doc.features).toBeUndefined();
  const provider = asRecord(asRecord(doc.model_providers)["copilot-env"]);
  expect(provider.base_url).toBe("https://api.githubcopilot.com");
  expect(provider.supports_websockets).toBe(false);
  expect(existsSync(join(codexHome, ".env"))).toBe(false);
});

test("formats Codex user-agent with dynamic version fallback", () => {
  expect(codexUserAgent("0.139.0")).toBe("codex_exec/0.139.0");
  // Never version-less: Copilot rejects some models for a bare codex_exec UA
  // (the gate is the versioned SHAPE), so the null fallback pins a real release.
  expect(codexUserAgent(null)).toBe(`codex_exec/${FALLBACK_CODEX_UA_VERSION}`);
  expect(FALLBACK_CODEX_UA_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});

test("runCodex --proxy writes the proxy provider at CODEX_HOME", async () => {
  isolate();
  const codexHome = join(dir, "custom-codex-home");
  process.env.CODEX_HOME = codexHome;
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(
    join(codexHome, "config.toml"),
    [
      'model_provider = "copilot-env"',
      "",
      "[model_providers.copilot-env]",
      'base_url = "http://stale:1/v1"',
      'env_key = "OPENAI_API_KEY"',
      "",
    ].join("\n"),
  );

  await runCodex({ kind: "configure", mode: "proxy" }, NOOP_CATALOG_DEPS);

  const doc = asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8")));
  expect(doc.model_provider).toBe("copilot-env");
  const provider = asRecord(asRecord(doc.model_providers)["copilot-env"]);
  expect(provider.base_url).toBe("http://127.0.0.1:4141/v1");
  // Proxy resolves the key at runtime via auth.command; nothing is baked into .env.
  expect(provider.env_key).toBeUndefined();
  expect(asRecord(provider.auth).command).toBe(proxyTokenCommand().command);
  expect(asRecord(provider.auth).args).toEqual(proxyTokenCommand().args);
  expect(existsSync(join(codexHome, ".env"))).toBe(false);
});

test("runCodex --proxy and --direct force the selected provider (no probe)", async () => {
  isolate();
  const codexHome = join(dir, "custom-codex-home");
  process.env.CODEX_HOME = codexHome;
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(
    join(codexHome, "config.toml"),
    [
      'model_provider = "copilot-env"',
      "",
      "[model_providers.copilot-env]",
      'base_url = "https://old.example"',
      "",
    ].join("\n"),
  );

  await runCodex({ kind: "configure", mode: "proxy" }, NOOP_CATALOG_DEPS);
  let doc = asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8")));
  expect(doc.model_provider).toBe("copilot-env");
  expect(asRecord(asRecord(doc.model_providers)["copilot-env"]).base_url).toBe(
    "http://127.0.0.1:4141/v1",
  );

  await runCodex({ kind: "configure", mode: "direct" }, NOOP_CATALOG_DEPS);
  doc = asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8")));
  expect(doc.model_provider).toBe("copilot-env");
  const directProvider = asRecord(asRecord(doc.model_providers)["copilot-env"]);
  expect(directProvider.base_url).toBe("https://api.githubcopilot.com");
  // Toggling proxy -> direct must leave NO stale proxy-only key on the shared table.
  expect(directProvider.env_key).toBeUndefined();
});

test("toggling direct <-> proxy swaps the mode-specific keys on the shared table", () => {
  isolate();
  const codexHome = join(dir, ".codex");

  // Start direct: the table carries the managed auth (agent auth --get) + http_headers.
  configureCodexConfig(codexHome, { mode: "direct", codexExecVersion: "0.139.0" });
  let provider = asRecord(
    asRecord(asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8"))).model_providers)[
      "copilot-env"
    ],
  );
  expect(asRecord(provider.auth).args).toEqual(agentLauncherCommand(["auth", "--get"]).args);
  expect(provider.http_headers).toBeDefined();

  // Switch to proxy on the SAME table: the proxy auth (`agent proxy-token --yes`)
  // replaces the direct auth, env_key stays absent, and direct-only http_headers is
  // scrubbed.
  configureCodexConfig(codexHome, {
    mode: "proxy",
    baseUrl: "http://localhost:4141/v1",
  });
  const doc = asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8")));
  expect(doc.model_provider).toBe("copilot-env");
  provider = asRecord(asRecord(doc.model_providers)["copilot-env"]);
  expect(provider.base_url).toBe("http://localhost:4141/v1");
  expect(provider.env_key).toBeUndefined();
  expect(asRecord(provider.auth).command).toBe(proxyTokenCommand().command);
  expect(asRecord(provider.auth).args).toEqual(proxyTokenCommand().args);
  expect(provider.http_headers).toBeUndefined();
});

test("detectCodexDirect: true only when CLI+gh present, gh authed, and the probe succeeds", () => {
  isolate();
  // A runProbe spy lets us prove the cheap gates short-circuit BEFORE the (here
  // simulated) model call.
  let probeCalls = 0;
  const ok = {
    findCommand: (c: string) => ({ path: `/bin/${c}` }),
    ghAuthOk: () => true as const,
    runProbe: () => {
      probeCalls++;
      return { ok: true };
    },
    retryDelayMs: 0,
  };
  expect(detectCodexDirect(ok)).toBe(true);
  expect(probeCalls).toBe(1);
  // The live read-only prompt failed -> proxy.
  expect(detectCodexDirect({ ...ok, runProbe: () => ({ ok: false }) })).toBe(false);

  // Each cheap gate miss returns false WITHOUT calling runProbe.
  probeCalls = 0;
  expect(detectCodexDirect({ ...ok, ghAuthOk: () => false })).toBe(false);
  expect(
    detectCodexDirect({
      ...ok,
      findCommand: (c: string) => ({ path: c === "codex" ? null : `/bin/${c}` }),
    }),
  ).toBe(false);
  expect(
    detectCodexDirect({
      ...ok,
      findCommand: (c: string) => ({ path: c === "gh" ? null : `/bin/${c}` }),
    }),
  ).toBe(false);
  expect(probeCalls).toBe(0);
});

test("proxy mode rejects a base_url containing invalid characters", () => {
  isolate();

  expect(() =>
    configureCodexConfig(join(dir, ".codex"), {
      mode: "proxy",
      baseUrl: "http://bad url/v1",
    })
  ).toThrow("base_url contains invalid characters: http://bad url/v1");
});

test("model_catalog_json is written when enabled and the catalog file exists (both modes)", () => {
  isolate();
  const codexHome = join(dir, ".codex");
  const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
  enableCatalog();
  writeFileSync(catalogFile, '{"models":[{"slug":"gpt-5.5"}]}\n');

  configureCodexConfig(codexHome, { mode: "direct", codexExecVersion: "0.144.0" });
  let doc = asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8")));
  expect(doc.model_catalog_json).toBe(catalogFile);

  configureCodexConfig(codexHome, {
    mode: "proxy",
    baseUrl: "http://127.0.0.1:4141/v1",
    codexExecVersion: "0.144.0",
  });
  doc = asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8")));
  expect(doc.model_catalog_json).toBe(catalogFile);
});

test("the catalog reference is ledger-recorded on write and released on the disabled scrub", () => {
  isolate();
  const codexHome = join(dir, ".codex");
  const configPath = join(codexHome, "config.toml");
  const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
  enableCatalog();
  writeFileSync(catalogFile, '{"models":[{"slug":"gpt-5.5"}]}\n');

  configureCodexConfig(codexHome, { mode: "direct", codexExecVersion: "0.144.0" });
  expect(new OwnershipLedger().owns("codexCatalog", configPath)).toBe(true);

  // Disabling scrubs the key on the next full write and drops our claim with it.
  new CopilotEnvConfig().set({ codexModelCatalog: false });
  configureCodexConfig(codexHome, { mode: "direct", codexExecVersion: "0.144.0" });
  expect(
    asRecord(parse(readFileSync(configPath, "utf8"))).model_catalog_json,
  ).toBeUndefined();
  expect(new OwnershipLedger().owns("codexCatalog", configPath)).toBe(false);
});

test("a write to an unknown home (the probe's throwaway dir) never enters the ledger", () => {
  isolate();
  const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
  enableCatalog();
  writeFileSync(catalogFile, '{"models":[{"slug":"gpt-5.5"}]}\n');

  // detectCodexDirect writes a temp-home config exactly like this: the key is
  // still written (inert in a throwaway config), but a home outside the cleanup
  // sweep must never be claimed -- the ledger would accumulate dead tmp paths.
  const probeHome = join(dir, "probe-home");
  configureCodexConfig(probeHome, { mode: "direct", codexExecVersion: "0.144.0", quiet: true });
  const doc = asRecord(parse(readFileSync(join(probeHome, "config.toml"), "utf8")));
  expect(doc.model_catalog_json).toBe(catalogFile);
  expect(new OwnershipLedger().ownedPaths("codexCatalog")).toEqual([]);
});

test("a stale model_catalog_json is scrubbed when the catalog file is absent", () => {
  isolate();
  const codexHome = join(dir, ".codex");
  mkdirSync(codexHome, { recursive: true });
  enableCatalog();
  // Pre-seed a config referencing a catalog that no longer exists: a dangling
  // model_catalog_json is a Codex STARTUP error, so the write must scrub it.
  writeFileSync(
    join(codexHome, "config.toml"),
    ['model_catalog_json = "/nonexistent/codex-model-catalog.json"', ""].join("\n"),
  );

  configureCodexConfig(codexHome, { mode: "direct", codexExecVersion: "0.144.0" });
  const doc = asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8")));
  expect(doc.model_catalog_json).toBeUndefined();
});

test("a corrupt or empty catalog file is scrubbed like a missing one", () => {
  isolate();
  const codexHome = join(dir, ".codex");
  const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
  enableCatalog();
  // Referencing a file Codex cannot parse is a startup error, same as a
  // dangling path -- usability, not existence, gates the key.
  writeFileSync(catalogFile, "{ corrupt");

  configureCodexConfig(codexHome, { mode: "direct", codexExecVersion: "0.144.0" });
  const doc = asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8")));
  expect(doc.model_catalog_json).toBeUndefined();
});

test("syncCodexCatalogReference self-heals a managed config missing the key", () => {
  isolate();
  const codexHome = join(dir, ".codex");
  process.env.CODEX_HOME = codexHome;
  const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
  mkdirSync(codexHome, { recursive: true });
  enableCatalog();

  // The wiring-time seed failed (no catalog yet), so the managed config was
  // written WITHOUT the key. The auth-time refresh later generates the file...
  writeFileSync(
    join(codexHome, "config.toml"),
    ['model_provider = "copilot-env"', 'user_key = "kept"', ""].join("\n"),
  );
  writeFileSync(catalogFile, '{"models":[{"slug":"gpt-5.5"}]}');

  // ...and the post-refresh hook adds the reference in place.
  syncCodexCatalogReference();
  const doc = asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8")));
  expect(doc.model_catalog_json).toBe(catalogFile);
  expect(doc.user_key).toBe("kept");
});

test("syncCodexCatalogReference never adds the key to a config not on our provider", () => {
  isolate();
  const codexHome = join(dir, ".codex");
  process.env.CODEX_HOME = codexHome;
  const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
  mkdirSync(codexHome, { recursive: true });
  enableCatalog();
  writeFileSync(catalogFile, '{"models":[{"slug":"gpt-5.5"}]}');

  // No model_provider (the --mobile pairing shape) => leave the file alone.
  const pairing = 'user_key = "kept"\n';
  writeFileSync(join(codexHome, "config.toml"), pairing);
  syncCodexCatalogReference();
  expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(pairing);

  // A foreign provider => also untouched.
  const foreign = 'model_provider = "openai"\n';
  writeFileSync(join(codexHome, "config.toml"), foreign);
  syncCodexCatalogReference();
  expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(foreign);

  // No config.toml at all => a silent no-op.
  rmSync(join(codexHome, "config.toml"));
  syncCodexCatalogReference();
  expect(existsSync(join(codexHome, "config.toml"))).toBe(false);
});

test("syncCodexCatalogReference is ADD-only when enabled: a user-pinned catalog path survives", () => {
  isolate();
  const codexHome = join(dir, ".codex");
  process.env.CODEX_HOME = codexHome;
  mkdirSync(codexHome, { recursive: true });
  enableCatalog();
  writeFileSync(new CopilotApiPaths().codexModelCatalogFile, '{"models":[{"slug":"gpt-5.5"}]}');

  const pinned = [
    'model_provider = "copilot-env"',
    'model_catalog_json = "/home/u/custom-catalog.json"',
    "",
  ].join("\n");
  writeFileSync(join(codexHome, "config.toml"), pinned);

  syncCodexCatalogReference();
  expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(pinned);
});

test("disabled: configureCodexConfig scrubs model_catalog_json even when the file is usable", () => {
  isolate();
  const codexHome = join(dir, ".codex");
  const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
  // Opt-in NOT set: a perfectly usable file must still not be referenced.
  writeFileSync(catalogFile, '{"models":[{"slug":"gpt-5.5"}]}\n');
  mkdirSync(codexHome, { recursive: true });
  // stringify, not a hand-written template: a raw Windows path inside a TOML
  // basic string reads as escape sequences.
  writeFileSync(join(codexHome, "config.toml"), stringify({ "model_catalog_json": catalogFile }));

  configureCodexConfig(codexHome, { mode: "direct", codexExecVersion: "0.144.0" });
  const doc = asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8")));
  expect(doc.model_catalog_json).toBeUndefined();
});

test("disabled: sync strips our reference, deletes the file, and clears the throttle state", () => {
  isolate();
  const codexHome = join(dir, ".codex");
  process.env.CODEX_HOME = codexHome;
  const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(catalogFile, '{"models":[{"slug":"gpt-5.5"}]}');
  writeFileSync(
    join(codexHome, "config.toml"),
    stringify({
      "model_provider": "copilot-env",
      "model_catalog_json": catalogFile,
      "user_key": "kept",
    }),
  );
  new CopilotEnvState().set({ codexCatalogLastAttemptMs: 123, codexCatalogCodexVersion: "1.0.0" });

  syncCodexCatalogReference();

  const doc = asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8")));
  expect(doc.model_catalog_json).toBeUndefined();
  expect(doc.user_key).toBe("kept");
  expect(existsSync(catalogFile)).toBe(false);
  const state = new CopilotEnvState().read();
  expect(state.codexCatalogLastAttemptMs).toBe(0);
  expect(state.codexCatalogCodexVersion).toBeNull();
});

test("disabled: sync also strips per-host farm configs referencing the shared file", () => {
  isolate();
  const codexHome = join(dir, ".codex");
  process.env.CODEX_HOME = codexHome;
  const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
  mkdirSync(codexHome, { recursive: true });
  const farmHome = join(codexHome, "hosts", "otherhost");
  mkdirSync(farmHome, { recursive: true });
  writeFileSync(catalogFile, '{"models":[{"slug":"gpt-5.5"}]}');
  const referencing = stringify({ "model_catalog_json": catalogFile });
  writeFileSync(join(codexHome, "config.toml"), referencing);
  writeFileSync(join(farmHome, "config.toml"), referencing);

  syncCodexCatalogReference();

  for (const configPath of [join(codexHome, "config.toml"), join(farmHome, "config.toml")]) {
    const doc = asRecord(parse(readFileSync(configPath, "utf8")));
    expect(doc.model_catalog_json).toBeUndefined();
  }
  expect(existsSync(catalogFile)).toBe(false);
});

test("disabled: the ledger extends the sweep beyond the enumerated homes and drops stale claims", () => {
  isolate();
  const codexHome = join(dir, ".codex");
  process.env.CODEX_HOME = codexHome;
  const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(catalogFile, '{"models":[{"slug":"gpt-5.5"}]}');
  writeFileSync(join(codexHome, "config.toml"), 'model_provider = "copilot-env"\n');
  // A RECORDED config outside every known home (a retired farm home, a moved
  // CODEX_HOME) still referencing our file: only the ledger knows to sweep it.
  const outside = join(dir, "retired-home", "config.toml");
  mkdirSync(join(dir, "retired-home"), { recursive: true });
  writeFileSync(outside, stringify({ "model_catalog_json": catalogFile }));
  const ledger = new OwnershipLedger();
  ledger.record("codexCatalog", outside);
  // And a stale claim: the recorded config no longer exists at all.
  const gone = join(dir, "gone", "config.toml");
  ledger.record("codexCatalog", gone);

  syncCodexCatalogReference();

  expect(asRecord(parse(readFileSync(outside, "utf8"))).model_catalog_json).toBeUndefined();
  expect(existsSync(catalogFile)).toBe(false);
  expect(new OwnershipLedger().ownedPaths("codexCatalog")).toEqual([]);
});

test("disabled: a user-pinned custom catalog path survives, but our file still goes", () => {
  isolate();
  const codexHome = join(dir, ".codex");
  process.env.CODEX_HOME = codexHome;
  const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(catalogFile, '{"models":[{"slug":"gpt-5.5"}]}');
  const pinned = [
    'model_provider = "copilot-env"',
    'model_catalog_json = "/home/u/custom-catalog.json"',
    "",
  ].join("\n");
  writeFileSync(join(codexHome, "config.toml"), pinned);

  syncCodexCatalogReference();

  expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(pinned);
  expect(existsSync(catalogFile)).toBe(false);
});

test("disabled: steady-state sync is write-free", () => {
  isolate();
  const codexHome = join(dir, ".codex");
  process.env.CODEX_HOME = codexHome;
  mkdirSync(codexHome, { recursive: true });
  const clean = 'model_provider = "copilot-env"\n';
  writeFileSync(join(codexHome, "config.toml"), clean);
  const stateFile = new CopilotApiPaths().sharedStateFile;

  syncCodexCatalogReference();
  const stateAfterFirst = existsSync(stateFile) ? readFileSync(stateFile, "utf8") : null;
  syncCodexCatalogReference();

  // Nothing to clean: the config text is untouched and no state file appears.
  expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(clean);
  const stateAfterSecond = existsSync(stateFile) ? readFileSync(stateFile, "utf8") : null;
  expect(stateAfterSecond).toBe(stateAfterFirst);
  expect(stateAfterFirst).toBeNull();
});

test("disabled: an unreadable config.toml keeps the catalog file (no dangling reference)", () => {
  isolate();
  const codexHome = join(dir, ".codex");
  process.env.CODEX_HOME = codexHome;
  const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(catalogFile, '{"models":[{"slug":"gpt-5.5"}]}');
  // Unparseable TOML: it MIGHT still reference the file, so deletion must wait.
  writeFileSync(join(codexHome, "config.toml"), "model_catalog_json = [unclosed");

  syncCodexCatalogReference();

  expect(existsSync(catalogFile)).toBe(true);
});

test("disabled: a symlinked spelling of our path blocks deletion (fail closed)", () => {
  if (process.platform === "win32") return; // symlink creation needs privileges there
  isolate();
  const codexHome = join(dir, ".codex");
  process.env.CODEX_HOME = codexHome;
  const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(catalogFile, '{"models":[{"slug":"gpt-5.5"}]}');
  // A non-identical spelling that resolves to OUR file: not provably ours to
  // strip, but deleting the file would dangle it.
  const alias = join(dir, "catalog-alias.json");
  symlinkSync(catalogFile, alias);
  const pinned = stringify({ "model_catalog_json": alias });
  writeFileSync(join(codexHome, "config.toml"), pinned);

  syncCodexCatalogReference();

  expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(pinned);
  expect(existsSync(catalogFile)).toBe(true);
});

// The same fail-closed policy, one step further out: the symlink case above is a
// reference we PROVED points at our file, this is one we could not resolve AT ALL.
// A realpath that cannot run (EACCES on a path component, ELOOP) is not proof the
// reference is someone else's, so it must not authorize deleting the catalog --
// Codex treats a dangling model_catalog_json as a STARTUP error. Non-root POSIX
// only: 0000 blocks the resolve, and root bypasses file modes.
test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "disabled: a reference we CANNOT resolve blocks deletion too (fail closed)",
  () => {
    isolate();
    const codexHome = join(dir, ".codex");
    process.env.CODEX_HOME = codexHome;
    const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(catalogFile, '{"models":[{"slug":"gpt-5.5"}]}');
    // A reference under a directory we cannot traverse: realpathSync raises EACCES,
    // so whether it denotes our file is UNKNOWN, not "no".
    const blocked = join(dir, "blocked");
    mkdirSync(blocked, { recursive: true });
    const pinned = stringify({ "model_catalog_json": join(blocked, "catalog.json") });
    writeFileSync(join(codexHome, "config.toml"), pinned);
    chmodSync(blocked, 0o000);
    try {
      syncCodexCatalogReference();

      expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(pinned);
      expect(existsSync(catalogFile)).toBe(true);
    } finally {
      chmodSync(blocked, 0o755);
    }
  },
);

test("disabled: a reference that provably is NOT ours still lets the catalog go (the control)", () => {
  // The control for the two fail-closed rows above: the refusals must not seize up
  // the ordinary cleanup. A resolvable reference pointing somewhere else is a proven
  // "not ours", so the catalog file is still deleted and the foreign key left alone.
  isolate();
  const codexHome = join(dir, ".codex");
  process.env.CODEX_HOME = codexHome;
  const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(catalogFile, '{"models":[{"slug":"gpt-5.5"}]}');
  const foreign = join(dir, "someone-elses-catalog.json");
  writeFileSync(foreign, "{}");
  const pinned = stringify({ "model_catalog_json": foreign });
  writeFileSync(join(codexHome, "config.toml"), pinned);

  syncCodexCatalogReference();

  expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(pinned); // untouched
  expect(existsSync(catalogFile)).toBe(false); // ours went
});

// --- reader tolerance: the retired script-shaped proxy auth ---------------------

// What pre-`agent proxy-token` releases wrote as the managed proxy auth block on THIS
// platform: the src/scripts resolver script under the current root (the shape the old
// proxyTokenCommand produced).
function legacyScriptAuth(profileArgs: string[] = []): { command: string; args: string[] } {
  if (process.platform === "win32") {
    return {
      command: "powershell",
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(PROJECT_ROOT, "src", "scripts", "proxy-token.ps1"),
        "--yes",
        ...profileArgs,
      ],
    };
  }
  return {
    command: "/bin/sh",
    args: [join(PROJECT_ROOT, "src", "scripts", "proxy-token.sh"), "--yes", ...profileArgs],
  };
}

function proxyConfigWithAuth(auth: { command: string; args: string[] }): string {
  return stringify({
    "model_provider": "copilot-env",
    "model_providers": {
      "copilot-env": {
        "name": "copilot-env",
        "base_url": "http://127.0.0.1:4141/v1",
        "wire_api": "responses",
        "auth": { "command": auth.command, "args": auth.args },
      },
    },
  });
}

test("legacy script-shaped proxy auth still inspects as managed (reader tolerance)", () => {
  // An install whose wiring predates the `agent proxy-token` subcommand: the auth
  // block execs the src/scripts resolver script. It must keep reading as OUR managed
  // proxy wiring (`agent codex --check` exit 2 keeps the launchers' auto-start branch)
  // until a rewrite upgrades it.
  const wiring = inspectCodexWiring(proxyConfigWithAuth(legacyScriptAuth()), null, 4141, false);
  expect(wiring.providerMode).toBe("proxy");
  expect(wiring.envKeyMatches).toBe(true);
  expect(wiring.providerWired).toBe(true);
});

test("a genuinely foreign auth block still un-wires the proxy config", () => {
  // The tolerance must not widen into "any script named like ours": a foreign command
  // (or a script outside the managed root) is not managed wiring.
  const foreign = inspectCodexWiring(
    proxyConfigWithAuth({ command: "/usr/local/bin/my-token", args: ["--yes"] }),
    null,
    4141,
    false,
  );
  expect(foreign.providerMode).toBe("proxy");
  expect(foreign.envKeyMatches).toBe(false);
  expect(foreign.providerWired).toBe(false);

  const strayCopy = inspectCodexWiring(
    proxyConfigWithAuth({ command: "/bin/sh", args: ["/opt/elsewhere/proxy-token.sh", "--yes"] }),
    null,
    4141,
    false,
  );
  expect(strayCopy.providerWired).toBe(false);
});

test("inspectCodexWiring takes a TextReadResult: unreadable is other/read-error, never none", () => {
  const unreadable = inspectCodexWiring({ kind: "unreadable", error: "EACCES" }, null, 4141, false);
  expect(unreadable.providerMode).toBe("other");
  expect(unreadable.otherReason).toBe("read-error");
  expect(unreadable.configExists).toBe(true); // it EXISTS -- it just cannot be read

  const absent = inspectCodexWiring({ kind: "absent" }, null, 4141, false);
  expect(absent.providerMode).toBe("none");
  expect(absent.configExists).toBe(false);

  const text = inspectCodexWiring(
    { kind: "text", text: 'model_provider = "copilot-env"' },
    null,
    4141,
    false,
  );
  expect(text.providerSelected).toBe(true);
  expect(text.otherReason).toBe(null);
});

test("a foreign model_provider classifies other/custom carrying the foreign id", () => {
  const wiring = inspectCodexWiring('model_provider = "openai"', null, 4141, false);
  expect(wiring.providerMode).toBe("other");
  expect(wiring.otherReason).toBe("custom");
  expect(wiring.modelProvider).toBe("openai");
});

test("a rewrite upgrades legacy script wiring to the subcommand shape", () => {
  isolate();
  const codexHome = join(dir, ".codex");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "config.toml"), proxyConfigWithAuth(legacyScriptAuth()));

  configureCodexConfig(codexHome, { mode: "proxy", baseUrl: "http://127.0.0.1:4141/v1" });

  const doc = asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8")));
  const provider = asRecord(asRecord(doc.model_providers)["copilot-env"]);
  expect(asRecord(provider.auth).command).toBe(proxyTokenCommand().command);
  expect(asRecord(provider.auth).args).toEqual(proxyTokenCommand().args);
});

// --- the Direct service_tier pin -----------------------------------------------

const WORK = parseProfileName("work");

function tomlAt(path: string): Record<string, unknown> {
  return asRecord(parse(readFileSync(path, "utf8")));
}

test("a Direct write pins service_tier to a tier Copilot accepts and reports the change", () => {
  isolate();
  const codexHome = join(dir, ".codex");
  const configPath = join(codexHome, "config.toml");
  mkdirSync(codexHome, { recursive: true });
  // The writer narrates on stderr (createStderrLogger), so capture that stream.
  let narrated = "";
  const realWrite = process.stderr.write;
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    narrated += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  };
  try {
    // Absent: Codex 0.153+ would send the model's default tier (priority) -> pinned.
    configureCodexConfig(codexHome, { mode: "direct", codexExecVersion: "0.144.0" });
    expect(tomlAt(configPath).service_tier).toBe(DIRECT_SERVICE_TIER);
    // Rejected: the TUI's fast-mode toggle writes `priority` -> pinned, with the old value named.
    writeFileSync(configPath, stringify({ ...tomlAt(configPath), "service_tier": "priority" }));
    configureCodexConfig(codexHome, { mode: "direct", codexExecVersion: "0.144.0" });
    expect(tomlAt(configPath).service_tier).toBe(DIRECT_SERVICE_TIER);
    // Accepted: `flex` is the user's choice and survives, with nothing reported.
    writeFileSync(configPath, stringify({ ...tomlAt(configPath), "service_tier": "flex" }));
    configureCodexConfig(codexHome, { mode: "direct", codexExecVersion: "0.144.0" });
    expect(tomlAt(configPath).service_tier).toBe("flex");
  } finally {
    process.stderr.write = realWrite;
  }
  const tierLines = narrated.split("\n").filter((l) => l.includes("service_tier"));
  expect(tierLines.length).toBe(2);
  expect(tierLines[0]).toContain(`service_tier = "${DIRECT_SERVICE_TIER}" pinned in ${configPath}`);
  expect(tierLines[0]).toContain("model's default tier");
  expect(tierLines[1]).toContain('was "priority"');
});

test("a QUIET write still reports a tier change on a real home, and never for the probe's throwaway home", () => {
  isolate();
  const codexHome = join(dir, ".codex");
  process.env.CODEX_HOME = codexHome; // a known home, as `agent profile --sync` writes
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "config.toml"), 'service_tier = "priority"\n');
  const stderrOf = (fn: () => void): string => {
    let out = "";
    const realWrite = process.stderr.write;
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      out += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    };
    try {
      fn();
    } finally {
      process.stderr.write = realWrite;
    }
    return out;
  };
  const quietReal = stderrOf(() =>
    configureCodexConfig(codexHome, { mode: "direct", codexExecVersion: "0.144.0", quiet: true })
  );
  expect(quietReal).not.toContain("Codex config written");
  expect(quietReal).toContain(`service_tier = "${DIRECT_SERVICE_TIER}" pinned in`);
  expect(quietReal).toContain('was "priority"');
  // The live-probe home is outside knownCodexHomes AND quiet: its pin is inert and
  // unreported. The same unknown home written NON-quietly narrates like any write.
  const probeHome = join(dir, "probe-home");
  mkdirSync(probeHome);
  writeFileSync(join(probeHome, "config.toml"), 'service_tier = "priority"\n');
  const quietProbe = stderrOf(() =>
    configureCodexConfig(probeHome, { mode: "direct", codexExecVersion: "0.144.0", quiet: true })
  );
  expect(quietProbe).not.toContain("service_tier");
  expect(tomlAt(join(probeHome, "config.toml")).service_tier).toBe(DIRECT_SERVICE_TIER);
  writeFileSync(join(probeHome, "config.toml"), 'service_tier = "priority"\n');
  const loudUnknown = stderrOf(() =>
    configureCodexConfig(probeHome, { mode: "direct", codexExecVersion: "0.144.0" })
  );
  expect(loudUnknown).toContain("Codex config written");
  expect(loudUnknown).toContain('was "priority"');
});

test("a proxy write leaves service_tier alone (the proxy strips it before forwarding)", () => {
  isolate();
  const codexHome = join(dir, ".codex");
  const configPath = join(codexHome, "config.toml");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(configPath, 'service_tier = "priority"\n');
  configureCodexConfig(codexHome, {
    mode: "proxy",
    baseUrl: "http://127.0.0.1:4141/v1",
    codexExecVersion: "0.144.0",
  });
  expect(tomlAt(configPath).service_tier).toBe("priority");
  // And never adds one.
  writeFileSync(configPath, "");
  configureCodexConfig(codexHome, {
    mode: "proxy",
    baseUrl: "http://127.0.0.1:4141/v1",
    codexExecVersion: "0.144.0",
  });
  expect(tomlAt(configPath).service_tier).toBeUndefined();
});

test("a named Direct profile pins its OWN tier and never rewrites a foreign default selection's", () => {
  isolate();
  const codexHome = join(dir, ".codex");
  const configPath = join(codexHome, "config.toml");
  mkdirSync(codexHome, { recursive: true });
  const writeWork = () =>
    configureCodexConfig(codexHome, {
      mode: "direct",
      codexExecVersion: "0.144.0",
      profile: WORK,
      quiet: true,
    });
  const workTable = () => asRecord(asRecord(tomlAt(configPath).profiles).work);
  // Codex reads the profile's own tier, else the top-level one. Every combination:
  // the top-level line (a foreign OpenAI selection's) is never rewritten, and the
  // profile gets a local pin exactly when its effective tier would be rejected.
  const D = DIRECT_SERVICE_TIER;
  const cases: [
    top: string | undefined,
    local: string | undefined,
    expected: string | undefined,
  ][] = [
    ["priority", undefined, D],
    [undefined, undefined, D],
    [undefined, "priority", D],
    ["flex", undefined, undefined],
    ["flex", "priority", D],
    ["priority", "flex", "flex"],
    ["default", "default", "default"],
    // Unrecognized values are the user's: never rewritten, locally or inherited.
    ["priority", "fast", "fast"],
    ["fast", undefined, undefined],
  ];
  for (const [top, local, expected] of cases) {
    writeFileSync(
      configPath,
      stringify({
        "model_provider": "openai",
        ...(top === undefined ? {} : { "service_tier": top }),
        "profiles": {
          "work": { "model": "gpt-5.5", ...(local === undefined ? {} : { "service_tier": local }) },
        },
      }),
    );
    writeWork();
    const doc = tomlAt(configPath);
    expect([
      top,
      local,
      doc.service_tier,
      doc.model_provider,
      workTable().service_tier,
      workTable().model,
    ])
      .toEqual([top, local, top, "openai", expected, "gpt-5.5"]);
  }
  // Removing the profile takes its table -- and the local pin -- with it; the
  // foreign default's line was never ours and stays.
  writeFileSync(configPath, stringify({ "model_provider": "openai", "service_tier": "priority" }));
  writeWork();
  expect(workTable().service_tier).toBe(DIRECT_SERVICE_TIER);
  removeCodexProfile(codexHome, WORK);
  expect(tomlAt(configPath).service_tier).toBe("priority");
  expect(tomlAt(configPath).profiles).toBeUndefined();
});

test("removing the default wiring keeps the inert tier pin (it may be the user's own line)", () => {
  isolate();
  const codexHome = join(dir, ".codex");
  const configPath = join(codexHome, "config.toml");
  mkdirSync(codexHome, { recursive: true });
  // The user pinned "default" themselves; the Direct write keeps it (accepted) and
  // cannot tell it from its own pin afterwards -- so removal must not delete it.
  writeFileSync(configPath, 'service_tier = "default"\n');
  configureCodexConfig(codexHome, { mode: "direct", codexExecVersion: "0.144.0", quiet: true });
  removeCodexDefaultWiring(codexHome);
  const doc = tomlAt(configPath);
  expect(doc.service_tier).toBe("default");
  expect(doc.model_provider).toBeUndefined();
  expect(doc.web_search).toBeUndefined();
});

test("syncCodexServiceTier heals a Direct config on our provider and leaves every other config alone", () => {
  isolate();
  const codexHome = join(dir, ".codex");
  process.env.CODEX_HOME = codexHome;
  const configPath = join(codexHome, "config.toml");
  mkdirSync(codexHome, { recursive: true });
  // A pre-fix Direct config (no pin), then a fast-mode `priority`: both healed.
  configureCodexConfig(codexHome, { mode: "direct", codexExecVersion: "0.144.0", quiet: true });
  for (const start of [undefined, "priority"]) {
    const doc = tomlAt(configPath);
    if (start === undefined) delete doc.service_tier;
    else doc.service_tier = start;
    writeFileSync(configPath, stringify(doc));
    syncCodexServiceTier();
    expect(tomlAt(configPath).service_tier).toBe(DIRECT_SERVICE_TIER);
  }
  // Accepted: untouched byte for byte.
  const flex = stringify({ ...tomlAt(configPath), "service_tier": "flex" });
  writeFileSync(configPath, flex);
  syncCodexServiceTier();
  expect(readFileSync(configPath, "utf8")).toBe(flex);
  // Proxy mode on our provider: untouched (the proxy strips the field).
  configureCodexConfig(codexHome, {
    mode: "proxy",
    baseUrl: "http://127.0.0.1:4141/v1",
    codexExecVersion: "0.144.0",
    quiet: true,
  });
  const proxy = stringify({ ...tomlAt(configPath), "service_tier": "priority" });
  writeFileSync(configPath, proxy);
  syncCodexServiceTier();
  expect(readFileSync(configPath, "utf8")).toBe(proxy);
  // A foreign selection beside an inactive Direct table of ours (the selector, not
  // the table's presence, decides), an unparseable config, an absent one: untouched.
  configureCodexConfig(codexHome, { mode: "direct", codexExecVersion: "0.144.0", quiet: true });
  const foreign = stringify({
    ...tomlAt(configPath),
    "model_provider": "openai",
    "service_tier": "priority",
  });
  writeFileSync(configPath, foreign);
  syncCodexServiceTier();
  expect(readFileSync(configPath, "utf8")).toBe(foreign);
  writeFileSync(configPath, "not = [toml");
  expect(() => syncCodexServiceTier()).not.toThrow();
  expect(readFileSync(configPath, "utf8")).toBe("not = [toml");
  rmSync(configPath);
  expect(() => syncCodexServiceTier()).not.toThrow();
  expect(existsSync(configPath)).toBe(false);
});

test("syncCodexServiceTier for a named profile pins profile-locally and leaves a foreign default alone", () => {
  isolate();
  const codexHome = join(dir, ".codex");
  process.env.CODEX_HOME = codexHome;
  const configPath = join(codexHome, "config.toml");
  mkdirSync(codexHome, { recursive: true });
  configureCodexConfig(codexHome, {
    mode: "direct",
    codexExecVersion: "0.144.0",
    profile: WORK,
    quiet: true,
  });
  const doc = tomlAt(configPath);
  doc.model_provider = "openai";
  doc.service_tier = "priority";
  delete asRecord(asRecord(doc.profiles).work).service_tier;
  writeFileSync(configPath, stringify(doc));
  syncCodexServiceTier(WORK);
  const healed = tomlAt(configPath);
  expect(healed.service_tier).toBe("priority");
  expect(asRecord(asRecord(healed.profiles).work).service_tier).toBe(DIRECT_SERVICE_TIER);
  // The default-selection sync does not act for a foreign default.
  syncCodexServiceTier();
  expect(tomlAt(configPath).service_tier).toBe("priority");
});

test("agent codex --check names a rejected or unpinned service_tier on a Direct config", async () => {
  isolate();
  const codexHome = join(dir, ".codex");
  process.env.CODEX_HOME = codexHome;
  const configPath = join(codexHome, "config.toml");
  mkdirSync(codexHome, { recursive: true });
  configureCodexConfig(codexHome, { mode: "direct", codexExecVersion: "0.144.0", quiet: true });
  // The verdict is informational: every case keeps the provider-mode exit code (0).
  const checkLine = async (): Promise<string | undefined> => {
    const lines: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    process.exitCode = 99;
    try {
      await runCodex({ kind: "check" }, NOOP_CATALOG_DEPS);
    } finally {
      console.log = realLog;
    }
    expect(process.exitCode).toBe(0);
    return lines.find((l) => l.startsWith("service_tier:"));
  };
  expect(await checkLine()).toBe('service_tier: "default" (accepted by Copilot Direct)');
  writeFileSync(configPath, stringify({ ...tomlAt(configPath), "service_tier": "priority" }));
  expect(await checkLine()).toContain('service_tier: "priority" (Copilot Direct rejects it');
  const doc = tomlAt(configPath);
  delete doc.service_tier;
  writeFileSync(configPath, stringify(doc));
  expect(await checkLine()).toContain("service_tier: not pinned");
  // An unrecognized value is reported as such and left alone by a rewrite.
  writeFileSync(configPath, stringify({ ...doc, "service_tier": "fast" }));
  expect(await checkLine()).toContain('service_tier: "fast" (unrecognized; left alone');
  configureCodexConfig(codexHome, { mode: "direct", codexExecVersion: "0.144.0", quiet: true });
  expect(tomlAt(configPath).service_tier).toBe("fast");
});
