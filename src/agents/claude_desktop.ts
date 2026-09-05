// The whole-library Claude Desktop reconcile behind the `claude-desktop` key, and the
// status `agent claude --check` and health judge. Cross-agent: the default entry's mode
// comes from settings.json (src/agents/wiring.ts), the profiles' from the store.
import {
  claudeDesktopInstalled,
  type ClaudeDesktopStatus,
  type DesktopTarget,
  type DesktopTargetResolution,
  inspectClaudeDesktopWiring,
  removeAllClaudeDesktopWiring,
  removeClaudeDesktopEntry,
  removeUnlistedClaudeDesktopClaims,
  syncClaudeDesktopWiring,
} from "../claude/desktop.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { CopilotEnvState } from "../copilot_api/env_state.ts";
import { CopilotApiPaths } from "../copilot_api/paths.ts";
import { profileLabel } from "../copilot_api/profile.ts";
import { errMessage } from "../utils/error.ts";
import { readTextResult } from "../utils/fs.ts";
import { isRecord } from "../utils/json.ts";
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

/** Whether the profile store file is JSON with an object root and an object-of-objects
 *  `profiles` map (or is absent). The lenient store reader degrades any of those faults to
 *  "no profiles", which would make every named entry an orphan to delete. */
function profileStoreWellFormed(storeFile: string): boolean {
  const read = readTextResult(storeFile);
  if (read.kind === "absent") return true;
  if (read.kind === "unreadable") throw new Error(`could not read ${storeFile}: ${read.error}`);
  if (read.text.trim() === "") return true; // the canonical reader's empty store
  let doc: unknown;
  try {
    doc = JSON.parse(read.text);
  } catch {
    return false;
  }
  if (!isRecord(doc)) return false;
  const profiles = doc["profiles"];
  return profiles === undefined ||
    (isRecord(profiles) && Object.values(profiles).every(isRecord));
}

/** The Desktop wiring judged against the promised targets (read-only). A failed look
 *  anywhere (an unreadable ledger, root home, or store) is an `unjudged` status, never a
 *  throw: `agent claude --check` and health report it and keep their own verdicts. */
export function claudeDesktopStatus(): ClaudeDesktopStatus {
  try {
    return inspectClaudeDesktopWiring(resolveClaudeDesktopTargets());
  } catch (e) {
    return {
      kind: "unjudged",
      enabled: true,
      installed: claudeDesktopInstalled(),
      helperPaths: [],
      reason: `the Desktop wiring could not be checked (${errMessage(e)})`,
    };
  }
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
    for (const target of opts.quiet ? [] : resolution.targets) {
      if (target.profile !== null) await syncNamedTarget(target.profile, target.mode);
    }
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

/** One named target's upsert, resilient like `agent profile --sync`. */
async function syncNamedTarget(
  name: NonNullable<DesktopTarget["profile"]>,
  mode: DesktopTarget["mode"],
): Promise<void> {
  try {
    const write: ManagedWrite = mode === "direct"
      ? { mode: "direct", directIntegrationId: await resolveAndPersistDirectIdentity(name) }
      : { mode: "proxy" };
    await syncClaudeDesktopWiring({ ...write, profile: name });
  } catch (e) {
    logger.warn(`  Could not refresh ${profileLabel(name)}'s Desktop entry: ${errMessage(e)}`);
  }
}
