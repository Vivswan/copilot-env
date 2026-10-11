// Every spawn is gated on the running test's abort signal (testing.ts): a body the deadline
// abandoned keeps executing, and its next spawn would otherwise land inside a later test.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ISOLATE_ROOT, TEST_ROOT_ENV, tempDir, testAbortSignal } from "./testing.ts";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** What the `agent` binary runs (scripts/compile.ts compiles this module). */
export const CLI_ENTRY = join(ROOT, "src", "cli.ts");

/**
 * A quoted module specifier for splicing into generated source. It must be a file URL: a Windows
 * absolute path's drive letter reads as an unsupported URL scheme in an import.
 */
export function importSpecifier(path: string): string {
  return JSON.stringify(pathToFileURL(path).href);
}

const CHILD_VALUES_ENV = "COPILOT_ENV_TEST_CHILD_VALUES";

/**
 * Child programs are SOURCE TEXT, and a runtime value (a tmp path, a URL) travels as data in one
 * JSON env var the program reads back through this expression (`${CHILD_VALUES}.ready`).
 * Splicing values through JSON.stringify would leave U+2028/U+2029 and `</script>` unescaped
 * inside code (CodeQL js/bad-code-sanitization).
 */
export const CHILD_VALUES = `JSON.parse(process.env.${CHILD_VALUES_ENV} ?? "{}")`;

/** Spread into the spawn's `env`. spawnChild merges `env` over the parent's; runSync REPLACES
 *  the parent's with it, so spread process.env first there. */
export function childValuesEnv(values: Record<string, unknown>): Record<string, string> {
  return { [CHILD_VALUES_ENV]: JSON.stringify(values) };
}

/** `flags` go between `run` and the entry: bun reads a runtime flag such as `--preload` there
 *  and nowhere before `run`. `--no-env-file` keeps a .env in the checkout (every child's cwd)
 *  out of an env a test spelled exactly. */
export function bunRunArgs(...flags: string[]): string[] {
  return ["run", "--no-env-file", ...flags];
}

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Text fed to the child's stdin, then closed; omitted = an immediately-EOF stdin. */
  input?: string;
  /** Hard kill for a wedged child; sync spawns block the deadline race in testing.ts. */
  timeoutMs?: number;
  /** Run through the platform shell (the cliSpawn recipe's `shell`, for Windows .cmd shims). */
  shell?: boolean;
}

/**
 * Written LAST: no caller's map can drop the harness keys.
 *   TEST_ROOT_ENV  -> the child's temp root nests inside this process's (testing.ts)
 *   NODE_PATH      -> a child program written under that root resolves the repository's
 *                     packages (`import ... from "undici"` in a generated target) from this
 *                     checkout's node_modules, which no ancestor of a tmp dir holds
 */
/** Bun's runtime transpiler cache is off in every child: it lives under the child's HOME (macOS
 *  `Library/Caches/bun`, Windows AppData), and a test that retargets HOME and fingerprints it would
 *  find the `.pile` files among its own writes. */
function harnessEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return {
    ...env,
    [TEST_ROOT_ENV]: ISOLATE_ROOT,
    NODE_PATH: join(ROOT, "node_modules"),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
  };
}

/** Every spawn starts here, so a body the deadline abandoned never gets a new child at all. */
function liveTestSignal(): AbortSignal | undefined {
  const signal = testAbortSignal();
  if (signal?.aborted) throw signal.reason;
  return signal;
}

type StdioMode = "pipe" | "ignore" | "inherit";

export interface SpawnChildOptions<
  In extends StdioMode = "ignore",
  Out extends StdioMode = "pipe",
  Err extends StdioMode = "inherit",
> {
  args?: string[];
  cwd?: string;
  /** Merged over the parent's env, or the whole env under `clearEnv` (PATH included, for a
   *  bare command name). */
  env?: Record<string, string | undefined>;
  clearEnv?: boolean;
  stdin?: In;
  stdout?: Out;
  stderr?: Err;
  /** Bun's own: the argv is handed to CreateProcess as written, for a prequoted cmd.exe line. */
  windowsVerbatimArguments?: boolean;
}

/** The one async child spawn under test/: reaching a child-process API anywhere else is a lint
 *  error. The test's abort signal is the spawn's own, so the deadline teardown kills the child,
 *  and the harness keys mean it leaves nothing behind. A piped stream is a ReadableStream
 *  (stdout, stderr) or a FileSink (stdin) on the returned subprocess. */
export function spawnChild<
  const In extends StdioMode = "ignore",
  const Out extends StdioMode = "pipe",
  const Err extends StdioMode = "inherit",
>(cmd: string, options: SpawnChildOptions<In, Out, Err> = {}): Bun.Subprocess<In, Out, Err> {
  const signal = liveTestSignal();
  const { args = [], clearEnv = false, env: given = {}, ...stdio } = options;
  const env = harnessEnv(clearEnv ? given : { ...process.env, ...given });
  return Bun.spawn([cmd, ...args], { ...stdio, env, signal, killSignal: "SIGKILL" });
}

/**
 * The child gets EXACTLY `opts.env` (node's replacement semantics, an `undefined` value dropped)
 * plus the harness keys, so a key the caller omits, or spells `undefined`, is genuinely absent
 * in the child.
 */
export function runSync(cmd: string, args: string[], opts: RunOptions = {}): RunResult {
  // spawnSync can take no part in this: it blocks the thread, so the only moment the signal
  // can be observed for a SYNC child is before the call.
  liveTestSignal();
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    env: harnessEnv(opts.env ?? process.env),
    encoding: "utf-8",
    input: opts.input ?? "",
    maxBuffer: 16 * 1024 * 1024,
    // Windows runners are the slow leg.
    timeout: opts.timeoutMs ?? (process.platform === "win32" ? 300_000 : 120_000),
    shell: opts.shell ?? false,
  });
  if (res.error) throw res.error;
  return { exitCode: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

export function runScript(entry: string, args: string[] = [], opts: RunOptions = {}): RunResult {
  return runSync(process.execPath, [...bunRunArgs(), entry, ...args], opts);
}

export function runCli(args: string[], opts: RunOptions = {}): RunResult {
  return runScript(CLI_ENTRY, args, opts);
}

/** Where `name` lives as seen from `fromDir`: the resolver's own answer, so a package an isolated
 *  install symlinks out of node_modules is found beside its real location. */
export function resolvePackageDir(name: string, fromDir: string): string {
  return dirname(Bun.resolveSync(`${name}/package.json`, fromDir));
}
