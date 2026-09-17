import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  releaseFileLock,
  tryAcquireFileLock,
  withFileLock,
  withFileLockSync,
} from "../src/utils/file_lock.ts";
import { ROOT } from "./helpers/run.ts";
import { afterEach, expect, removeDir, tempDir, test } from "./helpers/testing.ts";
import { withUnprovablePidProbe } from "./helpers.ts";

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

const DEAD_PID = 2_147_483_646; // never alive -> pidAlive() returns false
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

// The steal judgment over a planted marker: a live holder is stolen only past the age horizon
// (a strict >, judged at the injected nowMs; Infinity never ages), a dead holder is stolen at
// once, and a JSON ts that is not finite reads as stale rather than as a lock that never ages out.
test("the steal judgment: age horizon at the injected nowMs, dead holders, and a non-finite ts", () => {
  const rows: {
    label: string;
    marker: string;
    staleMs: number;
    nowMs?: number;
    acquired: boolean;
  }[] = [
    {
      label: "exactly staleMs old is NOT stale",
      marker: marker(process.pid, 1_000),
      staleMs: 5_000,
      nowMs: 6_000,
      acquired: false,
    },
    {
      label: "one ms past staleMs steals",
      marker: marker(process.pid, 1_000),
      staleMs: 5_000,
      nowMs: 6_001,
      acquired: true,
    },
    {
      label: "staleMs=Infinity never age-steals a live holder, however old",
      marker: marker(process.pid, 1_000),
      staleMs: Number.POSITIVE_INFINITY,
      acquired: false,
    },
    {
      label: "a dead holder is stolen even when recent, even under staleMs=Infinity",
      marker: marker(DEAD_PID, Date.now()),
      staleMs: Number.POSITIVE_INFINITY,
      acquired: true,
    },
    {
      // JSON.parse turns 1e999 into Infinity.
      label: "a JSON marker with a non-finite ts is malformed, not immortal",
      marker: `{"pid":${process.pid},"ts":1e999}`,
      staleMs: 5_000,
      nowMs: 6_001,
      acquired: true,
    },
  ];
  dir = tempDir("copilot-env-file-lock-");
  rows.forEach((row, i) => {
    const path = join(dir, `${i}.lock`);
    writeFileSync(path, row.marker);
    const acquired = tryAcquireFileLock(
      path,
      row.staleMs,
      row.nowMs === undefined ? undefined : { nowMs: row.nowMs },
    );
    expect({ label: row.label, acquired }).toEqual({ label: row.label, acquired: row.acquired });
    if (acquired) releaseFileLock(path);
  });
});

test("jsonMarker writes the JSON {pid,ts} contract, and both formats are read", () => {
  const path = tmp("x.lock");
  expect(tryAcquireFileLock(path, 10_000, { nowMs: 1_000, jsonMarker: true })).toBe(true);
  // The on-disk form is the pre-unification autoupdate contract (old readers parse it).
  expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ pid: process.pid, ts: 1_000 });
  expect(tryAcquireFileLock(path, 10_000, { nowMs: 2_000 })).toBe(false);
  expect(tryAcquireFileLock(path, 5_000, { nowMs: 6_001 })).toBe(true);
  releaseFileLock(path);
  writeFileSync(path, marker(process.pid, 1_000));
  expect(tryAcquireFileLock(path, 10_000, { nowMs: 2_000, jsonMarker: true })).toBe(false);
});

// The release judgment reads the marker at the path: only OUR marker is deleted. A successor's
// marker (a non-holder's, or one an old release's rename-steal put over our held lock) survives
// byte-for-byte, or a third process would get a lock the successor believes it holds; our own
// marker goes even when its ts half is corrupted. A declined delete still drops our OS lock and
// handle, so the path is acquirable again once the successor's marker ages out.
test("release deletes our marker only: a non-holder's or a successor's survives, a corrupted ts of ours does not", () => {
  // arrange writes the path and returns the marker expected there AFTER the release (null = gone).
  const rows: { label: string; arrange: (path: string) => string | null }[] = [
    {
      label: "release by a non-holder is refused (a successor's lock survives)",
      arrange: (path) => {
        const successor = marker(process.pid + 1, 2_000);
        writeFileSync(path, successor);
        return successor;
      },
    },
    {
      label: "release by the HOLDER still spares a marker a rename-steal replaced",
      arrange: (path) => {
        expect(tryAcquireFileLock(path, 10_000, { nowMs: 1_000 })).toBe(true);
        const successor = marker(process.pid + 1, 2_000);
        writeFileSync(path, successor);
        return successor;
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
    // Acquirable again once the surviving marker ages out (or at once when nothing survived).
    expect({ label: row.label, reacquired: tryAcquireFileLock(path, 5_000, { nowMs: 8_000 }) })
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

// --- the unprovable-liveness posture at the steal boundary --------------------------------

// The dead-holder steal fires only on a PROVEN death. Without --allow-run (the daemon's own
// preload environment; the NotCapable shape is pinned in test/pid.test.ts) every pid reads
// "unproven", which must never license a steal of a possibly-live holder's lock.
//   staleMs=Infinity, unprovable  -> refused, marker untouched (a `=== "alive"` flatten steals here)
//   finite age horizon            -> still reclaims, so an unprovable token still boots the daemon
test("an unprovable liveness probe never licenses a steal; the age horizon still reclaims", async () => {
  const path = tmp("unprovable.lock");
  const agedPath = join(dir, "aged.lock");
  const planted = marker(process.pid, Date.now());
  writeFileSync(path, planted); // a test-planted marker: a LIVE holder, freshly stamped
  await withUnprovablePidProbe(async () => {
    // Dead-holder-only reclaim (the autoupdate/start-lock policy) backs off ...
    expect(tryAcquireFileLock(path, Number.POSITIVE_INFINITY)).toBe(false);
    // ... with the marker untouched.
    expect(readFileSync(path, "utf-8")).toBe(planted);
    // A dead holder reads the same to this token, so the dead-holder-only reclaim refuses it too ...
    writeFileSync(agedPath, marker(DEAD_PID, 1_000));
    expect(tryAcquireFileLock(agedPath, Number.POSITIVE_INFINITY)).toBe(false);
    // ... and the finite age horizon still reclaims it.
    expect(tryAcquireFileLock(agedPath, 5_000, { nowMs: 6_001 })).toBe(true);
  });
  releaseFileLock(agedPath);
});
