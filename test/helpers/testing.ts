// bun:test's surface over @std/testing/bdd and @std/expect, so runner policy (the per-test
// deadline, the sanitizer settings, the agent-state sandbox) lives in one place.
//   sanitizers        -> off: the deadline race leaves a timed-out body's ops pending, which
//                        the op sanitizer would misreport as the failure
//   abort signal      -> child processes only; in-process work an abandoned body keeps doing
//                        still lands (the per-file temp-dir harnesses absorb it)
//   runSync in flight -> cannot be interrupted: spawnSync blocks the thread the deadline timer
//                        runs on (RunOptions.timeoutMs)
import { AsyncLocalStorage } from "node:async_hooks";
import { lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { it } from "@std/testing/bdd";
import { CLAUDE_DESKTOP_DIR_ENV } from "../../src/claude/desktop.ts";
import { CI_NO_LIVE_LOOKUPS_ENV } from "../../src/codex/catalog.ts";
import { CI_PS_DOCUMENTS_DIR_ENV, CI_RC_DIR_ENV } from "../../src/shell/integration.ts";
import { sleepSync } from "../../src/utils/time.ts";

export { expect } from "@std/expect";
export { afterEach, beforeEach, describe } from "@std/testing/bdd";

// --- the temp root -----------------------------------------------------------------
//
// `deno test` evaluates each test file in its own isolate, so this module mints one root per
// file and removes it on unload (a failed run unloads too): a fixture a test abandons goes with
// the root instead of staying in the OS tmpdir. tempDir is the one way to a temp directory;
// reaching mkdtemp, makeTempDir, or os.tmpdir elsewhere under test/ is a lint error
// (test/lint/no_unmanaged_temp_dir.ts).

/**
 * A child that loads this module mints its own root INSIDE the root of the isolate that spawned
 * it (test/helpers/run.ts sets this on every child), so a child killed before its own unload
 * leaves nothing the parent's removal misses. It travels to children only: the isolates share
 * this process's environment, and the next one would nest under a root already gone.
 */
export const TEST_ROOT_ENV = "COPILOT_ENV_TEST_ROOT";
/** This isolate's root; the spawn helpers hand it to children under TEST_ROOT_ENV. */
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
 * Success is the path being GONE (lstat says ENOENT), never rmSync returning. Two transient
 * failures retry with backoff, as renameWithRetry does (src/utils/report_write.ts); the last
 * attempt throws.
 *   an entry a live child renamed away mid-walk (deno cache temp files)  -> `force` reads it as
 *                                                                          removed; the walk stops early
 *   Windows holding a handle briefly past process death                  -> EPERM/EBUSY, tree present
 */
export function removeDir(dir: string): "" {
  if (!dir) return "";
  const maxRetries = 9;
  for (let i = 0;; i++) {
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
    sleepSync(300);
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

// A root that survives fails the run (an uncaught error here is a test failure): it is
// exactly the leak this file exists to prevent, so it is never a green run's footnote.
globalThis.addEventListener("unload", () => {
  removeDir(ISOLATE_ROOT);
});

// A child under a fixture HOME with no pin derives a FRESH module cache from that HOME and fills
// it by download (8-14 MB per fixture), so this process pins its own cache once and every deno
// child inherits it (test/helpers/run.ts keeps the pin unless a caller names an absolute one).
// The isolates share one process environment, so the pin outlives the isolate that set it.
//   DENO_DIR absolute  -> kept as is
//   DENO_DIR empty     -> deno reads it as unset; replaced by the default `deno info` reports
//   DENO_DIR relative  -> would resolve against each child's own cwd; `deno info` resolves it
//                         against THIS process's cwd and that absolute path is pinned
const inheritedDenoDir = process.env.DENO_DIR ?? "";
export const PINNED_DENO_DIR = isAbsolute(inheritedDenoDir) ? inheritedDenoDir : hostDenoDir();
process.env.DENO_DIR = PINNED_DENO_DIR;

/** Where this deno resolves its cache -- asked, not derived, because the default is
 *  platform-specific and deno's to define. */
function hostDenoDir(): string {
  // The one child made outside test/helpers/run.ts: it runs at module load, before any test
  // body exists to be abandoned, so abort teardown has nothing to register.
  const info = new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  const decoder = new TextDecoder();
  if (!info.success) throw new Error(`deno info failed: ${decoder.decode(info.stderr)}`);
  const { denoDir } = JSON.parse(decoder.decode(info.stdout)) as { denoDir?: unknown };
  if (typeof denoDir !== "string" || denoDir === "") {
    throw new Error("deno info reported no denoDir");
  }
  return denoDir;
}

// --- the suite-wide agent-state sandbox ---------------------------------------
//
// Every env var that steers a real agent-state path is repointed under the isolate's root, so a
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
// Not NODE_ENV=test: consola reads that as a test run and silences the info output the logger
// tests assert on.
process.env[CI_NO_LIVE_LOOKUPS_ENV] = "1";

const DEFAULT_TIMEOUT_MS = 15_000;

type TestBody = () => void | Promise<void>;

type RegisterTest = (name: string, fn: TestBody, timeoutMs?: number) => void;

export interface TestApi extends RegisterTest {
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const expired = new Error(`test "${name}" timed out after ${timeoutMs}ms`);
        abort.abort(expired);
        reject(expired);
      }, timeoutMs);
    });
    try {
      await Promise.race([
        TEST_ABORT.run(abort.signal, () => Promise.resolve().then(fn)),
        deadline,
      ]);
    } finally {
      clearTimeout(timer);
      abort.abort(new Error(`test "${name}" has already finished`));
    }
  };
}

function register(base: typeof it | typeof it.skip): RegisterTest {
  return (name, fn, timeoutMs = DEFAULT_TIMEOUT_MS) => {
    base(name, { sanitizeOps: false, sanitizeResources: false }, withDeadline(name, fn, timeoutMs));
  };
}

export const test: TestApi = Object.assign(register(it), {
  skipIf(condition: boolean): RegisterTest {
    return condition ? register(it.skip) : register(it);
  },
});

/**
 * Deno honors a runtime `process.env.TZ` on unix only; on Windows the zone comes from the OS.
 * Two tests need this, and they are the only reason the flag survives:
 *   test/time.test.ts, "the DEFAULT zone honors the process TZ"  -> the property that justifies
 *                                                                  deriving the day key in JS
 *   test/cost.test.ts, the calendar `--days` cutoff               -> startOfLocalDay is system-zone
 *                                                                  only by design
 * Day SLICING is not gated: `localDayKey(ms, timeZone)` takes an explicit IANA zone.
 */
export const TZ_PINNABLE = Deno.build.os !== "windows";
