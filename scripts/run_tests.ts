// The suite's launcher: one `bun test` process per file, so a file is its own process (the
// per-file temp root and the agent-state sandbox in test/helpers/testing.ts rest on that) and a
// wedged file cannot take the others with it.
//   bun's --timeout  -> a backstop above the helper's own per-test deadline (testing.ts), so bun
//                       never preempts the deadline race that tears a test's children down
//   output           -> a file's stdout and stderr are kept in arrival order and printed as one
//                       block when the file finishes, so parallel files never interleave
//   *.e2e.test.ts    -> the realistic files (a process, a listener, a home-shaped sandbox, a real
//                       CLI or the network) run in CI or under --e2e only; --unit leaves them out
//   a Bun panic      -> a file whose process Bun itself killed runs once more and the second run
//                       is judged; a test failure and the budget kill are final
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deadline } from "@std/async";
import { Command, CommanderError, Option } from "commander";
import treeKill from "tree-kill";

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
/** The whole file, wall clock: bun's --timeout covers test bodies only, so a file that never
 *  registers one (a module-scope await that never settles) would otherwise hold the run until the
 *  workflow's own timeout. Generous: the longest file takes a quarter of it. */
const FILE_BUDGET_MS = 10 * 60_000;
const FILE_BUDGET_ENV = "COPILOT_ENV_TEST_FILE_BUDGET_MS";
/** The pipes settle with the child unless a descendant still holds them. */
const PIPE_GRACE_MS = 5_000;
/** Bun dying of its own fault: this exit code AND a panic line in the output (a test failure is
 *  exit 1, whatever it prints). Bun's crash handler labels the line by the thread that died:
 *  `panic(main thread): `, on Windows `panic(thread 7032): ` or `panic(<thread name>): `, and a
 *  bare `panic: ` for a thread on macOS or Linux. The case: Bun 1.4.x segfaults on the Windows
 *  runner about one run in three. */
const BUN_PANIC_EXIT = 3;
const BUN_PANIC_LINE = /^panic(\([^)]*\))?: /m;

interface FileResult {
  file: string;
  exitCode: number;
  output: string;
  ms: number;
  panicked: boolean;
}

interface Selection {
  paths: string[];
  unit: boolean;
  e2e: boolean;
}

function usage(): Command {
  return new Command("bun scripts/run_tests.ts")
    .description(
      `Runs every ${TEST_GLOB} file under test/, or under each directory PATH, plus each file PATH, ` +
        `one \`bun test\` process per file, ${JOBS_ENV} files at a time (default: min(4, the CPU ` +
        `count)), each file killed and failed past ${FILE_BUDGET_ENV} ms (default: ${FILE_BUDGET_MS}).`,
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

function fileBudgetMs(): number {
  const raw = process.env[FILE_BUDGET_ENV];
  if (raw === undefined || raw === "") return FILE_BUDGET_MS;
  const ms = Number(raw);
  if (!Number.isInteger(ms) || ms < 1) {
    throw new Error(`${FILE_BUDGET_ENV} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return ms;
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

async function runFile(file: string, budgetMs: number): Promise<FileResult> {
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
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    const collect = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
      const reader = stream.getReader();
      readers.push(reader);
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(decoder.decode(value, { stream: true }));
      }
      chunks.push(decoder.decode());
    };
    const settled = Promise.all([collect(child.stdout), collect(child.stderr)]);
    let overran = false;
    let killed: Promise<void> = Promise.resolve();
    const timer = setTimeout(() => {
      overran = true;
      // The whole tree: a test that hangs after spawning a daemon never reaches its teardown,
      // and a kill of the one pid would leave that daemon running.
      killed = killTree(child);
    }, budgetMs);
    const exitCode = await child.exited.finally(() => clearTimeout(timer));
    await killed;
    // A descendant that inherited the pipes and outlived the child keeps them open: past the
    // grace the readers are cancelled, which releases the pipes, so the launcher can exit.
    try {
      await deadline(settled, PIPE_GRACE_MS);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "TimeoutError")) throw error;
      for (const reader of readers) await reader.cancel();
    }
    const output = overran
      ? `${chunks.join("")}\n${displayName(file)} ran past the launcher's file budget (${seconds(
          budgetMs,
        )}) and was killed\n`
      : chunks.join("");
    const panicked = !overran && exitCode === BUN_PANIC_EXIT && BUN_PANIC_LINE.test(output);
    return {
      file,
      exitCode: overran ? 1 : exitCode,
      output,
      ms: performance.now() - started,
      panicked,
    };
  } finally {
    dispose();
  }
}

/** tree-kill lists descendants through this tool on POSIX; without it the listing would be an
 *  unhandled spawn error inside the package, not a callback. */
const TREE_LISTER =
  process.platform === "darwin" ? "pgrep" : process.platform === "linux" ? "ps" : null;

/** Resolves either way, and the child itself is dead either way: a tree already gone is the
 *  wanted state; a refused tree kill is said and the one pid is killed directly, so the budget
 *  still ends the file, though its descendants may survive. */
function killTree(child: Bun.Subprocess): Promise<void> {
  const pid = child.pid;
  const alone = (reason: string): void => {
    console.error(`run_tests: ${reason}; killing pid ${pid} alone, so its descendants may survive`);
    child.kill("SIGKILL");
  };
  if (TREE_LISTER !== null && Bun.which(TREE_LISTER) === null) {
    alone(`${TREE_LISTER} is not on PATH, so the process tree under pid ${pid} cannot be listed`);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    treeKill(pid, "SIGKILL", (error) => {
      // Windows reports success as a null error (exec's callback shape), POSIX as none.
      // exec's error text (the Windows branch) carries the command's stderr on further lines.
      if (error) {
        const detail = error.message.replace(/\s+/g, " ").trim();
        alone(`could not kill the process tree under pid ${pid}: ${detail}`);
      }
      resolve();
    });
  });
}

async function runAll(files: string[], limit: number, budgetMs: number): Promise<FileResult[]> {
  const queue = [...files];
  const results: FileResult[] = [];
  const worker = async (): Promise<void> => {
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
      let result = await runFile(file, budgetMs);
      if (result.panicked) {
        report(result, "retrying");
        result = await runFile(file, budgetMs);
      }
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
function report(result: FileResult, retrying?: "retrying"): void {
  const name = displayName(result.file);
  const passed = result.exitCode === 0;
  const outcome = retrying
    ? `died of a Bun runtime panic (exit ${result.exitCode}), running it once more`
    : passed
      ? "passed"
      : `failed (exit ${result.exitCode})`;
  const header = `${name}: ${outcome} in ${seconds(result.ms)}`;
  const group = passed && process.env.GITHUB_ACTIONS === "true";
  const open = group ? `::group::${header}` : `=== ${header}`;
  const close = group ? "::endgroup::\n" : "\n";
  process.stdout.write(`${open}\n${result.output}${close}`);
}

async function main(): Promise<number> {
  let files: string[];
  let limit: number;
  let budgetMs: number;
  try {
    const selection = parseArgs(process.argv.slice(2));
    if (typeof selection === "number") return selection;
    files = testFiles(selection);
    limit = jobs();
    budgetMs = fileBudgetMs();
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
  const results = await runAll(files, limit, budgetMs);
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
