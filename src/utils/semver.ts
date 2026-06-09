// Minimal dotted-numeric version comparison shared by the gateway float and the
// `start` floor check. Not a full semver implementation — the gateway ships plain
// `x.y.z` releases and we only need floor/ceiling ordering tests.

/**
 * True if dotted-numeric version `a` is lower than `b` (e.g. 1.10.13 < 1.10.30).
 * Compares numeric cores segment by segment; on equal cores, a prerelease
 * (`x.y.z-...`) ranks below the plain release (build metadata after `+` is
 * ignored, per semver). Not a full prerelease-identifier ordering — sufficient
 * because the gateway ships plain releases and we only need floor/ceiling tests.
 */
export function versionLessThan(a: string, b: string): boolean {
  const core = (v: string): number[] =>
    (v.split(/[-+]/)[0] ?? v).split(".").map((n) => Number.parseInt(n, 10) || 0);
  const isPrerelease = (v: string): boolean => (v.split("+")[0] ?? v).includes("-");
  const pa = core(a);
  const pb = core(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da < db;
  }
  // Equal numeric cores: a prerelease ranks below a plain release.
  const preA = isPrerelease(a);
  const preB = isPrerelease(b);
  if (preA !== preB) return preA;
  return false;
}

/** Drop a leading `v` from a tag/version (e.g. `v1.2.3` -> `1.2.3`). */
export function stripV(v: string): string {
  return v.replace(/^v/, "");
}
