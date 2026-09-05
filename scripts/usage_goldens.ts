// Record the `agent cost --json` goldens from the OLD cli (a detached worktree of
// PRE_INDEX_COMMIT). Nothing is written unless every entry validates against the current run.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FIXTURES_DIR } from "../test/helpers/usage_fixtures.ts";
import {
  describeMismatch,
  expectedCurrent,
  generateGoldenTree,
  GOLDEN_COST_ARGS,
  GOLDEN_MATRIX,
  GOLDEN_TIME_ZONE,
  type GoldenCase,
  goldenFilesFor,
  parseCostPayload,
  PRE_INDEX_COMMIT,
  type Recording,
  runCurrentCostJson,
  sourceEventCounts,
  stableStringify,
  treeSha256,
  usageTreeEnv,
  utcPinnable,
} from "../test/helpers/usage_goldens.ts";

function usage(): string {
  return `Usage: deno task usage:goldens [--out DIR]

Records test/fixtures/usage/<name>.json (the old cli's payload) and <name>.recording.json
for every entry of the golden matrix. Nothing is written unless every entry passes: the old
cli read both sources, and the current implementation printed the same payload (plus exactly
the planted lines' usage for the split case). The old code runs from a detached git worktree
of ${PRE_INDEX_COMMIT.slice(0, 7)} that this script creates, installs (deno ci), and removes.
The child runs with TZ=UTC, which deno honors on unix only; a Windows host must run in UTC.

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
        Deno.exit(0);
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
  const out = new Deno.Command(cmd, {
    args: argv,
    cwd: opts.cwd,
    env: opts.env,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  const text = new TextDecoder();
  if (out.code !== 0) throw new Error(`${what} exited ${out.code}:\n${text.decode(out.stderr)}`);
  return text.decode(out.stdout);
}

/** This process's deno cache directory, for the child to share instead of fetching the
 *  old checkout's dependencies again under the tree's HOME. */
function denoDir(): string {
  const fromEnv = Deno.env.get("DENO_DIR");
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const parsed = JSON.parse(run("deno info", Deno.execPath(), ["info", "--json"])) as {
    denoDir?: unknown;
  };
  if (typeof parsed.denoDir !== "string") throw new Error("deno info reported no denoDir");
  return parsed.denoDir;
}

/** The OLD cli's `cost` payload over the tree at `root`. */
function runOldCostJson(old: string, root: string, cache: string): Record<string, unknown> {
  const stdout = run(
    "the old cli",
    Deno.execPath(),
    ["run", "-P=cli", "src/cli.ts", ...GOLDEN_COST_ARGS],
    {
      cwd: old,
      env: {
        ...Deno.env.toObject(),
        ...usageTreeEnv(root),
        COPILOT_ENV_ROOT_HOME: "",
        TZ: GOLDEN_TIME_ZONE,
        DENO_DIR: cache,
      },
    },
  );
  return parseCostPayload(stdout, "the old cli");
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
  const payload = runOldCostJson(old, root, cache);
  const events = sourceEventCounts(payload);
  const silent = Object.entries(events).filter(([, n]) => n === 0).map(([s]) => s);
  if (!Object.keys(events).some((s) => s.startsWith("codex:")) || silent.length > 0) {
    throw new Error(`${entry.name}: the old cli read nothing from ${silent.join(", ") || "codex"}`);
  }
  const current = await runCurrentCostJson(root);
  const mismatch = describeMismatch(current, expectedCurrent(payload, generated));
  if (mismatch !== null) {
    throw new Error(
      `${entry.name}: the current implementation is not the old one${
        entry.split ? " plus the planted lines" : ""
      }\n  ${mismatch}`,
    );
  }
  return { entry, recording, payload, events };
}

async function main(args: { out: string }): Promise<void> {
  if (!utcPinnable()) {
    throw new Error(
      "this host cannot pin the per-day split to UTC (a Windows host must itself run in UTC)",
    );
  }
  const scratch = await Deno.makeTempDir({ prefix: "usage-goldens-" });
  // The worktree gets its own directory, never one inside the scratch: only git removes it.
  const worktree = await Deno.makeTempDir({ prefix: "usage-goldens-old-" });
  try {
    run("git worktree add", "git", ["worktree", "add", "--detach", worktree, PRE_INDEX_COMMIT]);
    run("deno ci", Deno.execPath(), ["ci"], { cwd: worktree });
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
  await main(parseArgs(Deno.args));
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  Deno.exit(1);
}
