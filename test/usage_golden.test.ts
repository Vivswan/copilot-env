// The current `agent cost` reproduces the pre-index goldens (test/helpers/usage_goldens.ts)
// through runCost and through the index cold and warm. In process throughout; no child runs.
import { join } from "node:path";
import { readClaudeSessions } from "../src/usage/claude_sessions.ts";
import { readCodexSessions } from "../src/usage/codex_sessions.ts";
import type { IndexStats, Reconcile, UsageSource } from "../src/usage/contribution.ts";
import { buildSourceJson } from "../src/usage/cost.ts";
import { openUsageIndex } from "../src/usage/index.ts";
import { estimateCost, type PricingTier } from "../src/usage/pricing.ts";
import type { ReadonlyUsageReport } from "../src/usage/usage.ts";
import { removeDir, tmpDir } from "./helpers.ts";
import { expect, test } from "./helpers/testing.ts";
import type { GeneratedTree } from "./helpers/usage_fixtures.ts";
import {
  canonicalLedger,
  describeMismatch,
  expectedCurrent,
  generateGoldenTree,
  generatorParams,
  GOLDEN_COST_ARGS,
  GOLDEN_MATRIX,
  GOLDEN_TIME_ZONE,
  type GoldenCase,
  goldenFilesFor,
  type GoldenTree,
  parseCostPayload,
  PRE_INDEX_COMMIT,
  readRecording,
  readText,
  runCurrentCostJson,
  sourceEventCounts,
  treeSha256,
  utcPinnable,
} from "./helpers/usage_goldens.ts";

/** runCost cuts days in the system zone, so ITS run needs the process pinned to UTC; a
 *  Windows host outside UTC cannot be pinned and skips only that comparison. The readers
 *  take the zone as a parameter, so the index paths run everywhere. */
const UTC = utcPinnable();

/** The optional larger extra run: a tree of this size checks the three read paths agree
 *  with each other (there is no golden for it). Unset, or no larger than the committed
 *  trees, means no extra run; a value that is not a positive number is refused. */
const EXTRA_MB = extraMb(process.env.COPILOT_ENV_USAGE_FIXTURE_MB);
const COMMITTED_MB = Math.max(...GOLDEN_MATRIX.map((c) => c.generator.mb));

function extraMb(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`COPILOT_ENV_USAGE_FIXTURE_MB must be a positive number, got '${raw}'`);
  }
  return n;
}

const roots: string[] = [];
globalThis.addEventListener("unload", () => {
  for (const root of roots) removeDir(root);
});

function freshRoot(): string {
  const root = tmpDir("usage-golden-");
  roots.push(root);
  return root;
}

interface Golden {
  entry: GoldenCase;
  /** What the old cli printed. */
  golden: Record<string, unknown>;
  generated: GoldenTree;
}

/** A case's golden and its tree, loaded once. The digest check reports a generator drift as
 *  such rather than as a cost mismatch; the events check keeps a golden from pinning nothing. */
const loaded = new Map<string, Promise<Golden>>();

function loadGolden(entry: GoldenCase): Promise<Golden> {
  let promise = loaded.get(entry.name);
  if (promise === undefined) {
    promise = (async () => {
      const files = goldenFilesFor(entry.name);
      const recording = readRecording(files, entry.name);
      expect(recording.oldCommit).toBe(PRE_INDEX_COMMIT);
      expect(recording.args).toEqual([...GOLDEN_COST_ARGS]);
      const golden = parseCostPayload(readText(files.goldenPath), entry.name);
      const events = sourceEventCounts(golden);
      expect(Object.keys(events).some((s) => s.startsWith("codex:"))).toBe(true);
      for (const [source, n] of Object.entries(events)) {
        expect(n, `${entry.name} ${source}`).toBeGreaterThan(0);
      }
      const generated = await generateGoldenTree(entry, freshRoot());
      expect(
        treeSha256(generated.tree),
        `${entry.name}: the generator no longer writes the recorded tree`,
      )
        .toBe(recording.treeSha256);
      return { entry, golden, generated };
    })();
    loaded.set(entry.name, promise);
  }
  return promise;
}

/** No pricing: the unreachable URL leaves both implementations with an empty price list. */
const NO_PRICING = new Map<string, PricingTier>();

/** The per-source blocks of a payload that the readers determine: each Codex provider's
 *  block and the Claude block, without the `roots` count runCost adds beside them. */
function sourceBlocks(payload: Record<string, unknown>): Record<string, unknown> {
  const codex = payload.codexSessions as { providers: Record<string, unknown> };
  const { roots: _roots, ...claude } = payload.claudeSessions as Record<string, unknown>;
  return { codex: codex.providers, claude };
}

/** The same blocks from reports (the readers' or the ledger's), composed the way runCost
 *  composes them. */
function blocksFromReports(
  codex: ReadonlyMap<string, ReadonlyUsageReport>,
  claude: ReadonlyUsageReport,
): Record<string, unknown> {
  const block = (report: ReadonlyUsageReport): unknown =>
    buildSourceJson(report, estimateCost(report.byModel, NO_PRICING), NO_PRICING, {
      perDay: true,
    });
  return JSON.parse(JSON.stringify({
    codex: Object.fromEntries([...codex.keys()].sort().map((p) => [p, block(codex.get(p)!)])),
    claude: block(claude),
  }));
}

/** The generator's own ledger for a tree, as source blocks. */
function ledgerBlocks(tree: GeneratedTree): Record<string, unknown> {
  return blocksFromReports(
    new Map([...tree.expected.codex].map(([p, r]) => [p, canonicalLedger(r)])),
    canonicalLedger(tree.expected.claude),
  );
}

type StatsBySource = Record<UsageSource, IndexStats>;

/** Read the tree through the index at `indexDir`; both readers must go through it, so the
 *  stats come back keyed by source and a reader that bypassed the index leaves a hole. */
async function readThroughIndex(
  tree: GeneratedTree,
  indexDir: string,
): Promise<{ blocks: Record<string, unknown>; stats: StatsBySource }> {
  const index = openUsageIndex({ dir: indexDir });
  if (index === null) throw new Error("the usage index did not open");
  const stats: Partial<StatsBySource> = {};
  const observed: Reconcile = (source, walked, whole, tail) => {
    const result = index.reconcile(source, walked, whole, tail);
    stats[source] = result.stats;
    return result;
  };
  try {
    const codex = await readCodexSessions(
      [join(tree.codexRoot, "sessions"), join(tree.codexRoot, "archived_sessions")],
      undefined,
      GOLDEN_TIME_ZONE,
      observed,
    );
    const claude = await readClaudeSessions(
      [join(tree.claudeRoot, "projects")],
      undefined,
      GOLDEN_TIME_ZONE,
      observed,
    );
    if (stats.codex === undefined || stats.claude === undefined) {
      throw new Error(`a reader bypassed the index (saw ${Object.keys(stats).join(", ")})`);
    }
    return {
      blocks: blocksFromReports(codex, claude),
      stats: { codex: stats.codex, claude: stats.claude },
    };
  } finally {
    index.close();
  }
}

const SOURCES: readonly UsageSource[] = ["codex", "claude"];

/** Cold then warm over ONE fresh index directory of its own (never the one runCost may
 *  populate), each held to `expected`; per source, the cold run parses every file whole and
 *  fails nothing, and the warm run reuses exactly those rows. */
async function checkIndexPaths(tree: GeneratedTree, expected: Record<string, unknown>) {
  const indexDir = join(freshRoot(), "index");
  const cold = await readThroughIndex(tree, indexDir);
  expect(describeMismatch(cold.blocks, expected)).toBeNull();
  const warm = await readThroughIndex(tree, indexDir);
  expect(describeMismatch(warm.blocks, expected)).toBeNull();
  for (const source of SOURCES) {
    const c = cold.stats[source];
    const w = warm.stats[source];
    // A fresh index has no row to resume from, so every cold parse is a whole one.
    expect(c.filesFailed, `${source} cold`).toBe(0);
    expect(c.filesReused, `${source} cold`).toBe(0);
    expect(c.filesParsedTail, `${source} cold`).toBe(0);
    expect(c.filesParsedWhole, `${source} cold`).toBeGreaterThan(0);
    expect(w.filesFailed, `${source} warm`).toBe(0);
    expect(w.filesParsedWhole + w.filesParsedTail, `${source} warm`).toBe(0);
    expect(w.filesReused, `${source} warm`).toBe(c.filesParsedWhole);
  }
}

for (const entry of GOLDEN_MATRIX) {
  const claim = entry.split
    ? "the pre-index payload plus exactly the planted line-splitting lines"
    : "the pre-index payload";

  test.skipIf(!UTC)(`${entry.name}: runCost reproduces ${claim}`, async () => {
    const { golden, generated } = await loadGolden(entry);
    const current = await runCurrentCostJson(generated.tree.root);
    expect(describeMismatch(current, expectedCurrent(golden, generated))).toBeNull();
    expect(current).toEqual(expectedCurrent(golden, generated));
    if (generated.delta !== null) {
      // The old reader really dropped them: the golden itself does not match.
      expect(describeMismatch(current, golden)).not.toBeNull();
      // And the current reader agrees with the generator's own ledger, planted lines included.
      expect(describeMismatch(sourceBlocks(current), ledgerBlocks(generated.tree))).toBeNull();
    }
  }, 120_000);

  test(
    `${entry.name}: the readers through the index, cold and warm, reproduce ${claim}`,
    async () => {
      const { golden, generated } = await loadGolden(entry);
      await checkIndexPaths(generated.tree, sourceBlocks(expectedCurrent(golden, generated)));
    },
    120_000,
  );
}

test("tamper control: one changed token count fails the golden comparison", async () => {
  const { golden } = await loadGolden(GOLDEN_MATRIX[0]!);
  const tampered = JSON.parse(JSON.stringify(golden)) as Record<string, unknown>;
  const claude = tampered.claudeSessions as { usageByModel: Record<string, { input: number }> };
  const model = Object.keys(claude.usageByModel).sort()[0]!;
  claude.usageByModel[model]!.input += 1;
  // Control for the control: an untouched copy still matches.
  expect(describeMismatch(JSON.parse(JSON.stringify(golden)), golden)).toBeNull();
  expect(describeMismatch(tampered, golden)).toContain("input");
  expect(tampered).not.toEqual(golden);
  // A payload carrying the runtime key compares without it, as the command's may.
  const withRuntime = JSON.stringify({ ...golden, runtime: { elapsedMs: 1 } });
  expect(describeMismatch(parseCostPayload(withRuntime, "x"), golden)).toBeNull();
});

test.skipIf(!UTC || !(EXTRA_MB > COMMITTED_MB))(
  `extra ${EXTRA_MB} MiB tree: runCost, cold index, and warm index agree with each other`,
  async () => {
    const entry: GoldenCase = {
      name: "extra",
      generator: generatorParams(EXTRA_MB, 1, true),
      split: false,
    };
    const { tree } = await generateGoldenTree(entry, freshRoot());
    const current = await runCurrentCostJson(tree.root);
    await checkIndexPaths(tree, sourceBlocks(current));
  },
  600_000,
);
