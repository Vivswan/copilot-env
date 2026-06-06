// Single source of truth for "which copilot-env release to install / update to".
//
// This file is SELF-CONTAINED (no repo-internal imports, no dependencies) on purpose:
// the installers download THIS ONE FILE and run it with bun to resolve the release
// tarball URL *before* any repo is on disk, while src/commands/update.ts imports the
// same functions. Keep it dependency-free so the standalone download keeps working.
//
//   bun resolve-release.ts [--cooldown-days N]   ->  prints the chosen tarball_url
//
// Discovery reads the GitHub Releases REST API (JSON; published, non-prerelease,
// vX.Y.Z only) and takes the tag/date/tarball URL verbatim from the payload.

const SECONDS_PER_DAY = 24 * 60 * 60;
// per_page=100 reads every release in one page (this repo will not exceed that for
// years), so cooldown selection sees the whole eligible set, not just the first 30.
const RELEASES_API = "https://api.github.com/repos/Vivswan/copilot-env/releases?per_page=100";
const GH = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2026-03-10",
  "User-Agent": "copilot-env",
} as const;

/** A published release, taken verbatim from the API: tag, publish time, tarball URL. */
export interface Release {
  tag: string;
  dateSeconds: number;
  tarballUrl: string;
}

/** Parse the GitHub `/releases` JSON into newest-first releases: published,
 *  non-prerelease, exact vX.Y.Z, with a tarball URL. Returns [] on anything
 *  unparseable. */
export function parseReleasesJson(jsonText: string): Release[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const releases: Release[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (r.draft === true || r.prerelease === true) continue;
    if (typeof r.tag_name !== "string" || !/^v\d+\.\d+\.\d+$/.test(r.tag_name)) continue;
    if (typeof r.tarball_url !== "string") continue;
    const date = typeof r.published_at === "string" ? r.published_at : r.created_at;
    if (typeof date !== "string") continue;
    const dateSeconds = Math.floor(Date.parse(date) / 1000);
    if (Number.isFinite(dateSeconds)) {
      releases.push({ tag: r.tag_name, dateSeconds, tarballUrl: r.tarball_url });
    }
  }
  // Don't trust the API's order -- sort newest-first ourselves.
  releases.sort((a, b) => b.dateSeconds - a.dateSeconds);
  return releases;
}

/** Newest release (the first after sorting), or null. */
export function pickLatest(releases: Release[]): Release | null {
  return releases[0] ?? null;
}

/** Newest release aged >= `days`, falling back to the oldest known release. */
export function pickAged(releases: Release[], nowSeconds: number, days: number): Release | null {
  const cutoff = nowSeconds - days * SECONDS_PER_DAY;
  let oldest: Release | null = null;
  for (const r of releases) {
    oldest = r; // newest-first, so the last seen is the oldest
    if (r.dateSeconds <= cutoff) return r;
  }
  return oldest;
}

/** Fetch the releases and pick the target: the latest, or (with a cooldown) the newest
 *  release aged >= `cooldownDays`. Returns null when offline / the API errors / there is
 *  no eligible release. */
export async function resolveTarget(cooldownDays: number | null): Promise<Release | null> {
  let text: string;
  try {
    const res = await fetch(RELEASES_API, { headers: GH });
    if (!res.ok) return null;
    text = await res.text();
  } catch {
    return null; // offline / API unreachable
  }
  const releases = parseReleasesJson(text);
  if (releases.length === 0) return null;
  return cooldownDays === null
    ? pickLatest(releases)
    : pickAged(releases, Date.now() / 1000, cooldownDays);
}

// CLI used by install.sh / install.ps1 (run via bun): prints the chosen tarball_url.
// Exit 0 + url on success; 1 if no release resolved / offline; 2 on bad/unknown args.
if (import.meta.main) {
  const args = process.argv.slice(2);
  let cooldownDays: number | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--cooldown-days") {
      const raw = args[++i] ?? "";
      if (!/^\d+$/.test(raw)) {
        process.stderr.write(
          `--cooldown-days must be a non-negative whole number (got '${raw}')\n`,
        );
        process.exit(2);
      }
      cooldownDays = Number.parseInt(raw, 10);
    } else {
      process.stderr.write(`unknown argument '${args[i]}' (only --cooldown-days N is accepted)\n`);
      process.exit(2);
    }
  }
  const target = await resolveTarget(cooldownDays);
  if (!target) {
    process.stderr.write("no copilot-env release found (or the network is unavailable)\n");
    process.exit(1);
  }
  process.stdout.write(target.tarballUrl);
}
