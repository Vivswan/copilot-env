import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";

import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { CopilotApiPaths } from "../src/copilot_api/paths.ts";
import { migration } from "../src/migrations/3.3.20.ts";

// The 3.3.20 migration removes the previously always-on Codex model catalog
// (now opt-in): the generated JSON, the config.toml reference, and the refresh
// throttle state. It has filesystem side effects, so it is isolated under temp
// homes.
const SAVED = {
  HOME: process.env.HOME,
  CODEX_HOME: process.env.CODEX_HOME,
  COPILOT_API_HOME: process.env.COPILOT_API_HOME,
};
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
  dir = mkdtempSync(join(tmpdir(), "copilot-mig3320-"));
  process.env.HOME = dir;
  process.env.COPILOT_API_HOME = join(dir, "proxy-home");
  mkdirSync(join(dir, "proxy-home"), { recursive: true });
  const codexHome = join(dir, ".codex");
  process.env.CODEX_HOME = codexHome;
  mkdirSync(codexHome, { recursive: true });
  return codexHome;
}

test("removes the catalog file, the config.toml reference, and the throttle state", async () => {
  const codexHome = isolate();
  const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
  writeFileSync(catalogFile, '{"models":[{"slug":"gpt-5.5"}]}');
  writeFileSync(
    join(codexHome, "config.toml"),
    // stringify, not a hand-written template: a raw Windows path inside a TOML
    // basic string reads as escape sequences.
    stringify({
      "model_provider": "copilot-env",
      "model_catalog_json": catalogFile,
      "user_key": "kept",
    }),
  );
  new CopilotEnvState().set({ codexCatalogLastAttemptMs: 123, codexCatalogCodexVersion: "1.0.0" });

  expect(migration.version).toBe("3.3.20");
  await migration.run();

  const doc = parse(readFileSync(join(codexHome, "config.toml"), "utf8")) as Record<
    string,
    unknown
  >;
  expect(doc.model_catalog_json).toBeUndefined();
  expect(doc.user_key).toBe("kept");
  expect(existsSync(catalogFile)).toBe(false);
  const state = new CopilotEnvState().read();
  expect(state.codexCatalogLastAttemptMs).toBe(0);
  expect(state.codexCatalogCodexVersion).toBeNull();
});

test("a user who opted in BEFORE updating keeps the catalog (the sync heals, not removes)", async () => {
  const codexHome = isolate();
  new CopilotEnvConfig().set({ codexModelCatalog: true });
  const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
  writeFileSync(catalogFile, '{"models":[{"slug":"gpt-5.5"}]}');
  writeFileSync(
    join(codexHome, "config.toml"),
    stringify({ "model_provider": "copilot-env", "model_catalog_json": catalogFile }),
  );

  await migration.run();

  const doc = parse(readFileSync(join(codexHome, "config.toml"), "utf8")) as Record<
    string,
    unknown
  >;
  expect(doc.model_catalog_json).toBe(catalogFile);
  expect(existsSync(catalogFile)).toBe(true);
});

test("idempotent: a second run on an already-clean install changes nothing", async () => {
  const codexHome = isolate();
  const clean = 'model_provider = "copilot-env"\n';
  writeFileSync(join(codexHome, "config.toml"), clean);

  await migration.run();
  await migration.run();

  expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(clean);
  expect(existsSync(new CopilotApiPaths().codexModelCatalogFile)).toBe(false);
});
