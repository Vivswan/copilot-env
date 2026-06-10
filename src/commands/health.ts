// `agent health`: diagnose the local gateway and setup. Default `--scope full`
// runs the whole environment diagnosis; `--scope runtime` is the fast
// gateway-readiness probe the launchers/scripts rely on — its exit code is
// byte-compatible with the original health command (it skips the shell/CLI
// probes, though the tracked-pid check still spawns `ps`/PowerShell as before).
// `--json` emits a structured report instead of the formatted text one. Exit 1
// iff any check fails; warnings alone exit 0.
import { buildHealthJson, exitCodeFor, isHealthScope } from "../health/aggregate.ts";
import { evaluateAll } from "../health/checks.ts";
import { gatherFacts } from "../health/probe.ts";
import { renderReport } from "../health/report.ts";
import { HEALTH_SCOPES } from "../health/types.ts";

export interface HealthArgs {
  scope: string;
  json: boolean;
  live?: boolean;
}

export async function runHealth(args: HealthArgs): Promise<void> {
  if (!isHealthScope(args.scope)) {
    throw new Error(`--scope must be one of: ${HEALTH_SCOPES.join(", ")}`);
  }
  const scope = args.scope;
  const facts = await gatherFacts(scope, { live: Boolean(args.live) });
  const results = evaluateAll(scope, facts);

  if (args.json) {
    console.log(JSON.stringify(buildHealthJson(scope, results), null, 2));
  } else {
    renderReport(scope, results);
  }
  // Set, don't exit, so stderr/stdout flush (matches the rest of the CLI).
  process.exitCode = exitCodeFor(results);
}
