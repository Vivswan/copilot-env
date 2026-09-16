// The shared `agent codex` / `agent claude` skeleton behind AgentAdapter. This module imports
// NEITHER src/codex/ nor src/claude/: each agent file builds its own adapter and calls
// runAgentConfig, so the dependency edge points one way (agent file -> here) and cannot cycle.
import { CopilotApiConfig } from "../copilot_api/config.ts";
import { Credential } from "../copilot_api/credential.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import type { Profile, ProfileName } from "../copilot_api/profile.ts";
import { errMessage } from "../utils/error.ts";
import { createStderrLogger } from "../utils/logger.ts";
import { resolveDirectMode } from "./direct_detect.ts";
import type { ManagedAgentMode, RequestedMode } from "./provider_mode.ts";

const logger = createStderrLogger();

/** The two Direct facts a wiring bakes, resolved ONCE above the writers (probeDirectWiring in
 *  src/codex/config.ts) and handed down, so no writer probes. */
export interface DirectWiring {
  /** The probed `Copilot-Integration-Id` to bake, or null to send none. */
  directIntegrationId: string | null;
  /** The Copilot host to bake as the base URL (selectDirectIdentityAndHost). */
  directBaseUrl: string;
}

/**
 * The mode-dependent half of one managed wiring write, shared by every adapter and the Claude
 * Desktop wiring. Both Direct facts are optional in the type (absent = no header, the generic
 * host, today's bytes), so a scratch or replayed write needs no probe.
 *
 *   the default slot -> runAgentConfig resolves them
 *   a named profile  -> wireBothAgents resolves them
 *   mode "proxy"     -> carries neither field at all, so the pairing is unrepresentable
 */
export type ManagedMode =
  | ({ mode: "direct" } & Partial<DirectWiring>)
  | { mode: "proxy"; directIntegrationId?: never; directBaseUrl?: never };

/**
 * How one agent obtains the credential at request time (the `static-key` scope names the agents
 * that bake it).
 *
 *   command -> the config names a copilot-env command that prints the credential (the default)
 *   static  -> the value itself is written into the config; the agent spawns nothing of ours
 */
export type CredentialWiring = { kind: "command" } | { kind: "static"; token: string };

/** `credential` is required, never defaulted: resolveCredentialWiring is its ONE constructor, so a
 *  writer can never fall back to the command shape when the preference asked for the value. */
export type ManagedWrite = ManagedMode & { credential: CredentialWiring };

/**
 * The one place the `static-key` preference is read for a write, per agent. Proxy bakes the
 * daemon's own API key (minted here if absent, like wiringPortFor reserving the port); direct
 * bakes the GitHub credential, `directToken` when the caller already resolved it. A value that
 * cannot be resolved throws: an unresolvable static credential is a failed write, never a silent
 * command fallback.
 */
export function resolveCredentialWiring(
  agent: ManagedAgentId,
  mode: ManagedAgentMode,
  profile: Profile,
  directToken?: string | null,
): CredentialWiring {
  const config = new CopilotEnvConfig();
  if (!config.staticKeyFor(agent)) return { kind: "command" };
  if (mode === "proxy") {
    return { kind: "static", token: CopilotApiConfig.forProfile(profile).ensureApiKey() };
  }
  const resolved = typeof directToken === "string"
    ? { token: directToken, reason: null }
    : new Credential(undefined, profile).resolveWithReason();
  if (resolved.token === null) {
    const slot = profile === null ? "" : ` --profile ${profile}`;
    throw new Error(
      `static-key is ${config.staticKeyScope()} but no credential resolves to bake: ` +
        `${resolved.reason}. Run \`agent auth${slot}\`, or \`agent config --set static-key none\` ` +
        "to go back to the resolver command.",
    );
  }
  return { kind: "static", token: resolved.token };
}

/** The GitHub token a static DIRECT wiring already resolved, so the identity probe and Desktop's
 *  discovery reuse it instead of resolving (for gh-cli, spawning) again. Undefined for the command
 *  shape AND for proxy: a proxy static write holds the daemon's API key, which is no GitHub
 *  credential and must never be sent upstream as one. */
export function resolvedDirectToken(
  mode: ManagedAgentMode,
  credential: CredentialWiring,
): string | undefined {
  return mode === "direct" && credential.kind === "static" ? credential.token : undefined;
}

/** Contradictory flag pairs (`--check --direct`, `--mobile --check`) are rejected at the
 *  parse below, so no arm carries another arm's knobs and dispatch order never decides. */
export type AgentConfigAction =
  | { kind: "check" }
  | { kind: "mobile" }
  | { kind: "configure"; mode: RequestedMode };

/** The `agent codex` arms (the Codex-only `--mobile` flag lives here). */
export type CodexCliAction = Extract<
  AgentConfigAction,
  { kind: "check" | "mobile" | "configure" }
>;

/** The `agent claude` arms (no `--mobile`; that flag is Codex's). */
export type ClaudeCliAction = Extract<AgentConfigAction, { kind: "check" | "configure" }>;

/** `mobile` is dispatched to its own handler at the CLI boundary and never reaches
 *  runAgentConfig. */
export type AgentRunAction = Extract<AgentConfigAction, { kind: "check" | "configure" }>;

/** Cross-cutting knobs of one run (never part of the parsed CLI action). */
export interface AgentRunOptions {
  /** Pre-resolved Direct credential: skips the store resolve. The settings-bundle
   *  import passes its plan's already-resolved token so the gh-cli provider is
   *  shelled out to once per import, not once per writer. */
  ghToken?: string | null;
}

function assertCheckStandsAlone(mode: RequestedMode): void {
  if (mode !== "auto") {
    throw new Error(
      "--check only reports the configured provider; it does not combine with --direct/--proxy",
    );
  }
}

/** `mode` arrives already parsed (parseModeFlags), so the `--direct --proxy` conflict is
 *  rejected before any combination here is considered. */
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

export function parseClaudeAction(flags: {
  check?: boolean;
  mode: RequestedMode;
}): ClaudeCliAction {
  if (flags.check) {
    assertCheckStandsAlone(flags.mode);
    return { kind: "check" };
  }
  return { kind: "configure", mode: flags.mode };
}

/** Knobs of a named-profile write (`agent profile`); the mode and direct identity travel in
 *  the ManagedWrite beside it. */
export interface AgentProfileWriteOptions {
  quiet: boolean;
}

/** DefaultAgentRequest is indexed by this union (configure_defaults.ts), so a new agent is a
 *  compile error there until the request names it. bothAgents' list is an AgentAdapter[], where
 *  a missing adapter still compiles. */
export type ManagedAgentId = "codex" | "claude";

export interface RemoveProfileOptions {
  keepDesktopEntry?: boolean;
  /** The Claude files to remove, resolved up front by the caller's plan
   *  (claudeProfileArtifacts); absent = resolve now. */
  claudeArtifacts?: readonly string[];
}

/**
 * One CLI agent's wiring surface; the config.toml / settings.json mechanics stay in src/codex/
 * and src/claude/. Default and named-profile writes are separate methods because only the
 * default flow hands the adapter a resolved credential.
 *
 *   configureDefault -> gets runAgentConfig's credential (Codex seeds its catalog with it)
 *   configureProfile -> gets none; Claude Desktop's discovery resolves that slot itself
 */
export interface AgentAdapter {
  readonly id: ManagedAgentId;
  /** The capitalized user-facing label ("Codex"/"Claude") for narration and errors. */
  readonly label: string;
  /** Prints the configured provider and sets the exit code (providerModeExitCode). Per-agent
   *  because the printed fields are (CODEX_HOME + config.toml vs settings.json + apiKeyHelper). */
  check(): void;
  /** Live Direct probe behind "auto": can the stored credential use Direct from this machine?
   *  The scratch config bakes `direct` (identity and host) so the smoke call sends the same request
   *  the real wiring would; without it a PAT that needs `copilot-developer-cli` fails the probe.
   *  `ghToken` (the credential runAgentConfig already resolved) feeds the Copilot smoke
   *  (src/copilot_api/endpoint_smoke.ts) that picks the probe's model and, with no CLI on the
   *  machine, pings the wire itself; null (nothing stored) is the proxy verdict. */
  detectDirect(direct: DirectWiring, ghToken: string | null): Promise<boolean>;
  /** The DEFAULT credential's Direct client identity (config pin, else probe) and host
   *  (`copilot-host` literal, else probe). On the adapter because this module must not import the
   *  per-agent probe machinery. */
  resolveDirectWiring(ghToken: string | null): Promise<DirectWiring>;
  /** `ghToken` is the credential runAgentConfig already resolved (null = none stored). Only
   *  Claude Desktop's model discovery resolves again, and only from null (src/claude/desktop.ts). */
  configureDefault(write: ManagedWrite, ghToken: string | null): Promise<void>;
  /** Never probes: the identity arrives inside `write`. Async when the adapter also refreshes
   *  a derived surface (Claude's Desktop config library). */
  configureProfile(
    name: ProfileName,
    write: ManagedWrite,
    options: AgentProfileWriteOptions,
  ): void | Promise<void>;
  /** `keepDesktopEntry` leaves the Claude Desktop entry and helper scripts to a caller whose
   *  own plan removes them (uninstall). */
  removeProfile(name: ProfileName, options?: RemoveProfileOptions): void;
}

/** Every "Configuring X for <backend> ..." line goes through here so the backend phrasing
 *  cannot drift between the default flows and `agent profile`. */
export function configuringLine(subject: string, mode: ManagedAgentMode, suffix = ""): string {
  return `  Configuring ${subject} for ${
    mode === "direct" ? "GitHub Copilot Direct" : "the local copilot-api proxy"
  }${suffix} ...`;
}

/**
 * The credential, the direct identity, and the Copilot host are each resolved ONCE here and handed
 * down, so the probe, the write, and every derived surface bake the same values without re-probing.
 *
 *   explicit flag > live probe of the stored credential    (resolveDirectMode)
 *
 * The identity and host come BEFORE the probe: a credential rejected under every known identity
 * cannot use Direct, which under "auto" is the proxy verdict, not a failure.
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
  const chosen = await resolveDefaultMode(adapter, action.mode, ghToken);
  logger.log(configuringLine(adapter.label, chosen.mode));
  const credential = resolveCredentialWiring(adapter.id, chosen.mode, null, ghToken);
  const write: ManagedWrite = chosen.mode === "direct"
    ? { ...chosen, credential }
    : { mode: "proxy", credential };
  await adapter.configureDefault(write, ghToken);
}

async function resolveDefaultMode(
  adapter: AgentAdapter,
  mode: RequestedMode,
  ghToken: string | null,
): Promise<ManagedMode> {
  if (mode === "proxy") return { mode };
  let direct: DirectWiring;
  try {
    direct = await adapter.resolveDirectWiring(ghToken);
  } catch (e) {
    if (mode === "direct") throw e;
    logger.log(
      `  Copilot Direct rejects this credential → using the local proxy\n${errMessage(e)}`,
    );
    return { mode: "proxy" };
  }
  return (await resolveDirectMode(mode, () => adapter.detectDirect(direct, ghToken)))
    ? { mode: "direct", ...direct }
    : { mode: "proxy" };
}
