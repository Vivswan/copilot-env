// The generator's one smoke: the same seed writes the same bytes on every OS (the pinned
// digest), and the readers return exactly the usage an adversarial tree's ledger says it
// planted, per provider, per canonical model, per UTC day. The oracle is proven to bite:
// a raised snapshot, an extra count, and a moved timestamp each break the comparison.
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { discoverClaudeSessionRoots, readClaudeSessions } from "../src/usage/claude_sessions.ts";
import { discoverCodexSessionRoots, readCodexSessions } from "../src/usage/codex_sessions.ts";
import { canonicalModelName } from "../src/usage/pricing.ts";
import type { ModelUsage, ReadonlyUsageReport } from "../src/usage/usage.ts";
import { MILLISECONDS_PER_DAY } from "../src/utils/time.ts";
import { tmpDir } from "./helpers.ts";
import { expect, test } from "./helpers/testing.ts";
import {
  type ExpectedReport,
  type GeneratedTree,
  generateUsageTree,
} from "./helpers/usage_fixtures.ts";

const roots: string[] = [];
globalThis.addEventListener("unload", () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function freshRoot(): string {
  const root = tmpDir("usage-fixtures-");
  roots.push(root);
  return root;
}

const PINNED_CORPUS_DIGEST = "c690363809f606f6f680264f49d9aba0fac771ee171a38f848d613eea6694a16";

/** The ledger with its raw model ids folded onto the readers' canonical spelling. */
function canonical(report: ExpectedReport): ExpectedReport {
  const fold = (row: Map<string, ModelUsage>): Map<string, ModelUsage> => {
    const out = new Map<string, ModelUsage>();
    for (const [model, u] of row) {
      const key = canonicalModelName(model);
      const prev = out.get(key);
      out.set(
        key,
        prev === undefined ? { ...u } : {
          input: prev.input + u.input,
          output: prev.output + u.output,
          cacheRead: prev.cacheRead + u.cacheRead,
          cacheCreation: prev.cacheCreation + u.cacheCreation,
          events: prev.events + u.events,
        },
      );
    }
    return out;
  };
  return {
    byModel: fold(report.byModel),
    perDay: new Map([...report.perDay].map(([day, row]) => [day, fold(row)])),
  };
}

async function readBack(
  tree: GeneratedTree,
): Promise<{ codex: Map<string, ReadonlyUsageReport>; claude: ReadonlyUsageReport }> {
  return {
    codex: await readCodexSessions(discoverCodexSessionRoots([tree.codexRoot]), undefined, "UTC"),
    claude: await readClaudeSessions(
      discoverClaudeSessionRoots([tree.claudeRoot]),
      undefined,
      "UTC",
    ),
  };
}

function byModel(report: ReadonlyUsageReport): Record<string, unknown> {
  return Object.fromEntries([...report.byModel].sort(([a], [b]) => a.localeCompare(b)));
}

function perDay(report: ReadonlyUsageReport): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    [...report.perDay].sort(([a], [b]) => a.localeCompare(b)).map(([day, models]) => [
      day,
      Object.fromEntries([...models].sort(([a], [b]) => a.localeCompare(b))),
    ]),
  );
}

function textOf(file: string): string {
  const raw = readFileSync(file);
  return file.endsWith(".zst") ? zstdDecompressSync(raw).toString("utf8") : raw.toString("utf8");
}

/** Every report of a tree equals its ledger, roll-up and per-day split alike. */
function expectLedgerMatch(tree: GeneratedTree, got: Awaited<ReturnType<typeof readBack>>): void {
  expect([...got.codex.keys()].sort()).toEqual([...tree.expected.codex.keys()].sort());
  for (const [provider, expected] of tree.expected.codex) {
    const report = got.codex.get(provider)!;
    expect(byModel(report)).toEqual(byModel(canonical(expected)));
    expect(perDay(report)).toEqual(perDay(canonical(expected)));
  }
  expect(byModel(got.claude)).toEqual(byModel(canonical(tree.expected.claude)));
  expect(perDay(got.claude)).toEqual(perDay(canonical(tree.expected.claude)));
}

/** The JSONL lines of the first file of `source` whose text carries `needle`. */
function linesOf(tree: GeneratedTree, source: "codex" | "claude", needle: string) {
  const file = tree.files.find((f) => f.source === source && textOf(f.path).includes(needle))!;
  const lines = readFileSync(file.path, "utf8").split("\n").filter((l) => l !== "");
  return { file, lines, at: lines.findIndex((l) => l.includes(needle)) };
}

test(
  "generateUsageTree writes the pinned bytes, and the readers return exactly its ledger",
  async () => {
    // The cross-OS pin: one seed, one digest over every file's relative path and bytes.
    const pinnedRoot = freshRoot();
    const pinned = await generateUsageTree({ root: pinnedRoot, mb: 1, seed: 7, days: 5 });
    const hash = createHash("sha256");
    for (
      const entry of pinned.files
        .map((f) => ({ rel: relative(pinnedRoot, f.path).replaceAll("\\", "/"), path: f.path }))
        .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
    ) {
      hash.update(`${entry.rel}\n`);
      hash.update(readFileSync(entry.path));
    }
    expect(hash.digest("hex")).toBe(PINNED_CORPUS_DIGEST);

    // The drift canary: an adversarial tree (forks, an archived duplicate, repeated counts,
    // resumes, a torn tail, pasted needles) reads back as exactly what the ledger booked,
    // with more than one day and more than one provider in play.
    const tree = await generateUsageTree({ root: freshRoot(), mb: 5, seed: 20260904 });
    expect(discoverCodexSessionRoots([tree.codexRoot]).length).toBe(2);
    const got = await readBack(tree);
    expectLedgerMatch(tree, got);
    expect([...got.codex.values()].some((r) => r.perDay.size > 1)).toBe(true);
    expect(got.claude.perDay.size).toBeGreaterThan(1);

    // The oracle bites, three ways, on a plain tree: a raised Claude snapshot and an extra
    // Codex count move the roll-ups; a message moved a day later leaves the roll-up alone
    // and moves the per-day split.
    const plain = await generateUsageTree({
      root: freshRoot(),
      mb: 2,
      seed: 11,
      adversarial: false,
    });
    expectLedgerMatch(plain, await readBack(plain));
    const claude = linesOf(plain, "claude", '"type":"assistant"');
    const raised = JSON.parse(claude.lines[claude.at]!) as {
      "message": { "usage": { "output_tokens": number } };
    };
    raised.message.usage.output_tokens += 1_000;
    writeFileSync(claude.file.path, `${[...claude.lines, JSON.stringify(raised)].join("\n")}\n`);
    const codex = linesOf(plain, "codex", '"token_count"');
    const extra = JSON.parse(codex.lines[codex.at]!) as {
      "payload": { "info": { "total_token_usage": { "total_tokens": number } } };
    };
    extra.payload.info.total_token_usage.total_tokens += 1;
    writeFileSync(codex.file.path, `${[...codex.lines, JSON.stringify(extra)].join("\n")}\n`);
    const tampered = await readBack(plain);
    expect(byModel(tampered.claude)).not.toEqual(byModel(canonical(plain.expected.claude)));
    expect(
      [...plain.expected.codex].some(([provider, expected]) =>
        JSON.stringify(byModel(tampered.codex.get(provider)!)) !==
          JSON.stringify(byModel(canonical(expected)))
      ),
    ).toBe(true);

    const shifted = await generateUsageTree({
      root: freshRoot(),
      mb: 2,
      seed: 11,
      adversarial: false,
    });
    const target = linesOf(shifted, "claude", '"type":"assistant"');
    const moved = JSON.parse(target.lines[target.at]!) as { timestamp: string };
    moved.timestamp = new Date(Date.parse(moved.timestamp) + MILLISECONDS_PER_DAY).toISOString();
    target.lines[target.at] = JSON.stringify(moved);
    writeFileSync(target.file.path, `${target.lines.join("\n")}\n`);
    const day = await readBack(shifted);
    expect(byModel(day.claude)).toEqual(byModel(canonical(shifted.expected.claude)));
    expect(perDay(day.claude)).not.toEqual(perDay(canonical(shifted.expected.claude)));
  },
  120_000,
);
