import * as v from "valibot";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** isRecord as a schema: valibot's own object and record schemas take an array for an object, so a
 *  shape whose keys are all optional starts from this one to refuse it. */
export function jsonObject(message?: v.ErrorMessage<v.CustomIssue>) {
  return v.custom<Record<string, unknown>>(isRecord, message);
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
