// The current `agent cost` reproduces the pre-index goldens (test/helpers/usage_goldens.ts)
// through runCost and through the index cold and warm. In process throughout; no child runs.
import { join } from "node:path";
import { buildSourceJson, type CostRuntime } from "../../src/usage/cost.ts";
import { estimateCost, type PricingTier } from "../../src/usage/pricing.ts";
import type { ReadonlyUsageReport } from "../../src/usage/usage.ts";
import { must } from "../../src/utils/assert.ts";
import { expect, tempDir, test } from "../helpers/testing.ts";
import type { GeneratedTree } from "../helpers/usage_fixtures.ts";
import {
  canonicalLedger,
  describeMismatch,
  expectedCurrent,
  GOLDEN_COST_ARGS,
  GOLDEN_MATRIX,
  type GoldenCase,
  type GoldenTree,
  generateGoldenTree,
  goldenFilesFor,
  PRE_INDEX_COMMIT,
  parseCostPayload,
  readRecording,
  readText,
  runCurrentCost,
  sourceEventCounts,
  treeSha256,
  utcPinnable,
} from "../helpers/usage_goldens.ts";

/** runCost cuts days in the system zone: pin UTC, or skip (a Windows host outside UTC cannot). */
const UTC = utcPinnable();

interface Golden {
  /** The case, as GOLDEN_MATRIX lists it. */
  entry: GoldenCase;

  /** What the old cli printed. */
  golden: Record<string, unknown>;

  /** The case's tree, rebuilt in a temp dir; its digest must match the recording's. */
  generated: GoldenTree;
}

/** One load per case, shared by every test over it. */
const loaded = new Map<string, Promise<Golden>>();

/** The digest check reports a generator drift as such rather than as a cost mismatch; the events
 *  check keeps a golden from pinning nothing. */
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
      const generated = await generateGoldenTree(entry, tempDir("usage-golden-"));
      expect(
        treeSha256(generated.tree),
        `${entry.name}: the generator no longer writes the recorded tree`,
      ).toBe(recording.treeSha256);
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
    buildSourceJson(report, estimateCost(report, NO_PRICING), NO_PRICING, {
      perDay: true,
    });
  return JSON.parse(
    JSON.stringify({
      codex: Object.fromEntries(
        [...codex.keys()]
          .sort()
          .map((p) => [p, block(must(codex.get(p), "p is one of the map's own keys"))]),
      ),
      claude: block(claude),
    }),
  );
}

/** The generator's own ledger for a tree, as source blocks. */
function ledgerBlocks(tree: GeneratedTree): Record<string, unknown> {
  return blocksFromReports(
    new Map([...tree.expected.codex].map(([p, r]) => [p, canonicalLedger(r)])),
    canonicalLedger(tree.expected.claude),
  );
}

/**
 * The three read paths over one tree, each held to `expected`: `--no-index`, then cold and
 * warm through the index in a fresh copilot-api home. The stats prove BOTH readers went
 * through the index: the summed file count equals the tree's, and the warm run reuses exactly
 * the rows the cold run parsed and reads no bytes (a reader that bypassed it would parse again).
 */
async function checkReadPaths(tree: GeneratedTree, expected: Record<string, unknown>) {
  const plain = await runCurrentCost(tree.root, { noIndex: true });
  expect(plain.runtime.indexed).toBe(false);
  expect(describeMismatch(plain.payload, expected)).toBeNull();

  const copilotApiHome = join(tempDir("usage-golden-"), "copilot-env");
  const cold = await runCurrentCost(tree.root, { copilotApiHome });
  expect(describeMismatch(cold.payload, expected)).toBeNull();
  const warm = await runCurrentCost(tree.root, { copilotApiHome });
  expect(describeMismatch(warm.payload, expected)).toBeNull();
  expectColdThenWarm(cold.runtime, warm.runtime, tree.files.length);
  return plain.payload;
}

function expectColdThenWarm(cold: CostRuntime, warm: CostRuntime, files: number): void {
  expect(cold.indexed).toBe(true);
  expect(cold.index.filesSeen).toBe(files);
  expect(cold.index.filesFailed).toBe(0);
  expect(cold.index.filesReused).toBe(0);
  expect(cold.index.filesParsedTail).toBe(0);
  expect(cold.index.filesParsedWhole).toBeGreaterThan(0);
  expect(warm.indexed).toBe(true);
  expect(warm.index.filesFailed).toBe(0);
  expect(warm.index.filesParsedWhole + warm.index.filesParsedTail).toBe(0);
  expect(warm.index.filesReused).toBe(cold.index.filesParsedWhole);
  expect(warm.index.filesSeen).toBe(cold.index.filesSeen);
  expect(warm.index.bytesRead).toBe(0);
}

for (const entry of GOLDEN_MATRIX) {
  const claim = entry.split
    ? "the pre-index payload plus exactly the planted line-splitting lines"
    : "the pre-index payload";

  test.skipIf(!UTC)(
    `${entry.name}: runCost without, cold, and warm index reproduces ${claim}`,
    async () => {
      const { golden, generated } = await loadGolden(entry);
      const expected = expectedCurrent(golden, generated);
      const current = await checkReadPaths(generated.tree, expected);
      expect(current).toEqual(expected);
      if (generated.delta !== null) {
        // The old reader really dropped them: the golden itself does not match.
        expect(describeMismatch(current, golden)).not.toBeNull();
        // And the current reader agrees with the generator's own ledger, planted lines included.
        expect(describeMismatch(sourceBlocks(current), ledgerBlocks(generated.tree))).toBeNull();
      }
    },
    120_000,
  );
}

test("tamper control: one changed token count fails the golden comparison", async () => {
  const { golden } = await loadGolden(must(GOLDEN_MATRIX[0], "the golden matrix has a case"));
  const tampered = JSON.parse(JSON.stringify(golden)) as Record<string, unknown>;
  const claude = tampered.claudeSessions as { usageByModel: Record<string, { input: number }> };
  const model = must(Object.keys(claude.usageByModel).sort()[0], "the golden's claude has a model");
  must(claude.usageByModel[model], "model is one of usageByModel's own keys").input += 1;
  // Control for the control: an untouched copy still matches.
  expect(describeMismatch(JSON.parse(JSON.stringify(golden)), golden)).toBeNull();
  expect(describeMismatch(tampered, golden)).toContain("input");
  expect(tampered).not.toEqual(golden);
  // A payload carrying the runtime key compares without it, as the command's may.
  const withRuntime = JSON.stringify({ ...golden, runtime: { elapsedMs: 1 } });
  expect(describeMismatch(parseCostPayload(withRuntime, "x"), golden)).toBeNull();
});
