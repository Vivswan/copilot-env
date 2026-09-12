// The once-per-day autoupdate routine, gated on the `auto-update` config key. `agent start`
// (src/commands/start.ts) runs it as the last step of a live launch, so an installed binary
// self-updates through the one command path (a source checkout runs the check and skips the
// apply). Stderr-only output: `start`'s stdout and exit code are never touched here.
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
  /** Injectable for tests (a hermetic lock path); defaults to THE update lock. */
  lock?: typeof withUpdateLock;
}

/** A failed check or update is recorded and logged, never thrown; the caller keeps an error
 *  boundary for the I/O around the gate itself (config, state, lock). An applied update flips
 *  the live version for later starts; this process keeps running the image it loaded. */
export async function runPreflight(opts: PreflightOptions): Promise<void> {
  const state = opts.state ?? new AutoupdateState();
  if (!new CopilotEnvConfig().autoUpdateEnabled()) return;
  if (!isDue(state.read().lastCheckMs, opts.nowMs)) return;

  await (opts.lock ?? withUpdateLock)(opts.nowMs, async (outcome) => {
    if (!outcome.held) {
      logger.info(
        "autoupdate: could not take the update lock (another check running?); skipping.",
      );
      return;
    }
    // Re-read under the lock: a concurrent run may have completed the check (and apply) between
    // the unlocked read above and this acquire. This is what keeps two starts from applying
    // one release twice.
    if (!isDue(state.read().lastCheckMs, opts.nowMs)) return;
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
    // Stderr end to end, so an autoupdate can never write to stdout (protects `agent env`). No
    // flag here: the stored `verify-provenance` (default: verify) decides.
    const provenance = resolveProvenanceDecision(
      undefined,
      new CopilotEnvConfig().verifyProvenanceEnabled(),
    );
    await applyUpdate(current, target, lock, { logger, childStdoutToStderr: true, provenance });
    state.set({ lastCheckMs: nowMs, lastResult: `updated ${target.tag}` });
    logger.info(`copilot-env updated to ${target.tag}; active on the next \`agent start\``);
  } catch (e) {
    state.set({ lastCheckMs: nowMs, lastResult: `error: ${errMessage(e)}` });
    logger.warn(`autoupdate: update failed (continuing): ${errMessage(e)}`);
  }
}
