// The fail-closed scrub: ids pseudonymized in place, every other value judged by its key against
// the vocabulary, transcript paths renamed, and the scrubbed copy of each source tree.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { must } from "../../../src/utils/assert.ts";
import { isRecord } from "../../../src/utils/json.ts";
import { writeFile } from "./cli.ts";
import {
  CONTAINER_KEYS,
  CONTAINER_STRUCT_KEYS,
  ENUM_VALUES,
  ISO_TIMESTAMP_RE,
  KNOWN_KEYS,
  NUMERIC_KEYS,
  PREFIXED_ID_RE,
  TIMESTAMP_KEYS,
  UUID_RE,
  VERSION_KEYS,
  VERSION_RE,
} from "./scrub_vocabulary.ts";
import { ROLLOUT_FILE_RE, type Source, walkJsonl } from "./transcripts.ts";

/** What every content string becomes; an unknown key becomes `SCRUBBED_KEY_n` from it. */
const PLACEHOLDER = "SCRUBBED";

/** The number every other number becomes. */
const NUMBER_PLACEHOLDER = 0;

/** The key of a value with no owning key: the root record, an array element. */
const NO_KEY = "";

/** Prefixed ids shorter than this get a tail of this length: room for the pseudonym to be unique. */
const MIN_PSEUDONYM_TAIL = 8;

/** Deterministic per-run pseudonyms that keep an id's shape, so linkage survives the scrub. */
export class IdMap {
  private readonly seen = new Map<string, string>();

  private readonly assigned = new Set<string>();

  constructor(private readonly salt: string = randomUUID()) {}

  /** At least `length` hex characters, from as many digest blocks as that takes. */
  private digest(value: string, attempt: number, length: number): string {
    let hex = "";
    for (let block = 0; hex.length < length; block++) {
      hex += createHash("sha256")
        .update(`${this.salt}\n${attempt}\n${block}\n${value}`)
        .digest("hex");
    }
    return hex;
  }

  /** The pseudonym for an id-shaped string, or null when `value` is not one. Never the value
   *  itself and never one already handed out: a clash re-digests deterministically. */
  pseudonym(value: string): string | null {
    const known = this.seen.get(value);
    if (known !== undefined) return known;
    let shape: (hex: string) => string;
    let length: number;
    if (UUID_RE.test(value)) {
      length = 32;
      shape = (h) =>
        `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(
          20,
          32,
        )}`;
    } else {
      const m = PREFIXED_ID_RE.exec(value);
      if (m === null) return null;
      const [, prefix, tail] = m as unknown as [string, string, string];
      const sep = value.charAt(prefix.length);
      length = Math.max(tail.length, MIN_PSEUDONYM_TAIL);
      shape = (h) => `${prefix}${sep}${h.slice(0, length)}`;
    }
    let out: string;
    for (let attempt = 0; ; attempt++) {
      out = shape(this.digest(value, attempt, length));
      if (out !== value && !this.assigned.has(out)) break;
    }
    this.seen.set(value, out);
    this.assigned.add(out);
    return out;
  }
}

interface ScrubState {
  scrubbed: number;
}

/** A string the vocabulary keeps as is: a timestamp or version under one of its keys outside a
 *  container, or one of its key's closed enum values (inside a container, under `type` and
 *  `name` alone). */
function isVocabularyString(
  key: string,
  value: string,
  nested: boolean,
  inContainer: boolean,
): boolean {
  if (!nested && TIMESTAMP_KEYS.has(key) && ISO_TIMESTAMP_RE.test(value)) return true;
  if (!nested && VERSION_KEYS.has(key) && VERSION_RE.test(value)) return true;
  const enumKey = inContainer ? key === "type" || key === "name" : Object.hasOwn(ENUM_VALUES, key);
  const allowed = enumKey ? ENUM_VALUES[key] : undefined;
  return (!nested || inContainer) && allowed !== undefined && allowed.has(value);
}

/** Each member under its own key when the key is known (a container's structural keys inside
 *  one), else under a placeholder key with its value as content. */
function scrubRecord(
  value: Record<string, unknown>,
  ids: IdMap,
  state: ScrubState,
  nested: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let ordinal = 0;
  for (const [k, v] of Object.entries(value)) {
    const keep = nested ? CONTAINER_STRUCT_KEYS.has(k) : KNOWN_KEYS.has(k);
    let outKey = k;
    if (!keep) {
      state.scrubbed++;
      do outKey = `${PLACEHOLDER}_KEY_${ordinal++}`;
      while (outKey in value || outKey in out);
    }
    out[outKey] = scrubValue(k, v, ids, state, nested || !keep);
  }
  return out;
}

/** Fail-closed for strings and numbers: one not listed below is content and becomes its
 *  placeholder. Booleans, null, and the empty string pass through unchanged
 *  (test/usage/usage_corpus.e2e.test.ts pins a kept null).
 *    string  -> a pseudonymized id; a timestamp or version under one of its keys; one of its
 *               key's closed enum values
 *    number  -> only DIRECTLY under a NUMERIC_KEYS key outside a container (an array element
 *               has no owning key)
 *    key     -> KNOWN_KEYS, or CONTAINER_STRUCT_KEYS inside a container; an unknown key's
 *               value is content, container rules inside */
function scrubValue(
  key: string,
  value: unknown,
  ids: IdMap,
  state: ScrubState,
  inContainer: boolean,
): unknown {
  // A scalar directly under a container key is that container's content.
  const nested = inContainer || CONTAINER_KEYS.has(key);
  if (typeof value === "string") {
    if (value === "") return value;
    const pseudonym = ids.pseudonym(value);
    if (pseudonym !== null) return pseudonym;
    if (isVocabularyString(key, value, nested, inContainer)) return value;
    state.scrubbed++;
    return PLACEHOLDER;
  }
  if (typeof value === "number") {
    if (!nested && NUMERIC_KEYS.has(key)) return value;
    state.scrubbed++;
    return NUMBER_PLACEHOLDER;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(NO_KEY, item, ids, state, nested));
  }
  if (isRecord(value)) return scrubRecord(value, ids, state, nested);
  return value;
}

export interface ScrubbedText {
  /** Line for line with the source; an unparseable line becomes one placeholder record. */
  text: string;

  /** Non-empty lines, the unparseable ones included. */
  lines: number;

  /** Lines `isUsageLine` accepted before the scrub: what the readers would price. */
  usageLines: number;

  /** Replaced strings and numbers, renamed keys, and unparseable lines; pseudonyms do not count. */
  scrubbedValues: number;

  /** Distinct `YYYY-MM-DDTHH:MM` minutes the records' own timestamps fall in. */
  minutes: number;
}

/** An assistant record whose message carries a usage object: what the Claude reader prices. */
export const isClaudeUsageLine = (record: unknown): boolean =>
  isRecord(record) &&
  record.type === "assistant" &&
  isRecord(record.message) &&
  isRecord(record.message.usage);

/** A token_count event carrying `last_token_usage`: what the Codex reader prices. */
export const isCodexUsageLine = (record: unknown): boolean =>
  isRecord(record) &&
  record.type === "event_msg" &&
  isRecord(record.payload) &&
  record.payload.type === "token_count" &&
  isRecord(record.payload.info) &&
  isRecord(record.payload.info.last_token_usage);

/** Scrub one JSONL file's text; a line that is not JSON is replaced whole. */
export function scrubJsonl(
  text: string,
  isUsageLine: (record: unknown) => boolean,
  ids: IdMap,
): ScrubbedText {
  const state: ScrubState = { scrubbed: 0 };
  const minutes = new Set<string>();
  let usageLines = 0;
  let count = 0;
  const out = text.split("\n").map((line) => {
    if (line === "") return line;
    count++;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      state.scrubbed++;
      return JSON.stringify({ scrubbed_unparseable_line: PLACEHOLDER });
    }
    if (isUsageLine(parsed)) usageLines++;
    if (
      isRecord(parsed) &&
      typeof parsed.timestamp === "string" &&
      ISO_TIMESTAMP_RE.test(parsed.timestamp)
    ) {
      minutes.add(parsed.timestamp.slice(0, "YYYY-MM-DDTHH:MM".length));
    }
    return JSON.stringify(scrubValue(NO_KEY, parsed, ids, state, false));
  });
  return {
    text: out.join("\n"),
    lines: count,
    usageLines,
    scrubbedValues: state.scrubbed,
    minutes: minutes.size,
  };
}

/** A Claude session id as a whole segment; a Codex rollout's id is ROLLOUT_FILE_RE's to find. */
const UUID_SEGMENT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The group keeps the `agent-` prefix, so the pseudonym replaces the whole stem. */
const AGENT_FILE_RE = /^(agent-[A-Za-z0-9_-]+)\.jsonl$/;

/** The numbered placeholder a renamed path segment gets. */
const SEGMENT_PREFIX = "scrubbed-";

/** The same for a Claude project slug, keeping a cwd slug's leading dash. */
const CWD_SLUG_PREFIX = "-scrubbed-cwd-";

/** `segment`'s placeholder, stable within one source tree, never the raw segment itself (a user
 *  directory could be named like a placeholder). */
function renamedSegment(
  segment: string,
  prefix: string,
  segmentNames: Map<string, string>,
): string {
  const known = segmentNames.get(segment);
  if (known !== undefined) return known;
  const taken = new Set(segmentNames.values());
  for (let n = segmentNames.size + 1; ; n++) {
    const renamed = `${prefix}${n}`;
    if (renamed === segment || taken.has(renamed)) continue;
    segmentNames.set(segment, renamed);
    return renamed;
  }
}

/** One segment of a Codex `YYYY/MM/DD/rollout-<stamp>-<uuid>.jsonl` path: the date directories
 *  kept, the rollout file's id pseudonymized in place, anything else renamed. */
function scrubCodexSegment(
  segment: string,
  index: number,
  last: number,
  ids: IdMap,
  segmentNames: Map<string, string>,
): string {
  const dateShape = index === 0 ? /^\d{4}$/ : /^\d{2}$/;
  if (index < 3 && index < last && dateShape.test(segment)) return segment;
  const rollout = index === last && index === 3 ? ROLLOUT_FILE_RE.exec(segment) : null;
  if (rollout !== null) {
    const id = must(rollout[2], "the id group of ROLLOUT_FILE_RE always participates");
    return `rollout-${rollout[1]}-${ids.pseudonym(id) ?? id}.jsonl`;
  }
  return renamedSegment(segment, SEGMENT_PREFIX, segmentNames);
}

/** The session segment of a Claude path, `<uuid>` or `<uuid>.jsonl`, pseudonymized; null when
 *  it is not uuid-shaped. */
function pseudonymizedSession(segment: string, ids: IdMap): string | null {
  const suffix = segment.endsWith(".jsonl") ? ".jsonl" : "";
  const file = segment.slice(0, segment.length - suffix.length);
  if (!UUID_SEGMENT_RE.test(file)) return null;
  return `${ids.pseudonym(file)}${suffix}`;
}

/** An agent file sits right under subagents/ (index 3) or under a workflow name (index 5). */
function isAgentFilePosition(segments: string[], index: number): boolean {
  if (index !== segments.length - 1 || segments[2] !== "subagents") return false;
  return index === 3 || (index === 5 && segments[3] === "workflows");
}

/** One segment of a Claude `<slug>/<uuid>[/subagents[/workflows/<name>]/agent-<id>.jsonl]`
 *  path: ids pseudonymized in place, the structural names kept, anything else renamed. */
function scrubClaudeSegment(
  segment: string,
  index: number,
  segments: string[],
  ids: IdMap,
  segmentNames: Map<string, string>,
): string {
  const last = segments.length - 1;
  if (index === 0) return renamedSegment(segment, CWD_SLUG_PREFIX, segmentNames);
  if (index === 1) {
    const session = pseudonymizedSession(segment, ids);
    if (session !== null) return session;
    return renamedSegment(segment, SEGMENT_PREFIX, segmentNames);
  }
  if (index === 2 && segment === "subagents" && index < last) return segment;
  if (index === 3 && segment === "workflows" && index < last) return segment;
  const agent = isAgentFilePosition(segments, index) ? AGENT_FILE_RE.exec(segment) : null;
  if (agent !== null) {
    const id = must(agent[1], "the name group of AGENT_FILE_RE always participates");
    return `${ids.pseudonym(id) ?? id}.jsonl`;
  }
  return renamedSegment(segment, SEGMENT_PREFIX, segmentNames);
}

/** The destination-relative path, judged position by position against each source's layout:
 *  ids pseudonymized in place, other segments renamed. */
function scrubbedRelativePath(
  rel: string,
  source: Source,
  ids: IdMap,
  segmentNames: Map<string, string>,
): string {
  const segments = rel.split(/[\\/]/);
  if (source === "codex") {
    const last = segments.length - 1;
    return segments
      .map((segment, index) => scrubCodexSegment(segment, index, last, ids, segmentNames))
      .join("/");
  }
  return segments
    .map((segment, index) => scrubClaudeSegment(segment, index, segments, ids, segmentNames))
    .join("/");
}

export interface SourceSummary {
  /** Every JSONL file walkJsonl found under the source root. */
  files: number;

  /** ScrubbedText.lines summed over the files. */
  lines: number;

  /** ScrubbedText.usageLines summed over the files. */
  usageLines: number;

  /** ScrubbedText.scrubbedValues summed over the files. */
  scrubbedValues: number;

  /** Files whose timestamps fall in two or more distinct minutes. */
  sessionsSpanningMinutes: number;
}

export function copyScrubbed(
  source: Source,
  srcRoot: string,
  destRoot: string,
  isUsageLine: (record: unknown) => boolean,
  ids: IdMap,
): SourceSummary {
  const files: string[] = [];
  walkJsonl(srcRoot, files);
  files.sort();
  const segmentNames = new Map<string, string>();
  const summary: SourceSummary = {
    files: files.length,
    lines: 0,
    usageLines: 0,
    scrubbedValues: 0,
    sessionsSpanningMinutes: 0,
  };
  for (const file of files) {
    const dest = join(
      destRoot,
      scrubbedRelativePath(relative(srcRoot, file), source, ids, segmentNames),
    );
    mkdirSync(dirname(dest), { recursive: true });
    const result = scrubJsonl(readFileSync(file, "utf8"), isUsageLine, ids);
    writeFile(dest, result.text);
    summary.lines += result.lines;
    summary.usageLines += result.usageLines;
    summary.scrubbedValues += result.scrubbedValues;
    if (result.minutes >= 2) summary.sessionsSpanningMinutes++;
  }
  return summary;
}
