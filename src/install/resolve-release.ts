// The one source of "which GitHub release to install / update to", read from the Releases REST
// API: copilot-env's own releases for `agent update` and the autoupdate preflight, and the agent
// CLI vendors' for `agent shell --clis --cooldown`. install.sh / install.ps1 resolve `latest`
// themselves: they run before anything of ours is on disk.
//
// The lookup is anonymous on purpose: the stored credential exists to reach Copilot, and a token
// exported in the shell may belong to another account. The anonymous limit (60/hour/IP) covers a
// lookup that runs once per `--check`, per autoupdate cooldown, or per CLI install.
import { retry } from "@std/async";
import type { ProbeFetch } from "../copilot_api/integration_identity.ts";
import { SECONDS_PER_DAY } from "../utils/time.ts";
import { COPILOT_ENV_USER_AGENT } from "../utils/user_agent.ts";

/** A repository whose releases are read. `repo` is `owner/name`; `tagPattern` admits its stable
 *  tags alone (a vendor marks prereleases, but a tag shape such as `rust-vX.Y.Z-alpha.N` is
 *  dropped here too). */
export interface ReleaseRepo {
  repo: string;
  tagPattern: RegExp;
}

/** copilot-env's own releases, for `agent update` and the autoupdate preflight. */
const COPILOT_ENV_RELEASES: ReleaseRepo = {
  repo: "Vivswan/copilot-env",
  tagPattern: /^v\d+\.\d+\.\d+$/,
};

/** The API's page ceiling, newest first. */
const PER_PAGE = 100;

/** An aged pick's page budget; daily vendor prereleases push a week-old stable past page one. */
const MAX_PAGES = 5;

/** How far back an aged pick looks, for the message that says nothing was old enough. */
export const AGED_RELEASE_HORIZON = PER_PAGE * MAX_PAGES;

function releasesApi(repo: string, page: number): string {
  return `https://api.github.com/repos/${repo}/releases?per_page=${PER_PAGE}&page=${page}`;
}

const GH = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2026-03-10",
  "User-Agent": COPILOT_ENV_USER_AGENT,
} as const;

/** The tag picks the release and the running platform picks the asset within it
 *  (releaseAssetName, src/utils/targets.ts), so nothing else from the API row is needed. */
export interface Release {
  tag: string;
  dateSeconds: number;
}

/** One API page: its stable releases newest-first, and the rows it held before the stable filter
 *  (fewer than PER_PAGE: the last page). */
export interface ReleasePage {
  releases: Release[];
  rows: number;
}

/** Unparseable text, or an API error object, reads as an empty last page. */
export function parseReleasesJson(
  jsonText: string,
  tagPattern: RegExp = COPILOT_ENV_RELEASES.tagPattern,
): ReleasePage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { releases: [], rows: 0 };
  }
  if (!Array.isArray(parsed)) return { releases: [], rows: 0 };

  const releases: Release[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (r.draft === true || r.prerelease === true) continue;
    if (typeof r.tag_name !== "string" || !tagPattern.test(r.tag_name)) continue;
    const date = typeof r.published_at === "string" ? r.published_at : r.created_at;
    if (typeof date !== "string") continue;
    const dateSeconds = Math.floor(Date.parse(date) / 1000);
    if (Number.isFinite(dateSeconds)) {
      releases.push({ tag: r.tag_name, dateSeconds });
    }
  }
  // The API's order is not trusted; sort newest-first here.
  releases.sort((a, b) => b.dateSeconds - a.dateSeconds);
  return { releases, rows: parsed.length };
}

export function pickAged(releases: Release[], nowSeconds: number, days: number): Release | null {
  const cutoff = nowSeconds - days * SECONDS_PER_DAY;
  return releases.find((r) => r.dateSeconds <= cutoff) ?? null; // newest-first
}

// The endpoint occasionally 5xx's, rate-limits, or drops; a few backed-off retries resolve those.
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

// Three backoffs doubling from RETRY_BASE_MS before the fault reads as "no release found".
const MAX_FETCH_ATTEMPTS = 4;

// The first backoff (doubled, jittered); ResolveOptions.retryBaseMs overrides it, tests with 0.
const RETRY_BASE_MS = 400;

export interface ResolveOptions {
  fetchImpl?: ProbeFetch;
  retryBaseMs?: number;
}

/** A non-retryable response (401/404) gives up immediately: retrying would not fix it; a retryable
 *  one is retried with backoff, so a transient fault resolves instead of reading as a spurious "no
 *  release found". */
async function fetchReleasesText(
  url: string,
  fetchImpl: ProbeFetch,
  base: number,
): Promise<string | null> {
  // A non-retryable status returns null from the callback: to `retry` that is a success, so it
  // comes straight back after one attempt. The old loop had no ceiling on the backoff, so none
  // here either: the library's default of 60s would refuse any `retryBaseMs` above it.
  try {
    return await retry(
      async () => {
        const res = await fetchImpl(url, { headers: GH });
        if (res.ok) return await res.text();
        if (RETRYABLE_STATUSES.has(res.status)) throw new Error(`GitHub API ${res.status}`);
        return null;
      },
      {
        maxAttempts: MAX_FETCH_ATTEMPTS,
        minTimeout: base,
        maxTimeout: Number.POSITIVE_INFINITY,
        multiplier: 2,
        jitter: 1,
      },
    );
  } catch {
    return null; // a thrown fetch (network / DNS / connection reset) or the attempts ran out
  }
}

async function fetchReleasePage(
  source: ReleaseRepo,
  page: number,
  opts: ResolveOptions,
): Promise<ReleasePage | null> {
  const text = await fetchReleasesText(
    releasesApi(source.repo, page),
    opts.fetchImpl ?? fetch,
    opts.retryBaseMs ?? RETRY_BASE_MS,
  );
  return text === null ? null : parseReleasesJson(text, source.tagPattern);
}

async function resolveLatest(
  source: ReleaseRepo,
  opts: ResolveOptions = {},
): Promise<Release | null> {
  const page = await fetchReleasePage(source, 1, opts);
  return page?.releases[0] ?? null;
}

export type AgedRelease =
  | { kind: "release"; release: Release }
  /** Nothing within AGED_RELEASE_HORIZON was old enough; `oldest` is the oldest stable release the
   *  pages held, null when they held none. */
  | { kind: "none"; oldest: Release | null }
  /** A page could not be read (offline, or the API refused after the retries). */
  | { kind: "unread" };

export async function resolveAged(
  source: ReleaseRepo,
  days: number,
  opts: ResolveOptions = {},
): Promise<AgedRelease> {
  const now = Date.now() / 1000;
  let oldest: Release | null = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const read = await fetchReleasePage(source, page, opts);
    if (read === null) return { kind: "unread" };

    const pick = pickAged(read.releases, now, days);
    if (pick !== null) return { kind: "release", release: pick };
    oldest = read.releases.at(-1) ?? oldest;
    if (read.rows < PER_PAGE) break;
  }
  return { kind: "none", oldest };
}

/** copilot-env's own next release, for `agent update` and the autoupdate preflight: the newest,
 *  or with a cooldown the newest at least that old, else the oldest known, so a repository whose
 *  every release is fresh still updates. Null when the lookup failed or found no release. */
export async function resolveTarget(
  cooldownDays: number | null,
  opts: ResolveOptions = {},
): Promise<Release | null> {
  if (cooldownDays === null) return await resolveLatest(COPILOT_ENV_RELEASES, opts);
  const aged = await resolveAged(COPILOT_ENV_RELEASES, cooldownDays, opts);
  switch (aged.kind) {
    case "release":
      return aged.release;
    case "none":
      return aged.oldest;
    case "unread":
      return null;
  }
}
