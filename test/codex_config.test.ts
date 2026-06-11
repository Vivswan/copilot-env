import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
      "[model_providers.github-copilot-direct]",
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
  expect(doc.model_provider).toBe("github-copilot-direct");
  expect(doc.web_search).toBe("live");
  // Direct disables image generation via a top-level [features] table.
  expect(asRecord(doc.features).image_generation).toBe(false);

  const provider = asRecord(asRecord(doc.model_providers)["github-copilot-direct"]);
  expect(provider.name).toBe("GitHub Copilot Direct");
  expect(provider.base_url).toBe("https://api.githubcopilot.com");
  expect(provider.wire_api).toBe("responses");
  expect(provider.supports_websockets).toBe(false);
  expect(provider.requires_openai_auth).toBe(false);
  expect(provider.user_extra).toBe("kept");

  const headers = asRecord(provider.http_headers);
  expect(headers["Openai-Intent"]).toBe("conversation-edits");
  expect(headers["User-Agent"]).toBe("codex_exec/0.139.0");

  const auth = asRecord(provider.auth);
  expect(auth.command).toBe("gh");
  expect(auth.args).toEqual(["auth", "token"]);
  expect(auth.timeout_ms).toBe(5000);
  expect(auth.refresh_interval_ms).toBe(300000);

  const other = asRecord(asRecord(doc.model_providers).other);
  expect(other.base_url).toBe("http://other/v1");
  expect(other.env_key).toBe("OTHER_KEY");

  expect(readFileSync(join(codexHome, ".env"), "utf8")).toBe("OPENAI_API_KEY=old\n");
});

test("direct + baked gh-token: env_key (no auth block) + the token in .env (0600), still direct", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-codex-"));
  process.env.HOME = dir;
  const codexHome = join(dir, ".codex");

  const rc = configureCodexConfig(codexHome, { ghToken: "ghu_baked", codexExecVersion: "0.139.0" });
  expect(rc).toBe(0);

  const doc = asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8")));
  expect(doc.model_provider).toBe("github-copilot-direct");
  const provider = asRecord(asRecord(doc.model_providers)["github-copilot-direct"]);
  // Token mode reads the bearer from a dedicated env_key, and drops the gh `auth` block.
  expect(provider.env_key).toBe(DIRECT_ENV_KEY);
  expect(provider.auth).toBeUndefined();
  // The dedicated key must NOT be a standard GitHub var (so it can't shadow gh/git).
  expect(DIRECT_ENV_KEY).not.toBe("GITHUB_TOKEN");
  expect(DIRECT_ENV_KEY).not.toBe("GH_TOKEN");

  // The token lives in CODEX_HOME's .env (0600), under the dedicated key.
  const envText = readFileSync(join(codexHome, ".env"), "utf8");
  expect(envText).toContain(`${DIRECT_ENV_KEY}=ghu_baked`);
  if (process.platform !== "win32") {
    expect(statSync(join(codexHome, ".env")).mode & 0o077).toBe(0);
  }

  // Wiring still classifies as direct, and flags the token path.
  const wiring = inspectCodexWiring(
    readFileSync(join(codexHome, "config.toml"), "utf8"),
    envText,
    4141,
    false,
  );
  expect(wiring.providerMode).toBe("direct");
  expect(wiring.directUsesToken).toBe(true);
});

test("switching direct token -> direct gh (no token) drops the stale env_key and restores auth", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-codex-"));
  process.env.HOME = dir;
  const codexHome = join(dir, ".codex");

  configureCodexConfig(codexHome, { ghToken: "ghu_baked" });
  // Sanity: the baked token landed in .env first.
  expect(readFileSync(join(codexHome, ".env"), "utf8")).toContain(`${DIRECT_ENV_KEY}=ghu_baked`);

  configureCodexConfig(codexHome, {}); // plain direct, no token

  const doc = asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8")));
  const provider = asRecord(asRecord(doc.model_providers)["github-copilot-direct"]);
  expect(provider.env_key).toBeUndefined(); // stale token key removed
  expect(asRecord(provider.auth).command).toBe("gh"); // gh auth restored
  // The baked token is scrubbed from .env — no Copilot token left at rest.
  expect(readFileSync(join(codexHome, ".env"), "utf8")).not.toContain(DIRECT_ENV_KEY);
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
    apiKey: "secret-key",
  });
  expect(rc).toBe(0);

  const doc = asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8")));
  // Unknown user content survives, and our proxy is reselected as default.
  expect(asRecord(doc.my_custom).keep).toBe("me");
  expect(doc.model_provider).toBe("copilot-env");

  const provider = asRecord(asRecord(doc.model_providers)["copilot-env"]);
  expect(provider.base_url).toBe("http://localhost:4141/v1");
  expect(provider.name).toBe("copilot-env");
  expect(provider.env_key).toBe("OPENAI_API_KEY"); // stale value corrected
  expect(provider.wire_api).toBe("responses"); // missing managed field filled
  expect(provider.requires_openai_auth).toBe(false);
  expect(provider.supports_websockets).toBe(false);
  expect(provider.user_extra).toBe("kept"); // user-added key in the table survives

  // A second, unrelated provider table is left fully intact.
  const other = asRecord(asRecord(doc.model_providers).other);
  expect(other.base_url).toBe("http://other/v1");
  expect(other.env_key).toBe("OTHER_KEY");

  expect(readFileSync(join(codexHome, ".env"), "utf8")).toBe("OPENAI_API_KEY=secret-key\n");
});

test("replaces OPENAI_API_KEY in .env in place, preserving other lines", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-codex-"));
  process.env.HOME = dir;
  const codexHome = join(dir, ".codex");
  mkdirSync(codexHome, { recursive: true });

  writeFileSync(
    join(codexHome, ".env"),
    ["# my secrets", "FOO=bar", "OPENAI_API_KEY=old", "BAZ=qux", ""].join("\n"),
  );

  const rc = configureCodexConfig(codexHome, {
    proxy: true,
    baseUrl: "http://localhost:4141/v1",
    apiKey: "fresh-key",
  });
  expect(rc).toBe(0);

  // Comment + unrelated vars survive; OPENAI_API_KEY is updated in place.
  expect(readFileSync(join(codexHome, ".env"), "utf8")).toBe(
    ["# my secrets", "FOO=bar", "OPENAI_API_KEY=fresh-key", "BAZ=qux", ""].join("\n"),
  );
});

test("appends OPENAI_API_KEY to an existing .env that lacks it", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-codex-"));
  process.env.HOME = dir;
  const codexHome = join(dir, ".codex");
  mkdirSync(codexHome, { recursive: true });

  writeFileSync(join(codexHome, ".env"), ["FOO=bar", ""].join("\n"));

  const rc = configureCodexConfig(codexHome, {
    proxy: true,
    baseUrl: "http://localhost:4141/v1",
    apiKey: "k",
  });
  expect(rc).toBe(0);

  expect(readFileSync(join(codexHome, ".env"), "utf8")).toBe(
    ["FOO=bar", "OPENAI_API_KEY=k", ""].join("\n"),
  );
});

test("dedups duplicates, leaves look-alike/commented keys, normalizes CRLF", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-codex-"));
  process.env.HOME = dir;
  const codexHome = join(dir, ".codex");
  mkdirSync(codexHome, { recursive: true });

  // CRLF input with a comment, a look-alike key (must NOT match), a commented
  // key, an `export ` assignment, and a later duplicate assignment.
  writeFileSync(
    join(codexHome, ".env"),
    "# c\r\nOPENAI_API_KEY_SUFFIX=keep\r\n#OPENAI_API_KEY=disabled\r\nexport OPENAI_API_KEY=old1\r\nOPENAI_API_KEY=old2\r\n",
  );

  expect(
    configureCodexConfig(codexHome, {
      proxy: true,
      baseUrl: "http://localhost:4141/v1",
      apiKey: "K",
    }),
  ).toBe(0);

  // The first (export) assignment is replaced in place, the later duplicate is
  // dropped, look-alike/commented/comment lines survive, and CRLF -> "\n".
  expect(readFileSync(join(codexHome, ".env"), "utf8")).toBe(
    ["# c", "OPENAI_API_KEY_SUFFIX=keep", "#OPENAI_API_KEY=disabled", "OPENAI_API_KEY=K", ""].join(
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
  expect(doc.model_provider).toBe("github-copilot-direct");
  expect(doc.web_search).toBe("live");
  expect(asRecord(doc.features).image_generation).toBe(false);
  const provider = asRecord(asRecord(doc.model_providers)["github-copilot-direct"]);
  expect(provider.base_url).toBe("https://api.githubcopilot.com");
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
  expect(readFileSync(join(codexHome, ".env"), "utf8")).toContain("OPENAI_API_KEY=");
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
      'model_provider = "github-copilot-direct"',
      "",
      "[model_providers.github-copilot-direct]",
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
  expect(doc.model_provider).toBe("github-copilot-direct");
  expect(asRecord(asRecord(doc.model_providers)["github-copilot-direct"]).base_url).toBe(
    "https://api.githubcopilot.com",
  );

  expect(() => runCodex({ proxy: true, direct: true })).toThrow(
    "--direct, --proxy, and --auto are mutually exclusive",
  );
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
    apiKey: "k",
  });
  expect(rc).toBe(1);
});
