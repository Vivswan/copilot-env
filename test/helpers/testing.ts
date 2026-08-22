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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@std/testing/bdd";
import { CI_PS_DOCUMENTS_DIR_ENV, CI_RC_DIR_ENV } from "../../src/shell/integration.ts";

export { expect } from "@std/expect";
export { afterEach, beforeEach, describe } from "@std/testing/bdd";

// --- the suite-wide agent-state sandbox ---------------------------------------
//
// Every env var that steers a real agent-state path is repointed into one per-run temp dir
// here, so a test that sets up no harness of its own still cannot touch the developer's
// `~/.codex`, `~/.claude`, `~/.claude.json`, copilot-api home, or shell rc files.
//
// HOME stays REAL: each path above has its own override, which is what makes it redirectable
// without HOME.
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), "copilot-env-suite-"));
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
globalThis.addEventListener("unload", () => {
  rmSync(SANDBOX_HOME, { recursive: true, force: true });
});

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
 * is ignored.
 *
 * ONE test still needs this, and it is the only reason the flag survives:
 * test/time.test.ts's "the DEFAULT zone honors the process TZ", which pins the property
 * that justifies deriving the day key in JS rather than with SQLite's `localtime`. Day
 * SLICING itself is no longer gated -- `localDayKey(ms, timeZone)` takes an explicit
 * IANA zone, so every usage source's local-day bucketing is asserted on all three
 * platforms. Reach for that parameter, not this flag.
 */
export const TZ_PINNABLE = Deno.build.os !== "windows";
