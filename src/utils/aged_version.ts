// timeMap is the npm packument's `time` object: version -> publish date, plus the created/modified
// keys.
import { versionLessThan } from "./semver.ts";

const STABLE = /^\d+\.\d+\.\d+$/; // excludes prereleases and the created/modified keys

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
    if (best === null || versionLessThan(best, version)) best = version;
  }
  return best;
}
