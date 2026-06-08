// `agent update`: resolves a release, applies it, refreshes deps, and runs migrations.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { consola } from "consola";
import { applyRelease } from "../install/release.ts";
import { resolveTarget } from "../install/resolve-release.ts";
import { PROJECT_ROOT } from "../utils/root.ts";
import { versionLessThan } from "../utils/semver.ts";
import { packageVersion } from "../utils/version.ts";

// `agent update` brings the checkout up to the newest GitHub release WITHOUT git:
//  - discovery (which release, and its tarball URL) is resolveTarget() from
//    ../install/resolve-release.ts -- the SAME module the installers download + run,
//    so the release-pick logic has one home. Then
//  - apply downloads that release's `tarball_url` and SYNCS it onto the checkout:
//    tracked files are replaced, files the release no longer ships (and OS junk)
//    are pruned, and node_modules/.git are preserved; then `bun install`.

const stripV = (v: string): string => v.replace(/^v/, "");

export interface UpdateArgs {
  check?: boolean;
  cooldown?: number | null;
  force?: boolean;
}

export async function runUpdate(args: UpdateArgs): Promise<void> {
  const cooldown = args.cooldown ?? null;
  if (cooldown !== null && (!Number.isInteger(cooldown) || cooldown < 0)) {
    throw new Error(`--cooldown expects a non-negative whole number of days (got '${cooldown}')`);
  }

  // Current checkout version as `vX.Y.Z`, to match the upstream tag format for display.
  const current = `v${packageVersion()}`;
  const target = await resolveTarget(cooldown);
  if (!target) {
    consola.warn("No copilot-env release found upstream (or the network is unavailable).");
    process.exitCode = 2; // distinct from "update available" (1) and "up to date" (0)
    return;
  }

  if (!versionLessThan(stripV(current), stripV(target.tag))) {
    consola.success(`copilot-env is up to date (${current}).`);
    return;
  }

  consola.info(`Update available: ${current} -> ${target.tag}`);
  if (args.check) {
    process.exitCode = 1; // an update is available
    return;
  }

  // The sync overwrites/prunes the checkout in place. A `.git` dir means this is a git
  // checkout (a dev/manual clone, not a tarball install) that may hold uncommitted or
  // untracked work -- refuse unless --force so an update can't silently destroy it.
  // (existsSync is a file probe, not a git command; tarball installs have no .git and
  // update freely.)
  if (!args.force && existsSync(join(PROJECT_ROOT, ".git"))) {
    throw new Error(
      "this is a git checkout (.git present) and `agent update` overwrites files in place; " +
        "commit or stash your changes and re-run with --force (or update via git).",
    );
  }

  consola.start(`Updating copilot-env ${current} -> ${target.tag} ...`);
  await applyRelease(target.tarballUrl, target.sourceSha);

  // Refresh deps for the new release (HUSKY=0 mirrors the bin shims).
  const install = spawnSync("bun", ["install", "--frozen-lockfile"], {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
    env: { ...process.env, HUSKY: "0" },
  });
  if (install.status !== 0) throw new Error("bun install failed after update");

  // Run post-update migrations in a FRESH process so they load from the new release on
  // disk -- this process still holds the pre-update code in memory. Best-effort: a
  // migration hiccup never fails the update. Effective only for updates that originate
  // at a release already shipping this call (>= the one that introduced migrations);
  // earlier transitions are handled by the installer's `agent setup shell` refresh.
  const migrate = spawnSync(
    "bun",
    [join(PROJECT_ROOT, "src", "migrations", "index.ts"), stripV(current), stripV(target.tag)],
    { cwd: PROJECT_ROOT, stdio: "inherit", env: { ...process.env, HUSKY: "0" } },
  );
  if (migrate.status !== 0) {
    consola.warn("Post-update migrations reported a problem; see the output above.");
  }

  consola.success(
    `Updated copilot-env ${current} -> ${target.tag}. Restart your agents to pick it up.`,
  );
}
