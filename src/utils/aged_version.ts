// Utility for picking the newest stable npm release older than a minimum-age window.
import { versionLessThan } from "./semver.ts";

const STABLE = /^\d+\.\d+\.\d+$/; // plain x.y.z -- excludes prereleases + created/modified

// Pure + deterministic (now is injected, not read from the clock) so it is
// directly unit-testable. Returns the newest qualifying version, or null.
export function pickAgedVersion(
  timeMap: Record<string, string>,
  minimumAgeMs: number,
  nowMs: number,
): string | null {
  const cutoff = nowMs - minimumAgeMs;
  let best: string | null = null;
  for (const [version, iso] of Object.entries(timeMap)) {
    if (!STABLE.test(version)) continue;
    const published = Date.parse(iso);
    if (Number.isNaN(published) || published > cutoff) continue;
    // Only STABLE x.y.z values reach here, so versionLessThan compares numeric
    // cores; first-seen wins on a tie (kept, matching the previous behavior).
    if (best === null || versionLessThan(best, version)) best = version;
  }
  return best;
}
