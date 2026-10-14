import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { join } from "node:path";
import {
  type FileLockProbe,
  LockBusyError,
  probeFileLock,
  releaseFileLock,
  removeLeftoverLock,
  removeMarkerWithRetry,
  tryAcquireFileLock,
  withFileLock,
  withFileLockSync,
  withRequiredFileLockSync,
} from "../../src/utils/file_lock.ts";
import type { OsLock } from "../../src/utils/os_lock.ts";
import { createPosixOsLock, osLock, osLockSupported } from "../../src/utils/os_lock.ts";
import type { PidLiveness } from "../../src/utils/pid.ts";
import { PROJECT_ROOT } from "../../src/utils/root.ts";
import { expect, tempDir, test } from "../helpers/testing.ts";
import { tsFilesUnder } from "../helpers/tree.ts";

// The multi-process mutual-exclusion proof is config_lock.e2e.test.ts and file_lock.e2e.test.ts,
// the crash release daemon_lock.e2e.test.ts. Here every judgment is deterministic: probes use an
// injected clock or staleMs=Infinity, so a suspended test process can never age a lock mid-test.
// Under the OS lock a marker is never judged, so the pid rows below play a holder only on the
// marker layer, reached through an injected OS lock that will not load, as a machine without the
// libc is.

let dir = "";
function tmp(name: string): string {
  dir = tempDir("copilot-env-file-lock-");
  return join(dir, name);
}

const DEAD_PID = 2_147_483_646; // never a live process
const OTHER_PID = process.pid + 1; // another process, as the injected liveness says
const LIVE_UNRELATED_PID = process.ppid; // the launcher: alive for the test, and not a holder
const marker = (pid: number, ts: number): string => `${pid}\n${ts}\n`;

/** A machine whose libc or kernel32 will not load: the one state that puts this binary on the
 *  marker layer, for every process of it alike. */
const NO_LIBC: OsLock = {
  tryExclusive: () => ({ kind: "unsupported", cause: new Error("dlopen failed") }),
  tryShared: () => ({ kind: "unsupported", cause: new Error("dlopen failed") }),
  release: () => {},
};

/** A filesystem that refuses the lock call (an exFAT or SMB home): the lock's own failure, never
 *  a fallback to the marker layer. */
const REFUSES_LOCKS: OsLock = {
  tryExclusive: () => {
    throw Object.assign(new Error("flock refused with ENOLCK"), { code: "ENOLCK" });
  },
  tryShared: () => {
    throw Object.assign(new Error("flock refused with ENOLCK"), { code: "ENOLCK" });
  },
  release: () => {},
};

// The OS layer is the lock on every platform CI runs: a libc or kernel32 that will not load there
// is a defect in the adapter (a wrong library name or symbol), never the silent fallback the marker
// layer is for machines we do not run. The cause prints with the failure.
test("the OS layer loads on linux, darwin, and win32", () => {
  const loaded = osLockSupported();
  if (["linux", "darwin", "win32"].includes(process.platform)) {
    expect(loaded, loaded.supported ? "" : String(loaded.cause)).toEqual({ supported: true });
  }
});

test("acquire, contend against a fresh live holder, release, re-acquire", () => {
  const path = tmp("x.lock");
  expect(tryAcquireFileLock(path, 10_000, { nowMs: 1_000 })).toBe(true);
  expect(existsSync(path)).toBe(true);
  expect(tryAcquireFileLock(path, 10_000, { nowMs: 2_000 })).toBe(false); // fresh + live
  releaseFileLock(path);
  expect(existsSync(path)).toBe(false);
  expect(tryAcquireFileLock(path, 10_000, { nowMs: 3_000 })).toBe(true);
});

test("the lock file IS the marker: it names the holder's pid and clock, readable by path, beside a sidecar that outlives the release", () => {
  // Other processes read it to name the holder (the daemon verdict, LockBusyError's pid), and the
  // daemon's preload creates the same file, so the text is the whole readable protocol. The
  // sidecar carries the OS lock and is never unlinked (the orphan-inode note in file_lock.ts).
  const path = tmp("x.lock");
  expect(tryAcquireFileLock(path, 10_000, { nowMs: 1_000 })).toBe(true);
  expect(readFileSync(path, "utf-8")).toBe(marker(process.pid, 1_000));
  releaseFileLock(path);
  expect([existsSync(path), existsSync(`${path}.oslock`)]).toEqual([false, true]);
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

// Under the OS lock the marker is never judged: a marker under a free sidecar is a leftover
// whatever it says, so a crashed holder's file, garbage, our own pid outside the record (a release
// Windows refused), and the two pids the marker layer cannot tell from a holder (the incident: a
// pid the OS recycled onto a live process, and one this token cannot signal, which the injected
// liveness plays by answering alive for every pid) are all written over at once.
test("under a free OS lock any marker is written over: a dead pid, garbage, our own pid, a LIVE recycled pid, and a pid the liveness calls alive", () => {
  const rows: { label: string; leftover: string }[] = [
    { label: "this process, fresh, not held", leftover: marker(process.pid, Date.now()) },
    { label: "a dead pid, fresh", leftover: marker(DEAD_PID, Date.now()) },
    { label: "malformed", leftover: "garbage" },
    { label: "a live unrelated pid", leftover: marker(LIVE_UNRELATED_PID, Date.now()) },
    { label: "a pid the liveness reads alive", leftover: marker(OTHER_PID, Date.now()) },
  ];
  dir = tempDir("copilot-env-file-lock-");
  let livenessReads = 0;
  const alwaysAlive = (): PidLiveness => {
    livenessReads += 1;
    return "alive";
  };
  rows.forEach((row, i) => {
    const path = join(dir, `${i}.lock`);
    writeFileSync(path, row.leftover);
    const acquired = tryAcquireFileLock(path, 10_000, { nowMs: 5_000, liveness: alwaysAlive });
    expect({ label: row.label, acquired, marker: readFileSync(path, "utf-8") }).toEqual({
      label: row.label,
      acquired: true,
      marker: marker(process.pid, 5_000),
    });
    releaseFileLock(path);
  });
  expect(livenessReads).toBe(0); // the OS lock judged, never the pid table
});

// The probe's contract with the daemon verdict and the dry-run marker: the shared try-lock on the
// sidecar reads a holder, and a free sidecar beside a marker is a leftover naming its LAST holder.
// The holder here is another handle on the sidecar, as another process would hold it, since an
// in-process hold answers from the record without touching the OS.
test("probeFileLock: a held sidecar reads held with the marker's pid, a free one free, no sidecar beside a marker free, and nothing absent", () => {
  const path = tmp("probe.lock");
  expect(probeFileLock(path)).toEqual({ kind: "absent" });
  writeFileSync(path, marker(LIVE_UNRELATED_PID, 1_000));
  expect(probeFileLock(path)).toEqual({
    kind: "free",
    markerPid: LIVE_UNRELATED_PID,
    judge: "os-lock",
  });
  const held = osLock.tryExclusive(`${path}.oslock`);
  if (held.kind !== "locked") throw new Error(`the sidecar did not lock: ${held.kind}`);
  try {
    expect(probeFileLock(path)).toEqual({
      kind: "held",
      markerPid: LIVE_UNRELATED_PID,
      judge: "os-lock",
    });
    // A held sidecar still reads, from another handle, as the empty file it is: a home walker
    // (a backup, `agent uninstall`'s look, a test's fingerprint) must never meet the lock. On
    // Windows a LockFileEx range is mandatory, which is why the locked byte sits far past EOF.
    expect(readFileSync(`${path}.oslock`, "utf-8")).toBe("");
    // A held lock is never a leftover: nothing is removed, whatever the pid table says.
    expect({ removed: removeLeftoverLock(path), marker: existsSync(path) }).toEqual({
      removed: false,
      marker: true,
    });
  } finally {
    osLock.release(held.handle);
  }
  expect(probeFileLock(path)).toEqual({
    kind: "free",
    markerPid: LIVE_UNRELATED_PID,
    judge: "os-lock",
  });
  // The probe's own try-lock is SHARED: it coexists with another shared holder (a concurrent
  // probe) and reads the lock free. An exclusive probe would read that holder as held.
  const shared = osLock.tryShared(`${path}.oslock`);
  if (shared.kind !== "locked") throw new Error(`the sidecar did not share: ${shared.kind}`);
  try {
    expect(probeFileLock(path)).toEqual({
      kind: "free",
      markerPid: LIVE_UNRELATED_PID,
      judge: "os-lock",
    });
  } finally {
    osLock.release(shared.handle);
  }
  // A free one is the leftover the CLI clears before a spawn, its live pid notwithstanding.
  expect({ removed: removeLeftoverLock(path), marker: existsSync(path) }).toEqual({
    removed: true,
    marker: false,
  });
});

// --- the marker layer (a machine whose libc will not load) -------------------------------

// Where the libc will not load the marker is still taken, without a link: the exclusive create is
// the guard and the pid in the file the judge, with the layer's two known limits: a pid the
// liveness calls alive (a sandboxed token's EPERM, a recycled pid) is a holder, and a leftover is
// judged then unlinked. The probe says which layer answered, so the daemon verdict and the start
// notice know. A filesystem that refuses the lock CALL is not this layer's: that is the lock's own
// failure, and the caller sees `unavailable` with the refusal, never a second judge of the marker.
test("the marker layer: taken without a link where the libc will not load; a refused lock call is unavailable, never a fallback", () => {
  dir = tempDir("copilot-env-file-lock-");
  const path = join(dir, "x.lock");
  const alive = (): PidLiveness => "alive";
  const dead = (): PidLiveness => "dead";
  expect(tryAcquireFileLock(path, 10_000, { nowMs: 1_000, osLock: NO_LIBC })).toBe(true);
  expect(readFileSync(path, "utf-8")).toBe(marker(process.pid, 1_000));
  expect(probeFileLock(path, { osLock: NO_LIBC })).toEqual({
    kind: "held",
    markerPid: process.pid,
    judge: "pid",
  });
  releaseFileLock(path);
  expect(existsSync(path)).toBe(false);
  // The incident this layer exists for: a home on a filesystem without hard links (exFAT, some
  // SMB or FUSE). No scratch directory can refuse a link, so the pin is on the mechanism: the
  // lock module never links; its create is an exclusive open and a rename.
  const source = readFileSync(join(PROJECT_ROOT, "src", "utils", "file_lock.ts"), "utf-8");
  expect(source).not.toMatch(/\blinkSync\b|\blink\(/);

  const rows: {
    label: string;
    leftover: string;
    liveness: () => PidLiveness;
    acquired: boolean;
    probe: FileLockProbe;
  }[] = [
    {
      label: "a pid the liveness reads alive (EPERM, or recycled)",
      leftover: marker(OTHER_PID, 1_000),
      liveness: alive,
      acquired: false,
      probe: { kind: "held", markerPid: OTHER_PID, judge: "pid" },
    },
    {
      label: "a dead pid",
      leftover: marker(OTHER_PID, 1_000),
      liveness: dead,
      acquired: true,
      probe: { kind: "free", markerPid: OTHER_PID, judge: "pid" },
    },
    {
      label: "garbage, a creator mid-write or a torn file, after the grace",
      leftover: "garbage",
      liveness: alive,
      acquired: true,
      probe: { kind: "unknown" },
    },
    {
      label: "an empty marker: a creator between its guard and its text",
      leftover: "",
      liveness: alive,
      acquired: true,
      probe: { kind: "unknown" },
    },
  ];
  rows.forEach((row, i) => {
    const rowPath = join(dir, `${i}.lock`);
    writeFileSync(rowPath, row.leftover);
    const probe = probeFileLock(rowPath, { osLock: NO_LIBC, liveness: row.liveness });
    const acquired = tryAcquireFileLock(rowPath, 10_000, {
      nowMs: 5_000,
      osLock: NO_LIBC,
      liveness: row.liveness,
      retryMs: 5,
    });
    expect({ label: row.label, probe, acquired, marker: readFileSync(rowPath, "utf-8") }).toEqual({
      label: row.label,
      probe: row.probe,
      acquired: row.acquired,
      marker: row.acquired ? marker(process.pid, 5_000) : row.leftover,
    });
    if (acquired) releaseFileLock(rowPath);
  });

  // The CLI's pre-spawn clear for a daemon whose token cannot judge the pid: a dead holder's
  // leftover goes, a pid the liveness calls alive stays.
  writeFileSync(path, marker(OTHER_PID, 1_000));
  expect(removeLeftoverLock(path, { osLock: NO_LIBC, liveness: alive })).toBe(false);
  expect(removeLeftoverLock(path, { osLock: NO_LIBC, liveness: dead })).toBe(true);
  expect(existsSync(path)).toBe(false);

  // A refused lock call: unavailable with the refusal itself, the marker never written. Twice:
  // through a seam that throws, and through the REAL POSIX adapter over a libc table whose flock
  // fails ENOLCK, so an adapter that read that errno as "no libc" (a fallback) would show here.
  const refusingLibc = createPosixOsLock(() => ({
    kind: "loaded",
    symbols: { flock: () => -1, errno: () => osConstants.errno.ENOLCK },
  }));
  for (const refusing of [REFUSES_LOCKS, refusingLibc]) {
    const refused = withFileLockSync(
      path,
      { staleMs: 10_000, waitMs: 0, osLock: refusing },
      (o) => o,
    );
    expect(refused).toEqual({ held: false, reason: "unavailable", cause: expect.any(Error) });
    expect(() =>
      withRequiredFileLockSync(path, { staleMs: 10_000, waitMs: 0, osLock: refusing }, () => {}),
    ).toThrow("ENOLCK");
    expect(existsSync(path)).toBe(false);
  }
});

// The release judgment reads the marker at the path: only OUR marker is deleted. A release by a
// non-holder (a test's cleanup, a stray primitive call) leaves another pid's marker byte-for-byte,
// or it would blind the probes to the live holder's pid; our own marker goes even when its ts half
// is corrupted (a torn write).
test("release deletes our marker only: another pid's survives, a corrupted ts of ours does not", () => {
  // arrange writes the path and returns the marker expected there AFTER the release (null = gone).
  const rows: { label: string; arrange: (path: string) => string | null }[] = [
    {
      label: "release by a non-holder is refused (another pid's marker survives)",
      arrange: (path) => {
        const other = marker(OTHER_PID, 2_000);
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
    }),
  ).toThrow("boom");
  expect(existsSync(path)).toBe(false); // released by the scope's finally ...
  // ... and genuinely free: a fresh scope acquires it.
  expect(withFileLockSync(path, { staleMs: 10_000, waitMs: 0 }, (outcome) => outcome.held)).toBe(
    true,
  );

  await expect(
    withFileLock(path, { staleMs: 10_000, waitMs: 0 }, () => Promise.reject(new Error("boom"))),
  ).rejects.toThrow("boom");
  expect(existsSync(path)).toBe(false);
  expect(withFileLockSync(path, { staleMs: 10_000, waitMs: 0 }, (outcome) => outcome.held)).toBe(
    true,
  );
});

test("withFileLockSync bounded wait retries, notices once with the holder's probe (never before noticeAfterMs), then proceeds not-held", () => {
  const path = tmp("scoped.lock");
  withFileLockSync(path, { staleMs: Number.POSITIVE_INFINITY, waitMs: 0 }, () => {
    const notices: FileLockProbe[] = [];
    const held = withFileLockSync(
      path,
      {
        staleMs: Number.POSITIVE_INFINITY,
        waitMs: 40,
        retryMs: 5,
        onWait: (holder) => notices.push(holder),
      },
      (outcome) => outcome.held,
    );
    expect(held).toBe(false);
    // Once, not per retry, naming the holder it waits on (the start notice reads the judge).
    expect(notices).toEqual([{ kind: "held", markerPid: process.pid, judge: "os-lock" }]);

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
    }),
  ).toThrow("use withFileLock");
  expect(ran).toBe(false); // rejected up front: not even the pre-await prefix ran
  expect(existsSync(path)).toBe(false); // and no lock was taken for it

  expect(() =>
    // @ts-expect-error the compile-time exclusion flags it too; this pins the RUNTIME guard
    withFileLockSync(path, { staleMs: 10_000, waitMs: 0 }, () => Promise.resolve(1)),
  ).toThrow("use withFileLock");
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

test("the lock primitives stay out of src/", () => {
  // The primitives are exported for the on-disk contract tests; production goes through the
  // scoped API, which keeps acquisition, release, and evidence in one owner. Each name is
  // allowed ONLY in its listed modules.
  //   tryAcquireFileLock, probeFileLock in daemon_lock.ts  -> released by process death, so no scope
  //   removeLeftoverLock in daemon_lock.ts                 -> the CLI clears a dead daemon's marker
  //   probeFileLock in dry_run.ts                          -> a child's read of the marker
  const allowedIn: Record<string, string[]> = {
    tryAcquireFileLock: [
      join(PROJECT_ROOT, "src", "utils", "file_lock.ts"),
      join(PROJECT_ROOT, "src", "copilot_api", "daemon_lock.ts"),
    ],
    probeFileLock: [
      join(PROJECT_ROOT, "src", "utils", "file_lock.ts"),
      join(PROJECT_ROOT, "src", "copilot_api", "daemon_lock.ts"),
      join(PROJECT_ROOT, "src", "utils", "dry_run.ts"),
    ],
    removeLeftoverLock: [
      join(PROJECT_ROOT, "src", "utils", "file_lock.ts"),
      join(PROJECT_ROOT, "src", "copilot_api", "daemon_lock.ts"),
    ],
    releaseFileLock: [join(PROJECT_ROOT, "src", "utils", "file_lock.ts")],
  };
  const found: string[] = [];
  for (const p of tsFilesUnder(join(PROJECT_ROOT, "src"))) {
    const source = readFileSync(p, "utf-8");
    for (const name of Object.keys(allowedIn)) {
      if (source.includes(name)) found.push(`${p}: ${name}`);
    }
  }
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
  expect(withRequiredFileLockSync(path, { staleMs: 10_000, waitMs: 0 }, (lock) => lock.held)).toBe(
    true,
  );
  expect(existsSync(path)).toBe(false);
});

// The bounded wait measures one holder's silence, not the queue. Behind live writers the marker
// changes at every hold (a release, then the successor's pid+ts), so a contender waits them all out
// however long the queue is; only a marker unchanged for waitMs is a hung or leaked holder. The
// other process is played on the marker layer by a marker naming a foreign pid, kept alive by the
// injected liveness, which is consulted on every refused attempt and so can rewrite the marker
// between them.
test("the bounded wait restarts on every holder change: live writers never starve a contender, a silent holder still gives up at waitMs", () => {
  const path = tmp("queue.lock");
  const HOLDS = 20;
  const policy = { staleMs: 10_000, waitMs: 40, retryMs: 5, osLock: NO_LIBC };

  // One writer that releases and re-acquires between every attempt (same pid, a new ts): HOLDS
  // refusals x retryMs is far past waitMs, and the contender still takes the lock afterwards.
  let attempts = 0;
  writeFileSync(path, marker(OTHER_PID, 1_000));
  const churning = (): PidLiveness => {
    attempts += 1;
    if (attempts > HOLDS) return "dead";
    writeFileSync(path, marker(OTHER_PID, 1_000 + attempts));
    return "alive";
  };
  const t0 = Date.now();
  const held = withRequiredFileLockSync(
    path,
    { ...policy, liveness: churning },
    (lock) => lock.held,
  );
  expect({ held, attempts, outlastedWait: Date.now() - t0 >= policy.waitMs }).toEqual({
    held: true,
    attempts: HOLDS + 1,
    outlastedWait: true,
  });
  expect(existsSync(path)).toBe(false); // released on the way out

  // The same refusals under a marker that never changes: a LockBusyError naming that pid at about
  // waitMs, well short of the churning row's attempts, and the holder's marker untouched.
  attempts = 0;
  writeFileSync(path, marker(OTHER_PID, 1_000));
  const silent = (): PidLiveness => {
    attempts += 1;
    return "alive";
  };
  let ran = false;
  expect(() =>
    withRequiredFileLockSync(path, { ...policy, liveness: silent }, () => {
      ran = true;
    }),
  ).toThrow(`pid ${OTHER_PID}`);
  expect({ ran, gaveUp: attempts <= HOLDS, leftover: readFileSync(path, "utf-8") }).toEqual({
    ran: false,
    gaveUp: true,
    leftover: marker(OTHER_PID, 1_000),
  });
});

// The lock's own I/O can fail (its directory cannot be made, the create is refused): the lock's
// own failure, so it rides the bounded wait like a refused marker write and then surfaces as
// itself, never as a holder nobody can stop.
test("a lock whose own I/O fails is retried through the wait, then rethrown as itself (required) or not-held (best-effort)", () => {
  dir = tempDir("copilot-env-file-lock-");
  // A regular file where the lock's directory must be: every mkdir of it fails, on every platform.
  const blocker = join(dir, "not-a-dir");
  writeFileSync(blocker, "");
  const path = join(blocker, "x.lock");
  let attempts = 0;
  const counting = (): PidLiveness => {
    attempts += 1;
    return "alive";
  };
  const policy = { staleMs: 10_000, waitMs: 20, retryMs: 5, liveness: counting };
  let ran = false;
  expect(() =>
    withRequiredFileLockSync(path, policy, () => {
      ran = true;
    }),
  ).toThrow(/ENOTDIR|EEXIST|ENOENT/);
  expect(ran).toBe(false);
  expect(attempts).toBe(0); // no marker was there to judge: the failure is the lock's own
  expect(withFileLockSync(path, policy, (o) => o)).toEqual({
    held: false,
    reason: "unavailable",
    cause: expect.any(Error),
  });
  expect(existsSync(path)).toBe(false);
});
