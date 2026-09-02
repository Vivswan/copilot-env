import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  reclaimStaleLock,
  releaseFileLock,
  tryAcquireFileLock,
  withFileLock,
  withFileLockSync,
} from "../src/utils/file_lock.ts";
import { ROOT } from "./helpers/run.ts";
import { afterEach, expect, test } from "./helpers/testing.ts";
import { removeDir, tmpDir } from "./helpers.ts";

// Direct tests of the shared lock's parameterization (staleMs, injected nowMs, marker
// format) and of the steal path's restore contract. The multi-process mutual-exclusion
// proof lives in config_lock.test.ts; here each judgment is exercised deterministically
// (probes use an injected clock or staleMs=Infinity, so a suspended test process can
// never age a lock mid-test).

let dir = "";
afterEach(() => {
  dir = removeDir(dir);
});
function tmp(name: string): string {
  dir = tmpDir("copilot-env-file-lock-");
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
  // The marker is the cross-version contract: other processes read it to judge the holder.
  // Holding the OS lock on the marker itself would break exactly that on Windows, where an
  // exclusive LockFileEx fails reads from every other handle -- so the lock lives on a
  // sidecar and this by-path read must work on every platform.
  const path = tmp("x.lock");
  expect(tryAcquireFileLock(path, 10_000, { nowMs: 1_000 })).toBe(true);
  expect(readFileSync(path, "utf-8")).toBe(marker(process.pid, 1_000));
  releaseFileLock(path);
});

test("staleMs is the age horizon, judged at the injected nowMs (strictly older steals)", () => {
  const path = tmp("x.lock");
  writeFileSync(path, marker(process.pid, 1_000));
  // Exactly staleMs old is NOT stale (the judgment is a strict >).
  expect(tryAcquireFileLock(path, 5_000, { nowMs: 6_000 })).toBe(false);
  // One millisecond past the horizon it is stolen.
  expect(tryAcquireFileLock(path, 5_000, { nowMs: 6_001 })).toBe(true);
});

test("staleMs=Infinity never age-steals a live holder, however old", () => {
  const path = tmp("x.lock");
  writeFileSync(path, marker(process.pid, 1_000)); // ancient, but the holder is alive
  expect(tryAcquireFileLock(path, Number.POSITIVE_INFINITY)).toBe(false);
});

test("a dead holder is stolen even when recent, even under staleMs=Infinity", () => {
  const path = tmp("x.lock");
  writeFileSync(path, marker(DEAD_PID, Date.now()));
  expect(tryAcquireFileLock(path, Number.POSITIVE_INFINITY)).toBe(true);
});

test("jsonMarker writes the JSON {pid,ts} contract, and both formats are read", () => {
  const path = tmp("x.lock");
  expect(tryAcquireFileLock(path, 10_000, { nowMs: 1_000, jsonMarker: true })).toBe(true);
  // The on-disk form is the pre-unification autoupdate contract (old readers parse it).
  expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ pid: process.pid, ts: 1_000 });
  // A live fresh JSON lock blocks a native-format contender ...
  expect(tryAcquireFileLock(path, 10_000, { nowMs: 2_000 })).toBe(false);
  // ... the same age horizon applies to it ...
  expect(tryAcquireFileLock(path, 5_000, { nowMs: 6_001 })).toBe(true);
  releaseFileLock(path);
  // ... and a native lock blocks a JSON-format contender.
  writeFileSync(path, marker(process.pid, 1_000));
  expect(tryAcquireFileLock(path, 10_000, { nowMs: 2_000, jsonMarker: true })).toBe(false);
});

test("a JSON marker with a non-finite ts is malformed, not immortal", () => {
  const path = tmp("x.lock");
  // JSON.parse turns 1e999 into Infinity; it must read as stale, not as a lock that can
  // never age out.
  writeFileSync(path, `{"pid":${process.pid},"ts":1e999}`);
  expect(tryAcquireFileLock(path, 5_000, { nowMs: 6_001 })).toBe(true);
});

test("reclaimStaleLock restores a FRESH holder's lock instead of stealing it", () => {
  const path = tmp("x.lock");
  // The interleaving under test: we observed a stale marker, but before our rename a
  // fresh holder replaced the lock. The yanked marker no longer matches, so the
  // reclaim must put the fresh lock back untouched.
  const fresh = marker(process.pid, Date.now());
  writeFileSync(path, fresh);
  reclaimStaleLock(path, marker(DEAD_PID, 1_000));
  expect(readFileSync(path, "utf-8")).toBe(fresh); // restored byte-for-byte
  expect(tryAcquireFileLock(path, Number.POSITIVE_INFINITY)).toBe(false); // still held
  // No .steal.* remnant is left behind.
  expect(readdirSync(dir).filter((f) => f.includes(".steal."))).toEqual([]);
});

test("reclaimStaleLock removes the lock when it IS the stale marker we judged", () => {
  const path = tmp("x.lock");
  const stale = marker(DEAD_PID, 1_000);
  writeFileSync(path, stale);
  reclaimStaleLock(path, stale);
  expect(existsSync(path)).toBe(false);
});

test("release by a non-holder is refused (a successor's lock survives)", () => {
  const path = tmp("x.lock");
  writeFileSync(path, marker(process.pid + 1, Date.now()));
  releaseFileLock(path);
  expect(existsSync(path)).toBe(true);
});

test("release by the HOLDER still spares a marker a rename-steal replaced", () => {
  // The mixed-version window: we hold the lock, and an old release (which judges by marker
  // age alone, seeing no OS lock) renames ours aside and puts its own marker at the path.
  // Our release must delete OUR marker, never the successor's -- otherwise we would hand a
  // third process a lock the successor believes it holds.
  const path = tmp("x.lock");
  expect(tryAcquireFileLock(path, 10_000, { nowMs: 1_000 })).toBe(true);
  const successor = marker(process.pid + 1, 2_000);
  writeFileSync(path, successor);

  releaseFileLock(path);
  expect(readFileSync(path, "utf-8")).toBe(successor); // untouched, byte-for-byte

  // Our OS lock and handle were dropped all the same, so the path is acquirable again once
  // the successor's marker ages out -- a declined delete must not strand the sidecar.
  expect(tryAcquireFileLock(path, 5_000, { nowMs: 8_000 })).toBe(true);
});

test("release by the holder works even when the marker's ts half is corrupted", () => {
  const path = tmp("x.lock");
  writeFileSync(path, `${process.pid}\ngarbage`);
  releaseFileLock(path);
  expect(existsSync(path)).toBe(false);
});

// --- the scoped API (withFileLock / withFileLockSync) --------------------------------

test("withFileLockSync runs fn held, returns its value, and releases on the way out", () => {
  const path = tmp("scoped.lock");
  const result = withFileLockSync(path, { staleMs: 10_000, waitMs: 0 }, (outcome) => {
    expect(outcome.held).toBe(true);
    expect(existsSync(path)).toBe(true);
    return 42;
  });
  expect(result).toBe(42);
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

test("a scope that refreshes a PRIMITIVE holder's aged lock never releases it", () => {
  const path = tmp("scoped.lock");
  expect(tryAcquireFileLock(path, Number.POSITIVE_INFINITY, { nowMs: 1_000 })).toBe(true);
  const held = withFileLockSync(
    path,
    { staleMs: 5_000, waitMs: 0, nowMs: 20_000 },
    (outcome) => outcome.held,
  );
  expect(held).toBe(true); // the refresh reports a (re-)acquire ...
  expect(existsSync(path)).toBe(true); // ... but a lock no scope owns is not a scope's to release
  releaseFileLock(path);
  expect(existsSync(path)).toBe(false);
});

test("a nested scope that refreshes OUR aged lock never releases the outer scope's lock", () => {
  const path = tmp("scoped.lock");
  withFileLockSync(
    path,
    { staleMs: Number.POSITIVE_INFINITY, waitMs: 0, nowMs: 1_000 },
    (outer) => {
      expect(outer.held).toBe(true);
      // Our own marker, aged past the inner staleMs: the primitive refreshes it in place and
      // reports a (re-)acquire, so the nested scope observes held ...
      const innerHeld = withFileLockSync(
        path,
        { staleMs: 5_000, waitMs: 0, nowMs: 20_000 },
        (outcome) => outcome.held,
      );
      expect(innerHeld).toBe(true);
      // ... but ownership stayed with the enclosing scope: the lock is still there.
      expect(existsSync(path)).toBe(true);
    },
  );
  expect(existsSync(path)).toBe(false); // the OUTER scope's finally did the one release
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

test("withFileLockSync releases exactly once when fn throws, and the throw propagates", () => {
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
});

test("withFileLockSync bounded wait retries, notices once, then proceeds not-held", () => {
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
  });
});

test("withFileLockSync never notices before noticeAfterMs has fully passed", () => {
  const path = tmp("scoped.lock");
  withFileLockSync(path, { staleMs: Number.POSITIVE_INFINITY, waitMs: 0 }, () => {
    let notices = 0;
    withFileLockSync(
      path,
      {
        staleMs: Number.POSITIVE_INFINITY,
        waitMs: 40,
        retryMs: 5,
        noticeAfterMs: 60_000, // far beyond the wait budget: strictly-after means never here
        onWait: () => notices++,
      },
      () => {},
    );
    expect(notices).toBe(0);
  });
});

test("withFileLockSync refuses an async fn BEFORE its body runs", () => {
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
});

test("withFileLockSync refuses a plain fn returning a thenable, still releasing", () => {
  const path = tmp("scoped.lock");
  // @ts-expect-error the compile-time exclusion flags it too; this pins the RUNTIME guard
  expect(() => withFileLockSync(path, { staleMs: 10_000, waitMs: 0 }, () => Promise.resolve(1)))
    .toThrow("use withFileLock");
  expect(existsSync(path)).toBe(false); // the misuse still released the scope's lock
});

test("withFileLock holds across an async fn and releases only after it settles", async () => {
  const path = tmp("scoped.lock");
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

test("withFileLock releases when the async fn rejects, and the rejection propagates", async () => {
  const path = tmp("scoped.lock");
  await expect(
    withFileLock(path, { staleMs: 10_000, waitMs: 0 }, () => Promise.reject(new Error("boom"))),
  ).rejects.toThrow("boom");
  expect(existsSync(path)).toBe(false);
  expect(
    withFileLockSync(path, { staleMs: 10_000, waitMs: 0 }, (outcome) => outcome.held),
  ).toBe(true);
});

test("the lock outcomes are frozen singletons: evidence cannot be doctored in place", () => {
  const path = tmp("scoped.lock");
  withFileLockSync(path, { staleMs: Number.POSITIVE_INFINITY, waitMs: 0 }, (outer) => {
    expect(Object.isFrozen(outer)).toBe(true);
    expect(() => {
      (outer as { held: boolean }).held = false;
    }).toThrow();
    // The not-held branch hands out the same immutable evidence discipline.
    withFileLockSync(path, { staleMs: Number.POSITIVE_INFINITY, waitMs: 0 }, (inner) => {
      expect(inner.held).toBe(false);
      expect(Object.isFrozen(inner)).toBe(true);
      expect(() => {
        (inner as { held: boolean }).held = true;
      }).toThrow();
    });
  });
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
  // tryAcquireFileLock/releaseFileLock/reclaimStaleLock are exported for the on-disk
  // contract tests only, and withUpdateLockForTests exists so suites can lock a hermetic
  // path; production code goes through the scoped API (withFileLock/withFileLockSync and
  // withUpdateLock), which is what keeps acquisition, release, and evidence in one owner.
  // Each name is allowed ONLY in its listed modules, never src-wide. The one production
  // consumer of tryAcquireFileLock and probeFileLock is the daemon's hold-for-life
  // liveness lock (src/scripts/daemon_lock.ts): its lock is released by process death, so
  // acquisition has no scope to release in, and the CLI-side consult probes holder-ship
  // without ever taking the lock over -- the copilot_api liveness sites go through that
  // module's daemonLockVerdict/daemonLockHolderPid, never the raw primitives.
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
    reclaimStaleLock: [join(ROOT, "src", "utils", "file_lock.ts")],
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
