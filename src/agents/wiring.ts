// The single place both agents' effective wiring is read together; every "are the agents
// direct?" consumer goes through here so the answer cannot drift. The two predicates at the
// bottom answer two DIFFERENT questions: pick by question, not by name.
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

/** Overrides for tests and callers that already resolved the homes/port; the defaults are the
 *  effective ones (effectiveCodexHome, resolveClaudeHome, copilotApiResolvePort). */
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
  const claude = inspectClaudeWiring(readTextResult(settingsPathFor(claudeHome)), expectedPort);
  return { codex, claude };
}

/** DEFAULT selections only; named profiles have their own artifacts. Store-level failures (run
 *  state, port resolution) propagate: never-throw callers use readAgentModesSafe.
 *    missing config file  -> "none"
 *    unreadable           -> "other" (present, not ours to touch)
 *    malformed            -> as the inspect functions classify it */
export function readAgentModes(opts: AgentWiringOptions = {}): {
  codex: AgentProviderMode;
  claude: AgentProviderMode;
} {
  const { codex, claude } = readAgentWirings(opts);
  return { codex: codex.providerMode, claude: claude.providerMode };
}

/** Every failure collapses to "other" for both agents, so a best-effort caller (a migration,
 *  init's read-back) neither aborts nor mistakes an unreadable setup for an unconfigured one it
 *  may write over. */
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
 * Health's question: when false, a down daemon on that port is not a failure. False only when
 * both agents are Direct AND Claude's base URL does not point at the local proxy: Claude's MODE
 * keys off apiKeyHelper alone, so a direct helper with a proxy ANTHROPIC_BASE_URL reads "direct"
 * while its traffic goes to the daemon. A base URL routed elsewhere does not count, and named
 * profiles are ignored (a proxy profile runs its own daemon in its own home). For "unused by
 * everything" see proxyUnusedEverywhere.
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
 * The float's question: unused by the default selection AND every named profile, so floating
 * against npm would be wasted work. Stricter than the inverse of defaultSetupNeedsProxy: any
 * profile home counts as proxy use (only proxy wiring or `agent start --profile` creates one),
 * and Claude must carry exactly the managed Direct base URL. Any read failure counts as "maybe
 * used", so uncertain wiring floats normally.
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
