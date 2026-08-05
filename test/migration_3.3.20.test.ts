import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";

import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { CopilotApiPaths } from "../src/copilot_api/paths.ts";
import { migration } from "../src/migrations/3.3.20.ts";
import { envSnapshot, isolateAgentHomes, removeDir } from "./helpers.ts";

// The 3.3.20 migration removes the previously always-on Codex model catalog
// (now opt-in): the generated JSON, the config.toml reference, and the refresh
// throttle state. It has filesystem side effects, so it is isolated under temp
// homes.
const restoreEnv = envSnapshot();
let dir = "";

afterEach(() => {
  restoreEnv();
  dir = removeDir(dir);
});

function isolate(): string {
  const homes = isolateAgentHomes("copilot-mig3320-", { mkdirs: true });
  dir = homes.dir;
  return homes.codexHome;
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
