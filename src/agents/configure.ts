// The shared `agent codex` / `agent claude` command skeleton. Both commands do
// the same dance -- `--check` short-circuits, then resolve the credential, decide
// direct-vs-proxy, narrate, and hand off to the agent's writer -- so the dance
// lives here ONCE, behind AgentAdapter. Each agent file builds its own adapter
// around its existing writers and calls runAgentConfig; this module deliberately
// imports NEITHER src/codex/ nor src/claude/, so the dependency edge points one
// way (agent file -> here) and can never cycle.
import { Credential } from "../copilot_api/credential.ts";
import type { ProfileName } from "../copilot_api/profile.ts";
import { createStderrLogger } from "../utils/logger.ts";
import { resolveDirectMode } from "./direct_detect.ts";
import type { ManagedAgentMode, RequestedMode } from "./provider_mode.ts";

const logger = createStderrLogger();

/**
 * The mode-dependent half of ONE managed wiring write -- the SHARED request
 * shape every agent adapter (and the Claude Desktop wiring) accepts. Direct
 * alone carries the probed client identity, so a proxy write paired with an
 * integration id is unrepresentable rather than silently ignored. The identity
 * is always resolved ABOVE the writers (runAgentConfig for the default
 * selection, wireBothAgents for a named profile) and passed down, so one
 * resolution serves every surface a write touches (agent config + Claude
 * Desktop) instead of each layer re-probing.
 */
export type ManagedWrite =
  | {
    mode: "direct";
    /** The probed `Copilot-Integration-Id` to bake, or null/absent to send none. */
    directIntegrationId?: string | null;
  }
  | { mode: "proxy"; directIntegrationId?: never };

/**
 * What ONE `agent codex` / `agent claude` invocation does. Each arm carries
 * only its own knobs (`mode` never travels with `check`/`mobile`/`desktop`),
 * so a contradictory combination like `--check --direct` or `--mobile --check`
 * is rejected at the boundary parse below instead of resolved by dispatch
 * order. The per-command unions narrow this to the arms each command declares.
 */
export type AgentConfigAction =
  | { kind: "check" }
  | { kind: "mobile" }
  | { kind: "desktop" }
  | { kind: "configure"; mode: RequestedMode };

/** The `agent codex` arms (no `--desktop`; that flag is Claude's). */
export type CodexCliAction = Exclude<AgentConfigAction, { kind: "desktop" }>;

/** The `agent claude` arms (no `--mobile`; that flag is Codex's). */
export type ClaudeCliAction = Extract<
  AgentConfigAction,
  { kind: "check" | "desktop" | "configure" }
>;

/** The arms the shared skeleton (runAgentConfig) executes itself; `mobile` and
 *  `desktop` are dispatched to their own handlers at the CLI boundary, so they
 *  never reach the run* functions at all. */
export type AgentRunAction = Extract<AgentConfigAction, { kind: "check" | "configure" }>;

/** Cross-cutting knobs of one run (never part of the parsed CLI action). */
export interface AgentRunOptions {
  /** Pre-resolved Direct credential: skips the store resolve. The settings-bundle
   *  import passes its plan's already-resolved token so the gh-cli provider is
   *  shelled out to once per import, not once per writer. */
  ghToken?: string | null;
}

/** The shared `--check` conflict: reporting never combines with a forced mode. */
function assertCheckStandsAlone(mode: RequestedMode): void {
  if (mode !== "auto") {
    throw new Error(
      "--check only reports the configured provider; it does not combine with --direct/--proxy",
    );
  }
}

/** Parse the raw `agent codex` flags into a CodexCliAction (the CLI boundary).
 *  `mode` arrives already parsed (parseModeFlags), so the `--direct --proxy`
 *  conflict is rejected before any combination below is considered. */
export function parseCodexAction(flags: {
  check?: boolean;
  mode: RequestedMode;
  mobile?: boolean;
}): CodexCliAction {
  if (flags.mobile) {
    if (flags.check || flags.mode !== "auto") {
      throw new Error(
        "--mobile is an interactive pairing flow; it does not combine with --check/--direct/--proxy",
      );
    }
    return { kind: "mobile" };
  }
  if (flags.check) {
    assertCheckStandsAlone(flags.mode);
    return { kind: "check" };
  }
  return { kind: "configure", mode: flags.mode };
}

/** Parse the raw `agent claude` flags into a ClaudeCliAction (the CLI boundary). */
export function parseClaudeAction(flags: {
  check?: boolean;
  mode: RequestedMode;
  desktop?: boolean;
}): ClaudeCliAction {
  if (flags.desktop) {
    if (flags.check || flags.mode !== "auto") {
      throw new Error("--desktop cannot be combined with --check/--direct/--proxy.");
    }
    return { kind: "desktop" };
  }
  if (flags.check) {
    assertCheckStandsAlone(flags.mode);
    return { kind: "check" };
  }
  return { kind: "configure", mode: flags.mode };
}

/** The per-agent knobs of a NAMED-profile write (`agent profile`); the write's
 *  mode + direct identity travel in the shared ManagedWrite beside it. */
export interface AgentProfileWriteOptions {
  quiet: boolean;
}

/** The managed agents, as adapter/request keys. Every cross-agent map (the
 *  default-selection request, bothAgents' list) is keyed on this union, so
 *  adding an agent is a compile error everywhere one could be silently missed. */
export type ManagedAgentId = "codex" | "claude";

/**
 * One CLI agent's wiring surface, as runAgentConfig and `agent profile` consume
 * it. Adapters WRAP the existing per-agent writers (config.toml / settings.json
 * mechanics stay in src/codex/ and src/claude/); this interface only carries the
 * shared command shape.
 *
 * Default-selection and named-profile writes are separate methods on purpose:
 * the default flow hands the adapter the already-resolved credential (Codex
 * seeds its catalog with it), while a profile write must never resolve one.
 * Both receive the SAME ManagedWrite -- the direct client identity is resolved
 * once by the caller (runAgentConfig via resolveDirectIdentity for the default,
 * wireBothAgents via the persisted-slot cache for a profile) and passed down.
 */
export interface AgentAdapter {
  /** The stable agent key (request maps and adapter lists are keyed on it). */
  readonly id: ManagedAgentId;
  /** The capitalized user-facing label ("Codex"/"Claude") for narration and errors. */
  readonly label: string;
  /** The `--check` report: print the configured provider and set the exit code
   *  (providerModeExitCode). The printed fields are per-agent (CODEX_HOME +
   *  config.toml vs settings.json + apiKeyHelper), so the whole report is. */
  check(): void;
  /** Live Direct auto-detect probe (the "auto" fallback when no credential is stored). */
  detectDirect(): boolean;
  /** Resolve the DEFAULT credential's direct client identity (config pin, else
   *  probe). Lives on the adapter because this module must not import the
   *  per-agent probe machinery (the dependency edge points agent file -> here). */
  resolveDirectIdentity(ghToken: string | null): Promise<string | null>;
  /** Default-selection write. `ghToken` is the credential runAgentConfig already
   *  resolved (null = none stored), so the adapter never resolves it a second
   *  time; the write's direct identity arrives inside `write`. */
  configureDefault(write: ManagedWrite, ghToken: string | null): Promise<void>;
  /** Named-profile write (wraps the existing writer; never probes -- the identity
   *  arrives inside `write`). Async when the adapter also refreshes a derived
   *  surface (Claude's Desktop config library). */
  configureProfile(
    name: ProfileName,
    write: ManagedWrite,
    options: AgentProfileWriteOptions,
  ): void | Promise<void>;
  /** Remove a named profile's managed artifacts from the agent's effective home. */
  removeProfile(name: ProfileName): void;
}

/**
 * The one user-facing "Configuring X for Y ..." sentence, single-sourced: the
 * default-selection flows say `Configuring Codex/Claude for <backend> ...` and
 * `agent profile` says `Configuring profile "x" for <backend> (both agents) ...`
 * -- same sentence, different subject and suffix. Every site MUST emit it
 * through here so the backend phrasing can never drift between them.
 */
export function configuringLine(subject: string, mode: ManagedAgentMode, suffix = ""): string {
  return `  Configuring ${subject} for ${
    mode === "direct" ? "GitHub Copilot Direct" : "the local copilot-api proxy"
  }${suffix} ...`;
}

/**
 * The shared body of `agent codex` / `agent claude`: a `check` action reports and
 * returns; a `configure` action resolves the stored credential ONCE (provider-aware:
 * gh-cli -> gh, copilot/gh-token -> stored token, none -> null, so a
 * recorded-but-broken provider correctly falls through to the probe), decides the
 * mode (explicit flag > stored credential selects Direct > live probe), narrates,
 * resolves the direct client identity ONCE, and hands the adapter one ManagedWrite
 * (so the write and every derived surface bake the same identity without
 * re-probing, and the adapter reuses the resolved credential too).
 */
export async function runAgentConfig(
  adapter: AgentAdapter,
  action: AgentRunAction,
  opts: AgentRunOptions = {},
): Promise<void> {
  if (action.kind === "check") {
    adapter.check();
    return;
  }
  const ghToken = opts.ghToken !== undefined ? opts.ghToken : new Credential().resolve();
  const direct = resolveDirectMode(action.mode, ghToken, () => adapter.detectDirect());
  const mode: ManagedAgentMode = direct ? "direct" : "proxy";
  logger.log(configuringLine(adapter.label, mode));
  const write: ManagedWrite = mode === "direct"
    ? { mode, directIntegrationId: await adapter.resolveDirectIdentity(ghToken) }
    : { mode };
  await adapter.configureDefault(write, ghToken);
}
