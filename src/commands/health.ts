// The launchers and shell scripts call `--scope runtime` and branch on its exit code, so that code
// is a contract (src/health/aggregate.ts, exitCodeFor).
import { assertKnownProfile, type ProfileMode } from "../copilot_api/env_state.ts";
import { parseProfileFlag, type Profile } from "../copilot_api/profile.ts";
import { buildHealthJson, exitCodeFor, isHealthScope } from "../health/aggregate.ts";
import { evaluateAll } from "../health/checks.ts";
import type { HealthFacts } from "../health/facts.ts";
import { gatherFacts } from "../health/probe.ts";
import { renderReport } from "../health/report.ts";
import { HEALTH_SCOPES } from "../health/types.ts";

export interface HealthArgs {
  scope: string;
  json: boolean;
  live?: boolean;
  profile?: string;
}

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
  // Before anything is probed: a typo'd --profile must error naming the known profiles, never
  // diagnose the default wiring under the wrong name.
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
