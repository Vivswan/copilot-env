// Pure aggregation over CheckResult[] -- the primary unit-test surface. No I/O.
import {
  type CheckResult,
  type CheckStatus,
  HEALTH_SCOPES,
  type HealthJson,
  type HealthScope,
} from "./types.ts";

/** Narrow an arbitrary string to a HealthScope (for `--scope` validation). */
export function isHealthScope(s: string): s is HealthScope {
  return (HEALTH_SCOPES as readonly string[]).includes(s);
}

/** Keep only checks that participate in `scope`, preserving input order. */
export function filterByScope(results: CheckResult[], scope: HealthScope): CheckResult[] {
  return results.filter((r) => r.scopes.includes(scope));
}

const RANK: Record<CheckStatus, number> = { ok: 0, warn: 1, fail: 2 };

/** Worst status across `results` by precedence fail > warn > ok ("ok" if empty). */
export function worstStatus(results: CheckResult[]): CheckStatus {
  let worst: CheckStatus = "ok";
  for (const r of results) {
    if (RANK[r.status] > RANK[worst]) worst = r.status;
  }
  return worst;
}

/** Exit code policy: 1 iff any check failed; warnings alone exit 0. */
export function exitCodeFor(results: CheckResult[]): 0 | 1 {
  return results.some((r) => r.status === "fail") ? 1 : 0;
}

/** Build the `--json` payload from the (already scope-filtered) results. */
export function buildHealthJson(scope: HealthScope, results: CheckResult[]): HealthJson {
  const status = worstStatus(results);
  const exitCode = exitCodeFor(results);
  return {
    scope,
    ok: exitCode === 0,
    status,
    exitCode,
    checks: results.map((r) => ({
      id: r.id,
      label: r.label,
      group: r.group,
      status: r.status,
      detail: r.detail,
      ...(r.fix ? { fix: r.fix } : {}),
      ...(r.value ? { value: r.value } : {}),
    })),
  };
}
