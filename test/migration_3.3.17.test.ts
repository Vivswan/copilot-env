import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";

import { migration } from "../src/migrations/3.3.17.ts";

// The 3.3.17 migration removes the managed image_generation = false that older
// direct-mode writers put in the Codex config (Copilot Direct serves image
// generation now). It has filesystem side effects, so it is isolated under a
// temp CODEX_HOME.
const SAVED = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME };
let dir = "";

afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

function isolate(): string {
  dir = mkdtempSync(join(tmpdir(), "copilot-mig3317-"));
  process.env.HOME = dir;
  const codexHome = join(dir, ".codex");
  process.env.CODEX_HOME = codexHome;
  mkdirSync(codexHome, { recursive: true });
  return codexHome;
}

function writeCodex(
  codexHome: string,
  featureLines: string[],
  opts: { managed?: boolean; selected?: boolean } = {},
): string {
  const { managed = true, selected = true } = opts;
  const p = join(codexHome, "config.toml");
  const providerTable = managed ? "[model_providers.copilot-env]" : "[model_providers.other]";
  writeFileSync(
    p,
    [
      `model_provider = "${selected ? "copilot-env" : "other"}"`,
      "",
      ...featureLines,
      providerTable,
      'base_url = "https://api.githubcopilot.com"',
      'wire_api = "responses"',
      "",
    ].join("\n"),
  );
  return p;
}

function asRecord(v: unknown): Record<string, unknown> {
  expect(v).toBeDefined();
  expect(typeof v).toBe("object");
  return v as Record<string, unknown>;
}

test("removes the stale disable and drops the then-empty [features] table", () => {
  const codexHome = isolate();
  const p = writeCodex(codexHome, ["[features]", "image_generation = false", ""]);
  void migration.run();
  const doc = asRecord(parse(readFileSync(p, "utf8")));
  expect(doc.features).toBeUndefined();
  // Unrelated fields survive the targeted edit.
  expect(doc.model_provider).toBe("copilot-env");
  expect(asRecord(asRecord(doc.model_providers)["copilot-env"]).wire_api).toBe("responses");
});

test("keeps the [features] table when a user-added key remains", () => {
  const codexHome = isolate();
  const p = writeCodex(codexHome, [
    "[features]",
    "image_generation = false",
    "user_feature = true",
    "",
  ]);
  void migration.run();
  const doc = asRecord(parse(readFileSync(p, "utf8")));
  expect(asRecord(doc.features).image_generation).toBeUndefined();
  expect(asRecord(doc.features).user_feature).toBe(true);
});

test("a config without the stale disable is left byte-identical (idempotent)", () => {
  const codexHome = isolate();
  const p = writeCodex(codexHome, []);
  const before = readFileSync(p, "utf8");
  void migration.run();
  expect(readFileSync(p, "utf8")).toBe(before);
});

test("a user-set image_generation = true is not scrubbed", () => {
  const codexHome = isolate();
  const p = writeCodex(codexHome, ["[features]", "image_generation = true", ""]);
  const before = readFileSync(p, "utf8");
  void migration.run();
  expect(readFileSync(p, "utf8")).toBe(before);
});

test("a non-managed config (no copilot-env provider table) is left untouched", () => {
  const codexHome = isolate();
  const p = writeCodex(codexHome, ["[features]", "image_generation = false", ""], {
    managed: false,
  });
  const before = readFileSync(p, "utf8");
  void migration.run();
  expect(readFileSync(p, "utf8")).toBe(before);
});

test("our table present but another provider selected is left untouched", () => {
  const codexHome = isolate();
  const p = writeCodex(codexHome, ["[features]", "image_generation = false", ""], {
    selected: false,
  });
  const before = readFileSync(p, "utf8");
  void migration.run();
  expect(readFileSync(p, "utf8")).toBe(before);
});

test("no Codex config at all is a no-op", () => {
  isolate();
  expect(() => void migration.run()).not.toThrow();
});
