// One discriminated read behind src/codex/config.ts's managed-config sites, so each site's error
// POLICY (throw, skip, seed a default) stays a small visible switch. "unparseable" is distinct so
// write paths can refuse to clobber a config that exists but could not be read: a hand-edit typo
// must never cost the user their config.toml.
import { parse, stringify } from "smol-toml";
import { errMessage } from "../utils/error.ts";
import { isEnoent } from "../utils/fs.ts";
import * as fs from "../utils/fs_facade.ts";

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

/** The dotted leaf a static-key write bakes the bearer into, for `providerId`'s table: the one
 *  Codex value a preview must redact. */
export function codexBearerLeaf(providerId: string): string {
  return `model_providers.${providerId}.http_headers.Authorization`;
}

/**
 * The managed writers name the leaves a preview redacts (`secretKeys`, the bearer of the table
 * they write) and their write prints attribute by attribute. A whole-document rewrite that names
 * none (a removal, a migration) is printed path-only: a Codex config can carry a baked bearer in
 * any table.
 */
export function saveCodexToml(
  path: string,
  doc: Record<string, unknown>,
  detail?: string,
  secretKeys?: Iterable<string>,
): void {
  // In place, as Codex itself writes it: a user's symlinked config.toml stays a link.
  const text = stringify(doc);
  if (secretKeys === undefined) fs.writeText(path, text, { atomic: false, detail, secret: true });
  else fs.writeText(path, text, { atomic: false, detail, secretKeys });
}
