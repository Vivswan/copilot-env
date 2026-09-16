// The plan half of every managed wiring write (config.toml, settings.json, the Claude Desktop
// library): a writer expresses what it enforces as a PATCH over the file's document, and the same
// patch both mutates the document the apply saves and yields the attribute rows a preview prints.
// A key a writer sets can therefore never be written without appearing in its plan. Domain layer:
// no command imports; rendering lives in src/commands/.
import { isRecord } from "../utils/json.ts";

export type FileVerdict = "create" | "rewrite" | "same" | "delete";

export type AttributeStatus = "set" | "change" | "same" | "remove";

/** One managed attribute of one file, keyed by its dotted path in the file's own syntax
 *  (`model_providers.copilot-env.base_url`, `env.ANTHROPIC_BASE_URL`). `current` and `next` are the
 *  leaf values as the file holds them (undefined = absent); the renderer decides how a value
 *  prints, and redacts a `secret` one. */
export interface AttributeRow {
  key: string;
  status: AttributeStatus;
  current: unknown;
  next: unknown;
  secret: boolean;
}

/** One file the write touches. A whole-file artifact (a helper script, a directory) carries no
 *  attributes, only the verdict. */
export interface FilePlan {
  path: string;
  verdict: FileVerdict;
  attributes: AttributeRow[];
}

/** A computed write: the files it touches, and the one step that performs it. */
export interface WritePlan {
  files: FilePlan[];
  apply(): void;
}

export type Doc = Record<string, unknown>;

/** A leaf assignment or a removal at a path. A record value REPLACES the subtree at its path (every
 *  leaf not in the value goes); an array or scalar is one leaf. */
export type PatchOp =
  | { path: readonly string[]; value: unknown }
  | { path: readonly string[]; remove: true };

export function set(path: readonly string[] | string, value: unknown): PatchOp {
  return { path: segments(path), value };
}

export function remove(path: readonly string[] | string): PatchOp {
  return { path: segments(path), remove: true };
}

function segments(path: readonly string[] | string): readonly string[] {
  return typeof path === "string" ? [path] : path;
}

/** A segment carrying a dot is quoted, so a dotted key never reads as two levels. */
export function dottedKey(path: readonly string[]): string {
  return path.map((s) => (s.includes(".") || s.includes(" ") ? JSON.stringify(s) : s)).join(".");
}

/** A node the patch descends into. Anything else is a leaf, a Date included: smol-toml parses a
 *  TOML datetime into a Date subclass, and patching its properties would emit the datetime again
 *  with the managed keys silently gone. */
function isDoc(value: unknown): value is Doc {
  return isRecord(value) && !(value instanceof Date);
}

function leafAt(doc: Doc | null, path: readonly string[]): unknown {
  let cur: unknown = doc;
  for (const seg of path) {
    if (!isDoc(cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** Every leaf under `value`, as [path, leaf] pairs; arrays and scalars are leaves, an empty record
 *  is one leaf of its own. */
function leavesOf(value: unknown, prefix: readonly string[]): [readonly string[], unknown][] {
  if (!isDoc(value) || Object.keys(value).length === 0) return [[prefix, value]];
  return Object.entries(value).flatMap(([k, v]) => leavesOf(v, [...prefix, k]));
}

/** A TOML datetime and its ISO string serialize alike, yet the file changes shape: the kind
 *  compares too. */
function sameValue(a: unknown, b: unknown): boolean {
  return (a instanceof Date) === (b instanceof Date) && typeof a === typeof b &&
    JSON.stringify(a) === JSON.stringify(b);
}

/** Mutates `doc` in place: intermediate levels are created (a leaf in the way is replaced, as the
 *  writers always did), a removal of an absent path is a no-op. */
export function applyPatch(doc: Doc, ops: readonly PatchOp[]): Doc {
  for (const op of ops) {
    const parents = op.path.slice(0, -1);
    const last = op.path[op.path.length - 1];
    if (last === undefined) continue;
    let cur: Doc = doc;
    let present = true;
    for (const seg of parents) {
      const next = cur[seg];
      if (isDoc(next)) {
        cur = next;
        continue;
      }
      if ("remove" in op) {
        present = false;
        break;
      }
      const created: Doc = {};
      cur[seg] = created;
      cur = created;
    }
    if (!present) continue;
    if ("remove" in op) delete cur[last];
    else cur[last] = op.value;
  }
  return doc;
}

/**
 * The attribute rows `ops` produce over `current` (null = the file is absent), folded to the final
 * state per leaf: a key removed then set is one row, a leaf a set replaces on its way down (a
 * scalar where a table goes) is a removal. `secretKeys` names the leaves whose values a renderer
 * must redact (dotted).
 */
export function planPatch(
  current: Doc | null,
  ops: readonly PatchOp[],
  secretKeys: ReadonlySet<string> = new Set(),
): AttributeRow[] {
  const pending = new Map<string, { path: readonly string[]; next: unknown }>();
  const drop = (path: readonly string[]): void =>
    void pending.set(dottedKey(path), { path, next: undefined });
  const dropUnder = (path: readonly string[]): void => {
    for (const [leaf, plan] of leavesOf(leafAt(current, path), path)) {
      if (plan !== undefined) drop(leaf);
    }
    const prefix = dottedKey(path);
    for (const [key, plan] of pending) {
      if (key === prefix || key.startsWith(`${prefix}.`)) drop(plan.path);
    }
  };
  for (const op of ops) {
    if ("remove" in op) {
      dropUnder(op.path);
      continue;
    }
    for (let depth = 1; depth < op.path.length; depth++) {
      const parent = op.path.slice(0, depth);
      const inTheWay = leafAt(current, parent);
      if (inTheWay !== undefined && !isDoc(inTheWay)) drop(parent);
      // A scalar an earlier op set at this level goes the same way when a leaf lands under it.
      const planned = pending.get(dottedKey(parent));
      if (planned !== undefined && planned.next !== undefined && !isDoc(planned.next)) drop(parent);
    }
    if (isDoc(op.value)) dropUnder(op.path);
    for (const [leaf, value] of leavesOf(op.value, op.path)) {
      pending.set(dottedKey(leaf), { path: leaf, next: value });
    }
  }
  // A table removed and re-populated is no removal; a scalar replaced by a table still goes.
  const kept = [...pending.keys()].filter((key) => pending.get(key)?.next !== undefined);
  for (const [key, plan] of pending) {
    if (plan.next !== undefined || !isDoc(leafAt(current, plan.path))) continue;
    if (kept.some((k) => k.startsWith(`${key}.`))) pending.delete(key);
  }
  const rows: AttributeRow[] = [];
  for (const [key, { path, next }] of pending) {
    const before = leafAt(current, path);
    if (before === undefined && next === undefined) continue;
    const status: AttributeStatus = before === undefined
      ? "set"
      : next === undefined
      ? "remove"
      : sameValue(before, next)
      ? "same"
      : "change";
    rows.push({ key, status, current: before, next, secret: secretKeys.has(key) });
  }
  return rows;
}

/** How a text file's content changes: byte comparison, so a same-content rewrite reads `same`. */
export function textVerdict(currentText: string | null, nextText: string): FileVerdict {
  if (currentText === null) return "create";
  return currentText === nextText ? "same" : "rewrite";
}

/** A whole-file artifact with no attribute rows. */
export function filePlan(path: string, verdict: FileVerdict): FilePlan {
  return { path, verdict, attributes: [] };
}

/** A write with nothing to do (Desktop absent, a write refused and reported). */
export const NO_WRITE: WritePlan = { files: [], apply() {} };
