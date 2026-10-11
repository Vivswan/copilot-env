// The suite's launcher: one `bun test` process per file, so a file is its own process (the
// per-file temp root and the agent-state sandbox in test/helpers/testing.ts rest on that) and a
// wedged file cannot take the others with it.
//   bun's --timeout  -> a backstop above the helper's own per-test deadline (testing.ts), so bun
//                       never preempts the deadline race that tears a test's children down
//   output           -> a file's stdout and stderr are kept in arrival order and printed as one
//                       block when the file finishes, so parallel files never interleave
//   *.e2e.test.ts    -> the realistic files (a process, a listener, a home-shaped sandbox, a real
//                       CLI or the network) run in CI or under --e2e only; --unit leaves them out
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, CommanderError, Option } from "commander";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEST_DIR = join(ROOT, "test");
const TEST_GLOB = "**/*.test.ts";
const TEST_SUFFIX = ".test.ts";
const E2E_SUFFIX = ".e2e.test.ts";
const JOBS_ENV = "COPILOT_ENV_TEST_JOBS";
/** A persistent HOME for every `bun test` child, in place of the per-child scratch one. Every
 *  child also receives it set to the HOME it runs under: test/helpers/home_guard.ts refuses a
 *  test file whose HOME this variable does not name. */
const TEST_HOME_ENV = "COPILOT_ENV_TEST_HOME";
// Windows runners are the slow leg.
const PER_TEST_TIMEOUT_MS = process.platform === "win32" ? 120_000 : 60_000;

interface FileResult {
  file: string;
  exitCode: number;
  output: string;
  ms: number;
}

interface Selection {
  paths: string[];
  unit: boolean;
  e2e: boolean;
}

function usage(): Command {
  return new Command("bun scripts/run_tests.ts")
    .description(
      `Runs every ${TEST_GLOB} file under test/, or under each directory PATH, plus each file PATH, one \`bun test\` process per file, ${JOBS_ENV} files at a time (default: min(4, the CPU count)).`,
    )
    .argument("[path...]", "a test file, or a directory of them")
    .addOption(
      new Option("--unit", `only the unit files: every *${E2E_SUFFIX} file is left out`).conflicts(
        "e2e",
      ),
    )
    .option("--e2e", `run the *${E2E_SUFFIX} files outside CI (GITHUB_ACTIONS=true or CI=true)`)
    .exitOverride();
}

/** Case-blind: on a case-insensitive filesystem a path spelled `.E2E.test.ts` names the same
 *  realistic file, and a name that only looks like one costs nothing on the others. */
function isE2e(file: string): boolean {
  return file.toLowerCase().endsWith(E2E_SUFFIX);
}

function testFilesUnder(dir: string): string[] {
  return [...new Bun.Glob(TEST_GLOB).scanSync({ cwd: dir, absolute: true })].sort();
}

/** The selection, or the exit code commander settled on after printing its own message. */
function parseArgs(args: string[]): Selection | number {
  const program = usage();
  try {
    program.parse(args, { from: "user" });
  } catch (err) {
    if (!(err instanceof CommanderError)) throw err;
    return err.exitCode === 0 ? 0 : 2;
  }
  const flags = program.opts<{ unit?: boolean; e2e?: boolean }>();
  return { paths: program.args, unit: flags.unit === true, e2e: flags.e2e === true };
}

/** A directory expands to its test files here, never at `bun test`, which would run them all in
 *  one process. A file named outright is held to the same name rule as a discovered one: a name
 *  outside TEST_GLOB (an .spec.ts, say) would otherwise pass the e2e gate unexamined. A file
 *  --unit leaves out is an error, not a silent skip. */
function testFiles(selection: Selection): string[] {
  const named: string[] = [];
  const expanded: string[] = [];
  for (const arg of selection.paths) {
    const path = resolve(arg);
    const entry = statSync(path, { throwIfNoEntry: false });
    if (entry === undefined) throw new Error(`no such test file or directory: ${path}`);
    if (entry.isDirectory()) expanded.push(...testFilesUnder(path));
    else if (!path.endsWith(TEST_SUFFIX)) {
      throw new Error(`not a test file (${TEST_GLOB}): ${displayName(path)}`);
    } else named.push(path);
  }
  if (selection.paths.length === 0) expanded.push(...testFilesUnder(TEST_DIR));
  if (selection.unit) {
    const excluded = named.find(isE2e);
    if (excluded !== undefined) {
      throw new Error(`--unit leaves out ${displayName(excluded)}: it is a *${E2E_SUFFIX} file`);
    }
    return [...named, ...expanded.filter((file) => !isE2e(file))];
  }
  return [...named, ...expanded];
}

function e2eAllowed(selection: Selection): boolean {
  return selection.e2e || process.env.GITHUB_ACTIONS === "true" || process.env.CI === "true";
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
 * The parent's env with NODE_ENV pinned and HOME at `home`: `bun test` sets NODE_ENV=test when
 * it is unset, which consola reads as a test run and silences the info output the logger tests
 * assert on, in the test process and in every child that inherits its env (test/helpers/testing.ts
 * pins the same value once loaded). `--no-env-file` on the same child keeps a .env in the
 * checkout out of the suite.
 */
function childEnv(home: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: "development",
    HOME: home,
    [TEST_HOME_ENV]: home,
  };
  if (process.platform === "win32") env.USERPROFILE = home;
  return env;
}

/** Scratch homes of the children still running, removed on an interrupt too. */
const liveHomes = new Set<string>();

/** The child's HOME: the persistent TEST_HOME_ENV directory, else a scratch one removed with the
 *  child. Bun reads os.homedir() once at startup, so a HOME the test helpers retarget later never
 *  reaches it: the child must START under this one, or a path resolved through homedir() lands in
 *  the developer's real home. */
function childHome(): { home: string; dispose: () => void } {
  const persistent = process.env[TEST_HOME_ENV];
  if (persistent !== undefined && persistent !== "") {
    const home = resolve(persistent);
    mkdirSync(home, { recursive: true });
    return { home, dispose: () => {} };
  }
  const home = mkdtempSync(join(tmpdir(), "copilot-env-test-home-"));
  liveHomes.add(home);
  return {
    home,
    dispose: () => {
      liveHomes.delete(home);
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** Aborted on SIGINT or SIGTERM, so an interrupted run leaves no `bun test` behind. */
const cancel = new AbortController();

async function runFile(file: string): Promise<FileResult> {
  const started = performance.now();
  const { home, dispose } = childHome();
  try {
    const child = Bun.spawn(
      [process.execPath, "test", "--no-env-file", "--timeout", String(PER_TEST_TIMEOUT_MS), file],
      {
        cwd: ROOT,
        env: childEnv(home),
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
  } finally {
    dispose();
  }
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
    const selection = parseArgs(process.argv.slice(2));
    if (typeof selection === "number") return selection;
    files = testFiles(selection);
    limit = jobs();
    const e2e = files.filter(isE2e);
    if (e2e.length > 0 && !e2eAllowed(selection)) {
      throw new Error(
        `${e2e.length} *${E2E_SUFFIX} file${e2e.length === 1 ? "" : "s"} selected: the realistic tests run in CI (GITHUB_ACTIONS=true or CI=true) or under --e2e; \`bun run test:unit\` runs the unit files alone`,
      );
    }
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
      for (const home of liveHomes) rmSync(home, { recursive: true, force: true });
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
