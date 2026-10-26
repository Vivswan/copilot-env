// Shared types for `agent health`, plus the two helpers every check family spells its identity
// and named-profile fix with. Dependency-free (the only import is the profile vocabulary) so the
// pure aggregation/evaluation layers import only from here.
import type { ProfileName } from "../copilot_api/profile.ts";

export type CheckStatus = "ok" | "warn" | "fail";

/** The surfaces `agent health` targets; declaration order is the help and text-report order. */
export const HEALTH_SCOPES = [
  "full",
  "runtime",
  "proxy",
  "setup",
  "auth",
  "codex",
  "claude",
] as const;

export type HealthScope = (typeof HEALTH_SCOPES)[number];

// SINGLE SOURCE for scope membership, shared by the fact-gatherer (probe.ts gates which facts to
// collect) and the check descriptors below (which stamp CheckResult.scopes), so the two cannot
// drift. Every set includes "full".

/** The daemon rows; `runtime` is the fast probe, whose row set and exit code are a contract. */
export const RUNTIME_SCOPES: readonly HealthScope[] = ["full", "proxy", "runtime"];

/** The version, dependency, and proxy-package rows; the identity probe fires only in these. */
export const BOOTSTRAP_SCOPES: readonly HealthScope[] = ["full", "proxy"];

/** The account-wide setup rows: shell, launchers, the CLI census, the host farm, autoupdate. */
export const SETUP_SCOPES: readonly HealthScope[] = ["full", "setup"];

/** The GitHub credential backs both agents' Direct: a section of its own, not a per-agent one. */
export const AUTH_SCOPES: readonly HealthScope[] = ["full", "auth", "setup"];

/** An agent's wiring row renders under `setup` too, so that scope shows both agents at once. */
export const CODEX_SCOPES: readonly HealthScope[] = ["full", "setup", "codex"];

/** As CODEX_SCOPES, for Claude's wiring row. */
export const CLAUDE_SCOPES: readonly HealthScope[] = ["full", "setup", "claude"];

/** `--live` end-to-end prompts run only in the agent-focused scopes (never setup). */
export const CODEX_LIVE_SCOPES: readonly HealthScope[] = ["full", "codex"];

/** As CODEX_LIVE_SCOPES, for Claude: a live prompt never runs under `setup`. */
export const CLAUDE_LIVE_SCOPES: readonly HealthScope[] = ["full", "claude"];

/** Section a check renders under (fixed render order lives in report.ts). */
export type CheckGroup = "bootstrap" | "proxy" | "runtime" | "setup" | "auth" | "codex" | "claude";

/** One row of CHECK_DESCRIPTORS. The ids and labels are external contracts, so never rename them:
 *  `--json` consumers key on the ids, and the labels are the report's row headers.
 *
 *   setup.auth          -> checkAuth: one credential line per target (the default, a named profile)
 *   setup.cli.<command> -> the one id minted outside this table; the CLI list is runtime data */
interface CheckDescriptor {
  readonly label: string;
  readonly group: CheckGroup;
  readonly scopes: readonly HealthScope[];
}

/** Every registered check by id; CheckDescriptor says why nothing here may be renamed. */
const CHECK_DESCRIPTORS = {
  "bootstrap.version": {
    label: "copilot-env version",
    group: "bootstrap",
    scopes: BOOTSTRAP_SCOPES,
  },
  "bootstrap.runtime": { label: "Runtime", group: "bootstrap", scopes: BOOTSTRAP_SCOPES },
  "bootstrap.nodeModules": {
    label: "Dependencies (node_modules)",
    group: "bootstrap",
    scopes: BOOTSTRAP_SCOPES,
  },
  "proxy.package": { label: "Proxy package", group: "proxy", scopes: BOOTSTRAP_SCOPES },
  "proxy.resolved": {
    label: "Proxy resolved + installed",
    group: "proxy",
    scopes: BOOTSTRAP_SCOPES,
  },
  "runtime.port": { label: "Proxy port reachable", group: "runtime", scopes: RUNTIME_SCOPES },
  "runtime.pid": { label: "Tracked proxy process", group: "runtime", scopes: RUNTIME_SCOPES },
  // Informational rows: full-scope only (paths), or full+proxy; never the fast `runtime` probe
  // scope, whose row set and exit code are a contract.
  "runtime.paths": { label: "Paths", group: "runtime", scopes: ["full"] },
  "runtime.watchdog": { label: "Idle watchdog", group: "runtime", scopes: ["full", "proxy"] },
  "runtime.identity": { label: "Proxy identity", group: "runtime", scopes: ["full", "proxy"] },
  "runtime.orphan": { label: "Proxy port ownership", group: "runtime", scopes: ["full", "proxy"] },
  "profile.consistency": {
    label: "Profile consistency",
    group: "runtime",
    scopes: RUNTIME_SCOPES,
  },
  "setup.shell": { label: "Shell integration", group: "setup", scopes: SETUP_SCOPES },
  "setup.launchers": { label: "Launchers (cl/co/cx)", group: "setup", scopes: SETUP_SCOPES },
  "setup.auth": { label: "Authentication", group: "auth", scopes: AUTH_SCOPES },
  "setup.codex": { label: "Codex wiring", group: "codex", scopes: CODEX_SCOPES },
  "setup.codex-host": { label: "Per-host CODEX_HOME", group: "codex", scopes: SETUP_SCOPES },
  "setup.claude": { label: "Claude wiring", group: "claude", scopes: CLAUDE_SCOPES },
  "setup.claude-desktop": {
    label: "Claude Desktop wiring",
    group: "claude",
    scopes: CLAUDE_SCOPES,
  },
  "setup.autoupdate": { label: "Autoupdate", group: "setup", scopes: SETUP_SCOPES },
  // The live rows keep the full agent scope set; their FACTS are gathered only under --live in
  // the *_LIVE_SCOPES, which is what gates them.
  "codex.live": { label: "Codex live prompt", group: "codex", scopes: CODEX_SCOPES },
  "claude.live": { label: "Claude live prompt", group: "claude", scopes: CLAUDE_SCOPES },
} as const satisfies Record<string, CheckDescriptor>;

type RegisteredCheckId = keyof typeof CHECK_DESCRIPTORS;

/** The strings are external contracts (`--json` consumers key on them). */
export type CheckId = RegisteredCheckId | `setup.cli.${string}`;

/** `fix?: never` keeps the property readable as undefined without narrowing, so neither the
 *  renderer nor the --json builder needs a fix-presence guard. */
export type CheckOutcome =
  | { status: "ok"; detail: string; fix?: never }
  | { status: "warn" | "fail"; detail: string; fix: string };

/** `scopes` always includes "full"; `profile` names the runtime target (null = the default
 *  target; environment-wide checks are always null); `value` carries structured data for `--json`. */
export type CheckResult = {
  id: CheckId;
  label: string;
  group: CheckGroup;
  profile: ProfileName | null;
  scopes: readonly HealthScope[];
  value?: Record<string, unknown>;
} & CheckOutcome;

export interface HealthJson {
  /** The scope the run was asked for (`--scope`), as HEALTH_SCOPES spells it. */
  scope: HealthScope;

  /** The profile the run was narrowed to (null = the default/whole environment). */
  profile: string | null;

  /** No check failed; a warn keeps it true. */
  ok: boolean;

  /** The worst status across the checks. */
  status: CheckStatus;

  /** The process exit code the run ends with: 1 on any `fail`. */
  exitCode: 0 | 1;

  /** The scope-filtered checks, each minus its `scopes`: a filter input, not report data. */
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

export function meta(id: RegisteredCheckId): {
  id: RegisteredCheckId;
  label: string;
  group: CheckGroup;
  scopes: readonly HealthScope[];
} {
  const d = CHECK_DESCRIPTORS[id];
  return { id, label: d.label, group: d.group, scopes: d.scopes };
}

/** The re-wire fix for a NAMED profile (mode is sticky from the store on a re-add). */
export function profileAddFix(name: ProfileName): string {
  return `agent profile ${name} add`;
}
