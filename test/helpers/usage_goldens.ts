// Golden `agent cost --json` payloads recorded from the pre-index implementation, shared
// by the recorder (scripts/usage_goldens.ts) and the pinning test (test/usage_golden.test.ts)
// so the two agree on the matrix, the paths, the serializer, the digest, and the run.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";
import { runCost } from "../../src/usage/cost.ts";
import { canonicalModelName } from "../../src/usage/pricing.ts";
import type { ModelUsage, ReadonlyUsageReport } from "../../src/usage/usage.ts";
import {
  DEFAULT_DAYS,
  DEFAULT_END,
  type ExpectedReport,
  FIXTURES_DIR,
  type GeneratedTree,
  generateUsageTree,
  type Json,
  LINE_SPLITTING_CODE_POINTS,
  MAX_DAYS,
  MAX_MB,
  MIN_MB,
  render,
  templates,
} from "./usage_fixtures.ts";

/** The last commit before any reader change: the implementation the goldens were recorded from. */
export const PRE_INDEX_COMMIT = "48384eaa9352b90c5d9f80894add828937d042e2";

/** Port 1 is on the fetch spec's bad-port list, so the request fails inside the runtime
 *  before any socket opens: both implementations fall back to the token-only report the
 *  same way, offline, and no pricing cache is ever written. */
export const UNREACHABLE_PRICING_URL = "https://127.0.0.1:1/unreachable";

/** The zone the goldens' per-day buckets are cut in: the generator's synthetic user's own. */
export const GOLDEN_TIME_ZONE = "UTC";

/** The `cost` argv both implementations ran, after the executable and entrypoint. No
 *  `--days`: a window puts `sinceMs`, a function of the clock, into the payload, while
 *  the default all-time window holds every generated day with a constant `null`. */
export const GOLDEN_COST_ARGS: readonly string[] = [
  "cost",
  "--json",
  "--per-day",
  "--pricing-url",
  UNREACHABLE_PRICING_URL,
];

/** An RFC 3339 instant with an explicit zone, the only `end` the generator accepts. */
const ZONED_INSTANT = v.pipe(
  v.string(),
  v.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/),
  v.check((s) => Number.isFinite(Date.parse(s)), "not a parsable instant"),
);

/** Every parameter that determines a generated tree, spelled out so a sidecar is complete
 *  on its own. */
export const GeneratorParamsSchema = v.strictObject({
  mb: v.pipe(v.number(), v.minValue(MIN_MB), v.maxValue(MAX_MB)),
  seed: v.pipe(v.number(), v.integer()),
  adversarial: v.boolean(),
  days: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_DAYS)),
  end: ZONED_INSTANT,
});
export type GeneratorParams = v.InferOutput<typeof GeneratorParamsSchema>;

export function generatorParams(mb: number, seed: number, adversarial: boolean): GeneratorParams {
  return { mb, seed, adversarial, days: DEFAULT_DAYS, end: DEFAULT_END };
}

export interface GoldenCase {
  name: string;
  generator: GeneratorParams;
  /** Plant the line-splitting assistant lines (plantSplitLines) after generating: the old
   *  reader drops the OLD_READER_SPLITS ones, so this golden is expected to differ from the
   *  current output by exactly their usage. */
  split: boolean;
}

/** THE recorded matrix: three adversarial trees and one plain at 20 MiB, where the old and
 *  the current implementation must agree, plus one small plain tree carrying the planted
 *  line-splitting lines, the one known deviation, pinned as a quantified delta. */
export const GOLDEN_MATRIX: readonly GoldenCase[] = [
  { name: "golden-1", generator: generatorParams(20, 1, true), split: false },
  { name: "golden-2", generator: generatorParams(20, 2, true), split: false },
  { name: "golden-3", generator: generatorParams(20, 3, true), split: false },
  { name: "golden-4-plain", generator: generatorParams(20, 4, false), split: false },
  { name: "golden-5-split", generator: generatorParams(2, 5, false), split: true },
];

export interface GoldenFiles {
  goldenPath: string;
  recordingPath: string;
}

export function goldenFilesFor(name: string, dir: string = FIXTURES_DIR): GoldenFiles {
  return {
    goldenPath: path.join(dir, `${name}.json`),
    recordingPath: path.join(dir, `${name}.recording.json`),
  };
}

const SHA256_HEX = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/));
const COMMIT_SHA = v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/));

/** The sidecar beside a golden: how its tree was made and how the old cli was run. */
export const RecordingSchema = v.strictObject({
  generator: GeneratorParamsSchema,
  split: v.boolean(),
  treeSha256: SHA256_HEX,
  oldCommit: COMMIT_SHA,
  args: v.array(v.string()),
  timeZone: v.literal(GOLDEN_TIME_ZONE),
});
export type Recording = v.InferOutput<typeof RecordingSchema>;

export function readRecording(files: GoldenFiles, what: string): Recording {
  const result = v.safeParse(RecordingSchema, JSON.parse(readText(files.recordingPath)));
  if (!result.success) {
    const issue = result.issues[0];
    const where = issue.path?.map((p) => String(p.key)).join(".") ?? "<root>";
    throw new Error(`${what}: invalid recording sidecar at ${where} (${issue.message})`);
  }
  return result.output;
}

/** File text with CRLF folded to LF, so a checkout's line endings never reach a byte compare. */
export function readText(file: string): string {
  return readFileSync(file, "utf8").replaceAll("\r\n", "\n");
}

export interface GoldenTree {
  tree: GeneratedTree;
  /** The planted lines' usage (a split case), or null. */
  delta: PlantedDelta | null;
}

/** The case's tree: generated, then planted when the case says so. The ledger covers the
 *  planted lines too. */
export async function generateGoldenTree(entry: GoldenCase, root: string): Promise<GoldenTree> {
  const tree = await generateUsageTree({ root, ...entry.generator });
  return { tree, delta: entry.split ? plantSplitLines(tree) : null };
}

/** SHA-256 over a tree: sorted root-relative paths with forward slashes, each followed by
 *  the file's raw bytes (the recipe test/usage_fixtures.test.ts pins its fixed corpus with). */
export function treeSha256(tree: GeneratedTree): string {
  const entries = tree.files
    .map((f) => ({ rel: path.relative(tree.root, f.path).replaceAll("\\", "/"), path: f.path }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(`${entry.rel}\n`);
    hash.update(readFileSync(entry.path));
  }
  return hash.digest("hex");
}

// ---------- the planted line-splitting lines ----------

/**
 * The planted code points the OLD reader lost a line to, measured against it: node:readline
 * breaks a line at U+2028 and U+2029, while a U+0085 (NEL) line survives in both readers.
 * The delta a split golden differs by is the usage of exactly these lines.
 */
export const OLD_READER_SPLITS: ReadonlySet<string> = new Set(["\u2028", "\u2029"]);

/** What the old reader missed of plantSplitLines: the canonical model and UTC day the lines
 *  land on, and the summed usage of the OLD_READER_SPLITS lines (one event each). */
export interface PlantedDelta {
  model: string;
  day: string;
  usage: ModelUsage;
}

/** Token counts per planted line, one row per LINE_SPLITTING_CODE_POINTS member; distinct
 *  primes, so a line counted twice or attributed elsewhere is visible in the sum. */
const PLANTED_USAGE: readonly Omit<ModelUsage, "events">[] = [
  { input: 1009, output: 101, cacheRead: 2003, cacheCreation: 31 },
  { input: 1013, output: 103, cacheRead: 2011, cacheCreation: 37 },
  { input: 1019, output: 107, cacheRead: 2017, cacheCreation: 41 },
];

const PLANTED_SESSION_ID = "00000000-0000-4000-a000-000000002028";

/** One assistant line per LINE_SPLITTING_CODE_POINTS member, the code point raw in the text
 *  (JSON.stringify does not escape them), on a day and model the tree already has so the
 *  delta touches only existing rows. */
export function plantSplitLines(tree: GeneratedTree): PlantedDelta {
  const first = tree.files.filter((f) => f.source === "claude")
    .map((f) => f.path).sort()[0];
  if (first === undefined) throw new Error("the tree has no Claude transcript to plant beside");
  const claude = tree.expected.claude;
  // The raw model with the most events (ties by name) and the latest day it was used on.
  const rawModel = [...claude.byModel].sort(([a, ua], [b, ub]) =>
    ub.events - ua.events || a.localeCompare(b)
  )[0]?.[0];
  if (rawModel === undefined) throw new Error("the tree's ledger has no Claude model");
  const day = [...claude.perDay].filter(([, row]) => row.has(rawModel)).map(([d]) => d)
    .sort().at(-1);
  if (day === undefined) throw new Error("the tree's ledger has no Claude day");

  const lines: string[] = [];
  const total: ModelUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, events: 0 };
  for (const [i, cp] of LINE_SPLITTING_CODE_POINTS.entries()) {
    const u = PLANTED_USAGE[i];
    if (u === undefined) throw new Error("PLANTED_USAGE is shorter than the code point list");
    const hex = cp.codePointAt(0)!.toString(16).padStart(4, "0");
    const usageJson: Json = {
      "input_tokens": u.input,
      "cache_creation_input_tokens": u.cacheCreation,
      "cache_read_input_tokens": u.cacheRead,
      "output_tokens": u.output,
    };
    lines.push(JSON.stringify(render(templates.claude.lines.assistant ?? null, {
      parentUuid: null,
      isSidechain: false,
      content: [render(templates.claude.blocks.text ?? null, {
        fill: `planted U+${hex} here:${cp}and the line goes on`,
      })],
      messageId: `msg_planted_${hex}`,
      model: rawModel,
      stopReason: "end_turn",
      usage: usageJson,
      apiBlockIndex: 0,
      uuid: `00000000-0000-4000-a000-00000000${hex}`,
      ts: `${day}T12:00:0${i}.000Z`,
      sessionId: PLANTED_SESSION_ID,
      cwd: "/home/user/projects/planted",
      version: "2.2.0",
      branch: "main",
      slug: "planted-lines",
    })));
    const booked: ModelUsage = { ...u, events: 1 };
    bookLedger(claude, day, rawModel, booked);
    if (OLD_READER_SPLITS.has(cp)) {
      for (const key of Object.keys(total) as (keyof ModelUsage)[]) total[key] += booked[key];
    }
  }
  const file = path.join(path.dirname(first), `${PLANTED_SESSION_ID}.jsonl`);
  const body = `${lines.join("\n")}\n`;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
  tree.files.push({ path: file, source: "claude", bytes: Buffer.byteLength(body) });
  return { model: canonicalModelName(rawModel), day, usage: total };
}

function bookLedger(report: ExpectedReport, day: string, model: string, u: ModelUsage): void {
  addUsage(report.byModel, model, u);
  let row = report.perDay.get(day);
  if (row === undefined) {
    row = new Map();
    report.perDay.set(day, row);
  }
  addUsage(row, model, u);
}

function addUsage(into: Map<string, ModelUsage>, model: string, u: ModelUsage): void {
  const prev = into.get(model) ??
    { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, events: 0 };
  into.set(model, {
    input: prev.input + u.input,
    output: prev.output + u.output,
    cacheRead: prev.cacheRead + u.cacheRead,
    cacheCreation: prev.cacheCreation + u.cacheCreation,
    events: prev.events + u.events,
  });
}

/** The ledger with its raw model ids folded onto the readers' canonical spelling. */
export function canonicalLedger(report: ExpectedReport): ReadonlyUsageReport {
  const fold = (row: Map<string, ModelUsage>): Map<string, ModelUsage> => {
    const out = new Map<string, ModelUsage>();
    for (const [model, u] of row) addUsage(out, canonicalModelName(model), u);
    return out;
  };
  return {
    byModel: fold(report.byModel),
    perDay: new Map([...report.perDay].map(([day, row]) => [day, fold(row)])),
  };
}

/**
 * `payload` (a `cost --json --per-day` payload) with `delta` added to its Claude block: the
 * model's usage row and the day's per-day row, nothing else. Both rows must already exist,
 * which is what makes "differs ONLY by the planted lines" a precise claim.
 */
export function withPlantedDelta(
  payload: Record<string, unknown>,
  delta: PlantedDelta,
): Record<string, unknown> {
  const out = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
  const claude = out.claudeSessions as {
    usageByModel: Record<string, ModelUsage>;
    perDay: {
      day: string;
      requests: number;
      input: number;
      output: number;
      cacheRead: number;
      cacheCreation: number;
      total: number;
    }[];
  };
  const model = claude.usageByModel[delta.model];
  const row = claude.perDay.find((r) => r.day === delta.day);
  if (model === undefined || row === undefined) {
    throw new Error(`the payload has no Claude row for ${delta.model} on ${delta.day}`);
  }
  const u = delta.usage;
  model.input += u.input;
  model.output += u.output;
  model.cacheRead += u.cacheRead;
  model.cacheCreation += u.cacheCreation;
  model.events += u.events;
  row.requests += u.events;
  row.input += u.input;
  row.output += u.output;
  row.cacheRead += u.cacheRead;
  row.cacheCreation += u.cacheCreation;
  row.total += u.input + u.output + u.cacheRead + u.cacheCreation;
  return out;
}

/** What the CURRENT implementation must print for a case, given the golden the OLD one
 *  printed: the same payload, plus the planted delta for a split case. */
export function expectedCurrent(
  golden: Record<string, unknown>,
  generated: GoldenTree,
): Record<string, unknown> {
  return generated.delta === null ? golden : withPlantedDelta(golden, generated.delta);
}

// ---------- serialization and comparison ----------

/** JSON with every object's keys sorted, two-space indented, no trailing newline: the one
 *  form goldens are written in and compared through, so a mismatch diffs line by line. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** The first line where `actual`'s stable form departs from `expected`'s, both sides quoted,
 *  or null when the two serialize identically (deep equality, for JSON values). */
export function describeMismatch(actual: unknown, expected: unknown): string | null {
  const a = stableStringify(actual).split("\n");
  const e = stableStringify(expected).split("\n");
  const n = Math.max(a.length, e.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== e[i]) {
      return `line ${i + 1}: expected ${JSON.stringify(e[i] ?? "<end>")}, got ${
        JSON.stringify(a[i] ?? "<end>")
      }`;
    }
  }
  return null;
}

/** The key the current implementation reserves for run metadata the old one never emitted;
 *  parseCostPayload drops it. */
export const RUNTIME_KEY = "runtime";

/** A `cost --json` stdout as its payload object, the runtime key dropped. */
export function parseCostPayload(stdout: string, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`${what} printed no JSON payload`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${what} printed a JSON payload that is not an object`);
  }
  const payload = parsed as Record<string, unknown>;
  delete payload[RUNTIME_KEY];
  return payload;
}

/** Per-source event totals of a payload (`codex:<provider>` and `claude`): every source must
 *  have read something, or the golden pins nothing about it. */
export function sourceEventCounts(payload: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  const providers = asRecord(asRecord(payload.codexSessions).providers);
  for (const [provider, block] of Object.entries(providers)) {
    out[`codex:${provider}`] = eventsOf(asRecord(block));
  }
  out.claude = eventsOf(asRecord(payload.claudeSessions));
  return out;
}

function eventsOf(block: Record<string, unknown>): number {
  let events = 0;
  for (const usage of Object.values(asRecord(block.usageByModel))) {
    const n = asRecord(usage).events;
    if (typeof n === "number") events += n;
  }
  return events;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// ---------- running the current implementation ----------

/** The env that points every usage reader at a generated tree. HOME and USERPROFILE both,
 *  so the homedir-derived defaults agree on every OS. */
export function usageTreeEnv(root: string): Record<string, string> {
  return {
    HOME: root,
    USERPROFILE: root,
    CODEX_HOME: path.join(root, ".codex"),
    CLAUDE_CONFIG_DIR: path.join(root, ".claude"),
    COPILOT_API_HOME: path.join(root, ".copilot-env"),
  };
}

/** Env keys the in-process run overrides or clears, restored afterwards. */
const RUN_ENV_KEYS = [...Object.keys(usageTreeEnv("")), "COPILOT_ENV_ROOT_HOME", "TZ"] as const;

/** Whether Date's local-day arithmetic can be pinned to UTC here: deno honors a runtime
 *  `TZ` on unix only, so on Windows this asks whether the host already runs in UTC. */
export function utcPinnable(): boolean {
  const saved = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    process.env.TZ = GOLDEN_TIME_ZONE;
    // Two dates half a year apart: a zone on UTC in winter alone (London) must not pass.
    return new Date(Date.UTC(2026, 0, 1)).getTimezoneOffset() === 0 &&
      new Date(Date.UTC(2026, 6, 1)).getTimezoneOffset() === 0;
  } finally {
    process.env.TZ = saved;
  }
}

/** The current implementation's payload over the tree at `root`, run IN PROCESS through
 *  runCost with the readers pointed at the tree by env and the process pinned to UTC
 *  (the caller has checked utcPinnable()). */
export async function runCurrentCostJson(root: string): Promise<Record<string, unknown>> {
  const saved = RUN_ENV_KEYS.map((key) => [key, process.env[key]] as const);
  const savedTz = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const original = console.log;
  const lines: string[] = [];
  try {
    for (const [key, value] of Object.entries(usageTreeEnv(root))) process.env[key] = value;
    delete process.env.COPILOT_ENV_ROOT_HOME;
    process.env.TZ = GOLDEN_TIME_ZONE;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    await runCost({ json: true, perDay: true, pricingUrl: UNREACHABLE_PRICING_URL });
  } finally {
    console.log = original;
    for (const [key, value] of saved) {
      if (key === "TZ") continue;
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    // Restored by name, never deleted: a deleted TZ leaves later assignments ignored.
    process.env.TZ = savedTz;
  }
  return parseCostPayload(lines.join("\n"), "the current implementation");
}
