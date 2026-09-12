// The fail-closed scrub: ids pseudonymized in place, every other value judged by its key against
// the vocabulary, transcript paths renamed, and the scrubbed copy of each source tree.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
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
import { isRecord, ROLLOUT_FILE_RE, type Source, walkJsonl } from "./transcripts.ts";

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
      hex += createHash("sha256").update(`${this.salt}\n${attempt}\n${block}\n${value}`).digest(
        "hex",
      );
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
        `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${
          h.slice(20, 32)
        }`;
    } else {
      const m = PREFIXED_ID_RE.exec(value);
      if (m === null) return null;
      const [, prefix, tail] = m as unknown as [string, string, string];
      const sep = value.charAt(prefix.length);
      length = Math.max(tail.length, MIN_PSEUDONYM_TAIL);
      shape = (h) => `${prefix}${sep}${h.slice(0, length)}`;
    }
    let out: string;
    for (let attempt = 0;; attempt++) {
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

/** Fail-closed for strings and numbers: one not listed below is content and becomes its
 *  placeholder. Booleans, null, and the empty string pass through unchanged
 *  (test/usage_corpus.test.ts pins a kept null).
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
    if (!nested && TIMESTAMP_KEYS.has(key) && ISO_TIMESTAMP_RE.test(value)) return value;
    if (!nested && VERSION_KEYS.has(key) && VERSION_RE.test(value)) return value;
    const enumKey = inContainer
      ? key === "type" || key === "name"
      : Object.hasOwn(ENUM_VALUES, key);
    if ((!nested || inContainer) && enumKey && ENUM_VALUES[key]!.has(value)) return value;
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
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    let ordinal = 0;
    for (const [k, v] of Object.entries(value)) {
      const keep = nested ? CONTAINER_STRUCT_KEYS.has(k) : KNOWN_KEYS.has(k);
      let outKey = k;
      if (!keep) {
        state.scrubbed++;
        do outKey = `${PLACEHOLDER}_KEY_${ordinal++}`; while (outKey in value || outKey in out);
      }
      out[outKey] = scrubValue(k, v, ids, state, nested || !keep);
    }
    return out;
  }
  return value;
}

export interface ScrubbedText {
  text: string;
  lines: number;
  usageLines: number;
  scrubbedValues: number;
  /** Distinct `YYYY-MM-DDTHH:MM` minutes the records' own timestamps fall in. */
  minutes: number;
}

/** An assistant record whose message carries a usage object: what the Claude reader prices. */
export const isClaudeUsageLine = (record: unknown): boolean =>
  isRecord(record) && record.type === "assistant" && isRecord(record.message) &&
  isRecord(record.message.usage);

/** A token_count event carrying `last_token_usage`: what the Codex reader prices. */
export const isCodexUsageLine = (record: unknown): boolean =>
  isRecord(record) && record.type === "event_msg" && isRecord(record.payload) &&
  record.payload.type === "token_count" && isRecord(record.payload.info) &&
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
      return JSON.stringify({ "scrubbed_unparseable_line": PLACEHOLDER });
    }
    if (isUsageLine(parsed)) usageLines++;
    if (
      isRecord(parsed) && typeof parsed.timestamp === "string" &&
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

const UUID_SEGMENT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_FILE_RE = /^(agent-[A-Za-z0-9_-]+)\.jsonl$/;

/** The destination-relative path, judged position by position against each source's layout
 *  (Claude `<slug>/<uuid>[/subagents[/workflows/<name>]/agent-<id>.jsonl]`, Codex
 *  `YYYY/MM/DD/rollout-<stamp>-<uuid>.jsonl`): ids pseudonymized in place, other segments renamed. */
function scrubbedRelativePath(
  rel: string,
  source: Source,
  ids: IdMap,
  segmentNames: Map<string, string>,
): string {
  const segments = rel.split(/[\\/]/);
  const rename = (segment: string, index: number): string => {
    let renamed = segmentNames.get(segment);
    if (renamed === undefined) {
      const taken = new Set(segmentNames.values());
      // Never the raw segment itself (a user directory could be named like a placeholder).
      for (let n = segmentNames.size + 1;; n++) {
        renamed = index === 0 && source === "claude" ? `-scrubbed-cwd-${n}` : `scrubbed-${n}`;
        if (renamed !== segment && !taken.has(renamed)) break;
      }
      segmentNames.set(segment, renamed);
    }
    return renamed;
  };
  const last = segments.length - 1;
  return segments.map((segment, index) => {
    if (source === "codex") {
      const dateShape = index === 0 ? /^\d{4}$/ : /^\d{2}$/;
      if (index < 3 && index < last && dateShape.test(segment)) return segment;
      const rollout = index === last && index === 3 ? ROLLOUT_FILE_RE.exec(segment) : null;
      if (rollout !== null) {
        return `rollout-${rollout[1]}-${ids.pseudonym(rollout[2]!) ?? rollout[2]}.jsonl`;
      }
      return rename(segment, index);
    }
    if (index === 0) return rename(segment, index);
    if (index === 1) {
      const file = segment.endsWith(".jsonl") ? segment.slice(0, -".jsonl".length) : segment;
      if (UUID_SEGMENT_RE.test(file)) {
        return `${ids.pseudonym(file)}${segment.endsWith(".jsonl") ? ".jsonl" : ""}`;
      }
      return rename(segment, index);
    }
    if (index === 2 && segment === "subagents" && index < last) return segment;
    if (index === 3 && segment === "workflows" && index < last) return segment;
    // An agent file sits right under subagents/ (index 3) or under a workflow name (index 5).
    const agentPosition = index === last && segments[2] === "subagents" &&
      (index === 3 || (index === 5 && segments[3] === "workflows"));
    const agent = agentPosition ? AGENT_FILE_RE.exec(segment) : null;
    if (agent !== null) return `${ids.pseudonym(agent[1]!) ?? agent[1]}.jsonl`;
    return rename(segment, index);
  }).join("/");
}

export interface SourceSummary {
  files: number;
  lines: number;
  usageLines: number;
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
