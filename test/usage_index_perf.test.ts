// The usage index on a seeded tree of real-log shape: a warm `agent cost` reads no session
// bytes, an append is read as its new bytes plus the probe, a deleted session leaves the
// index, no planted text reaches the index file, and a warm run is a fraction of the cold
// one. In process throughout; sized by COPILOT_ENV_USAGE_FIXTURE_MB (30 MiB unset).
import { appendFileSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TAIL_PROBE_BYTES } from "../src/usage/contribution.ts";
import type { CostRuntime } from "../src/usage/cost.ts";
import { USAGE_INDEX_DB_NAME } from "../src/usage/index.ts";
import { USAGE_INDEX_DIR_NAME } from "../src/usage/paths.ts";
import { removeDir, tmpDir } from "./helpers.ts";
import { expect, test } from "./helpers/testing.ts";
import { generateUsageTree } from "./helpers/usage_fixtures.ts";
import { runCurrentCost, utcPinnable } from "./helpers/usage_goldens.ts";

const DEFAULT_MB = 30;
const MB = fixtureMb(process.env.COPILOT_ENV_USAGE_FIXTURE_MB);

function fixtureMb(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_MB;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`COPILOT_ENV_USAGE_FIXTURE_MB must be a positive number, got '${raw}'`);
  }
  return n;
}

/** A cold run this short is dominated by fixed costs, so only a longer one carries a ratio. */
const RATIO_FLOOR_MS = 200;
const WARM_FRACTION = 1 / 5;

const roots: string[] = [];
globalThis.addEventListener("unload", () => {
  for (const root of roots) removeDir(root);
});

function freshRoot(): string {
  const root = tmpDir("usage-index-perf-");
  roots.push(root);
  return root;
}

/** Every byte SQLite left on disk for the index, as latin1 text: the database itself (it
 *  must be there and be one) and whichever sidecars exist. */
function indexBytes(home: string): string {
  const db = join(home, USAGE_INDEX_DIR_NAME, USAGE_INDEX_DB_NAME);
  let text = readFileSync(db).toString("latin1");
  expect(text.startsWith("SQLite format 3\0")).toBe(true);
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    if (existsSync(`${db}${suffix}`)) text += readFileSync(`${db}${suffix}`).toString("latin1");
  }
  return text;
}

/** The stored paths of the index at `home`, read through a second connection. */
function storedPaths(home: string): Set<string> {
  const db = new DatabaseSync(join(home, USAGE_INDEX_DIR_NAME, USAGE_INDEX_DB_NAME), {
    readOnly: true,
  });
  try {
    const rows = db.prepare(`SELECT "path" FROM "files"`).all() as { path: string }[];
    return new Set(rows.map((row) => row.path));
  } finally {
    db.close();
  }
}

function log(label: string, runtime: CostRuntime): void {
  console.log(`${label}: ${JSON.stringify(runtime.timing)} ${JSON.stringify(runtime.index)}`);
}

test.skipIf(!utcPinnable())(
  `a ${MB} MiB tree: warm reads nothing, an append reads its bytes, a delete leaves the index`,
  async () => {
    const root = freshRoot();
    const tree = await generateUsageTree({ root, mb: MB, seed: 1 });
    const copilotApiHome = join(freshRoot(), "copilot-env");

    const cold = await runCurrentCost(root, { copilotApiHome });
    log("cold", cold.runtime);
    const warm = await runCurrentCost(root, { copilotApiHome });
    log("warm", warm.runtime);
    expect(warm.payload).toEqual(cold.payload);
    expect(cold.runtime.index.filesFailed).toBe(0);
    expect(cold.runtime.index.filesReused).toBe(0);
    expect(warm.runtime.index.filesReused).toBe(cold.runtime.index.filesParsedWhole);
    expect(warm.runtime.index.filesParsedWhole + warm.runtime.index.filesParsedTail).toBe(0);
    expect(warm.runtime.index.bytesRead).toBe(0);
    if (cold.runtime.timing.total > RATIO_FLOOR_MS) {
      expect(warm.runtime.timing.total).toBeLessThan(cold.runtime.timing.total * WARM_FRACTION);
    }

    // No planted prompt text reaches the index: every marker is in some session file
    // (read one file at a time: a whole tree is past V8's string limit) ...
    const unseen = new Set(tree.markers);
    expect(unseen.size).toBeGreaterThan(0);
    for (const file of tree.files) {
      if (file.path.endsWith(".zst") || unseen.size === 0) continue;
      const text = readFileSync(file.path, "utf8");
      for (const marker of unseen) if (text.includes(marker)) unseen.delete(marker);
    }
    expect([...unseen]).toEqual([]);
    // ... and in none of the index's bytes.
    const stored = indexBytes(copilotApiHome);
    for (const marker of tree.markers) expect(stored).not.toContain(marker);
    const claudeFiles = tree.files.filter((f) => f.source === "claude").map((f) => f.path);

    // Append one complete line to three LF-terminated transcripts: each is read from its
    // tail, so the run reads the appended bytes plus two probe reads per file (the index
    // verifies the stored probe, the scanner seeds the next one) and nothing else.
    const terminated = claudeFiles.filter((path) => {
      const size = statSync(path).size;
      const fd = readFileSync(path);
      return size > TAIL_PROBE_BYTES && fd[size - 1] === 0x0a;
    });
    const appendedTo = terminated.slice(0, 3);
    expect(appendedTo.length).toBe(3);
    const line = `${
      JSON.stringify({ type: "user", message: { role: "user", content: "more" } })
    }\n`;
    for (const path of appendedTo) appendFileSync(path, line);
    const appended = await runCurrentCost(root, { copilotApiHome });
    log("after append", appended.runtime);
    expect(appended.runtime.index.filesParsedTail).toBe(3);
    expect(appended.runtime.index.filesParsedWhole).toBe(0);
    expect(appended.runtime.index.bytesRead).toBe(
      3 * (Buffer.byteLength(line) + 2 * TAIL_PROBE_BYTES),
    );
    expect(appended.payload).toEqual(cold.payload);

    // Delete two transcripts: their rows go, the rest reuse.
    const deleted = terminated.slice(3, 5);
    expect(deleted.length).toBe(2);
    for (const path of deleted) expect(storedPaths(copilotApiHome).has(path)).toBe(true);
    for (const path of deleted) rmSync(path);
    const afterDelete = await runCurrentCost(root, { copilotApiHome });
    log("after delete", afterDelete.runtime);
    expect(afterDelete.runtime.index.filesDeleted).toBe(2);
    expect(afterDelete.runtime.index.filesSeen).toBe(cold.runtime.index.filesSeen - 2);
    expect(afterDelete.runtime.index.filesReused).toBe(cold.runtime.index.filesParsedWhole - 2);
    expect(afterDelete.runtime.index.bytesRead).toBe(0);
    const remaining = storedPaths(copilotApiHome);
    for (const path of deleted) expect(remaining.has(path)).toBe(false);
    // The fold no longer carries them: the no-index parse of what is on disk agrees.
    const plain = await runCurrentCost(root, { noIndex: true });
    expect(afterDelete.payload).toEqual(plain.payload);
  },
  600_000,
);
