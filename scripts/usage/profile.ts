// Measure this machine's Codex and Claude session logs, read-only, into the DISTRIBUTIONS the
// generator (test/helpers/usage_fixtures.ts) samples from: quantile tables, shares and schema
// words only, never text, ids or paths. Invoked as `bun run usage:profile --out FILE`. Only what
// each reader would price is measured: a file the readers skip never shapes the profile.
//
// The output is personal data (one machine's usage fingerprint), so `--out` is required and
// must point outside the repository: a path inside this checkout is refused before any log is
// read. The committed profile (test/fixtures/usage/profile.json) is hand-authored, never this
// script's output.
import { Buffer } from "node:buffer";
import {
  createReadStream,
  type Dirent,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import { resolveClaudeHome } from "../../src/claude/paths.ts";
import { knownCodexHomes } from "../../src/codex/host.ts";
import { SYNTHETIC_MODEL } from "../../src/usage/claude_sessions.ts";
import { ROLLOUT_FILE } from "../../src/usage/codex_sessions.ts";
import { must } from "../../src/utils/assert.ts";
import { isEnoentOrNotdir } from "../../src/utils/fs.ts";
import { isRecord } from "../../src/utils/json.ts";
import { byCodeUnit } from "../../src/utils/order.ts";
import { localDayKey } from "../../src/utils/time.ts";
import { mulberry32, type Rng } from "../../test/helpers/usage_fixtures.ts";
import {
  claudeLineType,
  codexLineType,
  filenameShape,
  type ModelProfile,
  modelLabel,
  OTHER_LINE_TYPE,
  type Profile,
  parseProfile,
  quantiles,
  RESUME_GAP_MS,
  type SourceProfile,
  TORN_LINE_TYPE,
  type UsageSource,
} from "../../test/helpers/usage_profile_contract.ts";

/** Samples a distribution keeps (Algorithm R past it), so quantiles come from a bounded sample. */
const RESERVOIR_SIZE = 200_000;

/** The Codex reader's own walk depth: rollouts sit at sessions/YYYY/MM/DD, never deeper. */
const CODEX_MAX_DEPTH = 4;

/** The Claude reader takes any plain .jsonl, so the profile does too. */
const CLAUDE_FILE = /\.jsonl$/;

/** The Claude reader's own walk depth, down to the subagent workflow files. */
const CLAUDE_MAX_DEPTH = 8;

/** This checkout, symlinks resolved: the one place the profile must never be written. */
const REPO_ROOT = realpathSync(fileURLToPath(new URL("../..", import.meta.url)));

function usage(): string {
  return `Usage: bun run usage:profile --out FILE [--seed N]

Walks the Codex session roots (sessions/, archived_sessions/ under every known
Codex home) and the Claude transcript root (<claude-home>/projects) read-only
and writes a distributions-only profile to FILE. The profile is personal data
(this machine's usage fingerprint): FILE is required and must lie outside the
repository; a path inside this checkout is refused.`;
}

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

interface Args {
  out: string;
  seed: number;
}

/** `file` resolved against the cwd with the symlinks of its longest existing prefix followed:
 *  a link into the checkout, whether the file itself or a directory above it, names the checkout. */
function realTarget(file: string): string {
  let existing = path.resolve(file);
  const missing: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync(existing), ...missing);
    } catch {
      const parent = path.dirname(existing);
      // A root that cannot be resolved (an absent drive): the lexical path is all there is.
      if (parent === existing) return path.join(existing, ...missing);
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

/** Whether `file` would land inside this checkout, the checkout root itself included. */
function insideRepository(file: string): boolean {
  const rel = path.relative(REPO_ROOT, realTarget(file));
  return rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`));
}

function integerSeed(value: string): number {
  const seed = Number(value);
  if (!Number.isInteger(seed)) die(`--seed must be an integer, got '${value}'`);
  return seed;
}

function parseArgs(argv: string[]): Args {
  let out: string | undefined;
  let seed = 1;
  for (let i = 0; i < argv.length; i += 2) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    const value = argv[i + 1];
    if ((arg !== "--out" && arg !== "--seed") || value === undefined) {
      die(`unknown argument '${arg}'\n\n${usage()}`);
    }
    if (arg === "--out") out = value;
    else seed = integerSeed(value);
  }
  if (out === undefined) die(`--out FILE is required\n\n${usage()}`);
  if (insideRepository(out)) {
    die(
      `refusing to write ${out}: it lies inside the repository checkout (${REPO_ROOT}); the profile is personal data, name a path outside it`,
    );
  }
  return { out, seed };
}

// ---------- accumulators ----------

/** A fixed-size uniform sample of a stream (Algorithm R), seeded so a rerun agrees. */
class Reservoir {
  readonly values: number[] = [];
  private seen = 0;
  constructor(private readonly rng: Rng) {}

  add(value: number): void {
    this.seen++;
    if (this.values.length < RESERVOIR_SIZE) {
      this.values.push(value);
      return;
    }
    const slot = Math.floor(this.rng() * this.seen);
    if (slot < RESERVOIR_SIZE) this.values[slot] = value;
  }
}

class Counter {
  readonly counts = new Map<string, number>();
  total = 0;

  add(key: string, n = 1): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + n);
    this.total += n;
  }

  shares(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const key of [...this.counts.keys()].sort()) {
      out[key] = this.total === 0 ? 0 : (this.counts.get(key) ?? 0) / this.total;
    }
    return out;
  }
}

interface ModelAccumulator {
  events: number;
  input: Reservoir;
  output: Reservoir;
  cacheRead: Reservoir;
  cacheWrite: Reservoir;
}

class SourceAccumulator {
  bytes = 0;
  files = 0;
  readonly fileBytes: number[] = [];
  readonly linesPerFile: number[] = [];
  readonly bytesPerLine = new Map<string, Reservoir>();
  readonly lineTypes = new Counter();
  totalLines = 0;
  usageLines = 0;
  readonly models = new Map<string, ModelAccumulator>();
  readonly sessionsPerDay = new Counter();
  readonly gaps: Reservoir;
  readonly turnsPerSession: number[] = [];
  readonly usageEventsPerTurn: number[] = [];
  readonly repeatsPerUsageKey: Reservoir;
  repeatedLines = 0;
  grownLines = 0;
  forks = 0;
  resumes = 0;
  readonly directoryDepth: number[] = [];
  readonly slugSegments: number[] = [];
  readonly filenameShapes = new Counter();
  crossings = 0;
  timedFiles = 0;

  constructor(readonly rng: Rng) {
    this.gaps = new Reservoir(rng);
    this.repeatsPerUsageKey = new Reservoir(rng);
  }

  lineBytes(type: string, bytes: number): void {
    let reservoir = this.bytesPerLine.get(type);
    if (reservoir === undefined) {
      reservoir = new Reservoir(this.rng);
      this.bytesPerLine.set(type, reservoir);
    }
    reservoir.add(bytes);
    this.lineTypes.add(type);
    this.totalLines++;
  }

  usageEvent(
    model: string,
    input: number,
    output: number,
    cacheRead: number,
    cacheWrite: number,
  ): void {
    let acc = this.models.get(model);
    if (acc === undefined) {
      acc = {
        events: 0,
        input: new Reservoir(this.rng),
        output: new Reservoir(this.rng),
        cacheRead: new Reservoir(this.rng),
        cacheWrite: new Reservoir(this.rng),
      };
      this.models.set(model, acc);
    }
    acc.events++;
    acc.input.add(input);
    acc.output.add(output);
    acc.cacheRead.add(cacheRead);
    acc.cacheWrite.add(cacheWrite);
  }

  profile(totalBytes: number): SourceProfile {
    const bytesPerLine: Record<string, ReturnType<typeof quantiles>> = {};
    for (const type of [...this.bytesPerLine.keys()].sort()) {
      bytesPerLine[type] = quantiles(
        must(this.bytesPerLine.get(type), "type is one of the map's own keys").values,
      );
    }
    const models: Record<string, ModelProfile> = {};
    const totalEvents = [...this.models.values()].reduce((sum, m) => sum + m.events, 0);
    for (const name of [...this.models.keys()].sort()) {
      const acc = must(this.models.get(name), "name is one of the map's own keys");
      models[name] = {
        share: totalEvents === 0 ? 0 : acc.events / totalEvents,
        input: quantiles(acc.input.values),
        output: quantiles(acc.output.values),
        cacheRead: quantiles(acc.cacheRead.values),
        cacheWrite: quantiles(acc.cacheWrite.values),
      };
    }
    const ratio = (n: number, d: number): number => (d === 0 ? 0 : n / d);
    return {
      bytesShare: ratio(this.bytes, totalBytes),
      fileBytes: quantiles(this.fileBytes),
      linesPerFile: quantiles(this.linesPerFile),
      bytesPerLine,
      lineTypeShare: this.lineTypes.shares(),
      usageLineShare: ratio(this.usageLines, this.totalLines),
      models,
      sessionsPerDay: quantiles([...this.sessionsPerDay.counts.values()]),
      gapMs: quantiles(this.gaps.values),
      turnsPerSession: quantiles(this.turnsPerSession),
      usageEventsPerTurn: quantiles(this.usageEventsPerTurn),
      repeatsPerUsageKey: quantiles(this.repeatsPerUsageKey.values),
      growingSnapshotShare: ratio(this.grownLines, this.repeatedLines),
      forkShare: ratio(this.forks, this.files),
      resumeShare: ratio(this.resumes, this.files),
      directoryDepth: quantiles(this.directoryDepth),
      slugSegments: quantiles(this.slugSegments),
      filenameShapes: this.filenameShapes.shares(),
      midnightCrossingShare: ratio(this.crossings, this.timedFiles),
    };
  }
}

// ---------- walking ----------

interface WalkEntry {
  file: string;
  depth: number;
}

/**
 * The session directories to profile. Unlike the readers' discovery, which
 * treats any failed lookup as "no such root", an absent directory (ENOENT /
 * ENOTDIR) is the only tolerated outcome here; every other failure, and an
 * incomplete home sweep, is counted so the profile is refused rather than
 * measured over part of the logs.
 */
function sessionRoots(unreadable: string[]): { codex: string[]; claude: string[] } {
  const codex: string[] = [];
  const homes = knownCodexHomes();
  if (!homes.complete) unreadable.push("codex farm homes (incomplete sweep)");
  const seen = new Set<string>();
  const consider = (out: string[], dir: string): void => {
    let real: string;
    try {
      real = realpathSync(dir);
    } catch (e) {
      if (!isEnoentOrNotdir(e)) unreadable.push(dir);
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    out.push(dir);
  };
  for (const home of homes.homes) {
    for (const sub of ["sessions", "archived_sessions"]) consider(codex, path.join(home, sub));
  }
  const claude: string[] = [];
  consider(claude, path.join(resolveClaudeHome(), "projects"));
  return { codex, claude };
}

/** A directory listing as the readers see it: Dirent entries, sorted by name, or null when
 *  the directory cannot be listed. A symlinked directory is not a directory to a Dirent, so
 *  it is not descended into, exactly as the readers do not. */
function listing(dir: string): Dirent[] | null {
  try {
    return readdirSync(dir, { withFileTypes: true }).sort((a, b) => byCodeUnit(a.name, b.name));
  } catch {
    return null;
  }
}

/**
 * Every log file under `dir`, sorted, with its depth. A directory that cannot
 * be listed is COUNTED in `unreadable` rather than skipped silently: a profile
 * measured over part of the logs would look plausible and be wrong, so the
 * caller refuses to write one.
 */
function walk(
  dir: string,
  depth: number,
  accept: RegExp,
  maxDepth: number,
  out: WalkEntry[],
  unreadable: string[],
): void {
  const entries = listing(dir);
  if (entries === null) {
    unreadable.push(dir);
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < maxDepth) walk(full, depth + 1, accept, maxDepth, out, unreadable);
    } else if (accept.test(entry.name)) {
      out.push({ file: full, depth });
    }
  }
}

/** The complete (LF-terminated) lines of one log file, cut the way the readers do: on LF
 *  alone (node:readline also split on U+2028/U+2029 inside JSON strings and under-counted
 *  exactly the lines the scanner reads), a trailing CR stripped, an unterminated final
 *  fragment withheld; `.jsonl.zst` decompressed whole. */
async function* lines(file: string): AsyncGenerator<string> {
  const chunks = file.endsWith(".zst")
    ? [zstdDecompressSync(readFileSync(file)).toString("utf8")]
    : createReadStream(file, { encoding: "utf8" });
  let rest = "";
  for await (const chunk of chunks) {
    const parts = `${rest}${String(chunk)}`.split("\n");
    rest = parts.pop() ?? "";
    for (const part of parts) yield part.endsWith("\r") ? part.slice(0, -1) : part;
  }
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function timestampMs(line: Record<string, unknown>): number | undefined {
  const ts = typeof line.timestamp === "string" ? Date.parse(line.timestamp) : Number.NaN;
  return Number.isFinite(ts) ? ts : undefined;
}

/** Per-file bookkeeping shared by both sources; the caller feeds it one parsed line at a time. */
class FileTrace {
  lines = 0;
  firstMs?: number;
  lastMs?: number;
  resumed = false;
  turns = 0;
  usageEvents = 0;

  constructor(private readonly acc: SourceAccumulator) {}

  line(type: string, bytes: number, ms: number | undefined): void {
    this.lines++;
    this.acc.lineBytes(type, bytes);
    if (ms === undefined) return;
    if (this.lastMs !== undefined) {
      const gap = ms - this.lastMs;
      if (gap >= 0) this.acc.gaps.add(gap);
      if (gap >= RESUME_GAP_MS) this.resumed = true;
    }
    this.firstMs ??= ms;
    this.lastMs = ms;
  }

  finish(fileBytes: number, depth: number, name: string, forked: boolean): void {
    this.acc.files++;
    this.acc.bytes += fileBytes;
    this.acc.fileBytes.push(fileBytes);
    this.acc.linesPerFile.push(this.lines);
    this.acc.directoryDepth.push(depth);
    this.acc.filenameShapes.add(filenameShape(name));
    if (forked) this.acc.forks++;
    if (this.resumed) this.acc.resumes++;
    const turns = Math.max(1, this.turns);
    this.acc.turnsPerSession.push(turns);
    this.acc.usageEventsPerTurn.push(this.usageEvents / turns);
    if (this.firstMs !== undefined && this.lastMs !== undefined) {
      this.acc.timedFiles++;
      if (localDayKey(this.firstMs) !== localDayKey(this.lastMs)) this.acc.crossings++;
    }
  }
}

/** The record one line holds, or null once a torn or non-object line has been booked. */
function parsedLine(raw: string, bytes: number, trace: FileTrace): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    trace.line(TORN_LINE_TYPE, bytes, undefined);
    return null;
  }
  if (!isRecord(parsed)) {
    trace.line(OTHER_LINE_TYPE, bytes, undefined);
    return null;
  }
  return parsed;
}

// ---------- Codex ----------

/** The readers' fallback window for a fork whose parent is gone (codex_sessions.ts). */
const FORK_PREFIX_WINDOW_MS = 2_000;

/** The model a turn_context or thread_settings_applied line names, else null. */
function lineModel(type: string, payload: Record<string, unknown>): string | null {
  if (type === "turn_context" && typeof payload.model === "string" && payload.model !== "") {
    return modelLabel(payload.model);
  }
  if (type === "event_msg/thread_settings_applied" && isRecord(payload.thread_settings)) {
    const m = payload.thread_settings.model;
    if (typeof m === "string" && m !== "") return modelLabel(m);
  }
  return null;
}

/**
 * One rollout being profiled. `infoHashesBySession` is the readers' own ledger: every info
 * this file saw is recorded under its session id at the end, and a fork drops the infos found
 * in its declared parent's set (or, with the parent absent, the counts inside the batch-write
 * window). Within the file an exact repeat is a repeat. Every line still counts toward the
 * file's physical statistics.
 */
class RolloutProfiler {
  readonly trace: FileTrace;

  private model = "unknown";

  private forked = false;

  private sessionId: string | undefined;

  private metaTsMs: number | undefined;

  private parentHashes: Set<string> | undefined;

  private readonly ownHashes = new Set<string>();

  private readonly infoRepeats = new Map<string, number>();

  constructor(
    private readonly acc: SourceAccumulator,
    private readonly infoHashesBySession: Map<string, Set<string>>,
  ) {
    this.trace = new FileTrace(acc);
  }

  /** Book one parsed line by its type; `ms` is its own timestamp. */
  record(type: string, payload: Record<string, unknown>, ms: number | undefined): void {
    if (type === "session_meta" && this.sessionId === undefined) this.sessionMeta(payload, ms);
    if (type === "turn_context") this.trace.turns++;
    const model = lineModel(type, payload);
    if (model !== null) this.model = model;
    if (type === "event_msg/token_count" && isRecord(payload.info)) {
      this.tokenCount(payload.info, ms);
    }
  }

  private sessionMeta(payload: Record<string, unknown>, ms: number | undefined): void {
    const id = payload.id ?? payload.session_id;
    this.sessionId = typeof id === "string" ? id : undefined;
    if (typeof payload.forked_from_id === "string") {
      this.forked = true;
      this.parentHashes = this.infoHashesBySession.get(payload.forked_from_id);
    }
    this.metaTsMs = ms;
  }

  /** A token_count info the readers would skip: already seen in this file, found in the
   *  declared parent, or (parent absent) inside the fork's batch-write window. */
  private isCopy(key: string, ms: number | undefined): boolean {
    if (this.ownHashes.has(key) || this.parentHashes?.has(key) === true) return true;
    return (
      this.forked &&
      this.parentHashes === undefined &&
      this.metaTsMs !== undefined &&
      ms !== undefined &&
      ms - this.metaTsMs <= FORK_PREFIX_WINDOW_MS
    );
  }

  /** Sample one token_count the way the readers book it: an exact repeat within the file is a
   *  repeat, a copy is skipped, the rest is a usage event under the current model. */
  private tokenCount(info: Record<string, unknown>, ms: number | undefined): void {
    this.acc.usageLines++;
    const key = JSON.stringify(info);
    const seen = this.infoRepeats.get(key) ?? 0;
    this.infoRepeats.set(key, seen + 1);
    if (seen > 0) {
      this.acc.repeatedLines++;
      return;
    }
    const copied = this.isCopy(key, ms);
    this.ownHashes.add(key);
    if (copied) return;
    const last = info.last_token_usage;
    if (!isRecord(last)) return;
    this.trace.usageEvents++;
    this.acc.usageEvent(
      this.model,
      num(last.input_tokens),
      num(last.output_tokens),
      num(last.cached_input_tokens),
      num(last.cache_write_input_tokens),
    );
  }

  finish(fileBytes: number, depth: number, name: string): void {
    for (const repeats of this.infoRepeats.values()) this.acc.repeatsPerUsageKey.add(repeats);
    if (this.sessionId !== undefined && this.ownHashes.size > 0) {
      this.infoHashesBySession.set(this.sessionId, this.ownHashes);
    }
    this.trace.finish(fileBytes, depth, name, this.forked);
  }
}

/** Profile one rollout, sampling each token_count the way the readers book it. */
async function profileCodexFile(
  acc: SourceAccumulator,
  file: string,
  depth: number,
  infoHashesBySession: Map<string, Set<string>>,
): Promise<void> {
  const name = path.basename(file);
  const rollout = new RolloutProfiler(acc, infoHashesBySession);
  const stamp = ROLLOUT_FILE.exec(name);
  if (stamp !== null) acc.sessionsPerDay.add(`${stamp[1]}-${stamp[2]}-${stamp[3]}`);
  for await (const raw of lines(file)) {
    if (raw.length === 0) continue;
    const bytes = Buffer.byteLength(raw);
    const parsed = parsedLine(raw, bytes, rollout.trace);
    if (parsed === null) continue;
    const type = codexLineType(parsed);
    const ms = timestampMs(parsed);
    rollout.trace.line(type, bytes, ms);
    rollout.record(type, isRecord(parsed.payload) ? parsed.payload : {}, ms);
  }
  rollout.finish(statSync(file).size, depth, name);
}

// ---------- Claude ----------

interface Snapshot {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  lines: number;
}

/** An assistant message's usage under its id (an id-less line gets `lineKey`, unique to its
 *  file and position, since the readers count such lines independently); null for a message
 *  without usage or from the synthetic model. */
function assistantUsage(
  message: Record<string, unknown>,
  lineKey: string,
): { id: string; snapshot: Snapshot } | null {
  if (!isRecord(message.usage)) return null;
  if (message.model === SYNTHETIC_MODEL) return null;
  return {
    id: typeof message.id === "string" ? message.id : lineKey,
    snapshot: {
      model: modelLabel(message.model),
      input: num(message.usage.input_tokens),
      output: num(message.usage.output_tokens),
      cacheRead: num(message.usage.cache_read_input_tokens),
      cacheWrite: num(message.usage.cache_creation_input_tokens),
      lines: 1,
    },
  };
}

/** A repeat of a booked id folded in: each bucket at its maximum, one more line. */
function raiseSnapshot(prev: Snapshot, next: Snapshot): void {
  prev.lines++;
  prev.input = Math.max(prev.input, next.input);
  prev.output = Math.max(prev.output, next.output);
  prev.cacheRead = Math.max(prev.cacheRead, next.cacheRead);
  prev.cacheWrite = Math.max(prev.cacheWrite, next.cacheWrite);
}

/**
 * One transcript being profiled. `messages` is the RUN-WIDE per-id ledger: streaming repeats
 * a message id within a file and a resume repeats it across files, so each id's per-bucket
 * maximum and line count are booked once, by the caller, after every file has been seen.
 */
class TranscriptProfiler {
  readonly trace: FileTrace;

  private forked = false;

  private readonly ownIds = new Set<string>();

  private prevId: string | undefined;

  private prevOutput = 0;

  constructor(
    private readonly acc: SourceAccumulator,
    private readonly messages: Map<string, Snapshot>,
  ) {
    this.trace = new FileTrace(acc);
  }

  /** Book one assistant usage line: a repeat of the previous id is a streaming snapshot (grown
   *  when its output rose); a first sighting enters the ledger, a later one raises its entry. */
  usage(id: string, snapshot: Snapshot): void {
    this.acc.usageLines++;
    if (id === this.prevId) {
      this.acc.repeatedLines++;
      if (snapshot.output > this.prevOutput) this.acc.grownLines++;
    }
    this.prevId = id;
    this.prevOutput = snapshot.output;
    const prev = this.messages.get(id);
    if (prev === undefined) {
      this.trace.usageEvents++;
      this.ownIds.add(id);
      this.messages.set(id, snapshot);
      return;
    }
    // Seen first in an EARLIER file: a resume copy. Within this file it is streaming.
    if (!this.ownIds.has(id)) this.forked = true;
    raiseSnapshot(prev, snapshot);
  }

  finish(fileBytes: number, depth: number, name: string): void {
    const { firstMs } = this.trace;
    if (firstMs !== undefined) this.acc.sessionsPerDay.add(localDayKey(firstMs));
    this.trace.finish(fileBytes, depth, name, this.forked);
  }
}

/** Profile one transcript, each assistant usage line into the run-wide ledger. */
async function profileClaudeFile(
  acc: SourceAccumulator,
  file: string,
  depth: number,
  messages: Map<string, Snapshot>,
): Promise<void> {
  const name = path.basename(file);
  const transcript = new TranscriptProfiler(acc, messages);
  for await (const raw of lines(file)) {
    if (raw.length === 0) continue;
    const bytes = Buffer.byteLength(raw);
    const parsed = parsedLine(raw, bytes, transcript.trace);
    if (parsed === null) continue;
    const type = claudeLineType(parsed);
    transcript.trace.line(type, bytes, timestampMs(parsed));
    if (type === "user/prompt") transcript.trace.turns++;
    if (type !== "assistant" || !isRecord(parsed.message)) continue;
    const usage = assistantUsage(parsed.message, `${file}:${transcript.trace.lines}`);
    if (usage !== null) transcript.usage(usage.id, usage.snapshot);
  }
  transcript.finish(statSync(file).size, depth, name);
}

// ---------- main ----------

/** The readers' file selection: basename order (a fork's parent, the earlier start, comes
 *  first) and one file per rollout name, the plain copy preferred over its .zst archive. A file
 *  the readers never open shapes nothing here either. */
function selectedCodexFiles(roots: string[], unreadable: string[]): WalkEntry[] {
  const found: WalkEntry[] = [];
  for (const root of roots) walk(root, 1, ROLLOUT_FILE, CODEX_MAX_DEPTH, found, unreadable);
  found.sort((a, b) => byCodeUnit(path.basename(a.file), path.basename(b.file)));
  const byBasename = new Map<string, WalkEntry>();
  for (const entry of found) {
    const key = path.basename(entry.file).replace(/\.zst$/, "");
    const prev = byBasename.get(key);
    if (prev === undefined || (prev.file.endsWith(".zst") && !entry.file.endsWith(".zst"))) {
      byBasename.set(key, entry);
    }
  }
  return [...byBasename.values()];
}

/** Project slugs are the DIRECTORIES at the root; a stray file there is not a project. */
function bookSlugSegments(root: string, acc: SourceAccumulator, unreadable: string[]): void {
  const entries = listing(root);
  if (entries === null) unreadable.push(root);
  for (const entry of entries ?? []) {
    if (!entry.isDirectory()) continue;
    acc.slugSegments.push(entry.name.split("-").filter((s) => s.length > 0).length);
  }
}

/** The transcript files oldest first, so a resume's copied ids are seen in the original first;
 *  the project slugs at each root are booked on the way. */
function selectedClaudeFiles(
  roots: string[],
  acc: SourceAccumulator,
  unreadable: string[],
): WalkEntry[] {
  const found: WalkEntry[] = [];
  for (const root of roots) {
    walk(root, 1, CLAUDE_FILE, CLAUDE_MAX_DEPTH, found, unreadable);
    bookSlugSegments(root, acc, unreadable);
  }
  found.sort((a, b) => {
    const am = statSync(a.file).mtimeMs;
    const bm = statSync(b.file).mtimeMs;
    return am === bm ? a.file.localeCompare(b.file) : am - bm;
  });
  return found;
}

/** Every entry in order, a progress line every 500; a file that fails to parse is collected,
 *  never skipped silently. */
async function profileEach(
  source: UsageSource,
  entries: WalkEntry[],
  failed: string[],
  profile: (entry: WalkEntry) => Promise<void>,
): Promise<void> {
  for (const [i, entry] of entries.entries()) {
    if (i % 500 === 0 && i > 0) console.error(`  ${source} ${i}/${entries.length}`);
    try {
      await profile(entry);
    } catch {
      failed.push(entry.file);
    }
  }
}

/** Fail closed: a profile over part of the logs would be plausible and wrong. The offending
 *  paths go to stderr only (this machine's paths never enter the profile). */
function refuseIncomplete(out: string, unreadable: string[], failed: string[]): void {
  if (unreadable.length === 0 && failed.length === 0) return;
  for (const p of unreadable) console.error(`unreadable: ${p}`);
  for (const p of failed) console.error(`failed to parse: ${p}`);
  die(
    `refusing to write ${out}: ${unreadable.length} unreadable entries, ${failed.length} unreadable files`,
  );
}

/** The profile written to `out`, or refused when there is too little to measure (no usage lines
 *  at all): one the generator could not sample from is never written. */
function writeProfile(out: string, accs: Record<UsageSource, SourceAccumulator>): void {
  const totalBytes = accs.codex.bytes + accs.claude.bytes;
  let profile: Profile;
  try {
    profile = parseProfile({
      version: 1,
      codex: accs.codex.profile(totalBytes),
      claude: accs.claude.profile(totalBytes),
    });
  } catch (e) {
    die(`refusing to write ${out}: ${e instanceof Error ? e.message : String(e)}`);
  }
  writeFileSync(out, `${JSON.stringify(profile, null, 2)}\n`);
  console.error(`wrote ${out}: codex ${accs.codex.files} files, claude ${accs.claude.files} files`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rng = mulberry32(args.seed);
  const accs: Record<UsageSource, SourceAccumulator> = {
    codex: new SourceAccumulator(rng),
    claude: new SourceAccumulator(rng),
  };
  const unreadable: string[] = [];
  const failed: string[] = [];
  const roots = sessionRoots(unreadable);

  const codexFiles = selectedCodexFiles(roots.codex, unreadable);
  console.error(`profiling ${codexFiles.length} codex rollout files`);
  const infoHashesBySession = new Map<string, Set<string>>();
  await profileEach("codex", codexFiles, failed, (entry) =>
    profileCodexFile(accs.codex, entry.file, entry.depth, infoHashesBySession),
  );

  const claudeFiles = selectedClaudeFiles(roots.claude, accs.claude, unreadable);
  console.error(`profiling ${claudeFiles.length} claude transcript files`);
  const messages = new Map<string, Snapshot>();
  await profileEach("claude", claudeFiles, failed, (entry) =>
    profileClaudeFile(accs.claude, entry.file, entry.depth, messages),
  );
  // One sample per message id at its run-wide maximum, the way the readers price it.
  for (const snapshot of messages.values()) {
    accs.claude.usageEvent(
      snapshot.model,
      snapshot.input,
      snapshot.output,
      snapshot.cacheRead,
      snapshot.cacheWrite,
    );
    accs.claude.repeatsPerUsageKey.add(snapshot.lines);
  }

  refuseIncomplete(args.out, unreadable, failed);
  writeProfile(args.out, accs);
}

await main();
