// Shared types for `agent health` diagnostics. Kept dependency-free (the only
// import is the profile vocabulary, itself dependency-free) so the pure
// aggregation/evaluation layers (aggregate.ts, checks.ts) import only from here.
import type { ProfileName } from "../copilot_api/profile.ts";

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
// the check descriptors below (which stamp CheckResult.scopes) -- the two must
// stay in lockstep, so the sets live here rather than as two hand-synced copies.
// Every set includes "full".
export const RUNTIME_SCOPES: readonly HealthScope[] = ["full", "proxy", "runtime"];
// The default run's NAMED-profile runtime sweep joins only the diagnostic scopes
// (full, proxy) -- never the launchers' fast `runtime` probe, whose row set and
// exit code are a contract of the DEFAULT daemon alone (a stopped profile daemon
// must not fail a launcher's readiness gate). A `--profile` narrowing addresses
// its target in every runtime-bearing scope regardless.
export const PROFILE_SWEEP_SCOPES: readonly HealthScope[] = ["full", "proxy"];
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

/** The identity fields every result of one registered check carries. */
interface CheckDescriptor {
  readonly label: string;
  readonly group: CheckGroup;
  readonly scopes: readonly HealthScope[];
}

/**
 * THE check registry: one descriptor per registered check id, the single source
 * of each check's label/group/scopes (checkAuth and checkProfileAuth share the
 * `setup.auth` row by design -- one credential line per target). The id strings
 * and labels are external contracts (`--json` consumers key on them; the labels
 * are the report's row headers): never rename them. The per-CLI family
 * (`setup.cli.<command>`) is the one id minted outside this table -- the CLI
 * list is runtime data (probe deps), so it cannot be enumerated here.
 */
export const CHECK_DESCRIPTORS = {
  "bootstrap.version": {
    label: "copilot-env version",
    group: "bootstrap",
    scopes: BOOTSTRAP_SCOPES,
  },
  "bootstrap.deno": { label: "Deno runtime", group: "bootstrap", scopes: BOOTSTRAP_SCOPES },
  "bootstrap.nodeModules": {
    label: "Dependencies (node_modules)",
    group: "bootstrap",
    scopes: BOOTSTRAP_SCOPES,
  },
  "proxy.package": { label: "Proxy package", group: "proxy", scopes: BOOTSTRAP_SCOPES },
  "proxy.sidecar": { label: "Deno sidecar", group: "proxy", scopes: BOOTSTRAP_SCOPES },
  "proxy.resolved": { label: "Proxy resolved + cached", group: "proxy", scopes: BOOTSTRAP_SCOPES },
  "runtime.port": { label: "Proxy port reachable", group: "runtime", scopes: RUNTIME_SCOPES },
  "runtime.pid": { label: "Tracked proxy process", group: "runtime", scopes: RUNTIME_SCOPES },
  // Informational rows: full-scope only (paths), or full+proxy -- never the
  // launchers' fast `runtime` probe, whose row set and exit code are a contract.
  "runtime.paths": { label: "Paths", group: "runtime", scopes: ["full"] },
  "runtime.watchdog": { label: "Idle watchdog", group: "runtime", scopes: ["full", "proxy"] },
  "runtime.identity": { label: "Proxy identity", group: "runtime", scopes: ["full", "proxy"] },
  "runtime.orphan": { label: "Proxy port ownership", group: "runtime", scopes: ["full", "proxy"] },
  "profile.consistency": {
    label: "Profile consistency",
    group: "runtime",
    scopes: RUNTIME_SCOPES,
  },
  // Diagnostic-only (full + proxy), like the informational runtime rows: the
  // launchers' fast `runtime` probe's row set is a contract of the default
  // daemon's liveness alone.
  "runtime.defaultHomeMigration": {
    label: "Default home migration",
    group: "runtime",
    scopes: ["full", "proxy"],
  },
  "setup.shell": { label: "Shell integration", group: "setup", scopes: SETUP_SCOPES },
  "setup.launchers": { label: "Launchers (cl/co/cx)", group: "setup", scopes: SETUP_SCOPES },
  "setup.tool.node": { label: "node", group: "setup", scopes: SETUP_SCOPES },
  "setup.tool.npm": { label: "npm", group: "setup", scopes: SETUP_SCOPES },
  "setup.auth": { label: "Authentication", group: "auth", scopes: AUTH_SCOPES },
  "setup.codex": { label: "Codex wiring", group: "codex", scopes: CODEX_SCOPES },
  "setup.codex-host": { label: "Per-host CODEX_HOME", group: "codex", scopes: SETUP_SCOPES },
  "setup.claude": { label: "Claude wiring", group: "claude", scopes: CLAUDE_SCOPES },
  "setup.autoupdate": { label: "Autoupdate", group: "setup", scopes: SETUP_SCOPES },
  // The live rows keep the full agent scope set (their FACTS are gathered only
  // under --live in the *_LIVE_SCOPES, which is what actually gates them).
  "codex.live": { label: "Codex live prompt", group: "codex", scopes: CODEX_SCOPES },
  "claude.live": { label: "Claude live prompt", group: "claude", scopes: CLAUDE_SCOPES },
} as const satisfies Record<string, CheckDescriptor>;

/** A check id registered in the descriptor table. */
export type RegisteredCheckId = keyof typeof CHECK_DESCRIPTORS;

/** Every check id: the registered table plus the per-CLI family. The strings
 *  are external contracts (`--json` consumers key on them). */
export type CheckId = RegisteredCheckId | `setup.cli.${string}`;

/** The verdict half of a check result: a fix hint is REQUIRED on warn/fail and
 *  unrepresentable on ok (`fix?: never` keeps the property readable as
 *  undefined without narrowing), so neither the renderer nor the --json builder
 *  needs a fix-presence guard. */
export type CheckOutcome =
  | { status: "ok"; detail: string; fix?: never }
  | { status: "warn" | "fail"; detail: string; fix: string };

/**
 * One diagnostic result. `id` is a stable machine-readable key (e.g.
 * "runtime.port"); `scopes` lists every scope the check participates in (every
 * check includes "full"). `profile` names the runtime target a check describes
 * (null = the default target; environment-wide checks are always null).
 * `value` carries structured data for `--json`.
 */
export type CheckResult = {
  id: CheckId;
  label: string;
  group: CheckGroup;
  profile: ProfileName | null;
  scopes: readonly HealthScope[];
  value?: Record<string, unknown>;
} & CheckOutcome;

/** Shape emitted by `agent health --json`. */
export interface HealthJson {
  scope: HealthScope;
  /** The profile the run was narrowed to (null = the default/whole environment). */
  profile: string | null;
  ok: boolean; // no `fail` present
  status: CheckStatus; // worst status across checks
  exitCode: 0 | 1;
  checks: {
    id: string;
    label: string;
    group: CheckGroup;
    profile: ProfileName | null;
    status: CheckStatus;
    detail: string;
    fix?: string;
    value?: Record<string, unknown>;
  }[];
}
