// The usage index, driven in-process against fixture files written here and a
// pair of fake parsers that turn each fixture line into one Claude occurrence:
// its dedup key is the line's hash, so the stored contribution carries numbers,
// a model name, and hashes, and never a byte of the line itself. `IndexStats`
// is the oracle for what the index did each run.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { consola } from "consola";
import {
  type ClaudeContribution,
  type ClaudeOccurrence,
  type CodexContribution,
  CONTRIBUTION_VERSION,
  dedupKey,
  emptyIndexStats,
  type IndexStats,
  type ParsedFile,
  parseEveryCandidate,
  type ParseTail,
  type ParseWhole,
  type Reconcile,
  TAIL_PROBE_BYTES,
  type WalkedFile,
} from "../src/usage/contribution.ts";
import {
  DEFAULT_PARSER_FINGERPRINT,
  openUsageIndex,
  USAGE_INDEX_DB_NAME,
  USAGE_INDEX_LOCK_NAME,
  type UsageIndex,
} from "../src/usage/index.ts";
import { usageIndexDir } from "../src/usage/paths.ts";
import { releaseFileLock, tryAcquireFileLock } from "../src/utils/file_lock.ts";
import { afterEach, expect, test } from "./helpers/testing.ts";

let root = "";
let logs = "";
let indexDir = "";
const openIndexes: UsageIndex[] = [];

afterEach(() => {
  for (const index of openIndexes.splice(0)) {
    try {
      index.close();
    } catch {
      // already closed by the test
    }
  }
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

function setup(): void {
  root = mkdtempSync(join(tmpdir(), "usage-index-"));
  logs = join(root, "logs");
  indexDir = join(root, "index");
  mkdirSync(logs);
}

function open(
  opts: { fingerprint?: string; lockPolicy?: { staleMs: number; waitMs: number } } = {},
) {
  const index = openUsageIndex({ dir: indexDir, ...opts });
  if (index === null) throw new Error("index did not open");
  openIndexes.push(index);
  return index;
}

// --- fixtures -------------------------------------------------------------------

const BASE_TS = Date.UTC(2026, 5, 1);
const MODEL = "model-x";

/** One fixture line: an id, a timestamp, and `marker` (the text that must never
 *  reach the database). */
function line(n: number, marker: string): string {
  return `line-${n} ts=${BASE_TS + n * 1000} ${marker}\n`;
}

function writeLines(path: string, from: number, count: number, marker: string): void {
  let text = "";
  for (let n = from; n < from + count; n++) text += line(n, marker);
  writeFileSync(path, text);
}

function appendLines(path: string, from: number, count: number, marker: string): number {
  let text = "";
  for (let n = from; n < from + count; n++) text += line(n, marker);
  appendFileSync(path, text);
  return Buffer.byteLength(text);
}

function walked(path: string, opts: Partial<WalkedFile> = {}): WalkedFile {
  const st = statSync(path);
  return { path, size: st.size, mtimeMs: st.mtimeMs, candidate: true, resumable: true, ...opts };
}

// --- the fake parsers -----------------------------------------------------------

interface ParserCalls {
  whole: string[];
  tail: { path: string; fromByte: number; prior: ClaudeContribution }[];
}

function occurrenceOf(text: string): ClaudeOccurrence {
  const ts = /ts=(\d+)/.exec(text);
  return [
    dedupKey(text),
    ts === null ? null : Number(ts[1]),
    MODEL,
    Buffer.byteLength(text),
    0,
    0,
    0,
  ];
}

function probeHex(bytes: Buffer, through: number): string {
  return bytes.subarray(Math.max(0, through - TAIL_PROBE_BYTES), through).toString("hex");
}

function parseFrom(
  path: string,
  fromByte: number,
  prior: ClaudeContribution,
): ParsedFile<ClaudeContribution> {
  const bytes = readFileSync(path);
  const fresh = bytes.subarray(fromByte).toString("utf8").split("\n").filter((t) => t !== "");
  return {
    contribution: {
      v: CONTRIBUTION_VERSION,
      occurrences: [...prior.occurrences, ...fresh.map(occurrenceOf)],
    },
    parsedThrough: bytes.length,
    tailProbeHex: probeHex(bytes, bytes.length),
    bytesRead: bytes.length - fromByte,
  };
}

function fakeParsers(
  calls: ParserCalls,
  failing: ReadonlySet<string> = new Set(),
): { whole: ParseWhole<ClaudeContribution>; tail: ParseTail<ClaudeContribution> } {
  return {
    whole: (file) => {
      calls.whole.push(file.path);
      if (failing.has(file.path)) throw new Error("boom");
      return parseFrom(file.path, 0, { v: CONTRIBUTION_VERSION, occurrences: [] });
    },
    tail: (file, fromByte, prior) => {
      calls.tail.push({ path: file.path, fromByte, prior });
      if (failing.has(file.path)) throw new Error("boom");
      return parseFrom(file.path, fromByte, prior);
    },
  };
}

function runReconcile(
  reconcile: Reconcile,
  files: readonly WalkedFile[],
  failing?: ReadonlySet<string>,
) {
  const calls: ParserCalls = { whole: [], tail: [] };
  const parsers = fakeParsers(calls, failing);
  const result = reconcile("claude", files, parsers.whole, parsers.tail);
  return { ...result, calls };
}

/** A COMPLETE stats expectation: every field not named is asserted to be zero. */
function fullStats(expected: Partial<IndexStats>): IndexStats {
  return { ...emptyIndexStats(), ...expected };
}

/** What a fresh whole parse of `path` yields: the reference every run must match. */
function expectedContribution(path: string): ClaudeContribution {
  return parseFrom(path, 0, { v: CONTRIBUTION_VERSION, occurrences: [] }).contribution;
}

// --- inspection helpers ---------------------------------------------------------

function dbPath(): string {
  return join(indexDir, USAGE_INDEX_DB_NAME);
}

/** Read the `files` table rows of a CLOSED index. */
interface StoredRow {
  path: string;
  record: string;
  tailProbe: string;
  lastTsMs: number | null;
}

function storedRows(): StoredRow[] {
  const db = new DatabaseSync(dbPath(), { readOnly: true });
  try {
    return db.prepare(
      `SELECT "path", "record", "tail_probe" AS tailProbe, "last_ts_ms" AS lastTsMs
         FROM "files" ORDER BY "path"`,
    ).all() as unknown as StoredRow[];
  } finally {
    db.close();
  }
}

function rewriteRecord(path: string, record: string): void {
  rewriteColumn(path, "record", record);
}

/** Overwrite one column of one row from a second connection. `column` is one of
 *  the on-disk names and is interpolated as an identifier, never as a value. */
function rewriteColumn(path: string, column: string, value: string | number): void {
  const db = new DatabaseSync(dbPath());
  try {
    db.prepare(`UPDATE "files" SET "${column}" = ? WHERE "path" = ?`).run(value, path);
  } finally {
    db.close();
  }
}

/** Make the index's next `files` read fail from a second connection (the table is
 *  renamed away), or put it back so a later write COULD land. */
function hideFilesTable(hidden: boolean): void {
  const db = new DatabaseSync(dbPath());
  try {
    db.exec(
      hidden
        ? `ALTER TABLE "files" RENAME TO "files_hidden"`
        : `ALTER TABLE "files_hidden" RENAME TO "files"`,
    );
  } finally {
    db.close();
  }
}

/** Every byte SQLite left on disk for the index: the database and any sidecar. */
function rawIndexBytes(): string {
  let text = "";
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const file = `${dbPath()}${suffix}`;
    if (existsSync(file)) text += readFileSync(file).toString("latin1");
  }
  return text;
}

/** Run `body` with stdout/stderr captured (consola routes through one of them); the
 *  consola level is raised so info/warn are not self-silenced under the test runner. */
function captureAllWrites(body: () => void): string {
  const written: string[] = [];
  const savedLevel = consola.level;
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const capture = (chunk: string | Uint8Array): boolean => {
    written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };
  process.stdout.write = capture;
  process.stderr.write = capture;
  try {
    consola.level = 3;
    body();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    consola.level = savedLevel;
  }
  return written.join("");
}

// --- tests ----------------------------------------------------------------------

test("usageIndexDir lives under the root copilot-api home", () => {
  expect(usageIndexDir()).toBe(join(process.env.COPILOT_API_HOME ?? "", "usage-index"));
});

test("round trip: a second run reuses every row and reads no bytes", () => {
  setup();
  const a = join(logs, "a.jsonl");
  const b = join(logs, "b.jsonl");
  writeLines(a, 0, 3, "alpha");
  writeLines(b, 0, 5, "beta");
  const index = open();
  const files = [walked(a), walked(b)];

  const first = runReconcile(index.reconcile, files);
  expect(first.stats).toEqual(
    fullStats({
      filesSeen: 2,
      filesParsedWhole: 2,
      bytesRead: statSync(a).size + statSync(b).size,
    }),
  );
  expect(first.records.map((r) => r.path)).toEqual([a, b]);

  const second = runReconcile(index.reconcile, files);
  expect(second.stats).toEqual(fullStats({ filesSeen: 2, filesReused: 2 }));
  expect(second.calls.whole).toEqual([]);
  expect(second.calls.tail).toEqual([]);
  expect(second.records).toEqual(first.records);
  expect(second.records[0]?.contribution).toEqual(expectedContribution(a));
  expect(second.records[1]?.contribution).toEqual(expectedContribution(b));
});

test("an appended file is parsed from its tail with the prior contribution", () => {
  setup();
  const a = join(logs, "a.jsonl");
  const b = join(logs, "b.jsonl");
  writeLines(a, 0, 4, "alpha");
  writeLines(b, 0, 2, "beta");
  const index = open();
  const first = runReconcile(index.reconcile, [walked(a), walked(b)]);
  const sizeBefore = statSync(a).size;
  const priorA = first.records[0]?.contribution;

  const appended = appendLines(a, 4, 3, "alpha");
  const second = runReconcile(index.reconcile, [walked(a), walked(b)]);
  expect(second.stats).toEqual(fullStats({
    filesSeen: 2,
    filesReused: 1,
    filesParsedTail: 1,
    bytesRead: appended + TAIL_PROBE_BYTES,
  }));
  expect(second.calls.whole).toEqual([]);
  expect(second.calls.tail).toEqual([{ path: a, fromByte: sizeBefore, prior: priorA }]);
  expect(second.records[0]?.contribution).toEqual(expectedContribution(a));

  const third = runReconcile(index.reconcile, [walked(a), walked(b)]);
  expect(third.stats).toEqual(fullStats({ filesSeen: 2, filesReused: 2 }));
  expect(third.records[0]?.contribution).toEqual(expectedContribution(a));
});

test("a short file's probe is the whole prefix and still counts in bytesRead", () => {
  setup();
  const a = join(logs, "a.jsonl");
  writeFileSync(a, "tiny ts=1\n");
  const shortSize = statSync(a).size;
  expect(shortSize).toBeLessThan(TAIL_PROBE_BYTES);
  const index = open();
  runReconcile(index.reconcile, [walked(a)]);
  const appended = appendLines(a, 1, 1, "more");
  const second = runReconcile(index.reconcile, [walked(a)]);
  expect(second.stats).toEqual(
    fullStats({ filesSeen: 1, filesParsedTail: 1, bytesRead: appended + shortSize }),
  );
});

test("a shrunk file is parsed whole", () => {
  setup();
  const a = join(logs, "a.jsonl");
  writeLines(a, 0, 6, "alpha");
  const index = open();
  runReconcile(index.reconcile, [walked(a)]);
  writeLines(a, 0, 2, "alpha");
  const second = runReconcile(index.reconcile, [walked(a)]);
  expect(second.stats).toEqual(
    fullStats({ filesSeen: 1, filesParsedWhole: 1, bytesRead: statSync(a).size }),
  );
  expect(second.calls.tail).toEqual([]);
  expect(second.records[0]?.contribution).toEqual(expectedContribution(a));
});

test("the same size with another mtime is parsed whole", () => {
  setup();
  const a = join(logs, "a.jsonl");
  writeLines(a, 0, 3, "alpha");
  const index = open();
  const first = runReconcile(index.reconcile, [walked(a)]);
  const before = statSync(a);
  writeLines(a, 0, 3, "bravo");
  expect(statSync(a).size).toBe(before.size);
  const later = new Date(before.mtimeMs + 5_000);
  utimesSync(a, later, later);
  const second = runReconcile(index.reconcile, [walked(a)]);
  expect(second.stats).toEqual(
    fullStats({ filesSeen: 1, filesParsedWhole: 1, bytesRead: statSync(a).size }),
  );
  expect(second.records[0]?.contribution).not.toEqual(first.records[0]?.contribution);
  expect(second.records[0]?.contribution).toEqual(expectedContribution(a));
});

test("an mtime-only change (same bytes, same size) is parsed whole", () => {
  setup();
  const a = join(logs, "a.jsonl");
  writeLines(a, 0, 3, "alpha");
  const index = open();
  const first = runReconcile(index.reconcile, [walked(a)]);
  const before = statSync(a);
  const bytesBefore = readFileSync(a);
  const later = new Date(before.mtimeMs + 5_000);
  utimesSync(a, later, later);
  expect(readFileSync(a)).toEqual(bytesBefore);
  expect(statSync(a).mtimeMs).not.toBe(before.mtimeMs);
  const second = runReconcile(index.reconcile, [walked(a)]);
  expect(second.stats).toEqual(
    fullStats({ filesSeen: 1, filesParsedWhole: 1, bytesRead: statSync(a).size }),
  );
  expect(second.calls.whole).toEqual([a]);
  expect(second.records).toEqual(first.records);
  // The rewritten row carries the new mtime: a third run reuses it.
  expect(runReconcile(index.reconcile, [walked(a)]).stats).toEqual(
    fullStats({ filesSeen: 1, filesReused: 1 }),
  );
});

test("a grown file whose old tail changed fails the probe and is parsed whole", () => {
  setup();
  const a = join(logs, "a.jsonl");
  writeLines(a, 0, 3, "alpha");
  const index = open();
  runReconcile(index.reconcile, [walked(a)]);
  const oldSize = statSync(a).size;
  // Same prefix length, one byte inside the probe window differs, then more lines.
  const rewritten = Buffer.from(readFileSync(a));
  rewritten[oldSize - 2] = "X".charCodeAt(0);
  writeFileSync(a, rewritten);
  appendLines(a, 3, 2, "alpha");
  const second = runReconcile(index.reconcile, [walked(a)]);
  // The probe bytes were read before the whole parse read the file again.
  expect(second.stats).toEqual(fullStats({
    filesSeen: 1,
    filesParsedWhole: 1,
    bytesRead: TAIL_PROBE_BYTES + statSync(a).size,
  }));
  expect(second.calls.tail).toEqual([]);
  expect(second.records[0]?.contribution).toEqual(expectedContribution(a));
});

test("a grown non-resumable file is parsed whole without a probe read", () => {
  setup();
  const a = join(logs, "a.jsonl.zst");
  writeLines(a, 0, 3, "alpha");
  const index = open();
  runReconcile(index.reconcile, [walked(a, { resumable: false })]);
  appendLines(a, 3, 2, "alpha");
  const second = runReconcile(index.reconcile, [walked(a, { resumable: false })]);
  expect(second.stats).toEqual(
    fullStats({ filesSeen: 1, filesParsedWhole: 1, bytesRead: statSync(a).size }),
  );
});

test("a walked non-candidate is neither parsed nor deleted", () => {
  setup();
  const a = join(logs, "a.jsonl");
  const b = join(logs, "b.jsonl");
  writeLines(a, 0, 3, "alpha");
  writeLines(b, 0, 3, "beta");
  const index = open();
  runReconcile(index.reconcile, [walked(a), walked(b)]);

  const second = runReconcile(index.reconcile, [walked(a), walked(b, { candidate: false })]);
  expect(second.stats).toEqual(fullStats({ filesSeen: 2, filesReused: 1 }));
  expect(second.records.map((r) => r.path)).toEqual([a]);
  index.close();
  expect(storedRows().map((r) => r.path)).toEqual([a, b]);

  // Back in the window: reused, never re-read.
  const reopened = open();
  const third = runReconcile(reopened.reconcile, [walked(a), walked(b)]);
  expect(third.stats).toEqual(fullStats({ filesSeen: 2, filesReused: 2 }));
});

test("a deleted session vanishes: its row is gone and it contributes no record", () => {
  setup();
  const a = join(logs, "a.jsonl");
  const gone = join(logs, "gone-4f9c2e71.jsonl");
  writeLines(a, 0, 3, "alpha");
  writeLines(gone, 0, 3, "gone-marker-7b1d");
  const index = open();
  const first = runReconcile(index.reconcile, [walked(a), walked(gone)]);
  expect(first.records.map((r) => r.path)).toEqual([a, gone]);
  const goneKeys = first.records[1]?.contribution.occurrences.map((o) => o[0]) ?? [];
  expect(goneKeys.length).toBe(3);

  rmSync(gone);
  const second = runReconcile(index.reconcile, [walked(a)]);
  expect(second.stats).toEqual(fullStats({ filesSeen: 1, filesReused: 1, filesDeleted: 1 }));
  expect(second.records.map((r) => r.path)).toEqual([a]);
  for (const record of second.records) {
    for (const occurrence of record.contribution.occurrences) {
      expect(goneKeys).not.toContain(occurrence[0]);
    }
  }
  index.close();
  expect(storedRows().map((r) => r.path)).toEqual([a]);
  // Nothing of the deleted session survives on disk, not even in freed pages,
  // while the surviving session's row is still there to prove the scan can see rows.
  const raw = rawIndexBytes();
  expect(raw).toContain(a);
  expect(raw).not.toContain("gone-4f9c2e71");
  for (const key of goneKeys) expect(raw).not.toContain(key);
});

test("a parse that throws is one failure: warned, row deleted, others untouched", () => {
  setup();
  const a = join(logs, "a.jsonl");
  const bad = join(logs, "bad.jsonl");
  writeLines(a, 0, 3, "alpha");
  writeLines(bad, 0, 3, "bad");
  const index = open();
  runReconcile(index.reconcile, [walked(a), walked(bad)]);
  appendLines(bad, 3, 1, "bad");

  let second: ReturnType<typeof runReconcile> | undefined;
  const out = captureAllWrites(() => {
    second = runReconcile(index.reconcile, [walked(a), walked(bad)], new Set([bad]));
  });
  expect(out).toContain(`could not read ${bad} (boom).`);
  expect(second?.stats).toEqual(
    fullStats({ filesSeen: 2, filesReused: 1, filesFailed: 1, bytesRead: TAIL_PROBE_BYTES }),
  );
  expect(second?.records.map((r) => r.path)).toEqual([a]);
  index.close();
  expect(storedRows().map((r) => r.path)).toEqual([a]);

  // With the parser healthy again the file is parsed whole (no row to resume from).
  const reopened = open();
  const third = runReconcile(reopened.reconcile, [walked(a), walked(bad)]);
  expect(third.stats).toEqual(
    fullStats({ filesSeen: 2, filesReused: 1, filesParsedWhole: 1, bytesRead: statSync(bad).size }),
  );
});

test("a corrupt database is rebuilt with one info line and the run still succeeds", () => {
  setup();
  const a = join(logs, "a.jsonl");
  writeLines(a, 0, 3, "alpha");
  mkdirSync(indexDir, { recursive: true });
  writeFileSync(dbPath(), "this is not a database, not even close to one\n".repeat(20));

  let index: UsageIndex | undefined;
  const out = captureAllWrites(() => {
    index = open();
  });
  expect(out.split("rebuilding the usage index").length - 1).toBe(1);
  const result = runReconcile(index!.reconcile, [walked(a)]);
  expect(result.stats).toEqual(
    fullStats({ filesSeen: 1, filesParsedWhole: 1, bytesRead: statSync(a).size }),
  );
  expect(result.records[0]?.contribution).toEqual(expectedContribution(a));
  index!.close();
  expect(storedRows().map((r) => r.path)).toEqual([a]);
});

test("a parser fingerprint change re-parses everything once", () => {
  setup();
  const a = join(logs, "a.jsonl");
  const b = join(logs, "b.jsonl");
  writeLines(a, 0, 3, "alpha");
  writeLines(b, 0, 3, "beta");
  const first = open({ fingerprint: "parsers-1" });
  runReconcile(first.reconcile, [walked(a), walked(b)]);
  first.close();

  const same = open({ fingerprint: "parsers-1" });
  expect(runReconcile(same.reconcile, [walked(a), walked(b)]).stats).toEqual(
    fullStats({ filesSeen: 2, filesReused: 2 }),
  );
  same.close();

  let changed: UsageIndex | undefined;
  const out = captureAllWrites(() => {
    changed = open({ fingerprint: "parsers-2" });
  });
  expect(out).toContain("rebuilding the usage index");
  expect(out).toContain("parser_fingerprint parsers-1");
  const result = runReconcile(changed!.reconcile, [walked(a), walked(b)]);
  expect(result.stats).toEqual(
    fullStats({
      filesSeen: 2,
      filesParsedWhole: 2,
      bytesRead: statSync(a).size + statSync(b).size,
    }),
  );
  changed!.close();

  // The default stamp is a different fingerprint too.
  let defaulted: UsageIndex | undefined;
  const out2 = captureAllWrites(() => {
    defaulted = open();
  });
  expect(out2).toContain(`rebuilding the usage index`);
  expect(DEFAULT_PARSER_FINGERPRINT).not.toBe("parsers-2");
  expect(runReconcile(defaulted!.reconcile, [walked(a)]).stats).toEqual(
    fullStats({ filesSeen: 1, filesParsedWhole: 1, bytesRead: statSync(a).size }),
  );
});

test("a row with another contribution version is parsed whole; the rest reuse", () => {
  setup();
  const a = join(logs, "a.jsonl");
  const b = join(logs, "b.jsonl");
  const c = join(logs, "c.jsonl");
  writeLines(a, 0, 3, "alpha");
  writeLines(b, 0, 3, "beta");
  writeLines(c, 0, 3, "gamma");
  const index = open();
  runReconcile(index.reconcile, [walked(a), walked(b), walked(c)]);
  index.close();
  const rowA = storedRows().find((r) => r.path === a);
  const stale = JSON.parse(rowA?.record ?? "") as { v: number };
  stale.v = CONTRIBUTION_VERSION + 1;
  rewriteRecord(a, JSON.stringify(stale));
  rewriteRecord(b, "{not json");

  const reopened = open();
  const result = runReconcile(reopened.reconcile, [walked(a), walked(b), walked(c)]);
  expect(result.stats).toEqual(fullStats({
    filesSeen: 3,
    filesReused: 1,
    filesParsedWhole: 2,
    bytesRead: statSync(a).size + statSync(b).size,
  }));
  expect(result.calls.whole).toEqual([a, b]);
  expect(result.calls.tail).toEqual([]);
  for (const [i, path] of [a, b, c].entries()) {
    expect(result.records[i]).toEqual({ path, contribution: expectedContribution(path) });
  }
  reopened.close();
  expect(storedRows().map((r) => (JSON.parse(r.record) as { v: number }).v)).toEqual([1, 1, 1]);
});

for (const corrupt of [-1, 1e20]) {
  test(`a row with resume offset ${corrupt} reads as no row: whole parse, row healed`, () => {
    setup();
    const a = join(logs, "a.jsonl");
    const b = join(logs, "b.jsonl");
    writeLines(a, 0, 3, "alpha");
    writeLines(b, 0, 3, "beta");
    const index = open();
    runReconcile(index.reconcile, [walked(a), walked(b)]);
    index.close();
    rewriteColumn(a, "parsed_through", corrupt);
    // Both grow, so a trusted row would resume; a's corrupt one must not be trusted.
    appendLines(a, 3, 1, "alpha");
    const appendedB = appendLines(b, 3, 1, "beta");

    const reopened = open();
    let result: ReturnType<typeof runReconcile> | undefined;
    const out = captureAllWrites(() => {
      result = runReconcile(reopened.reconcile, [walked(a), walked(b)]);
    });
    expect(out).not.toContain("could not read");
    expect(result?.stats).toEqual(fullStats({
      filesSeen: 2,
      filesParsedWhole: 1,
      filesParsedTail: 1,
      bytesRead: statSync(a).size + TAIL_PROBE_BYTES + appendedB,
    }));
    expect(result?.calls.whole).toEqual([a]);
    expect(result?.records[0]?.contribution).toEqual(expectedContribution(a));
    reopened.close();

    // The healed row resumes normally on the next append.
    const healed = open();
    const appendedA = appendLines(a, 4, 1, "alpha");
    expect(runReconcile(healed.reconcile, [walked(a), walked(b)]).stats).toEqual(fullStats({
      filesSeen: 2,
      filesReused: 1,
      filesParsedTail: 1,
      bytesRead: TAIL_PROBE_BYTES + appendedA,
    }));
  });
}

test("no session text reaches the database", () => {
  setup();
  const marker = "SECRET-PLAINTEXT-MARKER-9d1e";
  const a = join(logs, "a.jsonl");
  writeLines(a, 0, 5, marker);
  expect(readFileSync(a, "utf8")).toContain(marker);
  const index = open();
  const result = runReconcile(index.reconcile, [walked(a)]);
  expect(result.stats).toEqual(
    fullStats({ filesSeen: 1, filesParsedWhole: 1, bytesRead: statSync(a).size }),
  );
  expect(result.records[0]?.contribution.occurrences.length).toBe(5);
  index.close();
  const raw = rawIndexBytes();
  expect(raw).not.toContain(marker);
  expect(raw).not.toContain(Buffer.from(marker).toString("hex"));
  // The tail probe is stored as a hash: neither the last bytes of the file nor
  // their hex encoding are on disk, and the column holds a 32-hex dedup key.
  const fileBytes = readFileSync(a);
  const tail = fileBytes.subarray(fileBytes.length - TAIL_PROBE_BYTES);
  expect(raw).not.toContain(tail.toString("latin1"));
  expect(raw).not.toContain(tail.toString("hex"));
  const row = storedRows()[0];
  expect(row?.tailProbe).toBe(dedupKey(tail.toString("hex")));
  expect(row?.tailProbe).toMatch(/^[0-9a-f]{32}$/);
  // Positive controls: what IS allowed on disk is there.
  expect(raw).toContain(MODEL);
  expect(raw).toContain(a);
  expect(raw).toContain(dedupKey(line(0, marker).replace(/\n$/, "")));
});

test("with the lock held elsewhere the records are still right and nothing is written", () => {
  setup();
  const a = join(logs, "a.jsonl");
  const b = join(logs, "b.jsonl");
  writeLines(a, 0, 3, "alpha");
  writeLines(b, 0, 3, "beta");
  const policy = { staleMs: 60_000, waitMs: 0 };
  const index = open({ lockPolicy: policy });
  runReconcile(index.reconcile, [walked(a), walked(b)]);
  const lockPath = join(indexDir, USAGE_INDEX_LOCK_NAME);
  expect(tryAcquireFileLock(lockPath, 60_000)).toBe(true);
  try {
    rmSync(b);
    appendLines(a, 3, 2, "alpha");
    let result: ReturnType<typeof runReconcile> | undefined;
    const out = captureAllWrites(() => {
      result = runReconcile(index.reconcile, [walked(a)]);
    });
    expect(out).toContain("usage index lock unavailable; this run's results were not saved.");
    expect(result?.stats).toEqual(fullStats({
      filesSeen: 1,
      filesParsedTail: 1,
      bytesRead: TAIL_PROBE_BYTES + statSync(a).size - 3 * Buffer.byteLength(line(0, "alpha")),
    }));
    expect(result?.records.map((r) => r.path)).toEqual([a]);
    expect(result?.records[0]?.contribution).toEqual(expectedContribution(a));
  } finally {
    releaseFileLock(lockPath);
  }
  index.close();
  // Neither the tail parse nor the deletion landed: b's row is still there and
  // a's row still describes the shorter file.
  const rows = storedRows();
  expect(rows.map((r) => r.path)).toEqual([a, b]);
  const storedA = JSON.parse(rows[0]?.record ?? "") as ClaudeContribution;
  expect(storedA.occurrences.length).toBe(3);

  // The next run, lock free, catches up.
  const reopened = open();
  const caughtUp = runReconcile(reopened.reconcile, [walked(a)]);
  expect(caughtUp.stats).toEqual(fullStats({
    filesSeen: 1,
    filesParsedTail: 1,
    filesDeleted: 1,
    bytesRead: TAIL_PROBE_BYTES + 2 * Buffer.byteLength(line(3, "alpha")),
  }));
});

test("opening while another run holds the lock yields no index, with one info line", () => {
  setup();
  mkdirSync(indexDir, { recursive: true });
  const lockPath = join(indexDir, USAGE_INDEX_LOCK_NAME);
  expect(tryAcquireFileLock(lockPath, 60_000)).toBe(true);
  try {
    let index: UsageIndex | null = null;
    const out = captureAllWrites(() => {
      index = openUsageIndex({ dir: indexDir, lockPolicy: { staleMs: 60_000, waitMs: 0 } });
    });
    expect(index).toBeNull();
    expect(out.split("usage index lock unavailable; running without it.").length - 1).toBe(1);
    expect(existsSync(dbPath())).toBe(false);
  } finally {
    releaseFileLock(lockPath);
  }
  // Lock free: the same call opens and creates the database.
  expect(open({ lockPolicy: { staleMs: 60_000, waitMs: 0 } })).not.toBeNull();
  expect(existsSync(dbPath())).toBe(true);
});

test("a database with rows but no stamps is rebuilt, never adopted", () => {
  setup();
  const a = join(logs, "a.jsonl");
  writeLines(a, 0, 3, "alpha");
  const index = open();
  runReconcile(index.reconcile, [walked(a)]);
  index.close();
  const db = new DatabaseSync(dbPath());
  try {
    db.exec(`DELETE FROM "meta"`);
  } finally {
    db.close();
  }
  let reopened: UsageIndex | undefined;
  const out = captureAllWrites(() => {
    reopened = open();
  });
  expect(out).toContain("rebuilding the usage index (unstamped rows).");
  expect(runReconcile(reopened!.reconcile, [walked(a)]).stats).toEqual(
    fullStats({ filesSeen: 1, filesParsedWhole: 1, bytesRead: statSync(a).size }),
  );
});

for (const when of ["before the run", "between two candidates"] as const) {
  test(`an index that fails ${when} parses the rest whole, warns once, saves nothing`, () => {
    setup();
    const a = join(logs, "a.jsonl");
    const b = join(logs, "b.jsonl");
    const c = join(logs, "c.jsonl");
    writeLines(a, 0, 3, "alpha");
    writeLines(b, 0, 3, "beta");
    writeLines(c, 0, 3, "gamma");
    const index = open();
    runReconcile(index.reconcile, [walked(a), walked(b), walked(c)]);
    rmSync(c);

    if (when === "before the run") hideFilesTable(true);
    const calls: ParserCalls = { whole: [], tail: [] };
    const parsers = fakeParsers(calls);
    // "Between": the sabotage fires from whichever parser handles `a` (its append
    // makes that the tail parser), so `b`'s row lookup is what fails. Either way
    // the table is back before the run ends, so a write COULD land: only the
    // index-failure guard keeps it from doing so.
    const afterParsing = (file: WalkedFile): void => {
      if (when === "between two candidates" && file.path === a) hideFilesTable(true);
      if (file.path === b) hideFilesTable(false);
    };
    const whole: ParseWhole<ClaudeContribution> = (file) => {
      const parsed = parsers.whole(file);
      afterParsing(file);
      return parsed;
    };
    const tail: ParseTail<ClaudeContribution> = (file, fromByte, prior) => {
      const parsed = parsers.tail(file, fromByte, prior);
      afterParsing(file);
      return parsed;
    };
    appendLines(a, 3, 1, "alpha");
    let result: ReturnType<Reconcile> | undefined;
    const out = captureAllWrites(() => {
      result = index.reconcile("claude", [walked(a), walked(b)], whole, tail);
    });
    expect(out.split("usage index unreadable, parsing every file").length - 1).toBe(1);
    expect(out).not.toContain("could not read");
    expect(result?.records.map((r) => r.path)).toEqual([a, b]);
    expect(result?.records[0]?.contribution).toEqual(expectedContribution(a));
    expect(result?.records[1]?.contribution).toEqual(expectedContribution(b));
    // Before: nothing is known, both parse whole. Between: a still resumed from its
    // row (a tail parse), then the failure made b a whole parse.
    const expectedTail = when === "before the run" ? 0 : 1;
    expect(result?.stats).toEqual(fullStats({
      filesSeen: 2,
      filesParsedWhole: 2 - expectedTail,
      filesParsedTail: expectedTail,
      bytesRead: (expectedTail === 1
        ? TAIL_PROBE_BYTES + Buffer.byteLength(line(3, "alpha"))
        : statSync(a).size) +
        statSync(b).size,
    }));
    index.close();
    // Nothing was saved although the table was back: a's row still describes the
    // 3-line file and the deleted c's row is still there.
    const rows = storedRows();
    expect(rows.map((r) => r.path)).toEqual([a, b, c]);
    expect((JSON.parse(rows[0]?.record ?? "") as ClaudeContribution).occurrences.length).toBe(3);
    // The next run, index healthy, catches up from those rows.
    const reopened = open();
    const next = runReconcile(reopened.reconcile, [walked(a), walked(b)]);
    expect(next.stats).toEqual(fullStats({
      filesSeen: 2,
      filesReused: 1,
      filesParsedTail: 1,
      filesDeleted: 1,
      bytesRead: TAIL_PROBE_BYTES + Buffer.byteLength(line(3, "alpha")),
    }));
  });
}

/** Contributions the schema must refuse to store, each spoiling one occurrence. */
const UNSTORABLE: {
  name: string;
  spoil: (o: ClaudeOccurrence) => ClaudeOccurrence;
  needle: string;
}[] = [
  {
    name: "a raw id in a hash slot",
    spoil: (o) => ["msg_01RAWIDENTIFIER", o[1], o[2], o[3], o[4], o[5], o[6]],
    needle: "msg_01RAWIDENTIFIER",
  },
  {
    name: "a non-finite count",
    spoil: (o) => [o[0], o[1], o[2], Infinity, o[4], o[5], o[6]],
    needle: "null",
  },
];

for (const { name, spoil, needle } of UNSTORABLE) {
  test(`a contribution with ${name} is returned, never stored, and evicts its row`, () => {
    setup();
    const a = join(logs, "a.jsonl");
    const leaky = join(logs, "leaky.jsonl");
    writeLines(a, 0, 2, "alpha");
    writeLines(leaky, 0, 2, "leaky");
    const calls: ParserCalls = { whole: [], tail: [] };
    const parsers = fakeParsers(calls);
    const leaking: ParseWhole<ClaudeContribution> = (file) => {
      const parsed = parsers.whole(file);
      if (file.path !== leaky) return parsed;
      const [first, ...rest] = parsed.contribution.occurrences;
      if (first === undefined) throw new Error("fixture has no lines");
      return {
        ...parsed,
        contribution: { v: CONTRIBUTION_VERSION, occurrences: [spoil(first), ...rest] },
      };
    };
    const index = open();
    // A clean first run stores both rows (the control the eviction is measured
    // against); the shrink then forces a whole parse, the leaking one.
    runReconcile(index.reconcile, [walked(a), walked(leaky)]);
    writeLines(leaky, 0, 1, "leaky");

    let result: ReturnType<Reconcile> | undefined;
    const out = captureAllWrites(() => {
      result = index.reconcile("claude", [walked(a), walked(leaky)], leaking, () => {
        throw new Error("the leaky file must be re-parsed whole for this test");
      });
    });
    expect(out.split(`not indexing ${leaky}: its contribution is not storable.`).length - 1).toBe(
      1,
    );
    expect(out).not.toContain("could not read");
    // The fold still gets both records this run...
    expect(result?.records.map((r) => r.path)).toEqual([a, leaky]);
    expect(result?.stats).toEqual(fullStats({
      filesSeen: 2,
      filesReused: 1,
      filesParsedWhole: 1,
      bytesRead: statSync(leaky).size,
    }));
    index.close();
    // ...but the leaky file's old row is gone too, and the spoiled value leaves no
    // trace in a stored record (the clean row is the control that records exist).
    const rows = storedRows();
    expect(rows.map((r) => r.path)).toEqual([a]);
    expect(rows[0]?.record).toContain(MODEL);
    expect(rows[0]?.record).not.toContain(needle);
    expect(rawIndexBytes()).not.toContain("msg_01RAWIDENTIFIER");
  });
}

test("an extra property on a contribution is stripped: never stored, never a timestamp", () => {
  setup();
  const a = join(logs, "a.jsonl");
  writeLines(a, 0, 3, "alpha");
  const marker = "EXTRA-PROPERTY-PLAINTEXT-3c7f";
  const calls: ParserCalls = { whole: [], tail: [] };
  const parsers = fakeParsers(calls);
  const decorated: ParseWhole<ClaudeContribution> = (file) => {
    const parsed = parsers.whole(file);
    // A Claude contribution wearing a Codex-shaped `events` list: the shape a
    // careless spread could produce. The timestamps must come from `occurrences`.
    const contribution: ClaudeContribution & { events: unknown } = {
      ...parsed.contribution,
      events: [[marker, marker, marker, marker, 1, 2, 3]],
    };
    return { ...parsed, contribution };
  };
  const index = open();
  const result = index.reconcile("claude", [walked(a)], decorated, parsers.tail);
  expect(result.stats).toEqual(
    fullStats({ filesSeen: 1, filesParsedWhole: 1, bytesRead: statSync(a).size }),
  );
  expect(index.candidatesNewerThan(0)).toEqual([
    { path: a, source: "claude", lastTsMs: BASE_TS + 2_000 },
  ]);
  index.close();
  const rows = storedRows();
  expect(rows.map((r) => r.path)).toEqual([a]);
  expect(rows[0]?.lastTsMs).toBe(BASE_TS + 2_000);
  expect(JSON.parse(rows[0]?.record ?? "")).toEqual(expectedContribution(a));
  expect(rawIndexBytes()).not.toContain(marker);
});

test("a stale database still open elsewhere is never removed; the opener runs index-less", () => {
  setup();
  const a = join(logs, "a.jsonl");
  writeLines(a, 0, 3, "alpha");
  const live = open({ fingerprint: "parsers-1" });
  const seeded = runReconcile(live.reconcile, [walked(a)]);
  const quick = { staleMs: 60_000, waitMs: 0 };

  let other: UsageIndex | null = null;
  const out = captureAllWrites(() => {
    other = openUsageIndex({ dir: indexDir, fingerprint: "parsers-2", lockPolicy: quick });
  });
  expect(other).toBeNull();
  expect(out.split("usage index in use by another run").length - 1).toBe(1);
  expect(out).toContain("parser_fingerprint parsers-1");
  expect(out).not.toContain("rebuilding the usage index");
  // The live handle's files and rows are intact, and it keeps working.
  expect(existsSync(dbPath())).toBe(true);
  expect(existsSync(`${dbPath()}-wal`)).toBe(true);
  const again = runReconcile(live.reconcile, [walked(a)]);
  expect(again.stats).toEqual(fullStats({ filesSeen: 1, filesReused: 1 }));
  expect(again.records).toEqual(seeded.records);
  live.close();

  // Once the live handle is gone the same open rebuilds (the control).
  let rebuilt: UsageIndex | undefined;
  const out2 = captureAllWrites(() => {
    rebuilt = open({ fingerprint: "parsers-2", lockPolicy: quick });
  });
  expect(out2.split("rebuilding the usage index (parser_fingerprint parsers-1)").length - 1).toBe(
    1,
  );
  expect(runReconcile(rebuilt!.reconcile, [walked(a)]).stats).toEqual(
    fullStats({ filesSeen: 1, filesParsedWhole: 1, bytesRead: statSync(a).size }),
  );
});

/** Ways a stored row can carry text the schema does not declare. */
const PLANTED: { name: string; plant: (row: StoredRow, marker: string) => void }[] = [
  {
    name: "an extra object property in the record",
    plant: (row, marker) => {
      const doc = JSON.parse(row.record) as Record<string, unknown>;
      rewriteRecord(row.path, JSON.stringify({ ...doc, leak: marker }));
    },
  },
  {
    name: "an extra tuple item in the record",
    plant: (row, marker) => {
      const doc = JSON.parse(row.record) as { v: number; occurrences: unknown[][] };
      const [first, ...rest] = doc.occurrences;
      rewriteRecord(
        row.path,
        JSON.stringify({ ...doc, occurrences: [[...(first ?? []), marker], ...rest] }),
      );
    },
  },
  {
    name: "a non-hash tail probe",
    plant: (row, marker) => rewriteColumn(row.path, "tail_probe", marker),
  },
  {
    name: "an inherited-name property in the record",
    plant: (row, marker) => {
      const doc = JSON.parse(row.record) as Record<string, unknown>;
      rewriteRecord(row.path, JSON.stringify({ ...doc, constructor: marker }));
    },
  },
];

for (const { name, plant } of PLANTED) {
  test(`a stored row with ${name} is not reused: whole parse, row rewritten clean`, () => {
    setup();
    const marker = "PLANTED-ROW-PLAINTEXT-5a2b";
    const a = join(logs, "a.jsonl");
    const b = join(logs, "b.jsonl");
    writeLines(a, 0, 3, "alpha");
    writeLines(b, 0, 3, "beta");
    const index = open();
    runReconcile(index.reconcile, [walked(a), walked(b)]);
    index.close();
    const rowA = storedRows().find((r) => r.path === a);
    if (rowA === undefined) throw new Error("the seeded row is missing");
    plant(rowA, marker);
    expect(rawIndexBytes()).toContain(marker);

    const reopened = open();
    const result = runReconcile(reopened.reconcile, [walked(a), walked(b)]);
    expect(result.stats).toEqual(
      fullStats({ filesSeen: 2, filesReused: 1, filesParsedWhole: 1, bytesRead: statSync(a).size }),
    );
    expect(result.calls.whole).toEqual([a]);
    expect(result.records[0]).toEqual({ path: a, contribution: expectedContribution(a) });
    reopened.close();
    const clean = storedRows()[0];
    expect(JSON.parse(clean?.record ?? "")).toEqual(expectedContribution(a));
    expect(clean?.tailProbe).toMatch(/^[0-9a-f]{32}$/);
    expect(rawIndexBytes()).not.toContain(marker);
  });
}

test("a rollback-mode database held by another connection is in use, not exclusive", () => {
  setup();
  const a = join(logs, "a.jsonl");
  writeLines(a, 0, 3, "alpha");
  const index = open();
  const seeded = runReconcile(index.reconcile, [walked(a)]);
  index.close();
  // A foreign holder: takes the file out of WAL mode and keeps a write transaction
  // open, so our own WAL entry cannot be established.
  const holder = new DatabaseSync(dbPath());
  try {
    expect(holder.prepare("PRAGMA journal_mode = DELETE").get()).toEqual({
      journal_mode: "delete",
    });
    holder.exec("BEGIN IMMEDIATE");
    let other: UsageIndex | null = null;
    const out = captureAllWrites(() => {
      other = openUsageIndex({ dir: indexDir, lockPolicy: { staleMs: 60_000, waitMs: 0 } });
    });
    expect(other).toBeNull();
    expect(out.split("usage index in use by another run").length - 1).toBe(1);
    expect(out).not.toContain("rebuilding the usage index");
    expect(existsSync(dbPath())).toBe(true);
    holder.exec("COMMIT");
  } finally {
    holder.close();
  }
  // Released: the same database opens again with its rows intact (the control).
  const reopened = open();
  const again = runReconcile(reopened.reconcile, [walked(a)]);
  expect(again.stats).toEqual(fullStats({ filesSeen: 1, filesReused: 1 }));
  expect(again.records).toEqual(seeded.records);
});

test("candidatesNewerThan filters by the latest event and keeps undated rows", () => {
  setup();
  const a = join(logs, "a.jsonl");
  const b = join(logs, "b.jsonl");
  const undated = join(logs, "undated.jsonl");
  writeLines(a, 0, 3, "alpha");
  writeLines(b, 10, 3, "beta");
  writeFileSync(undated, "no timestamp here\n");
  const index = open();
  runReconcile(index.reconcile, [walked(a), walked(b), walked(undated)]);
  const since = BASE_TS + 5_000;
  expect(index.candidatesNewerThan(since).map((s) => s.path).sort()).toEqual([b, undated].sort());
  expect(index.candidatesNewerThan(BASE_TS).map((s) => s.path).sort()).toEqual(
    [a, b, undated].sort(),
  );
  const summaryB = index.candidatesNewerThan(since).find((s) => s.path === b);
  expect(summaryB).toEqual({ path: b, source: "claude", lastTsMs: BASE_TS + 12_000 });
  index.close();
  expect(storedRows().find((r) => r.path === undated)?.lastTsMs).toBeNull();

  // A summary row that does not parse is an unreadable index, not an empty window;
  // the same query answers again once the row is whole.
  const reopened = open();
  for (const corrupt of ["not a timestamp", -Infinity]) {
    rewriteColumn(b, "last_ts_ms", corrupt);
    expect(() => reopened.candidatesNewerThan(since)).toThrow();
  }
  rewriteColumn(b, "last_ts_ms", BASE_TS + 12_000);
  expect(reopened.candidatesNewerThan(since).map((s) => s.path).sort()).toEqual(
    [b, undated].sort(),
  );
});

test("rows are scoped per source: a claude walk never deletes codex rows", () => {
  setup();
  const c = join(logs, "rollout.jsonl");
  const a = join(logs, "a.jsonl");
  writeLines(c, 0, 2, "codex");
  writeLines(a, 0, 2, "alpha");
  const index = open();
  const codexWhole: ParseWhole<CodexContribution> = (file) => ({
    contribution: {
      v: CONTRIBUTION_VERSION,
      state: { provider: "openai", model: "gpt" },
      events: [[BASE_TS, "openai", "gpt", dedupKey(file.path), 1, 2, 3]],
    },
    parsedThrough: file.size,
    tailProbeHex: "",
    bytesRead: file.size,
  });
  index.reconcile("codex", [walked(c)], codexWhole, () => {
    throw new Error("no tail");
  });
  const claude = runReconcile(index.reconcile, [walked(a)]);
  expect(claude.stats).toEqual(
    fullStats({ filesSeen: 1, filesParsedWhole: 1, bytesRead: statSync(a).size }),
  );
  index.close();
  expect(storedRows().map((r) => r.path)).toEqual([a, c]);
});

test("a codex row with an inherited-name property in its state is not reused", () => {
  setup();
  const marker = "PLANTED-STATE-PLAINTEXT-8e1c";
  const c = join(logs, "rollout.jsonl");
  writeLines(c, 0, 2, "codex");
  const wholeCalls: string[] = [];
  const codexWhole: ParseWhole<CodexContribution> = (file) => {
    wholeCalls.push(file.path);
    return {
      contribution: {
        v: CONTRIBUTION_VERSION,
        state: { provider: "openai", model: "gpt" },
        events: [[BASE_TS, "openai", "gpt", dedupKey(file.path), 1, 2, 3]],
      },
      parsedThrough: file.size,
      tailProbeHex: "",
      bytesRead: file.size,
    };
  };
  const noTail = (): never => {
    throw new Error("no tail");
  };
  const index = open();
  index.reconcile("codex", [walked(c)], codexWhole, noTail);
  index.close();
  const row = storedRows()[0];
  const doc = JSON.parse(row?.record ?? "") as { state: Record<string, unknown> };
  rewriteRecord(c, JSON.stringify({ ...doc, state: { ...doc.state, toString: marker } }));
  expect(rawIndexBytes()).toContain(marker);

  const reopened = open();
  const result = reopened.reconcile("codex", [walked(c)], codexWhole, noTail);
  expect(result.stats).toEqual(
    fullStats({ filesSeen: 1, filesParsedWhole: 1, bytesRead: statSync(c).size }),
  );
  expect(wholeCalls).toEqual([c, c]);
  reopened.close();
  expect(JSON.parse(storedRows()[0]?.record ?? "")).toEqual(doc);
  expect(rawIndexBytes()).not.toContain(marker);
});

/** Files that fail to open as OUR database without proving they are nobody's. */
const UNREMOVABLE: { name: string; sabotage: () => void; line: () => string }[] = [
  {
    name: "a corrupt database (valid header, garbage pages)",
    sabotage: () => {
      const bytes = readFileSync(dbPath());
      const corrupt = Buffer.alloc(bytes.length, 0xff);
      bytes.copy(corrupt, 0, 0, 100);
      writeFileSync(dbPath(), corrupt);
    },
    line: () => "usage index unavailable (database disk image is malformed); running without it.",
  },
  {
    name: "a database path that is a directory",
    sabotage: () => {
      rmSync(dbPath(), { force: true });
      rmSync(`${dbPath()}-wal`, { force: true });
      rmSync(`${dbPath()}-shm`, { force: true });
      mkdirSync(dbPath());
    },
    line: () =>
      `could not open the usage index (unable to open database file: ${dbPath()}); running without it.`,
  },
];

for (const { name, sabotage, line } of UNREMOVABLE) {
  test(`${name} is left untouched: no rebuild, the opener runs index-less`, () => {
    setup();
    const a = join(logs, "a.jsonl");
    writeLines(a, 0, 3, "alpha");
    const index = open();
    runReconcile(index.reconcile, [walked(a)]);
    index.close();
    sabotage();
    const before = statSync(dbPath());
    const bytesBefore = before.isFile() ? readFileSync(dbPath()) : null;

    let other: UsageIndex | null = null;
    const out = captureAllWrites(() => {
      other = openUsageIndex({ dir: indexDir });
    });
    expect(other).toBeNull();
    expect(out.split(line()).length - 1).toBe(1);
    expect(out).not.toContain("rebuilding the usage index");
    const after = statSync(dbPath());
    expect(after.isDirectory()).toBe(before.isDirectory());
    if (bytesBefore !== null) expect(readFileSync(dbPath())).toEqual(bytesBefore);
  });
}

test("the contract's no-index reconcile parses every candidate whole and stores nothing", () => {
  setup();
  const a = join(logs, "a.jsonl");
  const b = join(logs, "b.jsonl");
  const bad = join(logs, "bad.jsonl");
  writeLines(a, 0, 3, "alpha");
  writeLines(b, 0, 3, "beta");
  writeLines(bad, 0, 1, "bad");
  let result: ReturnType<typeof runReconcile> | undefined;
  const out = captureAllWrites(() => {
    result = runReconcile(
      parseEveryCandidate,
      [walked(a), walked(b, { candidate: false }), walked(bad)],
      new Set([bad]),
    );
  });
  expect(out.split(`could not read ${bad} (boom).`).length - 1).toBe(1);
  expect(result?.stats).toEqual(
    fullStats({ filesSeen: 3, filesParsedWhole: 1, filesFailed: 1, bytesRead: statSync(a).size }),
  );
  expect(result?.records.map((r) => r.path)).toEqual([a]);
  expect(existsSync(indexDir)).toBe(false);
});

test("openUsageIndex returns null when the directory cannot be created", () => {
  setup();
  const blocker = join(root, "blocker");
  writeFileSync(blocker, "a file where the directory should go");
  let index: UsageIndex | null = null;
  const out = captureAllWrites(() => {
    index = openUsageIndex({ dir: join(blocker, "usage-index") });
  });
  expect(index).toBeNull();
  expect(out).toContain("could not create the usage index directory");
});
