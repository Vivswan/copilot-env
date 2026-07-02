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

test("fable shorthand prefix-matches a claude-fable entry", () => {
  const catalog = new Set<string>(["anthropic/claude-fable-5", "anthropic/claude-opus-4.8"]);
  expect(resolvePricingId("fable", catalog)).toBe("anthropic/claude-fable-5");
  // Single-number version: the [1m] strip applies, digit-dash-digit does not.
  expect(resolvePricingId("claude-fable-5[1m]", catalog)).toBe("anthropic/claude-fable-5");
});

test("returns null when nothing matches", () => {
  expect(resolvePricingId("totally-unknown-model", CATALOG)).toBeNull();
});

test("prefers the bare flagship over -fast/-mini siblings sharing a prefix", () => {
  const catalog = new Set<string>([
    "anthropic/claude-opus-4.8-fast",
    "anthropic/claude-opus-4.8",
    "anthropic/claude-opus-4.8-mini",
  ]);
  // All three share the `anthropic/claude-opus` prefix; the tiebreaker must
  // demote the `fast`/`mini` variants and return the bare flagship id.
  expect(resolvePricingId("opus", catalog)).toBe("anthropic/claude-opus-4.8");
});

test("picks the newest version among prefix matches", () => {
  const catalog = new Set<string>(["anthropic/claude-opus-4.1", "anthropic/claude-opus-4.8"]);
  // No exact `provider/candidate`; prefix match must prefer the higher version.
  expect(resolvePricingId("opus", catalog)).toBe("anthropic/claude-opus-4.8");
});

test("returns null when the provider is inferable but the catalog has no match", () => {
  const catalog = new Set<string>(["anthropic/claude-opus-4.8"]);
  // `gpt-9.9` infers the `openai` provider but nothing in the catalog matches.
  expect(resolvePricingId("gpt-9.9", catalog)).toBeNull();
});

test("estimateCost computes and includes cache bucket costs in totals", () => {
  const pricing = new Map<string, PricingTier>([
    ["anthropic/claude-opus-4.8", { input: 15, output: 75, cacheRead: 1.5, cacheCreation: 18.75 }],
  ]);
  // Non-zero cache buckets with non-zero cache rates must be priced and summed.
  const usage = new Map<string, UsageTokens>([
    [
      "claude-opus-4.8",
      { input: 2_000_000, output: 1_000_000, cacheRead: 4_000_000, cacheCreation: 1_000_000 },
    ],
  ]);

  const result = estimateCost(usage, pricing);
  const cost = result.perModel["claude-opus-4.8"];

  // input: 2M * 15/M = 30 ; output: 1M * 75/M = 75
  expect(cost?.inputCostUsd).toBe(30);
  expect(cost?.outputCostUsd).toBe(75);
  // cacheRead: 4M * 1.5/M = 6 ; cacheCreation: 1M * 18.75/M = 18.75
  expect(cost?.cacheReadCostUsd).toBe(6);
  expect(cost?.cacheCreationCostUsd).toBe(18.75);
  // total = 30 + 75 + 6 + 18.75 = 129.75
  expect(cost?.estimatedCostUsd).toBe(129.75);
  expect(result.totalUsd).toBe(129.75);
});

test("estimateCost rounds cache bucket costs to four decimals", () => {
  const pricing = new Map<string, PricingTier>([
    ["anthropic/claude-opus-4.8", { input: 15, cacheRead: 1.5 }],
  ]);
  // 333_333 / 1M * 1.5 = 0.4999995 -> rounds to 0.5 ; input untouched.
  const usage = new Map<string, UsageTokens>([
    ["claude-opus-4.8", { input: 0, output: 0, cacheRead: 333_333, cacheCreation: 0 }],
  ]);

  const result = estimateCost(usage, pricing);
  const cost = result.perModel["claude-opus-4.8"];

  expect(cost?.cacheReadCostUsd).toBe(0.5);
  expect(cost?.estimatedCostUsd).toBe(0.5);
  expect(result.totalUsd).toBe(0.5);
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
