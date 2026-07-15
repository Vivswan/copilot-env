import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { NOOP_CATALOG_DEPS } from "../src/codex/catalog.ts";
import {
  codexUserAgent,
  configureCodexConfig,
  DIRECT_ENV_KEY,
  detectCodexDirect,
  inspectCodexWiring,
  runCodex,
  syncCodexCatalogReference,
} from "../src/codex/config.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { CopilotApiPaths } from "../src/copilot_api/paths.ts";
import { agentLauncherCommand, proxyTokenCommand } from "../src/utils/root.ts";

const SAVED_HOME = process.env.HOME;
const SAVED_CODEX_HOME = process.env.CODEX_HOME;
const SAVED_COPILOT_API_HOME = process.env.COPILOT_API_HOME;
let dir = "";

afterEach(() => {
  if (SAVED_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = SAVED_HOME;
  }
  if (SAVED_CODEX_HOME === undefined) {
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = SAVED_CODEX_HOME;
  }
  if (SAVED_COPILOT_API_HOME === undefined) {
    delete process.env.COPILOT_API_HOME;
  } else {
    process.env.COPILOT_API_HOME = SAVED_COPILOT_API_HOME;
  }
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

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
  dir = mkdtempSync(join(tmpdir(), "copilot-codex-"));
  process.env.HOME = dir;
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

  const rc = configureCodexConfig(codexHome, "direct", { codexExecVersion: "0.139.0" });
  expect(rc).toBe(0);

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

test("direct uses the launcher auth.command (no env_key, no token at rest), classified direct", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-codex-"));
  process.env.HOME = dir;
  const codexHome = join(dir, ".codex");

  const rc = configureCodexConfig(codexHome, "direct", { codexExecVersion: "0.139.0" });
  expect(rc).toBe(0);

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
  dir = mkdtempSync(join(tmpdir(), "copilot-codex-"));
  process.env.HOME = dir;
  const codexHome = join(dir, ".codex");
  mkdirSync(codexHome, { recursive: true });
  // A user-maintained .env with our baked token plus an unrelated key.
  writeFileSync(join(codexHome, ".env"), `MY_VAR=keep\n${DIRECT_ENV_KEY}=ghu_old\n`);

  configureCodexConfig(codexHome, "direct", {}); // gh-direct

  const env = readFileSync(join(codexHome, ".env"), "utf8");
  expect(env).toContain("MY_VAR=keep");
  expect(env).not.toContain(DIRECT_ENV_KEY);

  // A second gh-direct home with no .env at all: the scrub must not create one.
  const codexHome2 = join(dir, ".codex2");
  configureCodexConfig(codexHome2, "direct", {});
  expect(existsSync(join(codexHome2, ".env"))).toBe(false);
});

test("proxy mode enforces every managed field while preserving unknown user keys", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-codex-"));
  process.env.HOME = dir;
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

  const rc = configureCodexConfig(codexHome, "proxy", {
    baseUrl: "http://localhost:4141/v1",
  });
  expect(rc).toBe(0);

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
  dir = mkdtempSync(join(tmpdir(), "copilot-codex-"));
  process.env.HOME = dir;
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
    configureCodexConfig(codexHome, "proxy", { baseUrl: "http://localhost:4141/v1" }),
  ).toThrow(/not valid TOML|refusing to overwrite/);
  // The user's file is left exactly as it was.
  expect(readFileSync(configPath, "utf8")).toBe(original);
});

test("proxy mode preserves the user's OPENAI_API_KEY but scrubs the copilot-env legacy key", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-codex-"));
  process.env.HOME = dir;
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

  expect(configureCodexConfig(codexHome, "proxy", { baseUrl: "http://localhost:4141/v1" })).toBe(0);

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
  dir = mkdtempSync(join(tmpdir(), "copilot-codex-"));
  process.env.HOME = dir;
  const codexHome = join(dir, ".codex");

  const rc = configureCodexConfig(codexHome, "direct", { codexExecVersion: "0.139.0" });
  expect(rc).toBe(0);

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
  expect(codexUserAgent(null)).toBe("codex_exec");
});

test("runCodex --proxy writes the proxy provider at CODEX_HOME", async () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-codex-"));
  process.env.HOME = dir;
  process.env.COPILOT_API_HOME = join(dir, "copilot-api-home");
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

  await runCodex({ proxy: true }, NOOP_CATALOG_DEPS);

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
  dir = mkdtempSync(join(tmpdir(), "copilot-codex-"));
  process.env.HOME = dir;
  process.env.COPILOT_API_HOME = join(dir, "copilot-api-home");
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

  await runCodex({ proxy: true }, NOOP_CATALOG_DEPS);
  let doc = asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8")));
  expect(doc.model_provider).toBe("copilot-env");
  expect(asRecord(asRecord(doc.model_providers)["copilot-env"]).base_url).toBe(
    "http://127.0.0.1:4141/v1",
  );

  await runCodex({ direct: true }, NOOP_CATALOG_DEPS);
  doc = asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8")));
  expect(doc.model_provider).toBe("copilot-env");
  const directProvider = asRecord(asRecord(doc.model_providers)["copilot-env"]);
  expect(directProvider.base_url).toBe("https://api.githubcopilot.com");
  // Toggling proxy -> direct must leave NO stale proxy-only key on the shared table.
  expect(directProvider.env_key).toBeUndefined();

  await expect(runCodex({ proxy: true, direct: true }, NOOP_CATALOG_DEPS)).rejects.toThrow(
    "--direct and --proxy are mutually exclusive",
  );
});

test("toggling direct <-> proxy swaps the mode-specific keys on the shared table", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-codex-"));
  process.env.HOME = dir;
  const codexHome = join(dir, ".codex");

  // Start direct: the table carries the managed auth (agent auth --get) + http_headers.
  expect(configureCodexConfig(codexHome, "direct", { codexExecVersion: "0.139.0" })).toBe(0);
  let provider = asRecord(
    asRecord(asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8"))).model_providers)[
      "copilot-env"
    ],
  );
  expect(asRecord(provider.auth).args).toEqual(agentLauncherCommand(["auth", "--get"]).args);
  expect(provider.http_headers).toBeDefined();

  // Switch to proxy on the SAME table: the proxy auth (/bin/sh -c ensure + print)
  // replaces the direct auth, env_key stays absent, and direct-only http_headers is
  // scrubbed.
  expect(
    configureCodexConfig(codexHome, "proxy", {
      baseUrl: "http://localhost:4141/v1",
    }),
  ).toBe(0);
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
  dir = mkdtempSync(join(tmpdir(), "copilot-codex-"));
  process.env.HOME = dir;
  // A runProbe spy lets us prove the cheap gates short-circuit BEFORE the (here
  // simulated) model call.
  let probeCalls = 0;
  const ok = {
    resolveCommand: (c: string) => `/bin/${c}`,
    ghAuthOk: () => true,
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
    detectCodexDirect({ ...ok, resolveCommand: (c) => (c === "codex" ? null : `/bin/${c}`) }),
  ).toBe(false);
  expect(
    detectCodexDirect({ ...ok, resolveCommand: (c) => (c === "gh" ? null : `/bin/${c}`) }),
  ).toBe(false);
  expect(probeCalls).toBe(0);
});

test("proxy mode rejects a base_url containing invalid characters", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-codex-"));
  process.env.HOME = dir;

  const rc = configureCodexConfig(join(dir, ".codex"), "proxy", {
    baseUrl: "http://bad url/v1",
  });
  expect(rc).toBe(1);
});

test("model_catalog_json is written when enabled and the catalog file exists (both modes)", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-codex-"));
  process.env.HOME = dir;
  process.env.COPILOT_API_HOME = join(dir, "copilot-api-home");
  const codexHome = join(dir, ".codex");
  const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
  mkdirSync(join(dir, "copilot-api-home"), { recursive: true });
  enableCatalog();
  writeFileSync(catalogFile, '{"models":[{"slug":"gpt-5.5"}]}\n');

  expect(configureCodexConfig(codexHome, "direct", { codexExecVersion: "0.144.0" })).toBe(0);
  let doc = asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8")));
  expect(doc.model_catalog_json).toBe(catalogFile);

  expect(
    configureCodexConfig(codexHome, "proxy", {
      baseUrl: "http://127.0.0.1:4141/v1",
      codexExecVersion: "0.144.0",
    }),
  ).toBe(0);
  doc = asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8")));
  expect(doc.model_catalog_json).toBe(catalogFile);
});

test("a stale model_catalog_json is scrubbed when the catalog file is absent", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-codex-"));
  process.env.HOME = dir;
  process.env.COPILOT_API_HOME = join(dir, "copilot-api-home"); // no catalog file here
  const codexHome = join(dir, ".codex");
  mkdirSync(codexHome, { recursive: true });
  enableCatalog();
  // Pre-seed a config referencing a catalog that no longer exists: a dangling
  // model_catalog_json is a Codex STARTUP error, so the write must scrub it.
  writeFileSync(
    join(codexHome, "config.toml"),
    ['model_catalog_json = "/nonexistent/codex-model-catalog.json"', ""].join("\n"),
  );

  expect(configureCodexConfig(codexHome, "direct", { codexExecVersion: "0.144.0" })).toBe(0);
  const doc = asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8")));
  expect(doc.model_catalog_json).toBeUndefined();
});

test("a corrupt or empty catalog file is scrubbed like a missing one", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-codex-"));
  process.env.HOME = dir;
  process.env.COPILOT_API_HOME = join(dir, "copilot-api-home");
  const codexHome = join(dir, ".codex");
  const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
  mkdirSync(join(dir, "copilot-api-home"), { recursive: true });
  enableCatalog();
  // Referencing a file Codex cannot parse is a startup error, same as a
  // dangling path -- usability, not existence, gates the key.
  writeFileSync(catalogFile, "{ corrupt");

  expect(configureCodexConfig(codexHome, "direct", { codexExecVersion: "0.144.0" })).toBe(0);
  const doc = asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8")));
  expect(doc.model_catalog_json).toBeUndefined();
});

test("syncCodexCatalogReference self-heals a managed config missing the key", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-codex-"));
  process.env.HOME = dir;
  process.env.COPILOT_API_HOME = join(dir, "copilot-api-home");
  const codexHome = join(dir, ".codex");
  process.env.CODEX_HOME = codexHome;
  const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
  mkdirSync(join(dir, "copilot-api-home"), { recursive: true });
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
  dir = mkdtempSync(join(tmpdir(), "copilot-codex-"));
  process.env.HOME = dir;
  process.env.COPILOT_API_HOME = join(dir, "copilot-api-home");
  const codexHome = join(dir, ".codex");
  process.env.CODEX_HOME = codexHome;
  const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
  mkdirSync(join(dir, "copilot-api-home"), { recursive: true });
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
  dir = mkdtempSync(join(tmpdir(), "copilot-codex-"));
  process.env.HOME = dir;
  process.env.COPILOT_API_HOME = join(dir, "copilot-api-home");
  const codexHome = join(dir, ".codex");
  process.env.CODEX_HOME = codexHome;
  mkdirSync(join(dir, "copilot-api-home"), { recursive: true });
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
  dir = mkdtempSync(join(tmpdir(), "copilot-codex-"));
  process.env.HOME = dir;
  process.env.COPILOT_API_HOME = join(dir, "copilot-api-home");
  const codexHome = join(dir, ".codex");
  const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
  mkdirSync(join(dir, "copilot-api-home"), { recursive: true });
  // Opt-in NOT set: a perfectly usable file must still not be referenced.
  writeFileSync(catalogFile, '{"models":[{"slug":"gpt-5.5"}]}\n');
  mkdirSync(codexHome, { recursive: true });
  // stringify, not a hand-written template: a raw Windows path inside a TOML
  // basic string reads as escape sequences.
  writeFileSync(join(codexHome, "config.toml"), stringify({ "model_catalog_json": catalogFile }));

  expect(configureCodexConfig(codexHome, "direct", { codexExecVersion: "0.144.0" })).toBe(0);
  const doc = asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8")));
  expect(doc.model_catalog_json).toBeUndefined();
});

test("disabled: sync strips our reference, deletes the file, and clears the throttle state", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-codex-"));
  process.env.HOME = dir;
  process.env.COPILOT_API_HOME = join(dir, "copilot-api-home");
  const codexHome = join(dir, ".codex");
  process.env.CODEX_HOME = codexHome;
  const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
  mkdirSync(join(dir, "copilot-api-home"), { recursive: true });
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
  dir = mkdtempSync(join(tmpdir(), "copilot-codex-"));
  process.env.HOME = dir;
  process.env.COPILOT_API_HOME = join(dir, "copilot-api-home");
  const codexHome = join(dir, ".codex");
  process.env.CODEX_HOME = codexHome;
  const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
  mkdirSync(join(dir, "copilot-api-home"), { recursive: true });
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

test("disabled: a user-pinned custom catalog path survives, but our file still goes", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-codex-"));
  process.env.HOME = dir;
  process.env.COPILOT_API_HOME = join(dir, "copilot-api-home");
  const codexHome = join(dir, ".codex");
  process.env.CODEX_HOME = codexHome;
  const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
  mkdirSync(join(dir, "copilot-api-home"), { recursive: true });
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
  dir = mkdtempSync(join(tmpdir(), "copilot-codex-"));
  process.env.HOME = dir;
  process.env.COPILOT_API_HOME = join(dir, "copilot-api-home");
  const codexHome = join(dir, ".codex");
  process.env.CODEX_HOME = codexHome;
  mkdirSync(join(dir, "copilot-api-home"), { recursive: true });
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
  dir = mkdtempSync(join(tmpdir(), "copilot-codex-"));
  process.env.HOME = dir;
  process.env.COPILOT_API_HOME = join(dir, "copilot-api-home");
  const codexHome = join(dir, ".codex");
  process.env.CODEX_HOME = codexHome;
  const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
  mkdirSync(join(dir, "copilot-api-home"), { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(catalogFile, '{"models":[{"slug":"gpt-5.5"}]}');
  // Unparseable TOML: it MIGHT still reference the file, so deletion must wait.
  writeFileSync(join(codexHome, "config.toml"), "model_catalog_json = [unclosed");

  syncCodexCatalogReference();

  expect(existsSync(catalogFile)).toBe(true);
});

test("disabled: a symlinked spelling of our path blocks deletion (fail closed)", () => {
  if (process.platform === "win32") return; // symlink creation needs privileges there
  dir = mkdtempSync(join(tmpdir(), "copilot-codex-"));
  process.env.HOME = dir;
  process.env.COPILOT_API_HOME = join(dir, "copilot-api-home");
  const codexHome = join(dir, ".codex");
  process.env.CODEX_HOME = codexHome;
  const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
  mkdirSync(join(dir, "copilot-api-home"), { recursive: true });
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
