import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  AUTH_REFRESH_WORST_CASE_MS,
  CATALOG_PATCH_VERSION,
  CI_NO_LIVE_LOOKUPS_ENV,
  type CopilotCatalogModel,
  type CopilotModelLimits,
  generateCodexModelCatalog,
  inspectCatalogFile,
  parseCopilotModels,
  patchModelCatalog,
  refreshCodexModelCatalogIfStale,
  resetCatalogProbeState,
  withCatalogRefreshDeadline,
} from "../src/codex/catalog.ts";
import { DIRECT_AUTH_TIMEOUT_MS } from "../src/codex/config.ts";
import { GH_AUTH_TIMEOUT_MS } from "../src/copilot_api/gh_cli.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { CopilotApiPaths } from "../src/copilot_api/paths.ts";
import { MILLISECONDS_PER_DAY } from "../src/utils/time.ts";
import { afterEach, expect, test } from "./helpers/testing.ts";
import { envSnapshot, isolateProxyHome, removeDir } from "./helpers.ts";

const restoreEnv = envSnapshot([
  "PATH",
  CI_NO_LIVE_LOOKUPS_ENV,
  "COPILOT_ENV_PROBE_SEEN",
  "COPILOT_ENV_PROBE_RUNS",
]);
let dir = "";

afterEach(() => {
  restoreEnv();
  dir = removeDir(dir);
});

function isolate(): void {
  dir = isolateProxyHome("copilot-catalog-");
  // The catalog is opt-in (default false); these tests exercise the enabled
  // machinery, so flip it on in the isolated home. The disabled-gate tests
  // below undo this per-test.
  new CopilotEnvConfig().set({ codexModelCatalog: true });
}

type Model = Record<string, unknown>;

/** A Copilot entry Codex can drive, with only the limits varying by default. */
function copilotModel(
  limits: CopilotModelLimits,
  extra: Partial<CopilotCatalogModel> = {},
): CopilotCatalogModel {
  return {
    limits,
    name: null,
    reasoningEfforts: null,
    parallelToolCalls: null,
    codexServable: true,
    ...extra,
  };
}

function modelsOf(entries: [string, CopilotCatalogModel][]): Map<string, CopilotCatalogModel> {
  return new Map(entries);
}

function modelsIn(doc: Record<string, unknown> | null): Model[] {
  return (doc as { models: Model[] }).models;
}

function effortsOf(model: Model): unknown[] {
  return (model.supported_reasoning_levels as Model[]).map((level) => level.effort);
}

function bySlug(doc: Record<string, unknown> | null, slug: string): Model {
  const found = modelsIn(doc).find((m) => m.slug === slug);
  if (found === undefined) throw new Error(`no model ${slug}`);
  return found;
}

// The worked example from the live catalogs: Codex bundles gpt-5.5 at 272k/95%
// while Copilot serves a 1.05M window with a 922k prompt cap.
const GPT55_LIMITS: CopilotModelLimits = {
  maxContextWindowTokens: 1_050_000,
  maxPromptTokens: 922_000,
};
// Copilot's gpt-6-astra: 1M window, 872k prompt cap (=> 87%).
const ASTRA_LIMITS: CopilotModelLimits = {
  maxContextWindowTokens: 1_000_000,
  maxPromptTokens: 872_000,
};

/** A minimal bundled dump in the shape `codex debug models --bundled` emits: every
 *  field the patcher reads or rewrites, plus opaque ones it must carry untouched. */
function syntheticDump(): string {
  const entry = (slug: string, priority: number): Model => ({
    slug,
    "display_name": slug.toUpperCase(),
    description: `${slug} bundled`,
    "default_reasoning_level": "medium",
    "supported_reasoning_levels": [{ effort: "low" }, { effort: "medium" }, { effort: "high" }],
    "shell_type": "unified_exec",
    visibility: "list",
    "supported_in_api": true,
    priority,
    "additional_speed_tiers": ["fast"],
    "service_tiers": [{ id: "priority", name: "Fast" }],
    // Non-null sentinels: a bundled entry's own claims must survive untouched
    // (only a CLONE drops them).
    "availability_nux": { text: `try ${slug}` },
    upgrade: { model: `${slug}-next` },
    "model_messages": { "persistent_instructions": `persist ${slug}` },
    "truncation_policy": { mode: "bytes", limit: 10_000 },
    "context_window": 272_000,
    "max_context_window": 272_000,
    "effective_context_window_percent": 95,
    "comp_hash": `hash-${slug}`,
    "experimental_supported_tools": ["read_file"],
    "input_modalities": ["text", "image"],
    "base_instructions": `instructions for ${slug}`,
  });
  return JSON.stringify({
    models: [entry("gpt-5.6-sol", 1), entry("gpt-5.4", 2), {
      slug: "codex-auto-review",
      visibility: "hide",
      priority: 9,
      "truncation_policy": { mode: "bytes", limit: 10_000 },
    }],
  });
}

// --- parseCopilotModels ------------------------------------------------------

test("parseCopilotModels reads limits, identity, and Codex-servability, skipping incomplete entries", () => {
  const models = parseCopilotModels({
    data: [
      {
        id: "gpt-5.5",
        name: "GPT-5.5",
        model_picker_enabled: true,
        supported_endpoints: ["/responses", "ws:/responses"],
        capabilities: {
          type: "chat",
          limits: { max_context_window_tokens: 1_050_000, max_prompt_tokens: 922_000 },
          supports: { reasoning_effort: ["low", "medium", 7], parallel_tool_calls: true },
        },
      },
      // Missing prompt cap: skipped (both numbers are required for the patch).
      { id: "gpt-5.4-mini", capabilities: { limits: { max_context_window_tokens: 400_000 } } },
      // Ill-typed / degenerate values: skipped.
      {
        id: "bad-types",
        capabilities: { limits: { max_context_window_tokens: "1m", max_prompt_tokens: 1 } },
      },
      {
        id: "zero",
        capabilities: { limits: { max_context_window_tokens: 0, max_prompt_tokens: 0 } },
      },
      { id: "no-capabilities" },
      "not-a-record",
    ],
  });
  expect([...models.keys()]).toEqual(["gpt-5.5"]);
  expect(models.get("gpt-5.5")).toEqual({
    limits: GPT55_LIMITS,
    name: "GPT-5.5",
    reasoningEfforts: ["low", "medium"],
    parallelToolCalls: true,
    codexServable: true,
  });
});

test("parseCopilotModels reads an empty or ill-typed effort list as unadvertised (null)", () => {
  const limits = { max_context_window_tokens: 400_000, max_prompt_tokens: 272_000 };
  const models = parseCopilotModels({
    data: [
      { id: "empty", capabilities: { limits, supports: { reasoning_effort: [] } } },
      { id: "ill-typed", capabilities: { limits, supports: { reasoning_effort: [1, null] } } },
    ],
  });
  expect(models.get("empty")?.reasoningEfforts).toBeNull();
  expect(models.get("ill-typed")?.reasoningEfforts).toBeNull();
});

test("parseCopilotModels: servable means chat + /responses + picker-enabled; unadvertised facts are null", () => {
  const limits = { max_context_window_tokens: 400_000, max_prompt_tokens: 272_000 };
  const models = parseCopilotModels({
    data: [
      // Chat-completions only: Codex cannot drive it.
      {
        id: "no-responses",
        model_picker_enabled: true,
        supported_endpoints: ["/chat/completions"],
        capabilities: { type: "chat", limits },
      },
      // Hidden from Copilot's own picker: hidden from Codex's too.
      {
        id: "no-picker",
        model_picker_enabled: false,
        supported_endpoints: ["/responses"],
        capabilities: { type: "chat", limits },
      },
      {
        id: "embeddings",
        model_picker_enabled: true,
        supported_endpoints: ["/responses"],
        capabilities: { type: "embeddings", limits },
      },
      { id: "bare", capabilities: { limits } },
    ],
  });
  for (const id of ["no-responses", "no-picker", "embeddings", "bare"]) {
    expect(models.get(id)?.codexServable).toBe(false);
  }
  expect(models.get("bare")).toEqual({
    limits: { maxContextWindowTokens: 400_000, maxPromptTokens: 272_000 },
    name: null,
    reasoningEfforts: null,
    parallelToolCalls: null,
    codexServable: false,
  });
});

test("parseCopilotModels merges a [1m] twin into its base: larger window, every stated fact, either order", () => {
  const base = {
    id: "claude-x",
    name: "Claude X",
    model_picker_enabled: true,
    supported_endpoints: ["/responses"],
    capabilities: {
      type: "chat",
      limits: { max_context_window_tokens: 200_000, max_prompt_tokens: 180_000 },
      supports: { reasoning_effort: ["low"], parallel_tool_calls: true },
    },
  };
  // The twin states only its limits.
  const twin = {
    id: "claude-x[1m]",
    capabilities: { limits: { max_context_window_tokens: 1_000_000, max_prompt_tokens: 900_000 } },
  };
  const expected: CopilotCatalogModel = {
    limits: { maxContextWindowTokens: 1_000_000, maxPromptTokens: 900_000 },
    name: "Claude X",
    reasoningEfforts: ["low"],
    parallelToolCalls: true,
    codexServable: true,
  };
  expect(parseCopilotModels({ data: [base, twin] }).get("claude-x")).toEqual(expected);
  expect(parseCopilotModels({ data: [twin, base] }).get("claude-x")).toEqual(expected);

  // Both state a fact and disagree: the larger window's entry speaks first, in
  // either order.
  const loudTwin = {
    ...twin,
    name: "Claude X 1M",
    model_picker_enabled: false,
    capabilities: {
      ...twin.capabilities,
      supports: { reasoning_effort: ["high"], parallel_tool_calls: false },
    },
  };
  const twinWins: CopilotCatalogModel = {
    ...expected,
    name: "Claude X 1M",
    reasoningEfforts: ["high"],
    parallelToolCalls: false,
  };
  expect(parseCopilotModels({ data: [base, loudTwin] }).get("claude-x")).toEqual(twinWins);
  expect(parseCopilotModels({ data: [loudTwin, base] }).get("claude-x")).toEqual(twinWins);

  // A twin advertising an EMPTY effort list says nothing, so the base's list wins
  // in either order (an empty list must never read as "no shared effort").
  const emptyTwin = {
    ...twin,
    capabilities: { ...twin.capabilities, supports: { reasoning_effort: [] } },
  };
  expect(parseCopilotModels({ data: [base, emptyTwin] }).get("claude-x")?.reasoningEfforts)
    .toEqual(["low"]);
  expect(parseCopilotModels({ data: [emptyTwin, base] }).get("claude-x")?.reasoningEfforts)
    .toEqual(["low"]);
});

test("parseCopilotModels returns empty on a shapeless body", () => {
  expect(parseCopilotModels(null).size).toBe(0);
  expect(parseCopilotModels({ data: "nope" }).size).toBe(0);
  expect(parseCopilotModels({}).size).toBe(0);
});

// --- patchModelCatalog: the bundled entries --------------------------------------

test("patchModelCatalog overlays matching slugs and keeps every other field verbatim", () => {
  const bundled = JSON.stringify({
    schema_version: 3,
    models: [
      {
        slug: "gpt-5.5",
        display_name: "GPT-5.5",
        context_window: 272_000,
        max_context_window: 272_000,
        effective_context_window_percent: 95,
        nested: { keep: ["me", 1] },
        service_tiers: [{ id: "priority", name: "Fast" }],
        additional_speed_tiers: ["fast"],
      },
      {
        slug: "gpt-5.2",
        context_window: 272_000,
        effective_context_window_percent: 95,
        service_tiers: [{ id: "priority", name: "Fast" }],
      },
      { no_slug: true },
    ],
  });
  const doc = patchModelCatalog(
    bundled,
    modelsOf([["gpt-5.5", copilotModel(GPT55_LIMITS, { parallelToolCalls: true })]]),
  );
  expect(doc).not.toBeNull();
  const models = modelsIn(doc);

  // Patched: Copilot's window, and the percent floored to the prompt cap
  // (922000 / 1050000 => 87; the bundled 95% would 413 upstream before compact).
  expect(models[0]?.context_window).toBe(1_050_000);
  expect(models[0]?.max_context_window).toBe(1_050_000);
  expect(models[0]?.effective_context_window_percent).toBe(87);
  // Untouched fields survive verbatim.
  expect(models[0]?.display_name).toBe("GPT-5.5");
  expect(models[0]?.nested).toEqual({ keep: ["me", 1] });
  // Tier advertisements are EMPTIED on every model (limits-matched or not): they
  // make Codex send `service_tier`, which Copilot's /responses rejects -- but
  // the keys stay, so the entry keeps the dump's exact key set.
  expect(models[0]?.service_tiers).toEqual([]);
  expect(models[0]?.additional_speed_tiers).toEqual([]);
  // The known-required extra: Copilot's advertised value where known...
  expect(models[0]?.supports_parallel_tool_calls).toBe(true);
  // ...and false for a model Copilot does not list. A non-matching sibling is
  // otherwise untouched apart from the emptied tiers.
  expect(models[1]).toEqual({
    slug: "gpt-5.2",
    context_window: 272_000,
    effective_context_window_percent: 95,
    service_tiers: [],
    supports_parallel_tool_calls: false,
  });
  // A slug-less entry survives (with the fill, which every entry gets).
  expect(models[2]).toEqual({ no_slug: true, supports_parallel_tool_calls: false });
  // Top-level extras survive.
  expect((doc as Record<string, unknown>).schema_version).toBe(3);
});

test("a dump that already carries a known-required extra wins over the fill", () => {
  const bundled = JSON.stringify({
    models: [{ slug: "gpt-5.5", supports_parallel_tool_calls: "native" }],
  });
  const doc = patchModelCatalog(
    bundled,
    modelsOf([["gpt-5.5", copilotModel(GPT55_LIMITS, { parallelToolCalls: false })]]),
  );
  expect(bySlug(doc, "gpt-5.5").supports_parallel_tool_calls).toBe("native");
});

test("patchModelCatalog returns null on bad input (never a catalog Codex would reject)", () => {
  const models = modelsOf([["gpt-5.5", copilotModel(GPT55_LIMITS)]]);
  expect(patchModelCatalog("{ not json", models)).toBeNull();
  expect(patchModelCatalog(JSON.stringify({ models: [] }), models)).toBeNull();
  expect(patchModelCatalog(JSON.stringify({ nope: true }), models)).toBeNull();
  expect(patchModelCatalog(JSON.stringify([1, 2]), models)).toBeNull();
});

// --- patchModelCatalog: Copilot-only additions ------------------------------------

const DONOR_EFFORTS = ["low", "medium", "high", "ultra"];

function donor(slug: string, extra: Model = {}): Model {
  return {
    slug,
    display_name: slug.toUpperCase(),
    description: `${slug} bundled description`,
    default_reasoning_level: "medium",
    supported_reasoning_levels: [
      { effort: "low", description: "fast" },
      { effort: "medium", description: "balanced" },
      { effort: "high", description: "deep" },
      { effort: "ultra", description: "multi-agent" },
    ],
    visibility: "hide",
    supported_in_api: false,
    priority: 3,
    upgrade: { model: "gpt-x" },
    availability_nux: { text: "try it" },
    comp_hash: `hash-${slug}`,
    context_window: 272_000,
    max_context_window: 272_000,
    effective_context_window_percent: 95,
    base_instructions: `instructions for ${slug}`,
    experimental_supported_tools: ["a", "b"],
    ...extra,
  };
}

const FAMILY_DUMP = JSON.stringify({
  models: [
    donor("gpt-5.6-sol", { priority: 1 }),
    donor("gpt-5.6-terra", { priority: 2 }),
    donor("gpt-5.4", { priority: 4 }),
    donor("gpt-5.2", { priority: 5 }),
    { slug: "codex-auto-review", visibility: "hide", priority: 9 },
  ],
});

test("a Copilot-only model is appended as a clone of its closest bundled relative", () => {
  const doc = patchModelCatalog(
    FAMILY_DUMP,
    modelsOf([
      // Same version, longest shared prefix: sol-fast clones sol, not terra.
      [
        "gpt-5.6-sol-fast",
        copilotModel(GPT55_LIMITS, {
          name: "GPT-5.6 Sol Fast",
          reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
          parallelToolCalls: true,
        }),
      ],
      // No 6.x bundled: the nearest version is 5.6, first in dump order (sol).
      ["gpt-6-astra", copilotModel(ASTRA_LIMITS, { name: "GPT-6 Astra" })],
      // 5.3 sits between 5.2 and 5.4: the newer donor wins the tie.
      ["gpt-5.3-codex", copilotModel(GPT55_LIMITS)],
    ]),
  );
  expect(modelsIn(doc).map((m) => m.slug)).toEqual([
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.4",
    "gpt-5.2",
    "codex-auto-review",
    // Appended in id order regardless of Map insertion order.
    "gpt-5.3-codex",
    "gpt-5.6-sol-fast",
    "gpt-6-astra",
  ]);

  const solFast = bySlug(doc, "gpt-5.6-sol-fast");
  // Identity + limits from Copilot.
  expect(solFast.display_name).toBe("GPT-5.6 Sol Fast");
  expect(solFast.description).toBe(
    "GPT-5.6 Sol Fast, served by GitHub Copilot (not bundled with Codex)",
  );
  expect(solFast.context_window).toBe(1_050_000);
  expect(solFast.max_context_window).toBe(1_050_000);
  expect(solFast.effective_context_window_percent).toBe(87);
  expect(solFast.supports_parallel_tool_calls).toBe(true);
  // The donor's Codex-side shape survives...
  expect(solFast.base_instructions).toBe("instructions for gpt-5.6-sol");
  expect(solFast.experimental_supported_tools).toEqual(["a", "b"]);
  // ...but not its donor-specific claims: listed and API-served in its own right.
  expect(solFast.visibility).toBe("list");
  expect(solFast.supported_in_api).toBe(true);
  expect(solFast.upgrade).toBeNull();
  expect(solFast.availability_nux).toBeNull();
  expect("comp_hash" in solFast).toBe(false);
  // Reasoning levels narrow to Copilot's list (ultra is Codex-only); default kept.
  expect(effortsOf(solFast)).toEqual(["low", "medium", "high"]);
  expect(solFast.default_reasoning_level).toBe("medium");
  // Priorities continue after the bundled maximum, in appended order.
  expect(bySlug(doc, "gpt-5.3-codex").priority).toBe(10);
  expect(solFast.priority).toBe(11);
  expect(bySlug(doc, "gpt-6-astra").priority).toBe(12);

  const astra = bySlug(doc, "gpt-6-astra");
  expect(astra.base_instructions).toBe("instructions for gpt-5.6-sol");
  expect(astra.effective_context_window_percent).toBe(87);
  // No Copilot value for parallel tool calls: the conservative fill.
  expect(astra.supports_parallel_tool_calls).toBe(false);
  // Unadvertised efforts keep the donor's levels whole.
  expect(effortsOf(astra)).toEqual(DONOR_EFFORTS);

  const codex53 = bySlug(doc, "gpt-5.3-codex");
  expect(codex53.base_instructions).toBe("instructions for gpt-5.4");
  expect(effortsOf(codex53)).toEqual(DONOR_EFFORTS);

  // The donors themselves are untouched by the cloning (tiers aside).
  expect(bySlug(doc, "gpt-5.6-sol").comp_hash).toBe("hash-gpt-5.6-sol");
  expect(bySlug(doc, "gpt-5.6-sol").visibility).toBe("hide");
  expect(bySlug(doc, "gpt-5.6-sol").supported_in_api).toBe(false);
});

test("a clone's default reasoning level moves into the narrowed list when Copilot drops it", () => {
  const doc = patchModelCatalog(
    FAMILY_DUMP,
    modelsOf([["gpt-5.6-luna", copilotModel(GPT55_LIMITS, { reasoningEfforts: ["high"] })]]),
  );
  const luna = bySlug(doc, "gpt-5.6-luna");
  expect(effortsOf(luna)).toEqual(["high"]);
  expect(luna.default_reasoning_level).toBe("high");
});

test("advertised efforts sharing nothing with the donor's levels (or a donor listing none) skip the clone", () => {
  const disjoint = patchModelCatalog(
    FAMILY_DUMP,
    modelsOf([["gpt-5.3-codex", copilotModel(GPT55_LIMITS, { reasoningEfforts: ["zeta"] })]]),
  );
  expect(modelsIn(disjoint).some((m) => m.slug === "gpt-5.3-codex")).toBe(false);
  // A donor without a level list has nothing to intersect: no clone either.
  const levelless = JSON.stringify({
    models: [{ ...donor("gpt-5.4"), supported_reasoning_levels: undefined }],
  });
  const noLevels = patchModelCatalog(
    levelless,
    modelsOf([["gpt-5.3-codex", copilotModel(GPT55_LIMITS, { reasoningEfforts: ["low"] })]]),
  );
  expect(modelsIn(noLevels).some((m) => m.slug === "gpt-5.3-codex")).toBe(false);
  // Control: the same donor WITH levels clones.
  const withLevels = patchModelCatalog(
    FAMILY_DUMP,
    modelsOf([["gpt-5.3-codex", copilotModel(GPT55_LIMITS, { reasoningEfforts: ["low"] })]]),
  );
  expect(effortsOf(bySlug(withLevels, "gpt-5.3-codex"))).toEqual(["low"]);
});

test("only servable gpt-* models Codex lacks are added; bundled ones are never duplicated", () => {
  const doc = patchModelCatalog(
    FAMILY_DUMP,
    modelsOf([
      // Bundled: limits overlaid in place, no clone.
      ["gpt-5.4", copilotModel(GPT55_LIMITS)],
      // Not servable by Codex (chat-completions only / picker-hidden).
      ["gpt-5.4-nano", copilotModel(GPT55_LIMITS, { codexServable: false })],
      // Another vendor's family: no bundled relative to clone from.
      ["claude-opus-5", copilotModel(GPT55_LIMITS)],
      ["grok-4.5", copilotModel(GPT55_LIMITS)],
      // A codename outside the numbered family: nothing places it.
      ["gpt-daybreak-green", copilotModel(GPT55_LIMITS)],
    ]),
  );
  expect(modelsIn(doc).map((m) => m.slug)).toEqual([
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.4",
    "gpt-5.2",
    "codex-auto-review",
  ]);
  expect(bySlug(doc, "gpt-5.4").context_window).toBe(1_050_000);
});

test("donor versions order by dotted segments: 5.10 is newer than 5.9, and 5.3.1 sits at 5.3", () => {
  const dump = JSON.stringify({
    models: [donor("gpt-5.1"), donor("gpt-5.9"), donor("gpt-5.10"), donor("gpt-5.3")],
  });
  const doc = patchModelCatalog(
    dump,
    modelsOf([
      // 5.11 is nearest 5.10 (not 5.1, which a decimal parse would conflate with 5.10).
      ["gpt-5.11-nova", copilotModel(GPT55_LIMITS)],
      // A three-segment version is a gpt-* slug too, nearest its own minor.
      ["gpt-5.3.1", copilotModel(GPT55_LIMITS)],
    ]),
  );
  expect(bySlug(doc, "gpt-5.11-nova").base_instructions).toBe("instructions for gpt-5.10");
  expect(bySlug(doc, "gpt-5.3.1").base_instructions).toBe("instructions for gpt-5.3");
});

test("a version segment past 999 leaves the numbered family (the encoding cannot place it)", () => {
  // As a donor: gpt-5.3.1000 must not be read as gpt-5.4; as a Copilot id: not cloned.
  const doc = patchModelCatalog(
    JSON.stringify({ models: [donor("gpt-5.3.1000"), donor("gpt-5.2")] }),
    modelsOf([
      ["gpt-5.4-nova", copilotModel(GPT55_LIMITS)],
      ["gpt-5.3.1000-fast", copilotModel(GPT55_LIMITS)],
    ]),
  );
  expect(modelsIn(doc).map((m) => m.slug)).toEqual(["gpt-5.3.1000", "gpt-5.2", "gpt-5.4-nova"]);
  expect(bySlug(doc, "gpt-5.4-nova").base_instructions).toBe("instructions for gpt-5.2");
});

test("a dump with no gpt-* entry adds nothing (no donor family)", () => {
  const doc = patchModelCatalog(
    JSON.stringify({ models: [{ slug: "codex-auto-review" }] }),
    modelsOf([["gpt-6-astra", copilotModel(ASTRA_LIMITS)]]),
  );
  expect(modelsIn(doc).map((m) => m.slug)).toEqual(["codex-auto-review"]);
});

test("patchModelCatalog is deterministic: identical output for the same input, any Map order", () => {
  const forward = modelsOf([
    ["gpt-6-astra", copilotModel(ASTRA_LIMITS)],
    ["gpt-5.3-codex", copilotModel(GPT55_LIMITS)],
    ["gpt-5.5", copilotModel(GPT55_LIMITS)],
  ]);
  const reversed = modelsOf([...forward.entries()].reverse());
  const a = JSON.stringify(patchModelCatalog(FAMILY_DUMP, forward));
  expect(JSON.stringify(patchModelCatalog(FAMILY_DUMP, forward))).toBe(a);
  expect(JSON.stringify(patchModelCatalog(FAMILY_DUMP, reversed))).toBe(a);
});

// --- the superset property: no field a dump carries ever goes missing ------------

test("every field of every bundled entry survives (tiers emptied, limits overlaid), and a clone carries its donor's key set minus comp_hash", () => {
  const raw = syntheticDump();
  const bundled = modelsIn(JSON.parse(raw));
  const doc = patchModelCatalog(
    raw,
    modelsOf([
      ["gpt-5.6-sol", copilotModel(GPT55_LIMITS, { parallelToolCalls: true })],
      ["gpt-5.6-sol-fast", copilotModel(GPT55_LIMITS, { name: "GPT-5.6 Sol Fast" })],
    ]),
  );
  expect(modelsIn(doc).length).toBe(bundled.length + 1);
  const tierFields = ["service_tiers", "additional_speed_tiers"];
  const limitFields = ["context_window", "max_context_window", "effective_context_window_percent"];
  for (const entry of bundled) {
    const slug = entry.slug as string;
    const out = bySlug(doc, slug);
    expect(Object.keys(out).sort()).toEqual(
      [...Object.keys(entry), "supports_parallel_tool_calls"].sort(),
    );
    // Only the tiers, and the limits of the ONE model Copilot lists, are rewritten;
    // every other value is byte-identical.
    const rewritten = new Set(
      slug === "gpt-5.6-sol" ? [...tierFields, ...limitFields] : tierFields,
    );
    for (const [key, value] of Object.entries(entry)) {
      if (!rewritten.has(key)) expect([slug, key, out[key]]).toEqual([slug, key, value]);
    }
    for (const key of tierFields) if (key in entry) expect(out[key]).toEqual([]);
  }
  const overlaid = bySlug(doc, "gpt-5.6-sol");
  expect([
    overlaid.context_window,
    overlaid.max_context_window,
    overlaid.effective_context_window_percent,
  ])
    .toEqual([1_050_000, 1_050_000, 87]);
  const cloneKeys = Object.keys(bySlug(doc, "gpt-5.6-sol-fast")).sort();
  const donorKeys = Object.keys(bySlug(doc, "gpt-5.6-sol")).filter((k) => k !== "comp_hash").sort();
  expect(cloneKeys).toEqual(donorKeys);
});

// --- generateCodexModelCatalog -----------------------------------------------

const BUNDLED = JSON.stringify({
  models: [{ slug: "gpt-5.5", context_window: 272_000, effective_context_window_percent: 95 }],
});
const GPT55_ONLY = modelsOf([["gpt-5.5", copilotModel(GPT55_LIMITS)]]);

test("generateCodexModelCatalog writes the patched catalog file", async () => {
  isolate();
  let narrated = "";
  const realWrite = process.stderr.write;
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    narrated += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  };
  let ok = false;
  try {
    ok = await generateCodexModelCatalog("direct", {
      bundledCatalog: () => BUNDLED,
      fetchCopilotModels: async () => GPT55_ONLY,
      acceptsCatalog: () => true,
    });
  } finally {
    process.stderr.write = realWrite;
  }
  expect(ok).toBe(true);
  const file = new CopilotApiPaths().codexModelCatalogFile;
  // Nothing hidden: the write is named on stderr (stdout may be a token).
  expect(narrated).toContain(`Codex model catalog written → ${file}`);
  const written = JSON.parse(readFileSync(file, "utf8"));
  expect(written.models[0].context_window).toBe(1_050_000);
  expect(written.models[0].effective_context_window_percent).toBe(87);
  // Owner-only, like every file the store writes beside it.
  if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
});

test("generateCodexModelCatalog fetches Copilot FIRST (cheap fail skips the codex spawn)", async () => {
  isolate();
  let bundledCalled = false;
  const ok = await generateCodexModelCatalog("direct", {
    bundledCatalog: () => {
      bundledCalled = true;
      return BUNDLED;
    },
    fetchCopilotModels: async () => null,
  });
  expect(ok).toBe(false);
  expect(bundledCalled).toBe(false);
  expect(existsSync(new CopilotApiPaths().codexModelCatalogFile)).toBe(false);
});

test("a candidate the installed codex rejects is never written; an unverifiable one is", async () => {
  isolate();
  const file = new CopilotApiPaths().codexModelCatalogFile;
  let probed = "";
  expect(
    await generateCodexModelCatalog("direct", {
      bundledCatalog: () => BUNDLED,
      fetchCopilotModels: async () => GPT55_ONLY,
      acceptsCatalog: (json) => {
        probed = json;
        return false;
      },
    }),
  ).toBe(false);
  expect(existsSync(file)).toBe(false);
  // The probe judged the patched document, not the raw dump.
  expect(JSON.parse(probed).models[0].context_window).toBe(1_050_000);

  // No codex to ask (null): the JSON-valid candidate is written as before.
  expect(
    await generateCodexModelCatalog("direct", {
      bundledCatalog: () => BUNDLED,
      fetchCopilotModels: async () => GPT55_ONLY,
      acceptsCatalog: () => null,
    }),
  ).toBe(true);
  expect(existsSync(file)).toBe(true);
});

test("a failed regeneration never touches an existing (stale but valid) catalog", async () => {
  isolate();
  const accept = { acceptsCatalog: () => true };
  expect(
    await generateCodexModelCatalog("direct", {
      bundledCatalog: () => BUNDLED,
      fetchCopilotModels: async () => GPT55_ONLY,
      ...accept,
    }),
  ).toBe(true);
  const before = readFileSync(new CopilotApiPaths().codexModelCatalogFile, "utf8");

  // Bundled dump fails; a throwing fetch is also swallowed; a rejected candidate too.
  expect(
    await generateCodexModelCatalog("direct", {
      bundledCatalog: () => null,
      fetchCopilotModels: async () => GPT55_ONLY,
      ...accept,
    }),
  ).toBe(false);
  expect(
    await generateCodexModelCatalog("direct", {
      bundledCatalog: () => BUNDLED,
      fetchCopilotModels: async () => {
        throw new Error("boom");
      },
      ...accept,
    }),
  ).toBe(false);
  expect(
    await generateCodexModelCatalog("direct", {
      bundledCatalog: () => BUNDLED,
      fetchCopilotModels: async () => GPT55_ONLY,
      acceptsCatalog: () => false,
    }),
  ).toBe(false);
  expect(readFileSync(new CopilotApiPaths().codexModelCatalogFile, "utf8")).toBe(before);
});

// --- refreshCodexModelCatalogIfStale -----------------------------------------

test("refresh is attempt-throttled: a fresh timestamp skips deps entirely", async () => {
  isolate();
  const now = 1_700_000_000_000;
  new CopilotEnvState().set({
    codexCatalogLastAttemptMs: now - 1000,
    codexCatalogPatchVersion: CATALOG_PATCH_VERSION,
  });
  let called = false;
  await refreshCodexModelCatalogIfStale("direct", {
    nowMs: () => now,
    codexVersion: () => null,
    fetchCopilotModels: async () => {
      called = true;
      return null;
    },
  });
  expect(called).toBe(false);
});

test("refresh records the ATTEMPT timestamp even when generation fails", async () => {
  isolate();
  const now = 1_700_000_000_000;
  new CopilotEnvState().set({ codexCatalogLastAttemptMs: now - MILLISECONDS_PER_DAY - 1 });
  const regenerated = await refreshCodexModelCatalogIfStale("proxy", {
    nowMs: () => now,
    codexVersion: () => null,
    bundledCatalog: () => null,
    fetchCopilotModels: async () => GPT55_ONLY,
  });
  expect(regenerated).toBe(false);
  // Attempt recorded BEFORE the (failed) generation: no retry storm on the
  // 300s Codex auth refresh cadence.
  expect(new CopilotEnvState().read().codexCatalogLastAttemptMs).toBe(now);
});

test("refresh regenerates when due and reports it", async () => {
  isolate();
  const now = 1_700_000_000_000;
  const regenerated = await refreshCodexModelCatalogIfStale("direct", {
    nowMs: () => now, // lastAttemptMs defaults to 0 => due
    bundledCatalog: () => BUNDLED,
    fetchCopilotModels: async () => GPT55_ONLY,
    acceptsCatalog: () => true,
  });
  expect(regenerated).toBe(true);
  expect(new CopilotEnvState().read().codexCatalogLastAttemptMs).toBe(now);
  expect(existsSync(new CopilotApiPaths().codexModelCatalogFile)).toBe(true);
});

// --- inspectCatalogFile -----------------------------------

test("an accepted catalog is remembered by content and codex version: no re-probe until either changes", async () => {
  isolate();
  const file = new CopilotApiPaths().codexModelCatalogFile;
  let probes = 0;
  const probing = (verdict: boolean | null, version: string | null) => ({
    acceptsCatalog: () => {
      probes++;
      return verdict;
    },
    codexVersion: () => version,
  });
  // Generation under codex 1.0.0, accepted: the (hash, version) pair is recorded.
  expect(
    await generateCodexModelCatalog("direct", {
      bundledCatalog: () => BUNDLED,
      fetchCopilotModels: async () => GPT55_ONLY,
      ...probing(true, "1.0.0"),
    }),
  ).toBe(true);
  expect(probes).toBe(1);
  const recorded = new CopilotEnvState().read().codexCatalogAccepted;
  expect(recorded?.codexVersion).toBe("1.0.0");
  expect(recorded?.sha256).toMatch(/^[0-9a-f]{64}$/);

  // The sync's later inspection (a fresh process would read the same state):
  // same bytes, same codex -- accepted without asking.
  expect(inspectCatalogFile(file, probing(false, "1.0.0"))).toBe("accepted");
  expect(probes).toBe(1);
  // A codex upgrade asks again (and a rejection is not recorded).
  expect(inspectCatalogFile(file, probing(false, "2.0.0"))).toBe("rejected");
  expect(probes).toBe(2);
  expect(new CopilotEnvState().read().codexCatalogAccepted).toEqual(recorded);
  // An acceptance by the new codex is recorded, then trusted.
  expect(inspectCatalogFile(file, probing(true, "2.0.0"))).toBe("accepted");
  expect(inspectCatalogFile(file, probing(false, "2.0.0"))).toBe("accepted");
  expect(probes).toBe(3);
  expect(new CopilotEnvState().read().codexCatalogAccepted?.codexVersion).toBe("2.0.0");
  // A changed file asks again; an unknown codex version never trusts the record.
  writeFileSync(file, '{"models":[{"slug":"other"}]}');
  expect(inspectCatalogFile(file, probing(false, "2.0.0"))).toBe("rejected");
  expect(probes).toBe(4);
  expect(inspectCatalogFile(file, probing(true, null))).toBe("accepted");
  expect(inspectCatalogFile(file, probing(true, null))).toBe("accepted");
  expect(probes).toBe(6);
});

test("a proven acceptance survives an acceptance cache that cannot be read or written", () => {
  isolate();
  const file = new CopilotApiPaths().codexModelCatalogFile;
  writeFileSync(file, '{"models":[{"slug":"x"}]}');
  // The state store's path is a directory: reads and writes both throw.
  const stateFile = join(dir, ".copilot-env-state.json");
  rmSync(stateFile, { force: true });
  mkdirSync(stateFile);
  const deps = { acceptsCatalog: () => true, codexVersion: () => "1.0.0" };
  expect(inspectCatalogFile(file, deps)).toBe("accepted");
  expect(inspectCatalogFile(file, deps)).toBe("accepted");
});

test("inspectCatalogFile: one read decides unusable, then hands the same bytes to the probe", () => {
  isolate();
  const file = new CopilotApiPaths().codexModelCatalogFile;
  let seen: string | null = null;
  // An unknown codex version: nothing is recorded or trusted, every call probes.
  const judging = (verdict: boolean | null) => ({
    acceptsCatalog: (json: string) => {
      seen = json;
      return verdict;
    },
    codexVersion: () => null,
  });
  // Absent, unreadable (a directory), malformed, empty: unusable before any probe.
  expect(inspectCatalogFile(file, judging(true))).toBe("unusable");
  mkdirSync(file);
  expect(inspectCatalogFile(file, judging(true))).toBe("unusable");
  rmSync(file, { recursive: true });
  writeFileSync(file, "{ corrupt");
  expect(inspectCatalogFile(file, judging(true))).toBe("unusable");
  writeFileSync(file, '{"models":[]}');
  expect(inspectCatalogFile(file, judging(true))).toBe("unusable");
  expect(seen).toBeNull();
  // A catalog: the probe's verdict, over exactly the bytes read.
  writeFileSync(file, '{"models":[{"slug":"x"}]}');
  expect(inspectCatalogFile(file, judging(false))).toBe("rejected");
  expect(seen).toBe('{"models":[{"slug":"x"}]}');
  expect(inspectCatalogFile(file, judging(true))).toBe("accepted");
  expect(inspectCatalogFile(file, judging(null))).toBe("unverifiable");
  // The default probe is off under the suite's live-lookup seam: unverifiable.
  expect(inspectCatalogFile(file)).toBe("unverifiable");
});

// --- the default probe's production path, through a fake `codex` on PATH ---------
// (POSIX shell scripts; the Windows .cmd dispatch is covered by the launch tests.)

const onPosix = test.skipIf(process.platform === "win32");

/** A fake `codex` first on PATH, a probe-runs ledger, and the catalog file to judge. */
function fakeCodexHarness() {
  isolate();
  const bin = join(dir, "bin");
  mkdirSync(bin);
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  delete process.env[CI_NO_LIVE_LOOKUPS_ENV];
  resetCatalogProbeState(); // a previous test's fake codex path must not be reused
  const seen = join(dir, "probe-seen.json");
  process.env.COPILOT_ENV_PROBE_SEEN = seen;
  const runs = join(dir, "probe-runs");
  process.env.COPILOT_ENV_PROBE_RUNS = runs;
  const file = new CopilotApiPaths().codexModelCatalogFile;
  // The referenced candidate path, if any (what a real codex would parse).
  const readCandidate =
    'candidate=$(sed -n \'s/^model_catalog_json = "\\(.*\\)"$/\\1/p\' "$CODEX_HOME/config.toml")';
  return {
    file,
    seen,
    readCandidate,
    dump: `echo '{"models":[{"slug":"fake"}]}'`,
    /** Install the fake: `debug models` runs append "<cwd> <CODEX_HOME>" to the ledger. */
    fake(body: string): void {
      const script = [
        "#!/bin/sh",
        'if [ "$1" = "debug" ]; then echo "$(pwd -P) $(cd "$CODEX_HOME" && pwd -P)" >> "$COPILOT_ENV_PROBE_RUNS"; fi',
        body,
        "",
      ].join("\n");
      writeFileSync(join(bin, "codex"), script);
      chmodSync(join(bin, "codex"), 0o755);
    },
    runs(): string[] {
      return existsSync(runs) ? readFileSync(runs, "utf8").split("\n").filter(Boolean) : [];
    },
    /** Distinct bytes per scenario: verdicts are memoized per content. */
    write(tag: string): string {
      const content = `{"models":[{"slug":"${tag}"}]}`;
      writeFileSync(file, content);
      return content;
    },
  };
}

onPosix(
  "rejected: the candidate run fails, the empty-config control dumps; the bytes judged are the file's, inside the throwaway home",
  () => {
    const h = fakeCodexHarness();
    const content = h.write("rejected");
    h.fake([
      h.readCandidate,
      'if [ -n "$candidate" ]; then cp "$candidate" "$COPILOT_ENV_PROBE_SEEN"; echo "Error: bad catalog" >&2; exit 1; fi',
      h.dump,
    ].join("\n"));
    expect(inspectCatalogFile(h.file)).toBe("rejected");
    expect(readFileSync(h.seen, "utf8")).toBe(content);
    const runs = h.runs();
    expect(runs.length).toBe(2); // the candidate run and its control
    // codex reads project config from cwd, so every run sits in its throwaway home.
    for (const line of runs) {
      const [cwd, home] = line.split(" ");
      expect(cwd).toBe(home);
    }
  },
);

onPosix(
  "accepted: the candidate parses and garbage through the same key fails; the same bytes are never judged twice",
  () => {
    const h = fakeCodexHarness();
    h.write("accepted");
    h.fake([
      h.readCandidate,
      'if ! grep -q \'"models"\' "$candidate"; then echo "Error: failed to parse model_catalog_json" >&2; exit 1; fi',
      'cat "$candidate"',
    ].join("\n"));
    expect(inspectCatalogFile(h.file)).toBe("accepted");
    expect(h.runs().length).toBe(2); // the candidate run and the garbage control
    expect(inspectCatalogFile(h.file)).toBe("accepted");
    expect(h.runs().length).toBe(2); // the auth-time re-judgement spawns nothing
  },
);

onPosix("unverifiable: a run that proves nothing either way never becomes a verdict", () => {
  const h = fakeCodexHarness();
  const cases: [name: string, body: string][] = [
    // Exits 0 but dumps something other than the candidate: it was never read.
    ["dumps-other-slugs", h.dump],
    // Echoes the candidate's own slugs yet would swallow garbage too.
    [
      "echoes-candidate-swallows-garbage",
      `echo '{"models":[{"slug":"echoes-candidate-swallows-garbage"}]}'`,
    ],
    // Fails with AND without the catalog: not the catalog's fault.
    ["fails-either-way", 'echo "Error: config broken" >&2; exit 1'],
    // Fails with the catalog, but the control exits 0 without a dump.
    [
      "blank-control",
      [h.readCandidate, 'if [ -n "$candidate" ]; then exit 1; fi', "echo"].join("\n"),
    ],
    // Exits 0 without a catalog dump.
    ["no-dump", "echo nothing"],
    // Killed while judging the candidate (no exit code), though the control would dump.
    [
      "killed-candidate",
      [h.readCandidate, 'if [ -n "$candidate" ]; then kill -TERM $$; fi', h.dump].join("\n"),
    ],
  ];
  for (const [name, body] of cases) {
    h.write(name);
    h.fake(body);
    expect([name, inspectCatalogFile(h.file)]).toEqual([name, "unverifiable"]);
  }
});

onPosix("a spent probe budget judges nothing and spawns nothing", () => {
  const h = fakeCodexHarness();
  h.fake(h.dump);
  // Control: with budget, a judgement spawns the fake.
  h.write("budgeted");
  expect(inspectCatalogFile(h.file)).toBe("unverifiable");
  expect(h.runs().length).toBe(1);
  // Spent: a further file is not even spawned for.
  h.write("unbudgeted");
  resetCatalogProbeState(0);
  try {
    expect(inspectCatalogFile(h.file)).toBe("unverifiable");
    expect(h.runs().length).toBe(1);
  } finally {
    resetCatalogProbeState();
  }
});

test("the refresh's worst case (derived from its real timeouts and lock waits) plus the gh look fits the direct auth timeout", () => {
  // Constant arithmetic on purpose: AUTH_REFRESH_WORST_CASE_MS is built from the
  // budgets the code passes to its spawns, fetches, and lock waits, so a raised
  // budget that would overrun Codex's auth deadline fails here.
  const STARTUP_MARGIN_MS = 1000;
  expect(GH_AUTH_TIMEOUT_MS + AUTH_REFRESH_WORST_CASE_MS + STARTUP_MARGIN_MS)
    .toBeLessThanOrEqual(DIRECT_AUTH_TIMEOUT_MS);
});

test("past the refresh deadline the catalog is still written but its acceptance is not memoized", async () => {
  isolate();
  // The deadline is taken at the first tick; the clock then jumps past it.
  const t0 = 1_700_000_000_000;
  let calls = 0;
  const deps = {
    nowMs: () => (calls++ < 2 ? t0 : t0 + 60_000),
    codexVersion: () => "1.0.0",
    bundledCatalog: () => BUNDLED,
    fetchCopilotModels: async () => GPT55_ONLY,
    acceptsCatalog: () => true,
  };
  const regenerated = await withCatalogRefreshDeadline(
    deps,
    () => refreshCodexModelCatalogIfStale("direct", deps),
  );
  expect(regenerated).toBe(true);
  expect(existsSync(new CopilotApiPaths().codexModelCatalogFile)).toBe(true);
  expect(new CopilotEnvState().read().codexCatalogAccepted).toBeNull();
  // Control: inside the deadline the same run records the acceptance.
  const later = { ...deps, nowMs: () => t0 + 2 * MILLISECONDS_PER_DAY };
  await withCatalogRefreshDeadline(later, () => refreshCodexModelCatalogIfStale("direct", later));
  expect(new CopilotEnvState().read().codexCatalogAccepted?.codexVersion).toBe("1.0.0");
});

test("a codex version change bypasses the daily throttle (new bundled catalog within one cycle)", async () => {
  isolate();
  const now = 1_700_000_000_000;
  // A refresh just ran (fresh timestamp) against codex 0.144.0.
  new CopilotEnvState().set({
    codexCatalogLastAttemptMs: now - 1000,
    codexCatalogCodexVersion: "0.144.0",
    codexCatalogPatchVersion: CATALOG_PATCH_VERSION,
  });

  // Same version + fresh timestamp: throttled.
  let called = false;
  const deps = {
    nowMs: () => now,
    bundledCatalog: () => BUNDLED,
    acceptsCatalog: () => true,
    fetchCopilotModels: async () => {
      called = true;
      return GPT55_ONLY;
    },
  };
  expect(
    await refreshCodexModelCatalogIfStale("direct", { ...deps, codexVersion: () => "0.144.0" }),
  ).toBe(false);
  expect(called).toBe(false);

  // Upgraded codex: the file REPLACES the bundled catalog, so the new binary's
  // models would stay hidden behind the throttle -- a version change regenerates now.
  expect(
    await refreshCodexModelCatalogIfStale("direct", { ...deps, codexVersion: () => "0.145.0" }),
  ).toBe(true);
  expect(called).toBe(true);
  expect(new CopilotEnvState().read().codexCatalogCodexVersion).toBe("0.145.0");

  // An unresolvable version (codex missing) is NOT a change -- still throttled.
  called = false;
  expect(
    await refreshCodexModelCatalogIfStale("direct", { ...deps, codexVersion: () => null }),
  ).toBe(false);
  expect(called).toBe(false);
});

test("a catalog patch-logic change bypasses the daily throttle", async () => {
  isolate();
  const now = 1_700_000_000_000;
  // A refresh just ran (fresh timestamp, same codex) under the PREVIOUS patch
  // logic: its on-disk catalog may carry exactly what the new patch removes.
  new CopilotEnvState().set({
    codexCatalogLastAttemptMs: now - 1000,
    codexCatalogCodexVersion: "0.144.0",
    codexCatalogPatchVersion: CATALOG_PATCH_VERSION - 1,
  });
  const regenerated = await refreshCodexModelCatalogIfStale("direct", {
    nowMs: () => now,
    codexVersion: () => "0.144.0",
    bundledCatalog: () => BUNDLED,
    fetchCopilotModels: async () => GPT55_ONLY,
    acceptsCatalog: () => true,
  });
  expect(regenerated).toBe(true);
  expect(new CopilotEnvState().read().codexCatalogPatchVersion).toBe(CATALOG_PATCH_VERSION);
});

test("a failed post-upgrade regeneration does not retry on the next same-version call", async () => {
  isolate();
  const now = 1_700_000_000_000;
  new CopilotEnvState().set({
    codexCatalogLastAttemptMs: now - 1000,
    codexCatalogCodexVersion: "0.144.0",
    codexCatalogPatchVersion: CATALOG_PATCH_VERSION,
  });

  // Upgrade detected, but generation fails: the attempt AND new version are
  // recorded up front, so the failure is not retried on every 300s auth cycle.
  let calls = 0;
  const deps = {
    nowMs: () => now,
    codexVersion: () => "0.145.0",
    bundledCatalog: () => null,
    fetchCopilotModels: async () => {
      calls++;
      return GPT55_ONLY;
    },
  };
  expect(await refreshCodexModelCatalogIfStale("direct", deps)).toBe(false);
  expect(calls).toBe(1);
  expect(new CopilotEnvState().read().codexCatalogCodexVersion).toBe("0.145.0");

  expect(await refreshCodexModelCatalogIfStale("direct", deps)).toBe(false);
  expect(calls).toBe(1); // throttled: same version, fresh attempt timestamp
});

// --- the opt-in gate ----------------------------------------------------------

test("generate is a no-op when the catalog is not opted in", async () => {
  isolate();
  new CopilotEnvConfig().del("codexModelCatalog");
  const ok = await generateCodexModelCatalog("direct", {
    bundledCatalog: () => {
      throw new Error("must not be called");
    },
    fetchCopilotModels: async () => {
      throw new Error("must not be called");
    },
  });
  expect(ok).toBe(false);
  expect(existsSync(new CopilotApiPaths().codexModelCatalogFile)).toBe(false);
});

test("refresh is a no-op when disabled: no throttle state write", async () => {
  isolate();
  new CopilotEnvConfig().set({ codexModelCatalog: false });
  const ok = await refreshCodexModelCatalogIfStale("direct", {
    nowMs: () => 1_000_000,
    codexVersion: () => "1.0.0",
    bundledCatalog: () => {
      throw new Error("must not be called");
    },
    fetchCopilotModels: async () => {
      throw new Error("must not be called");
    },
  });
  expect(ok).toBe(false);
  // The gate sits BEFORE the attempt recording: a disabled install must never
  // re-create the throttle fields cleanup deleted.
  const state = new CopilotEnvState().read();
  expect(state.codexCatalogLastAttemptMs).toBe(0);
  expect(state.codexCatalogCodexVersion).toBeNull();
});
