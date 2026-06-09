// The once-per-day autoupdate routine. Run by the launchers (via the
// `import.meta.main` guard) before a normal command, and once immediately by
// `agent update --auto`. All output goes to stderr (stderr-routed consola) so the
// `agent env` stdout contract is never at risk; the launchers also skip `env`.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createConsola } from "consola";

import { applyUpdate } from "../commands/apply_update.ts";
import { resolveTarget } from "../install/resolve-release.ts";
import { PROJECT_ROOT } from "../utils/root.ts";
import { stripV, versionLessThan } from "../utils/semver.ts";
import { packageVersion } from "../utils/version.ts";
import { isDue } from "./due.ts";
import { acquireLock, releaseLock } from "./lock.ts";
import { AutoupdateState } from "./state.ts";

const logger = createConsola({ stdout: process.stderr, stderr: process.stderr });

export interface PreflightOptions {
  nowMs: number;
  /** Bypass the once-per-day gate (used by `agent update --auto`). */
  force?: boolean;
  /** Injectable for tests; defaults to the real on-disk state. */
  state?: AutoupdateState;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Run the autoupdate check (and apply) if enabled and due. Non-throwing. */
export async function runPreflight(opts: PreflightOptions): Promise<void> {
  const state = opts.state ?? new AutoupdateState();
  const data = state.read();
  if (!data.enabled) return;
  if (!opts.force && !isDue(data.lastCheckMs, opts.nowMs)) return;

  if (!acquireLock(opts.nowMs)) {
    logger.info("autoupdate: another check is already running; skipping.");
    return;
  }
  try {
    await checkAndApply(state, data.cooldownDays, opts.nowMs);
  } finally {
    releaseLock();
  }
}

async function checkAndApply(
  state: AutoupdateState,
  cooldownDays: number,
  nowMs: number,
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

  if (!versionLessThan(stripV(current), stripV(target.tag))) {
    state.set({ lastCheckMs: nowMs, lastResult: "up to date" });
    return;
  }

  // Never auto-mutate a git checkout (a dev/manual clone, not a tarball install).
  if (existsSync(join(PROJECT_ROOT, ".git"))) {
    state.set({ lastCheckMs: nowMs, lastResult: "skipped: git checkout" });
    logger.info(
      `autoupdate: ${current} -> ${target.tag} available, but this is a git checkout; skipping.`,
    );
    return;
  }

  logger.start(`autoupdate: updating ${current} -> ${target.tag} ...`);
  try {
    // Route applyUpdate's own + child-process output to stderr too, so an
    // autoupdate can never write to stdout (protects `agent env` on every OS).
    await applyUpdate(current, target, { logger, childStdoutToStderr: true });
    state.set({ lastCheckMs: nowMs, lastResult: `updated ${target.tag}` });
  } catch (e) {
    state.set({ lastCheckMs: nowMs, lastResult: `error: ${errMessage(e)}` });
    logger.warn(`autoupdate: update failed (continuing): ${errMessage(e)}`);
  }
}

// Runnable: `bun src/autoupdate/preflight.ts` from the launchers. Never throws out
// (a failed self-update must not block the user's command).
if (import.meta.main) {
  runPreflight({ nowMs: Date.now() }).catch((e) => {
    logger.warn(`autoupdate preflight error: ${errMessage(e)}`);
  });
}
