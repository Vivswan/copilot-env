// Measure this machine's Codex and Claude session logs, read-only, into the DISTRIBUTIONS the
// generator (test/helpers/usage_fixtures.ts) samples from: quantile tables, shares and schema
// words only, never text, ids or paths. Invoked as `deno task usage:profile [-- --out FILE]`.
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
import { zstdDecompressSync } from "node:zlib";
import { resolveClaudeHome } from "../src/claude/paths.ts";
import { knownCodexHomes } from "../src/codex/config.ts";
import { isEnoentOrNotdir } from "../src/utils/fs.ts";
import { isRecord } from "../src/utils/json.ts";
import { localDayKey } from "../src/utils/time.ts";
import {
  claudeLineType,
  codexLineType,
  filenameShape,
  modelLabel,
  type ModelProfile,
  mulberry32,
  OTHER_LINE_TYPE,
  parseProfile,
  type Profile,
  PROFILE_PATH,
  quantiles,
  RESUME_GAP_MS,
  type Rng,
  type SourceProfile,
  TORN_LINE_TYPE,
  type UsageSource,
} from "../test/helpers/usage_fixtures.ts";

const RESERVOIR_SIZE = 200_000;
/**
 * What each reader would price, and nothing else: Codex rollouts by their filename
 * pattern (plain or zstd) no deeper than sessions/YYYY/MM/DD, Claude transcripts as any
 * plain .jsonl down to the subagent workflow depth. A file the readers skip must not
 * shape the profile.
 */
const ROLLOUT_FILE = /^rollout-(\d{4})-(\d{2})-(\d{2})T.*\.jsonl(\.zst)?$/;
const CODEX_MAX_DEPTH = 4;
const CLAUDE_FILE = /\.jsonl$/;
const CLAUDE_MAX_DEPTH = 8;
const SYNTHETIC_MODEL = "<synthetic>";

function usage(): string {
  return `Usage: deno task usage:profile [-- --out FILE] [--seed N]

Walks the Codex session roots (sessions/, archived_sessions/ under every known
Codex home) and the Claude transcript root (<claude-home>/projects) read-only
and writes a distributions-only profile to FILE (default: ${PROFILE_PATH}).`;
}

function die(message: string): never {
  console.error(message);
  Deno.exit(1);
}

interface Args {
  out: string;
  seed: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { out: PROFILE_PATH, seed: 1 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      Deno.exit(0);
    }
    const value = argv[i + 1];
    if (arg === "--out" && value !== undefined) {
      args.out = value;
      i++;
    } else if (arg === "--seed" && value !== undefined) {
      args.seed = Number(value);
      if (!Number.isInteger(args.seed)) die(`--seed must be an integer, got '${value}'`);
      i++;
    } else {
      die(`unknown argument '${arg}'\n\n${usage()}`);
    }
  }
  return args;
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
      bytesPerLine[type] = quantiles(this.bytesPerLine.get(type)!.values);
    }
    const models: Record<string, ModelProfile> = {};
    const totalEvents = [...this.models.values()].reduce((sum, m) => sum + m.events, 0);
    for (const name of [...this.models.keys()].sort()) {
      const acc = this.models.get(name)!;
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
    return readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    );
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

// ---------- Codex ----------

/** The readers' fallback window for a fork whose parent is gone (codex_sessions.ts). */
const FORK_PREFIX_WINDOW_MS = 2_000;

/**
 * Profile one rollout, sampling each token_count the way the readers book it.
 * `infoHashesBySession` is the readers' own ledger: every info this file saw is
 * recorded under its session id at the end, and a fork drops the infos found in
 * its declared parent's set (or, with the parent absent, the counts inside the
 * batch-write window). Within the file an exact repeat is a repeat. Every line
 * still counts toward the file's physical statistics.
 */
async function profileCodexFile(
  acc: SourceAccumulator,
  file: string,
  depth: number,
  infoHashesBySession: Map<string, Set<string>>,
): Promise<void> {
  const name = path.basename(file);
  const trace = new FileTrace(acc);
  let model = "unknown";
  let forked = false;
  let sessionId: string | undefined;
  let metaTsMs: number | undefined;
  let parentHashes: Set<string> | undefined;
  const ownHashes = new Set<string>();
  const infoRepeats = new Map<string, number>();
  const rollout = ROLLOUT_FILE.exec(name);
  if (rollout !== null) acc.sessionsPerDay.add(`${rollout[1]}-${rollout[2]}-${rollout[3]}`);
  for await (const raw of lines(file)) {
    if (raw.length === 0) continue;
    const bytes = Buffer.byteLength(raw);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      trace.line(TORN_LINE_TYPE, bytes, undefined);
      continue;
    }
    if (!isRecord(parsed)) {
      trace.line(OTHER_LINE_TYPE, bytes, undefined);
      continue;
    }
    const type = codexLineType(parsed);
    trace.line(type, bytes, timestampMs(parsed));
    const payload = isRecord(parsed.payload) ? parsed.payload : {};
    if (type === "session_meta" && sessionId === undefined) {
      const id = payload.id ?? payload.session_id;
      sessionId = typeof id === "string" ? id : undefined;
      if (typeof payload.forked_from_id === "string") {
        forked = true;
        parentHashes = infoHashesBySession.get(payload.forked_from_id);
      }
      metaTsMs = timestampMs(parsed);
    }
    if (type === "turn_context") {
      trace.turns++;
      if (typeof payload.model === "string" && payload.model !== "") {
        model = modelLabel(payload.model);
      }
    }
    if (type === "event_msg/thread_settings_applied" && isRecord(payload.thread_settings)) {
      const m = payload.thread_settings.model;
      if (typeof m === "string" && m !== "") model = modelLabel(m);
    }
    if (type === "event_msg/token_count" && isRecord(payload.info)) {
      acc.usageLines++;
      const key = JSON.stringify(payload.info);
      const seen = infoRepeats.get(key) ?? 0;
      infoRepeats.set(key, seen + 1);
      if (seen > 0) {
        acc.repeatedLines++;
        continue;
      }
      const ms = timestampMs(parsed);
      const copied = ownHashes.has(key) ||
        parentHashes?.has(key) === true ||
        (forked && parentHashes === undefined && metaTsMs !== undefined && ms !== undefined &&
          ms - metaTsMs <= FORK_PREFIX_WINDOW_MS);
      ownHashes.add(key);
      if (copied) continue;
      const last = payload.info.last_token_usage;
      if (!isRecord(last)) continue;
      trace.usageEvents++;
      acc.usageEvent(
        model,
        num(last.input_tokens),
        num(last.output_tokens),
        num(last.cached_input_tokens),
        num(last.cache_write_input_tokens),
      );
    }
  }
  for (const repeats of infoRepeats.values()) acc.repeatsPerUsageKey.add(repeats);
  if (sessionId !== undefined && ownHashes.size > 0) infoHashesBySession.set(sessionId, ownHashes);
  trace.finish(statSync(file).size, depth, name, forked);
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

/**
 * Profile one transcript. `messages` is the RUN-WIDE per-id ledger: streaming
 * repeats a message id within a file and a resume repeats it across files, so
 * each id's per-bucket maximum and line count are booked once, by the caller,
 * after every file has been seen. An id-less line gets a key unique to its
 * file and position, since the readers count such lines independently.
 */
async function profileClaudeFile(
  acc: SourceAccumulator,
  file: string,
  depth: number,
  messages: Map<string, Snapshot>,
): Promise<void> {
  const name = path.basename(file);
  const trace = new FileTrace(acc);
  const ownIds = new Set<string>();
  let forked = false;
  let prevId: string | undefined;
  let prevOutput = 0;
  for await (const raw of lines(file)) {
    if (raw.length === 0) continue;
    const bytes = Buffer.byteLength(raw);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      trace.line(TORN_LINE_TYPE, bytes, undefined);
      continue;
    }
    if (!isRecord(parsed)) {
      trace.line(OTHER_LINE_TYPE, bytes, undefined);
      continue;
    }
    const type = claudeLineType(parsed);
    const ms = timestampMs(parsed);
    trace.line(type, bytes, ms);
    if (type === "user/prompt") trace.turns++;
    if (type !== "assistant" || !isRecord(parsed.message)) continue;
    const message = parsed.message;
    if (!isRecord(message.usage)) continue;
    if (message.model === SYNTHETIC_MODEL) continue;
    const model = modelLabel(message.model);
    acc.usageLines++;
    const id = typeof message.id === "string" ? message.id : `${file}:${trace.lines}`;
    const output = num(message.usage.output_tokens);
    if (id === prevId) {
      acc.repeatedLines++;
      if (output > prevOutput) acc.grownLines++;
    }
    prevId = id;
    prevOutput = output;
    const prev = messages.get(id);
    if (prev === undefined) {
      trace.usageEvents++;
      ownIds.add(id);
      messages.set(id, {
        model,
        input: num(message.usage.input_tokens),
        output,
        cacheRead: num(message.usage.cache_read_input_tokens),
        cacheWrite: num(message.usage.cache_creation_input_tokens),
        lines: 1,
      });
    } else {
      // Seen first in an EARLIER file: a resume copy. Within this file it is streaming.
      if (!ownIds.has(id)) forked = true;
      prev.lines++;
      prev.input = Math.max(prev.input, num(message.usage.input_tokens));
      prev.output = Math.max(prev.output, output);
      prev.cacheRead = Math.max(prev.cacheRead, num(message.usage.cache_read_input_tokens));
      prev.cacheWrite = Math.max(prev.cacheWrite, num(message.usage.cache_creation_input_tokens));
    }
  }
  if (trace.firstMs !== undefined) acc.sessionsPerDay.add(localDayKey(trace.firstMs));
  trace.finish(statSync(file).size, depth, name, forked);
}

// ---------- main ----------

async function main(): Promise<void> {
  const args = parseArgs(Deno.args);
  const rng = mulberry32(args.seed);
  const accs: Record<UsageSource, SourceAccumulator> = {
    codex: new SourceAccumulator(rng),
    claude: new SourceAccumulator(rng),
  };
  const unreadable: string[] = [];
  const failed: string[] = [];

  const roots = sessionRoots(unreadable);
  const codexFiles: WalkEntry[] = [];
  for (const root of roots.codex) {
    walk(root, 1, ROLLOUT_FILE, CODEX_MAX_DEPTH, codexFiles, unreadable);
  }
  // The readers' file selection: basename order (a fork's parent, the earlier start, comes
  // first) and one file per rollout name, the plain copy preferred over its .zst archive.
  // A file the readers never open shapes nothing here either.
  codexFiles.sort((a, b) => {
    const an = path.basename(a.file);
    const bn = path.basename(b.file);
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const byBasename = new Map<string, WalkEntry>();
  for (const entry of codexFiles) {
    const key = path.basename(entry.file).replace(/\.zst$/, "");
    const prev = byBasename.get(key);
    if (prev === undefined || (prev.file.endsWith(".zst") && !entry.file.endsWith(".zst"))) {
      byBasename.set(key, entry);
    }
  }
  const selected = [...byBasename.values()];
  console.error(`profiling ${selected.length} codex rollout files`);
  const infoHashesBySession = new Map<string, Set<string>>();
  for (const [i, entry] of selected.entries()) {
    if (i % 500 === 0 && i > 0) console.error(`  codex ${i}/${selected.length}`);
    try {
      await profileCodexFile(accs.codex, entry.file, entry.depth, infoHashesBySession);
    } catch {
      failed.push(entry.file);
    }
  }

  const claudeFiles: WalkEntry[] = [];
  for (const root of roots.claude) {
    walk(root, 1, CLAUDE_FILE, CLAUDE_MAX_DEPTH, claudeFiles, unreadable);
    // Project slugs are the DIRECTORIES at the root; a stray file there is not a project.
    const entries = listing(root);
    if (entries === null) unreadable.push(root);
    for (const entry of entries ?? []) {
      if (!entry.isDirectory()) continue;
      accs.claude.slugSegments.push(entry.name.split("-").filter((s) => s.length > 0).length);
    }
  }
  // Files are visited oldest first so a resume's copied ids are seen in the original first.
  claudeFiles.sort((a, b) => {
    const am = statSync(a.file).mtimeMs;
    const bm = statSync(b.file).mtimeMs;
    return am === bm ? a.file.localeCompare(b.file) : am - bm;
  });
  console.error(`profiling ${claudeFiles.length} claude transcript files`);
  const messages = new Map<string, Snapshot>();
  for (const [i, entry] of claudeFiles.entries()) {
    if (i % 500 === 0 && i > 0) console.error(`  claude ${i}/${claudeFiles.length}`);
    try {
      await profileClaudeFile(accs.claude, entry.file, entry.depth, messages);
    } catch {
      failed.push(entry.file);
    }
  }
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

  // Fail closed: a profile over part of the logs would be plausible and wrong. The
  // offending paths go to stderr only (this machine's paths never enter the profile).
  if (unreadable.length > 0 || failed.length > 0) {
    for (const p of unreadable) console.error(`unreadable: ${p}`);
    for (const p of failed) console.error(`failed to parse: ${p}`);
    die(
      `refusing to write ${args.out}: ${unreadable.length} unreadable entries, ${failed.length} unreadable files`,
    );
  }

  const totalBytes = accs.codex.bytes + accs.claude.bytes;
  let profile: Profile;
  try {
    profile = parseProfile({
      version: 1,
      codex: accs.codex.profile(totalBytes),
      claude: accs.claude.profile(totalBytes),
    });
  } catch (e) {
    // Too little to measure (no usage lines at all): a profile the generator could not
    // sample from is refused here rather than written.
    die(`refusing to write ${args.out}: ${e instanceof Error ? e.message : String(e)}`);
  }
  writeFileSync(args.out, `${JSON.stringify(profile, null, 2)}\n`);
  console.error(
    `wrote ${args.out}: codex ${accs.codex.files} files, claude ${accs.claude.files} files`,
  );
}

await main();
