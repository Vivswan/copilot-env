// The whole-library Claude Desktop reconcile behind the `claude-desktop` key, and the
// status `agent claude --check` and health judge. Cross-agent: the default entry's mode
// comes from settings.json (src/agents/wiring.ts), the profiles' from the store.
import {
  claudeDesktopInstalled,
  type ClaudeDesktopStatus,
  type DesktopTarget,
  type DesktopTargetResolution,
  inspectClaudeDesktopWiring,
  profileStoreWellFormed,
  removeAllClaudeDesktopWiring,
  removeClaudeDesktopEntry,
  removeUnlistedClaudeDesktopClaims,
  syncClaudeDesktopWiring,
} from "../claude/desktop.ts";
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

/** The default entry mirrors settings.json's managed mode (`none` or a custom provider
 *  promises none), then every COMPLETE profile slot. Any read failure is `unresolvable`,
 *  never "nothing": that misreading is what would sweep a live entry as an orphan. */
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

/** The Desktop wiring judged against the promised targets (read-only). A failed look
 *  anywhere (an unreadable ledger, root home, or store) is an `unjudged` status, never a
 *  throw: `agent claude --check` and health report it and keep their own verdicts. */
export function claudeDesktopStatus(): ClaudeDesktopStatus {
  // The preference is read on its own first, so a later failed look still reports the
  // value actually configured (health publishes it), never an assumed one.
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

/** The whole-library reconcile after a default write: key off sweeps everything owned; key
 *  on upserts every named target, then clears orphans and unlisted claims. `quiet` (the
 *  launcher hot path) is cleanup-only: no upsert, so no identity probe and no discovery. */
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
      removeAllClaudeDesktopWiring();
      return;
    }
    if (!claudeDesktopInstalled()) return;
    // Every promised target, the default included: a key flipped back to true by a
    // config-only import has no adapter write to ride on, so true is symmetric with false.
    for (const target of opts.quiet ? [] : resolution.targets) await syncTarget(target);
    const status = inspectClaudeDesktopWiring(resolution);
    if (status.kind === "unreadable") {
      logger.warn(
        `  Claude Desktop: ${status.metaPath} has an unexpected shape; leaving the config library alone.`,
      );
      return;
    }
    if (status.kind !== "inspected") return;
    for (const orphan of status.orphans) {
      if (orphan.profile === undefined) {
        logger.info(
          `  Claude Desktop: "${orphan.name}" at ${orphan.path} is ours but was renamed in the app; left alone.`,
        );
        continue;
      }
      removeClaudeDesktopEntry(orphan.profile);
    }
    if (status.unlisted.length > 0) removeUnlistedClaudeDesktopClaims();
  } catch (e) {
    logger.warn(`  Could not reconcile the Claude Desktop wiring: ${errMessage(e)}`);
  }
}

/** One target's upsert, resilient like `agent profile --sync`. The default resolves its
 *  credential for the catalog fetch; a named profile's wire resolves its own. */
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
