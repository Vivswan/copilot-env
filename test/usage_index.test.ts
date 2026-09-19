// Driven in-process with a pair of fake parsers that turn each fixture line into one Claude
// occurrence keyed by the line's hash, so a stored contribution carries numbers, a model name,
// and hashes, never a byte of the line itself. `IndexStats` is the oracle for what the index
// did each run.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
import { releaseFileLock, tryAcquireFileLock } from "../src/utils/file_lock.ts";
import { captureAllWrites } from "./helpers/output.ts";
import { afterEach, expect, tempDir, test } from "./helpers/testing.ts";

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
  root = tempDir("usage-index-");
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
}

function storedRows(): StoredRow[] {
  const db = new DatabaseSync(dbPath(), { readOnly: true });
  try {
    return db.prepare(
      `SELECT "path", "record", "tail_probe" AS tailProbe FROM "files" ORDER BY "path"`,
    ).all() as unknown as StoredRow[];
  } finally {
    db.close();
  }
}

/** Overwrite one row's record from a second connection. */
function rewriteRecord(path: string, record: string): void {
  const db = new DatabaseSync(dbPath());
  try {
    db.prepare(`UPDATE "files" SET "record" = ? WHERE "path" = ?`).run(record, path);
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

// --- tests ----------------------------------------------------------------------

test("round trip: a second run reuses every row and reads no bytes", () => {
  setup();
  const a = join(logs, "a.jsonl");
  const b = join(logs, "b.jsonl");
  writeLines(a, 0, 3, "alpha");
  writeLines(b, 0, 5, "beta");
  // A pre-existing wider directory is tightened before SQLite opens the index in it.
  mkdirSync(indexDir, { mode: 0o755 });
  const index = open();
  if (process.platform !== "win32") expect(statSync(indexDir).mode & 0o777).toBe(0o700);
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

/** One way a session file can differ from its stored row, and how the next run must read it:
 *  from its tail (prior contribution + new bytes) or whole. `change` returns the bytes that run
 *  must read; a sibling file `b` is walked alongside and always reused. */
const FILE_CHANGES: {
  name: string;
  file?: string;
  resumable?: boolean;
  initial?: (a: string) => void;
  change: (a: string, before: { size: number; mtimeMs: number }) => number;
  parsed: "tail" | "whole";
}[] = [
  {
    name: "an appended file is parsed from its tail with the prior contribution",
    initial: (a) => writeLines(a, 0, 4, "alpha"),
    change: (a) => appendLines(a, 4, 3, "alpha") + TAIL_PROBE_BYTES,
    parsed: "tail",
  },
  {
    name: "a short file's probe is the whole prefix and still counts in bytesRead",
    initial: (a) => {
      writeFileSync(a, "tiny ts=1\n");
      expect(statSync(a).size).toBeLessThan(TAIL_PROBE_BYTES);
    },
    change: (a, before) => appendLines(a, 1, 1, "more") + before.size,
    parsed: "tail",
  },
  {
    name: "a shrunk file is parsed whole",
    initial: (a) => writeLines(a, 0, 6, "alpha"),
    change: (a) => {
      writeLines(a, 0, 2, "alpha");
      return statSync(a).size;
    },
    parsed: "whole",
  },
  {
    name: "the same size with another mtime is parsed whole",
    change: (a, before) => {
      writeLines(a, 0, 3, "bravo");
      expect(statSync(a).size).toBe(before.size);
      const later = new Date(before.mtimeMs + 5_000);
      utimesSync(a, later, later);
      return statSync(a).size;
    },
    parsed: "whole",
  },
  {
    name: "an mtime-only change (same bytes, same size) is parsed whole",
    change: (a, before) => {
      const bytesBefore = readFileSync(a);
      const later = new Date(before.mtimeMs + 5_000);
      utimesSync(a, later, later);
      expect(readFileSync(a)).toEqual(bytesBefore);
      expect(statSync(a).mtimeMs).not.toBe(before.mtimeMs);
      return statSync(a).size;
    },
    parsed: "whole",
  },
  {
    // Same prefix length, one byte inside the probe window differs, then more lines: the
    // probe bytes are read before the whole parse reads the file again.
    name: "a grown file whose old tail changed fails the probe and is parsed whole",
    change: (a, before) => {
      const rewritten = Buffer.from(readFileSync(a));
      rewritten[before.size - 2] = "X".charCodeAt(0);
      writeFileSync(a, rewritten);
      appendLines(a, 3, 2, "alpha");
      return TAIL_PROBE_BYTES + statSync(a).size;
    },
    parsed: "whole",
  },
  {
    name: "a grown non-resumable file is parsed whole without a probe read",
    file: "a.jsonl.zst",
    resumable: false,
    change: (a) => {
      appendLines(a, 3, 2, "alpha");
      return statSync(a).size;
    },
    parsed: "whole",
  },
];

for (const { name, file = "a.jsonl", resumable = true, initial, change, parsed } of FILE_CHANGES) {
  test(name, () => {
    setup();
    const a = join(logs, file);
    const b = join(logs, "b.jsonl");
    if (initial) initial(a);
    else writeLines(a, 0, 3, "alpha");
    writeLines(b, 0, 2, "beta");
    const files = () => [walked(a, { resumable }), walked(b)];
    const index = open();
    const first = runReconcile(index.reconcile, files());
    const before = statSync(a);
    const priorA = first.records[0]?.contribution;

    const bytesRead = change(a, { size: before.size, mtimeMs: before.mtimeMs });
    const second = runReconcile(index.reconcile, files());
    expect(second.stats).toEqual(fullStats({
      filesSeen: 2,
      filesReused: 1,
      ...(parsed === "tail" ? { filesParsedTail: 1 } : { filesParsedWhole: 1 }),
      bytesRead,
    }));
    if (parsed === "tail") {
      expect(second.calls.whole).toEqual([]);
      expect(second.calls.tail).toEqual([{ path: a, fromByte: before.size, prior: priorA }]);
    } else {
      expect(second.calls.whole).toEqual([a]);
      expect(second.calls.tail).toEqual([]);
    }
    expect(second.records.map((r) => r.path)).toEqual([a, b]);
    expect(second.records[0]?.contribution).toEqual(expectedContribution(a));
    expect(second.records[1]?.contribution).toEqual(first.records[1]?.contribution);

    // The rewritten row describes the file as it is now: a third run reuses both.
    const third = runReconcile(index.reconcile, files());
    expect(third.stats).toEqual(fullStats({ filesSeen: 2, filesReused: 2 }));
    expect(third.records).toEqual(second.records);
  });
}

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

test("a parse that throws is one failure: warned, row deleted, others untouched", async () => {
  setup();
  const a = join(logs, "a.jsonl");
  const bad = join(logs, "bad.jsonl");
  writeLines(a, 0, 3, "alpha");
  writeLines(bad, 0, 3, "bad");
  const index = open();
  runReconcile(index.reconcile, [walked(a), walked(bad)]);
  appendLines(bad, 3, 1, "bad");

  let second: ReturnType<typeof runReconcile> | undefined;
  const out = await captureAllWrites(() => {
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

/** A stored database and the stamp the next opener carries: the rows are adopted only when the
 *  file is a sound database this parser stamped; anything else is rebuilt, with one info line. */
const OPENERS: {
  name: string;
  seedFingerprint?: string;
  sabotage?: () => void;
  openFingerprint?: string;
  rebuilds: boolean;
  line?: string;
}[] = [
  {
    name: "the same parser fingerprint adopts the rows",
    seedFingerprint: "parsers-1",
    openFingerprint: "parsers-1",
    rebuilds: false,
  },
  {
    name: "a file that is not a database is rebuilt",
    sabotage: () =>
      writeFileSync(dbPath(), "this is not a database, not even close to one\n".repeat(20)),
    rebuilds: true,
    line: "rebuilding the usage index",
  },
  {
    name: "another parser fingerprint is rebuilt, naming the stale one",
    seedFingerprint: "parsers-1",
    openFingerprint: "parsers-2",
    rebuilds: true,
    line: "rebuilding the usage index (parser_fingerprint parsers-1)",
  },
  {
    // The default stamp is a different fingerprint too.
    name: "the default fingerprint after a named one is rebuilt",
    seedFingerprint: "parsers-2",
    sabotage: () => expect(DEFAULT_PARSER_FINGERPRINT).not.toBe("parsers-2"),
    rebuilds: true,
    line: "rebuilding the usage index (parser_fingerprint parsers-2)",
  },
  {
    name: "rows without stamps are rebuilt, never adopted",
    sabotage: () => {
      const db = new DatabaseSync(dbPath());
      try {
        db.exec(`DELETE FROM "meta"`);
      } finally {
        db.close();
      }
    },
    rebuilds: true,
    line: "rebuilding the usage index (unstamped rows).",
  },
];

for (const { name, seedFingerprint, sabotage, openFingerprint, rebuilds, line } of OPENERS) {
  test(`opening a stored index: ${name}`, async () => {
    setup();
    const a = join(logs, "a.jsonl");
    const b = join(logs, "b.jsonl");
    writeLines(a, 0, 3, "alpha");
    writeLines(b, 0, 3, "beta");
    const seed = open({ fingerprint: seedFingerprint });
    runReconcile(seed.reconcile, [walked(a), walked(b)]);
    seed.close();
    sabotage?.();

    let reopened: UsageIndex | undefined;
    const out = await captureAllWrites(() => {
      reopened = open({ fingerprint: openFingerprint });
    });
    expect(out.split("rebuilding the usage index").length - 1).toBe(rebuilds ? 1 : 0);
    if (line !== undefined) expect(out).toContain(line);
    const result = runReconcile(reopened!.reconcile, [walked(a), walked(b)]);
    expect(result.stats).toEqual(fullStats(
      rebuilds
        ? { filesSeen: 2, filesParsedWhole: 2, bytesRead: statSync(a).size + statSync(b).size }
        : { filesSeen: 2, filesReused: 2 },
    ));
    expect(result.records[0]?.contribution).toEqual(expectedContribution(a));
    expect(result.records[1]?.contribution).toEqual(expectedContribution(b));
    reopened!.close();
    expect(storedRows().map((r) => r.path)).toEqual([a, b]);
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

test("with the lock held elsewhere the records are still right and nothing is written", async () => {
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
    const out = await captureAllWrites(() => {
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

test("opening while another run holds the lock yields no index, with one info line", async () => {
  setup();
  mkdirSync(indexDir, { recursive: true });
  const lockPath = join(indexDir, USAGE_INDEX_LOCK_NAME);
  expect(tryAcquireFileLock(lockPath, 60_000)).toBe(true);
  try {
    let index: UsageIndex | null = null;
    const out = await captureAllWrites(() => {
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

for (const when of ["before the run", "between two candidates"] as const) {
  test(`an index that fails ${when} parses the rest whole, warns once, saves nothing`, async () => {
    setup();
    const a = join(logs, "a.jsonl");
    const b = join(logs, "b.jsonl");
    const c = join(logs, "c.jsonl");
    const d = join(logs, "d.jsonl");
    writeLines(a, 0, 3, "alpha");
    writeLines(b, 0, 3, "beta");
    writeLines(c, 0, 3, "gamma");
    writeLines(d, 0, 3, "delta");
    const index = open();
    runReconcile(index.reconcile, [walked(a), walked(b), walked(c), walked(d)]);
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
    // d has grown too, but it is reached only AFTER the failure: it must parse whole
    // without a probe read, since the failed index's snapshot is not consulted again.
    appendLines(d, 3, 1, "delta");
    let result: ReturnType<Reconcile> | undefined;
    const out = await captureAllWrites(() => {
      result = index.reconcile("claude", [walked(a), walked(b), walked(d)], whole, tail);
    });
    expect(out.split("usage index unreadable, parsing every file").length - 1).toBe(1);
    expect(out).not.toContain("could not read");
    expect(result?.records.map((r) => r.path)).toEqual([a, b, d]);
    expect(result?.records[0]?.contribution).toEqual(expectedContribution(a));
    expect(result?.records[1]?.contribution).toEqual(expectedContribution(b));
    expect(result?.records[2]?.contribution).toEqual(expectedContribution(d));
    // Before: nothing is known, all parse whole. Between: a still resumed from its
    // row (a tail parse), then the failure made b and d whole parses.
    const expectedTail = when === "before the run" ? 0 : 1;
    expect(result?.stats).toEqual(fullStats({
      filesSeen: 3,
      filesParsedWhole: 3 - expectedTail,
      filesParsedTail: expectedTail,
      bytesRead: (expectedTail === 1
        ? TAIL_PROBE_BYTES + Buffer.byteLength(line(3, "alpha"))
        : statSync(a).size) +
        statSync(b).size + statSync(d).size,
    }));
    index.close();
    // Nothing was saved although the table was back: a's row still describes the
    // 3-line file and the deleted c's row is still there.
    const rows = storedRows();
    expect(rows.map((r) => r.path)).toEqual([a, b, c, d]);
    expect((JSON.parse(rows[0]?.record ?? "") as ClaudeContribution).occurrences.length).toBe(3);
    // The next run, index healthy, catches up from those rows: a and d resume from
    // their 3-line rows, b reuses, the deleted c goes.
    const reopened = open();
    const next = runReconcile(reopened.reconcile, [walked(a), walked(b), walked(d)]);
    expect(next.stats).toEqual(fullStats({
      filesSeen: 3,
      filesReused: 1,
      filesParsedTail: 2,
      filesDeleted: 1,
      bytesRead: 2 * TAIL_PROBE_BYTES + Buffer.byteLength(line(3, "alpha")) +
        Buffer.byteLength(line(3, "delta")),
    }));
  });
}

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

/** A stored record is this program's own: it is trusted once it parses as JSON under the current
 *  contribution version. One from another version, or text that is not JSON, reads as no row: the
 *  file parses whole and the row is rewritten. */
const REWRITTEN_RECORDS: { name: string; rewrite: (record: string) => string; reused: boolean }[] =
  [
    { name: "the same text (control)", rewrite: (record) => record, reused: true },
    {
      name: "another contribution version",
      rewrite: (record) =>
        record.replace(`"v":${CONTRIBUTION_VERSION}`, `"v":${CONTRIBUTION_VERSION + 1}`),
      reused: false,
    },
    { name: "text that is not JSON", rewrite: () => "{not json", reused: false },
  ];

for (const { name, rewrite, reused } of REWRITTEN_RECORDS) {
  test(`a stored row holding ${name} is ${reused ? "reused" : "parsed whole"}`, () => {
    setup();
    const a = join(logs, "a.jsonl");
    writeLines(a, 0, 2, "alpha");
    const index = open();
    runReconcile(index.reconcile, [walked(a)]);
    index.close();
    const record = storedRows()[0]?.record ?? "";
    const rewritten = rewrite(record);
    if (!reused) expect(rewritten).not.toBe(record);
    rewriteRecord(a, rewritten);

    const reopened = open();
    const result = runReconcile(reopened.reconcile, [walked(a)]);
    expect(result.stats).toEqual(fullStats(
      reused
        ? { filesSeen: 1, filesReused: 1 }
        : { filesSeen: 1, filesParsedWhole: 1, bytesRead: statSync(a).size },
    ));
    expect(result.records[0]?.contribution).toEqual(expectedContribution(a));
    reopened.close();
    expect(JSON.parse(storedRows()[0]?.record ?? "")).toEqual(expectedContribution(a));
  });
}

/** Everything under `path` as SQLite and we left it: directory listings and file bytes. */
function diskState(path: string): unknown {
  if (!existsSync(path)) return null;
  if (!statSync(path).isDirectory()) return readFileSync(path).toString("hex");
  return Object.fromEntries(
    readdirSync(path).sort().map((name) => [name, diskState(join(path, name))]),
  );
}

/** Index locations that fail to open as OUR database without proving they are nobody's. */
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
  {
    name: "a directory that cannot be created",
    sabotage: () => {
      rmSync(indexDir, { recursive: true, force: true });
      writeFileSync(indexDir, "a file where the directory should go");
    },
    line: () => `could not create the usage index directory ${indexDir}`,
  },
];

for (const { name, sabotage, line } of UNREMOVABLE) {
  test(`${name} is left untouched: no rebuild, the opener runs index-less`, async () => {
    setup();
    const a = join(logs, "a.jsonl");
    writeLines(a, 0, 3, "alpha");
    const index = open();
    runReconcile(index.reconcile, [walked(a)]);
    index.close();
    sabotage();
    const before = diskState(indexDir);

    let other: UsageIndex | null = null;
    const out = await captureAllWrites(() => {
      other = openUsageIndex({ dir: indexDir });
    });
    expect(other).toBeNull();
    expect(out.split(line()).length - 1).toBe(1);
    expect(out).not.toContain("rebuilding the usage index");
    expect(diskState(indexDir)).toEqual(before);
  });
}

test("the contract's no-index reconcile parses every candidate whole and stores nothing", async () => {
  setup();
  const a = join(logs, "a.jsonl");
  const b = join(logs, "b.jsonl");
  const bad = join(logs, "bad.jsonl");
  writeLines(a, 0, 3, "alpha");
  writeLines(b, 0, 3, "beta");
  writeLines(bad, 0, 1, "bad");
  let result: ReturnType<typeof runReconcile> | undefined;
  const out = await captureAllWrites(() => {
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
