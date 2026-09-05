import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  canonicalModelName,
  estimateCost,
  loadPricing,
  pricingCachePath,
  type PricingTier,
  resolvePricingId,
  roundUsd,
  type UsageTokens,
} from "../src/usage/pricing.ts";
import { expect, test } from "./helpers/testing.ts";

// The ONE serialized-USD precision: 4 decimal places, half-up, applied only at
// cost.ts's --json boundary; in-memory estimates stay exact so sums reconcile.
test("roundUsd pins the 4-decimal USD rounding rule", () => {
  expect(roundUsd(1.23456)).toBe(1.2346);
  expect(roundUsd(0.00004)).toBe(0);
  expect(roundUsd(0.00005)).toBe(0.0001);
  expect(roundUsd(12)).toBe(12);
});

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

test("resolves a dated Anthropic snapshot id onto its base model", () => {
  const catalog = new Set<string>(["anthropic/claude-haiku-4.5"]);
  expect(resolvePricingId("claude-haiku-4-5-20251001", catalog)).toBe("anthropic/claude-haiku-4.5");
});

test("canonicalModelName unifies the source spellings of one model", () => {
  // Anthropic dashed vs Copilot dotted vs dated snapshot: one canonical key.
  expect(canonicalModelName("claude-opus-4-8")).toBe("claude-opus-4.8");
  expect(canonicalModelName("claude-opus-4.8")).toBe("claude-opus-4.8");
  expect(canonicalModelName("claude-haiku-4-5-20251001")).toBe("claude-haiku-4.5");
  // The 1M-context marker survives as `-1m` (a distinct offering), undotted,
  // and a trailing `-internal` qualifier never mangles it (upstream ids can
  // end in `-1m-internal`).
  expect(canonicalModelName("claude-opus-4-6-1m")).toBe("claude-opus-4.6-1m");
  expect(canonicalModelName("claude-fable-5[1m]")).toBe("claude-fable-5-1m");
  expect(canonicalModelName("claude-opus-4-7-1m-internal")).toBe("claude-opus-4.7-1m-internal");
  // Provider prefixes survive; the dash-to-dot and date-strip rewrites are
  // scoped to claude ids, so legitimately dashed or date-suffixed ids from
  // other vendors are never respelled.
  expect(canonicalModelName("openai/gpt-5.5")).toBe("openai/gpt-5.5");
  expect(canonicalModelName("gpt-5.6-sol")).toBe("gpt-5.6-sol");
  expect(canonicalModelName("openai/gpt-4-0314")).toBe("openai/gpt-4-0314");
  expect(canonicalModelName("meta-llama/llama-3-8b")).toBe("meta-llama/llama-3-8b");
  expect(canonicalModelName("vendor/widget-20251001")).toBe("vendor/widget-20251001");
});

test("resolves a -1m-internal id onto its base model", () => {
  const catalog = new Set<string>(["anthropic/claude-opus-4.7"]);
  expect(resolvePricingId("claude-opus-4-7-1m-internal", catalog)).toBe(
    "anthropic/claude-opus-4.7",
  );
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

test("breaks an exact sort tie by id, whatever the catalog's insertion order", () => {
  // Two siblings identical in every ranking feature (length, version numbers,
  // flags): the pick must not depend on which one the catalog listed first.
  const forward = new Set<string>(["anthropic/claude-opus-4.8-a", "anthropic/claude-opus-4.8-b"]);
  const reversed = new Set<string>(["anthropic/claude-opus-4.8-b", "anthropic/claude-opus-4.8-a"]);
  expect(resolvePricingId("opus", forward)).toBe("anthropic/claude-opus-4.8-a");
  expect(resolvePricingId("opus", reversed)).toBe("anthropic/claude-opus-4.8-a");
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

test("estimateCost keeps USD amounts exact; rounding belongs to the boundary", () => {
  const pricing = new Map<string, PricingTier>([
    ["anthropic/claude-opus-4.8", { input: 15, cacheRead: 1.5 }],
  ]);
  // 333_333 / 1M * 1.5 = 0.4999995 -- stored EXACT, never pre-rounded to 0.5:
  // per-model costs feed the per-day sums, so rounding here would make the
  // by-model and per-day tables disagree. roundUsd applies once, at the boundary.
  const usage = new Map<string, UsageTokens>([
    ["claude-opus-4.8", { input: 0, output: 0, cacheRead: 333_333, cacheCreation: 0 }],
  ]);

  const result = estimateCost(usage, pricing);
  const cost = result.perModel["claude-opus-4.8"];

  expect(cost?.cacheReadCostUsd).toBeCloseTo(0.4999995, 10);
  expect(cost?.cacheReadCostUsd).not.toBe(0.5);
  expect(result.totalUsd).toBe(cost?.estimatedCostUsd);
  expect(roundUsd(cost?.estimatedCostUsd ?? 0)).toBe(0.5);
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

// ---------- the on-disk price-list cache ----------

const PRICE_URL = "https://pricing.example/models";
const OTHER_URL = "https://pricing.example/other-models";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** An OpenRouter-shaped models payload pricing one model at the given per-token rate. */
function openRouterBody(id: string, promptPerToken: string): unknown {
  return {
    data: [
      {
        id,
        pricing: {
          prompt: promptPerToken,
          completion: "0.000075",
          "input_cache_read": "0.0000015",
          "input_cache_write": "0.00001875",
        },
      },
    ],
  };
}

/** A fetch stub serving `body` and counting its calls; `fail` makes every call
 *  throw the way the real transport does, with the requested URL in the message. */
function fakeFetch(
  body: unknown,
  opts: { fail?: boolean } = {},
): { fetch: typeof fetch; calls: number } {
  const state = {
    calls: 0,
    fetch: ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      state.calls++;
      if (init?.signal?.aborted) return Promise.reject(init.signal.reason);
      if (opts.fail) {
        return Promise.reject(new TypeError(`error sending request for url (${String(input)})`));
      }
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as typeof fetch,
  };
  return state;
}

/** Run `body` against a throwaway cache dir, removed afterwards. */
async function withCacheDir(body: (cacheDir: string) => Promise<void>): Promise<void> {
  const cacheDir = mkdtempSync(join(tmpdir(), "pricing-cache-"));
  try {
    await body(cacheDir);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

test("loadPricing fetches on a cold cache, persists the list, and reports `fetched`", () =>
  withCacheDir(async (cacheDir) => {
    const net = fakeFetch(openRouterBody("anthropic/claude-opus-4.8", "0.000015"));
    const now = 1_700_000_000_000;

    const loaded = await loadPricing(PRICE_URL, { cacheDir, nowMs: now, fetchImpl: net.fetch });

    expect(loaded.source).toBe("fetched");
    expect(loaded.fetchedAtMs).toBe(now);
    expect(net.calls).toBe(1);
    expect(loaded.pricing.get("anthropic/claude-opus-4.8")?.input).toBe(15);
    const path = pricingCachePath(PRICE_URL, cacheDir);
    expect(existsSync(path)).toBe(true);
    expect(readdirSync(cacheDir)).toEqual([basename(path)]);
    const record = JSON.parse(readFileSync(path, "utf8"));
    // The URL itself never lands on disk (a custom one may carry credentials).
    expect(Object.keys(record).sort()).toEqual(["fetched_at_ms", "tiers", "url_sha256"]);
    expect(record.url_sha256).toBe(sha256(PRICE_URL));
    expect(JSON.stringify(record)).not.toContain("pricing.example");
    expect(record.fetched_at_ms).toBe(now);
    expect(record.tiers["anthropic/claude-opus-4.8"]).toEqual({
      input: 15,
      output: 75,
      cacheRead: 1.5,
      cacheCreation: 18.75,
    });
  }));

test("loadPricing answers a fresh cache without touching the network", () =>
  withCacheDir(async (cacheDir) => {
    const now = 1_700_000_000_000;
    const seed = fakeFetch(openRouterBody("anthropic/claude-opus-4.8", "0.000015"));
    await loadPricing(PRICE_URL, { cacheDir, nowMs: now, fetchImpl: seed.fetch });

    // A second fetch would serve a DIFFERENT rate: a cache hit must not see it.
    const net = fakeFetch(openRouterBody("anthropic/claude-opus-4.8", "0.000099"));
    const loaded = await loadPricing(PRICE_URL, {
      cacheDir,
      nowMs: now + DAY_MS - 1,
      fetchImpl: net.fetch,
    });

    expect(loaded.source).toBe("cache");
    expect(loaded.fetchedAtMs).toBe(now);
    expect(net.calls).toBe(0);
    expect(loaded.pricing.get("anthropic/claude-opus-4.8")).toEqual({
      input: 15,
      output: 75,
      cacheRead: 1.5,
      cacheCreation: 18.75,
    });
  }));

test("loadPricing refreshes an expired cache and rewrites it", () =>
  withCacheDir(async (cacheDir) => {
    const now = 1_700_000_000_000;
    const seed = fakeFetch(openRouterBody("anthropic/claude-opus-4.8", "0.000015"));
    await loadPricing(PRICE_URL, { cacheDir, nowMs: now, fetchImpl: seed.fetch });

    const net = fakeFetch(openRouterBody("anthropic/claude-opus-4.8", "0.000099"));
    const later = now + DAY_MS;
    const loaded = await loadPricing(PRICE_URL, { cacheDir, nowMs: later, fetchImpl: net.fetch });

    expect(loaded.source).toBe("fetched");
    expect(loaded.fetchedAtMs).toBe(later);
    expect(net.calls).toBe(1);
    expect(loaded.pricing.get("anthropic/claude-opus-4.8")?.input).toBe(99);
    const record = JSON.parse(readFileSync(pricingCachePath(PRICE_URL, cacheDir), "utf8"));
    expect(record.fetched_at_ms).toBe(later);
    expect(record.tiers["anthropic/claude-opus-4.8"].input).toBe(99);
  }));

test("loadPricing honours a caller-supplied ttl", () =>
  withCacheDir(async (cacheDir) => {
    const now = 1_700_000_000_000;
    const seed = fakeFetch(openRouterBody("anthropic/claude-opus-4.8", "0.000015"));
    await loadPricing(PRICE_URL, { cacheDir, nowMs: now, fetchImpl: seed.fetch });

    const net = fakeFetch(openRouterBody("anthropic/claude-opus-4.8", "0.000099"));
    const hit = await loadPricing(PRICE_URL, {
      cacheDir,
      nowMs: now + HOUR_MS - 1,
      ttlMs: HOUR_MS,
      fetchImpl: net.fetch,
    });
    expect(hit.source).toBe("cache");
    const miss = await loadPricing(PRICE_URL, {
      cacheDir,
      nowMs: now + HOUR_MS,
      ttlMs: HOUR_MS,
      fetchImpl: net.fetch,
    });
    expect(miss.source).toBe("fetched");
    expect(net.calls).toBe(1);
  }));

test("loadPricing falls back to the expired cache when the refresh fails", () =>
  withCacheDir(async (cacheDir) => {
    const now = 1_700_000_000_000;
    const seed = fakeFetch(openRouterBody("anthropic/claude-opus-4.8", "0.000015"));
    await loadPricing(PRICE_URL, { cacheDir, nowMs: now, fetchImpl: seed.fetch });

    const net = fakeFetch(null, { fail: true });
    const loaded = await loadPricing(PRICE_URL, {
      cacheDir,
      nowMs: now + 3 * DAY_MS,
      fetchImpl: net.fetch,
    });

    expect(loaded).toMatchObject({
      source: "stale-cache",
      fetchedAtMs: now,
      fetchError: "pricing request failed",
    });
    expect(net.calls).toBe(1);
    expect(loaded.pricing.get("anthropic/claude-opus-4.8")?.input).toBe(15);
    // The failed refresh must not have touched the stale file.
    const record = JSON.parse(readFileSync(pricingCachePath(PRICE_URL, cacheDir), "utf8"));
    expect(record.fetched_at_ms).toBe(now);
  }));

test("loadPricing rejects when the fetch fails and no cache exists", () =>
  withCacheDir(async (cacheDir) => {
    const net = fakeFetch(null, { fail: true });

    await expect(loadPricing(PRICE_URL, { cacheDir, nowMs: 1, fetchImpl: net.fetch })).rejects
      .toThrow("pricing request failed");
    expect(net.calls).toBe(1);
    expect(readdirSync(cacheDir)).toEqual([]);
  }));

test("loadPricing treats a corrupt or invalid cache file as absent", () =>
  withCacheDir(async (cacheDir) => {
    const now = 1_700_000_000_000;
    const path = pricingCachePath(PRICE_URL, cacheDir);
    const digest = sha256(PRICE_URL);
    const invalid: string[] = [
      "{not json",
      "[]",
      // Right keys, wrong types.
      JSON.stringify({ "url_sha256": digest, "fetched_at_ms": "yesterday", tiers: {} }),
      // A negative rate cannot be a price.
      JSON.stringify({
        "url_sha256": digest,
        "fetched_at_ms": now,
        tiers: { "x/y": { input: -1 } },
      }),
      // Ids are lowercased and routable; anything else was not written by fetchPricing.
      JSON.stringify({ "url_sha256": digest, "fetched_at_ms": now, tiers: { "": { input: 1 } } }),
      JSON.stringify({
        "url_sha256": digest,
        "fetched_at_ms": now,
        tiers: { "X/Y": { input: 1 } },
      }),
      JSON.stringify({
        "url_sha256": digest,
        "fetched_at_ms": now,
        tiers: { "x/ y": { input: 1 } },
      }),
      // An empty list is never written, so an empty record is not one this code wrote.
      JSON.stringify({ "url_sha256": digest, "fetched_at_ms": now, tiers: {} }),
      // Unknown fields at either level: not a record this code wrote.
      JSON.stringify({
        "url_sha256": digest,
        "fetched_at_ms": now,
        tiers: { "x/y": {} },
        extra: 1,
      }),
      JSON.stringify({
        "url_sha256": digest,
        "fetched_at_ms": now,
        tiers: { "x/y": { input: 1, note: "x" } },
      }),
      // A valid record written for ANOTHER url under this file name.
      JSON.stringify({
        "url_sha256": sha256(OTHER_URL),
        "fetched_at_ms": now,
        tiers: { "x/y": { input: 1 } },
      }),
    ];
    for (const text of invalid) {
      writeFileSync(path, text);
      const net = fakeFetch(openRouterBody("anthropic/claude-opus-4.8", "0.000015"));
      const loaded = await loadPricing(PRICE_URL, { cacheDir, nowMs: now, fetchImpl: net.fetch });
      expect(loaded.source).toBe("fetched");
      expect(net.calls).toBe(1);
      // ... and a failing refresh has nothing to fall back on.
      writeFileSync(path, text);
      const down = fakeFetch(null, { fail: true });
      await expect(loadPricing(PRICE_URL, { cacheDir, nowMs: now, fetchImpl: down.fetch })).rejects
        .toThrow("pricing request failed");
    }
    // Negative control: the same record with a valid shape IS a cache hit.
    writeFileSync(
      path,
      JSON.stringify({
        "url_sha256": digest,
        "fetched_at_ms": now,
        tiers: { "x/y": { input: 1 } },
      }),
    );
    const net = fakeFetch(null, { fail: true });
    const hit = await loadPricing(PRICE_URL, { cacheDir, nowMs: now, fetchImpl: net.fetch });
    expect(hit.source).toBe("cache");
    expect(net.calls).toBe(0);
  }));

test("loadPricing keeps one cache file per url", () =>
  withCacheDir(async (cacheDir) => {
    const now = 1_700_000_000_000;
    const a = fakeFetch(openRouterBody("anthropic/claude-opus-4.8", "0.000015"));
    const b = fakeFetch(openRouterBody("openai/gpt-5.5", "0.000002"));
    await loadPricing(PRICE_URL, { cacheDir, nowMs: now, fetchImpl: a.fetch });
    await loadPricing(OTHER_URL, { cacheDir, nowMs: now, fetchImpl: b.fetch });

    expect(pricingCachePath(PRICE_URL, cacheDir)).not.toBe(pricingCachePath(OTHER_URL, cacheDir));
    expect(readdirSync(cacheDir).length).toBe(2);
    const down = fakeFetch(null, { fail: true });
    const first = await loadPricing(PRICE_URL, { cacheDir, nowMs: now, fetchImpl: down.fetch });
    const second = await loadPricing(OTHER_URL, { cacheDir, nowMs: now, fetchImpl: down.fetch });
    expect([...first.pricing.keys()]).toEqual(["anthropic/claude-opus-4.8"]);
    expect([...second.pricing.keys()]).toEqual(["openai/gpt-5.5"]);
    expect(down.calls).toBe(0);
  }));

test("fetchPricing reads only string or number rates; other types and blank strings are absent", () =>
  withCacheDir(async (cacheDir) => {
    const net = fakeFetch({
      data: [
        { id: "a/bool", pricing: { prompt: true, completion: "0.000002" } },
        { id: "a/array", pricing: { prompt: [], completion: {} } },
        { id: "a/number", pricing: { prompt: 0.000001, completion: "0.000002" } },
        { id: "a/blank", pricing: { prompt: "", completion: "   " } },
        { id: "a/padded", pricing: { prompt: " 0.000001 ", completion: "0.000002" } },
        { id: "a/garbage", pricing: { prompt: "abc", completion: "0.000002" } },
      ],
    });
    const loaded = await loadPricing(PRICE_URL, { cacheDir, nowMs: 1, fetchImpl: net.fetch });

    // `true` and `[]` would coerce to 1 and 0 through Number(); neither is a price.
    expect(loaded.pricing.get("a/bool")).toEqual({ input: undefined, output: 2 });
    expect(loaded.pricing.get("a/array")).toEqual({ input: undefined, output: undefined });
    // Negative control: a numeric string and a plain number both price.
    expect(loaded.pricing.get("a/number")).toEqual({ input: 1, output: 2 });
    // Empty and whitespace-only strings are absent (Number("   ") is 0, which
    // would have priced the bucket as free); a padded number still prices.
    expect(loaded.pricing.get("a/blank")).toEqual({ input: undefined, output: undefined });
    expect(loaded.pricing.get("a/padded")).toEqual({ input: 1, output: 2 });
    // A string that is neither blank nor a number is not a price: the model is dropped.
    expect(loaded.pricing.has("a/garbage")).toBe(false);
  }));

test("loadPricing round-trips a tier with absent rates", () =>
  withCacheDir(async (cacheDir) => {
    const now = 1_700_000_000_000;
    const net = fakeFetch({ data: [{ id: "vendor/bare", pricing: { prompt: "0.000001" } }] });
    const fetched = await loadPricing(PRICE_URL, { cacheDir, nowMs: now, fetchImpl: net.fetch });
    const cached = await loadPricing(PRICE_URL, { cacheDir, nowMs: now, fetchImpl: net.fetch });

    expect(net.calls).toBe(1);
    expect(cached.pricing.get("vendor/bare")).toEqual(fetched.pricing.get("vendor/bare"));
    expect(cached.pricing.get("vendor/bare")?.input).toBe(1);
    expect(cached.pricing.get("vendor/bare")?.output).toBeUndefined();
  }));

test("loadPricing treats a cache stamped in the future as expired, but still as a fallback", () =>
  withCacheDir(async (cacheDir) => {
    const now = 1_700_000_000_000;
    const seed = fakeFetch(openRouterBody("anthropic/claude-opus-4.8", "0.000015"));
    await loadPricing(PRICE_URL, { cacheDir, nowMs: now + HOUR_MS, fetchImpl: seed.fetch });

    // The clock moved back: a "fresh" stamp from the future must not be trusted.
    const net = fakeFetch(openRouterBody("anthropic/claude-opus-4.8", "0.000099"));
    const refreshed = await loadPricing(PRICE_URL, { cacheDir, nowMs: now, fetchImpl: net.fetch });
    expect(refreshed.source).toBe("fetched");
    expect(net.calls).toBe(1);

    // ... yet when the refresh fails, the future-stamped copy beats no prices at all.
    await loadPricing(PRICE_URL, { cacheDir, nowMs: now + 2 * DAY_MS, fetchImpl: seed.fetch });
    expect(seed.calls).toBe(2);
    const down = fakeFetch(null, { fail: true });
    const stale = await loadPricing(PRICE_URL, { cacheDir, nowMs: now, fetchImpl: down.fetch });
    expect(stale.source).toBe("stale-cache");
    expect(stale.pricing.get("anthropic/claude-opus-4.8")?.input).toBe(15);
  }));

test("loadPricing treats an empty 200 response as a failed refresh", () =>
  withCacheDir(async (cacheDir) => {
    const now = 1_700_000_000_000;
    // No cache yet: an empty list is an error, not a price list, and nothing is written.
    const empty = fakeFetch({ data: [] });
    await expect(loadPricing(PRICE_URL, { cacheDir, nowMs: now, fetchImpl: empty.fetch })).rejects
      .toThrow("pricing response has no priced models");
    expect(readdirSync(cacheDir)).toEqual([]);

    // With an expired cache: the stale list wins over the empty response and stays on disk.
    const seed = fakeFetch(openRouterBody("anthropic/claude-opus-4.8", "0.000015"));
    await loadPricing(PRICE_URL, { cacheDir, nowMs: now, fetchImpl: seed.fetch });
    const bodyless = fakeFetch({});
    const loaded = await loadPricing(PRICE_URL, {
      cacheDir,
      nowMs: now + 2 * DAY_MS,
      fetchImpl: bodyless.fetch,
    });
    expect(loaded.source).toBe("stale-cache");
    expect(loaded.pricing.get("anthropic/claude-opus-4.8")?.input).toBe(15);
    const record = JSON.parse(readFileSync(pricingCachePath(PRICE_URL, cacheDir), "utf8"));
    expect(record.fetched_at_ms).toBe(now);
  }));

test("loadPricing serves a fetched list even when the cache cannot be written", () =>
  withCacheDir(async (dir) => {
    // A cache dir nested under a regular FILE cannot be created on any platform.
    const blocker = join(dir, "not-a-dir");
    writeFileSync(blocker, "");
    const cacheDir = join(blocker, "usage-index");
    const net = fakeFetch(openRouterBody("anthropic/claude-opus-4.8", "0.000015"));

    const loaded = await loadPricing(PRICE_URL, { cacheDir, nowMs: 1, fetchImpl: net.fetch });

    expect(loaded.source).toBe("fetched");
    expect(loaded.source === "fetched" && loaded.cacheWriteError).toBeTruthy();
    expect(loaded.pricing.get("anthropic/claude-opus-4.8")?.input).toBe(15);
    expect(existsSync(cacheDir)).toBe(false);
    // Negative control: a writable dir reports no write error.
    const ok = await loadPricing(PRICE_URL, { cacheDir: dir, nowMs: 1, fetchImpl: net.fetch });
    expect(ok).toEqual({ source: "fetched", pricing: ok.pricing, fetchedAtMs: 1 });
  }));

// Modelled on the live catalog, where the router pseudo-models (`openrouter/auto`
// and friends) carry `-1` sentinel rates beside hundreds of priced models.
test("loadPricing drops the entries that are not prices and keeps the rest of the catalog", () =>
  withCacheDir(async (cacheDir) => {
    const now = 1_700_000_000_000;
    const net = fakeFetch({
      data: [
        {
          id: "anthropic/claude-opus-4.8",
          pricing: { prompt: "0.000015", completion: "0.000075" },
        },
        { id: "openai/gpt-5.5", pricing: { prompt: "0.000002", completion: "0.000008" } },
        { id: "Google/Gemini-3-Pro", pricing: { prompt: "0.000001", completion: "0.000004" } },
        { id: "openrouter/auto", pricing: { prompt: "-1", completion: "-1" } },
        { id: "openrouter/fusion", pricing: { prompt: "0.000001", completion: "-1" } },
        { id: "vendor/infinite", pricing: { prompt: "Infinity", completion: "0.000001" } },
        { id: "vendor/nan", pricing: { prompt: 0.000001, completion: "NaN" } },
        { id: "vendor/negative-number", pricing: { prompt: -0.000001, completion: "0.000001" } },
        { id: "vendor/space d", pricing: { prompt: "0.000001", completion: "0.000001" } },
        { id: "", pricing: { prompt: "0.000001", completion: "0.000001" } },
      ],
    });

    const loaded = await loadPricing(PRICE_URL, { cacheDir, nowMs: now, fetchImpl: net.fetch });

    expect(loaded.source).toBe("fetched");
    expect([...loaded.pricing.keys()].sort()).toEqual([
      "anthropic/claude-opus-4.8",
      "google/gemini-3-pro",
      "openai/gpt-5.5",
    ]);
    expect(loaded.pricing.get("openai/gpt-5.5")).toEqual({
      input: 2,
      output: 8,
      cacheRead: undefined,
      cacheCreation: undefined,
    });
    // A dropped entry is simply unpriced when usage names it.
    const usage = new Map<string, UsageTokens>([
      ["openrouter/auto", { input: 1000, output: 0, cacheRead: 0, cacheCreation: 0 }],
      ["gpt-5.5", { input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 }],
    ]);
    const cost = estimateCost(usage, loaded.pricing);
    expect(cost.unpriced).toEqual(["openrouter/auto"]);
    expect(cost.totalUsd).toBe(2);
    // The persisted list is the filtered one and is a valid cache on re-read.
    const record = JSON.parse(readFileSync(pricingCachePath(PRICE_URL, cacheDir), "utf8"));
    expect(Object.keys(record.tiers).sort()).toEqual([...loaded.pricing.keys()].sort());
    const down = fakeFetch(null, { fail: true });
    const hit = await loadPricing(PRICE_URL, { cacheDir, nowMs: now, fetchImpl: down.fetch });
    expect(hit.source).toBe("cache");
    expect(hit.pricing).toEqual(loaded.pricing);
    expect(down.calls).toBe(0);
  }));

test("loadPricing treats a response with no priced model as a failed refresh", () =>
  withCacheDir(async (cacheDir) => {
    const now = 1_700_000_000_000;
    const seed = fakeFetch(openRouterBody("anthropic/claude-opus-4.8", "0.000015"));
    await loadPricing(PRICE_URL, { cacheDir, nowMs: now, fetchImpl: seed.fetch });
    const later = now + 2 * DAY_MS;

    // Router entries only, models with no rates at all, and unroutable ids
    // (empty or with whitespace): nothing here is a priced model.
    const unpriced = fakeFetch({
      data: [
        { id: "openrouter/auto", pricing: { prompt: "-1", completion: "-1" } },
        { id: "openai/gpt-5.5", pricing: { prompt: "-0.000001" } },
        { id: "a/b" },
        { id: "c/d", pricing: {} },
        { id: "", pricing: { prompt: "0.001" } },
        { id: "a b", pricing: { prompt: "0.001" } },
      ],
    });
    const kept = await loadPricing(PRICE_URL, {
      cacheDir,
      nowMs: later,
      fetchImpl: unpriced.fetch,
    });
    expect(kept).toMatchObject({
      source: "stale-cache",
      fetchedAtMs: now,
      fetchError: "pricing response has no priced models",
    });
    expect(kept.pricing.get("anthropic/claude-opus-4.8")?.input).toBe(15);
    expect(kept.pricing.has("openai/gpt-5.5")).toBe(false);

    // The stale file is untouched by the failed refresh.
    const record = JSON.parse(readFileSync(pricingCachePath(PRICE_URL, cacheDir), "utf8"));
    expect(record.fetched_at_ms).toBe(now);
    expect(Object.keys(record.tiers)).toEqual(["anthropic/claude-opus-4.8"]);
    // Negative control: one priced model among unpriced ones IS a usable list.
    const mixed = fakeFetch({
      data: [{ id: "a/b" }, { id: "anthropic/claude-opus-4.8", pricing: { prompt: "0.00002" } }],
    });
    const fresh = await loadPricing(PRICE_URL, { cacheDir, nowMs: later, fetchImpl: mixed.fetch });
    expect(fresh.source).toBe("fetched");
    expect(fresh.pricing.get("anthropic/claude-opus-4.8")?.input).toBe(20);
  }));

test("loadPricing never echoes the URL in its errors", () =>
  withCacheDir(async (cacheDir) => {
    const secretUrl = "https://pricing.example/models?token=SECRET-TOKEN-123";
    const now = 1_700_000_000_000;

    // Transport failure, no cache: the rejection carries neither the URL nor the token.
    const down = fakeFetch(null, { fail: true });
    const rejected = await loadPricing(secretUrl, { cacheDir, nowMs: now, fetchImpl: down.fetch })
      .then(() => null, (e: unknown) => (e instanceof Error ? e.message : String(e)));
    expect(rejected).toBe("pricing request failed");

    // A transport error's NAME is as untrusted as its message.
    const named = fakeFetch(null);
    named.fetch = (() => {
      const e = new Error(`boom ${secretUrl}`);
      e.name = secretUrl;
      return Promise.reject(e);
    }) as typeof fetch;
    await expect(loadPricing(secretUrl, { cacheDir, nowMs: now, fetchImpl: named.fetch })).rejects
      .toThrow(/^pricing request failed$/);

    // HTTP failure (a server's status text can echo the request) and a non-JSON
    // body: summarized without either.
    const denied = fakeFetch(null);
    denied.fetch = (() =>
      Promise.resolve(
        new Response("nope", { status: 401, statusText: `Unauthorized ${secretUrl}` }),
      )) as typeof fetch;
    await expect(loadPricing(secretUrl, { cacheDir, nowMs: now, fetchImpl: denied.fetch })).rejects
      .toThrow(/^pricing request returned HTTP 401$/);
    const html = fakeFetch(null);
    html.fetch = (() => Promise.resolve(new Response("<html>", { status: 200 }))) as typeof fetch;
    await expect(loadPricing(secretUrl, { cacheDir, nowMs: now, fetchImpl: html.fetch })).rejects
      .toThrow("pricing response was not valid JSON");

    // Stale fallback: the recorded fetchError is equally URL-free, and so is the file.
    const seed = fakeFetch(openRouterBody("anthropic/claude-opus-4.8", "0.000015"));
    await loadPricing(secretUrl, { cacheDir, nowMs: now, fetchImpl: seed.fetch });
    const stale = await loadPricing(secretUrl, {
      cacheDir,
      nowMs: now + 2 * DAY_MS,
      fetchImpl: down.fetch,
    });
    expect(stale.source).toBe("stale-cache");
    const text = JSON.stringify(stale) +
      readFileSync(pricingCachePath(secretUrl, cacheDir), "utf8");
    expect(text).not.toContain("SECRET-TOKEN");
    expect(text).not.toContain("pricing.example");
    // Negative control: the fake transport's own error DOES carry the token.
    await expect(down.fetch(secretUrl)).rejects.toThrow("SECRET-TOKEN-123");
  }));

test("loadPricing honours an abort signal: no request result, nothing written, stale kept", () =>
  withCacheDir(async (cacheDir) => {
    const now = 1_700_000_000_000;
    const aborted = new AbortController();
    aborted.abort();

    // No cache: a cancelled refresh rejects like any other failure and writes nothing.
    const net = fakeFetch(openRouterBody("anthropic/claude-opus-4.8", "0.000015"));
    await expect(
      loadPricing(PRICE_URL, {
        cacheDir,
        nowMs: now,
        fetchImpl: net.fetch,
        signal: aborted.signal,
      }),
    ).rejects.toThrow("pricing request was cancelled");
    expect(readdirSync(cacheDir)).toEqual([]);

    // Expired cache: the cancelled refresh leaves the stale copy as the answer.
    await loadPricing(PRICE_URL, { cacheDir, nowMs: now, fetchImpl: net.fetch });
    const stale = await loadPricing(PRICE_URL, {
      cacheDir,
      nowMs: now + 2 * DAY_MS,
      fetchImpl: net.fetch,
      signal: aborted.signal,
    });
    expect(stale).toMatchObject({
      source: "stale-cache",
      fetchError: "pricing request was cancelled",
    });

    // Negative control: a live signal changes nothing.
    const live = new AbortController();
    const fresh = await loadPricing(PRICE_URL, {
      cacheDir,
      nowMs: now + 2 * DAY_MS,
      fetchImpl: net.fetch,
      signal: live.signal,
    });
    expect(fresh.source).toBe("fetched");
  }));

// ---------- memoized lookups ----------

test("estimateCost prices the same list identically across calls and sees a changed catalog", () => {
  const pricing = new Map<string, PricingTier>([
    ["anthropic/claude-opus-4.1", { input: 15, output: 75 }],
  ]);
  const usage = new Map<string, UsageTokens>([
    ["opus", { input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 }],
    ["gpt-5.5", { input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 }],
  ]);

  const first = estimateCost(usage, pricing);
  const second = estimateCost(usage, pricing);
  expect(second).toEqual(first);
  expect(first.perModel["opus"]?.pricingReference).toBe("anthropic/claude-opus-4.1");
  expect(first.unpriced).toEqual(["gpt-5.5"]);

  // A price list that gains ids after it was first priced must resolve against
  // the new catalog, not a remembered one.
  pricing.set("anthropic/claude-opus-4.8", { input: 20, output: 80 });
  pricing.set("openai/gpt-5.5", { input: 2, output: 8 });
  const grown = estimateCost(usage, pricing);
  expect(grown.perModel["opus"]?.pricingReference).toBe("anthropic/claude-opus-4.8");
  expect(grown.perModel["gpt-5.5"]?.pricingReference).toBe("openai/gpt-5.5");
  expect(grown.unpriced).toEqual([]);

  // Same size, different ids: a swap must invalidate the remembered resolutions too.
  pricing.delete("anthropic/claude-opus-4.8");
  pricing.set("anthropic/claude-opus-4.9", { input: 25, output: 90 });
  const swapped = estimateCost(usage, pricing);
  expect(swapped.perModel["opus"]?.pricingReference).toBe("anthropic/claude-opus-4.9");
  expect(swapped.perModel["opus"]?.inputCostUsd).toBe(25);

  // A rate change under an unchanged id is priced from the map, never a remembered tier.
  pricing.set("anthropic/claude-opus-4.9", { input: 30, output: 90 });
  expect(estimateCost(usage, pricing).perModel["opus"]?.inputCostUsd).toBe(30);
});
