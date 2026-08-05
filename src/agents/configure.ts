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
import type { DirectProbeDeps } from "./live_probe.ts";
import type { ManagedAgentMode, RequestedMode } from "./provider_mode.ts";

const logger = createStderrLogger();

/** The `agent codex` / `agent claude` argument shape (shared; each agent file
 *  re-exports its own alias so cli.ts keeps its per-command names). */
export interface AgentConfigArgs {
  check?: boolean;
  /** `--direct`/`--proxy`, parsed once at the CLI boundary (auto = neither). */
  mode: RequestedMode;
}

/** The per-agent knobs of a NAMED-profile write (`agent profile`): the caller
 *  resolves the direct client identity ONCE and both agents bake the same value. */
export interface AgentProfileWriteOptions {
  quiet: boolean;
  /** Direct mode: the probed `Copilot-Integration-Id` to bake, or null to send none. */
  directIntegrationId?: string | null;
}

/**
 * One CLI agent's wiring surface, as runAgentConfig and `agent profile` consume
 * it. Adapters WRAP the existing per-agent writers (config.toml / settings.json
 * mechanics stay in src/codex/ and src/claude/); this interface only carries the
 * shared command shape.
 *
 * Default-selection and named-profile writes are separate methods on purpose:
 * the default flow hands the adapter the already-resolved credential (Codex
 * seeds its catalog with it, Claude reuses it for the identity probe) and probes
 * the client identity itself, while a profile write receives a pre-resolved
 * identity and must never probe. Folding them into one method would just move
 * the branch inside every adapter and force each path to carry the other's
 * ignored inputs.
 */
export interface AgentAdapter {
  /** The capitalized user-facing label ("Codex"/"Claude") for narration and errors. */
  readonly label: string;
  /** The `--check` report: print the configured provider and set the exit code
   *  (providerModeExitCode). The printed fields are per-agent (CODEX_HOME +
   *  config.toml vs settings.json + apiKeyHelper), so the whole report is. */
  check(): void;
  /** Live Direct auto-detect probe (the "auto" fallback when no credential is stored). */
  detectDirect(deps?: DirectProbeDeps): boolean;
  /** Default-selection write for the resolved mode. `ghToken` is the credential
   *  runAgentConfig already resolved (null = none stored), so the adapter never
   *  has to resolve it a second time. */
  configureDefault(mode: ManagedAgentMode, ghToken: string | null): Promise<void>;
  /** Named-profile write (wraps the existing writer; never probes). */
  configureProfile(
    name: ProfileName,
    mode: ManagedAgentMode,
    options: AgentProfileWriteOptions,
  ): void;
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
  return `  Configuring ${subject} for ${mode === "direct" ? "GitHub Copilot Direct" : "the local copilot-api proxy"}${suffix} ...`;
}

/**
 * The shared body of `agent codex` / `agent claude`: `--check` reports and
 * returns; otherwise resolve the stored credential ONCE (provider-aware: gh-cli
 * -> gh, copilot/gh-token -> stored token, none -> null, so a recorded-but-broken
 * provider correctly falls through to the probe), decide the mode (explicit flag
 * > stored credential selects Direct > live probe), narrate, and hand the write
 * to the adapter (which reuses the resolved credential instead of resolving twice).
 */
export async function runAgentConfig(adapter: AgentAdapter, args: AgentConfigArgs): Promise<void> {
  if (args.check) {
    adapter.check();
    return;
  }
  const ghToken = new Credential().resolve();
  const direct = resolveDirectMode(args.mode, ghToken, () => adapter.detectDirect());
  const mode: ManagedAgentMode = direct ? "direct" : "proxy";
  logger.log(configuringLine(adapter.label, mode));
  await adapter.configureDefault(mode, ghToken);
}
