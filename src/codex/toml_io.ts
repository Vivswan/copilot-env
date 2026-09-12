// One discriminated read behind src/codex/config.ts's managed-config sites, so each site's error
// POLICY (throw, skip, seed a default) stays a small visible switch. "unparseable" is distinct so
// write paths can refuse to clobber a config that exists but could not be read: a hand-edit typo
// must never cost the user their config.toml.
import * as fs from "node:fs";
import { parse, stringify } from "smol-toml";
import { errMessage } from "../utils/error.ts";
import { isEnoent } from "../utils/fs.ts";
import { writeFileReported } from "../utils/report_write.ts";

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
 *  seed-a-default site (loadOrCreateConfig) treats it like a missing file. */
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

export function saveCodexToml(path: string, doc: Record<string, unknown>, detail?: string): void {
  writeFileReported(path, stringify(doc), { detail });
}
