// Single source of truth for "which copilot-env release to install / update to".
//
// This file is SELF-CONTAINED (no repo-internal imports, no dependencies) on purpose:
// the installers download THIS ONE FILE and run it with bun to resolve the release
// tarball URL *before* any repo is on disk, while src/commands/update.ts imports the
// same functions. Keep it dependency-free so the standalone download keeps working.
//
// Direct run:
//   bun src/install/resolve-release.ts
//     Print the chosen release tarball_url for install.sh / install.ps1.
//   bun src/install/resolve-release.ts --json
//     Print tag, tarballUrl, sourceSha, and checksum URL metadata so installers
//     can verify the archive.
//   bun src/install/resolve-release.ts --json --tag vX.Y.Z
//     Print metadata for that exact published release. Release-uploaded
//     installer assets use this so `.../releases/download/vX.Y.Z/install.sh`
//     installs vX.Y.Z instead of floating to latest.
//
// Arguments:
//   --json  Emit structured release metadata instead of only the tarball URL.
//   --tag   Resolve one exact release tag instead of the latest release.
//
// Discovery reads the GitHub Releases REST API (JSON; published, non-prerelease,
// vX.Y.Z only) and takes the tag/date/tarball URL verbatim from the payload.
// Set COPILOT_ENV_CI_INCLUDE_DRAFT_RELEASES=1 only in release CI smoke tests;
// normal installs intentionally ignore draft releases.

const SECONDS_PER_DAY = 24 * 60 * 60;
// per_page=100 reads every release in one page (this repo will not exceed that for
// years), so cooldown selection sees the whole eligible set, not just the first 30.
const RELEASES_API = "https://api.github.com/repos/Vivswan/copilot-env/releases?per_page=100";
const GH = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2026-03-10",
  "User-Agent": "copilot-env",
} as const;
const CI_INCLUDE_DRAFT_RELEASES_ENV = "COPILOT_ENV_CI_INCLUDE_DRAFT_RELEASES";

/** A published release, taken from the API: tag, publish time, tarball URL, and
 *  the full commit SHA GitHub places in the source archive wrapper dir. */
export interface Release {
  tag: string;
  dateSeconds: number;
  tarballUrl: string;
  sourceSha: string;
  sourceSha256Url: string | null;
}

function releaseAssetUrl(release: Record<string, unknown>, name: string): string | null {
  if (!Array.isArray(release.assets)) return null;
  for (const item of release.assets) {
    if (typeof item !== "object" || item === null) continue;
    const asset = item as Record<string, unknown>;
    if (asset.name === name && typeof asset.browser_download_url === "string") {
      return asset.browser_download_url;
    }
  }
  return null;
}

function releaseArchiveName(tag: string): string {
  return `copilot-env-${tag}.tar.gz`;
}

/** Parse the GitHub `/releases` JSON into newest-first releases: published,
 *  non-prerelease, exact vX.Y.Z, with a tarball URL. Returns [] on anything
 *  unparseable. */
export function parseReleasesJson(jsonText: string, includeDrafts = false): Release[] {
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
    if ((r.draft === true && !includeDrafts) || r.prerelease === true) continue;
    if (typeof r.tag_name !== "string" || !/^v\d+\.\d+\.\d+$/.test(r.tag_name)) continue;
    if (typeof r.target_commitish !== "string" || !/^[0-9a-f]{40}$/i.test(r.target_commitish)) {
      continue;
    }
    const archiveName = releaseArchiveName(r.tag_name);
    const sourceArchiveUrl = releaseAssetUrl(r, archiveName);
    const tarballUrl =
      sourceArchiveUrl ?? (typeof r.tarball_url === "string" ? r.tarball_url : null);
    if (!tarballUrl) continue;
    const sourceSha256Url = sourceArchiveUrl ? releaseAssetUrl(r, `${archiveName}.sha256`) : null;
    const date = typeof r.published_at === "string" ? r.published_at : r.created_at;
    if (typeof date !== "string") continue;
    const dateSeconds = Math.floor(Date.parse(date) / 1000);
    if (Number.isFinite(dateSeconds)) {
      releases.push({
        tag: r.tag_name,
        dateSeconds,
        tarballUrl,
        sourceSha: r.target_commitish.toLowerCase(),
        sourceSha256Url,
      });
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

/** Exact tag release, accepting either vX.Y.Z or X.Y.Z. */
export function pickTag(releases: Release[], tag: string): Release | null {
  const normalized = tag.startsWith("v") ? tag : `v${tag}`;
  return releases.find((r) => r.tag === normalized) ?? null;
}

/** Fetch the releases and pick the target: the latest, or (with a cooldown) the newest
 *  release aged >= `cooldownDays`. Returns null when offline / the API errors / there is
 *  no eligible release. */
export async function resolveTarget(
  cooldownDays: number | null,
  exactTag: string | null = null,
): Promise<Release | null> {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = { ...GH };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const includeDrafts = process.env[CI_INCLUDE_DRAFT_RELEASES_ENV] === "1";
  let text: string;
  try {
    const res = await fetch(RELEASES_API, { headers });
    if (!res.ok) return null;
    text = await res.text();
  } catch {
    return null; // offline / API unreachable
  }
  const releases = parseReleasesJson(text, includeDrafts);
  if (releases.length === 0) return null;
  if (exactTag !== null) return pickTag(releases, exactTag);
  return cooldownDays === null
    ? pickLatest(releases)
    : pickAged(releases, Date.now() / 1000, cooldownDays);
}

// CLI used by install.sh / install.ps1 (run via bun): prints the chosen tarball_url.
// Exit 0 + url on success; 1 if no release resolved / offline; 2 on bad/unknown args.
if (import.meta.main) {
  const args = process.argv.slice(2);
  let json = false;
  let tag: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--tag") {
      tag = args[++i] ?? "";
      if (!tag) {
        process.stderr.write("--tag needs a value, e.g. --tag v1.3.0\n");
        process.exit(2);
      }
    } else if (arg?.startsWith("--tag=")) {
      tag = arg.slice("--tag=".length);
      if (!tag) {
        process.stderr.write("--tag= needs a value, e.g. --tag=v1.3.0\n");
        process.exit(2);
      }
    } else {
      process.stderr.write(`unknown argument '${arg}' (accepted: --json, --tag TAG)\n`);
      process.exit(2);
    }
  }
  const target = await resolveTarget(null, tag);
  if (!target) {
    process.stderr.write(
      tag
        ? `copilot-env release ${tag} was not found (or the GitHub API is unreachable)\n`
        : "no copilot-env release found (or the network is unavailable)\n",
    );
    process.exit(1);
  }
  process.stdout.write(
    json
      ? JSON.stringify({
          tag: target.tag,
          tarballUrl: target.tarballUrl,
          sourceSha: target.sourceSha,
          sourceSha256Url: target.sourceSha256Url,
        })
      : target.tarballUrl,
  );
}
