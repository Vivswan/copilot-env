// The one source of "which release to install / update to", read from the GitHub Releases REST
// API. install.sh / install.ps1 resolve `latest` themselves: they run before anything of ours is
// on disk.
//
// The lookup is anonymous on purpose: the stored credential exists to reach Copilot, and a token
// exported in the shell may belong to another account. The anonymous limit (60/hour/IP) covers a
// lookup that runs once per `--check` or per autoupdate cooldown.
import { retry } from "@std/async";
import { SECONDS_PER_DAY } from "../utils/time.ts";
import { COPILOT_ENV_USER_AGENT } from "../utils/user_agent.ts";

// per_page=100 reads every release in one page (this repo will not exceed that for years), so
// cooldown selection sees the whole eligible set, not just the first 30.
const RELEASES_API = "https://api.github.com/repos/Vivswan/copilot-env/releases?per_page=100";

const GH = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2026-03-10",
  "User-Agent": COPILOT_ENV_USER_AGENT,
} as const;

/** The tag picks the release and the running platform picks the asset within it
 *  (releaseAssetName, src/install/targets.ts), so nothing else from the API row is needed. */
export interface Release {
  tag: string;
  dateSeconds: number;
}

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

export function pickAged(releases: Release[], nowSeconds: number, days: number): Release | null {
  const cutoff = nowSeconds - days * SECONDS_PER_DAY;
  let oldest: Release | null = null;
  for (const r of releases) {
    oldest = r; // newest-first, so the last seen is the oldest
    if (r.dateSeconds <= cutoff) return r;
  }
  return oldest;
}

// The releases endpoint occasionally 5xx's, rate-limits, or drops the connection; a few
// backed-off retries turn those into a resolve instead of a spurious "no release found".
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_FETCH_ATTEMPTS = 4;
const RETRY_BASE_MS = 400;

export interface ResolveOptions {
  fetchImpl?: typeof fetch;
  retryBaseMs?: number;
}

/** A non-retryable response (401/404) gives up immediately: retrying would not fix it. */
async function fetchReleasesText(
  url: string,
  fetchImpl: typeof fetch,
  base: number,
): Promise<string | null> {
  // A non-retryable status returns null from the callback: to `retry` that is a success, so it
  // comes straight back after one attempt. The old loop had no ceiling on the backoff, so none
  // here either: the library's default of 60s would refuse any `retryBaseMs` above it.
  try {
    return await retry(async () => {
      const res = await fetchImpl(url, { headers: GH });
      if (res.ok) return await res.text();
      if (RETRYABLE_STATUSES.has(res.status)) throw new Error(`GitHub API ${res.status}`);
      return null;
    }, {
      maxAttempts: MAX_FETCH_ATTEMPTS,
      minTimeout: base,
      maxTimeout: Number.POSITIVE_INFINITY,
      multiplier: 2,
      jitter: 1,
    });
  } catch {
    return null; // a thrown fetch (network / DNS / connection reset) or the attempts ran out
  }
}

export async function resolveTarget(
  cooldownDays: number | null,
  opts: ResolveOptions = {},
): Promise<Release | null> {
  const text = await fetchReleasesText(
    RELEASES_API,
    opts.fetchImpl ?? fetch,
    opts.retryBaseMs ?? RETRY_BASE_MS,
  );
  if (text === null) return null; // offline / API errored after retries
  const releases = parseReleasesJson(text);
  if (releases.length === 0) return null;
  return cooldownDays === null
    ? releases[0] ?? null
    : pickAged(releases, Date.now() / 1000, cooldownDays);
}
