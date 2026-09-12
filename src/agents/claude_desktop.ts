// The whole-library Claude Desktop reconcile behind the `claude-desktop` key, and the
// status `agent claude --check` and health judge. Cross-agent: the default entry's mode
// comes from settings.json (src/agents/wiring.ts), the profiles' from the store.
import {
  claudeDesktopInstalled,
  profileStoreWellFormed,
  removeClaudeDesktopOrphan,
  removeUnlistedClaudeDesktopClaims,
  removeUnmanagedClaudeDesktopWiring,
  syncClaudeDesktopWiring,
} from "../claude/desktop.ts";
import {
  type ClaudeDesktopStatus,
  type DesktopTarget,
  type DesktopTargetResolution,
  inspectClaudeDesktopWiring,
} from "../claude/desktop_status.ts";
import { Credential } from "../copilot_api/credential.ts";
import { configDefaultBoolean, CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { CopilotEnvState } from "../copilot_api/env_state.ts";
import { CopilotApiPaths } from "../copilot_api/paths.ts";
import { profileLabel } from "../copilot_api/profile.ts";
import { errMessage } from "../utils/error.ts";
import { createStderrLogger } from "../utils/logger.ts";
import type { ManagedWrite } from "./configure.ts";
import { resolveAndPersistDirectIdentity } from "./profile_wiring.ts";
import { readAgentWirings } from "./wiring.ts";

const logger = createStderrLogger();

/** Any read failure is `unresolvable`, never an empty target list: an empty list would sweep
 *  every live entry as an orphan. A custom provider is not a failure; it promises no default
 *  entry. */
export function resolveClaudeDesktopTargets(): DesktopTargetResolution {
  const targets: DesktopTarget[] = [];
  try {
    const claude = readAgentWirings().claude;
    if (claude.providerMode === "direct" || claude.providerMode === "proxy") {
      targets.push({ profile: null, mode: claude.providerMode });
    } else if (claude.providerMode === "other" && claude.otherReason !== "custom") {
      return { kind: "unresolvable", reason: `Claude's settings.json ${claude.otherReason}` };
    }
    const storeFile = new CopilotApiPaths().sharedStateFile;
    if (!profileStoreWellFormed(storeFile)) {
      return { kind: "unresolvable", reason: `the profile store ${storeFile} is malformed` };
    }
    const state = new CopilotEnvState();
    for (const name of state.profileNames()) {
      const slot = state.readProfileSlot(name);
      if (slot.kind === "complete") targets.push({ profile: name, mode: slot.mode });
    }
  } catch (e) {
    return { kind: "unresolvable", reason: `the wiring could not be read: ${errMessage(e)}` };
  }
  return { kind: "resolved", targets };
}

/** Never throws: a failed look anywhere is an `unjudged` status, so `agent claude --check`
 *  and health report it and keep their own verdicts. */
export function claudeDesktopStatus(): ClaudeDesktopStatus {
  // The preference is read on its own first, so a later failed look still reports the
  // configured value (health publishes it), not an assumed one.
  let enabled = configDefaultBoolean("claude-desktop");
  try {
    enabled = new CopilotEnvConfig().claudeDesktopEnabled();
  } catch (e) {
    return unjudged(enabled, `the claude-desktop preference could not be read (${errMessage(e)})`);
  }
  try {
    return inspectClaudeDesktopWiring(resolveClaudeDesktopTargets());
  } catch (e) {
    return unjudged(enabled, `the Desktop wiring could not be checked (${errMessage(e)})`);
  }
}

function unjudged(enabled: boolean, reason: string): ClaudeDesktopStatus {
  return {
    kind: "unjudged",
    enabled,
    installed: claudeDesktopInstalled(),
    helperPaths: [],
    reason,
  };
}

/** Cleanup runs before the upserts so an orphan holding the applied slot hands it to the entry
 *  replacing it. This is the ONE caller of the key-off sweep, so its notice naming the default's
 *  leftover entry prints from here and nowhere else; the default write's own key-off stays
 *  silent (syncClaudeDesktopWiring in src/claude/desktop.ts).
 *
 *    quiet (the launcher hot path) -> cleanup only: no upsert, identity probe, discovery, or notice */
export async function reconcileClaudeDesktopWiring(opts: { quiet?: boolean } = {}): Promise<void> {
  try {
    // Resolved targets gate EVERY cleanup, the key-off sweep included: a store that
    // cannot be trusted must not decide what is ours to remove.
    const resolution = resolveClaudeDesktopTargets();
    if (resolution.kind === "unresolvable") {
      logger.warn(`  Claude Desktop: ${resolution.reason}; leaving the config library alone.`);
      return;
    }
    if (!new CopilotEnvConfig().claudeDesktopEnabled()) {
      removeUnmanagedClaudeDesktopWiring({ quiet: opts.quiet });
      return;
    }
    if (!claudeDesktopInstalled()) return;
    const status = inspectClaudeDesktopWiring(resolution);
    if (status.kind === "unreadable") {
      logger.warn(
        `  Claude Desktop: ${status.metaPath} has an unexpected shape; leaving the config library alone.`,
      );
      return;
    }
    if (status.kind === "unjudged") {
      logger.warn(`  Claude Desktop: ${status.reason}; leaving the config library alone.`);
      return;
    }
    if (status.kind !== "inspected") return;
    for (const orphan of status.orphans) removeClaudeDesktopOrphan(orphan);
    if (status.unlisted.length > 0) removeUnlistedClaudeDesktopClaims();
    // The default is upserted too: a key flipped back on by a config-only import has no
    // adapter write to ride on. A default already judged wired is skipped: init / `agent
    // claude` just synced it, and re-discovering its models would be a network call for a
    // byte-identical no-op.
    const defaultWired = status.entries.some(
      (e) => e.profile === null && e.verdict.kind === "wired",
    );
    for (const target of opts.quiet ? [] : resolution.targets) {
      if (target.profile === null && defaultWired) continue;
      await syncTarget(target);
    }
  } catch (e) {
    logger.warn(`  Could not reconcile the Claude Desktop wiring: ${errMessage(e)}`);
  }
}

/** Resilient like `agent profile --sync`. The default resolves its credential here for the
 *  catalog fetch; a named profile's wire resolves its own. */
async function syncTarget({ profile, mode }: DesktopTarget): Promise<void> {
  try {
    const ghToken = profile === null && mode === "direct" ? new Credential().resolve() : undefined;
    const write: ManagedWrite = mode === "direct"
      ? {
        mode: "direct",
        directIntegrationId: await resolveAndPersistDirectIdentity(profile, ghToken),
      }
      : { mode: "proxy" };
    await syncClaudeDesktopWiring({ ...write, profile, directToken: ghToken });
  } catch (e) {
    logger.warn(`  Could not refresh ${profileLabel(profile)}'s Desktop entry: ${errMessage(e)}`);
  }
}
