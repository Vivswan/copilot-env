// Apply a resolved release onto the checkout: download + sync the tarball, refresh
// deps, and run post-update migrations in a fresh process. Shared by `agent update`
// (src/commands/update.ts) and the autoupdate preflight (src/autoupdate/preflight.ts)
// so there's exactly one update implementation — and so neither imports the other
// (no import cycle). Callers own the up-to-date / `--check` / `.git` gates.
import { type StdioOptions, spawnSync } from "node:child_process";
import { join } from "node:path";
import { consola } from "consola";

import { applyRelease } from "../install/release.ts";
import type { Release } from "../install/resolve-release.ts";
import { PROJECT_ROOT } from "../utils/root.ts";
import { stripV } from "../utils/semver.ts";

/** Minimal sink so the preflight can route progress to a stderr-only logger. */
interface UpdateLogger {
  warn(message: string): void;
  success(message: string): void;
}

/** Run `bun install --frozen-lockfile` in the checkout (HUSKY=0 mirrors the bin shims). */
export function bunInstallFrozen(stdio: StdioOptions = "inherit"): void {
  const install = spawnSync("bun", ["install", "--frozen-lockfile"], {
    cwd: PROJECT_ROOT,
    stdio,
    env: { ...process.env, HUSKY: "0" },
  });
  if (install.status !== 0)
    throw new Error(
      `bun install failed (exit ${install.status ?? install.signal}); see the output above.`,
    );
}

export interface ApplyUpdateOptions {
  /** Where progress/warnings go (default: the global stdout consola). */
  logger?: UpdateLogger;
  /**
   * Send the child processes' stdout to stderr (so `bun install`/migration output
   * can't pollute stdout). The preflight sets this to protect the `agent env`
   * stdout contract on platforms where the launcher can't redirect streams.
   */
  childStdoutToStderr?: boolean;
}

export async function applyUpdate(
  current: string,
  target: Release,
  opts: ApplyUpdateOptions = {},
): Promise<void> {
  const logger = opts.logger ?? consola;
  // ["ignore", 2, 2] => stdin closed, child stdout AND stderr both go to our fd2.
  const stdio: StdioOptions = opts.childStdoutToStderr ? ["ignore", 2, 2] : "inherit";

  await applyRelease(target.tarballUrl, target.sourceSha, target.sourceSha256);

  // Refresh deps for the new release.
  bunInstallFrozen(stdio);

  // Run post-update migrations in a FRESH process so they load from the new release on
  // disk -- this process still holds the pre-update code in memory. Best-effort: a
  // migration hiccup never fails the update. Effective only for updates that originate
  // at a release already shipping this call (>= the one that introduced migrations);
  // earlier transitions are handled by the installer's `agent shell` refresh.
  const migrate = spawnSync(
    "bun",
    [join(PROJECT_ROOT, "src", "migrations", "index.ts"), stripV(current), stripV(target.tag)],
    { cwd: PROJECT_ROOT, stdio, env: { ...process.env, HUSKY: "0" } },
  );
  if (migrate.status !== 0) {
    logger.warn("Post-update migrations reported a problem; see the output above.");
  }

  logger.success(
    `Updated copilot-env ${current} -> ${target.tag}. Restart your agents to pick it up.`,
  );
}
