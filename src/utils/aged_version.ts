// Utility for picking the newest stable npm release older than a minimum-age window.

const STABLE = /^\d+\.\d+\.\d+$/; // plain x.y.z -- excludes prereleases + created/modified

// Pure + deterministic (now is injected, not read from the clock) so it is
// directly unit-testable. Returns the newest qualifying version, or null.
export function pickAgedVersion(
  timeMap: Record<string, string>,
  minimumAgeMs: number,
  nowMs: number,
): string | null {
  const cutoff = nowMs - minimumAgeMs;
  let best: [number, number, number] | null = null;
  for (const [version, iso] of Object.entries(timeMap)) {
    if (!STABLE.test(version)) continue;
    const published = Date.parse(iso);
    if (Number.isNaN(published) || published > cutoff) continue;
    const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
    const parts: [number, number, number] = [major, minor, patch];
    if (best === null || compareCore(parts, best) > 0) best = parts;
  }
  return best === null ? null : best.join(".");
}

// Numeric (not lexical) compare so 1.2.10 > 1.2.9 and 1.10.0 > 1.9.9.
function compareCore(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}
