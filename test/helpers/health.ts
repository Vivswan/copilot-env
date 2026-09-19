// The per-daemon runtime checks take the target AND its probe; these run one on a target whose
// daemon was interrogated, so a fixture that skipped the probe fails loudly instead of rendering.
import {
  checkRuntimeIdentity,
  checkRuntimeOrphan,
  checkRuntimePid,
  checkRuntimePort,
} from "../../src/health/checks.ts";
import type { DaemonProbed, RuntimeTarget } from "../../src/health/facts.ts";
import type { CheckResult } from "../../src/health/types.ts";

export function probeOf(t: RuntimeTarget | undefined): DaemonProbed {
  if (!t || t.probe.kind !== "probed") throw new Error("expected a probed runtime target");
  return t.probe;
}

export const runPort = (t: RuntimeTarget): CheckResult => checkRuntimePort(t, probeOf(t));
export const runPid = (t: RuntimeTarget): CheckResult => checkRuntimePid(t, probeOf(t));
export const runIdentity = (t: RuntimeTarget): CheckResult => checkRuntimeIdentity(t, probeOf(t));
export const runOrphan = (t: RuntimeTarget): CheckResult => checkRuntimeOrphan(t, probeOf(t));
