// What a dry run prints: the overlay diffed against the disk, path by path in first-touch order,
// and for a JSON or TOML file the leaves that differ, keyed by dotted path. The verdict is a tree
// diff, never a record of the operations: a file rewritten with its own bytes is `same`, a path
// created and deleted within the run is nothing, and a tree removed is one `delete` row (as the real
// run's one `deleted ->` line), unless the run made the directory again, when the disk's children
// it no longer lists are named. A disk file the run carried by path (a rename, a chmod, a copy), a
// planned link, and a file declared secret as a whole print their verdict alone: no bytes of theirs
// were decoded, or none may print.
import { lstatSync, readdirSync, readFileSync, readlinkSync, type Stats, statSync } from "node:fs";
import { extname, join, sep } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { FileContent, Overlay, OverlayEntry } from "./fs_overlay.ts";
import { isRecord, parseJsonRecord } from "./json.ts";

export type FileVerdict = "create" | "rewrite" | "same" | "delete";

export type AttributeStatus = "set" | "change" | "same" | "remove";

/** One leaf of one file. `current` and `next` are the values as the file holds them (undefined =
 *  absent); a `secret` value never prints. */
export interface AttributeRow {
  key: string;
  status: AttributeStatus;
  current: unknown;
  next: unknown;
  secret: boolean;
}

export interface FileChange {
  path: string;
  verdict: FileVerdict;
  directory: boolean;
  attributes: AttributeRow[];
  /** A planned file's text against the disk's (null: absent), for the line diff a file without
   *  attribute rows prints. */
  text?: { before: string | null; after: string };
}

type Doc = Record<string, unknown>;

function diskStat(key: string, follow: boolean): Stats | null {
  try {
    return follow ? statSync(key) : lstatSync(key);
  } catch {
    return null;
  }
}

/** A delete is judged by lstat (the link itself goes); a planned file or directory by stat, and a
 *  link at its path is replaced by the plain entry, which is a rewrite whatever the bytes; a
 *  planned link by lstat, against the disk link's target. */
export function diffOverlay(overlay: Overlay): FileChange[] {
  const changes: FileChange[] = [];
  for (const [key, entry] of overlay.entries) {
    if (overlay.isHidden(key)) continue;
    const name = overlay.nameOf(key);
    const raw = diskStat(key, false);
    if (entry.kind === "gone") {
      if (raw !== null) changes.push(change(name, "delete", raw.isDirectory()));
      continue;
    }
    if (entry.kind === "link") {
      changes.push(change(name, linkVerdict(key, entry.target, raw), false));
      continue;
    }
    const link = raw?.isSymbolicLink() ?? false;
    const disk = link ? diskStat(key, true) : raw;
    changes.push(
      entryChange(
        key,
        name,
        entry,
        disk,
        link,
        overlay.secretKeysOf(key),
        overlay.isSecretFile(key),
      ),
    );
    // The children a fresh directory no longer lists went with the tree.
    if (entry.kind === "dir" && entry.fresh && disk?.isDirectory()) {
      for (const child of readdirSync(key).sort()) {
        if (overlay.entries.has(join(key, child))) continue;
        const gone = diskStat(join(key, child), false);
        changes.push(change(join(name, child), "delete", gone?.isDirectory() ?? false));
      }
    }
  }
  return changes;
}

/** A link is the same only as a disk link with the same target text; anything else there is
 *  replaced. */
function linkVerdict(key: string, target: string, disk: Stats | null): FileVerdict {
  if (disk === null) return "create";
  if (!disk.isSymbolicLink()) return "rewrite";
  try {
    return readlinkSync(key) === target ? "same" : "rewrite";
  } catch {
    return "rewrite";
  }
}

function change(path: string, verdict: FileVerdict, directory: boolean): FileChange {
  return { path, verdict, directory, attributes: [] };
}

/** Whether the bytes the run leaves at `key` differ from the disk's there. */
function bytesDiffer(key: string, content: FileContent, before: string | null): boolean {
  if ("text" in content) return before !== content.text;
  if ("bytes" in content) return !readFileSync(key).equals(content.bytes);
  if (content.disk === key) return false;
  return !readFileSync(key).equals(readFileSync(content.disk));
}

/** A disk entry of the other kind (a file where a directory is planned, or the reverse) is a
 *  rewrite whose rows read as a create's: nothing of the old inode carries over. A mode-only
 *  change is a rewrite with no row, as a helper's executable-bit repair prints. A file declared
 *  secret as a whole has no rows and no text: nothing of it may print. */
function entryChange(
  key: string,
  name: string,
  entry: Exclude<OverlayEntry, { kind: "gone" | "link" }>,
  disk: Stats | null,
  replacesLink: boolean,
  secretKeys: ReadonlySet<string>,
  secretFile: boolean,
): FileChange {
  const directory = entry.kind === "dir";
  const sameKind = disk !== null && disk.isDirectory() === directory;
  const planned = entry.kind === "file" && "text" in entry.content ? entry.content.text : null;
  const before = sameKind && planned !== null ? readFileSync(key, "utf8") : null;
  const rows = planned === null || secretFile ? [] : docRows(key, before, planned, secretKeys);
  const differs = !sameKind || replacesLink ||
    (entry.kind === "file" && bytesDiffer(key, entry.content, before)) ||
    (disk !== null && (disk.mode & 0o777) !== entry.mode);
  const verdict: FileVerdict = disk === null && !replacesLink
    ? "create"
    : differs
    ? "rewrite"
    : "same";
  // A line diff cannot redact a value inside a line, so a file with a declared secret prints its
  // verdict alone when it has no leaf rows.
  const text = planned !== null && rows.length === 0 && secretKeys.size === 0 && !secretFile
    ? { before, after: planned }
    : undefined;
  return { path: name, verdict, directory, attributes: rows, ...(text ? { text } : {}) };
}

/** A blank file is the empty document, as the store and settings readers read it. */
function parseDoc(path: string, text: string | null): Doc | null {
  if (text === null || text.trim() === "") return {};
  const ext = extname(path).toLowerCase();
  if (ext === ".json") return parseJsonRecord(text);
  if (ext !== ".toml") return null;
  try {
    return parseToml(text);
  } catch {
    return null;
  }
}

/** A segment carrying a dot or a space is quoted, so a dotted key never reads as two levels. */
function dottedKey(path: readonly string[]): string {
  return path.map((s) => (s.includes(".") || s.includes(" ") ? JSON.stringify(s) : s)).join(".");
}

/** A Date is a leaf: smol-toml parses a TOML datetime into one. An empty table is no leaf of its
 *  own (a map emptied slot by slot prints only its slots); `empties` collects them for the one
 *  case they print (emptyLeaves). */
function leaves(
  value: unknown,
  prefix: readonly string[],
  out: Map<string, unknown>,
  empties: Set<string>,
): void {
  if (!isRecord(value) || value instanceof Date) {
    if (prefix.length > 0) out.set(dottedKey(prefix), value);
    return;
  }
  if (prefix.length > 0 && Object.keys(value).length === 0) empties.add(dottedKey(prefix));
  for (const [k, v] of Object.entries(value)) leaves(v, [...prefix, k], out, empties);
}

/** An empty table the run DROPS stands as a leaf (`{} -> (absent)`) when the other side has nothing
 *  at or under its key; one gained or kept is no row, and a map emptied slot by slot prints only
 *  its slots. */
function emptyLeaves(
  empties: ReadonlySet<string>,
  own: Map<string, unknown>,
  other: ReadonlyMap<string, unknown>,
): void {
  for (const key of empties) {
    if (other.has(key)) continue;
    let below = false;
    for (const k of other.keys()) if (k.startsWith(`${key}.`)) below = true;
    if (!below) own.set(key, {});
  }
}

/** A TOML datetime and its ISO string serialize alike, yet the file changes shape. */
function sameValue(a: unknown, b: unknown): boolean {
  return (a instanceof Date) === (b instanceof Date) && JSON.stringify(a) === JSON.stringify(b);
}

/** The leaf rows of a JSON or TOML file, every leaf of either side; no rows when either side does
 *  not parse (the verdict alone is what can be said) or the file is neither format. */
function docRows(
  path: string,
  beforeText: string | null,
  afterText: string,
  secretKeys: ReadonlySet<string>,
): AttributeRow[] {
  const beforeDoc = parseDoc(path, beforeText);
  const afterDoc = parseDoc(path, afterText);
  if (beforeDoc === null || afterDoc === null) return [];
  const before = new Map<string, unknown>();
  const after = new Map<string, unknown>();
  const beforeEmpties = new Set<string>();
  const afterEmpties = new Set<string>();
  leaves(beforeDoc, [], before, beforeEmpties);
  leaves(afterDoc, [], after, afterEmpties);
  // A dropped empty table is a row for TOML, where the writers' rows printed one; the JSON store
  // never printed a container; one kept on both sides is neither.
  for (const key of afterEmpties) beforeEmpties.delete(key);
  if (extname(path).toLowerCase() === ".toml") emptyLeaves(beforeEmpties, before, after);
  const rows: AttributeRow[] = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const status: AttributeStatus = !before.has(key)
      ? "set"
      : !after.has(key)
      ? "remove"
      : sameValue(before.get(key), after.get(key))
      ? "same"
      : "change";
    rows.push({
      key,
      status,
      current: before.get(key),
      next: after.get(key),
      secret: secretKeys.has(key),
    });
  }
  return rows;
}

// --- the print ------------------------------------------------------------------------------

/** JSON, so a string is told from a number or a boolean; an absent leaf reads `(absent)`, and a
 *  secret never prints. */
function renderValue(value: unknown, secret: boolean): string {
  if (value === undefined) return "(absent)";
  if (secret) return "<redacted>";
  return JSON.stringify(value) ?? String(value);
}

const VERDICT_LABEL: Record<FileVerdict, string> = {
  create: "create",
  rewrite: "rewrite",
  same: "unchanged",
  delete: "delete",
};

/** Past this many changed lines a text diff says how many changed instead of listing them. */
const TEXT_DIFF_MAX_LINES = 40;

/** The changed lines of a whole-text file (an rc block, a helper script) as `- old` and `+ new`
 *  rows; an unchanged line never prints, wherever it sits. */
function textDiffLines(before: string | null, after: string): string[] {
  // The "" a trailing newline splits into is the terminator, not a line of the file.
  const lines = (text: string): string[] => {
    const parts = text.split("\n");
    if (parts.at(-1) === "") parts.pop();
    return parts;
  };
  const rows = lineDiff(before === null ? [] : lines(before), lines(after))
    .filter(([kind]) => kind !== " ")
    .map(([kind, line]) => `${kind} ${line}`);
  if (rows.length > TEXT_DIFF_MAX_LINES) {
    const removed = rows.filter((row) => row.startsWith("-")).length;
    return [`(${removed} lines removed, ${rows.length - removed} lines added)`];
  }
  return rows;
}

type DiffKind = " " | "-" | "+";

/** A line diff by longest common subsequence, in file order. The texts are rc files and helper
 *  scripts, so the quadratic table stays small. */
function lineDiff(from: readonly string[], to: readonly string[]): [DiffKind, string][] {
  const width = to.length + 1;
  const table = new Uint32Array((from.length + 1) * width);
  const common = (i: number, j: number): number => table[i * width + j] ?? 0;
  for (let i = from.length - 1; i >= 0; i--) {
    for (let j = to.length - 1; j >= 0; j--) {
      table[i * width + j] = from[i] === to[j]
        ? common(i + 1, j + 1) + 1
        : Math.max(common(i + 1, j), common(i, j + 1));
    }
  }
  const rows: [DiffKind, string][] = [];
  let i = 0;
  let j = 0;
  for (let a = from[i], b = to[j]; a !== undefined && b !== undefined; a = from[i], b = to[j]) {
    if (a === b) {
      rows.push([" ", a]);
      i++;
      j++;
    } else if (common(i + 1, j) >= common(i, j + 1)) {
      rows.push(["-", a]);
      i++;
    } else {
      rows.push(["+", b]);
      j++;
    }
  }
  for (const line of from.slice(i)) rows.push(["-", line]);
  for (const line of to.slice(j)) rows.push(["+", line]);
  return rows;
}

/** Per file its verdict and path (a directory with a trailing separator), then every attribute
 *  that changes as `key  old -> new`, or for a file with no attribute rows its changed lines. */
export function renderDryRun(changes: readonly FileChange[]): string[] {
  if (changes.length === 0) return ["Nothing would be written."];
  const lines: string[] = [];
  for (const file of changes) {
    lines.push(`${VERDICT_LABEL[file.verdict]} ${file.path}${file.directory ? sep : ""}`);
    if (file.verdict === "same" || file.verdict === "delete") continue;
    const changed = file.attributes.filter((row) => row.status !== "same");
    if (changed.length === 0 && file.attributes.length > 0) {
      lines.push("  (every managed attribute already holds its value)");
    }
    if (file.attributes.length === 0 && file.text !== undefined) {
      for (const line of textDiffLines(file.text.before, file.text.after)) lines.push(`  ${line}`);
    }
    for (const row of changed) {
      const from = renderValue(row.current, row.secret);
      lines.push(`  ${row.key}  ${from} -> ${renderValue(row.next, row.secret)}`);
    }
  }
  return lines;
}
