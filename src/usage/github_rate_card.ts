// GitHub's Copilot rate card: the table behind the docs' models-and-pricing page, read from the data
// file that page renders and cached for a day beside the OpenRouter list (both are PUBLIC data). A
// card that cannot be fetched or does not parse WHOLE is never priced from: the last good cached
// card, else the built-in table, prices the run, and the caller says so in one line.

import { createHash } from "node:crypto";
import { join } from "node:path";
import * as v from "valibot";
import { canonicalPricingUrl } from "../copilot_api/config_registry.ts";
import { usageIndexDir } from "../copilot_api/paths.ts";
import { errMessage } from "../utils/error.ts";
import * as fs from "../utils/fs_facade.ts";
import { parseJsonRecord } from "../utils/json.ts";
import { MILLISECONDS_PER_DAY } from "../utils/time.ts";
import { COPILOT_ENV_USER_AGENT } from "../utils/user_agent.ts";
import type { PricingTier } from "./pricing.ts";

const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = MILLISECONDS_PER_DAY;
/** USD per million tokens a card rate must fall within; a number outside it is a misread cell. */
const MIN_RATE_PER_MILLION = 0.001;
const MAX_RATE_PER_MILLION = 500;
/** The card's spelling for a cell that does not apply to the row. */
const NOT_APPLICABLE = "Not applicable";

/** Prompts (input plus cached input) above `promptTokens` bill at `tier`; a rate the tier leaves
 *  out keeps the model's base rate. */
export interface LongContextTier {
  promptTokens: number;
  tier: PricingTier;
}

/** Keyed by the OpenRouter id DISPLAY_NAME_IDS gives the card's display name. */
export interface GitHubRateCard {
  rates: ReadonlyMap<string, PricingTier>;
  longContext: ReadonlyMap<string, LongContextTier>;
  /** Display names on the card that DISPLAY_NAME_IDS does not know, sorted: GitHub added a row. */
  unmapped: readonly string[];
}

/** Where the card that priced a run came from; `fetchedAtMs` is when GitHub was last read. */
export type RateCardSource =
  | { source: "fetched" | "cached"; fetchedAtMs: number }
  | { source: "built-in" };

export interface LoadedRateCard {
  card: GitHubRateCard;
  from: RateCardSource;
  /** Why today's card was not read (the run then prices from `card`, the last good one); absent
   *  when it was. */
  problem?: string;
  /** Set when a fetched card could not be persisted: the next run fetches again. */
  cacheWriteError?: string;
}

/** The rates that stand in when no card was ever cached: GitHub's card as read on 2026-09-19 for
 *  the models it prices differently from the OpenRouter list (every other model's card matched the
 *  list that day), plus the long-context tiers, which the list does not carry at all. */
export const BUILT_IN_RATE_CARD: GitHubRateCard = {
  rates: new Map([
    ["openai/gpt-5.6-sol", { input: 4, output: 20, cacheRead: 0.4, cacheCreation: 5 }],
  ]),
  longContext: new Map([
    ["openai/gpt-6-astra", {
      promptTokens: 272_000,
      tier: { input: 20, output: 75, cacheRead: 2, cacheCreation: 25 },
    }],
    ["openai/gpt-5.6-sol", {
      promptTokens: 272_000,
      tier: { input: 8, output: 30, cacheRead: 0.8, cacheCreation: 10 },
    }],
  ]),
  unmapped: [],
};

/** The card's display names and the OpenRouter id each one prices. `null` marks a row for an
 *  offering no id here names (a fast-mode variant): it is neither priced nor reported. A name
 *  missing from this map is a row GitHub added since, reported as unmapped. */
const DISPLAY_NAME_IDS: ReadonlyMap<string, string | null> = new Map([
  ["GPT-5 mini", "openai/gpt-5-mini"],
  ["GPT-5.3-Codex", "openai/gpt-5.3-codex"],
  ["GPT-5.4", "openai/gpt-5.4"],
  ["GPT-5.4 mini", "openai/gpt-5.4-mini"],
  ["GPT-5.4 nano", "openai/gpt-5.4-nano"],
  ["GPT-5.5", "openai/gpt-5.5"],
  ["GPT-5.6 Luna", "openai/gpt-5.6-luna"],
  ["GPT-5.6 Sol", "openai/gpt-5.6-sol"],
  ["GPT-5.6 Terra", "openai/gpt-5.6-terra"],
  ["GPT-6 Astra", "openai/gpt-6-astra"],
  ["Claude Haiku 4.5", "anthropic/claude-haiku-4.5"],
  ["Claude Sonnet 4", "anthropic/claude-sonnet-4"],
  ["Claude Sonnet 4.6", "anthropic/claude-sonnet-4.6"],
  ["Claude Opus 4.7", "anthropic/claude-opus-4.7"],
  ["Claude Opus 4.8", "anthropic/claude-opus-4.8"],
  ["Claude Opus 4.8 (fast mode) (preview)", null],
  ["Claude Opus 5", "anthropic/claude-opus-5"],
  ["Claude Sonnet 5", "anthropic/claude-sonnet-5"],
  ["Claude Fable 5", "anthropic/claude-fable-5"],
  ["Claude Fable 5.1", "anthropic/claude-fable-5.1"],
  ["Gemini 3.5 Flash", "google/gemini-3.5-flash"],
  ["Gemini 3.6 Flash", "google/gemini-3.6-flash"],
  ["Gemini 3.7 Flash", "google/gemini-3.7-flash"],
  ["Gemini 3.8 Flash", "google/gemini-3.8-flash"],
  ["Grok 4.5", "x-ai/grok-4.5"],
  ["Grok 4.6", "x-ai/grok-4.6"],
  ["MAI-Code-1.1-Flash", "microsoft/mai-code-1.1-flash"],
  ["Kimi K2.7 Code", "moonshotai/kimi-k2.7-code"],
  ["Kimi K3", "moonshotai/kimi-k3"],
]);

// ---------- the data file ----------

// The file is a YAML list of flat maps, one per row, every scalar on its own line; that is all the
// grammar read here. Anything else on a non-blank, non-comment line is a reshaped file, and a
// reshaped file is not priced from.
const ROW_START = /^- ([a-z_]+): (.*)$/;
const ROW_FIELD = /^ {2}([a-z_]+): (.*)$/;
const PRICE = /^\$(\d+(?:\.\d+)?)$/;
/** "<= 272K" (the card spells the first with U+2264) or "> 272K"; a zero size is no threshold. */
const THRESHOLD = /^(\u2264|>) ?([1-9]\d*)K$/;
/** A footnote marker on a display name, `[^gemini-flash-promo]`. */
const FOOTNOTE = /\[\^[^\]]*\]/g;

interface Row {
  line: number;
  fields: Map<string, string>;
}

function rows(text: string): Row[] {
  const out: Row[] = [];
  let current: Row | null = null;
  const setField = (row: Row, key: string, raw: string, lineNo: number): void => {
    if (row.fields.has(key)) throw new Error(`rate card line ${lineNo} repeats ${key}`);
    row.fields.set(key, unquote(raw, lineNo));
  };
  text.split("\n").forEach((rawLine, index) => {
    const line = rawLine.trimEnd();
    if (line === "" || line.startsWith("#")) return;
    const lineNo = index + 1;
    const start = ROW_START.exec(line);
    if (start !== null) {
      current = { line: lineNo, fields: new Map() };
      out.push(current);
      setField(current, start[1]!, start[2]!, lineNo);
      return;
    }
    const field = current === null ? null : ROW_FIELD.exec(line);
    if (field === null) throw new Error(`rate card line ${lineNo} is not a "key: value" row field`);
    setField(current!, field[1]!, field[2]!, lineNo);
  });
  return out;
}

function unquote(raw: string, line: number): string {
  const text = raw.trim();
  const quote = text[0];
  if (quote !== "'" && quote !== '"') return text;
  if (text.length < 2 || !text.endsWith(quote)) {
    throw new Error(`rate card line ${line} has an unterminated quote`);
  }
  return text.slice(1, -1);
}

/** "the GPT-5.6 Sol row (line 130)": every parse error names its row this way. */
function where(row: Row): string {
  return `the ${row.fields.get("model") ?? "unnamed"} row (line ${row.line})`;
}

function rateOf(row: Row, key: string, required: boolean): number | undefined {
  const raw = row.fields.get(key);
  if (raw === undefined || raw === NOT_APPLICABLE) {
    if (required) throw new Error(`${where(row)} has no ${key} price`);
    return undefined;
  }
  const match = PRICE.exec(raw);
  if (match === null) throw new Error(`${where(row)} has a ${key} cell that is not a $ price`);
  const rate = Number(match[1]);
  if (rate < MIN_RATE_PER_MILLION || rate > MAX_RATE_PER_MILLION) {
    throw new Error(
      `${where(row)} has a ${key} of $${
        match[1]
      }, outside $${MIN_RATE_PER_MILLION}..$${MAX_RATE_PER_MILLION} per million`,
    );
  }
  return rate;
}

function tierOf(row: Row): PricingTier {
  return {
    input: rateOf(row, "input", true),
    output: rateOf(row, "output", true),
    cacheRead: rateOf(row, "cached_input", true),
    cacheCreation: rateOf(row, "cache_write", false),
  };
}

/** Where a row sits: flat (no tiers), the default tier up to a prompt size, or the long-context
 *  tier above it. The card's tier label must agree with its threshold sign. */
type Placement =
  | { kind: "flat" }
  | { kind: "default"; promptTokens: number }
  | { kind: "long"; promptTokens: number };

function placementOf(row: Row): Placement {
  const threshold = row.fields.get("threshold");
  const tier = row.fields.get("tier");
  if (threshold === undefined && tier === undefined) return { kind: "flat" };
  if (threshold === undefined || tier === undefined) {
    throw new Error(`${where(row)} names a tier without a threshold, or the reverse`);
  }
  if (threshold === NOT_APPLICABLE) {
    if (tier !== "Default") throw new Error(`${where(row)} has no threshold but a ${tier} tier`);
    return { kind: "flat" };
  }
  const match = THRESHOLD.exec(threshold);
  if (match === null) {
    throw new Error(`${where(row)} has a threshold that is neither "<= NK" nor "> NK"`);
  }
  const promptTokens = Number(match[2]) * 1000;
  const expectedTier = match[1] === ">" ? "Long context" : "Default";
  if (tier !== expectedTier) {
    throw new Error(`${where(row)} has threshold ${threshold} but a ${tier} tier`);
  }
  return { kind: match[1] === ">" ? "long" : "default", promptTokens };
}

function setOnce<T>(into: Map<string, T>, id: string, value: T, row: Row): void {
  if (into.has(id)) throw new Error(`${where(row)} prices ${id} a second time`);
  into.set(id, value);
}

/** Every row is read in full before any is mapped, so a reshaped column anywhere in the file fails
 *  the whole parse rather than the rows it happened to touch. */
export function parseRateCard(text: string): GitHubRateCard {
  const parsed = rows(text).map((row) => {
    const model = row.fields.get("model");
    if (model === undefined) throw new Error(`the row at line ${row.line} has no model`);
    return {
      row,
      name: model.replace(FOOTNOTE, "").trim(),
      tier: tierOf(row),
      at: placementOf(row),
    };
  });
  const rates = new Map<string, PricingTier>();
  const longContext = new Map<string, LongContextTier>();
  const defaultThresholds = new Map<string, number>();
  const unmapped = new Set<string>();
  for (const { row, name, tier, at } of parsed) {
    const id = DISPLAY_NAME_IDS.get(name);
    if (id === undefined) {
      unmapped.add(name);
      continue;
    }
    if (id === null) continue;
    if (at.kind === "long") {
      setOnce(longContext, id, { promptTokens: at.promptTokens, tier }, row);
      continue;
    }
    setOnce(rates, id, tier, row);
    if (at.kind === "default") defaultThresholds.set(id, at.promptTokens);
  }
  // A model is flat, or a complete pair: a default row cut at a threshold and a long-context row
  // above the same one. A file that lost either half is reshaped.
  for (const [id, long] of longContext) {
    if (defaultThresholds.get(id) !== long.promptTokens) {
      throw new Error(`the long-context row of ${id} has no default row at the same threshold`);
    }
  }
  for (const id of defaultThresholds.keys()) {
    if (!longContext.has(id)) throw new Error(`the default row of ${id} has no long-context row`);
  }
  return { rates, longContext, unmapped: [...unmapped].sort() };
}

// ---------- fetch and cache ----------

/** Errors are fixed text (plus a numeric HTTP status), never the transport's: a custom URL may carry
 *  credentials. */
async function fetchRateCardText(url: string, fetchImpl: typeof fetch): Promise<string> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { Accept: "text/plain", "User-Agent": COPILOT_ENV_USER_AGENT },
      signal: timeout,
    });
  } catch {
    throw timeoutError(timeout) ?? new Error("rate card request failed");
  }
  if (!res.ok) throw new Error(`rate card request returned HTTP ${res.status}`);
  try {
    return await res.text();
  } catch {
    throw timeoutError(timeout) ?? new Error("rate card response could not be read");
  }
}

function timeoutError(timeout: AbortSignal): Error | null {
  return timeout.aborted
    ? new Error(`rate card request timed out after ${FETCH_TIMEOUT_MS / 1000}s`)
    : null;
}

/** A fresh cache answers without the network. Otherwise today's card is fetched and parsed whole;
 *  a fetch or parse failure, or a card with fewer models, long-context tiers, or cache-write rates
 *  than the one it replaces, keeps the cached card (expired or not), else the built-in table, and
 *  names the problem. A cache stamped in the future (clock moved back) is expired, never fresh. */
export async function loadGitHubRateCard(
  url: string,
  opts: {
    cacheDir?: string;
    nowMs?: number;
    ttlMs?: number;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<LoadedRateCard> {
  const nowMs = opts.nowMs ?? Date.now();
  const ttlMs = opts.ttlMs ?? CACHE_TTL_MS;
  const canonical = canonicalPricingUrl(url);
  const urlDigest = sha256Hex(canonical);
  const cachePath = rateCardCachePath(canonical, opts.cacheDir ?? usageIndexDir());
  const cached = readRateCardCache(cachePath, urlDigest);
  if (cached !== null) {
    const ageMs = nowMs - cached.fetchedAtMs;
    if (ageMs >= 0 && ageMs < ttlMs) {
      return { card: cached.card, from: { source: "cached", fetchedAtMs: cached.fetchedAtMs } };
    }
  }
  const lastGood: LoadedRateCard = cached === null
    ? { card: BUILT_IN_RATE_CARD, from: { source: "built-in" } }
    : { card: cached.card, from: { source: "cached", fetchedAtMs: cached.fetchedAtMs } };
  let card: GitHubRateCard;
  try {
    card = parseRateCard(await fetchRateCardText(canonical, opts.fetchImpl ?? fetch));
    const fewer = (what: string, now: number, before: number): void => {
      if (now < before) {
        throw new Error(`the card maps ${now} ${what}, fewer than the ${before} it did`);
      }
    };
    fewer("models", card.rates.size, lastGood.card.rates.size);
    fewer("long-context tiers", card.longContext.size, lastGood.card.longContext.size);
    fewer("cache-write rates", cacheWriteRates(card), cacheWriteRates(lastGood.card));
    // The seed's models are the ones this program relies on: a card without them is truncated,
    // whatever its counts say against a one-model seed on a cold cache.
    const missing = [
      ...[...BUILT_IN_RATE_CARD.rates.keys()].filter((id) => !card.rates.has(id)),
      ...[...BUILT_IN_RATE_CARD.longContext.keys()].filter((id) => !card.longContext.has(id)),
    ];
    if (missing.length > 0) {
      throw new Error(`the card no longer prices ${[...new Set(missing)].sort().join(", ")}`);
    }
  } catch (e) {
    return { ...lastGood, problem: errMessage(e) };
  }
  const from: RateCardSource = { source: "fetched", fetchedAtMs: nowMs };
  try {
    writeRateCardCache(cachePath, urlDigest, nowMs, card);
  } catch (e) {
    return { card, from, cacheWriteError: errMessage(e) };
  }
  return { card, from };
}

/** How many of the card's tiers, base and long-context, price cache writes: cache_write is the one
 *  cell a row may leave out, so it is the one a lost column cannot be told from. */
function cacheWriteRates(card: GitHubRateCard): number {
  const tiers = [...card.rates.values(), ...[...card.longContext.values()].map((l) => l.tier)];
  return tiers.filter((tier) => tier.cacheCreation !== undefined).length;
}

/** Keyed by the CANONICAL URL, so two spellings of one file share a cache. */
export function rateCardCachePath(url: string, cacheDir: string): string {
  return join(cacheDir, `rate-card-${sha256Hex(canonicalPricingUrl(url)).slice(0, 16)}.json`);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const RATE_SCHEMA = v.optional(v.pipe(v.number(), v.finite(), v.minValue(0)));
const TIER_SCHEMA = v.strictObject({
  "input": RATE_SCHEMA,
  "output": RATE_SCHEMA,
  "cacheRead": RATE_SCHEMA,
  "cacheCreation": RATE_SCHEMA,
});

// The URL is stored as a digest only. The quoted snake_case keys are the on-disk contract; the
// record is this program's own and is read back as written.
const CACHE_RECORD_SCHEMA = v.strictObject({
  "url_sha256": v.string(),
  "fetched_at_ms": v.pipe(v.number(), v.finite()),
  "rates": v.record(v.string(), TIER_SCHEMA),
  "long_context": v.record(
    v.string(),
    v.strictObject({
      "prompt_tokens": v.pipe(v.number(), v.integer(), v.minValue(1)),
      "tier": TIER_SCHEMA,
    }),
  ),
  "unmapped": v.array(v.string()),
});

/** A file written for another URL, not JSON, or not this record reads as absent. */
function readRateCardCache(
  path: string,
  urlDigest: string,
): { card: GitHubRateCard; fetchedAtMs: number } | null {
  const read = fs.readTextResult(path);
  if (read.kind !== "text") return null;
  const parsed = v.safeParse(CACHE_RECORD_SCHEMA, parseJsonRecord(read.text));
  if (!parsed.success || parsed.output.url_sha256 !== urlDigest) return null;
  const record = parsed.output;
  return {
    fetchedAtMs: record.fetched_at_ms,
    card: {
      rates: new Map(Object.entries(record.rates)),
      longContext: new Map(
        Object.entries(record.long_context).map(([id, long]) => [id, {
          promptTokens: long.prompt_tokens,
          tier: long.tier,
        }]),
      ),
      unmapped: record.unmapped,
    },
  };
}

function writeRateCardCache(
  path: string,
  urlDigest: string,
  fetchedAtMs: number,
  card: GitHubRateCard,
): void {
  const record: v.InferOutput<typeof CACHE_RECORD_SCHEMA> = {
    "url_sha256": urlDigest,
    "fetched_at_ms": fetchedAtMs,
    "rates": Object.fromEntries(card.rates),
    "long_context": Object.fromEntries(
      [...card.longContext].map(([id, long]) => [id, {
        "prompt_tokens": long.promptTokens,
        "tier": long.tier,
      }]),
    ),
    "unmapped": [...card.unmapped],
  };
  fs.writeText(path, `${JSON.stringify(record)}\n`, { secretKeys: [] });
}
