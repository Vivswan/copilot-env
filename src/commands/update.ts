import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { consola } from "consola";

import { PROJECT_ROOT } from "../utils/root.ts";
import { versionLessThan } from "../utils/semver.ts";

// `agent update` brings the copilot-env checkout up to the newest GitHub release
// (the installers do the first install; this owns updates). `--cooldown` adopts the
// newest release aged >= N days instead of strictly the latest -- the same
// supply-chain delay the installers apply. Pure tag-picking is split out
// (pickLatestTag / pickAgedTag) so it can be unit-tested without a network/git.

const SECONDS_PER_DAY = 24 * 60 * 60;

/** Newest release tag from `git ls-remote --tags --sort=-v:refname` output. */
export function pickLatestTag(lsRemoteOutput: string): string | null {
  for (const line of lsRemoteOutput.split("\n")) {
    // "<sha>\trefs/tags/vX.Y.Z" -- skip peeled "^{}" rows and prereleases.
    const match = line.match(/\trefs\/tags\/(v\d+\.\d+\.\d+)$/);
    if (match) return match[1] ?? null;
  }
  return null;
}

/** Newest release tag aged >= `days` from `git for-each-ref ... %(creatordate:unix)` output. */
export function pickAgedTag(
  forEachRefOutput: string,
  nowSeconds: number,
  days: number,
): string | null {
  const cutoff = nowSeconds - days * SECONDS_PER_DAY;
  let oldest: string | null = null; // fallback: the most-aged release (mirrors the installers)
  for (const line of forEachRefOutput.split("\n")) {
    const space = line.indexOf(" ");
    if (space < 0) continue;
    const ts = Number(line.slice(0, space));
    const tag = line.slice(space + 1).trim();
    if (!/^v\d+\.\d+\.\d+$/.test(tag)) continue;
    oldest = tag; // input is newest-first, so the last kept tag is the oldest
    if (Number.isFinite(ts) && ts <= cutoff) return tag;
  }
  return oldest;
}

function git(args: string[]): { status: number; stdout: string } {
  const result = spawnSync("git", ["-C", PROJECT_ROOT, ...args], { encoding: "utf-8" });
  return { status: result.status ?? 1, stdout: (result.stdout ?? "").toString() };
}

/** Current version from package.json (release-please-maintained), as `vX.Y.Z`. */
function currentVersion(): string {
  const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf-8")) as {
    version?: unknown;
  };
  return `v${typeof pkg.version === "string" ? pkg.version : "0.0.0"}`;
}

const stripV = (v: string): string => v.replace(/^v/, "");

function resolveTarget(cooldownDays: number | null): string | null {
  if (cooldownDays === null) {
    const out = git(["ls-remote", "--tags", "--sort=-v:refname", "origin", "v*"]);
    return out.status === 0 ? pickLatestTag(out.stdout) : null;
  }
  // Cooldown needs tag dates -> fetch tags locally, then pick by creatordate. A
  // fetch failure (offline/bad remote) must not fall through to stale local tags.
  if (git(["fetch", "--tags", "--force", "origin"]).status !== 0) return null;
  const out = git([
    "for-each-ref",
    "--sort=-creatordate",
    "--format=%(creatordate:unix) %(refname:short)",
    "refs/tags/v*",
  ]);
  return out.status === 0 ? pickAgedTag(out.stdout, Date.now() / 1000, cooldownDays) : null;
}

export function runUpdate(args: {
  check?: boolean;
  cooldown?: boolean;
  "cooldown-days"?: string;
}): void {
  let cooldownDays: number | null = null;
  if (args.cooldown) {
    const raw = args["cooldown-days"] ?? "7";
    if (!/^\d+$/.test(raw)) {
      throw new Error(`--cooldown-days must be a non-negative whole number (got '${raw}')`);
    }
    cooldownDays = Number.parseInt(raw, 10);
  }

  const current = currentVersion();
  const target = resolveTarget(cooldownDays);
  if (!target) {
    consola.warn("No copilot-env release found upstream (or git/network unavailable).");
    process.exitCode = 2; // distinct from "update available" (1) and "up to date" (0)
    return;
  }

  if (!versionLessThan(stripV(current), stripV(target))) {
    consola.success(`copilot-env is up to date (${current}).`);
    return;
  }

  consola.info(`Update available: ${current} -> ${target}`);
  if (args.check) {
    process.exitCode = 1; // an update is available
    return;
  }

  // Refuse to clobber local edits (protects dev checkouts); fail closed if the
  // status probe itself errors (e.g. not a git checkout).
  const status = git(["status", "--porcelain"]);
  if (status.status !== 0 || status.stdout.trim()) {
    throw new Error(
      "the checkout has uncommitted changes (or is not a git repo); resolve, then retry.",
    );
  }
  if (git(["fetch", "--tags", "origin"]).status !== 0) throw new Error("git fetch failed");
  if (git(["checkout", target]).status !== 0) throw new Error(`failed to checkout ${target}`);

  // Refresh deps for the new release (HUSKY=0 mirrors the bin shims).
  const install = spawnSync("bun", ["install", "--frozen-lockfile"], {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
    env: { ...process.env, HUSKY: "0" },
  });
  if (install.status !== 0) throw new Error("bun install failed after update");

  consola.success(
    `Updated copilot-env ${current} -> ${target}. Restart your agents to pick it up.`,
  );
}
