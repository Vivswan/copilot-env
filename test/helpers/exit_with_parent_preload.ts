// Loaded with `--preload` into the fake model endpoint's aimock child (test/helpers/fake_model_endpoint.ts)
// so the child can never outlive the test process that spawned it: a run interrupted mid-suite
// (Ctrl-C, a SIGKILL, a crash) once left aimock serving on its port for hours with no parent.
//
// Two watches, the first exact and the second the fallback for a spawner whose stdin is not a
// pipe (an immediate EOF on an ignored stdin exits at once, before the listening line, which the
// start reports as an early exit):
//   stdin EOF   the spawner holds the pipe's only write end, and the kernel closes it however that
//               process dies, so the EOF lands the instant the parent is gone, on every OS
//   parent pid  polled: reparented on unix (process.ppid moves to the reaper) or gone by the
//               signal-0 probe, which is the Windows path, where a dead parent's pid is all there
//               is to read
//
// Both are armed as this module evaluates: bun runs a preload to completion before the entry, and
// neither watch holds the event loop (the stdin read ends with the pipe; the poll is unref'd), so
// aimock's own start is never waited on.
import { pidLiveness } from "../../src/utils/pid.ts";

const PARENT_POLL_MS = 1_000;
const parent = process.ppid;

async function exitOnStdinEof(): Promise<never> {
  for await (const _chunk of process.stdin) {
    // nothing is ever written; only the EOF matters
  }
  process.exit(0);
}

function exitOnParentGone(): void {
  if (process.ppid !== parent || pidLiveness(parent) === "dead") process.exit(0);
}

exitOnStdinEof();
// The poll never keeps aimock's process alive on its own; the server does that.
setInterval(exitOnParentGone, PARENT_POLL_MS).unref();
