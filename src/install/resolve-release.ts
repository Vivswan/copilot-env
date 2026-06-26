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
//     Print tag, tarballUrl, sourceSha, and SHA256 metadata so installers
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
// vX.Y.Z only for floating installs) and takes the tag/date/tarball URL verbatim.
// An explicit --tag can resolve a prerelease because the user asked for that tag.
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
  sourceSha256: string | null;
}

interface ReleaseAsset {
  url: string;
  digest: string | null;
}

function normalizeSha256Digest(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.match(/^sha256:([0-9a-f]{64})$/i);
  const digest = match?.[1];
  return digest ? digest.toLowerCase() : null;
}

function releaseAsset(
  release: Record<string, unknown>,
  name: string,
  preferApiUrl = false,
): ReleaseAsset | null {
  if (!Array.isArray(release.assets)) return null;
  for (const item of release.assets) {
    if (typeof item !== "object" || item === null) continue;
    const asset = item as Record<string, unknown>;
    if (asset.name !== name) continue;
    if (preferApiUrl && typeof asset.url === "string") {
      return { url: asset.url, digest: normalizeSha256Digest(asset.digest) };
    }
    if (typeof asset.browser_download_url === "string") {
      return {
        url: asset.browser_download_url,
        digest: normalizeSha256Digest(asset.digest),
      };
    }
  }
  return null;
}

/** Parse the GitHub `/releases` JSON into newest-first releases: published,
 *  non-prerelease, exact vX.Y.Z, with a tarball URL. Returns [] on anything
 *  unparseable. */
export function parseReleasesJson(
  jsonText: string,
  includeDrafts = false,
  includePrereleases = false,
): Release[] {
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
    if ((r.draft === true && !includeDrafts) || (r.prerelease === true && !includePrereleases)) {
      continue;
    }
    if (typeof r.tag_name !== "string" || !/^v\d+\.\d+\.\d+$/.test(r.tag_name)) continue;
    if (typeof r.target_commitish !== "string" || !/^[0-9a-f]{40}$/i.test(r.target_commitish)) {
      continue;
    }
    const archiveName = `copilot-env-${r.tag_name}.tar.gz`;
    const useAssetApiUrl = r.draft === true;
    const sourceArchive = releaseAsset(r, archiveName, useAssetApiUrl);
    const tarballUrl =
      sourceArchive?.url ?? (typeof r.tarball_url === "string" ? r.tarball_url : null);
    if (!tarballUrl) continue;
    const date = typeof r.published_at === "string" ? r.published_at : r.created_at;
    if (typeof date !== "string") continue;
    const dateSeconds = Math.floor(Date.parse(date) / 1000);
    if (Number.isFinite(dateSeconds)) {
      releases.push({
        tag: r.tag_name,
        dateSeconds,
        tarballUrl,
        sourceSha: r.target_commitish.toLowerCase(),
        sourceSha256: sourceArchive?.digest ?? null,
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

// --- transient-failure retry around the GitHub API call ---------------------
// The releases endpoint occasionally 5xx's, rate-limits, or drops the connection -- most
// visibly the install.ps1 CI smoke job, whose resolver EXECUTION (unlike the resolver
// download) had no retry, so one API blip aborted the whole install with "no release found".
// A few backed-off retries turn those transients into a successful resolve. Self-contained:
// no imports, only an inline sleep. Tests set COPILOT_ENV_RELEASE_RETRY_BASE_MS=0 for speed.
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_FETCH_ATTEMPTS = 4;
const RETRY_BASE_MS_ENV = "COPILOT_ENV_RELEASE_RETRY_BASE_MS";

function retryBaseMs(): number {
  const raw = process.env[RETRY_BASE_MS_ENV];
  if (raw !== undefined && /^\d+$/.test(raw)) return Number.parseInt(raw, 10);
  return 400;
}

const sleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

/** GET the releases JSON, retrying transient failures (network drop, 5xx, rate-limit) with
 *  exponential backoff + jitter. Returns the body text, or null after exhausting attempts.
 *  A non-retryable response (e.g. 401/404) gives up immediately -- retrying won't fix it. */
async function fetchReleasesText(headers: Record<string, string>): Promise<string | null> {
  const base = retryBaseMs();
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    let retryable = true;
    try {
      const res = await fetch(RELEASES_API, { headers });
      if (res.ok) return await res.text();
      retryable = RETRYABLE_STATUSES.has(res.status);
    } catch {
      retryable = true; // network / DNS / connection reset
    }
    if (!retryable || attempt === MAX_FETCH_ATTEMPTS) return null;
    await sleep(base * 2 ** (attempt - 1) + Math.floor(Math.random() * (base + 1)));
  }
  return null;
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
  const text = await fetchReleasesText(headers);
  if (text === null) return null; // offline / API errored after retries
  const releases = parseReleasesJson(text, includeDrafts, exactTag !== null);
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
        ? `copilot-env release ${tag} was not found (or the GitHub API is unreachable); retry later or set GH_TOKEN to avoid GitHub API rate limits\n`
        : "no copilot-env release found (or the GitHub API is unreachable); retry later or set GH_TOKEN to avoid GitHub API rate limits\n",
    );
    process.exit(1);
  }
  process.stdout.write(
    json
      ? JSON.stringify({
          tag: target.tag,
          tarballUrl: target.tarballUrl,
          sourceSha: target.sourceSha,
          sourceSha256: target.sourceSha256,
        })
      : target.tarballUrl,
  );
}
