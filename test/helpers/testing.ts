// The suite's ONE runner shim: bun:test's surface, backed by @std/testing/bdd
// and @std/expect. Every test file imports the runner from here, so runner
// policy -- the default per-test deadline (bun ran with `--timeout 15000`), the
// bun-parity sanitizer settings, and the suite-wide agent-state sandbox -- lives
// in one place.
//
// Sanitizers are off deliberately: bun:test never sanitized ops/resources, and
// the deadline race below leaves the timed-out body's ops pending by design,
// which the op sanitizer would misreport as the failure.
//
// The abort signal below reaches child processes only. In-process work an abandoned
// body keeps doing (file writes, env mutations) still lands -- that is what the
// per-file temp-dir harnesses absorb -- and a runSync already in flight cannot be
// interrupted at all, since spawnSync blocks the thread the deadline timer runs on
// (RunOptions.timeoutMs covers that case).
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
// Every temp path a test module makes lives under ONE root, removed when the module's
// isolate unloads (a failed run unloads too): `deno test` runs each test file in its own
// isolate, so this module is evaluated, and the root minted and removed, once per test
// file. A fixture a test never removes, or abandons on its failing path, goes with the root
// instead of staying in the OS tmpdir forever. Nothing under test/ reaches mkdtemp,
// makeTempDir, or os.tmpdir itself (test/lint/no_unmanaged_temp_dir.ts): tempDir below is
// the one way to a temp directory.

/**
 * A child process that loads this module (a script under test, a nested `deno test`) mints
 * a root of its own -- INSIDE the root of the isolate that spawned it, which
 * test/helpers/run.ts names here on every child. A child killed before its own unload (the
 * abort teardown of a timed-out test) therefore leaves nothing the parent's removal misses.
 * The variable travels to children only, never into this process's environment: the
 * isolates share that, and the next one would nest under a root already gone.
 */
export const TEST_ROOT_ENV = "COPILOT_ENV_TEST_ROOT";
/** This isolate's root; the spawn helpers hand it to children under TEST_ROOT_ENV. */
export const ISOLATE_ROOT = mkdtempSync(
  join(process.env[TEST_ROOT_ENV] ?? tmpdir(), "copilot-env-suite-"),
);

/** A fresh directory `<prefix><random>` under the isolate's root, so a failure still reads
 *  the same as before. Removed with the root; a test may removeDir it earlier. The prefix
 *  must name a direct child of the root: an empty one or one climbing out would land the
 *  directory beside the root, outside everything that removes it. */
export function tempDir(prefix: string): string {
  const target = join(ISOLATE_ROOT, prefix);
  if (dirname(target) !== ISOLATE_ROOT) {
    throw new Error(`tempDir prefix must name a direct child of the root: ${prefix}`);
  }
  return mkdtempSync(target);
}

/**
 * rmSync -rf a temp dir (no-op on ""); returns "" so callers can `dir = removeDir(dir)`.
 * Success is the path being GONE (lstat says ENOENT), not rmSync returning: with `force`, an
 * entry that a live child renames away mid-walk (deno writes its caches through temp files)
 * reads as an already-removed target, and the walk stops there with the rest of the tree in
 * place. Windows can also hold a handle (antivirus, the indexer, a just-killed child's
 * executable image) briefly past process death. Both retry with backoff -- same philosophy
 * as renameWithRetry (src/utils/report_write.ts); the final attempt throws.
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

// The module cache every spawned deno child reads. A child running under a fixture HOME
// derives a FRESH cache from that HOME when nothing pins one, and fills it with a download
// (that was 8-14 MB per fixture). So the children get this process's own cache, pinned once
// per process: the isolates share one process environment, which is what lets the pin
// outlive the isolate that set it. A cache the environment already pins (the denoland image,
// a CI step) is what deno info reports, so the pin canonicalizes it -- an empty value reads
// as unset to deno, and a relative one would resolve against each child's own cwd. The spawn
// helpers (test/helpers/run.ts) put the same value on every child whose caller's env lacks an
// absolute one, so a replacement env cannot drop it either.
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
// Every env var that steers a real agent-state path is repointed into one dir under the
// isolate's root here, so a test that sets up no harness of its own still cannot touch the
// developer's `~/.codex`, `~/.claude`, `~/.claude.json`, copilot-api home, or shell rc files.
//
// HOME stays REAL: each path above has its own override, which is what makes it redirectable
// without HOME.
const SANDBOX_HOME = join(ISOLATE_ROOT, "sandbox");
mkdirSync(SANDBOX_HOME);
process.env.COPILOT_API_HOME = join(SANDBOX_HOME, "copilot-api");
process.env.CLAUDE_CONFIG_DIR = join(SANDBOX_HOME, ".claude");
process.env.CODEX_HOME = join(SANDBOX_HOME, ".codex");
// The shell-integration seams, by their exported constants rather than retyped literals, so a
// rename cannot silently turn this floor into dead config. They sit at DIFFERENT levels: the
// rc one replaces homedir() (`<value>/.bashrc`), while the PowerShell one is the Documents
// folder holding the per-edition profile dirs (`<value>/WindowsPowerShell/...`). Both stay
// absolute and non-empty: the reader throws on an empty value rather than falling back to the
// machine's real home.
process.env[CI_RC_DIR_ENV] = SANDBOX_HOME;
process.env[CI_PS_DOCUMENTS_DIR_ENV] = join(SANDBOX_HOME, "Documents");
// The Claude Desktop seam points at a dir that is NEVER created: detection reads its
// existence, so the whole suite sees "no Claude Desktop" (and stays off the real
// library) unless a test opts in by mkdir'ing it.
process.env[CLAUDE_DESKTOP_DIR_ENV] = join(SANDBOX_HOME, "claude-desktop");
// The live-lookup seam (the installed codex's version, the npm codex-version
// query, the catalog probe): under the suite they read "unavailable" so no test depends on the
// developer's network or codex install. Not NODE_ENV=test: consola reads that as
// a test run and silences the info output the logger tests assert on.
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
// The deadline race ABANDONS a timed-out body; it does not cancel it. The body runs
// on -- and keeps spawning children -- alongside every test that follows. So each
// body gets its own AbortController, aborted when the deadline fires (and again
// once the body settles), and it travels WITH the body through AsyncLocalStorage
// rather than sitting in a module-level slot. That is the whole point: an abandoned
// continuation must see ITS OWN aborted signal, not the signal of whichever test
// happens to be live by the time it wakes up.
const TEST_ABORT = new AsyncLocalStorage<AbortSignal>();

/**
 * The running test's abort signal, aborted once its body has timed out or finished.
 * Spawn helpers consult it (test/helpers/run.ts) so an abandoned body cannot start a
 * new child, and so children it already started are torn down. Undefined outside a
 * test body, where there is no deadline to abandon.
 */
export function testAbortSignal(): AbortSignal | undefined {
  return TEST_ABORT.getStore();
}

/** `fn` raced against the deadline. Purely sync bodies can't be preempted
 *  (same as under bun); the race cuts off async bodies that stall. */
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
 * Whether pinning a timezone with `process.env.TZ` works in this runtime. Deno's TZ
 * support is unix-only: on Windows the zone comes from the OS and a runtime assignment
 * is ignored. Two tests need this, and they are the only reason the flag survives:
 * test/time.test.ts's "the DEFAULT zone honors the process TZ", which pins the property
 * that justifies deriving the day key in JS rather than with SQLite's `localtime`, and
 * test/cost.test.ts's calendar `--days` cutoff test, whose subject (`startOfLocalDay`) is
 * system-zone only by design. Day SLICING is not gated: `localDayKey(ms, timeZone)` takes
 * an explicit IANA zone, so reach for that parameter when the code under test offers one.
 */
export const TZ_PINNABLE = Deno.build.os !== "windows";
