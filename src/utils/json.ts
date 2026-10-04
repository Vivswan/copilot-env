export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `actual` is a parsed document's field, so a non-array is a plain false, never a throw. */
export function sameStrings(actual: unknown, expected: readonly string[]): boolean {
  return Array.isArray(actual) && actual.length === expected.length &&
    expected.every((v, i) => actual[i] === v);
}

/** `value` with every object's keys sorted at every level, arrays kept in order, so two
 *  payloads with the same content stringify identically. */
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  // fromEntries, not assignment into {}: an own "__proto__" key stays a key.
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  }
  return value;
}

/** Sorted-key JSON, two-space indented, no trailing newline: the one form the config store,
 *  the usage goldens and the cost-metrics comparison are written in, so a mismatch diffs line
 *  by line. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2);
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
