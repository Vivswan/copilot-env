// The shared config.toml reader/writer behind src/codex/config.ts's managed-config
// sites. Each of those load sites used to hand-roll fs.readFileSync + smol-toml parse
// with its own try/catch; this module parses ONCE and returns a discriminated result,
// so each call site's error POLICY (throw, skip, seed a default) stays a small visible
// switch instead of a bespoke catch block. "unparseable" is a distinct variant
// precisely so write paths can refuse to clobber a config that exists but could not
// be read -- a hand-edit typo must never cost the user their config.toml.
// (Deliberately NOT yet adopted by cleanupCodexCatalogArtifacts -- its one try spans
// the write too -- nor by mobile.ts, which keeps its own policy.)
import * as fs from "node:fs";
import { parse, stringify } from "smol-toml";
import { errMessage } from "../utils/error.ts";
import { isEnoent } from "../utils/fs.ts";

export type CodexTomlRead =
  | { kind: "absent" }
  | { kind: "ok"; doc: Record<string, unknown> }
  | { kind: "unparseable"; error: string };

// Only TOML's own insignificant whitespace counts as a blank document -- exactly
// the content an empty file parses to anyway: spaces, tabs, and LF/CRLF newlines.
// Deliberately NOT String.trim(): trim also eats a BOM/NBSP/lone CR, all of which
// smol-toml REJECTS, and a rejected file must read as "unparseable" (refuse to
// clobber), never as "absent".
const BLANK_TOML = /^(?:[ \t\n]|\r\n)*$/;

/**
 * Read and parse the TOML file at `path`. ENOENT reads as "absent"; any other
 * filesystem error (EISDIR, permission, I/O) THROWS raw -- callers must fail
 * loudly rather than mistake an unreadable config for a missing one. A file that
 * exists but is not valid TOML reads as "unparseable" with the parser's message.
 *
 * An empty or whitespace-only file also reads as "absent": a blank TOML document
 * carries nothing worth preserving, and the seed-a-default call site
 * (loadOrCreateConfig) has always treated it like a missing file.
 */
export function readCodexToml(path: string): CodexTomlRead {
  let text: string;
  try {
    text = fs.readFileSync(path, "utf8");
  } catch (e) {
    if (isEnoent(e)) return { kind: "absent" };
    throw e;
  }
  if (BLANK_TOML.test(text)) return { kind: "absent" };
  try {
    return { kind: "ok", doc: parse(text) as Record<string, unknown> };
  } catch (e) {
    return { kind: "unparseable", error: errMessage(e) };
  }
}

/** Serialize `doc` with smol-toml and write it to `path` (the exact
 *  stringify-then-writeFileSync every save site already performed). */
export function saveCodexToml(path: string, doc: Record<string, unknown>): void {
  fs.writeFileSync(path, stringify(doc));
}
