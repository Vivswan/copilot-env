// Loaded with `--preload` into the fake model endpoint's aimock child (test/fake_model_endpoint.ts)
// so the child can never outlive the test process that spawned it: a run interrupted mid-suite
// (Ctrl-C, a SIGKILL, a crash) once left aimock serving on its port for hours with no parent.
//
// Two watches, the first exact and the second the fallback for a spawner whose stdin is not a
// pipe (an immediate EOF on `stdin: "null"` exits at once, before the listening line, which the
// start reports as an early exit):
//   stdin EOF   the spawner holds the pipe's only write end, and the kernel closes it however that
//               process dies, so the EOF lands the instant the parent is gone, on every OS
//   parent pid  polled: reparented on unix (Deno.ppid moves to the reaper) or gone by the signal-0
//               probe, which is the Windows path, where a dead parent's pid is all there is to read
//
// Both are armed on the `load` event, which deno dispatches once the main module has evaluated,
// never at preload time: deno drains the event loop between a preload and the main module, so a
// read pending here would hold aimock's start until the EOF.
import { pidLiveness } from "../../src/utils/pid.ts";

const PARENT_POLL_MS = 1_000;
const parent = Deno.ppid;

async function exitOnStdinEof(): Promise<never> {
  for await (const _chunk of Deno.stdin.readable) {
    // nothing is ever written; only the EOF matters
  }
  Deno.exit(0);
}

function exitOnParentGone(): void {
  if (Deno.ppid !== parent || pidLiveness(parent) === "dead") Deno.exit(0);
}

globalThis.addEventListener("load", () => {
  exitOnStdinEof();
  // The poll never keeps aimock's process alive on its own; the server does that.
  Deno.unrefTimer(setInterval(exitOnParentGone, PARENT_POLL_MS));
});
