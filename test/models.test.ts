import {
  type CatalogModel,
  claudeCatalogRows,
  generateAliases,
  mergeUnlistedModels,
  newestClaudeModel,
  parseCatalogModels,
} from "../src/copilot_api/models.ts";
import { expect, test } from "./helpers/testing.ts";

// Each row pins the WHOLE alias map for its catalog, so an alias that must be absent is proven absent.
const ALIAS_ROWS: {
  name: string;
  catalog: CatalogModel[];
  aliases: Record<string, string>;
}[] = [
  {
    name: "a dot-form base id gets a dash alias and a [1m] alias that falls back to itself",
    catalog: [{ id: "claude-opus-4.8", is1m: false }],
    aliases: {
      "claude-opus-4-8": "claude-opus-4.8",
      "claude-opus-4-8[1m]": "claude-opus-4.8",
      "claude-opus-4.8[1m]": "claude-opus-4.8",
      opus: "claude-opus-4.8",
      "opus[1m]": "claude-opus-4.8",
      "claude-latest": "claude-opus-4.8",
      "claude-latest[1m]": "claude-opus-4.8",
    },
  },
  {
    name: "[1m] requests resolve to the 1m sibling, and opus prefers it",
    catalog: [{ id: "claude-opus-4.8", is1m: false }, { id: "claude-opus-4.8-1m", is1m: true }],
    aliases: {
      "claude-opus-4-8": "claude-opus-4.8",
      "claude-opus-4-8[1m]": "claude-opus-4.8-1m",
      "claude-opus-4.8[1m]": "claude-opus-4.8-1m",
      "claude-opus-4-8-1m": "claude-opus-4.8-1m",
      opus: "claude-opus-4.8-1m",
      "opus[1m]": "claude-opus-4.8-1m",
      "claude-latest": "claude-opus-4.8-1m",
      "claude-latest[1m]": "claude-opus-4.8-1m",
    },
  },
  {
    name: "family shorthand picks the newest version",
    catalog: [{ id: "claude-sonnet-4.5", is1m: false }, { id: "claude-sonnet-4.6", is1m: false }],
    aliases: {
      "claude-sonnet-4-5": "claude-sonnet-4.5",
      "claude-sonnet-4-5[1m]": "claude-sonnet-4.5",
      "claude-sonnet-4.5[1m]": "claude-sonnet-4.5",
      "claude-sonnet-4-6": "claude-sonnet-4.6",
      "claude-sonnet-4-6[1m]": "claude-sonnet-4.6",
      "claude-sonnet-4.6[1m]": "claude-sonnet-4.6",
      sonnet: "claude-sonnet-4.6",
      "sonnet[1m]": "claude-sonnet-4.6",
    },
  },
  {
    name: "a qualifier id gets a dash alias and neither a bare base alias nor a [1m] alias",
    catalog: [{ id: "claude-opus-4.7-high", is1m: false }],
    aliases: {
      "claude-opus-4-7-high": "claude-opus-4.7-high",
      opus: "claude-opus-4.7-high",
      "opus[1m]": "claude-opus-4.7-high",
      "claude-latest": "claude-opus-4.7-high",
      "claude-latest[1m]": "claude-opus-4.7-high",
    },
  },
  {
    name: "non-claude models produce no claude aliases, but GPTs get gpt-latest",
    catalog: [{ id: "gpt-5.5", is1m: false }, { id: "gemini-2.5-pro", is1m: false }],
    aliases: { "gpt-latest": "gpt-5.5" },
  },
  {
    name: "gpt-latest picks the newest non-mini GPT (mini/nano excluded)",
    catalog: [
      { id: "gpt-5", is1m: false },
      { id: "gpt-5.5", is1m: false },
      { id: "gpt-5-mini", is1m: false },
      { id: "gpt-6-nano", is1m: false },
      { id: "gpt-6", is1m: false },
    ],
    aliases: { "gpt-latest": "gpt-6" },
  },
  {
    name: "gpt-latest is absent when every GPT is a mini/nano tier",
    catalog: [{ id: "gpt-5-mini", is1m: false }, { id: "gpt-5-nano", is1m: false }],
    aliases: {},
  },
  {
    name: "gpt-latest tiebreak prefers the bare id over a same-version qualifier (bare first)",
    catalog: [{ id: "gpt-6", is1m: false }, { id: "gpt-6-foo", is1m: false }],
    aliases: { "gpt-latest": "gpt-6" },
  },
  {
    // Reversed order catches a 'last match wins' bug: the bare id must still win.
    name: "gpt-latest tiebreak prefers the bare id even when the qualifier appears first",
    catalog: [{ id: "gpt-6-foo", is1m: false }, { id: "gpt-6", is1m: false }],
    aliases: { "gpt-latest": "gpt-6" },
  },
  {
    // The live daemon catalog returns dash-form ids (`claude-opus-4-8`), not the dot form; the
    // regex once silently dropped every Claude model because of it.
    name: "dash-form catalog ids still produce the full alias set",
    catalog: [
      { id: "claude-opus-4-8", is1m: true },
      { id: "claude-sonnet-4-6", is1m: true },
      { id: "claude-haiku-4-5", is1m: false },
    ],
    aliases: {
      "claude-opus-4-8[1m]": "claude-opus-4-8",
      "claude-opus-4.8[1m]": "claude-opus-4-8",
      "claude-sonnet-4-6[1m]": "claude-sonnet-4-6",
      "claude-sonnet-4.6[1m]": "claude-sonnet-4-6",
      "claude-haiku-4-5[1m]": "claude-haiku-4-5",
      "claude-haiku-4.5[1m]": "claude-haiku-4-5",
      haiku: "claude-haiku-4-5",
      "haiku[1m]": "claude-haiku-4-5",
      opus: "claude-opus-4-8",
      "opus[1m]": "claude-opus-4-8",
      sonnet: "claude-sonnet-4-6",
      "sonnet[1m]": "claude-sonnet-4-6",
      "claude-latest": "claude-opus-4-8",
      "claude-latest[1m]": "claude-opus-4-8",
    },
  },
  {
    // An alias equal to the catalog id is skipped: the exact id passes through the proxy
    // unchanged anyway.
    name: "dash-form qualifier ids emit no identity alias",
    catalog: [{ id: "claude-opus-4-7-high", is1m: false }],
    aliases: {
      opus: "claude-opus-4-7-high",
      "opus[1m]": "claude-opus-4-7-high",
      "claude-latest": "claude-opus-4-7-high",
      "claude-latest[1m]": "claude-opus-4-7-high",
    },
  },
  {
    name: "dash-form [1m] requests resolve to a distinct dash-form 1m sibling",
    catalog: [{ id: "claude-opus-4-8", is1m: false }, { id: "claude-opus-4-8-1m", is1m: true }],
    aliases: {
      "claude-opus-4-8[1m]": "claude-opus-4-8-1m",
      "claude-opus-4.8[1m]": "claude-opus-4-8-1m",
      opus: "claude-opus-4-8-1m",
      "opus[1m]": "claude-opus-4-8-1m",
      "claude-latest": "claude-opus-4-8-1m",
      "claude-latest[1m]": "claude-opus-4-8-1m",
    },
  },
  {
    // Single-number generations (`claude-sonnet-5`, `claude-fable-5`) carry no minor version; the
    // regex must parse them or every alias silently vanishes. Dash and dot forms coincide for a
    // single-number version: no identity alias.
    name: "single-number version wins the family shorthand over an older major.minor",
    catalog: [{ id: "claude-sonnet-4-6", is1m: true }, { id: "claude-sonnet-5", is1m: true }],
    aliases: {
      "claude-sonnet-4-6[1m]": "claude-sonnet-4-6",
      "claude-sonnet-4.6[1m]": "claude-sonnet-4-6",
      "claude-sonnet-5[1m]": "claude-sonnet-5",
      sonnet: "claude-sonnet-5",
      "sonnet[1m]": "claude-sonnet-5",
    },
  },
  {
    // `claude-fable-5-1m` must backtrack to version 5 + qualifier `1m`.
    name: "fable links its 1m sibling through the single-number version",
    catalog: [{ id: "claude-fable-5", is1m: false }, { id: "claude-fable-5-1m", is1m: true }],
    aliases: {
      "claude-fable-5[1m]": "claude-fable-5-1m",
      fable: "claude-fable-5-1m",
      "fable[1m]": "claude-fable-5-1m",
      "claude-latest": "claude-fable-5-1m",
      "claude-latest[1m]": "claude-fable-5-1m",
    },
  },
  {
    name: "a single-number base without a sibling gets a [1m] alias falling back to itself",
    catalog: [{ id: "claude-fable-5", is1m: true }],
    aliases: {
      "claude-fable-5[1m]": "claude-fable-5",
      fable: "claude-fable-5",
      "fable[1m]": "claude-fable-5",
      "claude-latest": "claude-fable-5",
      "claude-latest[1m]": "claude-fable-5",
    },
  },
  {
    // A [1m] alias only exists when the id parsed with no qualifier, so its presence proves the
    // version group captured `4-5` whole.
    name: "greedy version keeps claude-haiku-4-5 as version 4.5, not qualifier 5",
    catalog: [{ id: "claude-haiku-4-5", is1m: false }],
    aliases: {
      "claude-haiku-4-5[1m]": "claude-haiku-4-5",
      "claude-haiku-4.5[1m]": "claude-haiku-4-5",
      haiku: "claude-haiku-4-5",
      "haiku[1m]": "claude-haiku-4-5",
    },
  },
  {
    // Deliberately out of alphabetical order to exercise the sorted iteration.
    name: "every claude family in the catalog gets a shorthand and a [1m] variant",
    catalog: [
      { id: "claude-sonnet-4-6", is1m: false },
      { id: "claude-fable-5", is1m: true },
      { id: "claude-opus-4-8", is1m: true },
    ],
    aliases: {
      "claude-sonnet-4-6[1m]": "claude-sonnet-4-6",
      "claude-sonnet-4.6[1m]": "claude-sonnet-4-6",
      "claude-fable-5[1m]": "claude-fable-5",
      "claude-opus-4-8[1m]": "claude-opus-4-8",
      "claude-opus-4.8[1m]": "claude-opus-4-8",
      fable: "claude-fable-5",
      "fable[1m]": "claude-fable-5",
      opus: "claude-opus-4-8",
      "opus[1m]": "claude-opus-4-8",
      sonnet: "claude-sonnet-4-6",
      "sonnet[1m]": "claude-sonnet-4-6",
      "claude-latest": "claude-fable-5",
      "claude-latest[1m]": "claude-fable-5",
    },
  },
  {
    name: "claude-latest prefers fable over opus",
    catalog: [
      { id: "claude-opus-4-8", is1m: true },
      { id: "claude-fable-5", is1m: false },
      { id: "claude-fable-5-1m", is1m: true },
    ],
    aliases: {
      "claude-opus-4-8[1m]": "claude-opus-4-8",
      "claude-opus-4.8[1m]": "claude-opus-4-8",
      "claude-fable-5[1m]": "claude-fable-5-1m",
      fable: "claude-fable-5-1m",
      "fable[1m]": "claude-fable-5-1m",
      opus: "claude-opus-4-8",
      "opus[1m]": "claude-opus-4-8",
      "claude-latest": "claude-fable-5-1m",
      "claude-latest[1m]": "claude-fable-5-1m",
    },
  },
  {
    name: "claude-latest falls back to the newest opus when no fable ships",
    catalog: [
      { id: "claude-opus-4-7", is1m: true },
      { id: "claude-opus-4-8", is1m: true },
      { id: "claude-sonnet-5", is1m: true },
    ],
    aliases: {
      "claude-opus-4-7[1m]": "claude-opus-4-7",
      "claude-opus-4.7[1m]": "claude-opus-4-7",
      "claude-opus-4-8[1m]": "claude-opus-4-8",
      "claude-opus-4.8[1m]": "claude-opus-4-8",
      "claude-sonnet-5[1m]": "claude-sonnet-5",
      opus: "claude-opus-4-8",
      "opus[1m]": "claude-opus-4-8",
      sonnet: "claude-sonnet-5",
      "sonnet[1m]": "claude-sonnet-5",
      "claude-latest": "claude-opus-4-8",
      "claude-latest[1m]": "claude-opus-4-8",
    },
  },
  {
    // Sonnet/haiku are excluded from claude-latest; they keep their shorthands.
    name: "claude-latest is absent when only reduced families are present",
    catalog: [{ id: "claude-sonnet-5", is1m: true }, { id: "claude-haiku-4-5", is1m: false }],
    aliases: {
      "claude-sonnet-5[1m]": "claude-sonnet-5",
      "claude-haiku-4-5[1m]": "claude-haiku-4-5",
      "claude-haiku-4.5[1m]": "claude-haiku-4-5",
      haiku: "claude-haiku-4-5",
      "haiku[1m]": "claude-haiku-4-5",
      sonnet: "claude-sonnet-5",
      "sonnet[1m]": "claude-sonnet-5",
    },
  },
  {
    // `gpt-latest` always points at a best-of-class model: the reduced sol-era tiers (terra,
    // luna) are excluded outright, like mini/nano.
    name: "gpt-latest picks sol at 5.6 over bare 5.5 and the reduced tiers",
    catalog: [
      { id: "gpt-5.5", is1m: false },
      { id: "gpt-5.6-sol", is1m: false },
      { id: "gpt-5.6-terra", is1m: false },
      { id: "gpt-5.6-luna", is1m: false },
    ],
    aliases: { "gpt-latest": "gpt-5.6-sol" },
  },
  {
    name: "gpt-latest never picks terra over an older bare flagship",
    catalog: [{ id: "gpt-5.4", is1m: false }, { id: "gpt-5.6-terra", is1m: false }],
    aliases: { "gpt-latest": "gpt-5.4" },
  },
  {
    name: "gpt-latest never picks terra, even as the only GPT",
    catalog: [{ id: "gpt-5.6-terra", is1m: false }],
    aliases: {},
  },
  {
    name: "gpt-latest never picks luna over an older bare flagship",
    catalog: [{ id: "gpt-5.3", is1m: false }, { id: "gpt-5.6-luna", is1m: false }],
    aliases: { "gpt-latest": "gpt-5.3" },
  },
  {
    name: "gpt-latest never picks luna, even as the only GPT",
    catalog: [{ id: "gpt-5.6-luna", is1m: false }],
    aliases: {},
  },
  {
    name: "gpt-latest falls back through bare flagships as models are removed: sol first",
    catalog: [
      { id: "gpt-5.6-sol", is1m: false },
      { id: "gpt-5.5", is1m: false },
      { id: "gpt-5.6-terra", is1m: false },
      { id: "gpt-5.4", is1m: false },
      { id: "gpt-5.6-luna", is1m: false },
      { id: "gpt-5.3", is1m: false },
    ],
    aliases: { "gpt-latest": "gpt-5.6-sol" },
  },
  {
    name: "gpt-latest falls back through bare flagships as models are removed: then 5.5",
    catalog: [
      { id: "gpt-5.5", is1m: false },
      { id: "gpt-5.6-terra", is1m: false },
      { id: "gpt-5.4", is1m: false },
      { id: "gpt-5.6-luna", is1m: false },
      { id: "gpt-5.3", is1m: false },
    ],
    aliases: { "gpt-latest": "gpt-5.5" },
  },
  {
    name: "gpt-latest falls back through bare flagships as models are removed: then 5.4",
    catalog: [
      { id: "gpt-5.6-terra", is1m: false },
      { id: "gpt-5.4", is1m: false },
      { id: "gpt-5.6-luna", is1m: false },
      { id: "gpt-5.3", is1m: false },
    ],
    aliases: { "gpt-latest": "gpt-5.4" },
  },
  {
    name: "gpt-latest falls back through bare flagships as models are removed: then 5.3",
    catalog: [
      { id: "gpt-5.6-terra", is1m: false },
      { id: "gpt-5.6-luna", is1m: false },
      { id: "gpt-5.3", is1m: false },
    ],
    aliases: { "gpt-latest": "gpt-5.3" },
  },
  {
    // Only reduced tiers remain: no flagship at all.
    name: "gpt-latest falls back through bare flagships as models are removed: none left",
    catalog: [{ id: "gpt-5.6-terra", is1m: false }, { id: "gpt-5.6-luna", is1m: false }],
    aliases: {},
  },
  {
    name: "gpt-latest still never picks mini/nano even at the newest version",
    catalog: [
      { id: "gpt-5.6-sol", is1m: false },
      { id: "gpt-6-mini", is1m: false },
      { id: "gpt-6-nano", is1m: false },
    ],
    aliases: { "gpt-latest": "gpt-5.6-sol" },
  },
  {
    name: "a terra qualifier with a suffix is still excluded",
    catalog: [{ id: "gpt-5.6-terra-preview", is1m: false }, { id: "gpt-5.4", is1m: false }],
    aliases: { "gpt-latest": "gpt-5.4" },
  },
  {
    name: "a newer version beats an older 1m-capable version for shorthands and claude-latest",
    catalog: [
      { id: "claude-fable-4-8", is1m: false },
      { id: "claude-fable-4-8-1m", is1m: true },
      { id: "claude-fable-5", is1m: false },
    ],
    aliases: {
      "claude-fable-4-8[1m]": "claude-fable-4-8-1m",
      "claude-fable-4.8[1m]": "claude-fable-4-8-1m",
      "claude-fable-5[1m]": "claude-fable-5",
      fable: "claude-fable-5",
      "fable[1m]": "claude-fable-5",
      "claude-latest": "claude-fable-5",
      "claude-latest[1m]": "claude-fable-5",
    },
  },
  {
    // Without the two-digit minor cap, `claude-fable-5-20251001` would parse as version
    // 5.20251001 and hijack the family shorthand.
    name: "a dated snapshot of a single-number version stays a qualifier",
    catalog: [{ id: "claude-fable-5", is1m: true }, { id: "claude-fable-5-20251001", is1m: false }],
    aliases: {
      "claude-fable-5[1m]": "claude-fable-5",
      fable: "claude-fable-5",
      "fable[1m]": "claude-fable-5",
      "claude-latest": "claude-fable-5",
      "claude-latest[1m]": "claude-fable-5",
    },
  },
  {
    // `minimax` merely contains `mini`; it is an unknown qualifier, not a tier.
    name: "reduced GPT tiers match whole qualifier tokens: minimax is not the mini tier",
    catalog: [{ id: "gpt-5.5", is1m: false }, { id: "gpt-5.6-minimax", is1m: false }],
    aliases: { "gpt-latest": "gpt-5.6-minimax" },
  },
  {
    name: "reduced GPT tiers match whole qualifier tokens: mini-high is the mini tier",
    catalog: [{ id: "gpt-5.5", is1m: false }, { id: "gpt-5.6-mini-high", is1m: false }],
    aliases: { "gpt-latest": "gpt-5.5" },
  },
];

test("generateAliases: every catalog shape maps to exactly its alias set", () => {
  for (const row of ALIAS_ROWS) {
    expect({ name: row.name, aliases: generateAliases(row.catalog) }).toEqual({
      name: row.name,
      aliases: row.aliases,
    });
  }
});

test("newestClaudeModel: the highest version across families, a dated snapshot over its undated twin, first listed on a full tie, null without a claude model", () => {
  // The probe's second hop must be an id Copilot serves today, so the pick is the newest thing
  // in the catalog, whatever its family; the dated snapshot is the more specific of two twins.
  const catalog: CatalogModel[] = [
    { id: "claude-opus-4.8", is1m: false },
    { id: "claude-haiku-4.5", is1m: false },
    { id: "claude-sonnet-5", is1m: false },
    { id: "claude-fable-5-1", is1m: false },
    { id: "claude-opus-5-20260301", is1m: false },
  ];
  expect(newestClaudeModel(catalog)).toBe("claude-fable-5-1");
  const noFable = catalog.filter((m) => m.id !== "claude-fable-5-1");
  expect(newestClaudeModel(noFable)).toBe("claude-opus-5-20260301");
  expect(
    newestClaudeModel([{ id: "claude-sonnet-5", is1m: false }, {
      id: "claude-opus-5",
      is1m: false,
    }]),
  ).toBe("claude-sonnet-5");
  expect(newestClaudeModel([{ id: "gpt-6", is1m: false }])).toBeNull();
});

// parseCatalogModels never throws: the catalog feeds a best-effort alias table, so a malformed body
// reads as an empty catalog and a malformed entry is skipped.
const CATALOG_ROWS: { name: string; body: unknown; models: CatalogModel[] }[] = [
  {
    name: "the [1m] suffix is stripped and flags the entry 1m",
    body: { "data": [{ "id": "claude-opus-4.8[1m]" }, { "id": "claude-opus-4.8" }] },
    models: [{ id: "claude-opus-4.8", is1m: true }, { id: "claude-opus-4.8", is1m: false }],
  },
  {
    name: "a 1M context window is read from capabilities.limits",
    body: {
      "data": [
        {
          "id": "claude-fable-5",
          "capabilities": { "limits": { "max_context_window_tokens": 1_000_000 } },
        },
        {
          "id": "gpt-5.6-sol",
          "capabilities": { "limits": { "max_context_window_tokens": 400_000 } },
        },
      ],
    },
    models: [{ id: "claude-fable-5", is1m: true }, { id: "gpt-5.6-sol", is1m: false }],
  },
  { name: "no body", body: undefined, models: [] },
  { name: "a string body", body: "nope", models: [] },
  { name: "a data field that is not an array", body: { "data": "nope" }, models: [] },
  {
    name: "malformed entries are skipped, the well-formed one kept",
    body: { "data": [null, 5, { "id": 7 }, { "id": "gpt-6" }] },
    models: [{ id: "gpt-6", is1m: false }],
  },
];

test("parseCatalogModels: every body shape maps to its catalog, never throwing", () => {
  for (const row of CATALOG_ROWS) {
    expect({ name: row.name, models: parseCatalogModels(row.body) }).toEqual({
      name: row.name,
      models: row.models,
    });
  }
});

test("claudeCatalogRows: every Claude model, deduped, most capable family first then newest, defaults marked", () => {
  // 1m siblings arrive from parseCatalogModels with the SAME id (the display-only
  // [1m] suffix stripped) and is1m true; the duplicate folds into one row. Desktop takes the
  // first row as its default model, so haiku (alphabetically before opus) lands last.
  const rows = claudeCatalogRows([
    { id: "claude-haiku-4-5", is1m: false },
    { id: "claude-opus-4-7", is1m: false },
    { id: "claude-opus-4-8", is1m: false },
    { id: "claude-opus-4-8", is1m: true },
    { id: "claude-fable-5", is1m: true },
    { id: "claude-sonnet-4-6", is1m: false },
    { id: "gpt-5.6-sol", is1m: false },
  ]);
  expect(rows).toEqual([
    { family: "fable", id: "claude-fable-5", is1m: true, familyDefault: true },
    { family: "opus", id: "claude-opus-4-8", is1m: true, familyDefault: true },
    { family: "opus", id: "claude-opus-4-7", is1m: false, familyDefault: false },
    { family: "sonnet", id: "claude-sonnet-4-6", is1m: false, familyDefault: true },
    { family: "haiku", id: "claude-haiku-4-5", is1m: false, familyDefault: true },
  ]);
  expect(claudeCatalogRows([{ id: "gpt-4o", is1m: false }])).toEqual([]);
});

test("mergeUnlistedModels appends verified extras as tagged Anthropic rows, id-sorted", () => {
  const merged = mergeUnlistedModels(
    [{
      id: "claude-haiku-4.5",
      name: "Claude Haiku 4.5",
      vendor: "Anthropic",
      type: "chat",
      contextWindow: 200_000,
      maxOutput: 64_000,
      preview: false,
    }],
    {
      models: [{ id: "claude-haiku-4.5", is1m: false }, { id: "claude-fable-5", is1m: true }],
      unlisted: ["claude-fable-5"],
    },
  );
  expect(merged.map((m) => m.id)).toEqual(["claude-fable-5", "claude-haiku-4.5"]);
  const fable = merged.find((m) => m.id === "claude-fable-5");
  expect(fable?.unlisted).toBe(true);
  expect(fable?.contextWindow).toBe(1_000_000); // the probed 1m verdict
  expect(merged.find((m) => m.id === "claude-haiku-4.5")?.unlisted).toBeUndefined();
});
