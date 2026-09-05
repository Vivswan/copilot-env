// Synthetic Codex rollout and Claude transcript trees for the usage readers: a PROFILE measured
// from real logs (numbers and schema words only) and a GENERATOR sampling it into real-shaped
// files, deterministic per seed on every OS (one PRNG, no clock, no environment, UTC), with a ledger.
import { Buffer } from "node:buffer";
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zstdCompressSync } from "node:zlib";
import * as v from "valibot";
import type { ModelUsage, ReadonlyUsageReport } from "../../src/usage/usage.ts";
import { isRecord } from "../../src/utils/json.ts";
import { MILLISECONDS_PER_DAY } from "../../src/utils/time.ts";

export const FIXTURES_DIR = fileURLToPath(new URL("../fixtures/usage/", import.meta.url));
export const PROFILE_PATH = path.join(FIXTURES_DIR, "profile.json");
export const TEMPLATES_DIR = path.join(FIXTURES_DIR, "templates");
export const MEGABYTE = 1024 * 1024;

/** The window's end when a caller names none: a fixed instant, never the clock. */
export const DEFAULT_END = "2026-09-01T00:00:00.000Z";
export const DEFAULT_DAYS = 40;
/** Bounds that keep the byte budget and the day table finite and sane: a tebibyte, a century.
 *  The floor leaves the Codex budget room for one session (MIN_FILE_BYTES), so a tree always
 *  carries at least one timestamped line and its span is always defined. */
export const MIN_MB = 0.01;
export const MAX_MB = 1024 * 1024;
export const MAX_DAYS = 36_500;

export type UsageSource = "codex" | "claude";
export const USAGE_SOURCES: readonly UsageSource[] = ["codex", "claude"];

/** Milliseconds a gap must reach before a session counts as resumed. */
export const RESUME_GAP_MS = 60 * 60 * 1000;

// ---------- the closed label sets a profile may name ----------

/** The label for a line whose type words are not in the reviewed set, and for a torn line. */
export const OTHER_LINE_TYPE = "other";
export const TORN_LINE_TYPE = "torn";

/**
 * The Codex line types a profile may name, as observed on real rollouts: a CLOSED set, so a
 * type word carrying anything else folds to OTHER_LINE_TYPE before it can reach a committed
 * file. Extend deliberately when the writer adds a type.
 */
export const CODEX_LINE_TYPES: ReadonlySet<string> = new Set([
  "compacted",
  "event_msg/agent_message",
  "event_msg/agent_reasoning",
  "event_msg/context_compacted",
  "event_msg/item_completed",
  "event_msg/mcp_tool_call_end",
  "event_msg/patch_apply_end",
  "event_msg/sub_agent_activity",
  "event_msg/task_complete",
  "event_msg/task_started",
  "event_msg/thread_rolled_back",
  "event_msg/thread_settings_applied",
  "event_msg/token_count",
  "event_msg/turn_aborted",
  "event_msg/user_message",
  "event_msg/web_search_end",
  "inter_agent_communication_metadata",
  "response_item/agent_message",
  "response_item/custom_tool_call",
  "response_item/custom_tool_call_output",
  "response_item/function_call",
  "response_item/function_call_output",
  "response_item/message/assistant",
  "response_item/message/developer",
  "response_item/message/user",
  "response_item/reasoning",
  "response_item/tool_search_call",
  "response_item/tool_search_output",
  "response_item/web_search_call",
  "session_meta",
  "token_usage_record",
  "turn_context",
  "world_state",
]);

/** The Claude line types the profile may name (see CODEX_LINE_TYPES). */
export const CLAUDE_LINE_TYPES: ReadonlySet<string> = new Set([
  "agent-name",
  "ai-title",
  "assistant",
  "atis-latch",
  "attachment",
  "continued-in",
  "cost-state",
  "custom-title",
  "file-history-delta",
  "file-history-snapshot",
  "last-prompt",
  "mode",
  "permission-mode",
  "pr-link",
  "queue-operation",
  "relocated",
  "result",
  "started",
  "system/agents_killed",
  "system/away_summary",
  "system/compact_boundary",
  "system/informational",
  "system/local_command",
  "system/model_refusal_fallback",
  "system/scheduled_task_fire",
  "system/stop_hook_summary",
  "system/turn_duration",
  "user/prompt",
  "user/tool_result",
  "worktree-state",
]);

/** Vendor model ids are dotted, dashed identifiers; anything else folds to OTHER_MODEL. */
export const OTHER_MODEL = "other";
const MODEL_ID = /^[a-z0-9][a-z0-9._:/-]{0,63}$/i;

// ---------- profile schema ----------

const nonNegative = v.pipe(v.number(), v.minValue(0));
const share = v.pipe(v.number(), v.minValue(0), v.maxValue(1));

export const QuantilesSchema = v.pipe(
  v.strictObject({
    count: v.pipe(v.number(), v.integer(), v.minValue(0)),
    p5: nonNegative,
    p25: nonNegative,
    p50: nonNegative,
    p75: nonNegative,
    p95: nonNegative,
    p99: nonNegative,
  }),
  v.check(
    (q) => q.p5 <= q.p25 && q.p25 <= q.p50 && q.p50 <= q.p75 && q.p75 <= q.p95 && q.p95 <= q.p99,
    "quantiles must be non-decreasing from p5 to p99",
  ),
);
export type Quantiles = v.InferOutput<typeof QuantilesSchema>;

const ShareTableSchema = v.record(v.string(), share);

export const ModelProfileSchema = v.strictObject({
  share,
  input: QuantilesSchema,
  output: QuantilesSchema,
  cacheRead: QuantilesSchema,
  cacheWrite: QuantilesSchema,
});
export type ModelProfile = v.InferOutput<typeof ModelProfileSchema>;

/** A record key naming a model: the vendor-id pattern or the fold-all label. */
const ModelKeySchema = v.pipe(
  v.string(),
  v.check((k) => k === OTHER_MODEL || MODEL_ID.test(k), "model id outside the vendor-id pattern"),
);

/**
 * One source's profile. Its record keys are the words the profile may carry, so
 * they are checked here at the parse boundary against the source's closed line
 * set and the model-id pattern: a profile holding any other word never parses.
 */
function sourceProfileSchema(lineTypes: ReadonlySet<string>) {
  const lineTypeKey = v.pipe(
    v.string(),
    v.check(
      (k) => lineTypes.has(k) || k === OTHER_LINE_TYPE || k === TORN_LINE_TYPE,
      "line type outside the reviewed set",
    ),
  );
  return v.strictObject({
    /** This source's share of the bytes across both sources. */
    bytesShare: share,
    fileBytes: QuantilesSchema,
    linesPerFile: QuantilesSchema,
    /** Serialized bytes of one line without its LF, per line type (codexLineType / claudeLineType). */
    bytesPerLine: v.record(lineTypeKey, QuantilesSchema),
    lineTypeShare: v.record(lineTypeKey, share),
    /** Fraction of lines the readers price (token_count, assistant with usage). */
    usageLineShare: share,
    /** At least one model with a positive share: a generator draws usage from this table. */
    models: v.pipe(
      v.record(ModelKeySchema, ModelProfileSchema),
      v.check(
        (models) => Object.values(models).some((m) => m.share > 0),
        "models must name at least one model with a positive share",
      ),
    ),
    /** Sessions started per calendar day, over the days that had any. */
    sessionsPerDay: QuantilesSchema,
    /** Milliseconds between consecutive timestamped lines of one file. */
    gapMs: QuantilesSchema,
    turnsPerSession: QuantilesSchema,
    usageEventsPerTurn: QuantilesSchema,
    /** Lines sharing one usage key: Claude's message.id, Codex's exact token_count info. */
    repeatsPerUsageKey: QuantilesSchema,
    /** Of the repeated lines, the fraction whose output snapshot grew over the previous. */
    growingSnapshotShare: share,
    /** Codex: sessions carrying forked_from_id. Claude: files repeating an earlier file's ids. */
    forkShare: share,
    /** Files with a gap of RESUME_GAP_MS or more between consecutive events. */
    resumeShare: share,
    directoryDepth: QuantilesSchema,
    /** Claude only: dash-separated segments of the project slug directory. */
    slugSegments: QuantilesSchema,
    filenameShapes: ShareTableSchema,
    midnightCrossingShare: share,
  });
}

/** The Codex instance stands for the shape; both sources parse to the same type. */
export const SourceProfileSchema = sourceProfileSchema(CODEX_LINE_TYPES);
export type SourceProfile = v.InferOutput<typeof SourceProfileSchema>;

export const ProfileSchema = v.strictObject({
  version: v.literal(1),
  codex: SourceProfileSchema,
  claude: sourceProfileSchema(CLAUDE_LINE_TYPES),
});
export type Profile = v.InferOutput<typeof ProfileSchema>;

/** The schema's own field names, the only path segments an error message may spell. */
const PROFILE_FIELDS: ReadonlySet<string> = new Set([
  ...Object.keys(ProfileSchema.entries),
  ...Object.keys(SourceProfileSchema.entries),
  ...Object.keys(ModelProfileSchema.entries),
  ...Object.keys(QuantilesSchema.pipe[0].entries),
]);

/**
 * Strict parse of a profile document. The message names the failing path and
 * what was expected there, never the value received: a document under test
 * may carry anything, and an error is the one place it could leak from.
 */
export function parseProfile(raw: unknown): Profile {
  const result = v.safeParse(ProfileSchema, raw);
  if (!result.success) {
    const issue = result.issues[0];
    // Record keys (line types, model ids, shapes) are data, so only the schema's own field
    // names may appear in the path.
    const where = issue.path
      ?.map((p) => (PROFILE_FIELDS.has(String(p.key)) ? String(p.key) : "<entry>"))
      .join(".") ?? "<root>";
    const detail = issue.type === "check"
      ? issue.message
      : `expected ${issue.expected ?? issue.type}`;
    throw new Error(`invalid usage profile at ${where}: ${detail}`);
  }
  return result.output;
}

/** JSON text parsed with a fixed error: the runtime's own message quotes the input. */
function parseJsonQuietly(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what} is not valid JSON`);
  }
}

export function loadProfile(file: string = PROFILE_PATH): Profile {
  return parseProfile(parseJsonQuietly(readFileSync(file, "utf8"), "usage profile"));
}

// ---------- quantiles ----------

/** The quantile table of `values` (sorted in place). An empty input yields all zeros. */
export function quantiles(values: number[]): Quantiles {
  values.sort((a, b) => a - b);
  const at = (q: number): number =>
    values[Math.min(values.length - 1, Math.floor(q * values.length))] ?? 0;
  return {
    count: values.length,
    p5: at(0.05),
    p25: at(0.25),
    p50: at(0.5),
    p75: at(0.75),
    p95: at(0.95),
    p99: at(0.99),
  };
}

const QUANTILE_POINTS: readonly (readonly [number, keyof Omit<Quantiles, "count">])[] = [
  [0.05, "p5"],
  [0.25, "p25"],
  [0.5, "p50"],
  [0.75, "p75"],
  [0.95, "p95"],
  [0.99, "p99"],
];

/**
 * One draw from the distribution a quantile table summarizes: piecewise-linear inverse CDF
 * through the six points, clamped (never extrapolated) below p5 and above p99. Linear
 * arithmetic only, so every host computes the same double.
 */
export function sampleQuantile(rng: Rng, q: Quantiles): number {
  const u = rng();
  let prev = QUANTILE_POINTS[0]!;
  if (u <= prev[0]) return q[prev[1]];
  for (const point of QUANTILE_POINTS.slice(1)) {
    if (u <= point[0]) {
      const lo = q[prev[1]];
      const hi = q[point[1]];
      return lo + (hi - lo) * ((u - prev[0]) / (point[0] - prev[0]));
    }
    prev = point;
  }
  return q[prev[1]];
}

/** sampleQuantile rounded to a whole number, never below `min`. */
export function sampleCount(rng: Rng, q: Quantiles, min = 0): number {
  return Math.max(min, Math.round(sampleQuantile(rng, q)));
}

// ---------- seeded randomness ----------

export type Rng = () => number;

/** mulberry32: 32-bit state, integer arithmetic only, so every host agrees on the stream. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: Rng, items: readonly T[]): T {
  const item = items[Math.min(items.length - 1, Math.floor(rng() * items.length))];
  if (item === undefined) throw new Error("pick from an empty list");
  return item;
}

function chance(rng: Rng, probability: number): boolean {
  return rng() < probability;
}

/** A key of `table` drawn by weight; keys are visited sorted so the draw is order-free. */
function weightedKey(rng: Rng, table: Record<string, number>): string {
  const keys = Object.keys(table).sort();
  if (keys.length === 0) throw new Error("weighted draw over an empty table");
  const total = keys.reduce((sum, key) => sum + (table[key] ?? 0), 0);
  let u = rng() * total;
  for (const key of keys) {
    u -= table[key] ?? 0;
    if (u < 0) return key;
  }
  return keys[keys.length - 1]!;
}

function modelShares(models: Record<string, ModelProfile>): Record<string, number> {
  return Object.fromEntries(Object.entries(models).map(([name, m]) => [name, m.share]));
}

const HEX = "0123456789abcdef";

function hex(rng: Rng, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += HEX[Math.floor(rng() * 16)];
  return out;
}

function uuid(rng: Rng): string {
  return `${hex(rng, 8)}-${hex(rng, 4)}-4${hex(rng, 3)}-a${hex(rng, 3)}-${hex(rng, 12)}`;
}

const WORDS: readonly string[] = [
  "alpha",
  "bravo",
  "charlie",
  "delta",
  "echo",
  "foxtrot",
  "golf",
  "hotel",
  "india",
  "juliet",
];

const BRANCHES: readonly string[] = ["main", "feat/synthetic", "fix/parser", "wt/generator"];

// ---------- line classification (shared with the profiler) ----------

/**
 * The type label of one Codex rollout line: `type`, `type/payload.type` for
 * event and response items, and the role appended for messages, folded onto
 * CODEX_LINE_TYPES.
 */
export function codexLineType(line: Record<string, unknown>): string {
  const type = typeof line.type === "string" ? line.type : "";
  const payload = isRecord(line.payload) ? line.payload : {};
  let label = type;
  if (type === "event_msg" || type === "response_item") {
    const sub = typeof payload.type === "string" ? payload.type : "";
    label = type === "response_item" && sub === "message" && typeof payload.role === "string"
      ? `${type}/${sub}/${payload.role}`
      : `${type}/${sub}`;
  }
  return CODEX_LINE_TYPES.has(label) ? label : OTHER_LINE_TYPE;
}

/**
 * The type label of one Claude transcript line: `type`, `system/<subtype>`,
 * and user lines split into prompts and tool results, folded onto
 * CLAUDE_LINE_TYPES.
 */
export function claudeLineType(line: Record<string, unknown>): string {
  const type = typeof line.type === "string" ? line.type : "";
  let label = type;
  if (type === "system") {
    label = `system/${typeof line.subtype === "string" ? line.subtype : ""}`;
  } else if (type === "user") {
    const message = isRecord(line.message) ? line.message : {};
    const content = message.content;
    const isToolResult = Array.isArray(content) &&
      content.some((block) => isRecord(block) && block.type === "tool_result");
    label = isToolResult ? "user/tool_result" : "user/prompt";
  }
  return CLAUDE_LINE_TYPES.has(label) ? label : OTHER_LINE_TYPE;
}

export function modelLabel(model: unknown): string {
  return typeof model === "string" && MODEL_ID.test(model) ? model : OTHER_MODEL;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The shape of a log filename, from a CLOSED set: the writers' known patterns with ids and
 * digits normalized away, `other.jsonl` for anything else, so a private basename never
 * reaches the profile.
 */
export function filenameShape(name: string): string {
  const rollout = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl(\.zst)?$/.exec(name);
  if (rollout !== null) {
    const parts = rollout[1]!.split("_");
    const ids = parts.every((part) => UUID.test(part)) ? parts.map(() => "UUID").join("_") : "ID";
    return `rollout-9999-99-99T99-99-99-${ids}.jsonl${rollout[2] ?? ""}`;
  }
  if (name.endsWith(".jsonl") && UUID.test(name.slice(0, -".jsonl".length))) return "UUID.jsonl";
  if (/^agent-[^/]+\.jsonl$/.test(name)) return "agent-ID.jsonl";
  if (name === "journal.jsonl") return name;
  return "other.jsonl";
}

// ---------- templates ----------

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

function isJsonObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface SourceTemplates {
  /** Whole-line templates keyed by line type (codexLineType / claudeLineType labels). */
  lines: Record<string, Json>;
  /** Content-block templates spliced into `@content` arrays. */
  blocks: Record<string, Json>;
}
export type Templates = Record<UsageSource, SourceTemplates>;

const SourceTemplatesSchema = v.strictObject({
  lines: v.record(v.string(), v.unknown()),
  blocks: v.record(v.string(), v.unknown()),
});

/** Load `<dir>/<source>.json` for both sources; the fixture set is committed and ASCII. */
export function loadTemplates(dir: string = TEMPLATES_DIR): Templates {
  const files = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  const out: Partial<Templates> = {};
  for (const source of USAGE_SOURCES) {
    const file = `${source}.json`;
    if (!files.includes(file)) throw new Error(`missing usage template ${file} in ${dir}`);
    const parsed = v.safeParse(
      SourceTemplatesSchema,
      parseJsonQuietly(readFileSync(path.join(dir, file), "utf8"), `usage template ${file}`),
    );
    if (!parsed.success) {
      throw new Error(`usage template ${file} must hold lines and blocks records`);
    }
    out[source] = parsed.output as SourceTemplates;
  }
  return out as Templates;
}

export const templates: Templates = loadTemplates();

/** A placeholder is a string of the form `@name`; everything else is literal. */
const PLACEHOLDER = /^@[a-zA-Z]+$/;

/**
 * Substitute `@name` placeholders in `template` from `ctx`. An unknown
 * placeholder is a template bug and throws, so a typo cannot ship as content.
 * Values from `ctx` are inserted as they are, not walked again.
 */
export function render(template: Json, ctx: Record<string, Json>): Json {
  if (typeof template === "string") {
    if (!PLACEHOLDER.test(template)) return template;
    const value = ctx[template.slice(1)];
    if (value === undefined) throw new Error(`template placeholder ${template} has no value`);
    return value;
  }
  if (Array.isArray(template)) return template.map((item) => render(item, ctx));
  if (isJsonObject(template)) {
    const out: JsonObject = {};
    for (const [key, value] of Object.entries(template)) out[key] = render(value, ctx);
    return out;
  }
  return template;
}

/** `@fill` maps to itself: the one placeholder that survives the first render for sizing. */
const KEEP_FILL: Record<string, Json> = { fill: "@fill" };

// ---------- filler text ----------

type FillKind = "prose" | "opaque";

/**
 * Code points no filler may carry: node:readline (the pre-index reader) splits lines on
 * U+2028, U+2029 and U+0085 too, so a line holding one unescaped would vanish from the
 * goldens recorded with it. Everything else non-ASCII is welcome.
 */
export const LINE_SPLITTING_CODE_POINTS: readonly string[] = ["\u2028", "\u2029", "\u0085"];

/**
 * The filler vocabulary, in escapes so this file stays ASCII: accents, CJK, Arabic, Hebrew,
 * emoji, quotes, backslashes and control characters the way pasted prose and tool output
 * carry them, never a LINE_SPLITTING_CODE_POINTS member.
 */
const PROSE_TOKENS: readonly string[] = [
  "the",
  "index",
  "cache",
  "rollout",
  "token",
  "usage",
  "synthetic",
  "parser",
  "please",
  "refactor",
  "module",
  "deterministic",
  "quantile",
  "session",
  "profile",
  "caf\u00e9",
  "na\u00efve",
  "\u00fcber",
  "stra\u00dfe",
  "\u65e5\u672c\u8a9e",
  "\u4e2d\u6587",
  "\u0645\u0631\u062d\u0628\u0627",
  "\u05e9\u05dc\u05d5\u05dd",
  "\u{1F600}",
  "\u{1F680}",
  "\u{1F4A1}",
  "\u2705",
  '"quoted"',
  "back\\slash",
  "C:\\Users\\dev\\proj",
  "line\nbreak",
  "tab\tstop",
  "<tag>",
  "a=b&c=d",
  "`code`",
  '{"k":1}',
];

const OPAQUE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

for (const token of [...PROSE_TOKENS, OPAQUE_ALPHABET]) {
  for (const cp of LINE_SPLITTING_CODE_POINTS) {
    if (token.includes(cp)) throw new Error("filler alphabet carries a line-splitting code point");
  }
}

/** The JSON-escaped UTF-8 length of `text` inside a string literal. */
function escapedBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text)) - 2;
}

/** Bytes a token occupies once JSON-escaped inside a string, plus its trailing space. */
const PROSE_COSTS: readonly number[] = PROSE_TOKENS.map((token) => escapedBytes(token) + 1);

/** Text whose JSON-escaped UTF-8 form is exactly `bytes` long. */
function filler(rng: Rng, bytes: number, kind: FillKind): string {
  if (bytes <= 0) return "";
  if (kind === "opaque") {
    let out = "";
    for (let i = 0; i < bytes; i++) out += OPAQUE_ALPHABET[Math.floor(rng() * 64)];
    return out;
  }
  let text = "";
  let remaining = bytes;
  for (let tries = 0; remaining > 0 && tries < bytes; tries++) {
    const i = Math.floor(rng() * PROSE_TOKENS.length);
    const cost = PROSE_COSTS[i]!;
    if (cost > remaining) continue;
    text += `${PROSE_TOKENS[i]} `;
    remaining -= cost;
  }
  // Spaces close the gap left when no token fits; a period replaces the last
  // one so the text never ends mid-whitespace.
  text += " ".repeat(remaining);
  return text.endsWith(" ") ? `${text.slice(0, -1)}.` : text;
}

// ---------- line rendering ----------

/**
 * Serialize `line` (rendered except for `@fill`) padded to `targetBytes` before its LF, or
 * unpadded when already longer; `prefix` (a marker, a pasted needle) leads the filled text.
 * Two serializations per line; the second is written.
 */
function serializeSized(
  rng: Rng,
  line: Json,
  targetBytes: number,
  kind: FillKind,
  prefix: string,
): string {
  const base = JSON.stringify(render(line, { fill: prefix }));
  const pad = Math.round(targetBytes) - Buffer.byteLength(base);
  if (pad <= 0) return base;
  const lead = prefix === "" ? "" : `${prefix} `;
  const padding = pad - (escapedBytes(lead) - escapedBytes(prefix));
  return JSON.stringify(render(line, { fill: lead + filler(rng, padding, kind) }));
}

function isoTimestamp(ms: number): string {
  return new Date(Math.round(ms)).toISOString();
}

/** The UTC calendar day of an instant: the synthetic user's local day. */
function utcDay(ms: number): string {
  return isoTimestamp(ms).slice(0, 10);
}

/** `YYYY-MM-DD` and `HH-MM-SS` of a UTC instant, the synthetic user's local clock. */
function utcParts(ms: number): { date: string; time: string; y: string; m: string; d: string } {
  const iso = isoTimestamp(ms);
  const date = iso.slice(0, 10);
  return {
    date,
    time: iso.slice(11, 19).replaceAll(":", "-"),
    y: date.slice(0, 4),
    m: date.slice(5, 7),
    d: date.slice(8, 10),
  };
}

// ---------- the generator ----------

export interface GenerateOptions {
  root: string;
  mb: number;
  seed: number;
  days?: number;
  profile?: Profile;
  adversarial?: boolean;
  /** RFC 3339 instant with a zone (`Z` or an offset) the window ends at; the default is a
   *  fixed date, never the clock. */
  end?: string;
}

export interface GeneratedFile {
  path: string;
  source: UsageSource;
  bytes: number;
}

/**
 * The usage the tree carries, per model_provider for Codex and one report for Claude, days
 * cut in UTC and models keyed by the RAW id the lines spell (canonicalize to compare with a
 * reader). Every planted count is booked once: copies of any kind add nothing.
 */
export interface ExpectedReport {
  byModel: Map<string, ModelUsage>;
  perDay: Map<string, Map<string, ModelUsage>>;
}

export interface ExpectedUsage {
  codex: Map<string, ExpectedReport>;
  claude: ExpectedReport;
}

/** A structural check that the ledger's shape is a reader report's read-only face. */
const _ledgerIsReport: (r: ExpectedReport) => ReadonlyUsageReport = (r) => r;

function emptyReport(): ExpectedReport {
  return { byModel: new Map(), perDay: new Map() };
}

function addBuckets(into: Map<string, ModelUsage>, model: string, u: ModelUsage): void {
  const prev = into.get(model);
  into.set(
    model,
    prev === undefined ? { ...u } : {
      input: prev.input + u.input,
      output: prev.output + u.output,
      cacheRead: prev.cacheRead + u.cacheRead,
      cacheCreation: prev.cacheCreation + u.cacheCreation,
      events: prev.events + u.events,
    },
  );
}

/** Book one increment into the roll-up and the day's row, the way the readers' fold does. */
function book(report: ExpectedReport, day: string, model: string, u: ModelUsage): void {
  addBuckets(report.byModel, model, u);
  let row = report.perDay.get(day);
  if (row === undefined) {
    row = new Map();
    report.perDay.set(day, row);
  }
  addBuckets(row, model, u);
}

function copyReport(report: ExpectedReport): ExpectedReport {
  return {
    byModel: new Map([...report.byModel].map(([m, u]) => [m, { ...u }])),
    perDay: new Map(
      [...report.perDay].map(([d, row]) => [d, new Map([...row].map(([m, u]) => [m, { ...u }]))]),
    ),
  };
}

export interface GeneratedTree {
  root: string;
  codexRoot: string;
  claudeRoot: string;
  files: GeneratedFile[];
  /** Distinctive strings planted inside prompt text, for the content tests. */
  markers: string[];
  expected: ExpectedUsage;
  /** The earliest and latest timestamp any line in the tree carries (unix ms, UTC). */
  firstEventMs: number;
  lastEventMs: number;
}

const MARKER_COUNT = 8;
const MIN_FILE_BYTES = 2_048;
const MAX_FILE_BYTES = 256 * MEGABYTE;
/** A hard stop on one turn's round trips, so a tiny line-size draw can never spin forever. */
const MAX_EVENTS_PER_TURN = 5_000;
/** The scripted edge-case sessions (the first few of each source) stay small so every one
 *  of them fits a few-MB tree: Codex plants the midnight/torn/archived session, a fork
 *  parent, its fork, a fork without its parent, and an archive-only session; Claude plants
 *  a truncated original, its resume, and a subagent workflow. */
const CODEX_SCRIPTED_SESSIONS = 5;
const CLAUDE_SCRIPTED_SESSIONS = 3;
const SCRIPTED_MAX_BYTES = 96 * 1024;
/** A single between-line gap is capped here; longer breaks are resumes, modelled apart. */
const MAX_LINE_GAP_MS = 10 * 60 * 1000;
/** A fork's copied prefix lands inside this window after its session_meta, and its own
 *  first line waits until READER_FORK_WINDOW_MS has passed: the readers' fallback when the
 *  parent is gone drops every token_count inside their two-second window, so an own count
 *  landing there would be lost. */
const FORK_COPY_WINDOW_MS = 800;
const READER_FORK_WINDOW_MS = 2_000;
const CODEX_MODEL_CONTEXT_WINDOW = 272_000;

/** Needles a user might paste: the readers' substring gates, inside content. */
const NEEDLES: readonly string[] = [
  '"token_count"',
  '"type":"assistant"',
  '"session_meta"',
  '"turn_context"',
  '"thread_settings_applied"',
  '"usage":{"input_tokens":999999}',
];

interface Generator {
  rng: Rng;
  profile: Profile;
  adversarial: boolean;
  markers: string[];
  markerCursor: number;
  needleCursor: number;
  files: GeneratedFile[];
  written: number;
  startMs: number;
  dayWeights: Record<UsageSource, Record<string, number>>;
  expected: ExpectedUsage;
  firstEventMs: number;
  lastEventMs: number;
}

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function sampleUsage(rng: Rng, model: ModelProfile): Usage {
  return {
    input: sampleCount(rng, model.input),
    output: sampleCount(rng, model.output, 1),
    cacheRead: sampleCount(rng, model.cacheRead),
    cacheWrite: sampleCount(rng, model.cacheWrite),
  };
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

/** The next planted marker, cycling, so every marker lands within the first sessions. */
function nextMarker(g: Generator): string {
  const marker = g.markers[g.markerCursor % g.markers.length]!;
  g.markerCursor++;
  return marker;
}

/** Prompt text: a marker, plus a pasted needle half the time when adversarial. */
function promptText(g: Generator): string {
  const marker = nextMarker(g);
  if (!g.adversarial || !chance(g.rng, 0.5)) return marker;
  const needle = NEEDLES[g.needleCursor % NEEDLES.length]!;
  g.needleCursor++;
  return `${marker} pasted: ${needle}`;
}

/** A session start inside the window, on a day drawn by the per-day session weights. */
function sessionStart(g: Generator, source: UsageSource): number {
  const day = Number(weightedKey(g.rng, g.dayWeights[source]));
  return g.startMs + day * MILLISECONDS_PER_DAY + g.rng() * MILLISECONDS_PER_DAY;
}

/** The byte target of the next file: a profile draw clamped into what the budget allows. */
function nextFileBytes(g: Generator, source: UsageSource, budget: number): number {
  const remaining = budget - g.written;
  const drawn = sampleQuantile(g.rng, g.profile[source].fileBytes);
  return Math.max(MIN_FILE_BYTES, Math.min(MAX_FILE_BYTES, drawn, remaining));
}

function lineGap(g: Generator, source: UsageSource): number {
  return Math.min(MAX_LINE_GAP_MS, sampleQuantile(g.rng, g.profile[source].gapMs));
}

function writeBytes(
  g: Generator,
  source: UsageSource,
  file: string,
  body: Uint8Array,
): GeneratedFile {
  mkdirSync(path.dirname(file), { recursive: true });
  // Exclusive: the root was empty when generation began, so an existing file is a bug.
  writeFileSync(file, body, { flag: "wx" });
  const entry = { path: file, source, bytes: body.byteLength };
  g.files.push(entry);
  g.written += entry.bytes;
  return entry;
}

function writeText(g: Generator, source: UsageSource, file: string, body: string): GeneratedFile {
  return writeBytes(g, source, file, Buffer.from(body, "utf8"));
}

/** Every instant one line carries: its top-level `timestamp` and the nested numeric ones
 *  (`started_at`, `completed_at_ms`, ...), which a fork copy keeps from the parent. */
interface LineStamps {
  outer?: number;
  nested: number[];
}

/** The earliest and latest instant a set of stamps carries, nested ones included. */
function spanOf(stamps: Iterable<LineStamps>): { first: number; last: number } {
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const { outer, nested } of stamps) {
    for (const ms of outer === undefined ? nested : [outer, ...nested]) {
      first = Math.min(first, ms);
      last = Math.max(last, ms);
    }
  }
  return { first, last };
}

/**
 * The lines of one file under construction, with a running byte count (LF included) and
 * each line's stamps. The span a tree reports is merged from these only when a buffer is
 * WRITTEN, so a discarded session, a popped line, or an unemitted instant never moves it.
 */
class LineBuffer {
  readonly lines: string[] = [];
  readonly stamps: LineStamps[] = [];
  bytes = 0;

  push(line: string, stamps: LineStamps): void {
    this.lines.push(line);
    this.stamps.push({
      outer: stamps.outer === undefined ? undefined : Math.round(stamps.outer),
      nested: stamps.nested.map((ms) => Math.round(ms)),
    });
    this.bytes += Buffer.byteLength(line) + 1;
  }

  pop(): string | undefined {
    const line = this.lines.pop();
    this.stamps.pop();
    if (line !== undefined) this.bytes -= Buffer.byteLength(line) + 1;
    return line;
  }

  body(): string {
    return this.lines.length === 0 ? "" : `${this.lines.join("\n")}\n`;
  }

  /** Fold the instants this buffer carries into the tree's span; called when it is written. */
  noteSpan(g: Generator): void {
    const { first, last } = spanOf(this.stamps);
    g.firstEventMs = Math.min(g.firstEventMs, first);
    g.lastEventMs = Math.max(g.lastEventMs, last);
  }
}

/** The instant placeholders a template emits: `@ts` (the outer timestamp) and the nested
 *  numeric ones. Nothing else in a template is an instant (durations are not). */
const INSTANT_PLACEHOLDERS = ["ts", "startedMs", "nowMs"] as const;
type InstantPlaceholder = (typeof INSTANT_PLACEHOLDERS)[number];
const TEMPLATE_INSTANTS = new Map<Json, InstantPlaceholder[]>();

function templateInstants(template: Json): InstantPlaceholder[] {
  let found = TEMPLATE_INSTANTS.get(template);
  if (found === undefined) {
    const text = JSON.stringify(template);
    found = INSTANT_PLACEHOLDERS.filter((name) => text.includes(`"@${name}"`));
    TEMPLATE_INSTANTS.set(template, found);
  }
  return found;
}

/** The stamps a rendered line carries, from its template's instant placeholders and `ctx`. */
function lineStamps(template: Json, ctx: Record<string, Json>): LineStamps {
  const instants = templateInstants(template);
  const nested: number[] = [];
  for (const name of instants) {
    if (name !== "ts") nested.push(ctx[name] as number);
  }
  return { outer: instants.includes("ts") ? (Date.parse(ctx.ts as string)) : undefined, nested };
}

interface LineOptions {
  bytes?: number;
  kind?: FillKind;
  /** The clock advance before this line, instead of a sampled gap. */
  gapMs?: number;
  extra?: Record<string, Json>;
  /** Leads the filled text: a marker or needle inside a prompt. */
  prefix?: string;
  /** Insert or reorder top-level keys after rendering (a fork's parent id, a subagent's id). */
  reshape?: (line: JsonObject) => JsonObject;
}

// ----- Codex -----

interface CodexSession {
  id: string;
  metaMs: number;
  provider: string;
  buffer: LineBuffer;
  forkedFrom?: string;
}

interface CodexState {
  ordinal: number;
  nowMs: number;
  totals: Usage;
  turnId: string;
  model: string;
  cwd: string;
  git: Json;
  /** `ordinal` and `item_completed` arrived with newer Codex releases; older rollouts lack them. */
  withOrdinal: boolean;
  /** `token_usage_record` is newer still; the profile's share decides how often it appears. */
  withUsageRecord: boolean;
  /** The floor on token_count repeats (2 for the scripted re-emitting session). */
  minCountRepeats: number;
}

function codexUsageJson(u: Usage): Json {
  return {
    "input_tokens": u.input,
    "cached_input_tokens": u.cacheRead,
    "cache_write_input_tokens": u.cacheWrite,
    "output_tokens": u.output,
    "reasoning_output_tokens": Math.floor(u.output * 0.4),
    "total_tokens": u.input + u.output,
  };
}

function codexLine(
  g: Generator,
  session: CodexSession,
  state: CodexState,
  type: string,
  opts: LineOptions = {},
): void {
  const template = templates.codex.lines[type];
  if (template === undefined) throw new Error(`no codex template for ${type}`);
  const profile = g.profile.codex;
  state.nowMs += opts.gapMs ?? lineGap(g, "codex");
  state.ordinal++;
  const ctx: Record<string, Json> = {
    ...KEEP_FILL,
    ts: isoTimestamp(state.nowMs),
    ordinal: state.ordinal,
    sessionId: session.id,
    turnId: state.turnId,
    id: `rs_${hex(g.rng, 48)}`,
    callId: `call_${hex(g.rng, 24)}`,
    compHash: hex(g.rng, 16),
    model: state.model,
    cwd: state.cwd,
    date: utcParts(state.nowMs).date,
    startedMs: Math.round(state.nowMs - 1_000),
    nowMs: Math.round(state.nowMs),
    contextWindow: CODEX_MODEL_CONTEXT_WINDOW,
    provider: session.provider,
    git: state.git,
    ...opts.extra,
  };
  let rendered = render(template, ctx);
  if (isJsonObject(rendered)) {
    if (!state.withOrdinal) delete rendered.ordinal;
    if (opts.reshape !== undefined) rendered = opts.reshape(rendered);
  }
  const target = opts.bytes ??
    sampleQuantile(g.rng, profile.bytesPerLine[type] ?? profile.fileBytes);
  session.buffer.push(
    serializeSized(g.rng, rendered, target, opts.kind ?? "prose", opts.prefix ?? ""),
    lineStamps(template, ctx),
  );
}

function codexMessage(
  g: Generator,
  session: CodexSession,
  state: CodexState,
  role: string,
  prefix = "",
): void {
  const block = role === "assistant" ? "output_text" : "input_text";
  codexLine(g, session, state, `response_item/message/${role}`, {
    prefix,
    extra: { content: [templates.codex.blocks[block] ?? null] },
  });
}

function codexItemCompleted(
  g: Generator,
  session: CodexSession,
  state: CodexState,
  item: Json,
): void {
  if (!state.withOrdinal) return;
  codexLine(g, session, state, "event_msg/item_completed", { extra: { item } });
}

/** The session's own session_meta line; a resume re-emits it with the same ids. The first
 *  one stamps the session start itself, which is also the rollout filename's timestamp. */
function codexSessionMeta(
  g: Generator,
  session: CodexSession,
  state: CodexState,
  first: boolean,
): void {
  codexLine(g, session, state, "session_meta", {
    gapMs: first ? 0 : undefined,
    reshape: session.forkedFrom === undefined ? undefined : (line) => {
      const payload = line.payload;
      if (isJsonObject(payload)) {
        // forked_from_id sits before model_provider in the writer's key order.
        const provider = payload["model_provider"] ?? null;
        delete payload["model_provider"];
        line.payload = {
          ...payload,
          "forked_from_id": session.forkedFrom!,
          "model_provider": provider,
        };
      }
      return line;
    },
  });
}

/** Book one Codex round trip's usage the way readCodexSessions prices it. */
function expectCodex(
  g: Generator,
  session: CodexSession,
  ms: number,
  model: string,
  last: Usage,
): void {
  let report = g.expected.codex.get(session.provider);
  if (report === undefined) {
    report = emptyReport();
    g.expected.codex.set(session.provider, report);
  }
  book(report, utcDay(ms), model, {
    input: last.input - last.cacheRead,
    output: last.output,
    cacheRead: last.cacheRead,
    cacheCreation: 0,
    events: 1,
  });
}

/**
 * One model round trip: reasoning, then a tool call (its usage record, its
 * completion, its output) or the final message, then the token count. The
 * count is what the readers price, so it is booked into the expected report.
 */
function codexRoundTrip(
  g: Generator,
  session: CodexSession,
  state: CodexState,
  model: ModelProfile,
  final: boolean,
): void {
  const share = g.profile.codex.lineTypeShare;
  const last = sampleUsage(g.rng, model);
  last.cacheRead = Math.min(last.cacheRead, last.input);
  state.totals = addUsage(state.totals, last);
  const usageRecord = (): void => {
    if (!state.withUsageRecord) return;
    codexLine(g, session, state, "token_usage_record", {
      extra: {
        usage: codexUsageJson(last),
        turnUsage: codexUsageJson(last),
        threadUsage: codexUsageJson(state.totals),
        responseId: `resp_${hex(g.rng, 32)}`,
      },
    });
  };

  codexLine(g, session, state, "response_item/reasoning", { kind: "opaque" });
  codexItemCompleted(g, session, state, {
    "type": "reasoning",
    "id": `item_${hex(g.rng, 12)}`,
    "summary_text": [],
    "raw_content": [],
  });
  if (chance(g.rng, 0.5)) codexLine(g, session, state, "event_msg/agent_reasoning");
  if (final) {
    codexMessage(g, session, state, "assistant");
    codexLine(g, session, state, "event_msg/agent_message");
    codexItemCompleted(g, session, state, {
      "type": "agent_message",
      "id": `item_${hex(g.rng, 12)}`,
      "content": [],
      "phase": "final_answer",
    });
    usageRecord();
  } else {
    const tool = weightedKey(g.rng, {
      custom: share["response_item/custom_tool_call"] ?? 1,
      function: share["response_item/function_call"] ?? 0.05,
      mcp: share["event_msg/mcp_tool_call_end"] ?? 0.05,
    });
    if (tool === "custom") {
      codexLine(g, session, state, "response_item/custom_tool_call");
      usageRecord();
      codexItemCompleted(g, session, state, {
        "type": "command_execution",
        "id": `item_${hex(g.rng, 12)}`,
        "process_id": String(1000 + Math.floor(g.rng() * 60000)),
        "command": ["bash", "-lc", "@fill"],
        "cwd": state.cwd,
        "parsed_cmd": [],
        "source": "agent",
        "status": "completed",
        "stdout": "",
        "stderr": "",
        "aggregated_output": "",
        "exit_code": 0,
        "duration": { "secs": 0, "nanos": 120000000 },
        "formatted_output": "",
      });
      codexLine(g, session, state, "response_item/custom_tool_call_output");
    } else if (tool === "function") {
      codexLine(g, session, state, "response_item/function_call");
      usageRecord();
      codexLine(g, session, state, "response_item/function_call_output");
    } else {
      usageRecord();
      codexLine(g, session, state, "event_msg/mcp_tool_call_end");
    }
  }
  const info: Json = {
    "total_token_usage": codexUsageJson(state.totals),
    "last_token_usage": codexUsageJson(last),
    "model_context_window": CODEX_MODEL_CONTEXT_WINDOW,
  };
  // A resumed or re-emitted count repeats the exact info; the readers book it once.
  const repeats = g.adversarial
    ? sampleCount(g.rng, g.profile.codex.repeatsPerUsageKey, state.minCountRepeats)
    : 1;
  for (let i = 0; i < repeats; i++) {
    codexLine(g, session, state, "event_msg/token_count", { extra: { info } });
    if (i === 0) expectCodex(g, session, state.nowMs, state.model, last);
  }
}

/**
 * One turn. A turn before the last stops at its sampled event count or byte share; the LAST
 * turn runs until the session reaches its sampled file size, so file and line sizes both
 * follow the profile and the event count per file emerges, as in the real logs.
 */
function codexTurn(
  g: Generator,
  session: CodexSession,
  state: CodexState,
  firstTurn: boolean,
  lastTurn: boolean,
  targetBytes: number,
): void {
  const profile = g.profile.codex;
  state.turnId = uuid(g.rng);
  if (!firstTurn) {
    codexLine(g, session, state, "event_msg/task_started");
    if (chance(g.rng, 0.15)) {
      state.model = weightedKey(g.rng, modelShares(profile.models));
      codexLine(g, session, state, "event_msg/thread_settings_applied", {
        extra: { threadSettings: { "model": state.model, "effort": "high" } },
      });
    }
    codexLine(g, session, state, "turn_context");
    codexMessage(g, session, state, "user", promptText(g));
    codexLine(g, session, state, "event_msg/user_message", { prefix: promptText(g) });
  }
  const model = profile.models[state.model] ?? Object.values(profile.models)[0]!;
  const events = sampleCount(g.rng, profile.usageEventsPerTurn, 1);
  for (let i = 0; i < MAX_EVENTS_PER_TURN; i++) {
    const reached = session.buffer.bytes >= targetBytes;
    const last = reached || (!lastTurn && i === events - 1) || i === MAX_EVENTS_PER_TURN - 1;
    codexRoundTrip(g, session, state, model, last);
    if (last) break;
  }
  codexLine(g, session, state, "event_msg/task_complete", {
    extra: { durationMs: Math.round(state.nowMs - session.metaMs) },
  });
}

interface CodexSessionOptions {
  forkOf?: CodexSession;
  /** A break of this length before the second turn (a resume), forcing at least two turns. */
  spanMs?: number;
  /** Write every token_count at least twice (a re-emitted count the readers must book once). */
  repeatCounts?: boolean;
  /** Paste this needle into the opening prompt (the fork parent carries "session_meta"). */
  needle?: string;
}

/** Build one Codex session; `forkOf` copies the parent's items first, the way a fork persists. */
function codexSession(
  g: Generator,
  targetBytes: number,
  startMs: number,
  opts: CodexSessionOptions = {},
): CodexSession {
  const profile = g.profile.codex;
  const session: CodexSession = {
    id: uuid(g.rng),
    metaMs: startMs,
    provider: pick(g.rng, ["copilot-env", "openai", "copilot-env", "azure"]),
    buffer: new LineBuffer(),
    forkedFrom: opts.forkOf?.id,
  };
  const share = profile.lineTypeShare;
  const usageRecordShare = (share["token_usage_record"] ?? 0) /
    Math.max(share["event_msg/token_count"] ?? 1, Number.EPSILON);
  const state: CodexState = {
    ordinal: 0,
    nowMs: startMs,
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    turnId: uuid(g.rng),
    model: weightedKey(g.rng, modelShares(profile.models)),
    cwd: `/home/user/projects/${pick(g.rng, WORDS)}-${pick(g.rng, WORDS)}`,
    git: {
      "commit_hash": hex(g.rng, 40),
      "branch": pick(g.rng, BRANCHES),
      "repository_url": `https://example.invalid/${pick(g.rng, WORDS)}/${pick(g.rng, WORDS)}.git`,
    },
    withOrdinal: chance(g.rng, 0.5),
    withUsageRecord: chance(g.rng, Math.min(1, usageRecordShare)),
    minCountRepeats: opts.repeatCounts === true ? 2 : 1,
  };
  codexSessionMeta(g, session, state, true);
  if (opts.forkOf !== undefined) {
    // A fork persists the parent's rollout ITEMS (never a session_meta; filtered on the parsed
    // type, so a prompt that pasted the word is still an item) in one batch under fresh outer
    // timestamps; nested instants stay the parent's. Its totals continue from the prefix.
    const parent = opts.forkOf.buffer;
    const copied = parent.lines.map((line, i) => ({
      parsed: JSON.parse(line) as JsonObject,
      nested: parent.stamps[i]!.nested,
    })).filter(({ parsed }) => parsed.type !== "session_meta");
    let copyMs = state.nowMs;
    const step = FORK_COPY_WINDOW_MS / Math.max(1, copied.length);
    for (const { parsed, nested } of copied) {
      copyMs += step * g.rng();
      parsed.timestamp = isoTimestamp(copyMs);
      session.buffer.push(JSON.stringify(parsed), { outer: copyMs, nested });
      const payload = parsed.payload;
      if (isJsonObject(payload) && payload.type === "token_count" && isJsonObject(payload.info)) {
        const totals = payload.info.total_token_usage;
        if (isJsonObject(totals)) {
          state.totals = {
            input: Number(totals.input_tokens ?? 0),
            output: Number(totals.output_tokens ?? 0),
            cacheRead: Number(totals.cached_input_tokens ?? 0),
            cacheWrite: Number(totals.cache_write_input_tokens ?? 0),
          };
        }
      }
    }
    state.ordinal += copied.length;
    state.nowMs = state.nowMs + READER_FORK_WINDOW_MS + 1_000 + g.rng() * 5_000;
  } else {
    codexLine(g, session, state, "event_msg/task_started");
    for (let i = 0; i < 3; i++) codexMessage(g, session, state, "developer");
    codexMessage(g, session, state, "user");
    codexLine(g, session, state, "world_state");
    codexLine(g, session, state, "turn_context");
    codexMessage(
      g,
      session,
      state,
      "user",
      opts.needle === undefined ? promptText(g) : `${nextMarker(g)} pasted: ${opts.needle}`,
    );
  }
  const turns = sampleCount(g.rng, profile.turnsPerSession, opts.spanMs === undefined ? 1 : 2);
  const perTurn = targetBytes / turns;
  for (let turn = 0; turn < turns; turn++) {
    if (turn > 0) {
      const resumed = opts.spanMs !== undefined && turn === 1
        ? opts.spanMs
        : chance(g.rng, profile.resumeShare / Math.max(1, turns - 1))
        ? RESUME_GAP_MS + g.rng() * 6 * RESUME_GAP_MS
        : 0;
      if (resumed > 0) {
        // Codex appends a fresh session_meta when a session is resumed; the readers
        // honor only the first.
        state.nowMs += resumed;
        codexSessionMeta(g, session, state, false);
      }
    }
    const lastTurn = turn === turns - 1;
    codexTurn(
      g,
      session,
      state,
      turn === 0 && opts.forkOf === undefined,
      lastTurn,
      lastTurn ? targetBytes : session.buffer.bytes + perTurn,
    );
    // A forced span still gets its second turn when the first already filled the file.
    const spanPending = opts.spanMs !== undefined && turn === 0;
    if (session.buffer.bytes >= targetBytes && !spanPending) break;
  }
  return session;
}

function codexRolloutPath(codexHome: string, session: CodexSession, archived: boolean): string {
  const parts = utcParts(session.metaMs);
  const name = `rollout-${parts.date}T${parts.time}-${session.id}.jsonl`;
  return archived
    ? path.join(codexHome, "archived_sessions", `${name}.zst`)
    : path.join(codexHome, "sessions", parts.y, parts.m, parts.d, name);
}

function writeCodexSession(
  g: Generator,
  codexHome: string,
  session: CodexSession,
  opts: { torn?: boolean; archived?: boolean } = {},
): GeneratedFile {
  session.buffer.noteSpan(g);
  let body = session.buffer.body();
  if (opts.torn === true) {
    // A crash mid-write leaves the tail unterminated: half a token_count line and
    // no LF. Its gate word is present, its JSON is not.
    const lines = session.buffer.lines;
    const source = lines.findLast((line) => line.includes('"token_count"')) ??
      lines[lines.length - 1]!;
    body += source.slice(0, Math.max(8, Math.floor(source.length / 2)));
  }
  if (opts.archived === true) {
    const compressed = zstdCompressSync(Buffer.from(body, "utf8"));
    return writeBytes(g, "codex", codexRolloutPath(codexHome, session, true), compressed);
  }
  return writeText(g, "codex", codexRolloutPath(codexHome, session, false), body);
}

/** A deep copy of the Codex expected reports, so a session can be built and then disowned. */
function snapshotCodexExpected(expected: Map<string, ExpectedReport>): Map<string, ExpectedReport> {
  return new Map([...expected].map(([provider, report]) => [provider, copyReport(report)]));
}

function generateCodex(g: Generator, codexHome: string, budget: number): void {
  let index = 0;
  let forkParent: CodexSession | undefined;
  while (g.written < budget - MIN_FILE_BYTES) {
    const scripted = g.adversarial && index < CODEX_SCRIPTED_SESSIONS ? index : -1;
    const drawn = nextFileBytes(g, "codex", budget);
    const bytes = scripted >= 0 ? Math.min(drawn, SCRIPTED_MAX_BYTES) : drawn;
    const start = sessionStart(g, "codex");
    if (scripted === 0) {
      // Resumed 26 hours later, so it crosses local midnight in every zone, with every
      // count re-emitted. The torn tail lands here too, and an archived copy sits beside
      // the live file.
      const session = codexSession(g, bytes, start, {
        spanMs: 26 * 60 * 60 * 1000,
        repeatCounts: true,
      });
      writeCodexSession(g, codexHome, session, { torn: true });
      writeCodexSession(g, codexHome, session, { archived: true });
    } else if (scripted === 1) {
      // The parent a fork will copy: its opening prompt pastes the word "session_meta", so
      // a copy that filtered items by substring instead of by type would lose it.
      forkParent = codexSession(g, bytes, start, { needle: '"session_meta"' });
      writeCodexSession(g, codexHome, forkParent);
    } else if (scripted === 2 && forkParent !== undefined) {
      const fork = codexSession(g, bytes, forkParent.metaMs + 10 * 60 * 1000, {
        forkOf: forkParent,
      });
      writeCodexSession(g, codexHome, fork);
    } else if (scripted === 3) {
      // A fork whose parent was deleted: only the batch-write window tells the
      // copied prefix apart. The ghost's usage is booked nowhere, since no file
      // carries it as its own, so the bookings its build made are rolled back.
      const before = snapshotCodexExpected(g.expected.codex);
      // The ghost is resumed, so its re-emitted session_meta exercises the item filter.
      const ghost = codexSession(g, Math.min(bytes, 64 * 1024), start, {
        spanMs: 2 * RESUME_GAP_MS,
      });
      g.expected.codex = before;
      const fork = codexSession(g, bytes, ghost.metaMs + 30 * 60 * 1000, { forkOf: ghost });
      writeCodexSession(g, codexHome, fork);
    } else if (scripted === 4) {
      // Archived only: the compressed copy is the sole record of this session.
      writeCodexSession(g, codexHome, codexSession(g, bytes, start), { archived: true });
    } else if (
      g.adversarial && forkParent !== undefined && chance(g.rng, g.profile.codex.forkShare)
    ) {
      const fork = codexSession(g, bytes, forkParent.metaMs + 60 * 60 * 1000, {
        forkOf: forkParent,
      });
      writeCodexSession(g, codexHome, fork);
    } else {
      writeCodexSession(g, codexHome, codexSession(g, bytes, start));
    }
    index++;
  }
}

// ----- Claude -----

interface ClaudeSession {
  id: string;
  slug: string;
  buffer: LineBuffer;
  /** Conversation lines (everything but the file header), what a resume copies. */
  body: LineBuffer;
  /** The final streamed line a truncated original never wrote; the resume carries it. */
  pendingFinal?: PendingLine;
  lastUuid: string;
  startMs: number;
  endMs: number;
}

/** A line held back from its file, with the booking it will owe once written. */
interface PendingLine {
  text: string;
  ms: number;
  model: string;
  delta: Usage;
}

interface ClaudeState {
  nowMs: number;
  model: string;
  cwd: string;
  agentId?: string;
  version: string;
  branch: string;
  slugWord: string;
}

interface ClaudeLineOptions extends LineOptions {
  /** Header lines carry no timestamp and do not advance the clock. */
  header?: boolean;
}

function claudeLine(
  g: Generator,
  session: ClaudeSession,
  state: ClaudeState,
  type: string,
  opts: ClaudeLineOptions = {},
): string {
  const template = templates.claude.lines[type];
  if (template === undefined) throw new Error(`no claude template for ${type}`);
  const profile = g.profile.claude;
  if (opts.header !== true) state.nowMs += lineGap(g, "claude");
  const lineUuid = uuid(g.rng);
  const ctx: Record<string, Json> = {
    ...KEEP_FILL,
    ts: isoTimestamp(state.nowMs),
    uuid: lineUuid,
    parentUuid: session.lastUuid === "" ? null : session.lastUuid,
    sessionId: session.id,
    model: state.model,
    cwd: state.cwd,
    slug: state.slugWord,
    version: state.version,
    branch: state.branch,
    isSidechain: state.agentId !== undefined,
    promptId: uuid(g.rng),
    toolUseId: `toolu_${hex(g.rng, 24)}`,
    messageId: `msg_${hex(g.rng, 24)}`,
    text: "",
    ...opts.extra,
  };
  let rendered = render(template, ctx);
  if (isJsonObject(rendered)) {
    if (state.agentId !== undefined && (type === "assistant" || type.startsWith("user"))) {
      const { parentUuid, isSidechain, ...rest } = rendered;
      rendered = {
        parentUuid: parentUuid ?? null,
        isSidechain: isSidechain ?? null,
        agentId: state.agentId,
        ...rest,
      };
    }
    if (opts.reshape !== undefined) rendered = opts.reshape(rendered);
  }
  const target = opts.bytes ??
    sampleQuantile(g.rng, profile.bytesPerLine[type] ?? profile.fileBytes);
  const line = serializeSized(g.rng, rendered, target, opts.kind ?? "prose", opts.prefix ?? "");
  const stamps = lineStamps(template, ctx);
  session.buffer.push(line, stamps);
  if (opts.header !== true) {
    session.body.push(line, stamps);
    session.lastUuid = lineUuid;
  }
  return line;
}

function claudeUsageJson(u: Usage, output: number): Json {
  return {
    "input_tokens": u.input,
    "cache_creation_input_tokens": u.cacheWrite,
    "cache_read_input_tokens": u.cacheRead,
    "output_tokens": output,
    "output_tokens_details": { "reasoning_tokens": Math.floor(output * 0.3) },
    "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 0 },
    "service_tier": "standard",
    "cache_creation": {
      "ephemeral_1h_input_tokens": 0,
      "ephemeral_5m_input_tokens": u.cacheWrite,
    },
    "inference_geo": "us",
    "iterations": [],
    "speed": "standard",
  };
}

/** Book one Claude line's delta the way readClaudeSessions prices it (cache write is cacheCreation). */
function expectClaude(g: Generator, ms: number, model: string, delta: Usage, first: boolean): void {
  book(g.expected.claude, utcDay(ms), model, {
    input: delta.input,
    output: delta.output,
    cacheRead: delta.cacheRead,
    cacheCreation: delta.cacheWrite,
    events: first ? 1 : 0,
  });
}

/**
 * One assistant message: `repeats` lines sharing the id, the snapshot growing toward the
 * final count or repeating it; the ledger books the first snapshot and each positive delta
 * on its line's day. With `truncate` the last line is held in `pendingFinal` for a resume.
 */
function claudeMessage(
  g: Generator,
  session: ClaudeSession,
  state: ClaudeState,
  model: ModelProfile,
  final: boolean,
  truncate: boolean,
): void {
  const profile = g.profile.claude;
  const usage = sampleUsage(g.rng, model);
  // A truncated message needs a line to hold back, so it streams at least two.
  const repeats = sampleCount(g.rng, profile.repeatsPerUsageKey, truncate ? 2 : 1);
  const growing = chance(g.rng, profile.growingSnapshotShare);
  const messageId = `msg_${hex(g.rng, 24)}`;
  let toolUseId = "";
  let booked = 0;
  for (let i = 0; i < repeats; i++) {
    const isLast = i === repeats - 1;
    const block = i === 0 && repeats > 1
      ? "thinking"
      : (isLast && final) || !chance(g.rng, 0.8)
      ? "text"
      : "tool_use";
    const snapshot = growing
      ? Math.max(1, Math.round(usage.output * ((i + 1) / repeats)))
      : usage.output;
    if (block === "tool_use") toolUseId = `toolu_${hex(g.rng, 24)}`;
    // An unescaped needle: a nested object whose key and value spell a reader gate.
    const needle = g.adversarial && chance(g.rng, 0.3);
    const blockCtx: Record<string, Json> = {
      ...KEEP_FILL,
      toolUseId,
      toolName: pick(g.rng, ["Bash", "Read", "Edit", "Grep", "Agent", "Write"]),
      toolInput: needle
        ? { "command": "@fill", "filter": { "type": "assistant", "token_count": 1 } }
        : { "command": "@fill" },
      signature: hex(g.rng, 64),
    };
    const held = truncate && isLast;
    const line = claudeLine(g, session, state, "assistant", {
      extra: {
        messageId,
        content: [render(templates.claude.blocks[block] ?? null, blockCtx)],
        usage: claudeUsageJson(usage, snapshot),
        stopReason: isLast ? (block === "tool_use" ? "tool_use" : "end_turn") : null,
        apiBlockIndex: i,
      },
    });
    const delta: Usage = i === 0
      ? { ...usage, output: snapshot }
      : { input: 0, cacheRead: 0, cacheWrite: 0, output: Math.max(0, snapshot - booked) };
    booked = Math.max(booked, snapshot);
    if (held) {
      session.buffer.pop();
      session.body.pop();
      session.pendingFinal = { text: line, ms: state.nowMs, model: state.model, delta };
      return;
    }
    // An exact repeat adds nothing and the readers skip it outright, touching no day.
    if (i === 0 || delta.output > 0) expectClaude(g, state.nowMs, state.model, delta, i === 0);
    if (block === "tool_use") {
      claudeLine(g, session, state, "user/tool_result", { extra: { toolUseId } });
      if (chance(g.rng, 0.3)) {
        claudeLine(g, session, state, "attachment", {
          extra: {
            attachment: {
              "type": "hook_success",
              "hookName": "PostToolUse:Bash",
              "toolUseID": toolUseId,
              "hookEvent": "PostToolUse",
              "content": "@fill",
              "stdout": "",
              "stderr": "",
              "exitCode": 0,
              "command": "deno lint",
              "durationMs": 120,
            },
          },
        });
      }
    }
  }
}

/** One turn; the last turn fills the session to its sampled file size (see codexTurn). */
function claudeTurn(
  g: Generator,
  session: ClaudeSession,
  state: ClaudeState,
  firstTurn: boolean,
  lastTurn: boolean,
  targetBytes: number,
  truncate: boolean,
): void {
  const profile = g.profile.claude;
  claudeLine(g, session, state, "user/prompt", { prefix: promptText(g) });
  claudeLine(g, session, state, "attachment", {
    extra: { attachment: { "type": "total_tokens_reminder", "text": "@fill" } },
  });
  if (firstTurn) claudeLine(g, session, state, "ai-title", { header: true });
  if (chance(g.rng, 0.3)) claudeLine(g, session, state, "queue-operation", { header: true });
  if (chance(g.rng, 0.1)) state.model = weightedKey(g.rng, modelShares(profile.models));
  const model = profile.models[state.model] ?? Object.values(profile.models)[0]!;
  const events = sampleCount(g.rng, profile.usageEventsPerTurn, 1);
  for (let i = 0; i < MAX_EVENTS_PER_TURN; i++) {
    const reached = session.buffer.bytes >= targetBytes;
    const last = reached || (!lastTurn && i === events - 1) || i === MAX_EVENTS_PER_TURN - 1;
    claudeMessage(g, session, state, model, last, truncate && last);
    if (session.pendingFinal !== undefined) return;
    if (last) break;
  }
  claudeLine(g, session, state, "system/turn_duration", {
    extra: { durationMs: Math.round(state.nowMs - session.startMs) },
  });
}

interface ClaudeSessionOptions {
  resumeOf?: ClaudeSession;
  agentId?: string;
  /** Cut the last message mid-stream, holding its final line for a resume. */
  truncate?: boolean;
}

function claudeSession(
  g: Generator,
  targetBytes: number,
  startMs: number,
  slug: string,
  opts: ClaudeSessionOptions = {},
): ClaudeSession {
  const profile = g.profile.claude;
  // A resume opens an hour or more after the original went quiet, not at a fresh draw.
  if (opts.resumeOf !== undefined) {
    startMs = opts.resumeOf.endMs + RESUME_GAP_MS + g.rng() * 3 * RESUME_GAP_MS;
  }
  const session: ClaudeSession = {
    id: uuid(g.rng),
    slug,
    buffer: new LineBuffer(),
    body: new LineBuffer(),
    lastUuid: "",
    startMs,
    endMs: startMs,
  };
  const state: ClaudeState = {
    nowMs: startMs,
    model: weightedKey(g.rng, modelShares(profile.models)),
    cwd: `/${slug.replace(/^-/, "").replaceAll("-", "/")}`,
    agentId: opts.agentId,
    version: pick(g.rng, ["2.1.0", "2.1.4", "2.2.0"]),
    branch: pick(g.rng, BRANCHES),
    slugWord: `${pick(g.rng, WORDS)}-${pick(g.rng, WORDS)}`,
  };
  if (opts.agentId === undefined) {
    claudeLine(g, session, state, "last-prompt", { header: true, extra: { text: promptText(g) } });
    claudeLine(g, session, state, "mode", { header: true });
    claudeLine(g, session, state, "permission-mode", { header: true });
    if (chance(g.rng, 0.7)) claudeLine(g, session, state, "atis-latch", { header: true });
    claudeLine(g, session, state, "attachment", {
      extra: {
        attachment: {
          "type": "skill_listing",
          "content": "@fill",
          "skillCount": 12,
          "isInitial": true,
          "names": [],
        },
      },
    });
    claudeLine(g, session, state, "file-history-snapshot", { header: true });
  } else {
    claudeLine(g, session, state, "agent-name", { header: true });
  }
  if (opts.resumeOf !== undefined) {
    // A resume carries the earlier file's conversation over byte for byte (the
    // same message ids and snapshots, which the readers book nothing new for),
    // then the final line the original never got to write, then its own turns.
    const copied = opts.resumeOf.body;
    for (const [i, line] of copied.lines.entries()) {
      session.buffer.push(line, copied.stamps[i]!);
      session.body.push(line, copied.stamps[i]!);
    }
    const pending = opts.resumeOf.pendingFinal;
    if (pending !== undefined) {
      session.buffer.push(pending.text, { outer: pending.ms, nested: [] });
      session.body.push(pending.text, { outer: pending.ms, nested: [] });
      if (pending.delta.output > 0) {
        expectClaude(g, pending.ms, pending.model, pending.delta, false);
      }
      opts.resumeOf.pendingFinal = undefined;
    }
    session.lastUuid = opts.resumeOf.lastUuid;
  }
  const turns = sampleCount(g.rng, profile.turnsPerSession, 1);
  const perTurn = targetBytes / turns;
  for (let turn = 0; turn < turns; turn++) {
    if (turn > 0 && chance(g.rng, profile.resumeShare / Math.max(1, turns - 1))) {
      state.nowMs += RESUME_GAP_MS + g.rng() * 6 * RESUME_GAP_MS;
    }
    const lastTurn = turn === turns - 1;
    claudeTurn(
      g,
      session,
      state,
      turn === 0,
      lastTurn,
      lastTurn ? targetBytes : session.buffer.bytes + perTurn,
      opts.truncate === true && lastTurn,
    );
    session.endMs = state.nowMs;
    if (session.buffer.bytes >= targetBytes || session.pendingFinal !== undefined) break;
  }
  return session;
}

/** A project slug directory: an existing one most of the time, else a new synthetic path. */
function claudeSlug(g: Generator, existing: string[]): string {
  if (existing.length > 0 && chance(g.rng, 0.7)) return pick(g.rng, existing);
  const segments = sampleCount(g.rng, g.profile.claude.slugSegments, 2);
  const parts = ["home", "user"];
  while (parts.length < segments) parts.push(pick(g.rng, WORDS));
  const slug = `-${parts.join("-")}`;
  existing.push(slug);
  return slug;
}

function writeClaudeFile(
  g: Generator,
  claudeHome: string,
  slug: string,
  relative: string[],
  buffer: LineBuffer,
): GeneratedFile {
  buffer.noteSpan(g);
  return writeText(
    g,
    "claude",
    path.join(claudeHome, "projects", slug, ...relative),
    buffer.body(),
  );
}

/** A subagent transcript under `parent`'s directory, at the sampled depth (4 or 6 segments). */
function writeClaudeSubagent(
  g: Generator,
  claudeHome: string,
  parent: ClaudeSession,
  bytes: number,
  start: number,
  deep: boolean,
): void {
  const agentId = `a${hex(g.rng, 15)}`;
  const agent = claudeSession(g, bytes, start, parent.slug, { agentId });
  const dir = deep
    ? [parent.id, "subagents", "workflows", `wf_${hex(g.rng, 8)}-${hex(g.rng, 3)}`]
    : [parent.id, "subagents"];
  writeClaudeFile(
    g,
    claudeHome,
    parent.slug,
    [...dir, `agent-${agentId}.jsonl`],
    agent.buffer,
  );
  if (deep) {
    // The workflow journal is a .jsonl the readers must walk and skip harmlessly.
    const journal = new LineBuffer();
    journal.push(
      JSON.stringify({
        "type": "workflow_started",
        "workflowId": dir[3],
        "timestamp": isoTimestamp(start),
      }),
      { outer: start, nested: [] },
    );
    journal.push(
      JSON.stringify({
        "type": "step_completed",
        "workflowId": dir[3],
        "step": 1,
        "timestamp": isoTimestamp(start + 60_000),
      }),
      { outer: start + 60_000, nested: [] },
    );
    writeClaudeFile(g, claudeHome, parent.slug, [...dir, "journal.jsonl"], journal);
  }
}

function generateClaude(g: Generator, claudeHome: string, budget: number): void {
  const profile = g.profile.claude;
  const slugs: string[] = [];
  let index = 0;
  let lastTopLevel: ClaudeSession | undefined;
  while (g.written < budget - MIN_FILE_BYTES) {
    const scripted = g.adversarial && index < CLAUDE_SCRIPTED_SESSIONS ? index : -1;
    const drawn = nextFileBytes(g, "claude", budget);
    const bytes = scripted >= 0 ? Math.min(drawn, SCRIPTED_MAX_BYTES) : drawn;
    const start = sessionStart(g, "claude");
    const slug = claudeSlug(g, slugs);
    if (scripted === 0) {
      // The original of a resume pair, its last message cut mid-stream.
      const original = claudeSession(g, bytes, start, slug, { truncate: true });
      writeClaudeFile(g, claudeHome, slug, [`${original.id}.jsonl`], original.buffer);
      lastTopLevel = original;
    } else if (scripted === 1 && lastTopLevel !== undefined) {
      const resumed = claudeSession(g, bytes, start, lastTopLevel.slug, { resumeOf: lastTopLevel });
      writeClaudeFile(g, claudeHome, resumed.slug, [`${resumed.id}.jsonl`], resumed.buffer);
      lastTopLevel = resumed;
    } else if (scripted === 2 && lastTopLevel !== undefined) {
      writeClaudeSubagent(g, claudeHome, lastTopLevel, bytes, start, true);
    } else {
      const depth = sampleCount(g.rng, profile.directoryDepth, 2);
      if (depth >= 4 && lastTopLevel !== undefined) {
        writeClaudeSubagent(g, claudeHome, lastTopLevel, bytes, start, depth >= 6);
      } else if (g.adversarial && lastTopLevel !== undefined && chance(g.rng, profile.forkShare)) {
        const resumed = claudeSession(g, bytes, start, lastTopLevel.slug, {
          resumeOf: lastTopLevel,
        });
        writeClaudeFile(
          g,
          claudeHome,
          resumed.slug,
          [`${resumed.id}.jsonl`],
          resumed.buffer,
        );
        lastTopLevel = resumed;
      } else {
        const session = claudeSession(g, bytes, start, slug);
        writeClaudeFile(g, claudeHome, slug, [`${session.id}.jsonl`], session.buffer);
        lastTopLevel = session;
      }
    }
    index++;
  }
}

// ----- entry -----

/** RFC 3339 with an explicit zone; a zone-less instant would parse in the host's zone. */
const ZONED_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Generate `.codex/sessions` + `.claude/projects` under `root` (absent or an empty directory),
 * about `mb` MiB split by the profile's byte shares. Point the readers at it with HOME=<root>
 * CODEX_HOME=<root>/.codex CLAUDE_CONFIG_DIR=<root>/.claude COPILOT_API_HOME=<root>/.copilot-env.
 */
export async function generateUsageTree(opts: GenerateOptions): Promise<GeneratedTree> {
  const profile = opts.profile ?? loadProfile();
  const days = opts.days ?? DEFAULT_DAYS;
  if (!Number.isInteger(days) || days <= 0 || days > MAX_DAYS) {
    throw new Error(`days must be an integer from 1 to ${MAX_DAYS}, got ${opts.days}`);
  }
  if (!Number.isFinite(opts.mb) || opts.mb < MIN_MB || opts.mb > MAX_MB) {
    throw new Error(`mb must be a number from ${MIN_MB} to ${MAX_MB}, got ${opts.mb}`);
  }
  if (!Number.isInteger(opts.seed)) throw new Error(`seed must be an integer, got ${opts.seed}`);
  const end = opts.end ?? DEFAULT_END;
  const endMs = Date.parse(end);
  if (!ZONED_INSTANT.test(end) || !Number.isFinite(endMs)) {
    throw new Error(`end must be an RFC 3339 instant with a zone (Z or offset), got ${opts.end}`);
  }
  // Only an absent or EMPTY real directory: old logs beside the new ones would reach the
  // readers while `expected` and the summary describe the new files alone, and a symlink
  // would put the tree somewhere else. Only ENOENT means absent; any other error propagates.
  // Normalized first: `link/` or `link/.` would make lstat follow the link.
  const root = path.resolve(opts.root);
  let claim: "absent" | "empty" | "occupied";
  try {
    const stat = lstatSync(root);
    claim = stat.isDirectory() && readdirSync(root).length === 0 ? "empty" : "occupied";
  } catch (e) {
    if (!(isRecord(e) && e.code === "ENOENT")) throw e;
    claim = "absent";
  }
  if (claim === "occupied") throw new Error("root must be an absent or empty directory");
  const rng = mulberry32(opts.seed);
  const g: Generator = {
    rng,
    profile,
    adversarial: opts.adversarial ?? true,
    markers: Array.from(
      { length: MARKER_COUNT },
      (_, i) => `synthetic-usage-marker-${opts.seed}-${i}`,
    ),
    markerCursor: 0,
    needleCursor: 0,
    files: [],
    written: 0,
    startMs: endMs - days * MILLISECONDS_PER_DAY,
    dayWeights: { codex: {}, claude: {} },
    expected: { codex: new Map(), claude: emptyReport() },
    firstEventMs: Number.POSITIVE_INFINITY,
    lastEventMs: Number.NEGATIVE_INFINITY,
  };
  for (const source of USAGE_SOURCES) {
    for (let day = 0; day < days; day++) {
      g.dayWeights[source][String(day)] = sampleCount(rng, profile[source].sessionsPerDay) + 0.01;
    }
  }
  const total = opts.mb * MEGABYTE;
  const shareSum = profile.codex.bytesShare + profile.claude.bytesShare;
  const codexBudget = shareSum > 0 ? total * (profile.codex.bytesShare / shareSum) : total / 2;
  const codexRoot = path.join(root, ".codex");
  const claudeRoot = path.join(root, ".claude");
  generateCodex(g, codexRoot, codexBudget);
  generateClaude(g, claudeRoot, total);
  mkdirSync(path.join(root, ".copilot-env"), { recursive: true });
  return await Promise.resolve({
    root,
    codexRoot,
    claudeRoot,
    files: g.files,
    markers: g.markers,
    expected: g.expected,
    firstEventMs: g.firstEventMs,
    lastEventMs: g.lastEventMs,
  });
}
