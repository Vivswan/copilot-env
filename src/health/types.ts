// Shared types for `agent health` diagnostics. Kept dependency-free so the pure
// aggregation/evaluation layers (aggregate.ts, checks.ts) import only from here.

/** Worst-to-best diagnostic outcome for a single check. */
export type CheckStatus = "ok" | "warn" | "fail";

/** Which diagnostic surface a `agent health` run targets. */
export type HealthScope = "full" | "runtime" | "proxy" | "setup" | "auth" | "codex" | "claude";

/** Declaration order doubles as the help/text-report ordering for scopes. */
export const HEALTH_SCOPES = [
  "full",
  "runtime",
  "proxy",
  "setup",
  "auth",
  "codex",
  "claude",
] as const;

// Scope membership per check/fact: the scopes each participates in. SINGLE SOURCE
// shared by the fact-gatherer (probe.ts, which gates which facts to collect) and
// the check evaluator (checks.ts, which stamps CheckResult.scopes) -- the two must
// stay in lockstep, so the sets live here rather than as two hand-synced copies.
// Every set includes "full".
export const RUNTIME_SCOPES: readonly HealthScope[] = ["full", "proxy", "runtime"];
export const BOOTSTRAP_SCOPES: readonly HealthScope[] = ["full", "proxy"];
export const SETUP_SCOPES: readonly HealthScope[] = ["full", "setup"];
// The GitHub credential underpins Direct for both agents, but it gets its own
// section rather than crowding the narrow per-agent scopes: full, setup, and its
// own focused `auth` scope.
export const AUTH_SCOPES: readonly HealthScope[] = ["full", "auth", "setup"];
export const CODEX_SCOPES: readonly HealthScope[] = ["full", "setup", "codex"];
export const CLAUDE_SCOPES: readonly HealthScope[] = ["full", "setup", "claude"];
// `--live` end-to-end prompts run only in the agent-focused scopes (never setup).
export const CODEX_LIVE_SCOPES: readonly HealthScope[] = ["full", "codex"];
export const CLAUDE_LIVE_SCOPES: readonly HealthScope[] = ["full", "claude"];

/** Section a check renders under (fixed render order lives in report.ts). */
export type CheckGroup = "bootstrap" | "proxy" | "runtime" | "setup" | "auth" | "codex" | "claude";

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
