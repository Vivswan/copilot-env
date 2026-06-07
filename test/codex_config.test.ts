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
