import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  type GitHubRateCard,
  type LoadedRateCard,
  loadGitHubRateCard,
  parseRateCard,
  rateCardCachePath,
  type RateCardSource,
} from "../src/usage/github_rate_card.ts";
import { estimateCost, type PricingTier, withGitHubRates } from "../src/usage/pricing.ts";
import { PROJECT_ROOT } from "../src/utils/root.ts";
import { expect, tempDir, test } from "./helpers/testing.ts";

/** GitHub's public data file behind the models-and-pricing docs page, as published. */
const CARD_TEXT = readFileSync(
  join(PROJECT_ROOT, "test", "fixtures", "github-rate-card.yml"),
  "utf8",
);
const CARD_URL = "https://rates.example/models-and-pricing.yml";
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

const SOL = { input: 4, output: 20, cacheRead: 0.4, cacheCreation: 5 };
const SOL_LONG = { input: 8, output: 30, cacheRead: 0.8, cacheCreation: 10 };
const ASTRA = { input: 10, output: 50, cacheRead: 1, cacheCreation: 12.5 };
const ASTRA_LONG = { input: 20, output: 75, cacheRead: 2, cacheCreation: 25 };
const FETCHED_NOW: RateCardSource = { source: "fetched", fetchedAtMs: NOW };

/** Serves `text` as the card and counts the calls; `fail` rejects the way the transport does. */
function textFetch(text: string, opts: { fail?: boolean } = {}): {
  fetch: typeof fetch;
  calls: number;
} {
  const state = {
    calls: 0,
    fetch: ((input: string | URL | Request): Promise<Response> => {
      state.calls++;
      if (opts.fail) {
        return Promise.reject(new TypeError(`error sending request for url (${String(input)})`));
      }
      return Promise.resolve(new Response(text, { status: 200 }));
    }) as typeof fetch,
  };
  return state;
}

function withCacheDir(body: (cacheDir: string) => Promise<void>): Promise<void> {
  return body(tempDir("rate-card-cache-"));
}

async function loadCard(
  cacheDir: string,
  nowMs: number,
  fetchImpl: typeof fetch,
): Promise<Extract<LoadedRateCard, { kind: "card" }>> {
  const loaded = await loadGitHubRateCard(CARD_URL, { cacheDir, nowMs, fetchImpl });
  if (loaded.kind !== "card") throw new Error(`no card: ${loaded.problem}`);
  return loaded;
}

function without(name: string, text: string = CARD_TEXT): string {
  return text.split(/\n(?=- model:)/).filter((row) => !row.includes(name)).join("\n");
}

test("parseRateCard reads the published file: a base tier per model, the long-context tier where the card has one, and every name mapped", () => {
  const card = parseRateCard(CARD_TEXT);
  expect(card.rates.get("openai/gpt-5.6-sol")).toEqual(SOL);
  expect(card.longContext.get("openai/gpt-5.6-sol")).toEqual({
    promptTokens: 272_000,
    tier: SOL_LONG,
  });
  expect(card.rates.get("openai/gpt-6-astra")).toEqual(ASTRA);
  expect(card.longContext.get("openai/gpt-6-astra")).toEqual({
    promptTokens: 272_000,
    tier: ASTRA_LONG,
  });
  // Anthropic: flat at any size.
  expect(card.rates.get("anthropic/claude-fable-5.1")).toEqual({
    input: 10,
    output: 50,
    cacheRead: 0.25,
    cacheCreation: 12.5,
  });
  expect(card.longContext.has("anthropic/claude-fable-5.1")).toBe(false);
  // A pre-5.6 OpenAI model has no cache write cost ("Not applicable"): the rate is absent, so
  // cache-write usage on it stays unpriced rather than free.
  expect(card.rates.get("openai/gpt-5.4")).toEqual({ input: 2.5, output: 15, cacheRead: 0.25 });
  // A footnote marker is not part of the name; a 200K threshold is read as such.
  expect(card.rates.get("google/gemini-3.6-flash")?.input).toBe(0.75);
  expect(card.longContext.get("x-ai/grok-4.5")?.promptTokens).toBe(200_000);
  // Every published row maps (the fast-mode variant is known and skipped), so the footer has
  // nothing to report; a row GitHub adds later is what it reports.
  expect(card.rates.size).toBe(28);
  expect(card.unmapped).toEqual([]);
  const added = parseRateCard(
    `${CARD_TEXT}\n- model: GPT-7\n  provider: openai\n  input: $1.00\n  cached_input: $0.10\n  output: $2.00\n`,
  );
  expect(added.unmapped).toEqual(["GPT-7"]);
  expect(added.rates.size).toBe(28);
});

/** Ways the file can change shape; each fails the whole parse, so nothing is priced from it. */
const RESHAPED: { name: string; reshape: (text: string) => string; problem: string }[] = [
  {
    name: "a column removed",
    reshape: (text) => text.replace(/^ {2}output: .*\n/gm, ""),
    problem: "the GPT-5 mini row (row 1) has no output price",
  },
  {
    name: "a threshold cell garbled",
    reshape: (text) => text.replace("'> 272K'", "'about 272K'"),
    problem: 'has a threshold that is neither "<= NK" nor "> NK"',
  },
  {
    name: "a tier label that disagrees with its threshold",
    reshape: (text) => text.replace("tier: 'Long context'", "tier: Default"),
    problem: "has threshold > 272K but a Default tier",
  },
  {
    name: "a rate outside $0.001..$500 per million",
    reshape: (text) => text.replace("input: $4.00", "input: $4000.00"),
    problem: "has a input of $4000.00, outside $0.001..$500 per million",
  },
  {
    name: "a line that is not `key: value`",
    reshape: (text) => text.replace("  provider: openai", "  provider openai"),
    problem: "rate card is not YAML: Cannot read a block mapping entry",
  },
  {
    name: "a long-context row without its default row",
    reshape: (text) =>
      text.replace(
        "- model: GPT-6 Astra\n  provider: openai\n  release_status: GA\n  category: Powerful\n  threshold: '\u2264 272K'",
        "- model: GPT-6 Astra\n  provider: openai\n  release_status: GA\n  category: Powerful\n  threshold: '\u2264 200K'",
      ),
    problem: "the long-context row of openai/gpt-6-astra has no default row at the same threshold",
  },
  {
    // Every mapped model survives, so only the pair rule catches it: a 300K astra prompt would
    // otherwise price at the base rate off a card the cache then keeps for a day.
    name: "every long-context row removed",
    reshape: (text) =>
      text.split(/\n(?=- model:)/).filter((row) => !row.includes("Long context")).join("\n"),
    problem: "the default row of openai/gpt-5.4 has no long-context row",
  },
  {
    name: "a zero threshold",
    reshape: (text) => text.replaceAll("272K", "0K"),
    problem: 'has a threshold that is neither "<= NK" nor "> NK"',
  },
  {
    // A repeated key would let the later, valid-looking cell hide the one that is not.
    name: "a repeated field in one row",
    reshape: (text) => text.replace("  input: $4.00\n", "  input: $4000.00\n  input: $4.00\n"),
    problem: "rate card is not YAML: Cannot store mapping pair: duplicated key",
  },
  {
    // A file with no rows is not an empty card: that would price every model from the list and
    // be cached for a day.
    name: "every row removed",
    reshape: (text) => text.split(/\n(?=- model:)/)[0]!,
    problem: "the rate card is not a list of rows",
  },
  {
    name: "an empty list",
    reshape: () => "[]\n",
    problem: "the rate card has no rows",
  },
];

for (const { name, reshape, problem } of RESHAPED) {
  test(`loadGitHubRateCard with ${name}: nothing to price from, the problem named, nothing cached`, () =>
    withCacheDir(async (cacheDir) => {
      const text = reshape(CARD_TEXT);
      expect(text).not.toBe(CARD_TEXT);
      const loaded = await loadGitHubRateCard(CARD_URL, {
        cacheDir,
        nowMs: NOW,
        fetchImpl: textFetch(text).fetch,
      });
      expect(loaded.kind).toBe("none");
      expect(loaded.problem).toContain(problem);
      expect(readdirSync(cacheDir)).toEqual([]);
    }));
}

// The incident: GitHub's current card, read whole, was refused for lacking a model this build
// maps, and a stale hand-copied table priced the run instead.
test("loadGitHubRateCard takes a whole card that lacks a mapped model as GitHub's current table, and that model prices from the list", () =>
  withCacheDir(async (cacheDir) => {
    const loaded = await loadCard(cacheDir, NOW, textFetch(without("GPT-5.6 Sol")).fetch);
    expect(loaded.from).toEqual(FETCHED_NOW);
    expect(loaded.problem).toBeUndefined();
    expect(loaded.card.rates.has("openai/gpt-5.6-sol")).toBe(false);
    expect(loaded.card.rates.get("openai/gpt-6-astra")).toEqual(ASTRA);
    expect(readdirSync(cacheDir)).toEqual([basename(rateCardCachePath(CARD_URL, cacheDir))]);

    const list = new Map<string, PricingTier>([
      ["openai/gpt-5.6-sol", { input: 2, output: 10, cacheRead: 0.2, cacheCreation: 2.5 }],
    ]);
    const usage = {
      byModel: new Map([["gpt-5.6-sol", {
        input: 1_000_000,
        output: 100_000,
        cacheRead: 0,
        cacheCreation: 0,
      }]]),
    };
    const estimate = estimateCost(usage, withGitHubRates(list, loaded.card, loaded.from));
    expect(estimate.perModel["gpt-5.6-sol"]?.estimatedCostUsd).toBeCloseTo(2 + 0.1 * 10, 10);
    expect(estimate.githubRated).toEqual([]);
  }));

test("loadGitHubRateCard fetches once a day, serves the cache inside the ttl, and keeps the last good card through a failed refresh", () =>
  withCacheDir(async (cacheDir) => {
    const net = textFetch(CARD_TEXT);
    const first = await loadCard(cacheDir, NOW, net.fetch);
    expect(first.from).toEqual(FETCHED_NOW);
    expect(first.problem).toBeUndefined();
    expect(first.card.rates.get("openai/gpt-5.6-sol")).toEqual(SOL);
    const path = rateCardCachePath(CARD_URL, cacheDir);
    expect(readdirSync(cacheDir)).toEqual([basename(path)]);
    const record = JSON.parse(readFileSync(path, "utf8"));
    // The URL never lands on disk (a custom one may carry credentials); the record is whole.
    expect(Object.keys(record).sort()).toEqual([
      "fetched_at_ms",
      "long_context",
      "rates",
      "unmapped",
      "url_sha256",
    ]);
    expect(JSON.stringify(record)).not.toContain("rates.example");

    // Inside the ttl: the cache answers, the network is not asked, the card is the same one.
    const second = await loadCard(cacheDir, NOW + DAY_MS - 1, net.fetch);
    expect(net.calls).toBe(1);
    expect(second.from).toEqual({ source: "cached", fetchedAtMs: NOW });
    expect(second.card).toEqual(first.card);

    // Expired, network down: the cached card, the problem named, the stamp on disk untouched.
    const down = await loadCard(cacheDir, NOW + DAY_MS, textFetch("", { fail: true }).fetch);
    expect(down.from).toEqual({ source: "cached", fetchedAtMs: NOW });
    expect(down.problem).toBe("rate card request failed");
    expect(down.card).toEqual(first.card);
    expect(JSON.parse(readFileSync(path, "utf8")).fetched_at_ms).toBe(NOW);

    // Expired and readable: refreshed, restamped.
    const refreshed = await loadCard(cacheDir, NOW + DAY_MS, net.fetch);
    expect(refreshed.from).toEqual({ source: "fetched", fetchedAtMs: NOW + DAY_MS });
    expect(JSON.parse(readFileSync(path, "utf8")).fetched_at_ms).toBe(NOW + DAY_MS);
  }));

test("the published card prices sol and astra at their base tier up to 272K and their long-context tier above it", () => {
  const list = new Map<string, PricingTier>([
    ["openai/gpt-5.6-sol", { input: 2, output: 10, cacheRead: 0.2, cacheCreation: 2.5 }],
    ["openai/gpt-6-astra", ASTRA],
  ]);
  const total = { input: 1_000_000, output: 100_000, cacheRead: 2_000_000, cacheCreation: 50_000 };
  const long = { input: 400_000, output: 40_000, cacheRead: 1_000_000, cacheCreation: 20_000 };
  const usage = {
    byModel: new Map([["gpt-5.6-sol", total], ["gpt-6-astra", total]]),
    longContext: { byModel: new Map([["gpt-5.6-sol", long], ["gpt-6-astra", long]]) },
  };
  const published = parseRateCard(CARD_TEXT);
  const fetched = estimateCost(usage, withGitHubRates(list, published, FETCHED_NOW));
  expect(fetched.githubRated).toEqual(["gpt-5.6-sol", "gpt-6-astra"]);
  // sol: 600K in at 4 + 400K at 8, 60K out at 20 + 40K at 30, 1M reads at 0.4 + 1M at 0.8, 30K
  // writes at 5 + 20K at 10.
  expect(fetched.perModel["gpt-5.6-sol"]?.estimatedCostUsd).toBeCloseTo(
    (0.6 * 4 + 0.4 * 8) + (0.06 * 20 + 0.04 * 30) + (0.4 + 0.8) + (0.03 * 5 + 0.02 * 10),
    10,
  );
  // astra: the list's base rate IS the card's, so only the long-context share moves the price.
  expect(fetched.perModel["gpt-6-astra"]?.estimatedCostUsd).toBeCloseTo(
    (0.6 * 10 + 0.4 * 20) + (0.06 * 50 + 0.04 * 75) + (1 + 2) + (0.03 * 12.5 + 0.02 * 25),
    10,
  );

  // A tier cut above the readers' 272K bucket would over-price the bucket, so it is not applied:
  // the model is flat at its base rate and not GitHub-rated.
  const cutHigher: GitHubRateCard = {
    ...published,
    longContext: new Map([["openai/gpt-6-astra", { promptTokens: 400_000, tier: ASTRA_LONG }]]),
  };
  const flat = estimateCost(usage, withGitHubRates(list, cutHigher, FETCHED_NOW));
  expect(flat.perModel["gpt-6-astra"]?.estimatedCostUsd).toBeCloseTo(
    10 + 0.1 * 50 + 2 * 1 + 0.05 * 12.5,
    10,
  );
  expect(flat.githubRated).toEqual(["gpt-5.6-sol"]);
});
