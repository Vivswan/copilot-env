// Version-ordering helpers shared by the proxy float, the `start` floor check, and
// the update/migration machinery. Backed by @std/semver for correct precedence
// (prerelease identifiers, build metadata) with tolerant parsing so a ragged
// (`1.2`) or `v`-prefixed input never throws.
import { lessThan, type SemVer, tryParse } from "semver";

/**
 * Parse to a comparable SemVer, tolerating a leading `v`, prerelease/build, and
 * partial cores (`1.2` -> `1.2.0`). tryParse itself takes the `v` prefix and
 * surrounding whitespace; a partial core is padded to a full x.y.0 first,
 * because tryParse alone rejects it. Returns null only for un-version-like text.
 */
function toSemver(v: string): SemVer | null {
  let text = v.trim();
  const partial = /^v?(\d+)(?:\.(\d+))?$/.exec(text);
  if (partial !== null) text = `${partial[1]}.${partial[2] ?? "0"}.0`;
  return tryParse(text) ?? null;
}

/**
 * True if version `a` is lower than `b` (e.g. 1.10.13 < 1.10.30), by SemVer
 * precedence: numeric cores compared field by field, a prerelease ranks below its
 * plain release, build metadata is ignored. Un-parseable input is treated as not
 * less-than (no throw) -- in practice only well-formed `x.y.z` values reach here.
 */
export function versionLessThan(a: string, b: string): boolean {
  const sa = toSemver(a);
  const sb = toSemver(b);
  if (sa === null || sb === null) return false;
  return lessThan(sa, sb);
}

/** Drop a leading `v` from a tag/version (e.g. `v1.2.3` -> `1.2.3`). */
export function stripV(v: string): string {
  return v.replace(/^v/, "");
}

/**
 * True when `current` is at or beyond `target` -- i.e. no update is needed.
 * Tolerates a leading `v` on either side. Names the `!versionLessThan(stripV...)`
 * idiom shared by `agent update` and the autoupdate preflight.
 */
export function isUpToDate(current: string, target: string): boolean {
  return !versionLessThan(stripV(current), stripV(target));
}
