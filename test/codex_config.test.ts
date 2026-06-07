import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";

import { configureCodexConfig } from "../src/commands/codex_config.ts";

const SAVED_HOME = process.env.HOME;
let dir = "";

afterEach(() => {
  if (SAVED_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = SAVED_HOME;
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

  const rc = configureCodexConfig("http://localhost:4141/v1", "secret-key", codexHome);
  expect(rc).toBe(0);

  const doc = asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8")));
  // Unknown user content survives, and our gateway is reselected as default.
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

  const rc = configureCodexConfig("http://localhost:4141/v1", "fresh-key", codexHome);
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

  const rc = configureCodexConfig("http://localhost:4141/v1", "k", codexHome);
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

  expect(configureCodexConfig("http://localhost:4141/v1", "K", codexHome)).toBe(0);

  // The first (export) assignment is replaced in place, the later duplicate is
  // dropped, look-alike/commented/comment lines survive, and CRLF -> "\n".
  expect(readFileSync(join(codexHome, ".env"), "utf8")).toBe(
    ["# c", "OPENAI_API_KEY_SUFFIX=keep", "#OPENAI_API_KEY=disabled", "OPENAI_API_KEY=K", ""].join(
      "\n",
    ),
  );
});

test("writes the managed default config when no provider section exists", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-codex-"));
  process.env.HOME = dir;
  const codexHome = join(dir, ".codex");

  const rc = configureCodexConfig("http://localhost:4141/v1", "k", codexHome);
  expect(rc).toBe(0);

  const doc = asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8")));
  const provider = asRecord(asRecord(doc.model_providers)["copilot-env"]);
  expect(provider.base_url).toBe("http://localhost:4141/v1");
});

test("rejects a base_url containing invalid characters", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-codex-"));
  process.env.HOME = dir;

  const rc = configureCodexConfig("http://bad url/v1", "k", join(dir, ".codex"));
  expect(rc).toBe(1);
});
