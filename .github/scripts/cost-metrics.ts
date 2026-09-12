// BEFORE/AFTER `agent cost` for a PR: base and head over one synthetic tree on one runner;
// a head JSON that differs from the base fails the job.
//
// `measure` runs head-controlled code, so it never holds a token; the workflow
// (cost-metrics.yml) posts the comment file it leaves in --out, then `verdict` reads the
// recorded verdict back as the exit status.
//   measure --out <dir> [--base <ref>] [--mb <n>]  -> comment.md + verdict in <dir>
//   verdict --in <dir>                               -> exit 1 when the JSON differs
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** Leads both the comment body and the failure summary, so either is recognizable as this script's. */
const COMMENT_MARKER = "<!-- cost-metrics -->";

/** The hand-off through --out/--in; the workflow reads the comment path from the COMMENT_OUTPUT step output. */
const COMMENT_FILE = "comment.md";
const VERDICT_FILE = "verdict";
const COMMENT_OUTPUT = "comment";

const COST_ARGS = ["-P=cli", "src/cli.ts", "cost", "--json", "--per-day"];

/** The one top-level key that describes the run, not the cost; dropped before the comparison. */
const RUNTIME_KEY = "runtime";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

const NO_INDEX_FLAG = "--no-index";
/** Bounds on the RENDERED diff section of the comment (heading, fence and note included). */
const DIFF_SECTION_LINES = 60;
const DIFF_SECTION_BYTES = 16 * 1024;
/** Bounds on the RENDERED failure summary (marker, heading, fence and note included). */
const FAILURE_SUMMARY_LINES = 200;
const FAILURE_SUMMARY_BYTES = 8 * 1024;
const DEFAULT_TREE_MB = 1024;
const DEFAULT_SEED = 1;
const DEFAULT_FIXTURES_SCRIPT = "scripts/usage_fixtures.ts";
/** A child that outlives this has wedged; `deno ci` and a 1 GB scan both finish well inside. */
const DEFAULT_CHILD_TIMEOUT_MS = 20 * 60 * 1000;

const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));

const SHA = /^[0-9a-f]{7,40}$/;

type Verdict = "match" | "differs";

interface MeasureOptions {
  out: string;
  base: string;
  headSha: string | undefined;
  mb: number;
  seed: number;
  fixturesScript: string;
}

interface VerdictOptions {
  in: string;
}

interface Checkout {
  label: string;
  dir: string;
  /** Whether this checkout's `cost` knows NO_INDEX_FLAG (a base may predate the index). */
  noIndex: boolean;
}

interface Measurement {
  ms: number;
  json: Record<string, unknown>;
  text: string;
}

/** One side's numbers for a window; undefined where the checkout could not produce one. */
export interface SideMetrics {
  coldMs: number;
  warmMs: number;
  noIndexMs: number | undefined;
  /** The warm run's `runtime.index.bytesRead`, when its payload carried it. */
  bytesRead: number | undefined;
}

/** The generator's summary line, validated: only these fields ever reach the comment. */
interface TreeSummary {
  files: number;
  bytes: number;
  /** Inclusive local-day keys (YYYY-MM-DD) of the tree's first and last day. */
  firstDay: string;
  lastDay: string;
}

interface Window {
  label: string;
  args: readonly string[];
}

/**
 * How a window's head payloads relate to the base's; `differs` alone fails the job. The
 * labels are the differing runs, first one first; the diff is that first run against the base.
 */
type Outcome =
  | { kind: "match" }
  | { kind: "transient"; labels: [string, ...string[]] }
  | { kind: "differs"; labels: [string, ...string[]]; diff: string };

export interface WindowResult {
  window: string;
  base: SideMetrics;
  head: SideMetrics;
  outcome: Outcome;
  /** Whether any run's payload carried RUNTIME_KEY (dropped before the comparison). */
  runtimeKeyPresent: boolean;
}

function usage(): never {
  console.error(
    [
      "usage: cost-metrics.ts measure --out <dir> [--base <ref>] [--head-sha <sha>] [--mb <n>]",
      "                               [--seed <n>] [--fixtures <path>]",
      "       cost-metrics.ts verdict --in <dir>",
    ].join("\n"),
  );
  process.exit(2);
}

/** `--name value` pairs; every flag takes a value. */
type Flags = Map<string, string>;

function parseFlags(argv: readonly string[]): Flags {
  const flags: Flags = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === undefined || !arg.startsWith("--") || value === undefined) usage();
    flags.set(arg.slice(2), value);
  }
  return flags;
}

function nonNegativeInt(raw: string, what: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${what} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function setting(flags: Flags, name: string, envName: string): string | undefined {
  const flag = flags.get(name);
  if (flag !== undefined) return flag;
  const env = process.env[envName];
  return env === undefined || env === "" ? undefined : env;
}

function parseMeasureOptions(argv: readonly string[]): MeasureOptions {
  const flags = parseFlags(argv);
  const out = flags.get("out");
  const base = setting(flags, "base", "BASE_SHA");
  if (out === undefined) usage();
  if (base === undefined) throw new Error("the base commit is required: --base <ref> or BASE_SHA");
  const mb = setting(flags, "mb", "COPILOT_ENV_USAGE_FIXTURE_MB");
  const headSha = setting(flags, "head-sha", "HEAD_SHA");
  if (headSha !== undefined && !SHA.test(headSha)) {
    throw new Error(`HEAD_SHA is not a commit sha: ${JSON.stringify(headSha)}`);
  }
  return {
    out: resolve(out),
    base,
    headSha,
    mb: mb === undefined ? DEFAULT_TREE_MB : nonNegativeInt(mb, "the tree size (MB)"),
    seed: nonNegativeInt(flags.get("seed") ?? String(DEFAULT_SEED), "--seed"),
    fixturesScript: setting(flags, "fixtures", "COST_METRICS_FIXTURES_SCRIPT") ??
      DEFAULT_FIXTURES_SCRIPT,
  };
}

function parseVerdictOptions(argv: readonly string[]): VerdictOptions {
  const flags = parseFlags(argv);
  const dir = flags.get("in");
  if (dir === undefined) usage();
  return { in: resolve(dir) };
}

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  /** The child's WHOLE environment; nothing of this process's is inherited. */
  env: Record<string, string>;
  /** Hard kill for a wedged child (default DEFAULT_CHILD_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Kills the child when aborted, on top of the timeout. */
  signal?: AbortSignal;
}

/**
 * Deno.Command with clearEnv, not node:child_process: deno's polyfill MERGES `env` into the
 * parent's. The kill is manual because Deno's own `signal` option only SIGTERMs.
 */
export async function run(
  command: string,
  args: readonly string[],
  opts: RunOptions,
): Promise<RunResult> {
  // Spawn first: a missing executable throws here, synchronously, with nothing yet to clean up.
  const child = new Deno.Command(command, {
    args: [...args],
    cwd: opts.cwd ?? REPO_ROOT,
    env: opts.env,
    clearEnv: true,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CHILD_TIMEOUT_MS;
  const timeout = new AbortController();
  const timer = setTimeout(
    () => timeout.abort(new Error(`timed out after ${timeoutMs} ms`)),
    timeoutMs,
  );
  const signal = opts.signal === undefined
    ? timeout.signal
    : AbortSignal.any([timeout.signal, opts.signal]);
  const kill = (): void => {
    try {
      child.kill("SIGKILL");
    } catch {
      // already exited
    }
  };
  if (signal.aborted) kill();
  else signal.addEventListener("abort", kill, { once: true });
  let output: Deno.CommandOutput;
  try {
    output = await child.output();
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", kill);
  }
  if (signal.aborted) {
    throw new Error(`${command} ${args.join(" ")} was killed: ${String(signal.reason)}`);
  }
  const decoder = new TextDecoder();
  return {
    status: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  };
}

async function mustRun(
  command: string,
  args: readonly string[],
  opts: RunOptions,
): Promise<RunResult> {
  const result = await run(command, args, opts);
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.status}\n${result.stderr.trimEnd()}`,
    );
  }
  return result;
}

const PASSTHROUGH_ENV = ["PATH", "TZ", "LANG", "LC_ALL"] as const;

export function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASSTHROUGH_ENV) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...extra };
}

/** The environment for the setup commands (git, deno ci, deno info): the runner's own homes. */
function setupEnv(): Record<string, string> {
  const extra: Record<string, string> = { DENO_NO_UPDATE_CHECK: "1" };
  for (const name of ["HOME", "DENO_DIR"]) {
    const value = process.env[name];
    if (value !== undefined) extra[name] = value;
  }
  return childEnv(extra);
}

function git(args: readonly string[]): Promise<RunResult> {
  return mustRun("git", ["-C", REPO_ROOT, ...args], { env: setupEnv() });
}

/** Resolve `ref` to a full commit sha, fetching it when a shallow checkout lacks it. */
async function resolveCommit(ref: string): Promise<string> {
  const local = await run(
    "git",
    ["-C", REPO_ROOT, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    { env: setupEnv() },
  );
  if (local.status === 0) return local.stdout.trim();
  await git(["fetch", "--no-tags", "--depth=1", "origin", ref]);
  return (await git(["rev-parse", "--verify", `${ref}^{commit}`])).stdout.trim();
}

function shortSha(sha: string): string {
  if (!SHA.test(sha)) throw new Error(`not a commit sha: ${JSON.stringify(sha)}`);
  return sha.slice(0, 7);
}

/** The deno cache dir, pinned explicitly because the measured runs get a fresh HOME. */
async function denoDir(): Promise<string> {
  const result = await mustRun("deno", ["info", "--json"], { env: setupEnv() });
  const info: unknown = JSON.parse(result.stdout);
  if (
    typeof info !== "object" || info === null || !("denoDir" in info) ||
    typeof info.denoDir !== "string"
  ) {
    throw new Error("deno info --json did not report denoDir");
  }
  return info.denoDir;
}

/** `deno run` pinned to a checkout's own deno.json: deno otherwise looks for the config from
 *  the SCRIPT's directory, so a fixtures script outside the checkout would find none. */
function denoRun(checkoutDir: string): string[] {
  return ["run", "--config", join(checkoutDir, "deno.json")];
}

function treeEnv(treeHome: string, copilotEnvHome: string, cache: string): Record<string, string> {
  return childEnv({
    HOME: treeHome,
    CODEX_HOME: join(treeHome, ".codex"),
    CLAUDE_CONFIG_DIR: join(treeHome, ".claude"),
    COPILOT_API_HOME: copilotEnvHome,
    DENO_DIR: cache,
    DENO_NO_UPDATE_CHECK: "1",
  });
}

const LOCAL_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The local-midnight timestamp of an inclusive local-day key; a day that does not exist
 *  (2026-02-30) is rejected rather than rolled over into the next month. */
function localMidnightMs(day: string, what: string): number {
  const match = LOCAL_DAY.exec(day);
  const [, y, m, d] = match ?? [];
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  // Years 0..99 would otherwise be read as 1900..1999.
  if (y !== undefined) date.setFullYear(Number(y));
  const valid = match !== null &&
    date.getFullYear() === Number(y) && date.getMonth() === Number(m) - 1 &&
    date.getDate() === Number(d);
  if (!valid) throw new Error(`${what} is not a calendar YYYY-MM-DD day: ${JSON.stringify(day)}`);
  return date.getTime();
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseTreeSummary(line: string): TreeSummary {
  const what = "fixtures summary";
  const parsed = record(line === "" ? undefined : JSON.parse(line));
  if (parsed === undefined) throw new Error(`${what}: the last output line is not a JSON object`);
  const int = (key: string): number => {
    const value = parsed[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new Error(`${what}: ${JSON.stringify(key)} is not a non-negative integer`);
    }
    return value;
  };
  const day = (key: string): string => {
    const value = parsed[key];
    if (typeof value !== "string") {
      throw new Error(`${what}: missing string ${JSON.stringify(key)}`);
    }
    localMidnightMs(value, `${what} ${key}`);
    return value;
  };
  return {
    files: int("files"),
    bytes: int("bytes"),
    firstDay: day("firstDay"),
    lastDay: day("lastDay"),
  };
}

async function generateTree(opts: MeasureOptions, treeHome: string): Promise<TreeSummary> {
  const script = resolve(REPO_ROOT, opts.fixturesScript);
  if (!existsSync(script)) throw new Error(`fixtures script not found: ${script}`);
  const result = await mustRun("deno", [
    ...denoRun(REPO_ROOT),
    "-P=test",
    script,
    "--out",
    treeHome,
    "--mb",
    String(opts.mb),
    "--seed",
    String(opts.seed),
  ], { env: setupEnv() });
  const lines = result.stdout.trim().split("\n");
  return parseTreeSummary(lines[lines.length - 1] ?? "");
}

/**
 * The window that always covers the whole tree: whole local days from the tree's first
 * day through `todayMs` (a local midnight), plus one. `cost --days N` counts N local calendar
 * days ending today, so N = (today - firstDay in days) + 1 reaches back to firstDay; the extra
 * day is slack for a run crossing midnight.
 */
function wholeTreeWindow(summary: TreeSummary, todayMs: number): Window {
  const first = localMidnightMs(summary.firstDay, "fixtures summary firstDay");
  const last = localMidnightMs(summary.lastDay, "fixtures summary lastDay");
  if (first > todayMs) throw new Error(`the tree starts in the future (${summary.firstDay})`);
  if (last < first) {
    throw new Error(`the tree ends before it starts (${summary.firstDay}..${summary.lastDay})`);
  }
  const spanDays = Math.round((last - first) / MILLISECONDS_PER_DAY) + 1;
  const windowDays = Math.round((todayMs - first) / MILLISECONDS_PER_DAY) + 2;
  return {
    label: `whole tree (${spanDays} days, ${windowDays}-day window)`,
    args: ["--days", String(windowDays)],
  };
}

function localTodayMs(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/** Every entry under `root` (symlinks not followed), sorted by relative path. */
function treeEntries(root: string): { rel: string; path: string }[] {
  const entries: { rel: string; path: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      entries.push({ rel: relative(root, path), path });
      if (entry.isDirectory()) walk(path);
    }
  };
  walk(root);
  return entries.sort((a, b) => a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
}

/** Read-only tree while it is measured: a cost run must not write the sessions it reads. */
function sealTree(root: string): void {
  for (const { path } of treeEntries(root)) {
    const stat = lstatSync(path);
    if (stat.isDirectory()) chmodSync(path, 0o555);
    else if (stat.isFile()) chmodSync(path, 0o444);
  }
  chmodSync(root, 0o555);
}

/** Directories writable again so the scratch dir can be removed. */
function unsealTree(root: string): void {
  chmodSync(root, 0o755);
  for (const { path } of treeEntries(root)) {
    if (lstatSync(path).isDirectory()) chmodSync(path, 0o755);
  }
}

function treeDigest(root: string): string {
  const hash = createHash("sha256");
  for (const { rel, path } of treeEntries(root)) {
    const stat = lstatSync(path);
    const kind = stat.isDirectory() ? "dir" : stat.isSymbolicLink() ? "link" : "file";
    hash.update(`${rel}\0${kind}\0`);
    if (kind === "file") hash.update(readFileSync(path));
    if (kind === "link") hash.update(readlinkSync(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Whether the checkout's `cost` command knows NO_INDEX_FLAG; a failing --help is an error. */
async function supportsNoIndex(dir: string, env: Record<string, string>): Promise<boolean> {
  const help = await mustRun("deno", [...denoRun(dir), "-P=cli", "src/cli.ts", "cost", "--help"], {
    cwd: dir,
    env,
  });
  return help.stdout.includes(NO_INDEX_FLAG);
}

/** Recursively key-sorted copy, so two payloads with the same content stringify identically. */
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  const rec = record(value);
  if (rec !== undefined) {
    return Object.fromEntries(Object.keys(rec).sort().map((key) => [key, canonical(rec[key])]));
  }
  return value;
}

export function comparable(json: Record<string, unknown>): string {
  const { [RUNTIME_KEY]: _runtime, ...kept } = json;
  return `${JSON.stringify(canonical(kept), null, 2)}\n`;
}

async function measure(
  checkout: Checkout,
  args: readonly string[],
  env: Record<string, string>,
): Promise<Measurement> {
  const started = performance.now();
  const result = await mustRun("deno", [...denoRun(checkout.dir), ...COST_ARGS, ...args], {
    cwd: checkout.dir,
    env,
  });
  const ms = Math.round(performance.now() - started);
  if (result.stdout.trim() === "") {
    throw new Error(`${checkout.label}: cost --json printed nothing\n${result.stderr.trimEnd()}`);
  }
  const json = record(JSON.parse(result.stdout));
  if (json === undefined) throw new Error(`${checkout.label}: cost --json did not print an object`);
  return { ms, json, text: comparable(json) };
}

export function bytesRead(json: Record<string, unknown>): number | undefined {
  const value = record(record(json[RUNTIME_KEY])?.index)?.bytesRead;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function activeDays(section: unknown): number {
  const value = record(section)?.activeDays;
  return typeof value === "number" ? value : 0;
}

function totalUsd(section: unknown): number {
  const value = record(section)?.totalUsd;
  return typeof value === "number" ? value : 0;
}

/**
 * A base payload with no session usage inside the window, or none of it priced, would make
 * every match vacuous: the first leaves nothing to compare, the second compares only zeros.
 */
function assertWindowHasUsage(window: string, json: Record<string, unknown>): void {
  const sources = [
    json.claudeSessions,
    ...Object.values(record(record(json.codexSessions)?.providers) ?? {}),
  ];
  if (sources.reduce((sum: number, source) => sum + activeDays(source), 0) === 0) {
    throw new Error(
      `${window}: the synthetic tree has no Codex or Claude usage inside the window, ` +
        "so a base/head match would prove nothing",
    );
  }
  if (!(sources.reduce((sum: number, source) => sum + totalUsd(source), 0) > 0)) {
    throw new Error(
      `${window}: the base priced nothing (pricing unavailable?), so a base/head match ` +
        "would prove nothing about cost",
    );
  }
}

const UTF8 = new TextEncoder();
const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true });

function byteLength(text: string): number {
  return UTF8.encode(text).length;
}

/** At most `max` leading bytes of `bytes`, backed off to a UTF-8 character boundary. */
function cutBytes(bytes: Uint8Array, max: number): Uint8Array {
  let cut = bytes.subarray(0, Math.max(0, max));
  for (;;) {
    try {
      UTF8_STRICT.decode(cut);
      return cut;
    } catch {
      cut = cut.subarray(0, cut.length - 1);
    }
  }
}

function lineCount(text: string): number {
  return text === "" ? 0 : text.split("\n").length;
}

/**
 * `text` cut to at most `maxLines` lines and `maxBytes` bytes OF OUTPUT: the note naming what
 * was dropped is part of the budget, so the result never exceeds either bound. A budget of
 * zero lines or bytes yields the empty string.
 */
function boundExcerpt(text: string, maxLines: number, maxBytes: number): string {
  if (maxLines <= 0 || maxBytes <= 0) return "";
  const lines = text.replace(/\n$/, "").split("\n");
  const kept = lines.length > maxLines ? lines.slice(0, Math.max(0, maxLines - 1)) : lines;
  const droppedLines = lines.length - kept.length;
  const full = UTF8.encode(kept.join("\n"));
  let body: Uint8Array = full;
  const render = (): string => {
    const droppedBytes = full.length - body.length;
    const parts: string[] = [];
    if (droppedLines > 0) parts.push(`${droppedLines} more lines`);
    if (droppedBytes > 0) parts.push(`${droppedBytes} more bytes`);
    const bodyText = UTF8_STRICT.decode(body);
    if (parts.length === 0) return bodyText;
    const note = `... ${parts.join(", ")}`;
    return bodyText === "" ? note : `${bodyText}\n${note}`;
  };
  let out = render();
  while (byteLength(out) > maxBytes && body.length > 0) {
    const over = byteLength(out) - maxBytes;
    body = cutBytes(body, body.length - over);
    // The byte cut adds the note line, so the body may keep one line fewer.
    const bodyLines = UTF8_STRICT.decode(body).split("\n");
    if (bodyLines.length > maxLines - 1) {
      body = UTF8.encode(bodyLines.slice(0, Math.max(0, maxLines - 1)).join("\n"));
    }
    out = render();
  }
  if (byteLength(out) > maxBytes) out = UTF8_STRICT.decode(cutBytes(UTF8.encode(out), maxBytes));
  return out;
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return longest;
}

/** `text` in a fenced block whose fence no backtick run inside can close; `info` is the
 *  fence's info string and must be a plain word (a backtick or newline there would break the
 *  fence or the line count). */
export function fenced(text: string, info = ""): string {
  if (!/^[A-Za-z0-9_-]*$/.test(info)) {
    throw new RangeError(`fence info must be a plain word, got ${JSON.stringify(info)}`);
  }
  const fence = "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
  return `${fence}${info}\n${text}\n${fence}`;
}

/** The smallest block: two fence lines around one (possibly empty) body line. */
const BLOCK_MIN_LINES = 3;

/**
 * A fenced block of `text` whose RENDERED form fits `maxLines` lines and `maxBytes` bytes.
 * A budget too small for even an empty block is a caller bug and throws.
 */
function boundedBlock(
  text: string,
  info: string,
  maxLines: number,
  maxBytes: number,
): string {
  const minOverhead = 3 + byteLength(info) + 1 + 1 + 3;
  if (maxLines < BLOCK_MIN_LINES || maxBytes < minOverhead) {
    throw new RangeError(
      `a fenced block needs at least ${BLOCK_MIN_LINES} lines and ${minOverhead} bytes, ` +
        `got ${maxLines} and ${maxBytes}`,
    );
  }
  // The fence depends on the body's longest backtick run, and the body on the budget the
  // fence leaves: shrink the body budget by each overshoot until the block fits. An empty
  // body has the minimal fence, so the loop ends within the budget.
  let budget = maxBytes - minOverhead;
  for (;;) {
    const block = fenced(boundExcerpt(text, maxLines - 2, budget), info);
    const over = byteLength(block) - maxBytes;
    if (over <= 0) return block;
    budget -= over;
  }
}

function failureSummary(message: string): string {
  const header = `${COMMENT_MARKER}\n## Cost metrics: measurement failed\n\n`;
  const block = boundedBlock(
    message,
    "",
    FAILURE_SUMMARY_LINES - lineCount(header),
    FAILURE_SUMMARY_BYTES - byteLength(header) - 1,
  );
  return `${header}${block}\n`;
}

/** Room for the diff section's one heading line; anything longer is cut, never spilled. */
const DIFF_HEADING_BYTES = 256;

function oneLine(text: string, maxBytes: number): string {
  return UTF8_STRICT.decode(cutBytes(UTF8.encode(text.replaceAll("\n", " ")), maxBytes));
}

function diffSection(window: string, label: string, diff: string): string {
  const heading = oneLine(`### ${window}: ${label} vs base (excerpt)`, DIFF_HEADING_BYTES);
  const header = `\n${heading}\n\n`;
  const block = boundedBlock(
    diff,
    "diff",
    DIFF_SECTION_LINES - lineCount(header),
    DIFF_SECTION_BYTES - byteLength(header),
  );
  return `${header}${block}`;
}

/** Bounded later, at render. */
async function unifiedDiff(scratch: string, baseText: string, headText: string): Promise<string> {
  writeFileSync(join(scratch, "base.json"), baseText);
  writeFileSync(join(scratch, "head.json"), headText);
  // --no-index compares two paths outside any repo; exit 1 is "they differ".
  // Relative names from the scratch dir keep the temp path out of the header.
  const result = await run("git", [
    "diff",
    "--no-index",
    "--no-color",
    "--unified=3",
    "--",
    "base.json",
    "head.json",
  ], { cwd: scratch, env: setupEnv() });
  if (result.status > 1) throw new Error(`git diff exited ${result.status}\n${result.stderr}`);
  return result.stdout;
}

interface Bench {
  base: Checkout;
  head: Checkout;
  treeHome: string;
  cache: string;
  scratch: string;
  /** A copilot-env home nobody has used yet: cold by construction. */
  freshHome: (name: string) => string;
}

export interface Payload {
  label: string;
  text: string;
}

/**
 * A head/base difference is confirmed against a SECOND base run: live pricing and the local
 * day boundary can move between runs, and only a difference that survives an unchanged base
 * is the code's.
 */
export async function classifyPayloads(
  baseText: string,
  heads: readonly Payload[],
  recheck: () => Promise<string>,
  diff: (headText: string) => Promise<string>,
): Promise<{ outcome: Outcome; rechecked: boolean }> {
  const [first, ...rest] = heads.filter(({ text }) => text !== baseText);
  if (first === undefined) return { outcome: { kind: "match" }, rechecked: false };
  const labels: [string, ...string[]] = [first.label, ...rest.map(({ label }) => label)];
  const recheckText = await recheck();
  if (recheckText === baseText) {
    return { outcome: { kind: "differs", labels, diff: await diff(first.text) }, rechecked: true };
  }
  if ([first, ...rest].every(({ text }) => text === recheckText)) {
    return { outcome: { kind: "transient", labels }, rechecked: true };
  }
  throw new Error(
    "the base payload changed between two runs and the head matches neither; the inputs " +
      "are unstable (pricing or the day boundary moved), re-run the job",
  );
}

interface SideRuns {
  cold: Measurement;
  warm: Measurement;
  noIndex: Measurement | undefined;
}

/**
 * One home for the whole sequence: cold builds whatever the checkout caches, warm reads it,
 * and --no-index runs with the same caches but the index bypassed, so its number isolates
 * the index rather than a cold pricing cache.
 */
async function measureSide(bench: Bench, checkout: Checkout, window: Window): Promise<SideRuns> {
  const env = treeEnv(bench.treeHome, bench.freshHome(checkout.label), bench.cache);
  const cold = await measure(checkout, window.args, env);
  const warm = await measure(checkout, window.args, env);
  const noIndex = checkout.noIndex
    ? await measure(checkout, [...window.args, NO_INDEX_FLAG], env)
    : undefined;
  return { cold, warm, noIndex };
}

function sideRunList(runs: SideRuns): { label: string; run: Measurement }[] {
  return [
    { label: "cold", run: runs.cold },
    { label: "warm", run: runs.warm },
    ...(runs.noIndex === undefined ? [] : [{ label: NO_INDEX_FLAG, run: runs.noIndex }]),
  ];
}

function sideMetrics(runs: SideRuns): SideMetrics {
  return {
    coldMs: runs.cold.ms,
    warmMs: runs.warm.ms,
    noIndexMs: runs.noIndex?.ms,
    bytesRead: bytesRead(runs.warm.json),
  };
}

async function measureWindow(bench: Bench, window: Window): Promise<WindowResult> {
  const env = (home: string): Record<string, string> => treeEnv(bench.treeHome, home, bench.cache);
  const { base, head } = bench;

  // Untimed priming of BOTH checkouts in throwaway homes: the timed runs then find the tree
  // in the OS file cache and each checkout's modules already emitted, so neither side pays
  // for the disk or for deno's first-run work.
  console.log(`${window.label}: priming`);
  await measure(base, window.args, env(bench.freshHome("prime-base")));
  await measure(head, window.args, env(bench.freshHome("prime-head")));

  console.log(`${window.label}: measuring`);
  const baseRuns = await measureSide(bench, base, window);
  assertWindowHasUsage(window.label, baseRuns.cold.json);
  const headRuns = await measureSide(bench, head, window);
  let recheckRun: Measurement | undefined;
  const { outcome } = await classifyPayloads(
    baseRuns.cold.text,
    sideRunList(headRuns).map(({ label, run }) => ({ label: `head ${label}`, text: run.text })),
    async () => {
      console.log(`${window.label}: a head payload differs, re-running base`);
      recheckRun = await measure(base, window.args, env(bench.freshHome("base-recheck")));
      return recheckRun.text;
    },
    (headText) => unifiedDiff(bench.scratch, baseRuns.cold.text, headText),
  );

  const allRuns = [
    ...sideRunList(baseRuns).map(({ run }) => run),
    ...sideRunList(headRuns).map(({ run }) => run),
    ...(recheckRun ? [recheckRun] : []),
  ];
  return {
    window: window.label,
    base: sideMetrics(baseRuns),
    head: sideMetrics(headRuns),
    outcome,
    runtimeKeyPresent: allRuns.some(({ json }) => RUNTIME_KEY in json),
  };
}

function verdictCell(outcome: Outcome): string {
  switch (outcome.kind) {
    case "match":
      return "match";
    case "transient":
      return "match (after a base re-run)";
    case "differs":
      return `DIFFERS (${outcome.labels.join(", ")})`;
  }
}

/**
 * The diff cell of one measure row: head minus base with the unit, then the percent of base,
 * each with its own sign (a percent that rounds to zero is `+0.0%`). No percent when the base
 * is 0, and an empty cell when either side has no value.
 */
export function deltaCell(
  head: number | undefined,
  base: number | undefined,
  unit: string,
): string {
  if (head === undefined || base === undefined) return "";
  const delta = head - base;
  const signed = (value: number, digits: number): string =>
    `${value < 0 ? "-" : "+"}${Math.abs(value).toFixed(digits)}`;
  if (base === 0) return `${signed(delta, 0)}${unit}`;
  const percent = Number((delta / base * 100).toFixed(1));
  return `${signed(delta, 0)}${unit} (${signed(percent, 1)}%)`;
}

const MEASURE_ROWS: readonly [string, (side: SideMetrics) => number | undefined, string][] = [
  ["cold", (side) => side.coldMs, " ms"],
  ["warm", (side) => side.warmMs, " ms"],
  [NO_INDEX_FLAG, (side) => side.noIndexMs, " ms"],
  ["warm bytes read", (side) => side.bytesRead, ""],
];

export function renderWindowTable(result: WindowResult): string[] {
  const value = (v: number | undefined, unit: string): string =>
    v === undefined ? "n/a" : `${v}${unit}`;
  const rows = MEASURE_ROWS.map(([label, pick, unit]) => [
    label,
    value(pick(result.base), unit),
    value(pick(result.head), unit),
    deltaCell(pick(result.head), pick(result.base), unit),
  ]);
  rows.push(["JSON vs base", "", "", verdictCell(result.outcome)]);
  return [
    `**${result.window}**`,
    "",
    "| measure | base | head | diff |",
    "| --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ];
}

function renderComment(
  results: readonly WindowResult[],
  opts: MeasureOptions,
  baseSha: string,
  measuredSha: string,
  tree: TreeSummary,
): string {
  if (results.length === 0) throw new Error("no windows measured");
  const anyDiffers = results.some((result) => result.outcome.kind === "differs");
  const headLabel = opts.headSha !== undefined && shortSha(opts.headSha) !== shortSha(measuredSha)
    ? `${shortSha(measuredSha)} (merge of PR head ${shortSha(opts.headSha)})`
    : shortSha(measuredSha);
  const lines = [
    COMMENT_MARKER,
    `## Cost metrics: ${anyDiffers ? "JSON DIFFERS from base" : "JSON matches base"}`,
    "",
    "`agent cost --json --per-day` over one synthetic tree, base and head back to back on one runner.",
    "",
    ...results.flatMap((result) => [...renderWindowTable(result), ""]),
    `- base \`${shortSha(baseSha)}\`, head \`${headLabel}\``,
    `- tree: ${opts.mb} MB requested, seed ${opts.seed}; ${tree.files} files, ${tree.bytes} bytes, ` +
    `days ${tree.firstDay}..${tree.lastDay}`,
    "- cold: first run in a fresh copilot-env home; warm: second run in the same home; " +
    `${NO_INDEX_FLAG}: a third run there with the index bypassed. Both checkouts were primed ` +
    "untimed first, so the numbers compare the scans, not the disk.",
  ];
  if (results.some((result) => result.runtimeKeyPresent)) {
    lines.push(`- compared with the \`${RUNTIME_KEY}\` key dropped`);
  }
  for (const result of results) {
    if (result.outcome.kind !== "transient") continue;
    lines.push(
      `- ${result.window}: ${result.outcome.labels.join(", ")} differed from the first base ` +
        "run but matched a second one, so the inputs (live pricing or the local day boundary) " +
        "moved between runs, not the code",
    );
  }
  let body = `${lines.join("\n")}\n`;
  for (const result of results) {
    if (result.outcome.kind !== "differs") continue;
    body += diffSection(result.window, result.outcome.labels[0], result.outcome.diff);
  }
  return body.endsWith("\n") ? body : `${body}\n`;
}

function appendStepSummary(text: string): void {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile !== undefined && summaryFile !== "") appendFileSync(summaryFile, text);
}

function setStepOutput(name: string, value: string): void {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile !== undefined && outputFile !== "") {
    appendFileSync(outputFile, `${name}=${value}\n`);
  }
}

interface Teardown {
  what: string;
  run: () => Promise<void> | void;
}

/** One failing step must not skip the rest. */
async function cleanup(steps: readonly Teardown[]): Promise<string[]> {
  const failures: string[] = [];
  for (const { what, run } of steps) {
    try {
      await run();
    } catch (error: unknown) {
      failures.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failures;
}

async function runMeasure(opts: MeasureOptions): Promise<void> {
  // Teardown steps register as their resource is created, so a failure anywhere in the try
  // (setup included) cleans up exactly what exists and still writes the failure summary.
  const teardown: Teardown[] = [];
  let primary: unknown;
  try {
    const baseSha = await resolveCommit(opts.base);
    const measuredSha = (await git(["rev-parse", "HEAD"])).stdout.trim();
    const cache = await denoDir();

    const scratch = mkdtempSync(join(tmpdir(), "cost-metrics-"));
    teardown.push({
      what: "remove scratch",
      run: () => rmSync(scratch, { recursive: true, force: true }),
    });
    const baseDir = join(scratch, "base");
    const treeHome = join(scratch, "home");
    let homes = 0;
    const freshHome = (name: string): string => join(scratch, "homes", `${++homes}-${name}`);

    console.log(`base ${shortSha(baseSha)} -> worktree ${baseDir}`);
    await git(["worktree", "add", "--detach", baseDir, baseSha]);
    teardown.unshift({
      what: "worktree remove",
      run: async () => {
        await git(["worktree", "remove", "--force", baseDir]);
      },
    });
    await mustRun("deno", ["ci"], { cwd: baseDir, env: setupEnv() });

    console.log(`generating a ${opts.mb} MB tree (seed ${opts.seed}) into ${treeHome}`);
    const tree = await generateTree(opts, treeHome);
    console.log(JSON.stringify(tree));
    const window = wholeTreeWindow(tree, localTodayMs());
    // Registered before sealing: a seal that fails halfway is still unsealed.
    teardown.unshift({ what: "unseal tree", run: () => unsealTree(treeHome) });
    sealTree(treeHome);
    const digest = treeDigest(treeHome);

    const probeEnv = treeEnv(treeHome, freshHome("probe"), cache);
    const bench: Bench = {
      base: { label: "base", dir: baseDir, noIndex: await supportsNoIndex(baseDir, probeEnv) },
      head: { label: "head", dir: REPO_ROOT, noIndex: await supportsNoIndex(REPO_ROOT, probeEnv) },
      treeHome,
      cache,
      scratch,
      freshHome,
    };
    const results = [await measureWindow(bench, window)];
    if (treeDigest(treeHome) !== digest) {
      throw new Error("the synthetic tree changed during the runs; a cost run must not write it");
    }

    const body = renderComment(results, opts, baseSha, measuredSha, tree);
    const verdict: Verdict = results.some((result) => result.outcome.kind === "differs")
      ? "differs"
      : "match";
    console.log(body);
    mkdirSync(opts.out, { recursive: true });
    const commentFile = join(opts.out, COMMENT_FILE);
    writeFileSync(commentFile, body);
    writeFileSync(join(opts.out, VERDICT_FILE), `${verdict}\n`);
    appendStepSummary(body);
    setStepOutput(COMMENT_OUTPUT, commentFile);
    console.log(`verdict: ${verdict} (written to ${opts.out})`);
  } catch (error: unknown) {
    primary = error;
    const message = error instanceof Error ? error.message : String(error);
    // Best effort, like the teardown: a summary that cannot be written must not hide the error.
    teardown.unshift({
      what: "failure summary",
      run: () => appendStepSummary(failureSummary(message)),
    });
  }
  const failures = await cleanup(teardown);
  if (primary !== undefined) {
    if (failures.length > 0) console.error(`cleanup failed:\n${failures.join("\n")}`);
    throw primary;
  }
  if (failures.length > 0) throw new Error(`cleanup failed:\n${failures.join("\n")}`);
}

function readVerdict(dir: string): Verdict {
  const raw = readFileSync(join(dir, VERDICT_FILE), "utf8").trim();
  if (raw === "match" || raw === "differs") return raw;
  throw new Error(`${join(dir, VERDICT_FILE)}: unknown verdict ${JSON.stringify(raw)}`);
}

function runVerdict(opts: VerdictOptions): number {
  const verdict = readVerdict(opts.in);
  if (verdict === "differs") console.error("cost JSON differs from the base commit");
  return verdict === "differs" ? 1 : 0;
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "measure":
      await runMeasure(parseMeasureOptions(rest));
      return 0;
    case "verdict":
      return runVerdict(parseVerdictOptions(rest));
    default:
      usage();
  }
}

// test/cost_metrics.test.ts imports the pure functions, so nothing runs on import.
if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
