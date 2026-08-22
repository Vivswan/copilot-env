// The suite's ONE runner shim: bun:test's surface, backed by @std/testing/bdd
// and @std/expect. Every test file imports the runner from here, so runner
// policy -- the default per-test deadline (bun ran with `--timeout 15000`) and
// bun-parity sanitizer settings -- lives in one place.
//
// Sanitizers are off deliberately: bun:test never sanitized ops/resources, and
// the deadline race below leaves the timed-out body's ops pending by design,
// which the op sanitizer would misreport as the failure.
import { it } from "@std/testing/bdd";

export { expect } from "@std/expect";
export { afterEach, beforeEach, describe } from "@std/testing/bdd";

const DEFAULT_TIMEOUT_MS = 15_000;

type TestBody = () => void | Promise<void>;

type RegisterTest = (name: string, fn: TestBody, timeoutMs?: number) => void;

export interface TestApi extends RegisterTest {
  /** bun:test's conditional skip: `test.skipIf(cond)("name", fn)`. */
  skipIf(condition: boolean): RegisterTest;
}

/** `fn` raced against the deadline. Purely sync bodies can't be preempted
 *  (same as under bun); the race cuts off async bodies that stall. */
function withDeadline(name: string, fn: TestBody, timeoutMs: number): () => Promise<void> {
  return async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`test "${name}" timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    try {
      await Promise.race([Promise.resolve().then(fn), deadline]);
    } finally {
      clearTimeout(timer);
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
 * is ignored, so a test that pins a zone to prove local-day bucketing can only assert on
 * POSIX. `test.skipIf(!TZ_PINNABLE)` is how such a test opts out.
 */
export const TZ_PINNABLE = Deno.build.os !== "windows";
