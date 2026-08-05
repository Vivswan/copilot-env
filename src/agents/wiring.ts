// The single place both agents' effective wiring is read together. Every
// "are the agents direct?" consumer -- the proxy float, health's runtime
// checks, migrations, `agent init`'s read-back -- goes through this module, so
// the answer can never drift between them. The two predicates below answer two
// DIFFERENT questions; pick by question, not by name.
import {
  DIRECT_BASE_URL as CLAUDE_DIRECT_BASE_URL,
  type ClaudeWiringStatus,
  inspectClaudeWiring,
} from "../claude/config.ts";
import { resolveClaudeHome, settingsPathFor } from "../claude/paths.ts";
import { type CodexWiringStatus, effectiveCodexHome, inspectCodexWiring } from "../codex/config.ts";
import { codexConfigPath } from "../codex/paths.ts";
import { profileHomeNames } from "../copilot_api/paths.ts";
import { copilotApiResolvePort } from "../copilot_api/port.ts";
import { readTextOrNull } from "../utils/fs.ts";
import type { AgentProviderMode } from "./provider_mode.ts";

/**
 * Overrides for tests and callers that already resolved the homes/port. The
 * defaults are the effective ones every caller shares: Codex = the run-state
 * `codexHome` override (set by `agent codex --host`) else `$CODEX_HOME` else
 * `~/.codex`; Claude = `$CLAUDE_CONFIG_DIR` else `~/.claude`; port = the
 * resolved default daemon port.
 */
export interface AgentWiringOptions {
  codexHome?: string;
  claudeHome?: string;
  expectedPort?: number;
}

/** Both DEFAULT selections' full wiring statuses, read from the effective homes. */
function readAgentWirings(opts: AgentWiringOptions): {
  codex: CodexWiringStatus;
  claude: ClaudeWiringStatus;
} {
  const expectedPort = opts.expectedPort ?? Number(copilotApiResolvePort());
  const codexHome = opts.codexHome ?? effectiveCodexHome();
  const codex = inspectCodexWiring(
    readTextOrNull(codexConfigPath(codexHome)),
    null,
    expectedPort,
    false,
  );
  const claudeHome = opts.claudeHome ?? resolveClaudeHome();
  const claude = inspectClaudeWiring(
    readTextOrNull(settingsPathFor(claudeHome)),
    claudeHome,
    expectedPort,
  );
  return { codex, claude };
}

/**
 * The effective provider mode of both agents' DEFAULT selections (named
 * profiles have their own settings artifacts and are not read here). A missing
 * or unreadable config file reads as "none"; a malformed one as the inspect
 * functions classify it. Store-level failures (run state, port resolution)
 * propagate -- wrap the call when a fallback is wanted.
 */
export function readAgentModes(opts: AgentWiringOptions = {}): {
  codex: AgentProviderMode;
  claude: AgentProviderMode;
} {
  const { codex, claude } = readAgentWirings(opts);
  return { codex: codex.providerMode, claude: claude.providerMode };
}

/**
 * Does the DEFAULT selection route anything to a local proxy? True unless both
 * agents are wired Direct. This is health's question: when it is false, a down
 * daemon on the default port is not a failure. Named profiles are deliberately
 * ignored -- a proxy profile runs its own daemon in its own isolated home,
 * which never makes the DEFAULT setup need one. For "is the proxy package
 * unused by everything" (the float's question) use proxyUnusedEverywhere.
 */
export function defaultSetupNeedsProxy(opts: AgentWiringOptions = {}): boolean {
  const modes = readAgentModes(opts);
  return !(modes.codex === "direct" && modes.claude === "direct");
}

/**
 * Is the local proxy package unused by EVERYTHING -- the default selection AND
 * every named profile -- so floating it against npm would be wasted
 * network/install work? Stricter than the inverse of defaultSetupNeedsProxy:
 * any profile home counts as proxy use (profile homes are created only by
 * proxy wiring or `agent start --profile`), and Claude must also carry the
 * managed Direct base URL so a mixed config (direct helper + proxy
 * ANTHROPIC_BASE_URL) still floats. Best-effort: any read/parse failure counts
 * as "maybe used" so uncertain wiring floats normally.
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
