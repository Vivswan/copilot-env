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

test("non-claude models are skipped entirely", () => {
  const catalog: CatalogModel[] = [
    { id: "gpt-5.5", is1m: false },
    { id: "gemini-2.5-pro", is1m: false },
  ];
  const aliases = generateAliases(catalog);

  expect(Object.keys(aliases)).toHaveLength(0);
});
