// The `runtime` scope is the fast probe: each addressed target's readiness rows alone (every
// profile's daemon under `agent health`, one daemon under `agent profile [<name>] health`), whose
// exit code is a contract for scripts that branch on it (src/health/aggregate.ts, exitCodeFor).
import { allProfileNames, knownProfile, type ProfileMode } from "../copilot_api/env_state.ts";
import type { Profile } from "../copilot_api/profile.ts";
import { buildHealthJson, exitCodeFor, isHealthScope } from "../health/aggregate.ts";
import { evaluateAll } from "../health/checks.ts";
import type { HealthFacts } from "../health/facts.ts";
import { gatherFacts } from "../health/probe.ts";
import { renderReport } from "../health/report.ts";
import { HEALTH_SCOPES, type HealthScope } from "../health/types.ts";
import type { CheckResult } from "../health/types.ts";

interface HealthArgs {
  scope: string;
  json: boolean;
  live?: boolean;
  profile?: string;
}

function profileModes(
  facts: HealthFacts,
  modes = new Map<string, ProfileMode | null>(),
): Map<string, ProfileMode | null> {
  for (const target of facts.runtimes ?? []) {
    if (target.profile !== null) modes.set(target.profile, target.slot.mode);
  }
  return modes;
}

function parseScope(scope: string): HealthScope {
  if (!isHealthScope(scope)) {
    throw new Error(`--scope must be one of: ${HEALTH_SCOPES.join(", ")}`);
  }
  return scope;
}

/** The report and the exit code, from the results of one or more gathers. `profile` is the
 *  narrowed run's for the JSON header; the every-profile run is the whole environment's (null). */
function report(
  scope: HealthScope,
  results: CheckResult[],
  modes: ReadonlyMap<string, ProfileMode | null>,
  json: boolean,
  profile: Profile,
): void {
  if (json) {
    console.log(JSON.stringify(buildHealthJson(scope, results, profile), null, 2));
  } else {
    renderReport(scope, results, modes);
  }
  // Set, don't exit, so stderr/stdout flush (matches the rest of the CLI).
  process.exitCode = exitCodeFor(results);
}

/** One profile's checks (`agent profile [<name>] health`): the default's run is the whole
 *  environment's account-wide checks and its own daemon (never a named profile's, whose stop
 *  is that profile's business); a named profile's run is its daemon, consistency, credential
 *  slot, and per-agent wiring alone. */
export async function runHealth(args: HealthArgs): Promise<void> {
  const scope = parseScope(args.scope);
  // Before anything is probed: a typo'd name must error naming the known profiles, never
  // diagnose the default wiring under the wrong name.
  const profile: Profile = knownProfile(args.profile);
  const facts = await gatherFacts(scope, { live: Boolean(args.live), profile });
  report(scope, evaluateAll(scope, facts), profileModes(facts), args.json, profile);
}

/** Every profile's checks (`agent health`): the default's run and each named profile's narrowed
 *  run, gathered at once (each probe has its own timeout budget, so ten profiles cost one, not
 *  ten) and folded in profile order, the default first. The rows keep the report's order: every
 *  named profile's runtime block follows the default's, ahead of the default's remaining rows;
 *  each profile's other rows (its credential, its wiring) come after them. */
export async function runHealthEverywhere(args: Omit<HealthArgs, "profile">): Promise<void> {
  const scope = parseScope(args.scope);
  const live = Boolean(args.live);
  const [facts, ...named] = await Promise.all([
    gatherFacts(scope, { live }),
    ...allProfileNames().map((name) => gatherFacts(scope, { live, profile: name })),
  ]);
  const results = evaluateAll(scope, facts);
  const modes = profileModes(facts);
  const runtimeRows: CheckResult[] = [];
  const otherRows: CheckResult[] = [];
  for (const gathered of named) {
    profileModes(gathered, modes);
    for (const result of evaluateAll(scope, gathered)) {
      (result.group === "runtime" ? runtimeRows : otherRows).push(result);
    }
  }
  results.splice(results.findLastIndex((r) => r.group === "runtime") + 1, 0, ...runtimeRows);
  results.push(...otherRows);
  report(scope, results, modes, args.json, null);
}
