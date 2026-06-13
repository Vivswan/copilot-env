import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";

import {
  codexUserAgent,
  configureCodexConfig,
  DIRECT_ENV_KEY,
  detectCodexDirect,
  inspectCodexWiring,
  runCodex,
} from "../src/codex/config.ts";
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
  writeFileSync(join(codexHome, ".env"), "OPENAI_API_KEY=old\n");

  const rc = configureCodexConfig(codexHome, { codexExecVersion: "0.139.0" });
  expect(rc).toBe(0);

  const doc = asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8")));
  expect(asRecord(doc.my_custom).keep).toBe("me");
  expect(doc.model_provider).toBe("copilot-env");
  expect(doc.web_search).toBe("live");
  // Direct disables image generation via a top-level [features] table.
  expect(asRecord(doc.features).image_generation).toBe(false);

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
  expect(auth.timeout_ms).toBe(15000);
  expect(auth.refresh_interval_ms).toBe(300000);
  // No baked token at rest.
  expect(provider.env_key).toBeUndefined();

  const other = asRecord(asRecord(doc.model_providers).other);
  expect(other.base_url).toBe("http://other/v1");
  expect(other.env_key).toBe("OTHER_KEY");

  // Direct resolves via auth.command; any stale proxy OPENAI_API_KEY in .env is scrubbed.
  expect(readFileSync(join(codexHome, ".env"), "utf8")).toBe("");
});

test("direct uses the launcher auth.command (no env_key, no token at rest), classified direct", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-codex-"));
  process.env.HOME = dir;
  const codexHome = join(dir, ".codex");

  const rc = configureCodexConfig(codexHome, { codexExecVersion: "0.139.0" });
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

  configureCodexConfig(codexHome, {}); // gh-direct

  const env = readFileSync(join(codexHome, ".env"), "utf8");
  expect(env).toContain("MY_VAR=keep");
  expect(env).not.toContain(DIRECT_ENV_KEY);

  // A second gh-direct home with no .env at all: the scrub must not create one.
  const codexHome2 = join(dir, ".codex2");
  configureCodexConfig(codexHome2, {});
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

  const rc = configureCodexConfig(codexHome, {
    proxy: true,
    baseUrl: "http://localhost:4141/v1",
  });
  expect(rc).toBe(0);

  const doc = asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8")));
  // Unknown user content survives, and our proxy is reselected as default.
  expect(asRecord(doc.my_custom).keep).toBe("me");
  expect(doc.model_provider).toBe("copilot-env");

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

  // A second, unrelated provider table is left fully intact.
  const other = asRecord(asRecord(doc.model_providers).other);
  expect(other.base_url).toBe("http://other/v1");
  expect(other.env_key).toBe("OTHER_KEY");

  // No key is baked into .env (resolved at runtime by auth.command).
  expect(existsSync(join(codexHome, ".env"))).toBe(false);
});

test("proxy mode scrubs a stale OPENAI_API_KEY from .env, preserving other lines", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-codex-"));
  process.env.HOME = dir;
  const codexHome = join(dir, ".codex");
  mkdirSync(codexHome, { recursive: true });

  // A .env left by the old env_key wiring (incl. a look-alike + commented key + an
  // `export` form). Proxy now resolves via auth.command, so the real OPENAI_API_KEY
  // assignments are scrubbed while everything else survives.
  writeFileSync(
    join(codexHome, ".env"),
    [
      "# my secrets",
      "FOO=bar",
      "OPENAI_API_KEY_SUFFIX=keep",
      "#OPENAI_API_KEY=disabled",
      "export OPENAI_API_KEY=old1",
      "OPENAI_API_KEY=old2",
      "",
    ].join("\n"),
  );

  expect(
    configureCodexConfig(codexHome, { proxy: true, baseUrl: "http://localhost:4141/v1" }),
  ).toBe(0);

  expect(readFileSync(join(codexHome, ".env"), "utf8")).toBe(
    ["# my secrets", "FOO=bar", "OPENAI_API_KEY_SUFFIX=keep", "#OPENAI_API_KEY=disabled", ""].join(
      "\n",
    ),
  );
});

test("writes the managed direct default config when no provider section exists", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-codex-"));
  process.env.HOME = dir;
  const codexHome = join(dir, ".codex");

  const rc = configureCodexConfig(codexHome, { codexExecVersion: "0.139.0" });
  expect(rc).toBe(0);

  const doc = asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8")));
  expect(doc.model_provider).toBe("copilot-env");
  expect(doc.web_search).toBe("live");
  expect(asRecord(doc.features).image_generation).toBe(false);
  const provider = asRecord(asRecord(doc.model_providers)["copilot-env"]);
  expect(provider.base_url).toBe("https://api.githubcopilot.com");
  expect(provider.supports_websockets).toBe(false);
  expect(existsSync(join(codexHome, ".env"))).toBe(false);
});

test("formats Codex user-agent with dynamic version fallback", () => {
  expect(codexUserAgent("0.139.0")).toBe("codex_exec/0.139.0");
  expect(codexUserAgent(null)).toBe("codex_exec");
});

test("runCodex --proxy writes the proxy provider at CODEX_HOME", () => {
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

  runCodex({ proxy: true });

  const doc = asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8")));
  expect(doc.model_provider).toBe("copilot-env");
  const provider = asRecord(asRecord(doc.model_providers)["copilot-env"]);
  expect(provider.base_url).toBe("http://localhost:4141/v1");
  // Proxy resolves the key at runtime via auth.command; nothing is baked into .env.
  expect(provider.env_key).toBeUndefined();
  expect(asRecord(provider.auth).command).toBe(proxyTokenCommand().command);
  expect(asRecord(provider.auth).args).toEqual(proxyTokenCommand().args);
  expect(existsSync(join(codexHome, ".env"))).toBe(false);
});

test("runCodex --proxy and --direct force the selected provider (no probe)", () => {
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

  runCodex({ proxy: true });
  let doc = asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8")));
  expect(doc.model_provider).toBe("copilot-env");
  expect(asRecord(asRecord(doc.model_providers)["copilot-env"]).base_url).toBe(
    "http://localhost:4141/v1",
  );

  runCodex({ direct: true });
  doc = asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8")));
  expect(doc.model_provider).toBe("copilot-env");
  const directProvider = asRecord(asRecord(doc.model_providers)["copilot-env"]);
  expect(directProvider.base_url).toBe("https://api.githubcopilot.com");
  // Toggling proxy -> direct must leave NO stale proxy-only key on the shared table.
  expect(directProvider.env_key).toBeUndefined();

  expect(() => runCodex({ proxy: true, direct: true })).toThrow(
    "--direct and --proxy are mutually exclusive",
  );
});

test("toggling direct <-> proxy swaps the mode-specific keys on the shared table", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-codex-"));
  process.env.HOME = dir;
  const codexHome = join(dir, ".codex");

  // Start direct: the table carries the managed auth (agent auth --get) + http_headers.
  expect(configureCodexConfig(codexHome, { codexExecVersion: "0.139.0" })).toBe(0);
  let provider = asRecord(
    asRecord(asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8"))).model_providers)[
      "copilot-env"
    ],
  );
  expect(asRecord(provider.auth).args).toEqual(["auth", "--get"]);
  expect(provider.http_headers).toBeDefined();

  // Switch to proxy on the SAME table: the proxy auth (/bin/sh -c ensure + print)
  // replaces the direct auth, env_key stays absent, and direct-only http_headers is
  // scrubbed.
  expect(
    configureCodexConfig(codexHome, {
      proxy: true,
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

  const rc = configureCodexConfig(join(dir, ".codex"), {
    proxy: true,
    baseUrl: "http://bad url/v1",
  });
  expect(rc).toBe(1);
});
