import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { probeFileLock, releaseFileLock, tryAcquireFileLock } from "../../src/utils/file_lock.ts";
import type { OsLock } from "../../src/utils/os_lock.ts";
import { until } from "../helpers/daemon.ts";
import {
  bunRunArgs,
  CHILD_VALUES,
  childValuesEnv,
  importSpecifier,
  ROOT,
  spawnChild,
} from "../helpers/run.ts";
import { expect, tempDir, test } from "../helpers/testing.ts";

// One lock, two processes of this binary, on each layer of src/utils/file_lock.ts. The layer is the
// machine's (the marker layer only where the libc will not load), so both processes are on the same
// one: exactly one holder at a time, and the lock passes to the contender once the holder dies.
// The multi-writer exclusion is config_lock.e2e.test.ts; the daemon's hold daemon_lock.e2e.test.ts.

/** The machine without a libc, for this process. */
const NO_LIBC: OsLock = {
  tryExclusive: () => ({ kind: "unsupported", cause: new Error("dlopen failed") }),
  tryShared: () => ({ kind: "unsupported", cause: new Error("dlopen failed") }),
  release: () => {},
};

/** A child holding `lock` for life on the OS layer or, with `noLibc`, on the marker layer through
 *  the same injected failure to load the libc. */
function holder(
  dir: string,
  lock: string,
  noLibc: boolean,
): { child: Bun.Subprocess<"ignore", "ignore", "inherit">; ready: string } {
  const ready = join(dir, "ready");
  const script = join(dir, "holder.ts");
  writeFileSync(
    script,
    `import { writeFileSync } from "node:fs";\n` +
      `import { tryAcquireFileLock } from ${importSpecifier(
        join(ROOT, "src", "utils", "file_lock.ts"),
      )};\n` +
      "const failed = { kind: 'unsupported', cause: new Error('dlopen failed') };\n" +
      "const noLibc = { tryExclusive: () => failed, tryShared: () => failed, release: () => {} };\n" +
      `const values = ${CHILD_VALUES};\n` +
      "const opts = values.noLibc ? { osLock: noLibc } : {};\n" +
      "if (!tryAcquireFileLock(values.lock, Number.POSITIVE_INFINITY, opts)) process.exit(1);\n" +
      'writeFileSync(values.ready, "held");\n' +
      "setInterval(() => {}, 60_000);\n",
  );
  const child = spawnChild(process.execPath, {
    args: [...bunRunArgs(), script],
    env: childValuesEnv({ lock, ready, noLibc }),
    stdout: "ignore",
    stderr: "inherit",
  });
  return { child, ready };
}

const LAYER_ROWS: { label: string; noLibc: boolean }[] = [
  { label: "the OS layer", noLibc: false },
  { label: "the marker layer (no libc on this machine)", noLibc: true },
];
for (const { label, noLibc } of LAYER_ROWS) {
  test(`a lock held by another process is refused, then taken once that process dies: ${label}`, async () => {
    const dir = tempDir("copilot-env-file-lock-e2e-");
    const lock = join(dir, "x.lock");
    const opts = noLibc ? { osLock: NO_LIBC } : {};
    const { child, ready } = holder(dir, lock, noLibc);
    try {
      await until(() => existsSync(ready));
      const heldMarker = readFileSync(lock, "utf-8");
      expect(heldMarker.startsWith(`${child.pid}\n`)).toBe(true);
      // Refused, the holder's marker untouched, and the probe names the holder by its layer.
      expect({
        acquired: tryAcquireFileLock(lock, Number.POSITIVE_INFINITY, opts),
        marker: readFileSync(lock, "utf-8"),
        probe: probeFileLock(lock, opts),
      }).toEqual({
        acquired: false,
        marker: heldMarker,
        probe: { kind: "held", markerPid: child.pid, judge: noLibc ? "pid" : "os-lock" },
      });
      child.kill("SIGKILL");
      await child.exited;
      // The holder is gone (its OS lock dropped, or its pid dead): the next attempt takes it.
      await until(() => tryAcquireFileLock(lock, Number.POSITIVE_INFINITY, opts));
      expect(readFileSync(lock, "utf-8").startsWith(`${process.pid}\n`)).toBe(true);
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      releaseFileLock(lock);
    }
  }, 30_000);
}
