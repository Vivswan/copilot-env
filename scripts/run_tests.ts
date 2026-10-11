// The suite's launcher: one `bun test` process per file, so a file is its own process (the
// per-file temp root and the agent-state sandbox in test/helpers/testing.ts rest on that) and a
// wedged file cannot take the others with it.
//   bun's --timeout  -> a backstop above the helper's own per-test deadline (testing.ts), so bun
//                       never preempts the deadline race that tears a test's children down
//   output           -> a file's stdout and stderr are kept in arrival order and printed as one
//                       block when the file finishes, so parallel files never interleave
import { statSync } from "node:fs";
import { availableParallelism } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEST_DIR = join(ROOT, "test");
const TEST_GLOB = "**/*.test.ts";
const JOBS_ENV = "COPILOT_ENV_TEST_JOBS";
// Windows runners are the slow leg.
const PER_TEST_TIMEOUT_MS = process.platform === "win32" ? 120_000 : 60_000;

interface FileResult {
  file: string;
  exitCode: number;
  output: string;
  ms: number;
}

function usage(): string {
  return `Usage: bun scripts/run_tests.ts [PATH]...

Runs every ${TEST_GLOB} file under test/, or under each directory PATH, plus each file PATH,
one \`bun test\` process per file, ${JOBS_ENV} files at a time (default: min(4, the CPU count)).`;
}

function testFilesUnder(dir: string): string[] {
  return [...new Bun.Glob(TEST_GLOB).scanSync({ cwd: dir, absolute: true })].sort();
}

/** A directory expands to its test files here, never at `bun test`, which would run them all in
 *  one process. */
function testFiles(args: string[]): string[] {
  const flags = args.filter((arg) => arg.startsWith("-"));
  if (flags.length > 0) {
    throw new Error(`unknown flag ${flags[0]}: the launcher takes paths only\n\n${usage()}`);
  }
  if (args.length === 0) return testFilesUnder(TEST_DIR);
  return args.flatMap((arg) => {
    const path = resolve(arg);
    const entry = statSync(path, { throwIfNoEntry: false });
    if (entry === undefined) throw new Error(`no such test file or directory: ${path}`);
    return entry.isDirectory() ? testFilesUnder(path) : [path];
  });
}

function jobs(): number {
  const raw = process.env[JOBS_ENV];
  if (raw === undefined || raw === "") return Math.min(4, availableParallelism());
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`${JOBS_ENV} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return count;
}

/**
 * The parent's env, with NODE_ENV pinned to what it already is or to the empty string: `bun test`
 * sets NODE_ENV=test when it is unset, which consola reads as a test run and silences the info
 * output the logger tests assert on, in the test process and in every child that inherits its
 * env. `--no-env-file` on the same child keeps a .env in the checkout out of the suite.
 */
function childEnv(): Record<string, string | undefined> {
  return { ...process.env, NODE_ENV: process.env.NODE_ENV ?? "" };
}

/** Aborted on SIGINT or SIGTERM, so an interrupted run leaves no `bun test` behind. */
const cancel = new AbortController();

async function runFile(file: string): Promise<FileResult> {
  const started = performance.now();
  const child = Bun.spawn(
    [process.execPath, "test", "--no-env-file", "--timeout", String(PER_TEST_TIMEOUT_MS), file],
    {
      cwd: ROOT,
      env: childEnv(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      signal: cancel.signal,
      killSignal: "SIGKILL",
    },
  );
  const chunks: string[] = [];
  const collect = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) chunks.push(decoder.decode(chunk, { stream: true }));
    chunks.push(decoder.decode());
  };
  const [exitCode] = await Promise.all([
    child.exited,
    collect(child.stdout),
    collect(child.stderr),
  ]);
  return { file, exitCode, output: chunks.join(""), ms: performance.now() - started };
}

async function runAll(files: string[], limit: number): Promise<FileResult[]> {
  const queue = [...files];
  const results: FileResult[] = [];
  const worker = async (): Promise<void> => {
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
      const result = await runFile(file);
      results.push(result);
      report(result);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, files.length) }, worker));
  return results;
}

/** A file outside the checkout (the launcher test writes its fixtures under the suite temp root)
 *  keeps its absolute path. */
function displayName(file: string): string {
  const rel = relative(ROOT, file);
  return rel.startsWith("..") || isAbsolute(rel) ? file : rel;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** A failed file stays out of the GitHub Actions log group, so the failure shows without a click. */
function report(result: FileResult): void {
  const name = displayName(result.file);
  const passed = result.exitCode === 0;
  const header = `${name}: ${passed ? "passed" : `failed (exit ${result.exitCode})`} in ${seconds(
    result.ms,
  )}`;
  const group = passed && process.env.GITHUB_ACTIONS === "true";
  const open = group ? `::group::${header}` : `=== ${header}`;
  const close = group ? "::endgroup::\n" : "\n";
  process.stdout.write(`${open}\n${result.output}${close}`);
}

async function main(): Promise<number> {
  let files: string[];
  let limit: number;
  try {
    files = testFiles(process.argv.slice(2));
    limit = jobs();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  if (files.length === 0) {
    console.error(`no ${TEST_GLOB} files matched`);
    return 1;
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      cancel.abort();
      process.exit(130);
    });
  }
  const started = performance.now();
  const results = await runAll(files, limit);
  const failed = results.filter((result) => result.exitCode !== 0);
  console.log(
    `${results.length} test files: ${results.length - failed.length} passed, ${
      failed.length
    } failed, in ${seconds(performance.now() - started)}`,
  );
  for (const result of failed) console.log(`  failed: ${displayName(result.file)}`);
  return failed.length === 0 ? 0 : 1;
}

process.exitCode = await main();
