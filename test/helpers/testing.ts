// bun:test's surface with the suite's runner policy in one place: the per-test deadline, the
// per-file temp root, and the agent-state sandbox.
//   abort signal      -> child processes only; in-process work an abandoned body keeps doing
//                        still lands (the per-file temp-dir harnesses absorb it)
//   runSync in flight -> cannot be interrupted: spawnSync blocks the thread the deadline timer
//                        runs on (RunOptions.timeoutMs)

import { afterAll, it } from "bun:test";
import "./node_env.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { abortable } from "@std/async";
import { CLAUDE_DESKTOP_DIR_ENV } from "../../src/claude/desktop_library.ts";
import { CI_NO_LIVE_LOOKUPS_ENV } from "../../src/codex/user_agent.ts";
import { CI_PS_DOCUMENTS_DIR_ENV, CI_RC_DIR_ENV } from "../../src/shell/integration.ts";

export { afterEach, beforeEach, describe, expect } from "bun:test";

// --- the temp root -----------------------------------------------------------------
//
// scripts/run_tests.ts runs each test file in its own process, so this module mints one root per
// process and removes it when the file is done (a failed run too): a fixture a test abandons goes
// with the root instead of staying in the OS tmpdir. tempDir is the one way to a temp directory;
// reaching mkdtemp or os.tmpdir elsewhere under test/ is a lint error.

/**
 * A child that loads this module mints its own root INSIDE the root of the process that spawned
 * it (test/helpers/run.ts sets this on every child), so a child killed before its own teardown
 * leaves nothing the parent's removal misses.
 */
export const TEST_ROOT_ENV = "COPILOT_ENV_TEST_ROOT";
/** This process's root; the spawn helpers hand it to children under TEST_ROOT_ENV. */
export const ISOLATE_ROOT = mkdtempSync(
  join(process.env[TEST_ROOT_ENV] ?? tmpdir(), "copilot-env-suite-"),
);

/** The prefix must name a direct child of the root: an empty one, or one climbing out, would
 *  land the directory beside the root, outside everything that removes it. */
export function tempDir(prefix: string): string {
  const target = join(ISOLATE_ROOT, prefix);
  if (dirname(target) !== ISOLATE_ROOT) {
    throw new Error(`tempDir prefix must name a direct child of the root: ${prefix}`);
  }
  return mkdtempSync(target);
}

/**
 * Success is the path being GONE (lstat says ENOENT), never rmSync returning. A transient
 * failure retries after a pause, as renameWithRetry does (src/utils/fs_disk.ts); the last
 * attempt throws.
 *   an entry a live child renamed away mid-walk (a cache's temp files)  -> `force` reads it as
 *                                                                        removed; the walk stops early
 *   Windows holding a handle briefly past process death                -> EPERM/EBUSY, tree present
 */
export function removeDir(dir: string): "" {
  if (!dir) return "";
  const maxRetries = 9;
  for (let i = 0; ; i++) {
    let failure: Error | undefined;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // ENOTEMPTY: a delete-pending file inside surfaces as not-empty on the dir itself.
      const transient = code === "EPERM" || code === "EBUSY" || code === "ENOTEMPTY";
      if (!transient) throw err;
      failure = err as Error;
    }
    if (isGone(dir)) return "";
    if (i >= maxRetries) throw failure ?? new Error(`${dir} still exists after removal`);
    Bun.sleepSync(300);
  }
}

/** Whether `path` provably does not exist: ENOENT, and nothing else. A lookup that fails
 *  for any other reason (an unreadable parent, say) is an error, never an absence. */
function isGone(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw err;
  }
}

/**
 * A root that survives fails the run: it is exactly the leak this file exists to prevent, so it
 * is never a green run's footnote. `bun test` emits no `exit` event, and bun:test's hooks throw
 * outside the runner (the bench and the usage scripts load this module under `bun run`), so the
 * runner's own hook is tried first.
 *   under `bun test`  -> afterAll: a throw there is a failed test
 *   under `bun run`   -> the process's exit event
 */
function onTeardown(teardown: () => void): void {
  try {
    afterAll(teardown);
  } catch {
    process.on("exit", teardown);
  }
}

onTeardown(() => {
  removeDir(ISOLATE_ROOT);
});

// --- the suite-wide agent-state sandbox ---------------------------------------
//
// Every env var that steers a real agent-state path is repointed under the process's root, so a
// test with no harness of its own still cannot touch the developer's `~/.codex`, `~/.claude`,
// `~/.claude.json`, copilot-api home, or shell rc files. HOME stays REAL: each path has its own
// override, which is what makes it redirectable without HOME.
const SANDBOX_HOME = join(ISOLATE_ROOT, "sandbox");
mkdirSync(SANDBOX_HOME);
process.env.COPILOT_API_HOME = join(SANDBOX_HOME, "copilot-api");
process.env.CLAUDE_CONFIG_DIR = join(SANDBOX_HOME, ".claude");
process.env.CODEX_HOME = join(SANDBOX_HOME, ".codex");
// By the exported constants, so a rename cannot turn this floor into dead config. Both must be
// absolute: the reader throws on a relative or empty value rather than falling back to the real
// home.
//   CI_RC_DIR_ENV            -> replaces homedir(): `<value>/.bashrc`
//   CI_PS_DOCUMENTS_DIR_ENV  -> the Documents folder over the per-edition profile dirs:
//                               `<value>/WindowsPowerShell/...`
process.env[CI_RC_DIR_ENV] = SANDBOX_HOME;
process.env[CI_PS_DOCUMENTS_DIR_ENV] = join(SANDBOX_HOME, "Documents");
// The Claude Desktop seam points at a dir that is NEVER created: detection reads its
// existence, so the whole suite sees "no Claude Desktop" (and stays off the real
// library) unless a test opts in by mkdir'ing it.
process.env[CLAUDE_DESKTOP_DIR_ENV] = join(SANDBOX_HOME, "claude-desktop");
// The live-lookup seam (installed codex version, npm codex-version query, catalog probe) reads
// "unavailable" under the suite, so no test depends on the developer's network or codex install.
process.env[CI_NO_LIVE_LOOKUPS_ENV] = "1";

const DEFAULT_TIMEOUT_MS = 15_000;
/** bun's own per-test timeout sits this far behind the deadline race, so the race always loses
 *  first and the abort signal fires; bun's is the backstop for a body it cannot reach. */
const RUNNER_TIMEOUT_MARGIN_MS = 5_000;

type TestBody = () => void | Promise<void>;

type RegisterTest = (name: string, fn: TestBody, timeoutMs?: number) => void;

interface TestApi extends RegisterTest {
  /** bun:test's conditional skip: `test.skipIf(cond)("name", fn)`. */
  skipIf(condition: boolean): RegisterTest;
}

// --- the per-test abort signal -------------------------------------------------
//
// The deadline race ABANDONS a timed-out body; it does not cancel it, so the body runs on and
// keeps spawning children alongside the tests that follow. Each body therefore gets its own
// AbortController, aborted when the deadline fires (and again once the body settles), carried
// WITH the body through AsyncLocalStorage: an abandoned continuation must see ITS OWN aborted
// signal, not the signal of whichever test is live when it wakes up.
const TEST_ABORT = new AsyncLocalStorage<AbortSignal>();

/**
 * Aborted once the body has timed out or finished; the spawn helpers (test/helpers/run.ts)
 * consult it, so an abandoned body cannot start a child and its children are torn down.
 *   inside a test body  -> that test's signal
 *   outside one         -> undefined: there is no deadline to abandon
 */
export function testAbortSignal(): AbortSignal | undefined {
  return TEST_ABORT.getStore();
}

/** Purely sync bodies cannot be preempted; the race cuts off async bodies that stall. */
function withDeadline(name: string, fn: TestBody, timeoutMs: number): () => Promise<void> {
  return async () => {
    const abort = new AbortController();
    const timer = setTimeout(() => {
      abort.abort(new Error(`test "${name}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    try {
      await abortable(
        TEST_ABORT.run(abort.signal, () => Promise.resolve().then(fn)),
        abort.signal,
      );
    } finally {
      clearTimeout(timer);
      abort.abort(new Error(`test "${name}" has already finished`));
    }
  };
}

function register(base: typeof it | ReturnType<typeof it.skipIf>): RegisterTest {
  return (name, fn, timeoutMs = DEFAULT_TIMEOUT_MS) => {
    base(name, withDeadline(name, fn, timeoutMs), {
      timeout: timeoutMs + RUNNER_TIMEOUT_MARGIN_MS,
    });
  };
}

export const test: TestApi = Object.assign(register(it), {
  skipIf(condition: boolean): RegisterTest {
    return register(it.skipIf(condition));
  },
});

/** A call's result as data, so a table row expects a value or an error side by side. */
type Outcome<T> = { value: T } | { error: unknown };

export function outcomeOf<T>(fn: () => T): Outcome<T> {
  try {
    return { value: fn() };
  } catch (error) {
    return { error };
  }
}

/** A runtime `process.env.TZ` is honored on unix only; on Windows the zone comes from the OS.
 *  Guards one test, test/utils/time.test.ts's "the DEFAULT zone honors the process TZ"; every other day
 *  computation names its IANA zone instead. */
export const TZ_PINNABLE = process.platform !== "win32";
