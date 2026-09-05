// The single place both agents' effective wiring is read together. Every
// "are the agents direct?" consumer -- the proxy float, health's runtime
// checks, migrations, `agent init`'s read-back -- goes through this module, so
// the answer can never drift between them. The two predicates below answer two
// DIFFERENT questions; pick by question, not by name.
import {
  type ClaudeWiringStatus,
  DIRECT_BASE_URL as CLAUDE_DIRECT_BASE_URL,
  inspectClaudeWiring,
} from "../claude/config.ts";
import { resolveClaudeHome, settingsPathFor } from "../claude/paths.ts";
import { type CodexWiringStatus, inspectCodexWiring } from "../codex/config.ts";
import { effectiveCodexHome } from "../codex/host.ts";
import { codexConfigPath } from "../codex/paths.ts";
import { profileHomeNames } from "../copilot_api/paths.ts";
import { copilotApiResolvePort } from "../copilot_api/port.ts";
import { readTextResult } from "../utils/fs.ts";
import type { AgentProviderMode } from "./provider_mode.ts";

/**
 * Overrides for tests and callers that already resolved the homes/port. The
 * defaults are the effective ones every caller shares: Codex = the run-state
 * `codexHome` override (the `codex-host` farm derivation) else `$CODEX_HOME` else
 * `~/.codex`; Claude = `$CLAUDE_CONFIG_DIR` else `~/.claude`; port = the
 * resolved default daemon port.
 */
export interface AgentWiringOptions {
  codexHome?: string;
  claudeHome?: string;
  expectedPort?: number;
}

/** Both DEFAULT selections' full wiring statuses, read from the effective homes. */
export function readAgentWirings(opts: AgentWiringOptions = {}): {
  codex: CodexWiringStatus;
  claude: ClaudeWiringStatus;
} {
  const expectedPort = opts.expectedPort ?? Number(copilotApiResolvePort());
  const codexHome = opts.codexHome ?? effectiveCodexHome();
  // Both classifiers take the three-way read themselves: an unreadable config
  // classifies as other/read-error (present but not ours to touch), never as
  // "none", which would let a best-effort caller treat it as free to write over.
  const codex = inspectCodexWiring(
    readTextResult(codexConfigPath(codexHome)),
    null,
    expectedPort,
    false,
  );
  const claudeHome = opts.claudeHome ?? resolveClaudeHome();
  const claude = inspectClaudeWiring(
    readTextResult(settingsPathFor(claudeHome)),
    claudeHome,
    expectedPort,
  );
  return { codex, claude };
}

/**
 * The effective provider mode of both agents' DEFAULT selections (named
 * profiles have their own settings artifacts and are not read here). A missing
 * config file reads as "none"; an unreadable one as "other" (present but not
 * ours to touch); a malformed one as the inspect functions classify it.
 * Store-level failures (run state, port resolution) propagate -- callers that
 * must never throw use readAgentModesSafe.
 */
export function readAgentModes(opts: AgentWiringOptions = {}): {
  codex: AgentProviderMode;
  claude: AgentProviderMode;
} {
  const { codex, claude } = readAgentWirings(opts);
  return { codex: codex.providerMode, claude: claude.providerMode };
}

/**
 * readAgentModes with every failure collapsed to "not ours to touch": both
 * agents read as "other", so a best-effort caller (a migration, `agent init`'s
 * result read-back) neither aborts nor mistakes an unreadable setup for an
 * unconfigured one it may write over.
 */
export function readAgentModesSafe(opts: AgentWiringOptions = {}): {
  codex: AgentProviderMode;
  claude: AgentProviderMode;
} {
  try {
    return readAgentModes(opts);
  } catch {
    return { codex: "other", claude: "other" };
  }
}

/**
 * Does the DEFAULT selection route anything to the local proxy on the expected
 * port? This is health's question: when it is false, a down daemon on that port
 * is not a failure. True unless both agents are wired Direct AND Claude's base
 * URL does not point at the local proxy -- Claude's MODE keys off apiKeyHelper
 * alone, so a mixed config (managed direct helper + a proxy ANTHROPIC_BASE_URL)
 * reads "direct" while its traffic genuinely goes to the daemon; the base-URL
 * fact catches that. A base URL routed elsewhere (the managed Direct URL, a
 * foreign gateway, a loopback service on some other port) does NOT count: our
 * daemon is not in that path, so its state can neither fix nor break the agent.
 * Named profiles are deliberately ignored -- a proxy profile runs its own
 * daemon in its own isolated home, which never makes the DEFAULT setup need
 * one. For "is the proxy package unused by everything" (the float's question)
 * use proxyUnusedEverywhere.
 */
export function defaultSetupNeedsProxy(opts: AgentWiringOptions = {}): boolean {
  const { codex, claude } = readAgentWirings(opts);
  return !(
    codex.providerMode === "direct" &&
    claude.providerMode === "direct" &&
    !claude.baseUrlMatches
  );
}

/**
 * Is the local proxy package unused by EVERYTHING -- the default selection AND
 * every named profile -- so floating it against npm would be wasted
 * network/install work? Stricter than the inverse of defaultSetupNeedsProxy on
 * two axes: any profile home counts as proxy use (profile homes are created
 * only by proxy wiring or `agent start --profile`), and Claude must carry
 * exactly the managed Direct base URL -- ANY deviation (a foreign gateway, an
 * absent URL, a local-proxy URL on any port) keeps the float running, where
 * defaultSetupNeedsProxy only counts a base URL aimed at OUR daemon's port.
 * Best-effort: any read/parse failure counts as "maybe used" so uncertain
 * wiring floats normally.
 */
export function proxyUnusedEverywhere(opts: AgentWiringOptions = {}): boolean {
  try {
    if (profileHomeNames().length > 0) return false;
    const { codex, claude } = readAgentWirings(opts);
    return (
      codex.providerMode === "direct" &&
      claude.providerMode === "direct" &&
      claude.baseUrl === CLAUDE_DIRECT_BASE_URL
    );
  } catch {
    return false;
  }
}
