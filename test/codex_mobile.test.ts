import { expect, test } from "bun:test";
import { parse } from "smol-toml";

import {
  readModelProvider,
  restoreModelProvider,
  stripModelProvider,
} from "../src/codex/mobile.ts";

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new Error("expected an object");
  return value as Record<string, unknown>;
}

const CONFIG = [
  'model_provider = "copilot-env"',
  'web_search = "live"',
  "",
  "[my_custom]",
  'keep = "me"',
  "",
  "[model_providers.copilot-env]",
  'base_url = "http://localhost:4141/v1"',
  'env_key = "OPENAI_API_KEY"',
  "requires_openai_auth = true",
  "",
  "[model_providers.other]",
  'base_url = "https://api.githubcopilot.com"',
  "",
].join("\n");

test("readModelProvider returns the configured provider, null when absent/malformed", () => {
  expect(readModelProvider(CONFIG)).toBe("copilot-env");
  expect(readModelProvider('web_search = "live"\n')).toBe(null);
  expect(readModelProvider("{ not toml")).toBe(null);
});

test("stripModelProvider removes model_provider, forces requires_openai_auth=false, keeps the rest", () => {
  const doc = asRecord(parse(stripModelProvider(CONFIG)));
  // model_provider gone; unrelated keys/sections preserved.
  expect(doc.model_provider).toBeUndefined();
  expect(doc.web_search).toBe("live");
  expect(asRecord(doc.my_custom).keep).toBe("me");
  // requires_openai_auth flipped to false on our managed table (was true).
  const providers = asRecord(doc.model_providers);
  expect(asRecord(providers["copilot-env"]).requires_openai_auth).toBe(false);
  // The provider tables themselves survive.
  expect(asRecord(providers["copilot-env"]).base_url).toBe("http://localhost:4141/v1");
  expect(asRecord(providers["other"]).base_url).toBe("https://api.githubcopilot.com");
});

test("restoreModelProvider puts the provider back and round-trips through strip", () => {
  const stripped = stripModelProvider(CONFIG);
  expect(readModelProvider(stripped)).toBe(null);
  const restored = restoreModelProvider(stripped, "copilot-env");
  expect(readModelProvider(restored)).toBe("copilot-env");
  // requires_openai_auth stays false after restore.
  const doc = asRecord(parse(restored));
  expect(asRecord(asRecord(doc.model_providers)["copilot-env"]).requires_openai_auth).toBe(false);
});
