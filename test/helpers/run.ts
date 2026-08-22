// Subprocess helpers shared by every test that spawns the CLI or a script.
// Children are deno subprocesses running under the repo's "test" permission
// set; `--config` pins the root deno.json because deno discovers config (and
// with it the permission set) from the ENTRYPOINT's directory, so a worker
// script written to a temp dir would otherwise resolve no set at all.
//
// Every spawn here is gated on the running test's abort signal (testing.ts): a
// body the deadline abandoned keeps executing, and without the gate its next
// spawn would land in the middle of whichever test is running by then.
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { testAbortSignal } from "./testing.ts";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * `path` as a quoted module specifier, ready to splice into generated source
 * (`import ... from ${importSpecifier(p)}`). It must be a file URL: a Windows
 * absolute path is not a valid specifier, and deno reads its drive letter as an
 * unsupported URL scheme.
 */
export function importSpecifier(path: string): string {
  return JSON.stringify(pathToFileURL(path).href);
}

/** `deno run` argv (before the entrypoint) for a child under the test permission set. */
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
  /** Hard kill for a wedged child; sync spawns block the deadline race in testing.ts. */
  timeoutMs?: number;
}

/**
 * The exact environment the child should get: the requested map with `undefined` values
 * dropped, since those spell "the child must not see this". Null-prototype, so a variable
 * named `toString` or `__proto__` is an ordinary key here rather than something inherited.
 */
function childEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** The running test's abort signal, thrown if the deadline already fired. Every spawn
 *  starts here, so a body the deadline abandoned never gets a new child at all. */
function liveTestSignal(): AbortSignal | undefined {
  const signal = testAbortSignal();
  if (signal?.aborted) throw signal.reason;
  return signal;
}

/**
 * Tear `child` down as soon as the running test's signal aborts. Private on purpose:
 * spawnChild below is the only way to make a child, so there is no reachable path that
 * builds one and forgets to register it.
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

/** THE async child spawn for the suite: constructs and registers for abort teardown in one
 *  step. Reaching a child-process API anywhere else under test/ is a lint error
 *  (test/lint/no_unmanaged_child_spawn.ts). */
export function spawnChild(cmd: string, options: Deno.CommandOptions): Deno.ChildProcess {
  liveTestSignal();
  return killOnTestAbort(new Deno.Command(cmd, options).spawn());
}

/**
 * Synchronous spawn with the RunResult shape the suite asserts on. The child gets
 * EXACTLY `opts.env` (node's documented replacement semantics), so a key the caller omits, or
 * spells `undefined`, is genuinely absent in the child.
 *
 * Deno's node:child_process MERGES `env` over the parent instead, so replacement is restored
 * here by clearing the parent's extra keys for the span of the spawn. PRECONDITION: the suite
 * runs no Web Worker. spawnSync blocks this thread, so nothing on it can observe the window,
 * but a Worker shares the process environment and would. (Deno.Command's `clearEnv` needs no
 * such window, but its outputSync has no `timeout` -- and a blocked thread is precisely what
 * stops the per-test deadline from killing a wedged child.)
 */
export function runSync(cmd: string, args: string[], opts: RunOptions = {}): RunResult {
  // spawnSync can take no part in this: it blocks the thread, so the only moment the signal
  // can be observed for a SYNC child is before the call.
  liveTestSignal();
  const wanted = childEnv(opts.env ?? process.env);
  const cleared: (readonly [string, string])[] = [];
  try {
    // Inside the try: a throw partway through must still restore what was already cleared.
    for (const [key, value] of Object.entries(process.env)) {
      // hasOwn, not `in`: `"toString" in wanted` is true through the prototype chain, which
      // would spare a parent variable of that name and leak it into the child.
      if (value !== undefined && !Object.hasOwn(wanted, key)) {
        cleared.push([key, value] as const);
        delete process.env[key];
      }
    }
    const res = spawnSync(cmd, args, {
      cwd: opts.cwd ?? ROOT,
      env: wanted,
      encoding: "utf-8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: opts.timeoutMs ?? 120_000,
    });
    if (res.error) throw res.error;
    return { exitCode: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  } finally {
    for (const [key, value] of cleared) process.env[key] = value;
  }
}

/** Run a repo TypeScript entrypoint (or a temp-dir worker script) as a deno child. */
export function runScript(entry: string, args: string[] = [], opts: RunOptions = {}): RunResult {
  return runSync(Deno.execPath(), [...denoRunArgs(), entry, ...args], opts);
}

/** Run the CLI (`src/cli.ts`) with `args`, from the repo root. */
export function runCli(args: string[], opts: RunOptions = {}): RunResult {
  return runScript(join(ROOT, "src", "cli.ts"), args, opts);
}

/**
 * The package directory `name` resolves to from `fromDir`, by node's
 * node_modules ancestor walk. `fromDir` is realpath'd first: deno's store
 * symlinks a package out of node_modules, and its own dependencies sit beside
 * the REAL location (inside the store), not beside the symlink.
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
