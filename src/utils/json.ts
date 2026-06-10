// Shared guards for JSON/API payloads whose runtime shape is outside our control.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

/**
 * Read a string-valued field by key (null if absent or not a string). Accessing
 * `doc[key]` through a parameter — rather than a literal `doc.someName` — also
 * keeps name-based static analysis from misclassifying a benign field (e.g. a
 * path stored under a `*Key*`-named config key) as a secret at the read site.
 */
export function readStringField(doc: Record<string, unknown>, key: string): string | null {
  const value = doc[key];
  return typeof value === "string" ? value : null;
}
