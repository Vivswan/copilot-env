// `--config` pins the root deno.json: deno discovers config, and with it the "test" permission
// set, from the ENTRYPOINT's directory, so a worker script in a temp dir would resolve no set.
// Every spawn is gated on the running test's abort signal (testing.ts): a body the deadline
// abandoned keeps executing, and its next spawn would otherwise land inside a later test.
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ISOLATE_ROOT, PINNED_DENO_DIR, TEST_ROOT_ENV, testAbortSignal } from "./testing.ts";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * A quoted module specifier for splicing into generated source. It must be a file URL: deno
 * reads a Windows absolute path's drive letter as an unsupported URL scheme.
 */
export function importSpecifier(path: string): string {
  return JSON.stringify(pathToFileURL(path).href);
}

/** The env var a child program's per-test values travel under; see CHILD_VALUES. */
const CHILD_VALUES_ENV = "COPILOT_ENV_TEST_CHILD_VALUES";

/**
 * Child programs are SOURCE TEXT, and a runtime value (a tmp path, a URL) travels as data in one
 * JSON env var the program reads back through this expression (`${CHILD_VALUES}.ready`).
 * Splicing values through JSON.stringify would leave U+2028/U+2029 and `</script>` unescaped
 * inside code (CodeQL js/bad-code-sanitization).
 */
export const CHILD_VALUES = `JSON.parse(Deno.env.get("${CHILD_VALUES_ENV}") ?? "{}")`;

/** Spread into the spawn's `env`. Deno.Command merges over the parent's env; runSync REPLACES
 *  it, so spread process.env first there. */
export function childValuesEnv(values: Record<string, unknown>): Record<string, string> {
  return { [CHILD_VALUES_ENV]: JSON.stringify(values) };
}

export function denoRunArgs(...flags: string[]): string[] {
  return ["run", "--config", join(ROOT, "deno.json"), "-P=test", ...flags];
}

export interface RunResult {
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

/** Null-prototype, so a variable named `toString` or `__proto__` is an ordinary key here, not
 *  something inherited. */
function childEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Written LAST: no caller's map can drop the two harness keys, and only an absolute DENO_DIR
 * redirects one. DENO_DIR follows the rule testing.ts applies to its own inherited value:
 *   absolute in the caller's map (the proxy float pins one)  -> kept
 *   missing, relative, or empty                             -> PINNED_DENO_DIR
 */
function harnessEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const denoDir = env.DENO_DIR;
  return {
    ...env,
    [TEST_ROOT_ENV]: ISOLATE_ROOT,
    DENO_DIR: denoDir !== undefined && isAbsolute(denoDir) ? denoDir : PINNED_DENO_DIR,
  };
}

/** The running test's abort signal, thrown if the deadline already fired. Every spawn
 *  starts here, so a body the deadline abandoned never gets a new child at all. */
function liveTestSignal(): AbortSignal | undefined {
  const signal = testAbortSignal();
  if (signal?.aborted) throw signal.reason;
  return signal;
}

/**
 * Private on purpose: spawnChild is the only way to make a child, so no reachable path builds
 * one and forgets to register it.
 */
function killOnTestAbort(child: Deno.ChildProcess): Deno.ChildProcess {
  const signal = testAbortSignal();
  if (signal === undefined) return child;
  const kill = (): void => {
    try {
      child.kill("SIGKILL");
    } catch {
      // already exited
    }
  };
  // An already-aborted signal never fires a listener added afterwards, and the deadline can
  // land between the spawn and this call -- so the kill is immediate in that case.
  if (signal.aborted) kill();
  else signal.addEventListener("abort", kill, { once: true });
  return child;
}

/** The one async child spawn under test/: reaching a child-process API anywhere else is a lint
 *  error (test/lint/no_unmanaged_child_spawn.ts). The harness keys mean a child killed by the
 *  abort teardown leaves nothing behind. */
export function spawnChild(cmd: string, options: Deno.CommandOptions): Deno.ChildProcess {
  liveTestSignal();
  const env = childEnv(harnessEnv(options.env ?? {}));
  return killOnTestAbort(new Deno.Command(cmd, { ...options, env }).spawn());
}

/**
 * The child gets EXACTLY `opts.env` (node's replacement semantics) plus the harness keys, so a
 * key the caller omits, or spells `undefined`, is genuinely absent in the child.
 */
export function runSync(cmd: string, args: string[], opts: RunOptions = {}): RunResult {
  // spawnSync can take no part in this: it blocks the thread, so the only moment the signal
  // can be observed for a SYNC child is before the call.
  liveTestSignal();
  const wanted = childEnv(harnessEnv(opts.env ?? process.env));
  // Deno's node:child_process MERGES `env` over the parent's, so replacement is restored by
  // clearing the parent's extra keys for the span of the spawn. PRECONDITION: the suite runs no
  // Web Worker; one shares the process environment and would see the cleared window.
  //   Deno.Command + clearEnv  -> no window, but outputSync has no `timeout` for a wedged child
  //   spawnSync                -> `timeout`; blocks this thread, so nothing on it sees the window
  const cleared: (readonly [string, string])[] = [];
  try {
    // Inside the try: a throw partway through must still restore what was already cleared.
    for (const [key, value] of Object.entries(process.env)) {
      // hasOwn, not `in`: on an ordinary object `"toString" in wanted` is true through the
      // prototype, which would spare a parent variable of that name and leak it into the child.
      if (value !== undefined && !Object.hasOwn(wanted, key)) {
        cleared.push([key, value] as const);
        delete process.env[key];
      }
    }
    const res = spawnSync(cmd, args, {
      cwd: opts.cwd ?? ROOT,
      env: wanted,
      encoding: "utf-8",
      input: opts.input ?? "",
      maxBuffer: 16 * 1024 * 1024,
      timeout: opts.timeoutMs ?? 120_000,
      shell: opts.shell ?? false,
    });
    if (res.error) throw res.error;
    return { exitCode: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  } finally {
    for (const [key, value] of cleared) process.env[key] = value;
  }
}

export function runScript(entry: string, args: string[] = [], opts: RunOptions = {}): RunResult {
  return runSync(Deno.execPath(), [...denoRunArgs(), entry, ...args], opts);
}

export function runCli(args: string[], opts: RunOptions = {}): RunResult {
  return runScript(join(ROOT, "src", "cli.ts"), args, opts);
}

/**
 * `fromDir` is realpath'd first: deno's store symlinks a package out of node_modules, and its
 * dependencies sit beside the REAL location inside the store, not beside the symlink.
 */
export function resolvePackageDir(name: string, fromDir: string): string {
  let dir = realpathSync(fromDir);
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`cannot resolve package ${name} from ${fromDir}`);
    dir = parent;
  }
}
