// Version-ordering helpers shared by the proxy float, the `start` floor check, and
// the update/migration machinery. Backed by the `semver` package for correct
// precedence (prerelease identifiers, build metadata) with tolerant parsing so a
// ragged (`1.2`) or `v`-prefixed input never throws.
import * as semver from "semver";

/**
 * Parse to a comparable SemVer, tolerating a leading `v`, prerelease/build, and
 * partial cores (`1.2` → `1.2.0`). `parse` keeps prerelease identifiers; `coerce`
 * is the fallback for partial inputs. Returns null only for un-version-like text.
 */
function toSemver(v: string): semver.SemVer | null {
  return semver.parse(v.trim(), { loose: true }) ?? semver.coerce(v);
}

/**
 * True if version `a` is lower than `b` (e.g. 1.10.13 < 1.10.30), by SemVer
 * precedence: numeric cores compared field by field, a prerelease ranks below its
 * plain release, build metadata is ignored. Un-parseable input is treated as not
 * less-than (no throw) — in practice only well-formed `x.y.z` values reach here.
 */
export function versionLessThan(a: string, b: string): boolean {
  const sa = toSemver(a);
  const sb = toSemver(b);
  if (sa === null || sb === null) return false;
  return semver.lt(sa, sb);
}

/** Drop a leading `v` from a tag/version (e.g. `v1.2.3` -> `1.2.3`). */
export function stripV(v: string): string {
  return v.replace(/^v/, "");
}

/**
 * True when `current` is at or beyond `target` — i.e. no update is needed.
 * Tolerates a leading `v` on either side. Names the `!versionLessThan(stripV…)`
 * idiom shared by `agent update` and the autoupdate preflight.
 */
export function isUpToDate(current: string, target: string): boolean {
  return !versionLessThan(stripV(current), stripV(target));
}
