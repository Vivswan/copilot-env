// The once-per-day autoupdate routine, gated on the `auto-update` config key. Run
// by the launchers (via the `import.meta.main` guard) before `agent start`. All
// output goes to stderr (stderr-routed consola) so the `agent env` stdout contract
// is never at risk; the launchers also skip `env`.
// Root .env first (as cli.ts does): COPILOT_API_HOME may live only there, and the
// config store the gate reads resolves under it.
import "../utils/dotenv.ts";
import { resolveTarget } from "../install/resolve-release.ts";
import { errMessage } from "../utils/error.ts";
import { createStderrLogger } from "../utils/logger.ts";
import { isProtectedRoot } from "../utils/root.ts";
import { isUpToDate } from "../utils/semver.ts";
import { packageVersion } from "../utils/version.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { applyUpdate, resolveProvenanceDecision } from "./apply.ts";
import { isDue } from "./due.ts";
import { type HeldUpdateLock, withUpdateLock } from "./lock.ts";
import { AutoupdateState, effectiveUpdateCooldownDays } from "./state.ts";

const logger = createStderrLogger();

export interface PreflightOptions {
  nowMs: number;
  /** Injectable for tests; defaults to the real on-disk state. */
  state?: AutoupdateState;
}

/** Run the autoupdate check (and apply) if the `auto-update` key is on and a check
 *  is due. Non-throwing. */
export async function runPreflight(opts: PreflightOptions): Promise<void> {
  const state = opts.state ?? new AutoupdateState();
  if (!new CopilotEnvConfig().autoUpdateEnabled()) return;
  if (!isDue(state.read().lastCheckMs, opts.nowMs)) return;

  await withUpdateLock(opts.nowMs, async (outcome) => {
    if (!outcome.held) {
      logger.info(
        "autoupdate: could not take the update lock (another check running?); skipping.",
      );
      return;
    }
    await checkAndApply(state, effectiveUpdateCooldownDays(), opts.nowMs, outcome);
  });
}

async function checkAndApply(
  state: AutoupdateState,
  cooldownDays: number,
  nowMs: number,
  lock: HeldUpdateLock,
): Promise<void> {
  const current = `v${packageVersion()}`;

  let target: Awaited<ReturnType<typeof resolveTarget>>;
  try {
    target = await resolveTarget(cooldownDays);
  } catch (e) {
    state.set({ lastCheckMs: nowMs, lastResult: `error: ${errMessage(e)}` });
    logger.warn(`autoupdate: release check failed: ${errMessage(e)}`);
    return;
  }

  if (!target) {
    // Offline / no release: record and stay quiet (don't nag), retry next day.
    state.set({ lastCheckMs: nowMs, lastResult: "no release resolved" });
    return;
  }

  if (isUpToDate(current, target.tag)) {
    state.set({ lastCheckMs: nowMs, lastResult: "up to date" });
    return;
  }

  // Never auto-mutate a source checkout (a dev clone, not an installed binary).
  if (isProtectedRoot()) {
    state.set({ lastCheckMs: nowMs, lastResult: "skipped: source checkout" });
    logger.info(
      `autoupdate: ${current} -> ${target.tag} available, but this is a source checkout; skipping.`,
    );
    return;
  }

  logger.start(`autoupdate: updating ${current} -> ${target.tag} ...`);
  try {
    // Route applyUpdate's own + child-process output to stderr too, so an
    // autoupdate can never write to stdout (protects `agent env` on every OS).
    // No flag here: the stored `verify-provenance` (default: verify) decides.
    const provenance = resolveProvenanceDecision(
      undefined,
      new CopilotEnvConfig().verifyProvenanceEnabled(),
    );
    await applyUpdate(current, target, lock, { logger, childStdoutToStderr: true, provenance });
    state.set({ lastCheckMs: nowMs, lastResult: `updated ${target.tag}` });
  } catch (e) {
    state.set({ lastCheckMs: nowMs, lastResult: `error: ${errMessage(e)}` });
    logger.warn(`autoupdate: update failed (continuing): ${errMessage(e)}`);
  }
}

// Runnable: `deno run -P=cli src/autoupdate/preflight.ts` from the launchers. Never throws out
// (a failed self-update must not block the user's command).
if (import.meta.main) {
  runPreflight({ nowMs: Date.now() }).catch((e) => {
    logger.warn(`autoupdate preflight error: ${errMessage(e)}`);
  });
}
