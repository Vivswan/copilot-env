// terminatePid re-proves daemon identity through the injected classify seam at the SIGKILL
// boundary, never on the proof the caller held at SIGTERM time. Each arm asserts the
// TerminateVerdict alongside the signals sent.
//   "no"      -> KILL refused, "refused-reused-pid", the reuse reported
//   "yes"     -> KILL sent, "killed"
//   "unknown" -> KILL sent, "killed": every caller gates its TERM on an identity read at
//                least as demanding, so a transient scan failure must not strand a stop
// The TERM-survivor arms need a trappable SIGTERM, which Windows lacks (process.kill is
// TerminateProcess there), so they are POSIX-only.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { consola } from "consola";
import { pidAlive, terminatePid, type TerminateVerdict } from "../src/copilot_api/process.ts";
import { killAndAwaitExit, until, withUnprovablePidProbe } from "./helpers.ts";
import { CHILD_VALUES, childValuesEnv, denoRunArgs, spawnChild } from "./helpers/run.ts";
import { afterEach, expect, removeDir, tempDir, test } from "./helpers/testing.ts";

let dir = "";

afterEach(() => {
  dir = removeDir(dir);
});

/** Spawn a child that ignores SIGTERM (so only a SIGKILL can end it) and signals
 *  readiness through a file; returns once the child is provably up. */
async function spawnTermIgnoringChild(): Promise<Deno.ChildProcess> {
  dir = tempDir("copilot-terminate-");
  const ready = join(dir, "ready");
  const script = join(dir, "survivor.ts");
  writeFileSync(
    script,
    'Deno.addSignalListener("SIGTERM", () => {});\n' +
      `Deno.writeTextFileSync(${CHILD_VALUES}.ready, "up");\n` +
      "setInterval(() => {}, 60_000);\n",
  );
  const child = spawnChild(Deno.execPath(), {
    args: [...denoRunArgs(), script],
    env: childValuesEnv({ ready }),
    stdout: "null",
    stderr: "inherit",
  });
  expect(await until(10_000, () => existsSync(ready))).toBe(true);
  return child;
}

/** A classify seam that records its calls and always answers `verdict`. */
function classifyStub(verdict: "yes" | "no" | "unknown"): {
  calls: number[];
  classify: (pid: number) => Promise<"yes" | "no" | "unknown">;
} {
  const calls: number[] = [];
  return {
    calls,
    classify: (pid: number) => {
      calls.push(pid);
      return Promise.resolve(verdict);
    },
  };
}

/** Run `body` with stdout/stderr captured (consola's warn goes through one of them). */
async function withCapturedOutput(body: () => Promise<void>): Promise<string> {
  const written: string[] = [];
  const savedLevel = consola.level;
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (s: string | Uint8Array) => {
    written.push(String(s));
    return true;
  };
  process.stderr.write = (s: string | Uint8Array) => {
    written.push(String(s));
    return true;
  };
  try {
    consola.level = 3; // ensure warn is not self-silenced under the test runner
    await body();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    consola.level = savedLevel;
  }
  return written.join("");
}

// The TERM'd daemon died inside the grace and the OS reassigned the pid: a KILL on the
// stale TERM-time proof would hit the impostor.
test.skipIf(process.platform === "win32")(
  "a pid classifying 'no' at the KILL boundary is spared, and the reuse is reported",
  async () => {
    const child = await spawnTermIgnoringChild();
    try {
      const { calls, classify } = classifyStub("no");
      let verdict: TerminateVerdict | undefined;
      const output = await withCapturedOutput(async () => {
        verdict = await terminatePid(child.pid, 300, classify);
      });
      // The refusal lands in the verdict AND the log, so the caller learns the daemon is
      // gone instead of guessing from a live foreign pid.
      expect(verdict).toBe("refused-reused-pid");
      expect(calls).toEqual([child.pid]);
      expect(pidAlive(child.pid)).toBe(true);
      expect(output).toContain(`Not escalating pid ${child.pid} to SIGKILL`);
    } finally {
      await killAndAwaitExit(child.pid);
    }
  },
  30_000,
);

// The child ignores SIGTERM, so its death is attributable only to the SIGKILL.
test.skipIf(process.platform === "win32")(
  "a pid still classifying 'yes' draws the SIGKILL escalation",
  async () => {
    const child = await spawnTermIgnoringChild();
    try {
      const { calls, classify } = classifyStub("yes");
      expect(await terminatePid(child.pid, 300, classify)).toBe("killed");
      expect(calls).toEqual([child.pid]);
      expect(await until(5_000, () => !pidAlive(child.pid))).toBe(true);
    } finally {
      await killAndAwaitExit(child.pid);
    }
  },
  30_000,
);

// A scan that cannot answer must not strand the stop: every caller gates its TERM on an
// identity read at least as demanding as this kill gate. Contrast corroborateLockHolder in
// launch.ts, which fails closed because no recent identity read backs the pid there.
test.skipIf(process.platform === "win32")(
  "a failed identity scan ('unknown') at the KILL boundary still escalates",
  async () => {
    const child = await spawnTermIgnoringChild();
    try {
      const { calls, classify } = classifyStub("unknown");
      // Same verdict as "yes": the kill-on-unknown carries no behavioral difference,
      // so it earns no separate arm.
      expect(await terminatePid(child.pid, 300, classify)).toBe("killed");
      expect(calls).toEqual([child.pid]);
      expect(await until(5_000, () => !pidAlive(child.pid))).toBe(true);
    } finally {
      await killAndAwaitExit(child.pid);
    }
  },
  30_000,
);

// Liveness is checked before identity, so the classify seam is a KILL-boundary check only
// and never runs on the happy path.
test(
  "a pid that died within the grace consults no identity scan",
  async () => {
    dir = tempDir("copilot-terminate-");
    const ready = join(dir, "ready");
    const script = join(dir, "compliant.ts");
    // No SIGTERM listener: the child dies on the SIGTERM itself (TerminateProcess on
    // Windows), well inside the grace.
    writeFileSync(
      script,
      `Deno.writeTextFileSync(${CHILD_VALUES}.ready, "up");\n` +
        "setInterval(() => {}, 60_000);\n",
    );
    const child = spawnChild(Deno.execPath(), {
      args: [...denoRunArgs(), script],
      env: childValuesEnv({ ready }),
      stdout: "null",
      stderr: "inherit",
    });
    try {
      expect(await until(10_000, () => existsSync(ready))).toBe(true);
      // Observe the exit eagerly so the child is reaped as soon as the SIGTERM lands --
      // a lingering zombie would still read pidAlive at the boundary.
      const exited = child.status;
      const { calls, classify } = classifyStub("no");
      expect(await terminatePid(child.pid, 3_000, classify)).toBe("died-in-grace");
      await exited;
      expect(calls).toEqual([]);
      expect(pidAlive(child.pid)).toBe(false);
    } finally {
      await killAndAwaitExit(child.pid);
    }
  },
  30_000,
);

// graceMs 0 is the no-escalation mode; "term-only" means signalled, nothing verified, never a
// death that was not observed. The child traps nothing, so Windows runs this too.
test(
  "graceMs 0 sends the TERM only, consults no identity, and answers 'term-only'",
  async () => {
    dir = tempDir("copilot-terminate-");
    const ready = join(dir, "ready");
    const script = join(dir, "compliant.ts");
    writeFileSync(
      script,
      `Deno.writeTextFileSync(${CHILD_VALUES}.ready, "up");\n` +
        "setInterval(() => {}, 60_000);\n",
    );
    const child = spawnChild(Deno.execPath(), {
      args: [...denoRunArgs(), script],
      env: childValuesEnv({ ready }),
      stdout: "null",
      stderr: "inherit",
    });
    try {
      expect(await until(10_000, () => existsSync(ready))).toBe(true);
      const exited = child.status;
      const { calls, classify } = classifyStub("no");
      expect(await terminatePid(child.pid, 0, classify)).toBe("term-only");
      await exited; // the SIGTERM alone ends the compliant child: the signal was sent
      expect(calls).toEqual([]);
    } finally {
      await killAndAwaitExit(child.pid);
    }
  },
  30_000,
);

// Under the daemon's own permission set the liveness probe throws NotCapable (pinned in
// test/pid.test.ts) and every pid reads "unproven". That must never mint "died-in-grace",
// which stopTrackedProxy reads as a confirmed death and clears tracking on; the classify
// boundary rules instead, as it does for a proven-alive pid.
test(
  "an unprovable liveness read at the KILL boundary never mints 'died-in-grace'",
  async () => {
    dir = tempDir("copilot-terminate-");
    const ready = join(dir, "ready");
    const script = join(dir, "compliant.ts");
    // No SIGTERM listener needed: with the probe (and every signal send) unprovable,
    // nothing can reach the child at all -- its survival proves exactly that.
    writeFileSync(
      script,
      `Deno.writeTextFileSync(${CHILD_VALUES}.ready, "up");\n` +
        "setInterval(() => {}, 60_000);\n",
    );
    const child = spawnChild(Deno.execPath(), {
      args: [...denoRunArgs(), script],
      env: childValuesEnv({ ready }),
      stdout: "null",
      stderr: "inherit",
    });
    try {
      expect(await until(10_000, () => existsSync(ready))).toBe(true);
      const { calls, classify } = classifyStub("yes");
      let verdict: TerminateVerdict | undefined;
      await withUnprovablePidProbe(async () => {
        verdict = await terminatePid(child.pid, 200, classify);
      });
      // A died-in-grace return would have skipped the classify call entirely.
      expect(verdict).toBe("killed");
      expect(calls).toEqual([child.pid]);
      expect(pidAlive(child.pid)).toBe(true);
    } finally {
      await killAndAwaitExit(child.pid);
    }
  },
  30_000,
);
