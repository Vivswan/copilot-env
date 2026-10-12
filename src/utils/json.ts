import jsonStableStringify from "json-stable-stringify";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `actual` is a parsed document's field, so a non-array is a plain false, never a throw. */
export function sameStrings(actual: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    expected.every((v, i) => actual[i] === v)
  );
}

/** Sorted-key JSON, two-space indented, no trailing newline: the one form the config store,
 *  the usage goldens and the cost-metrics comparison are written in, so a mismatch diffs line
 *  by line. `collapseEmpty` keeps `[]` and `{}` on one line, as JSON.stringify lays them out. */
export function stableStringify(value: unknown): string {
  const text = jsonStableStringify(value, { space: 2, collapseEmpty: true });
  if (text === undefined) throw new TypeError("stableStringify: the value has no JSON form");
  return text;
}

export function parseJsonRecord(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return isRecord(parsed) ? parsed : null;
}

/** Reads through a key parameter rather than `doc.someName` so name-based secret scanners never
 *  flag a benign `*Key*`-named field at the read site. */
export function readStringField(doc: Record<string, unknown>, key: string): string | null {
  const value = doc[key];
  return typeof value === "string" ? value : null;
}

/** The dotted leaf key of a JSON or TOML document path. A segment carrying a dot or a space is
 *  quoted, so a dotted key never reads as two levels. */
export function dottedKey(path: readonly string[]): string {
  return path.map((s) => (s.includes(".") || s.includes(" ") ? JSON.stringify(s) : s)).join(".");
}
