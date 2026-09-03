// terminatePid's SIGKILL boundary (src/copilot_api/process.ts): the escalation re-proves
// daemon identity through the injected classify seam (classifyDaemonPid in production)
// instead of firing on the seconds-old proof the caller held at SIGTERM time. Each
// three-state arm gets one control, and each control asserts the returned
// TerminateVerdict alongside the observable behavior (the whole outcome -- signals sent
// AND the answer callers act on):
//   - "no"      -> the KILL is refused ("refused-reused-pid") and the reuse reported (the
//                  arm that goes red under the historical pidAlive-only escalation),
//   - "yes"     -> the KILL proceeds ("killed"),
//   - "unknown" -> the KILL proceeds ("killed" -- the documented deliberate default:
//                  every caller gates its TERM on an identity read at least as demanding
//                  as the kill gate, and a transient scan failure must not strand a stop).
// The TERM-survivor arms need a trappable SIGTERM, which Windows does not have
// (process.kill maps to TerminateProcess), so they are POSIX-only -- same gating as the
// stopLockHolder escalation controls in test/launch_steps.test.ts.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { consola } from "consola";
import { pidAlive, terminatePid, type TerminateVerdict } from "../src/copilot_api/process.ts";
import { killAndAwaitExit, removeDir, tmpDir, until, withUnprovablePidProbe } from "./helpers.ts";
import { denoRunArgs, spawnChild } from "./helpers/run.ts";
import { afterEach, expect, test } from "./helpers/testing.ts";

let dir = "";

afterEach(() => {
  dir = removeDir(dir);
});

/** Spawn a child that ignores SIGTERM (so only a SIGKILL can end it) and signals
 *  readiness through a file; returns once the child is provably up. */
async function spawnTermIgnoringChild(): Promise<Deno.ChildProcess> {
  dir = tmpDir("copilot-terminate-");
  const ready = join(dir, "ready");
  const script = join(dir, "survivor.ts");
  writeFileSync(
    script,
    'Deno.addSignalListener("SIGTERM", () => {});\n' +
      `Deno.writeTextFileSync(${JSON.stringify(ready)}, "up");\n` +
      "setInterval(() => {}, 60_000);\n",
  );
  const child = spawnChild(Deno.execPath(), {
    args: [...denoRunArgs(), script],
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

// The arm the fix exists for: at the KILL boundary the pid classifies as NOT ours (the
// TERM'd daemon died inside the grace and the OS reassigned the pid), so no SIGKILL is
// sent and the reuse is reported. Under the historical pidAlive-only escalation this
// control goes red: the still-alive impostor would be killed on the stale TERM-time proof.
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
      // The identity was re-proven at the boundary (exactly once), the KILL was refused
      // (the child ignored SIGTERM, so only terminatePid's SIGKILL could have ended it),
      // and the refusal was reported honestly -- in the log AND in the verdict, so the
      // caller learns the daemon is gone instead of guessing from a live foreign pid.
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

// The positive control: a pid still classifying as ours draws the escalation. The child
// ignores SIGTERM, so its death is attributable only to the SIGKILL.
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

// The deliberate "unknown" default, pinned behaviorally: a scan that cannot answer does
// NOT strand the stop. Every terminatePid caller gates its TERM on an identity read at
// least as demanding as this kill gate, so a kill-on-unknown never acts under a weaker
// identity standard than some TERM in the tree already does (contrast with the
// fail-closed reads where no recent identity read backs the pid, e.g.
// corroborateLockHolder's unreadable-scan refusal in launch.ts).
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

// Cross-platform: a pid already dead at the boundary consults no scan and sends no KILL --
// the escalation is gated on liveness first, so the identity seam is a KILL-boundary
// check only, never a side channel on the happy path.
test(
  "a pid that died within the grace consults no identity scan",
  async () => {
    dir = tmpDir("copilot-terminate-");
    const ready = join(dir, "ready");
    const script = join(dir, "compliant.ts");
    // No SIGTERM listener: the child dies on the SIGTERM itself (TerminateProcess on
    // Windows), well inside the grace.
    writeFileSync(
      script,
      `Deno.writeTextFileSync(${JSON.stringify(ready)}, "up");\n` +
        "setInterval(() => {}, 60_000);\n",
    );
    const child = spawnChild(Deno.execPath(), {
      args: [...denoRunArgs(), script],
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

// graceMs 0 is the no-escalation mode: one SIGTERM, no wait, no identity consult. The
// verdict says exactly that ("term-only" -- signalled, nothing verified) rather than
// claiming a death it never observed -- and the compliant child's exit proves the TERM
// was genuinely sent, so a do-nothing "term-only" stub could not pass. Cross-platform:
// no signal is trapped (SIGTERM is TerminateProcess on Windows).
test(
  "graceMs 0 sends the TERM only, consults no identity, and answers 'term-only'",
  async () => {
    dir = tmpDir("copilot-terminate-");
    const ready = join(dir, "ready");
    const script = join(dir, "compliant.ts");
    writeFileSync(
      script,
      `Deno.writeTextFileSync(${JSON.stringify(ready)}, "up");\n` +
        "setInterval(() => {}, 60_000);\n",
    );
    const child = spawnChild(Deno.execPath(), {
      args: [...denoRunArgs(), script],
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

// The unprovable-liveness arm at the grace boundary: under the daemon's own permission
// set the liveness probe throws NotCapable (pinned real in test/pid.test.ts) and every
// pid reads "unproven" -- which must never mint "died-in-grace", the verdict callers
// read as a confirmed death (stopTrackedProxy clears tracking on it). Instead the
// classify boundary rules, exactly as it does for a proven-alive pid. Under the
// historical EPERM-only catch this control goes red: the unprovable probe reads dead,
// the verdict claims "died-in-grace", and the classify seam is never consulted.
test(
  "an unprovable liveness read at the KILL boundary never mints 'died-in-grace'",
  async () => {
    dir = tmpDir("copilot-terminate-");
    const ready = join(dir, "ready");
    const script = join(dir, "compliant.ts");
    // No SIGTERM listener needed: with the probe (and every signal send) unprovable,
    // nothing can reach the child at all -- its survival proves exactly that.
    writeFileSync(
      script,
      `Deno.writeTextFileSync(${JSON.stringify(ready)}, "up");\n` +
        "setInterval(() => {}, 60_000);\n",
    );
    const child = spawnChild(Deno.execPath(), {
      args: [...denoRunArgs(), script],
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
      // The classify boundary ruled ("killed", the same deliberate arm as proven-alive),
      // it was consulted exactly once (a died-in-grace return would have skipped it),
      // and no false death was reported: the child is provably still alive.
      expect(verdict).toBe("killed");
      expect(calls).toEqual([child.pid]);
      expect(pidAlive(child.pid)).toBe(true);
    } finally {
      await killAndAwaitExit(child.pid);
    }
  },
  30_000,
);
