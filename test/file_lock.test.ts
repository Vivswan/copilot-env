import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  LockBusyError,
  releaseFileLock,
  removeMarkerWithRetry,
  tryAcquireFileLock,
  withFileLock,
  withFileLockSync,
  withRequiredFileLockSync,
} from "../src/utils/file_lock.ts";
import { ROOT } from "./helpers/run.ts";
import { afterEach, expect, removeDir, tempDir, test } from "./helpers/testing.ts";

// The multi-process mutual-exclusion proof is config_lock.test.ts. Here every judgment is
// deterministic: probes use an injected clock or staleMs=Infinity, so a suspended test
// process can never age a lock mid-test.

let dir = "";
afterEach(() => {
  dir = removeDir(dir);
});
function tmp(name: string): string {
  dir = tempDir("copilot-env-file-lock-");
  return join(dir, name);
}

const DEAD_PID = 2_147_483_646; // never a live process
const marker = (pid: number, ts: number): string => `${pid}\n${ts}\n`;

test("acquire, contend against a fresh live holder, release, re-acquire", () => {
  const path = tmp("x.lock");
  expect(tryAcquireFileLock(path, 10_000, { nowMs: 1_000 })).toBe(true);
  expect(existsSync(path)).toBe(true);
  expect(tryAcquireFileLock(path, 10_000, { nowMs: 2_000 })).toBe(false); // fresh + live
  releaseFileLock(path);
  expect(existsSync(path)).toBe(false);
  expect(tryAcquireFileLock(path, 10_000, { nowMs: 3_000 })).toBe(true);
});

test("a HELD lock's marker stays readable and deletable by path (the sidecar invariant)", () => {
  // Other processes read the marker to judge the holder. An exclusive LockFileEx on Windows
  // fails reads from every other handle, so the OS lock lives on a sidecar, not the marker.
  const path = tmp("x.lock");
  expect(tryAcquireFileLock(path, 10_000, { nowMs: 1_000 })).toBe(true);
  expect(readFileSync(path, "utf-8")).toBe(marker(process.pid, 1_000));
  releaseFileLock(path);
});

// The incident's first link: on Windows a scanner's open handle refuses the marker delete once,
// and a delete given up on that first refusal leaves the marker behind. A refusal that is not an
// open handle's (ENOENT here) is not retried.
test("the marker delete is retried through an open-handle refusal, and gives up at once on any other", () => {
  dir = tempDir("copilot-env-file-lock-");
  const path = join(dir, "marker");
  writeFileSync(path, "payload");
  let calls = 0;
  const flaky = (p: string): void => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error("busy"), { code: "EBUSY" });
    rmSync(p, { force: true });
  };
  removeMarkerWithRetry(path, flaky);
  expect({ calls, gone: !existsSync(path) }).toEqual({ calls: 2, gone: true });

  let refusals = 0;
  const gone = (): void => {
    refusals += 1;
    throw Object.assign(new Error("nope"), { code: "ENOENT" });
  };
  expect(() => removeMarkerWithRetry(path, gone)).toThrow("nope");
  expect(refusals).toBe(1);
});

// A marker under a free OS lock is a leftover the acquirer overwrites, never a holder to wait out.
// The incident shape is the first row: on Windows a scanner's open handle refused the release's
// delete, and while the marker was judged, every writer (the ex-holder included) backed off from
// that fresh marker, wrote unlocked once its 4 s wait ran out, and only stopped colliding when the
// marker aged out at 10 s.
test("a leftover marker under a free OS lock never delays an acquirer, whatever its pid or age", () => {
  const rows: { label: string; leftover: string }[] = [
    { label: "this process, fresh", leftover: marker(process.pid, Date.now()) },
    { label: "another live pid, fresh", leftover: marker(process.ppid, Date.now()) },
    { label: "a dead pid, fresh", leftover: marker(DEAD_PID, Date.now()) },
    { label: "malformed", leftover: "garbage" },
  ];
  dir = tempDir("copilot-env-file-lock-");
  rows.forEach((row, i) => {
    const path = join(dir, `${i}.lock`);
    writeFileSync(path, row.leftover);
    const acquired = tryAcquireFileLock(path, 10_000, { nowMs: 5_000 });
    expect({ label: row.label, acquired, marker: readFileSync(path, "utf-8") })
      .toEqual({ label: row.label, acquired: true, marker: marker(process.pid, 5_000) });
    releaseFileLock(path);
  });
});

test("jsonMarker writes the JSON {pid,ts} contract; the hold refreshes past staleMs in either form", () => {
  const path = tmp("x.lock");
  expect(tryAcquireFileLock(path, 10_000, { nowMs: 1_000, jsonMarker: true })).toBe(true);
  // The on-disk form is the pre-unification autoupdate contract (old readers parse it).
  expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ pid: process.pid, ts: 1_000 });
  expect(tryAcquireFileLock(path, 10_000, { nowMs: 2_000 })).toBe(false);
  expect(tryAcquireFileLock(path, 5_000, { nowMs: 6_001 })).toBe(true);
  releaseFileLock(path);
});

// The release judgment reads the marker at the path: only OUR marker is deleted. A release by a
// non-holder (a test's cleanup, a stray primitive call) leaves another pid's marker byte-for-byte,
// or it would blind the probes to the live holder's pid; our own marker goes even when its ts half
// is corrupted (a torn write). A declined delete still drops our OS lock and handle.
test("release deletes our marker only: another pid's survives, a corrupted ts of ours does not", () => {
  // arrange writes the path and returns the marker expected there AFTER the release (null = gone).
  const rows: { label: string; arrange: (path: string) => string | null }[] = [
    {
      label: "release by a non-holder is refused (another pid's marker survives)",
      arrange: (path) => {
        const other = marker(process.pid + 1, 2_000);
        writeFileSync(path, other);
        return other;
      },
    },
    {
      label: "release by the holder works even when the marker's ts half is corrupted",
      arrange: (path) => {
        writeFileSync(path, `${process.pid}\ngarbage`);
        return null;
      },
    },
  ];
  dir = tempDir("copilot-env-file-lock-");
  rows.forEach((row, i) => {
    const path = join(dir, `${i}.lock`);
    const expectedAfter = row.arrange(path);
    releaseFileLock(path);
    const after = existsSync(path) ? readFileSync(path, "utf-8") : null;
    expect({ label: row.label, after }).toEqual({ label: row.label, after: expectedAfter });
    // Acquirable again at once: a surviving marker under a free OS lock is a leftover, not a holder.
    expect({ label: row.label, reacquired: tryAcquireFileLock(path, 5_000, { nowMs: 3_000 }) })
      .toEqual({ label: row.label, reacquired: true });
    releaseFileLock(path);
  });
});

// --- the scoped API (withFileLock / withFileLockSync) --------------------------------

// Both scopes run fn held and release on the way out; the async scope holds across the await
// and releases only after fn settles.
test("withFileLockSync and withFileLock run fn held, return its value, and release on the way out", async () => {
  const path = tmp("scoped.lock");
  const result = withFileLockSync(path, { staleMs: 10_000, waitMs: 0 }, (outcome) => {
    expect(outcome.held).toBe(true);
    expect(existsSync(path)).toBe(true);
    return 42;
  });
  expect(result).toBe(42);
  expect(existsSync(path)).toBe(false);

  const stillHeldAfterAwait = await withFileLock(
    path,
    { staleMs: 10_000, waitMs: 0 },
    async (outcome) => {
      expect(outcome.held).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return existsSync(path);
    },
  );
  expect(stillHeldAfterAwait).toBe(true);
  expect(existsSync(path)).toBe(false);
});

test("withFileLockSync reports a fresh live holder as not-held and releases nothing", () => {
  const path = tmp("scoped.lock");
  withFileLockSync(path, { staleMs: Number.POSITIVE_INFINITY, waitMs: 0 }, (outer) => {
    expect(outer.held).toBe(true);
    const innerHeld = withFileLockSync(
      path,
      { staleMs: Number.POSITIVE_INFINITY, waitMs: 0 },
      (outcome) => outcome.held,
    );
    expect(innerHeld).toBe(false);
    // The not-held scope must not have released the holder's lock (the holder is this
    // same pid, so a stray release here WOULD pass the pid guard and delete it).
    expect(existsSync(path)).toBe(true);
  });
  expect(existsSync(path)).toBe(false);
});

// A scope that refresh-acquires an aged lock of OURS reports held, but the lock is not the
// scope's to release: it stays with whoever owns it, a primitive hold (released by hand) or an
// enclosing scope (released by that scope's own exit).
test("a scope that refreshes an aged lock of ours never releases it: the primitive holder or the outer scope does", () => {
  const primitive = tmp("primitive.lock");
  expect(tryAcquireFileLock(primitive, Number.POSITIVE_INFINITY, { nowMs: 1_000 })).toBe(true);
  const held = withFileLockSync(
    primitive,
    { staleMs: 5_000, waitMs: 0, nowMs: 20_000 },
    (outcome) => outcome.held,
  );
  expect(held).toBe(true); // the refresh reports a (re-)acquire ...
  expect(existsSync(primitive)).toBe(true); // ... but a lock no scope owns is not a scope's to release
  releaseFileLock(primitive);
  expect(existsSync(primitive)).toBe(false);

  const nested = join(dir, "nested.lock");
  withFileLockSync(
    nested,
    { staleMs: Number.POSITIVE_INFINITY, waitMs: 0, nowMs: 1_000 },
    (outer) => {
      expect(outer.held).toBe(true);
      const innerHeld = withFileLockSync(
        nested,
        { staleMs: 5_000, waitMs: 0, nowMs: 20_000 },
        (outcome) => outcome.held,
      );
      expect(innerHeld).toBe(true);
      expect(existsSync(nested)).toBe(true); // ownership stayed with the enclosing scope
    },
  );
  expect(existsSync(nested)).toBe(false); // the OUTER scope's finally did the one release
});

test("the LAST settling async scope does the physical release (owner settles first)", async () => {
  const path = tmp("scoped.lock");
  let openGate = (): void => {};
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  let inner: Promise<void> = Promise.resolve();
  await withFileLock(
    path,
    { staleMs: Number.POSITIVE_INFINITY, waitMs: 0, nowMs: 1_000 },
    (outer) => {
      expect(outer.held).toBe(true);
      // A second scope refresh-acquires OUR aged marker and outlives this one (the
      // acquisition and the fn's run up to the gate happen synchronously here).
      inner = withFileLock(path, { staleMs: 5_000, waitMs: 0, nowMs: 20_000 }, async (o) => {
        expect(o.held).toBe(true);
        await gate;
      });
      return Promise.resolve();
    },
  );
  // The first (owning) scope settled while the refresher still runs: the lock must not
  // have been released out from under it.
  expect(existsSync(path)).toBe(true);
  openGate();
  await inner;
  expect(existsSync(path)).toBe(false); // the last scope out did the one release
});

test("a throwing fn (sync) or rejecting fn (async) releases exactly once, and the failure propagates", async () => {
  const path = tmp("scoped.lock");
  expect(() =>
    withFileLockSync(path, { staleMs: 10_000, waitMs: 0 }, () => {
      throw new Error("boom");
    })
  ).toThrow("boom");
  expect(existsSync(path)).toBe(false); // released by the scope's finally ...
  // ... and genuinely free: a fresh scope acquires it.
  expect(
    withFileLockSync(path, { staleMs: 10_000, waitMs: 0 }, (outcome) => outcome.held),
  ).toBe(true);

  await expect(
    withFileLock(path, { staleMs: 10_000, waitMs: 0 }, () => Promise.reject(new Error("boom"))),
  ).rejects.toThrow("boom");
  expect(existsSync(path)).toBe(false);
  expect(
    withFileLockSync(path, { staleMs: 10_000, waitMs: 0 }, (outcome) => outcome.held),
  ).toBe(true);
});

test("withFileLockSync bounded wait retries, notices once (never before noticeAfterMs), then proceeds not-held", () => {
  const path = tmp("scoped.lock");
  withFileLockSync(path, { staleMs: Number.POSITIVE_INFINITY, waitMs: 0 }, () => {
    let notices = 0;
    const held = withFileLockSync(
      path,
      { staleMs: Number.POSITIVE_INFINITY, waitMs: 40, retryMs: 5, onWait: () => notices++ },
      (outcome) => outcome.held,
    );
    expect(held).toBe(false);
    expect(notices).toBe(1); // once, not per retry

    let lateNotices = 0;
    withFileLockSync(
      path,
      {
        staleMs: Number.POSITIVE_INFINITY,
        waitMs: 40,
        retryMs: 5,
        noticeAfterMs: 60_000, // far beyond the wait budget: strictly-after means never here
        onWait: () => lateNotices++,
      },
      () => {},
    );
    expect(lateNotices).toBe(0);
  });
});

test("withFileLockSync refuses an async fn BEFORE its body runs, and a thenable-returning fn after, still releasing", () => {
  const path = tmp("scoped.lock");
  let ran = false;
  expect(() =>
    // @ts-expect-error the compile-time exclusion flags it too; this pins the RUNTIME guard
    withFileLockSync(path, { staleMs: 10_000, waitMs: 0 }, async () => {
      ran = true;
      await Promise.resolve();
    })
  ).toThrow("use withFileLock");
  expect(ran).toBe(false); // rejected up front: not even the pre-await prefix ran
  expect(existsSync(path)).toBe(false); // and no lock was taken for it

  // @ts-expect-error the compile-time exclusion flags it too; this pins the RUNTIME guard
  expect(() => withFileLockSync(path, { staleMs: 10_000, waitMs: 0 }, () => Promise.resolve(1)))
    .toThrow("use withFileLock");
  expect(existsSync(path)).toBe(false); // the misuse still released the scope's lock
});

test("releaseFileLock refuses a scope-held path: the scope owns the release", () => {
  // A primitive release mid-scope would strand SCOPE_HOLDS: the scope's own exit would
  // then physically release a lock a LATER acquirer holds. Refused loudly instead.
  const path = tmp("scoped.lock");
  withFileLockSync(path, { staleMs: 10_000, waitMs: 0 }, (outcome) => {
    expect(outcome.held).toBe(true);
    expect(() => releaseFileLock(path)).toThrow("scope-held");
    expect(existsSync(path)).toBe(true); // the refusal released nothing
  });
  expect(existsSync(path)).toBe(false); // the scope's own exit still released exactly once
});

test("the lock primitives and the update-lock test seam stay out of src/", () => {
  // The primitives are exported for the on-disk contract tests; production goes through the
  // scoped API, which keeps acquisition, release, and evidence in one owner. Each name is
  // allowed ONLY in its listed modules.
  //   tryAcquireFileLock, probeFileLock in daemon_lock.ts  -> released by process death, so no scope
  //   withUpdateLockForTests                               -> suites lock a hermetic path
  const allowedIn: Record<string, string[]> = {
    tryAcquireFileLock: [
      join(ROOT, "src", "utils", "file_lock.ts"),
      join(ROOT, "src", "scripts", "daemon_lock.ts"),
    ],
    probeFileLock: [
      join(ROOT, "src", "utils", "file_lock.ts"),
      join(ROOT, "src", "scripts", "daemon_lock.ts"),
    ],
    releaseFileLock: [join(ROOT, "src", "utils", "file_lock.ts")],
    withUpdateLockForTests: [join(ROOT, "src", "autoupdate", "lock.ts")],
  };
  const found: string[] = [];
  const walk = (dirPath: string): void => {
    for (const entry of Deno.readDirSync(dirPath)) {
      const p = join(dirPath, entry.name);
      if (entry.isDirectory) walk(p);
      else if (entry.name.endsWith(".ts")) {
        const source = readFileSync(p, "utf-8");
        for (const name of Object.keys(allowedIn)) {
          if (source.includes(name)) found.push(`${p}: ${name}`);
        }
      }
    }
  };
  walk(join(ROOT, "src"));
  // Positive control: the scanner must find each name at each of its allowed sites, or a
  // zero-offender read below would prove nothing.
  for (const [name, files] of Object.entries(allowedIn)) {
    for (const file of files) {
      expect(found).toContain(`${file}: ${name}`);
    }
  }
  const offenders = found.filter((hit) => {
    const [file, name] = hit.split(": ") as [string, string];
    return !(allowedIn[name] ?? []).includes(file);
  });
  expect(offenders).toEqual([]);
});

// --- the required lock --------------------------------------------------------------------

// The bounded policy's give-up is a not-held outcome, and a store writer must never run on one. The
// holder here is this process's own primitive hold, which the scope can neither refresh (fresh
// marker) nor take, so it gives up at waitMs.
test("withRequiredFileLockSync never runs fn unlocked: a holder past the wait is a LockBusyError naming the path and pid", () => {
  const path = tmp("required.lock");
  expect(tryAcquireFileLock(path, Number.POSITIVE_INFINITY, { nowMs: 1_000 })).toBe(true);
  let ran = false;
  let thrown: unknown;
  try {
    withRequiredFileLockSync(
      path,
      { staleMs: Number.POSITIVE_INFINITY, waitMs: 40, retryMs: 5 },
      () => {
        ran = true;
      },
    );
  } catch (e) {
    thrown = e;
  }
  const holderMarker = readFileSync(path, "utf-8");
  releaseFileLock(path);
  expect(holderMarker).toBe(marker(process.pid, 1_000)); // the failed scope released nothing
  expect(ran).toBe(false);
  expect(thrown).toBeInstanceOf(LockBusyError);
  expect((thrown as Error).message).toContain(path);
  expect((thrown as Error).message).toContain(`pid ${process.pid}`);

  // Lock free: fn runs with the lock evidence, and the scope releases on the way out.
  expect(withRequiredFileLockSync(path, { staleMs: 10_000, waitMs: 0 }, (lock) => lock.held))
    .toBe(true);
  expect(existsSync(path)).toBe(false);
});
