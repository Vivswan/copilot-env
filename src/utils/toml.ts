// The one importer of smol-toml: the one place copilot-env reads TOML text and says what a parsed
// table is, so what the repo accepts is its own decision, never whatever the parser's current
// release happens to do (1.8 rejected a leading BOM and gave tables Object.prototype; 1.9 skips
// the BOM and gives them a null prototype). test/utils/toml.test.ts keeps every other site out.
import { parse } from "smol-toml";
import { isRecord } from "./json.ts";

export { stringify } from "smol-toml";

/** Exactly one leading U+FEFF is an editor's encoding mark, not content, so it is dropped before
 *  the text is judged. Everything after it, an NBSP or a lone CR included, is the parser's to judge. */
const LEADING_BOM = /^\ufeff/;

export function parseToml(text: string): Record<string, unknown> {
  return parse(text.replace(LEADING_BOM, ""));
}

/** A table is any object the parser built for one, whatever prototype it chose. The datetime scalar
 *  is the one object that is not a table: a Date subclass with no enumerable keys, so recursing into
 *  it spreads it to an empty table, and a key written onto it is gone once it prints as the datetime
 *  again. */
export function isTomlTable(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && !(value instanceof Date);
}
