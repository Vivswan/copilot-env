// Tolerant on purpose: a ragged (`1.2`) or `v`-prefixed input never throws.
import { format, lessThan, type SemVer, tryParse } from "semver";

/** A compile-time tripwire, not a proof of parseability: a literal `x.y.z` assigns structurally, an
 *  arbitrary runtime string must pass through `toSemverString` first, and boundaries still parse.
 */
export type SemverString =
  | `${number}.${number}.${number}`
  | `${number}.${number}.${number}-${string}`
  | `${number}.${number}.${number}+${string}`;

/** `v1.10` -> `1.10.0`. Null rather than a throw, so each boundary can name its own offender. */
export function toSemverString(v: string): SemverString | null {
  const parsed = toSemver(v);
  return parsed === null ? null : format(parsed) as SemverString;
}

/** tryParse takes the `v` prefix and whitespace itself but rejects a partial core, so `1.2` is
 *  padded first. */
function toSemver(v: string): SemVer | null {
  let text = v.trim();
  const partial = /^v?(\d+)(?:\.(\d+))?$/.exec(text);
  if (partial !== null) text = `${partial[1]}.${partial[2] ?? "0"}.0`;
  return tryParse(text) ?? null;
}

/** Un-parseable input reads as not less-than rather than throwing. */
export function versionLessThan(a: string, b: string): boolean {
  const sa = toSemver(a);
  const sb = toSemver(b);
  if (sa === null || sb === null) return false;
  return lessThan(sa, sb);
}

export function stripV(v: string): string {
  return v.replace(/^v/, "");
}

export function isUpToDate(current: string, target: string): boolean {
  return !versionLessThan(stripV(current), stripV(target));
}
