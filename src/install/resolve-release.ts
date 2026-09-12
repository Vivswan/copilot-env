// The one source of "which release to install / update to". Discovery reads the GitHub Releases
// REST API (published, non-prerelease, vX.Y.Z only for floating installs); an explicit tag may
// resolve a prerelease because the user asked for it by name. Callers: `agent update` and the
// autoupdate preflight. install.sh / install.ps1 resolve `latest` themselves: they run before
// anything of ours is on disk.
const SECONDS_PER_DAY = 24 * 60 * 60;
// per_page=100 reads every release in one page (this repo will not exceed that for years), so
// cooldown selection sees the whole eligible set, not just the first 30.
const RELEASES_API = "https://api.github.com/repos/Vivswan/copilot-env/releases?per_page=100";

const GH = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2026-03-10",
  "User-Agent": "copilot-env",
} as const;

/** The tag picks the release and the running platform picks the asset within it
 *  (releaseAssetName, src/install/targets.ts), so nothing else from the API row is needed. */
export interface Release {
  tag: string;
  dateSeconds: number;
}

/** Newest-first; [] on anything unparseable. */
export function parseReleasesJson(jsonText: string, includePrereleases = false): Release[] {
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
    if (r.draft === true || (r.prerelease === true && !includePrereleases)) continue;
    if (typeof r.tag_name !== "string" || !/^v\d+\.\d+\.\d+$/.test(r.tag_name)) continue;
    const date = typeof r.published_at === "string" ? r.published_at : r.created_at;
    if (typeof date !== "string") continue;
    const dateSeconds = Math.floor(Date.parse(date) / 1000);
    if (Number.isFinite(dateSeconds)) {
      releases.push({ tag: r.tag_name, dateSeconds });
    }
  }
  // The API's order is not trusted; sort newest-first here.
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

// The releases endpoint occasionally 5xx's, rate-limits, or drops the connection; a few
// backed-off retries turn those into a resolve instead of a spurious "no release found". Tests
// set COPILOT_ENV_RELEASE_RETRY_BASE_MS=0 for speed.
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

/** The body text, or null after exhausting attempts. A non-retryable response (401/404) gives up
 *  immediately: retrying would not fix it. */
async function fetchReleasesText(
  url: string,
  headers: Record<string, string>,
): Promise<string | null> {
  const base = retryBaseMs();
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    let retryable = true;
    try {
      const res = await fetch(url, { headers });
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

/** Null when offline, the API errors, or no release is eligible. */
export async function resolveTarget(
  cooldownDays: number | null,
  exactTag: string | null = null,
): Promise<Release | null> {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = { ...GH };
  if (token) headers.Authorization = `Bearer ${token}`;
  const text = await fetchReleasesText(RELEASES_API, headers);
  if (text === null) return null; // offline / API errored after retries
  const releases = parseReleasesJson(text, exactTag !== null);
  if (releases.length === 0) return null;
  if (exactTag !== null) return pickTag(releases, exactTag);
  return cooldownDays === null
    ? pickLatest(releases)
    : pickAged(releases, Date.now() / 1000, cooldownDays);
}
