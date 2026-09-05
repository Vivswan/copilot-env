// The schema-drift gate against the INSTALLED Codex CLI, opt-in via COPILOT_ENV_LIVE_CODEX
// (CI installs the current release first). No token and no Copilot call: the CLI's own
// bundled dump plus a fixture Copilot /models body, under scratch homes only.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringify } from "smol-toml";
import {
  CI_NO_LIVE_LOOKUPS_ENV,
  type CopilotCatalogModel,
  generateCodexModelCatalog,
  parseCopilotModels,
} from "../src/codex/catalog.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { CopilotApiPaths } from "../src/copilot_api/paths.ts";
import { childEnvWithPath, cliSpawn, resolveCommand } from "../src/utils/command.ts";
import { PROJECT_ROOT } from "../src/utils/root.ts";
import { runSync } from "./helpers/run.ts";
import { afterEach, expect, test } from "./helpers/testing.ts";
import { envSnapshot, isolateAgentHomes, removeDir } from "./helpers.ts";

// Opted in: the test RUNS, and a missing codex is a failure (CI installs it right
// before), never a skip that lets the gate pass vacuously.
const LIVE_ENV = "COPILOT_ENV_LIVE_CODEX";
const live = test.skipIf(!process.env[LIVE_ENV]);

const restoreEnv = envSnapshot([CI_NO_LIVE_LOOKUPS_ENV]);
let dir = "";

afterEach(() => {
  restoreEnv();
  dir = removeDir(dir);
});

type Model = Record<string, unknown>;

const FIXTURE_BODY = JSON.parse(
  readFileSync(join(PROJECT_ROOT, "test", "fixtures", "copilot-models.json"), "utf8"),
) as { data: Model[] };
// The fixture's Copilot-only model: a numbered gpt slug no Codex release bundles.
const FIXTURE_ONLY = "gpt-5.4-fixture";
const OVERLAY_WINDOW = 1_050_000;

/** The fixture body plus one entry for a model THIS Codex bundles (its first numbered
 *  gpt slug), so the limits overlay meets a real bundled model whatever the release ships. */
function fixtureBodyFor(bundledSlugs: Set<string>): { data: Model[]; overlaid: string } {
  const overlaid = [...bundledSlugs].find((slug) => /^gpt-\d/.test(slug));
  if (overlaid === undefined) throw new Error("this Codex bundles no numbered gpt model");
  const entry: Model = {
    "id": overlaid,
    "name": overlaid,
    "model_picker_enabled": true,
    "supported_endpoints": ["/responses"],
    "capabilities": {
      "type": "chat",
      "limits": { "max_context_window_tokens": OVERLAY_WINDOW, "max_prompt_tokens": 922_000 },
      "supports": { "parallel_tool_calls": true },
    },
  };
  return { data: [...FIXTURE_BODY.data, entry], overlaid };
}

/** `codex debug models [args]` under `home` (config.toml already in place). A spawn
 *  failure throws (runSync); a killed child reads as a null exit code. */
function codexDebugModels(codexPath: string, home: string, args: string[] = []) {
  // The shared CLI recipe: cmd.exe for a Windows .cmd shim, the CLI's own bin dir on
  // PATH for an nvm-resolved shim (resolveCommand returns a bare name on Windows).
  const s = cliSpawn(codexPath, ["debug", "models", ...args]);
  const cliDir = dirname(codexPath);
  return runSync(s.file, s.args, {
    cwd: home,
    env: childEnvWithPath([cliDir === "." ? null : cliDir], { extra: { CODEX_HOME: home } }),
    timeoutMs: 60_000,
    shell: s.shell,
  });
}

/** A completed run that Codex itself refused: a numeric non-zero exit (not a kill)
 *  whose diagnostics name the catalog key. */
function expectCatalogRejection(run: { exitCode: number | null; stderr: string }): void {
  expect(typeof run.exitCode === "number" && run.exitCode !== 0).toBe(true);
  expect(run.stderr).toContain("model_catalog_json");
}

function slugsOf(json: string): string[] {
  return (JSON.parse(json) as { models: Model[] }).models.map((m) => String(m.slug)).sort();
}

live(
  "the installed Codex accepts the catalog generated from its own dump, and rejects a broken one",
  async () => {
    const homes = isolateAgentHomes("copilot-catalog-live-", { mkdirs: true });
    dir = homes.dir;
    delete process.env[CI_NO_LIVE_LOOKUPS_ENV]; // the real probe, the real version look
    new CopilotEnvConfig().set({ codexModelCatalog: true });
    const scratchHome = join(dir, "codex-home");
    mkdirSync(scratchHome, { recursive: true });
    const codexPath = resolveCommand("codex");
    expect(codexPath).not.toBeNull();
    if (codexPath === null) return;

    // The reference: the installed binary's own bundled catalog.
    const bundledRun = codexDebugModels(codexPath, scratchHome, ["--bundled"]);
    expect(bundledRun.exitCode, bundledRun.stderr).toBe(0);
    const bundled = (JSON.parse(bundledRun.stdout) as { models: Model[] }).models;
    expect(bundled.length).toBeGreaterThan(0);
    const bundledSlugs = new Set(bundled.map((m) => String(m.slug)));
    expect(bundledSlugs.has(FIXTURE_ONLY)).toBe(false);

    // Generation exactly as `agent codex` runs it, minus the network: the fixture
    // body stands in for Copilot's /models; dump and acceptance probe are the real CLI.
    const fixture = fixtureBodyFor(bundledSlugs);
    const fixtureModels: Map<string, CopilotCatalogModel> = parseCopilotModels(fixture);
    expect(fixtureModels.get(FIXTURE_ONLY)?.codexServable).toBe(true);
    expect(
      await generateCodexModelCatalog("direct", { fetchCopilotModels: async () => fixtureModels }),
    ).toBe(true);
    const file = new CopilotApiPaths().codexModelCatalogFile;
    const generated = readFileSync(file, "utf8");
    const ours = (JSON.parse(generated) as { models: Model[] }).models;

    // (1) Positive direction through the CLI: a config referencing the file parses, and
    // the dump is OUR catalog -- the bundled models plus the servable numbered-gpt
    // fixture models this Codex does not bundle (derived, never a pinned list).
    writeFileSync(join(scratchHome, "config.toml"), stringify({ "model_catalog_json": file }));
    const accepted = codexDebugModels(codexPath, scratchHome);
    expect(accepted.exitCode, accepted.stderr).toBe(0);
    expect(slugsOf(accepted.stdout)).toEqual(slugsOf(generated));
    const additions = [...fixtureModels]
      .filter(([id, m]) => m.codexServable && /^gpt-\d/.test(id) && !bundledSlugs.has(id))
      .map(([id]) => id);
    expect(additions).toContain(FIXTURE_ONLY);
    expect(slugsOf(generated)).toEqual([...bundledSlugs, ...additions].sort());

    // (2) Negative control through the same path: the same file minus one required
    // field per model is a startup error naming the key; so is a non-catalog.
    const broken = join(dir, "broken-catalog.json");
    writeFileSync(
      broken,
      JSON.stringify({
        "models": ours.map((m) => {
          const rest: Model = { ...m };
          delete rest.truncation_policy;
          return rest;
        }),
      }),
    );
    writeFileSync(join(scratchHome, "config.toml"), stringify({ "model_catalog_json": broken }));
    expectCatalogRejection(codexDebugModels(codexPath, scratchHome));
    writeFileSync(broken, "not a catalog");
    expectCatalogRejection(codexDebugModels(codexPath, scratchHome));

    // (3) Every field of every bundled entry survives into ours (a newly required
    // field can never be dropped by the patcher), on the real dump of this release.
    for (const entry of bundled) {
      const mine = ours.find((m) => m.slug === entry.slug);
      expect(mine).toBeDefined();
      const missing = Object.keys(entry).filter((key) => !Object.hasOwn(mine ?? {}, key));
      expect(missing, String(entry.slug)).toEqual([]);
    }

    // (4) The Copilot-only fixture model is present with the fixture's limits...
    const added = ours.find((m) => m.slug === FIXTURE_ONLY);
    expect(added?.display_name).toBe("GPT-5.4 Fixture");
    expect(added?.context_window).toBe(400_000);
    expect(added?.max_context_window).toBe(400_000);
    expect(added?.effective_context_window_percent).toBe(68);
    expect(added?.supports_parallel_tool_calls).toBe(true);
    // ...and the bundled model the derived fixture entry names carries Copilot's window.
    const overlaid = ours.find((m) => m.slug === fixture.overlaid);
    expect(overlaid?.context_window, fixture.overlaid).toBe(OVERLAY_WINDOW);
  },
);
