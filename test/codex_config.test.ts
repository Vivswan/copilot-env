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

test("preserves unknown user keys while updating the managed base_url", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-codex-"));
  process.env.HOME = dir;
  const codexHome = join(dir, ".codex");
  mkdirSync(codexHome, { recursive: true });

  // Seed an existing config with a user-added section plus our managed provider.
  writeFileSync(
    join(codexHome, "config.toml"),
    [
      'model_provider = "copilot-api"',
      "",
      "[my_custom]",
      'keep = "me"',
      "",
      "[model_providers.copilot-api]",
      'name = "copilot-api gateway"',
      'base_url = "http://stale:1/v1"',
      'env_key = "COPILOT_API_KEY"',
      "",
    ].join("\n"),
  );

  const rc = configureCodexConfig("http://localhost:4141/v1", "secret-key", codexHome);
  expect(rc).toBe(0);

  const doc = asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8")));
  expect(asRecord(doc.my_custom).keep).toBe("me");
  const provider = asRecord(asRecord(doc.model_providers)["copilot-api"]);
  expect(provider.base_url).toBe("http://localhost:4141/v1");
  expect(provider.name).toBe("copilot-api gateway");

  expect(readFileSync(join(codexHome, ".env"), "utf8")).toBe("COPILOT_API_KEY=secret-key\n");
});

test("writes the managed default config when no provider section exists", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-codex-"));
  process.env.HOME = dir;
  const codexHome = join(dir, ".codex");

  const rc = configureCodexConfig("http://localhost:4141/v1", "k", codexHome);
  expect(rc).toBe(0);

  const doc = asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8")));
  const provider = asRecord(asRecord(doc.model_providers)["copilot-api"]);
  expect(provider.base_url).toBe("http://localhost:4141/v1");
});

test("rejects a base_url containing invalid characters", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-codex-"));
  process.env.HOME = dir;

  const rc = configureCodexConfig("http://bad url/v1", "k", join(dir, ".codex"));
  expect(rc).toBe(1);
});
