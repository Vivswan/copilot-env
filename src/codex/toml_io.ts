// One discriminated read behind src/codex/config.ts's managed-config sites, so each site's error
// POLICY (throw, skip, seed a default) stays a small visible switch. "unparseable" is distinct so
// write paths can refuse to clobber a config that exists but could not be read: a hand-edit typo
// must never cost the user their config.toml.
import { parse, stringify } from "smol-toml";
import { errMessage } from "../utils/error.ts";
import { isEnoent } from "../utils/fs.ts";
import * as fs from "../utils/fs_facade.ts";
import { isRecord } from "../utils/json.ts";

export type CodexTomlRead =
  | { kind: "absent" }
  | { kind: "ok"; doc: Record<string, unknown> }
  | { kind: "unparseable"; error: string };

// Only TOML's own insignificant whitespace (spaces, tabs, LF/CRLF) counts as blank. NOT
// String.trim(): trim also eats a BOM, NBSP, or lone CR, all of which smol-toml REJECTS, and a
// rejected file must read as "unparseable" (refuse to clobber), never as "absent".
const BLANK_TOML = /^(?:[ \t\n]|\r\n)*$/;

/** ENOENT reads as "absent"; any other filesystem error (EISDIR, permission, I/O) THROWS raw, so a
 *  caller cannot mistake an unreadable config for a missing one. An empty or whitespace-only file
 *  also reads as "absent": a blank TOML document carries nothing worth preserving, and the
 *  seed-a-default site (loadOrCreateConfig) treats it like a missing file. Read through the
 *  facade, so a dry run's planned content answers in place of the disk. */
export function readCodexToml(path: string): CodexTomlRead {
  let text: string;
  try {
    text = fs.readText(path);
  } catch (e) {
    if (isEnoent(e)) return { kind: "absent" };
    throw e;
  }
  if (BLANK_TOML.test(text)) return { kind: "absent" };
  try {
    return { kind: "ok", doc: parse(text) as Record<string, unknown> };
  } catch (e) {
    // smol-toml quotes the offending source line in its message, which for a static-key config can
    // be the bearer itself; callers log this diagnostic.
    return {
      kind: "unparseable",
      error: errMessage(e).replace(/Bearer \S+/g, "Bearer <redacted>"),
    };
  }
}

/** The dotted leaf a static-key write bakes the bearer into, for `providerId`'s table. */
export function codexBearerLeaf(providerId: string): string {
  return `model_providers.${providerId}.http_headers.Authorization`;
}

/** Every `http_headers.Authorization` leaf of `doc`, dotted, wherever a table carries one: the
 *  managed provider tables, and a legacy `[profiles.<name>]` table a migration still moves. The
 *  header name is matched case-insensitively, as HTTP reads it (a user's own `authorization`
 *  spelling is a bearer too). A segment carrying a dot or a space is quoted, so a dotted key never
 *  reads as two levels. */
export function codexBearerLeaves(doc: Record<string, unknown>): string[] {
  const leaves: string[] = [];
  const quote = (s: string): string => (s.includes(".") || s.includes(" ") ? JSON.stringify(s) : s);
  const walk = (value: unknown, path: readonly string[]): void => {
    if (!isRecord(value) || value instanceof Date) return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "http_headers" && isRecord(child)) {
        for (const header of Object.keys(child)) {
          if (header.toLowerCase() === "authorization") {
            leaves.push([...path, key, header].map(quote).join("."));
          }
        }
      }
      walk(child, [...path, key]);
    }
  };
  walk(doc, []);
  return leaves;
}

/** Every write names the leaves a preview redacts: the bearers the written document carries, and
 *  those the file carries now (a table a migration renames leaves its old bearer as a row that
 *  goes). The non-secret rows print attribute by attribute; a bearer prints `<redacted>`. In
 *  place, as Codex itself writes it: a user's symlinked config.toml stays a link. */
export function saveCodexToml(path: string, doc: Record<string, unknown>, detail?: string): void {
  const current = readCodexToml(path);
  const secretKeys = new Set([
    ...codexBearerLeaves(doc),
    ...(current.kind === "ok" ? codexBearerLeaves(current.doc) : []),
  ]);
  fs.writeText(path, stringify(doc), { atomic: false, detail, secretKeys });
}
