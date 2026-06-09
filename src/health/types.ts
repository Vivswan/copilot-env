// Shared types for `agent health` diagnostics. Kept dependency-free so the pure
// aggregation/evaluation layers (aggregate.ts, checks.ts) import only from here.

/** Worst-to-best diagnostic outcome for a single check. */
export type CheckStatus = "ok" | "warn" | "fail";

/** Which diagnostic surface a `agent health` run targets. */
export type HealthScope = "full" | "runtime" | "gateway" | "setup" | "codex";

/** Declaration order doubles as the help/text-report ordering for scopes. */
export const HEALTH_SCOPES = ["full", "runtime", "gateway", "setup", "codex"] as const;

/** Section a check renders under (fixed render order lives in report.ts). */
export type CheckGroup = "bootstrap" | "gateway" | "runtime" | "setup" | "codex";

/**
 * One diagnostic result. `id` is a stable machine-readable key (e.g.
 * "runtime.port"); `scopes` lists every scope the check participates in (every
 * check includes "full"). `value` carries structured data for `--json`.
 */
export interface CheckResult {
  id: string;
  label: string;
  group: CheckGroup;
  scopes: readonly HealthScope[];
  status: CheckStatus;
  detail: string;
  fix?: string;
  value?: Record<string, unknown>;
}

/** Shape emitted by `agent health --json`. */
export interface HealthJson {
  scope: HealthScope;
  ok: boolean; // no `fail` present
  status: CheckStatus; // worst status across checks
  exitCode: 0 | 1;
  checks: {
    id: string;
    label: string;
    group: CheckGroup;
    status: CheckStatus;
    detail: string;
    fix?: string;
    value?: Record<string, unknown>;
  }[];
}
