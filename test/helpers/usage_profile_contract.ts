// The profile contract shared by the profiler (scripts/usage_profile.ts) and the generator
// (usage_fixtures.ts): the strict schema, the closed label sets its record keys may carry, and
// the quantile table both sides speak. Nothing here reads a file or draws a random number.
import * as v from "valibot";
import { isRecord } from "../../src/utils/json.ts";

export type UsageSource = "codex" | "claude";

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
const CODEX_LINE_TYPES: ReadonlySet<string> = new Set([
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
const CLAUDE_LINE_TYPES: ReadonlySet<string> = new Set([
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
const OTHER_MODEL = "other";
const MODEL_ID = /^[a-z0-9][a-z0-9._:/-]{0,63}$/i;

// ---------- profile schema ----------

const nonNegative = v.pipe(v.number(), v.minValue(0));
const share = v.pipe(v.number(), v.minValue(0), v.maxValue(1));

const QuantilesSchema = v.pipe(
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

const ModelProfileSchema = v.strictObject({
  share,
  input: QuantilesSchema,
  output: QuantilesSchema,
  cacheRead: QuantilesSchema,
  cacheWrite: QuantilesSchema,
});
export type ModelProfile = v.InferOutput<typeof ModelProfileSchema>;

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
const SourceProfileSchema = sourceProfileSchema(CODEX_LINE_TYPES);
export type SourceProfile = v.InferOutput<typeof SourceProfileSchema>;

const ProfileSchema = v.strictObject({
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

// ---------- line classification (shared with the profiler) ----------

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
 * From a CLOSED set, ids and digits normalized away and `other.jsonl` for anything else, so a
 * private basename never reaches the profile.
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
