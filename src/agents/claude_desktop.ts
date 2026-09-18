// The whole-library Claude Desktop reconcile behind the `claude.desktop` key, and the
// status `agent profile check --claude` and health judge. Cross-agent: every promise comes from the store
// (the default slot's recorded mode, the named slots), never from the agent files.
import {
  claudeDesktopInstalled,
  claudeDesktopRunning,
  planClaudeDesktopSync,
  planRemoveClaudeDesktopOrphan,
  planRemoveUnlistedClaudeDesktopClaims,
  planRemoveUnmanagedClaudeDesktopWiring,
  profileStoreWellFormed,
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
import { landPlan } from "../utils/write_session.ts";
import {
  landWithReservedPort,
  type ManagedWrite,
  resolveCredentialWiring,
  resolvedDirectToken,
} from "./configure.ts";
import { renderDirectWiring } from "./profile_wiring.ts";

const logger = createStderrLogger();

/** Any read failure is `unresolvable`, never an empty target list: an empty list would sweep
 *  every live entry as an orphan. A default slot with no recorded mode (nothing wired yet)
 *  promises no default entry. */
export function resolveClaudeDesktopTargets(): DesktopTargetResolution {
  const targets: DesktopTarget[] = [];
  try {
    // Every promise comes from copilot-env's own state: the default slot's recorded mode (the one
    // mode both agents share, written by the default wiring commands; null until the first write)
    // and each complete named slot. settings.json is an output, never read for this.
    const storeFile = new CopilotApiPaths().stateStoreFile;
    if (!profileStoreWellFormed(storeFile)) {
      return { kind: "unresolvable", reason: `the state store ${storeFile} is malformed` };
    }
    const state = new CopilotEnvState();
    const defaultMode = state.readProfileSlot(null).mode;
    if (defaultMode !== null) targets.push({ profile: null, mode: defaultMode });
    for (const name of state.profileNames()) {
      const slot = state.readProfileSlot(name);
      if (slot.kind === "complete") targets.push({ profile: name, mode: slot.mode });
    }
  } catch (e) {
    return {
      kind: "unresolvable",
      reason: `the profile store could not be read: ${errMessage(e)}`,
    };
  }
  return { kind: "resolved", targets };
}

/** Never throws: a failed look anywhere is an `unjudged` status, so `agent profile check --claude`
 *  and health report it and keep their own verdicts. */
export function claudeDesktopStatus(): ClaudeDesktopStatus {
  // The preference is read on its own first, so a later failed look still reports the
  // configured value (health publishes it), not an assumed one.
  let enabled = configDefaultBoolean("claude.desktop");
  try {
    enabled = new CopilotEnvConfig().claudeDesktopEnabled();
  } catch (e) {
    return unjudged(enabled, `the claude.desktop preference could not be read (${errMessage(e)})`);
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
 *  silent (planClaudeDesktopSync in src/claude/desktop.ts).
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
      landPlan(planRemoveUnmanagedClaudeDesktopWiring({ quiet: opts.quiet }));
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
    for (const orphan of status.orphans) landPlan(planRemoveClaudeDesktopOrphan(orphan));
    if (status.unlisted.length > 0) {
      const sweep = planRemoveUnlistedClaudeDesktopClaims();
      if (sweep.kind === "swept") landPlan(sweep);
    }
    if (opts.quiet) return;
    // The default is upserted too: a key flipped back on by a config-only import has no
    // adapter write to ride on. A default already judged wired is skipped: init / `agent
    // profile sync --claude` just synced it, and re-discovering its models would be a network call for a
    // byte-identical no-op.
    const defaultWired = status.entries.some(
      (e) => e.profile === null && e.verdict.kind === "wired",
    );
    for (const target of resolution.targets) {
      if (target.profile === null && defaultWired) continue;
      await syncTarget(target);
    }
    if (resolution.targets.length === 0) return;
    await reportClaudeDesktopReady(resolution);
  } catch (e) {
    logger.warn(`  Could not reconcile the Claude Desktop wiring: ${errMessage(e)}`);
  }
}

/** One line, only when the app WILL come up on the default entry at its next launch: the default is
 *  wired, `_meta.json` applies it, and the app boots third-party. Anything less is left to
 *  `agent profile check --claude`, whose lines name the gap. */
async function reportClaudeDesktopReady(resolution: DesktopTargetResolution): Promise<void> {
  const status = inspectClaudeDesktopWiring(resolution);
  if (status.kind !== "inspected") return;
  const ready =
    status.entries.some((e) =>
      e.profile === null && e.verdict.kind === "wired" && status.applied?.path === e.verdict.path
    ) && status.app.kind === "read" && status.app.deploymentMode === "3p";
  if (!ready) return;
  if ((await claudeDesktopRunning()) === "present") {
    logger.warn(
      "  Claude Desktop is running; quit it fully and reopen it to pick up the new files.",
    );
  }
  logger.success("  Claude Desktop is ready to use.");
}

/** Resilient like `agent sync`. The default resolves its credential here for the
 *  catalog fetch; a named profile's wire resolves its own. A Direct slot holding no pair is left
 *  as it is and named: the reconcile writes the Desktop entry alone, and the pair is landed only
 *  together with both agents' files (the repair command). */
async function syncTarget({ profile, mode }: DesktopTarget): Promise<void> {
  try {
    const rendered = mode === "direct" ? renderDirectWiring(profile) : null;
    if (mode === "direct" && rendered === null) {
      const repair = profile === null ? "agent profile sync --claude" : "agent sync";
      logger.warn(
        `  ${profileLabel(profile)}'s Direct pair is not stored; its Desktop entry is left as it ` +
          `is. \`${repair}\` lands the pair together with both agents' files and the entry.`,
      );
      return;
    }
    const ghToken = profile === null && mode === "direct" ? new Credential().resolve() : undefined;
    const credential = resolveCredentialWiring("claude", mode, profile, ghToken);
    // A static credential is already resolved: the identity probe and discovery reuse it.
    const token = ghToken ?? resolvedDirectToken(mode, credential);
    const write: ManagedWrite = mode === "direct"
      ? { mode: "direct", direct: rendered, credential }
      : { mode: "proxy", credential };
    const plan = await planClaudeDesktopSync({ ...write, profile, directToken: token });
    landWithReservedPort(plan, profile, plan.plannedPort);
  } catch (e) {
    logger.warn(`  Could not refresh ${profileLabel(profile)}'s Desktop entry: ${errMessage(e)}`);
  }
}
