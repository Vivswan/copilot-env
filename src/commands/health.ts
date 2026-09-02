// `agent health`: diagnose the local proxy and setup. Default `--scope full`
// runs the whole environment diagnosis (the default daemon plus every named
// profile's); `--scope runtime` is the fast proxy-readiness probe the
// launchers/scripts rely on -- its exit code is byte-compatible with the
// original health command (it skips the shell/CLI probes, though the
// tracked-pid check still spawns `ps`/PowerShell as before). `--profile <name>`
// narrows the run to that profile's runtime/credential/wiring checks (the
// account-wide checks drop out). `--json` emits a structured report instead of
// the formatted text one. Exit 1 iff any check fails; warnings alone exit 0.
import { assertKnownProfile, type ProfileMode } from "../copilot_api/env_state.ts";
import { parseProfileFlag, type Profile } from "../copilot_api/profile.ts";
import { buildHealthJson, exitCodeFor, isHealthScope } from "../health/aggregate.ts";
import { evaluateAll } from "../health/checks.ts";
import { gatherFacts, type HealthFacts } from "../health/probe.ts";
import { renderReport } from "../health/report.ts";
import { HEALTH_SCOPES } from "../health/types.ts";

export interface HealthArgs {
  scope: string;
  json: boolean;
  live?: boolean;
  /** `--profile <name>`: narrow the diagnosis to that named profile. */
  profile?: string;
}

/** Each named runtime target's recorded mode, for the report's section headers. */
function profileModes(facts: HealthFacts): Map<string, ProfileMode | null> {
  const modes = new Map<string, ProfileMode | null>();
  for (const target of facts.runtimes ?? []) {
    if (target.profile !== null) modes.set(target.profile, target.slot.mode);
  }
  return modes;
}

export async function runHealth(args: HealthArgs): Promise<void> {
  if (!isHealthScope(args.scope)) {
    throw new Error(`--scope must be one of: ${HEALTH_SCOPES.join(", ")}`);
  }
  const scope = args.scope;
  // Validate the narrowing BEFORE anything is probed: a typo'd --profile must
  // error naming the known profiles, never diagnose default (or half-default)
  // wiring under the wrong name.
  const profile: Profile = parseProfileFlag(args.profile);
  if (profile !== null) assertKnownProfile(profile);
  const facts = await gatherFacts(scope, { live: Boolean(args.live), profile });
  const results = evaluateAll(scope, facts);

  if (args.json) {
    console.log(JSON.stringify(buildHealthJson(scope, results, profile), null, 2));
  } else {
    renderReport(scope, results, profileModes(facts));
  }
  // Set, don't exit, so stderr/stdout flush (matches the rest of the CLI).
  process.exitCode = exitCodeFor(results);
}
