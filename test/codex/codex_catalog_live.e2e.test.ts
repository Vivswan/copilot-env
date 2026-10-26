// Schema-drift gate against the INSTALLED Codex CLI, opt-in via COPILOT_ENV_LIVE_CODEX. No
// token and no Copilot call: the CLI's bundled dump plus a fixture /models body, under
// scratch homes only.

import { afterEach } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "smol-toml";
import {
  type CopilotCatalogModel,
  generateCodexModelCatalog,
  parseCopilotModels,
} from "../../src/codex/catalog.ts";
import { CI_NO_LIVE_LOOKUPS_ENV } from "../../src/codex/user_agent.ts";
import { CopilotEnvConfig } from "../../src/copilot_api/env_config.ts";
import { CopilotApiPaths } from "../../src/copilot_api/paths.ts";
import { childEnv, resolveCommand } from "../../src/utils/command.ts";
import { PROJECT_ROOT } from "../../src/utils/root.ts";
import { envSnapshot, isolateAgentHomes } from "../helpers/env.ts";
import { runSync } from "../helpers/run.ts";
import { expect, test } from "../helpers/testing.ts";

// Opted in: the test RUNS and a missing codex FAILS it (CI installs one right before), never a vacuous skip.
const LIVE_ENV = "COPILOT_ENV_LIVE_CODEX";

// Without LIVE_ENV in the environment (the CI job that installs codex sets it) the live tests skip.
const live = test.skipIf(!process.env[LIVE_ENV]);

// The live test clears the no-live-lookups seam for the real probe; this puts it back.
const restoreEnv = envSnapshot([CI_NO_LIVE_LOOKUPS_ENV]);

let dir = "";

afterEach(() => {
  restoreEnv();
});

type Model = Record<string, unknown>;

// The checked-in Copilot `/models` body; the live test overlays one of THIS Codex's bundled models on it.
const FIXTURE_BODY = JSON.parse(
  readFileSync(join(PROJECT_ROOT, "test", "fixtures", "copilot-models.json"), "utf8"),
) as { data: Model[] };

// The fixture's Copilot-only model: a numbered gpt slug no Codex release bundles.
const FIXTURE_ONLY = "gpt-5.4-fixture";

// The window the overlay gives the bundled model, asserted back from the generated catalog.
const OVERLAY_WINDOW = 1_050_000;

/** The fixture body plus one entry for a model THIS Codex bundles (its first numbered
 *  gpt slug), so the limits overlay meets a real bundled model whatever the release ships. */
function fixtureBodyFor(bundledSlugs: Set<string>): { data: Model[]; overlaid: string } {
  const overlaid = [...bundledSlugs].find((slug) => /^gpt-\d/.test(slug));
  if (overlaid === undefined) throw new Error("this Codex bundles no numbered gpt model");
  const entry: Model = {
    id: overlaid,
    name: overlaid,
    model_picker_enabled: true,
    supported_endpoints: ["/responses"],
    capabilities: {
      type: "chat",
      limits: { max_context_window_tokens: OVERLAY_WINDOW, max_prompt_tokens: 922_000 },
      supports: { parallel_tool_calls: true },
    },
  };
  return { data: [...FIXTURE_BODY.data, entry], overlaid };
}

/** A spawn failure throws (runSync); a killed child reads as a null exit code. */
function codexDebugModels(codexPath: string, home: string, args: string[] = []) {
  return runSync(codexPath, ["debug", "models", ...args], {
    cwd: home,
    env: childEnv({ extra: { CODEX_HOME: home } }),
    timeoutMs: 60_000,
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

/** Negative control through the same path: the same file minus one required field per model is a
 *  startup error naming the key; so is a non-catalog. */
function expectBrokenCatalogsRejected(codexPath: string, scratchHome: string, ours: Model[]): void {
  const broken = join(dir, "broken-catalog.json");
  writeFileSync(
    broken,
    JSON.stringify({
      models: ours.map((m) => {
        const rest: Model = { ...m };
        delete rest.truncation_policy;
        return rest;
      }),
    }),
  );
  writeFileSync(join(scratchHome, "config.toml"), stringify({ model_catalog_json: broken }));
  expectCatalogRejection(codexDebugModels(codexPath, scratchHome));
  writeFileSync(broken, "not a catalog");
  expectCatalogRejection(codexDebugModels(codexPath, scratchHome));
}

live(
  "the installed Codex accepts the catalog generated from its own dump, and rejects a broken one",
  async () => {
    const homes = isolateAgentHomes("copilot-catalog-live-", { mkdirs: true });
    dir = homes.dir;
    delete process.env[CI_NO_LIVE_LOOKUPS_ENV]; // the real probe, the real version look
    new CopilotEnvConfig().set({ "codex.model-catalog": true });
    const scratchHome = join(dir, "codex-home");
    mkdirSync(scratchHome, { recursive: true });
    const codexPath = resolveCommand("codex");
    expect(codexPath).not.toBeNull();
    if (codexPath === null) return;

    const bundledRun = codexDebugModels(codexPath, scratchHome, ["--bundled"]);
    expect(bundledRun.exitCode, bundledRun.stderr).toBe(0);
    const bundled = (JSON.parse(bundledRun.stdout) as { models: Model[] }).models;
    expect(bundled.length).toBeGreaterThan(0);
    const bundledSlugs = new Set(bundled.map((m) => String(m.slug)));
    expect(bundledSlugs.has(FIXTURE_ONLY)).toBe(false);

    // Generation exactly as `agent profile sync --codex` runs it, minus the network: a fetch
    // answering every request (the identity probes, GET /models) with the fixture body stands in
    // for Copilot; dump and acceptance probe are the real CLI.
    const fixture = fixtureBodyFor(bundledSlugs);
    const fixtureModels: Map<string, CopilotCatalogModel> = parseCopilotModels(fixture);
    expect(fixtureModels.get(FIXTURE_ONLY)?.codexServable).toBe(true);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify(fixture), { status: 200 }),
      )) as unknown as typeof fetch;
    try {
      expect(await generateCodexModelCatalog("direct", "gho_fixture")).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
    const file = new CopilotApiPaths().codexModelCatalogFile;
    const generated = readFileSync(file, "utf8");
    const ours = (JSON.parse(generated) as { models: Model[] }).models;

    // (1) Positive direction through the CLI: a config referencing the file parses, and
    // the dump is OUR catalog -- the bundled models plus the servable numbered-gpt
    // fixture models this Codex does not bundle (derived, never a pinned list).
    writeFileSync(join(scratchHome, "config.toml"), stringify({ model_catalog_json: file }));
    const accepted = codexDebugModels(codexPath, scratchHome);
    expect(accepted.exitCode, accepted.stderr).toBe(0);
    expect(slugsOf(accepted.stdout)).toEqual(slugsOf(generated));
    const additions = [...fixtureModels]
      .filter(([id, m]) => m.codexServable && /^gpt-\d/.test(id) && !bundledSlugs.has(id))
      .map(([id]) => id);
    expect(additions).toContain(FIXTURE_ONLY);
    expect(slugsOf(generated)).toEqual([...bundledSlugs, ...additions].sort());

    // (2) Negative control through the same path.
    expectBrokenCatalogsRejected(codexPath, scratchHome, ours);

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
