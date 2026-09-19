import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import {
  CATALOG_PATCH_VERSION,
  type CopilotCatalogModel,
  type CopilotModelLimits,
  generateCodexModelCatalog,
  inspectCatalogFile,
  parseCopilotModels,
  patchModelCatalog,
  refreshCodexModelCatalogIfStale,
  resetCatalogProbeState,
} from "../src/codex/catalog.ts";
import { refreshCodexCatalogAndSync } from "../src/codex/catalog_reference.ts";
import { codexConfigPath } from "../src/codex/paths.ts";
import { CI_NO_LIVE_LOOKUPS_ENV, codexUserAgent } from "../src/codex/user_agent.ts";
import { runDryRun } from "../src/commands/dry_run.ts";
import { directClientHeaders } from "../src/copilot_api/integration_identity.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { OwnershipLedger } from "../src/copilot_api/ownership.ts";
import { CopilotApiPaths } from "../src/copilot_api/paths.ts";
import { MILLISECONDS_PER_DAY } from "../src/utils/time.ts";
import {
  type FakeCodex,
  fakeCodexOnPath,
  type FakeCodexProbe,
  type FakeCodexSpec,
} from "./helpers/fake_codex.ts";
import { captureChannels } from "./helpers/output.ts";
import { afterEach, expect, test } from "./helpers/testing.ts";
import { envSnapshot, isolateProxyHome } from "./helpers/env.ts";
import { linesNaming } from "./helpers/dry_run.ts";

const restoreEnv = envSnapshot(["PATH", CI_NO_LIVE_LOOKUPS_ENV]);
let dir = "";

afterEach(() => {
  restoreEnv();
});

function isolate(): void {
  dir = isolateProxyHome("copilot-catalog-");
  // The catalog is opt-in (default false); the disabled-gate tests at the end turn it back off.
  new CopilotEnvConfig().set({ "codex.model-catalog": true });
}

type Model = Record<string, unknown>;

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
  const limits = { max_context_window_tokens: 400_000, max_prompt_tokens: 272_000 };
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
      // An empty or ill-typed effort list is unadvertised (null), never an empty list.
      { id: "empty", capabilities: { limits, supports: { reasoning_effort: [] } } },
      { id: "ill-typed", capabilities: { limits, supports: { reasoning_effort: [1, null] } } },
    ],
  });
  expect([...models.keys()]).toEqual(["gpt-5.5", "empty", "ill-typed"]);
  expect(models.get("gpt-5.5")).toEqual({
    limits: GPT55_LIMITS,
    name: "GPT-5.5",
    reasoningEfforts: ["low", "medium"],
    parallelToolCalls: true,
    codexServable: true,
  });
  expect(models.get("empty")?.reasoningEfforts).toBeNull();
  expect(models.get("ill-typed")?.reasoningEfforts).toBeNull();
  // A shapeless body parses to no models at all.
  for (const body of [null, { data: "nope" }, {}]) {
    expect(parseCopilotModels(body).size, JSON.stringify(body)).toBe(0);
  }
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

  // An EMPTY effort list on the twin says nothing, so the base's list wins (an empty list must
  // never read as "no shared effort").
  const emptyTwin = {
    ...twin,
    capabilities: { ...twin.capabilities, supports: { reasoning_effort: [] } },
  };
  expect(parseCopilotModels({ data: [base, emptyTwin] }).get("claude-x")?.reasoningEfforts)
    .toEqual(["low"]);
  expect(parseCopilotModels({ data: [emptyTwin, base] }).get("claude-x")?.reasoningEfforts)
    .toEqual(["low"]);
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

  // The percent is floored to the prompt cap (922000 / 1050000 -> 87): the bundled 95% would 413
  // upstream before compact.
  expect(models[0]?.context_window).toBe(1_050_000);
  expect(models[0]?.max_context_window).toBe(1_050_000);
  expect(models[0]?.effective_context_window_percent).toBe(87);
  expect(models[0]?.display_name).toBe("GPT-5.5");
  expect(models[0]?.nested).toEqual({ keep: ["me", 1] });
  // Tiers are EMPTIED on every model: they make Codex send `service_tier`, which Copilot's
  // /responses rejects. The keys stay, so the entry keeps the dump's exact key set.
  expect(models[0]?.service_tiers).toEqual([]);
  expect(models[0]?.additional_speed_tiers).toEqual([]);
  expect(models[0]?.supports_parallel_tool_calls).toBe(true);
  expect(models[1]).toEqual({
    slug: "gpt-5.2",
    context_window: 272_000,
    effective_context_window_percent: 95,
    service_tiers: [],
    supports_parallel_tool_calls: false,
  });
  expect(models[2]).toEqual({ no_slug: true, supports_parallel_tool_calls: false });
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
  expect(solFast.display_name).toBe("GPT-5.6 Sol Fast");
  expect(solFast.description).toBe(
    "GPT-5.6 Sol Fast, served by GitHub Copilot (not bundled with Codex)",
  );
  expect(solFast.context_window).toBe(1_050_000);
  expect(solFast.max_context_window).toBe(1_050_000);
  expect(solFast.effective_context_window_percent).toBe(87);
  expect(solFast.supports_parallel_tool_calls).toBe(true);
  expect(solFast.base_instructions).toBe("instructions for gpt-5.6-sol");
  expect(solFast.experimental_supported_tools).toEqual(["a", "b"]);
  // Donor-specific claims are dropped: the clone is listed and API-served in its own right.
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
  // A dump with no gpt-* entry has no donor family: nothing is added.
  const noDonor = patchModelCatalog(
    JSON.stringify({ models: [{ slug: "codex-auto-review" }] }),
    modelsOf([["gpt-6-astra", copilotModel(ASTRA_LIMITS)]]),
  );
  expect(modelsIn(noDonor).map((m) => m.slug)).toEqual(["codex-auto-review"]);
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
// The production path end to end: the fake codex on PATH answers the bundled dump, the version,
// and the acceptance probe; Copilot is a fetch that answers every request with one `/models` body.

const BUNDLED = JSON.stringify({
  models: [{ slug: "gpt-5.5", context_window: 272_000, effective_context_window_percent: 95 }],
});
/** Copilot's `/models` body serving gpt-5.5 alone, at GPT55_LIMITS. */
const GPT55_BODY = {
  data: [{
    id: "gpt-5.5",
    "model_picker_enabled": true,
    "supported_endpoints": ["/responses"],
    capabilities: {
      type: "chat",
      limits: { "max_context_window_tokens": 1_050_000, "max_prompt_tokens": 922_000 },
    },
  }],
};
const TOKEN = "gho_x";

/** Copilot as the direct fetch reaches it: every request (the identity probes, then GET /models)
 *  answers 200 with `body`; null is a Copilot that cannot be reached. */
async function withCopilot<T>(
  body: unknown,
  fn: () => Promise<T>,
): Promise<{ result: T; sent: unknown[] }> {
  const sent: unknown[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    sent.push(init?.headers);
    if (body === null) return Promise.reject(new Error("offline"));
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  }) as typeof fetch;
  try {
    return { result: await fn(), sent };
  } finally {
    globalThis.fetch = realFetch;
  }
}

/** The opted-in isolated home with the fake codex on PATH: a bundled dump, an accepting probe. */
function catalogFixture(spec: Partial<FakeCodexSpec> = {}): FakeCodex {
  isolate();
  return fakeCodexOnPath(dir, { bundled: BUNDLED, probe: "accept", ...spec });
}

/** The default credential the refresh resolves when no caller hands it a token. */
function storeCredential(): void {
  new CopilotEnvState().setCredential(null, { kind: "stored", provider: "gh-token", token: TOKEN });
}

function generate(body: unknown = GPT55_BODY): Promise<boolean> {
  return withCopilot(body, () => generateCodexModelCatalog("direct", TOKEN))
    .then(({ result }) => result);
}

/** The narration and the write reports of a run, as one stderr text. */
async function stderrOf(fn: () => Promise<void>): Promise<string> {
  return (await captureChannels(fn, { writeReports: true })).stderr;
}

test("the Copilot seed asks the direct catalog with the exact header set Codex bakes", async () => {
  // The generated catalog is what Codex's OWN requests are then pinned to, and Copilot gates the
  // list per identity: a list fetched under another header set can advertise models Codex is
  // refused, or miss ones it is served. So the seed's GET carries the exact header set the baked
  // config sends: the versioned codex_exec UA, Openai-Intent, no id for the codex identity; the
  // identity probe and the `host auto` probe before it send the same set (the deadline
  // signal keeps them off the process memo, so each is its own request here).
  catalogFixture();
  const { sent } = await withCopilot(
    { data: [{ "id": "gpt-5.5", "capabilities": { "type": "chat" } }] },
    () => generateCodexModelCatalog("direct", TOKEN),
  );
  const asCodex = { ...directClientHeaders(codexUserAgent()), Authorization: `Bearer ${TOKEN}` };
  expect(sent).toEqual([asCodex, asCodex, asCodex]);
});

test("generateCodexModelCatalog writes the patched catalog file", async () => {
  catalogFixture();
  let ok = false;
  const narrated = await stderrOf(async () => {
    ok = await generate();
  });
  expect(ok).toBe(true);
  const file = new CopilotApiPaths().codexModelCatalogFile;
  // The catalog lives inside the data home: written, never named (stdout may be a token).
  expect(linesNaming(narrated, file)).toEqual([]);
  const written = JSON.parse(readFileSync(file, "utf8"));
  expect(written.models[0].context_window).toBe(1_050_000);
  expect(written.models[0].effective_context_window_percent).toBe(87);
  // Owner-only, like every file the store writes beside it.
  if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
});

test("a regenerated catalog identical to the one on disk previews as unchanged", async () => {
  // The catalog is written whole on every generation; a dry run over an unchanged upstream must
  // read the byte-identical rewrite as no change, as it does for config.toml and settings.json.
  catalogFixture();
  await captureChannels(async () => {
    expect(await generate()).toBe(true);
  });
  const file = new CopilotApiPaths().codexModelCatalogFile;
  const before = readFileSync(file, "utf8");
  const { stdout } = await captureChannels(() => runDryRun(() => generate()));
  // The print wraps to the terminal width (mid-path, or at the space after the verdict): the rows
  // are re-joined by their two-space indent, then the catalog's row is matched exactly.
  const rows = stdout.split("\n").slice(1).join("\n").split(/\n {2}(?! )/).map((row) =>
    row.replace(/\s+/g, "")
  );
  expect(rows).toEqual([`unchanged${file}`.replace(/\s+/g, "")]);
  expect(readFileSync(file, "utf8")).toBe(before);
});

test("generateCodexModelCatalog fetches Copilot FIRST (cheap fail skips the codex spawn)", async () => {
  const codex = catalogFixture();
  expect(await generate(null)).toBe(false);
  expect(codex.runs()).toEqual([]);
  expect(existsSync(new CopilotApiPaths().codexModelCatalogFile)).toBe(false);
});

test("a candidate the installed codex rejects is never written; an unverifiable one is", async () => {
  const codex = catalogFixture({ probe: "reject" });
  const file = new CopilotApiPaths().codexModelCatalogFile;
  expect(await generate()).toBe(false);
  expect(existsSync(file)).toBe(false);
  // The probe judged the patched document, not the raw dump.
  expect(JSON.parse(codex.seen() ?? "").models[0].context_window).toBe(1_050_000);

  codex.script({ probe: "dump-other" });
  let written = false;
  const narrated = await stderrOf(async () => {
    written = await generate();
  });
  expect(written).toBe(true);
  expect(existsSync(file)).toBe(true);
  expect(linesNaming(narrated, file)).toEqual([]); // in the data home: unnamed
});

test("a failed regeneration never touches an existing (stale but valid) catalog", async () => {
  // No resolvable codex version: the acceptance record stays empty, so every judgement asks.
  const codex = catalogFixture({ version: null });
  expect(await generate()).toBe(true);
  const before = readFileSync(new CopilotApiPaths().codexModelCatalogFile, "utf8");

  codex.script({ bundled: null });
  expect(await generate()).toBe(false);
  codex.script({ bundled: BUNDLED });
  expect(await generate(null)).toBe(false);
  codex.script({ probe: "reject" });
  expect(await generate()).toBe(false);
  expect(readFileSync(new CopilotApiPaths().codexModelCatalogFile, "utf8")).toBe(before);
});

// --- refreshCodexModelCatalogIfStale -----------------------------------------

test("refresh records the ATTEMPT timestamp even when generation fails", async () => {
  catalogFixture({ bundled: null });
  storeCredential();
  new CopilotEnvState().set({
    codexCatalogLastAttemptMs: Date.now() - MILLISECONDS_PER_DAY - 1,
  });
  const before = Date.now();
  const { result } = await withCopilot(GPT55_BODY, () => refreshCodexModelCatalogIfStale("direct"));
  expect(result).toBe(false);
  // Attempt recorded BEFORE the (failed) generation: no retry storm on the
  // repeated direct launches.
  const attempt = new CopilotEnvState().read().codexCatalogLastAttemptMs;
  expect(attempt).toBeGreaterThanOrEqual(before);
  expect(attempt).toBeLessThanOrEqual(Date.now());
});

test("past the refresh deadline the catalog is still written, but neither the acceptance memo nor the reference and its claim are", async () => {
  catalogFixture({ version: "1.0.0" });
  storeCredential();
  // A managed config with no reference yet: the sync after the refresh would add one.
  const codexHome = join(dir, ".codex");
  process.env.CODEX_HOME = codexHome;
  mkdirSync(codexHome, { recursive: true });
  const configPath = codexConfigPath(codexHome);
  const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
  writeFileSync(configPath, 'model_provider = "copilot-env"\n');
  const reference = () =>
    (parse(readFileSync(configPath, "utf8")) as Record<string, unknown>)
      .model_catalog_json;
  // The deadline is taken as the refresh starts; the clock then jumps past it while Copilot
  // answers, so the probe, the memo, and the reference sync all run late.
  const realNow = Date.now;
  let skewMs = 0;
  Date.now = () => realNow() + skewMs;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    skewMs = 60_000;
    return Promise.resolve(new Response(JSON.stringify(GPT55_BODY), { status: 200 }));
  }) as typeof fetch;
  let said = "";
  try {
    said = await stderrOf(() => refreshCodexCatalogAndSync("direct"));
  } finally {
    globalThis.fetch = realFetch;
    Date.now = realNow;
  }
  expect(existsSync(catalogFile)).toBe(true);
  expect(new CopilotEnvState().read().codexCatalogAccepted).toBeNull();
  expect(reference()).toBeUndefined();
  expect(new OwnershipLedger().owns("codexCatalog", configPath)).toBe(false);
  // The logger wraps to the terminal width (mid-path included), so both sides drop whitespace.
  const unwrapped = (text: string) => text.replace(/\s+/g, "");
  expect(unwrapped(said)).toContain(unwrapped(
    `catalog reference not set in ${configPath}: ownership could not be recorded; ` +
      "the next wiring or direct launch retries",
  ));
  // Control: inside the deadline the same run records the acceptance, the reference, and the claim.
  new CopilotEnvState().set({ codexCatalogLastAttemptMs: Date.now() - MILLISECONDS_PER_DAY - 1 });
  await withCopilot(GPT55_BODY, () => refreshCodexCatalogAndSync("direct"));
  expect(new CopilotEnvState().read().codexCatalogAccepted?.codexVersion).toBe("1.0.0");
  expect(reference()).toBe(catalogFile);
  expect(new OwnershipLedger().owns("codexCatalog", configPath)).toBe(true);
});

// --- inspectCatalogFile -----------------------------------

test("an accepted catalog is remembered by content and codex version: no re-probe until either changes", async () => {
  const codex = catalogFixture({ version: "1.0.0" });
  const file = new CopilotApiPaths().codexModelCatalogFile;
  expect(await generate()).toBe(true);
  expect(codex.runs().filter((run) => !run.args.includes("--bundled")).length).toBe(2); // the candidate and the garbage control
  const recorded = new CopilotEnvState().read().codexCatalogAccepted;
  expect(recorded?.codexVersion).toBe("1.0.0");
  expect(recorded?.sha256).toMatch(/^[0-9a-f]{64}$/);

  // Same bytes, same codex: the record answers, and a codex that would now reject is never asked.
  codex.script({ probe: "reject" });
  expect(inspectCatalogFile(file)).toBe("accepted");
  expect(codex.runs().length).toBe(3);
  // A codex upgrade asks again (and a rejection is not recorded).
  codex.script({ version: "2.0.0" });
  expect(inspectCatalogFile(file)).toBe("rejected");
  expect(codex.runs().length).toBe(5);
  expect(new CopilotEnvState().read().codexCatalogAccepted).toEqual(recorded);
  codex.script({ probe: "accept" });
  expect(inspectCatalogFile(file)).toBe("accepted");
  expect(new CopilotEnvState().read().codexCatalogAccepted?.codexVersion).toBe("2.0.0");
  codex.script({ probe: "reject" });
  expect(inspectCatalogFile(file)).toBe("accepted");
  // A changed file asks again; an unknown codex version never trusts or updates the record.
  writeFileSync(file, '{"models":[{"slug":"other"}]}');
  expect(inspectCatalogFile(file)).toBe("rejected");
  codex.script({ probe: "accept", version: null });
  expect(inspectCatalogFile(file)).toBe("accepted");
  expect(new CopilotEnvState().read().codexCatalogAccepted?.codexVersion).toBe("2.0.0");
  codex.script({ probe: "reject" });
  expect(inspectCatalogFile(file)).toBe("rejected");
});

test("a proven acceptance survives an acceptance cache that cannot be read or written", () => {
  catalogFixture({ version: "1.0.0" });
  const file = new CopilotApiPaths().codexModelCatalogFile;
  writeFileSync(file, '{"models":[{"slug":"x"}]}');
  // The state store's path is a directory: reads and writes both throw.
  const stateFile = join(dir, "state.json");
  rmSync(stateFile, { force: true });
  mkdirSync(stateFile);
  expect(inspectCatalogFile(file)).toBe("accepted");
  expect(inspectCatalogFile(file)).toBe("accepted");
});

test("inspectCatalogFile: one read decides unusable, then hands the same bytes to the probe", () => {
  // An unknown codex version: nothing is recorded or trusted, every judgement probes.
  const codex = catalogFixture({ version: null });
  const file = new CopilotApiPaths().codexModelCatalogFile;
  expect(inspectCatalogFile(file)).toBe("unusable");
  mkdirSync(file);
  expect(inspectCatalogFile(file)).toBe("unusable");
  rmSync(file, { recursive: true });
  writeFileSync(file, "{ corrupt");
  expect(inspectCatalogFile(file)).toBe("unusable");
  writeFileSync(file, '{"models":[]}');
  expect(inspectCatalogFile(file)).toBe("unusable");
  expect(codex.runs()).toEqual([]);
  writeFileSync(file, '{"models":[{"slug":"x"}]}');
  codex.script({ probe: "reject" });
  expect(inspectCatalogFile(file)).toBe("rejected");
  expect(codex.seen()).toBe('{"models":[{"slug":"x"}]}');
  codex.script({ probe: "accept" });
  expect(inspectCatalogFile(file)).toBe("accepted");
  codex.script({ probe: "dump-other" });
  expect(inspectCatalogFile(file)).toBe("unverifiable");
  // The probe is off under the suite's live-lookup seam: unverifiable, without a spawn.
  codex.script({ probe: "accept" });
  process.env[CI_NO_LIVE_LOOKUPS_ENV] = "1";
  const spawned = codex.runs().length;
  expect(inspectCatalogFile(file)).toBe("unverifiable");
  expect(codex.runs().length).toBe(spawned);
});

// --- the probe's verdict rules, through the fake codex -----------------------------

/** Distinct bytes per scenario: verdicts are memoized per content. */
function writeCatalog(tag: string): string {
  const file = new CopilotApiPaths().codexModelCatalogFile;
  const content = `{"models":[{"slug":"${tag}"}]}`;
  writeFileSync(file, content);
  return content;
}

test("rejected: the candidate run fails, the empty-config control dumps; the bytes judged are the file's, inside the throwaway home", () => {
  const codex = catalogFixture({ probe: "reject" });
  const content = writeCatalog("rejected");
  expect(inspectCatalogFile(new CopilotApiPaths().codexModelCatalogFile)).toBe("rejected");
  expect(codex.seen()).toBe(content);
  const runs = codex.runs();
  expect(runs.length).toBe(2); // the candidate run and its control
  // codex reads project config from cwd, so every run sits in its throwaway home.
  for (const run of runs) expect(run.cwd).toBe(run.home);
});

test("accepted: the candidate parses and garbage through the same key fails; the same bytes are never judged twice", () => {
  // No resolvable version: the acceptance record stays empty, so the second look is answered by
  // the per-process verdict memo, never the store.
  const codex = catalogFixture({ probe: "accept", version: null });
  writeCatalog("accepted");
  const file = new CopilotApiPaths().codexModelCatalogFile;
  expect(inspectCatalogFile(file)).toBe("accepted");
  expect(codex.runs().length).toBe(2); // the candidate run and the garbage control
  expect(inspectCatalogFile(file)).toBe("accepted");
  expect(codex.runs().length).toBe(2); // the later re-judgement spawns nothing
});

test("unverifiable: a run that proves nothing either way never becomes a verdict", () => {
  const codex = catalogFixture();
  const cases: FakeCodexProbe[] = [
    // Exits 0 but dumps something other than the candidate: it was never read.
    "dump-other",
    // Echoes the candidate's own slugs yet would swallow garbage too.
    "echo-any",
    // Fails with AND without the catalog: not the catalog's fault.
    "fail-always",
    // Fails with the catalog, but the control exits 0 without a dump.
    "blank-control",
    // Exits 0 without a catalog dump.
    "no-dump",
    // Killed while judging the candidate (no exit code), though the control would dump. A Windows
    // process ended by signal still reports an exit code, so that arm is POSIX-only.
    ...(process.platform === "win32" ? [] : ["kill-candidate" as const]),
  ];
  for (const probe of cases) {
    writeCatalog(probe);
    codex.script({ probe });
    expect([probe, inspectCatalogFile(new CopilotApiPaths().codexModelCatalogFile)])
      .toEqual([probe, "unverifiable"]);
  }
});

test("a spent probe budget judges nothing and spawns nothing", () => {
  const codex = catalogFixture({ probe: "dump-other" });
  const file = new CopilotApiPaths().codexModelCatalogFile;
  // Control: with budget, a judgement spawns the fake.
  writeCatalog("budgeted");
  expect(inspectCatalogFile(file)).toBe("unverifiable");
  expect(codex.runs().length).toBe(1);
  writeCatalog("unbudgeted");
  resetCatalogProbeState(0);
  try {
    expect(inspectCatalogFile(file)).toBe("unverifiable");
    expect(codex.runs().length).toBe(1);
  } finally {
    resetCatalogProbeState();
  }
});

test("a codex version change bypasses the daily throttle (new bundled catalog within one cycle)", async () => {
  const codex = catalogFixture({ version: "0.144.0" });
  storeCredential();
  new CopilotEnvState().set({
    codexCatalogLastAttemptMs: Date.now() - 1000,
    codexCatalogCodexVersion: "0.144.0",
    codexCatalogPatchVersion: CATALOG_PATCH_VERSION,
  });
  const refresh = () => withCopilot(GPT55_BODY, () => refreshCodexModelCatalogIfStale("direct"));
  // Same version, fresh attempt timestamp: throttled, so nothing is fetched and nothing spawned.
  const throttled = await refresh();
  expect(throttled.result).toBe(false);
  expect(throttled.sent).toEqual([]);
  expect(codex.runs()).toEqual([]);

  // Upgraded codex: the file REPLACES the bundled catalog, so the new binary's
  // models would stay hidden behind the throttle -- a version change regenerates now.
  codex.script({ version: "0.145.0" });
  const upgraded = await refresh();
  expect(upgraded.result).toBe(true);
  expect(upgraded.sent.length).toBeGreaterThan(0);
  expect(new CopilotEnvState().read().codexCatalogCodexVersion).toBe("0.145.0");

  // An unresolvable version (codex missing) is NOT a change -- still throttled.
  codex.script({ version: null });
  const unresolved = await refresh();
  expect(unresolved.result).toBe(false);
  expect(unresolved.sent).toEqual([]);
});

test("a catalog patch-logic change bypasses the daily throttle", async () => {
  catalogFixture({ version: "0.144.0" });
  storeCredential();
  // A catalog written under the PREVIOUS patch logic may carry exactly what the new patch removes.
  new CopilotEnvState().set({
    codexCatalogLastAttemptMs: Date.now() - 1000,
    codexCatalogCodexVersion: "0.144.0",
    codexCatalogPatchVersion: CATALOG_PATCH_VERSION - 1,
  });
  const { result } = await withCopilot(GPT55_BODY, () => refreshCodexModelCatalogIfStale("direct"));
  expect(result).toBe(true);
  expect(new CopilotEnvState().read().codexCatalogPatchVersion).toBe(CATALOG_PATCH_VERSION);
});

test("a failed post-upgrade regeneration does not retry on the next same-version call", async () => {
  catalogFixture({ version: "0.145.0", bundled: null });
  storeCredential();
  new CopilotEnvState().set({
    codexCatalogLastAttemptMs: Date.now() - 1000,
    codexCatalogCodexVersion: "0.144.0",
    codexCatalogPatchVersion: CATALOG_PATCH_VERSION,
  });

  // Upgrade detected, but generation fails: the attempt AND new version are
  // recorded up front, so the failure is not retried on every launch.
  const first = await withCopilot(GPT55_BODY, () => refreshCodexModelCatalogIfStale("direct"));
  expect(first.result).toBe(false);
  expect(first.sent.length).toBeGreaterThan(0);
  expect(new CopilotEnvState().read().codexCatalogCodexVersion).toBe("0.145.0");

  const second = await withCopilot(GPT55_BODY, () => refreshCodexModelCatalogIfStale("direct"));
  expect(second.result).toBe(false);
  expect(second.sent).toEqual([]); // throttled: same version, fresh attempt timestamp
});

// --- the opt-in gate ----------------------------------------------------------

test("generate is a no-op when the catalog is not opted in", async () => {
  const codex = catalogFixture();
  new CopilotEnvConfig().del("codex.model-catalog");
  const { result, sent } = await withCopilot(
    GPT55_BODY,
    () => generateCodexModelCatalog("direct", TOKEN),
  );
  expect(result).toBe(false);
  expect(sent).toEqual([]);
  expect(codex.runs()).toEqual([]);
  expect(existsSync(new CopilotApiPaths().codexModelCatalogFile)).toBe(false);
});

test("refresh is a no-op when disabled: no throttle state write", async () => {
  const codex = catalogFixture({ version: "1.0.0" });
  storeCredential();
  new CopilotEnvConfig().set({ "codex.model-catalog": false });
  const { result, sent } = await withCopilot(
    GPT55_BODY,
    () => refreshCodexModelCatalogIfStale("direct"),
  );
  expect(result).toBe(false);
  expect(sent).toEqual([]);
  expect(codex.runs()).toEqual([]);
  // The gate sits BEFORE the attempt recording: a disabled install must never
  // re-create the throttle fields cleanup deleted.
  const state = new CopilotEnvState().read();
  expect(state.codexCatalogLastAttemptMs).toBe(0);
  expect(state.codexCatalogCodexVersion).toBeNull();
});
