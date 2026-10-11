// Record the `agent cost --json` goldens from the OLD cli (a detached worktree of
// PRE_INDEX_COMMIT). Nothing is written unless every entry validates against the current run.
// The old cli is a deno checkout, so it runs under the `deno` on PATH (the sidecar the daemon
// needs anyway); this script and the current cli run under bun.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FIXTURES_DIR } from "../../test/helpers/usage_fixtures.ts";
import {
  describeMismatch,
  expectedCurrent,
  generateGoldenTree,
  GOLDEN_COST_ARGS,
  GOLDEN_MATRIX,
  GOLDEN_TIME_ZONE,
  type GoldenCase,
  goldenFilesFor,
  NOTE_KEY,
  parseCostPayload,
  PRE_INDEX_COMMIT,
  type Recording,
  runCurrentCost,
  sourceEventCounts,
  treeSha256,
  usageTreeEnv,
  utcPinnable,
} from "../../test/helpers/usage_goldens.ts";
import { stableStringify } from "../../src/utils/json.ts";

function usage(): string {
  return `Usage: bun run usage:goldens [--out DIR]

Records test/fixtures/usage/<name>.json (the old cli's payload) and <name>.recording.json
for every entry of the golden matrix. Nothing is written unless every entry passes: the old
cli read both sources, and the current implementation printed the same payload (plus exactly
the planted lines' usage for the split case). The old code is a deno checkout: it runs from a
detached git worktree of ${PRE_INDEX_COMMIT.slice(0, 7)} that this script creates, installs
(deno ci, with the deno on PATH), and removes. The child runs with TZ=UTC, which deno honors
on unix only; a Windows host must run in UTC.

  --out DIR   where the goldens go (default ${FIXTURES_DIR})`;
}

function parseArgs(argv: string[]): { out: string } {
  const args = { out: FIXTURES_DIR };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    switch (arg) {
      case "--help":
      case "-h":
        console.log(usage());
        process.exit(0);
        break;
      case "--out":
        if (value === undefined) throw new Error("--out needs a directory");
        args.out = value;
        i++;
        break;
      default:
        throw new Error(`unknown argument '${arg}'\n\n${usage()}`);
    }
  }
  return args;
}

/** Run a child to completion; a non-zero exit is an error carrying its stderr. */
function run(
  what: string,
  cmd: string,
  argv: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): string {
  const out = spawnSync(cmd, argv, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (out.error !== undefined) throw new Error(`${what} did not run: ${out.error.message}`);
  if (out.status !== 0) throw new Error(`${what} exited ${out.status}:\n${out.stderr}`);
  return out.stdout;
}

const DENO = "deno";
const denoEnv = { ...process.env, DENO_NO_UPDATE_CHECK: "1" };

/** The PATH deno's cache directory, for the old cli to share: its runs get the tree's HOME,
 *  and an unpinned cache would fetch the old checkout's dependencies into the measured tree. */
function denoDir(): string {
  const fromEnv = process.env.DENO_DIR;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const parsed = JSON.parse(run("deno info", DENO, ["info", "--json"], { env: denoEnv })) as {
    denoDir?: unknown;
  };
  if (typeof parsed.denoDir !== "string") throw new Error("deno info reported no denoDir");
  return parsed.denoDir;
}

/** The OLD cli's `cost` payload over the tree at `root`, plus its own note: parseCostPayload
 *  swaps the note for its sentinel, and the fixture on disk keeps what the old cli printed. */
function runOldCostJson(
  old: string,
  root: string,
  cache: string,
): { payload: Record<string, unknown>; note: unknown } {
  const stdout = run(
    "the old cli",
    DENO,
    ["run", "-P=cli", "src/cli.ts", ...GOLDEN_COST_ARGS],
    {
      cwd: old,
      env: {
        ...denoEnv,
        ...usageTreeEnv(root),
        COPILOT_ENV_ROOT_HOME: "",
        TZ: GOLDEN_TIME_ZONE,
        DENO_DIR: cache,
      },
    },
  );
  return {
    payload: parseCostPayload(stdout, "the old cli"),
    note: (JSON.parse(stdout) as Record<string, unknown>)[NOTE_KEY],
  };
}

interface Recorded {
  entry: GoldenCase;
  recording: Recording;
  payload: Record<string, unknown>;
  events: Record<string, number>;
}

/** Generate, run both implementations, and validate one matrix entry; nothing is written. */
async function recordEntry(
  entry: GoldenCase,
  old: string,
  cache: string,
  scratch: string,
): Promise<Recorded> {
  const root = path.join(scratch, entry.name);
  const generated = await generateGoldenTree(entry, root);
  const recording: Recording = {
    generator: entry.generator,
    split: entry.split,
    treeSha256: treeSha256(generated.tree),
    oldCommit: PRE_INDEX_COMMIT,
    args: [...GOLDEN_COST_ARGS],
    timeZone: GOLDEN_TIME_ZONE,
  };
  const { payload, note } = runOldCostJson(old, root, cache);
  const events = sourceEventCounts(payload);
  const silent = Object.entries(events).filter(([, n]) => n === 0).map(([s]) => s);
  if (!Object.keys(events).some((s) => s.startsWith("codex:")) || silent.length > 0) {
    throw new Error(`${entry.name}: the old cli read nothing from ${silent.join(", ") || "codex"}`);
  }
  const { payload: current } = await runCurrentCost(root, { noIndex: true });
  const mismatch = describeMismatch(current, expectedCurrent(payload, generated));
  if (mismatch !== null) {
    throw new Error(
      `${entry.name}: the current implementation is not the old one${
        entry.split ? " plus the planted lines" : ""
      }\n  ${mismatch}`,
    );
  }
  return { entry, recording, payload: { ...payload, [NOTE_KEY]: note }, events };
}

async function main(args: { out: string }): Promise<void> {
  if (!utcPinnable()) {
    throw new Error(
      "this host cannot pin the per-day split to UTC (a Windows host must itself run in UTC)",
    );
  }
  const scratch = mkdtempSync(path.join(tmpdir(), "usage-goldens-"));
  // The worktree gets its own directory, never one inside the scratch: only git removes it.
  const worktree = mkdtempSync(path.join(tmpdir(), "usage-goldens-old-"));
  try {
    run("git worktree add", "git", ["worktree", "add", "--detach", worktree, PRE_INDEX_COMMIT]);
    run("deno ci", DENO, ["ci"], { cwd: worktree, env: denoEnv });
    const cache = denoDir();
    const recorded: Recorded[] = [];
    for (const entry of GOLDEN_MATRIX) {
      recorded.push(await recordEntry(entry, worktree, cache, scratch));
    }
    // Every entry validated: only now does anything land in the fixtures directory.
    mkdirSync(args.out, { recursive: true });
    for (const { entry, recording, payload, events } of recorded) {
      const files = goldenFilesFor(entry.name, args.out);
      writeFileSync(files.goldenPath, `${stableStringify(payload)}\n`);
      writeFileSync(files.recordingPath, `${stableStringify(recording)}\n`);
      console.log(JSON.stringify({
        name: entry.name,
        wrote: [files.goldenPath, files.recordingPath],
        treeSha256: recording.treeSha256,
        events,
      }));
    }
  } finally {
    run("git worktree remove", "git", ["worktree", "remove", "--force", worktree]);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

try {
  await main(parseArgs(process.argv.slice(2)));
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
