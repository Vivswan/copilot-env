import { expect, test } from "bun:test";

import {
  estimateCost,
  type PricingTier,
  resolvePricingId,
  type UsageTokens,
} from "../src/usage/pricing.ts";

const CATALOG = new Set<string>([
  "anthropic/claude-opus-4.8",
  "anthropic/claude-opus-4.1",
  "openai/gpt-5.5",
]);

test("resolves a fully-qualified id directly", () => {
  expect(resolvePricingId("anthropic/claude-opus-4.8", CATALOG)).toBe("anthropic/claude-opus-4.8");
});

test("infers the provider for a bare claude id", () => {
  expect(resolvePricingId("claude-opus-4.8", CATALOG)).toBe("anthropic/claude-opus-4.8");
});

test("infers the provider for a gpt id", () => {
  expect(resolvePricingId("gpt-5.5", CATALOG)).toBe("openai/gpt-5.5");
});

test("normalizes [1m] and digit-dash before matching", () => {
  expect(resolvePricingId("claude-opus-4-8[1m]", CATALOG)).toBe("anthropic/claude-opus-4.8");
});

test("opus shorthand prefix-matches a claude-opus entry", () => {
  expect(resolvePricingId("opus", CATALOG)).toBe("anthropic/claude-opus-4.8");
});

test("returns null when nothing matches", () => {
  expect(resolvePricingId("totally-unknown-model", CATALOG)).toBeNull();
});

test("estimateCost prices known models and lists unpriceable ones", () => {
  const pricing = new Map<string, PricingTier>([
    ["anthropic/claude-opus-4.8", { input: 15, output: 75, cacheRead: 1.5, cacheCreation: 18.75 }],
  ]);
  const usage = new Map<string, UsageTokens>([
    ["claude-opus-4.8", { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheCreation: 0 }],
    ["mystery-model", { input: 500, output: 0, cacheRead: 0, cacheCreation: 0 }],
  ]);

  const result = estimateCost(usage, pricing);

  expect(result.perModel["claude-opus-4.8"]?.pricingReference).toBe("anthropic/claude-opus-4.8");
  expect(result.perModel["claude-opus-4.8"]?.inputCostUsd).toBe(15);
  expect(result.perModel["claude-opus-4.8"]?.outputCostUsd).toBe(75);
  expect(result.perModel["claude-opus-4.8"]?.estimatedCostUsd).toBe(90);
  expect(result.totalUsd).toBe(90);
  expect(result.unpriced).toEqual(["mystery-model"]);
});

test("estimateCost excludes a model whose used bucket has no rate", () => {
  const pricing = new Map<string, PricingTier>([
    ["anthropic/claude-opus-4.8", { input: 15, output: 75 }],
  ]);
  // cacheRead is used but the tier has no cacheRead rate -> not covered -> unpriced.
  const usage = new Map<string, UsageTokens>([
    ["claude-opus-4.8", { input: 0, output: 0, cacheRead: 1_000, cacheCreation: 0 }],
  ]);

  const result = estimateCost(usage, pricing);

  expect(result.totalUsd).toBe(0);
  expect(result.unpriced).toEqual(["claude-opus-4.8"]);
});
