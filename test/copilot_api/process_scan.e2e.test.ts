import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getOrphanPids } from "../../src/copilot_api/process.ts";
import { envSnapshot, pathLedBy } from "../helpers/env.ts";
import { afterEach, expect, step, tempDir, test } from "../helpers/testing.ts";

// Nothing in the runtime bounds a child, so a `ps` that never returns would hang the command that
// scans for orphans. The scan must settle on its own and read "unproven" (the verdict
// listUntrackedOrphans turns into a skipped sweep), never "no daemons".

afterEach(envSnapshot(["PATH"]));

// The shim ignores TERM and execs the sleeper under its own pid, so only a KILL ends it and the
// stdout pipe closes with it.
const HANGING_SHIM = "#!/bin/sh\ntrap '' TERM\nexec sleep 20\n";

test.skipIf(process.platform === "win32")(
  "getOrphanPids: a ps that never exits reads as unproven at the bound, never as no daemons",
  async () => {
    const bin = tempDir("copilot-env-hanging-ps-");
    writeFileSync(join(bin, "ps"), HANGING_SHIM, { mode: 0o755 });
    process.env.PATH = pathLedBy(bin);
    step("scan with the hanging ps on PATH");
    const started = performance.now();
    const scan = await getOrphanPids(process.pid, process.ppid);
    const elapsed = performance.now() - started;
    // Control: a ps that is missing fails in milliseconds; only the bound ending a live child
    // takes seconds.
    expect({ scan, waited: elapsed > 1000 }).toEqual({ scan: "unproven", waited: true });
  },
);
