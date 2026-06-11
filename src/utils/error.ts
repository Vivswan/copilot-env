// Shared error helpers.

/** The human-readable message for any thrown value (Error.message, else String). */
export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
