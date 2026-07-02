import { expect, test } from "bun:test";

import { type CatalogModel, generateAliases } from "../src/copilot_api/models.ts";

test("base id gets a dash alias and a [1m] alias that falls back to itself", () => {
  const catalog: CatalogModel[] = [{ id: "claude-opus-4.8", is1m: false }];
  const aliases = generateAliases(catalog);

  expect(aliases["claude-opus-4-8"]).toBe("claude-opus-4.8");
  expect(aliases["claude-opus-4-8[1m]"]).toBe("claude-opus-4.8");
  expect(aliases["claude-opus-4.8[1m]"]).toBe("claude-opus-4.8");
  expect(aliases.opus).toBe("claude-opus-4.8");
  expect(aliases["opus[1m]"]).toBe("claude-opus-4.8");
});

test("[1m] requests resolve to the 1m sibling, and opus prefers it", () => {
  const catalog: CatalogModel[] = [
    { id: "claude-opus-4.8", is1m: false },
    { id: "claude-opus-4.8-1m", is1m: true },
  ];
  const aliases = generateAliases(catalog);

  expect(aliases["claude-opus-4-8"]).toBe("claude-opus-4.8");
  expect(aliases["claude-opus-4-8[1m]"]).toBe("claude-opus-4.8-1m");
  expect(aliases["claude-opus-4.8[1m]"]).toBe("claude-opus-4.8-1m");
  expect(aliases.opus).toBe("claude-opus-4.8-1m");
  expect(aliases["opus[1m]"]).toBe("claude-opus-4.8-1m");
});

test("family shorthand picks the newest version", () => {
  const catalog: CatalogModel[] = [
    { id: "claude-sonnet-4.5", is1m: false },
    { id: "claude-sonnet-4.6", is1m: false },
  ];
  const aliases = generateAliases(catalog);

  expect(aliases.sonnet).toBe("claude-sonnet-4.6");
  expect(aliases["claude-sonnet-4-5"]).toBe("claude-sonnet-4.5");
  expect(aliases["claude-sonnet-4-6"]).toBe("claude-sonnet-4.6");
});

test("qualifier ids get a dash alias and no bare base alias", () => {
  const catalog: CatalogModel[] = [{ id: "claude-opus-4.7-high", is1m: false }];
  const aliases = generateAliases(catalog);

  expect(aliases["claude-opus-4-7-high"]).toBe("claude-opus-4.7-high");
  expect(aliases["claude-opus-4-7"]).toBeUndefined();
});

test("non-claude models produce no claude aliases, but GPTs get gpt-latest", () => {
  const catalog: CatalogModel[] = [
    { id: "gpt-5.5", is1m: false },
    { id: "gemini-2.5-pro", is1m: false },
  ];
  const aliases = generateAliases(catalog);

  expect(aliases["gpt-latest"]).toBe("gpt-5.5");
  expect(Object.keys(aliases)).toEqual(["gpt-latest"]);
});

test("gpt-latest picks the newest non-mini GPT (mini/nano excluded)", () => {
  const catalog: CatalogModel[] = [
    { id: "gpt-5", is1m: false },
    { id: "gpt-5.5", is1m: false },
    { id: "gpt-5-mini", is1m: false },
    { id: "gpt-6-nano", is1m: false },
    { id: "gpt-6", is1m: false },
  ];
  const aliases = generateAliases(catalog);

  expect(aliases["gpt-latest"]).toBe("gpt-6");
});

test("gpt-latest is absent when every GPT is a mini/nano tier", () => {
  const catalog: CatalogModel[] = [
    { id: "gpt-5-mini", is1m: false },
    { id: "gpt-5-nano", is1m: false },
  ];
  const aliases = generateAliases(catalog);

  expect(aliases["gpt-latest"]).toBeUndefined();
});

test("gpt-latest tiebreak prefers the bare id over a same-version qualifier (bare first)", () => {
  const catalog: CatalogModel[] = [
    { id: "gpt-6", is1m: false },
    { id: "gpt-6-foo", is1m: false },
  ];
  const aliases = generateAliases(catalog);

  expect(aliases["gpt-latest"]).toBe("gpt-6");
});

test("gpt-latest tiebreak prefers the bare id even when the qualifier appears first", () => {
  // Reversed order catches a 'last match wins' bug: the bare id must still win.
  const catalog: CatalogModel[] = [
    { id: "gpt-6-foo", is1m: false },
    { id: "gpt-6", is1m: false },
  ];
  const aliases = generateAliases(catalog);

  expect(aliases["gpt-latest"]).toBe("gpt-6");
});

test("a qualifier id like claude-opus-4.7-high gets no [1m] alias", () => {
  const catalog: CatalogModel[] = [{ id: "claude-opus-4.7-high", is1m: false }];
  const aliases = generateAliases(catalog);

  expect(aliases["claude-opus-4-7-high"]).toBe("claude-opus-4.7-high");
  expect(aliases["claude-opus-4-7-high[1m]"]).toBeUndefined();
  expect(aliases["claude-opus-4.7-high[1m]"]).toBeUndefined();
});

// The live daemon catalog returns dash-form version ids (`claude-opus-4-8`),
// not the dot form. These mirror that shape so the regex never silently drops
// every Claude model again.
test("dash-form catalog ids still produce the full alias set", () => {
  const catalog: CatalogModel[] = [
    { id: "claude-opus-4-8", is1m: true },
    { id: "claude-sonnet-4-6", is1m: true },
    { id: "claude-haiku-4-5", is1m: false },
  ];
  const aliases = generateAliases(catalog);

  expect(aliases.opus).toBe("claude-opus-4-8");
  expect(aliases["opus[1m]"]).toBe("claude-opus-4-8");
  expect(aliases["claude-opus-4-8[1m]"]).toBe("claude-opus-4-8");
  expect(aliases["claude-opus-4.8[1m]"]).toBe("claude-opus-4-8");
  expect(aliases.sonnet).toBe("claude-sonnet-4-6");
  expect(aliases.haiku).toBe("claude-haiku-4-5");
});

test("dash-form qualifier ids emit no identity alias", () => {
  const catalog: CatalogModel[] = [{ id: "claude-opus-4-7-high", is1m: false }];
  const aliases = generateAliases(catalog);

  // The generated key equals the catalog id, so the identity mapping is
  // skipped: the exact id passes through the proxy unchanged anyway.
  expect(aliases["claude-opus-4-7-high"]).toBeUndefined();
  expect(aliases["claude-opus-4-7"]).toBeUndefined();
});

test("dash-form [1m] requests resolve to a distinct dash-form 1m sibling", () => {
  const catalog: CatalogModel[] = [
    { id: "claude-opus-4-8", is1m: false },
    { id: "claude-opus-4-8-1m", is1m: true },
  ];
  const aliases = generateAliases(catalog);

  // No identity alias for the base id; the [1m] links still emit.
  expect(aliases["claude-opus-4-8"]).toBeUndefined();
  expect(aliases["claude-opus-4-8[1m]"]).toBe("claude-opus-4-8-1m");
  expect(aliases["claude-opus-4.8[1m]"]).toBe("claude-opus-4-8-1m");
  expect(aliases.opus).toBe("claude-opus-4-8-1m");
  expect(aliases["opus[1m]"]).toBe("claude-opus-4-8-1m");
});

// Single-number generations (`claude-sonnet-5`, `claude-fable-5`) carry no
// minor version; the regex must parse them or every alias silently vanishes.
test("single-number version wins the family shorthand over an older major.minor", () => {
  const catalog: CatalogModel[] = [
    { id: "claude-sonnet-4-6", is1m: true },
    { id: "claude-sonnet-5", is1m: true },
  ];
  const aliases = generateAliases(catalog);

  expect(aliases.sonnet).toBe("claude-sonnet-5");
  expect(aliases["sonnet[1m]"]).toBe("claude-sonnet-5");
  expect(aliases["claude-sonnet-5[1m]"]).toBe("claude-sonnet-5");
  // Dash and dot forms coincide for a single-number version: no identity alias.
  expect(aliases["claude-sonnet-5"]).toBeUndefined();
  expect(aliases["claude-sonnet-4-6[1m]"]).toBe("claude-sonnet-4-6");
});

test("fable links its 1m sibling through the single-number version", () => {
  // `claude-fable-5-1m` must backtrack to version 5 + qualifier `1m`.
  const catalog: CatalogModel[] = [
    { id: "claude-fable-5", is1m: false },
    { id: "claude-fable-5-1m", is1m: true },
  ];
  const aliases = generateAliases(catalog);

  expect(aliases.fable).toBe("claude-fable-5-1m");
  expect(aliases["fable[1m]"]).toBe("claude-fable-5-1m");
  expect(aliases["claude-fable-5[1m]"]).toBe("claude-fable-5-1m");
  expect(aliases["claude-fable-5"]).toBeUndefined();
  expect(aliases["claude-fable-5-1m"]).toBeUndefined();
});

test("a single-number base without a sibling gets a [1m] alias falling back to itself", () => {
  const catalog: CatalogModel[] = [{ id: "claude-fable-5", is1m: true }];
  const aliases = generateAliases(catalog);

  expect(aliases["claude-fable-5[1m]"]).toBe("claude-fable-5");
  expect(aliases.fable).toBe("claude-fable-5");
  expect(aliases["fable[1m]"]).toBe("claude-fable-5");
  expect(aliases["claude-fable-5"]).toBeUndefined();
});

test("greedy version keeps claude-haiku-4-5 as version 4.5, not qualifier 5", () => {
  const catalog: CatalogModel[] = [{ id: "claude-haiku-4-5", is1m: false }];
  const aliases = generateAliases(catalog);

  // A [1m] alias only exists when the id parsed with no qualifier, so its
  // presence proves the version group captured `4-5` whole.
  expect(aliases["claude-haiku-4-5[1m]"]).toBe("claude-haiku-4-5");
  expect(aliases["claude-haiku-4.5[1m]"]).toBe("claude-haiku-4-5");
  expect(aliases["haiku[1m]"]).toBe("claude-haiku-4-5");
});

test("every claude family in the catalog gets a shorthand and a [1m] variant", () => {
  // Deliberately out of alphabetical order to exercise the sorted iteration.
  const catalog: CatalogModel[] = [
    { id: "claude-sonnet-4-6", is1m: false },
    { id: "claude-fable-5", is1m: true },
    { id: "claude-opus-4-8", is1m: true },
  ];
  const aliases = generateAliases(catalog);

  expect(aliases.fable).toBe("claude-fable-5");
  expect(aliases["fable[1m]"]).toBe("claude-fable-5");
  expect(aliases.opus).toBe("claude-opus-4-8");
  expect(aliases["opus[1m]"]).toBe("claude-opus-4-8");
  expect(aliases.sonnet).toBe("claude-sonnet-4-6");
  expect(aliases["sonnet[1m]"]).toBe("claude-sonnet-4-6");
});

test("claude-latest prefers fable over opus", () => {
  const catalog: CatalogModel[] = [
    { id: "claude-opus-4-8", is1m: true },
    { id: "claude-fable-5", is1m: false },
    { id: "claude-fable-5-1m", is1m: true },
  ];
  const aliases = generateAliases(catalog);

  expect(aliases["claude-latest"]).toBe("claude-fable-5-1m");
  expect(aliases["claude-latest[1m]"]).toBe("claude-fable-5-1m");
});

test("claude-latest falls back to the newest opus when no fable ships", () => {
  const catalog: CatalogModel[] = [
    { id: "claude-opus-4-7", is1m: true },
    { id: "claude-opus-4-8", is1m: true },
    { id: "claude-sonnet-5", is1m: true },
  ];
  const aliases = generateAliases(catalog);

  expect(aliases["claude-latest"]).toBe("claude-opus-4-8");
  expect(aliases["claude-latest[1m]"]).toBe("claude-opus-4-8");
});

test("claude-latest is absent when only reduced families are present", () => {
  // Sonnet/haiku are excluded from claude-latest; they keep their shorthands.
  const catalog: CatalogModel[] = [
    { id: "claude-sonnet-5", is1m: true },
    { id: "claude-haiku-4-5", is1m: false },
  ];
  const aliases = generateAliases(catalog);

  expect(aliases["claude-latest"]).toBeUndefined();
  expect(aliases["claude-latest[1m]"]).toBeUndefined();
  expect(aliases.sonnet).toBe("claude-sonnet-5");
  expect(aliases.haiku).toBe("claude-haiku-4-5");
});

// `gpt-latest` always points at a best-of-class model: the reduced sol-era
// tiers (terra, luna) are excluded outright, like mini/nano.
test("gpt-latest picks sol at 5.6 over bare 5.5 and the reduced tiers", () => {
  const catalog: CatalogModel[] = [
    { id: "gpt-5.5", is1m: false },
    { id: "gpt-5.6-sol", is1m: false },
    { id: "gpt-5.6-terra", is1m: false },
    { id: "gpt-5.6-luna", is1m: false },
  ];
  const aliases = generateAliases(catalog);

  expect(aliases["gpt-latest"]).toBe("gpt-5.6-sol");
});

test("gpt-latest never picks terra, even as the only GPT", () => {
  const withOlderBare: CatalogModel[] = [
    { id: "gpt-5.4", is1m: false },
    { id: "gpt-5.6-terra", is1m: false },
  ];
  expect(generateAliases(withOlderBare)["gpt-latest"]).toBe("gpt-5.4");

  const terraOnly: CatalogModel[] = [{ id: "gpt-5.6-terra", is1m: false }];
  expect(generateAliases(terraOnly)["gpt-latest"]).toBeUndefined();
});

test("gpt-latest never picks luna, even as the only GPT", () => {
  const withOlderBare: CatalogModel[] = [
    { id: "gpt-5.3", is1m: false },
    { id: "gpt-5.6-luna", is1m: false },
  ];
  expect(generateAliases(withOlderBare)["gpt-latest"]).toBe("gpt-5.3");

  const lunaOnly: CatalogModel[] = [{ id: "gpt-5.6-luna", is1m: false }];
  expect(generateAliases(lunaOnly)["gpt-latest"]).toBeUndefined();
});

test("gpt-latest falls back through bare flagships as models are removed", () => {
  const catalog: CatalogModel[] = [
    { id: "gpt-5.6-sol", is1m: false },
    { id: "gpt-5.5", is1m: false },
    { id: "gpt-5.6-terra", is1m: false },
    { id: "gpt-5.4", is1m: false },
    { id: "gpt-5.6-luna", is1m: false },
    { id: "gpt-5.3", is1m: false },
  ];
  const expected = ["gpt-5.6-sol", "gpt-5.5", "gpt-5.4", "gpt-5.3"];

  for (const want of expected) {
    expect(generateAliases(catalog)["gpt-latest"]).toBe(want);
    catalog.splice(
      catalog.findIndex((m) => m.id === want),
      1,
    );
  }
  // Only reduced tiers remain: no flagship at all.
  expect(generateAliases(catalog)["gpt-latest"]).toBeUndefined();
});

test("gpt-latest still never picks mini/nano even at the newest version", () => {
  const catalog: CatalogModel[] = [
    { id: "gpt-5.6-sol", is1m: false },
    { id: "gpt-6-mini", is1m: false },
    { id: "gpt-6-nano", is1m: false },
  ];
  const aliases = generateAliases(catalog);

  expect(aliases["gpt-latest"]).toBe("gpt-5.6-sol");
});

test("a terra qualifier with a suffix is still excluded", () => {
  const catalog: CatalogModel[] = [
    { id: "gpt-5.6-terra-preview", is1m: false },
    { id: "gpt-5.4", is1m: false },
  ];
  expect(generateAliases(catalog)["gpt-latest"]).toBe("gpt-5.4");
});

test("a newer version beats an older 1m-capable version for shorthands and claude-latest", () => {
  const catalog: CatalogModel[] = [
    { id: "claude-fable-4-8", is1m: false },
    { id: "claude-fable-4-8-1m", is1m: true },
    { id: "claude-fable-5", is1m: false },
  ];
  const aliases = generateAliases(catalog);

  expect(aliases.fable).toBe("claude-fable-5");
  expect(aliases["fable[1m]"]).toBe("claude-fable-5");
  expect(aliases["claude-latest"]).toBe("claude-fable-5");
  // The older version still links its own 1m sibling.
  expect(aliases["claude-fable-4-8[1m]"]).toBe("claude-fable-4-8-1m");
});

test("a dated snapshot of a single-number version stays a qualifier", () => {
  // Without the two-digit minor cap, `claude-fable-5-20251001` would parse as
  // version 5.20251001 and hijack the family shorthand.
  const catalog: CatalogModel[] = [
    { id: "claude-fable-5", is1m: true },
    { id: "claude-fable-5-20251001", is1m: false },
  ];
  const aliases = generateAliases(catalog);

  expect(aliases.fable).toBe("claude-fable-5");
  expect(aliases["claude-latest"]).toBe("claude-fable-5");
  expect(aliases["claude-fable-5-20251001[1m]"]).toBeUndefined();
});

test("reduced GPT tiers match whole qualifier tokens, not substrings", () => {
  const catalog: CatalogModel[] = [
    { id: "gpt-5.5", is1m: false },
    { id: "gpt-5.6-minimax", is1m: false },
  ];
  // `minimax` merely contains `mini`; it is an unknown qualifier, not a tier.
  expect(generateAliases(catalog)["gpt-latest"]).toBe("gpt-5.6-minimax");

  const reduced: CatalogModel[] = [
    { id: "gpt-5.5", is1m: false },
    { id: "gpt-5.6-mini-high", is1m: false },
  ];
  expect(generateAliases(reduced)["gpt-latest"]).toBe("gpt-5.5");
});
