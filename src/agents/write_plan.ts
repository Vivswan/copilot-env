// The plan half of every managed wiring write (config.toml, settings.json, the Claude Desktop
// library): a writer expresses what it enforces as a PATCH over the file's document, and the same
// patch both mutates the document the apply saves and yields the attribute rows a preview prints.
// A key a writer sets can therefore never be written without appearing in its plan. The plan
// vocabulary and the landing (landPlan, the dry-run ledger) live in src/utils/write_session.ts so
// the JSON store can land through them too; this module holds the patch algebra and the ONE
// renderer every `--dry-run` prints through. Domain layer: no command imports.
import { sep } from "node:path";
import { isRecord } from "../utils/json.ts";
import {
  type AttributeRow,
  type AttributeStatus,
  dottedKey,
  type FilePlan,
  type FileVerdict,
  textVerdict,
} from "../utils/write_session.ts";

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

// --- the dry-run print ---------------------------------------------------------------------------

/** What a dry run says a value is: JSON, so a string is told from a number or a boolean, an absent
 *  leaf reads `(absent)`, and a secret never prints. */
function renderValue(value: unknown, secret: boolean): string {
  if (value === undefined) return "(absent)";
  if (secret) return "<redacted>";
  return JSON.stringify(value) ?? String(value);
}

/**
 * One path's plans folded into the file as the run leaves it: the FIRST plan's `current` and the
 * LAST plan's `next` per key (a slot committed then re-probed is one row), and the verdict of the
 * first `before` against the last `content` when both are known (a value cleared and restored is
 * `same`), else of the landings' own verdicts. A path created and deleted within the run folds to
 * nothing.
 */
export function foldFilePlans(files: readonly FilePlan[]): FilePlan[] {
  const byPath = new Map<string, FilePlan[]>();
  for (const file of files) byPath.set(file.path, [...(byPath.get(file.path) ?? []), file]);
  const folded: FilePlan[] = [];
  for (const [path, plans] of byPath) {
    const first = plans[0];
    const last = plans[plans.length - 1];
    if (first === undefined || last === undefined) continue;
    // Created and deleted inside the run (a backup the same import's prune removes as the oldest):
    // the path exists neither before nor after, so the run leaves nothing to say about it.
    if (first.verdict === "create" && last.verdict === "delete") continue;
    const rows = new Map<string, AttributeRow>();
    for (const plan of plans) {
      for (const row of plan.attributes) {
        const seen = rows.get(row.key);
        rows.set(row.key, {
          key: row.key,
          status: row.status,
          current: seen === undefined ? row.current : seen.current,
          next: row.next,
          secret: row.secret || (seen?.secret ?? false),
        });
      }
    }
    const attributes = [...rows.values()].map((row) => ({ ...row, status: statusOf(row) }));
    // A plan that rewrites identical bytes changes something the bytes do not show (a helper's
    // executable bit), so the byte comparison never demotes it to `same`.
    const beyondBytes = plans.some(
      (plan) => plan.verdict === "rewrite" && plan.before === plan.content,
    );
    const verdict: FileVerdict = last.verdict === "delete"
      ? "delete"
      : first.verdict === "create"
      ? "create"
      : beyondBytes
      ? "rewrite"
      : first.before !== undefined && last.content !== undefined
      ? textVerdict(first.before, last.content)
      : plans.some((plan) => plan.verdict !== "same")
      ? "rewrite"
      : "same";
    // A secret landing prints the verdict alone: no earlier landing's text is diffed against it,
    // and no earlier landing's rows print beneath it. Keys a landing declares (its own, or carried
    // by a move or a copy) redact every row of the path, earlier ones included, and rule out the
    // line diff a path without rows would print (its lines would carry the values).
    const secret = plans.some((plan) => plan.secret);
    const declared = new Set(plans.flatMap((plan) => plan.secretKeys ?? []));
    folded.push({
      path,
      verdict,
      attributes: secret
        ? []
        : attributes.map((row) => (declared.has(row.key) ? { ...row, secret: true } : row)),
      ...(secret || declared.size > 0
        ? secret ? { secret: true as const } : {}
        : { before: first.before, content: last.content }),
      ...(plans.some((plan) => plan.directory) ? { directory: true as const } : {}),
    });
  }
  return folded;
}

function statusOf(row: AttributeRow): AttributeStatus {
  if (row.current === undefined && row.next === undefined) return "same";
  if (row.current === undefined) return "set";
  if (row.next === undefined) return "remove";
  return sameValue(row.current, row.next) ? "same" : "change";
}

/** Past this many changed lines a text diff says how many changed instead of listing them. */
const TEXT_DIFF_MAX_LINES = 40;

/**
 * The changed lines of a whole-text write (a file with no managed attributes: an rc block, a
 * settings bundle), as `- old` and `+ new` rows. Only the lines that differ print: an unchanged
 * line never does, wherever it sits (a token exported between two rc blocks stays off the
 * preview when both blocks change around it). A change wider than TEXT_DIFF_MAX_LINES is counted.
 */
export function textDiffLines(before: string | null, content: string): string[] {
  // The "" a trailing newline splits into is the terminator, not a line of the file.
  const lines = (text: string): string[] => {
    const parts = text.split("\n");
    if (parts.at(-1) === "") parts.pop();
    return parts;
  };
  const rows = lineDiff(before === null ? [] : lines(before), lines(content))
    .filter(([kind]) => kind !== " ")
    .map(([kind, line]) => `${kind} ${line}`);
  if (rows.length > TEXT_DIFF_MAX_LINES) {
    const removed = rows.filter((row) => row.startsWith("-")).length;
    return [`(${removed} lines removed, ${rows.length - removed} lines added)`];
  }
  return rows;
}

type DiffKind = " " | "-" | "+";

/** A line diff by longest common subsequence, in file order: `" "` kept, `"-"` removed from
 *  `from`, `"+"` added in `to`. The texts are rc files and settings bundles, so the quadratic
 *  table stays small. */
function lineDiff(from: readonly string[], to: readonly string[]): [DiffKind, string][] {
  // common(i, j) = the common subsequence length of from[i..] and to[j..], one row per i.
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

const VERDICT_LABEL: Record<FileVerdict, string> = {
  create: "create",
  rewrite: "rewrite",
  same: "unchanged",
  delete: "delete",
};

/**
 * The lines a `--dry-run` prints: per file its verdict and path, then every attribute that changes
 * as `key  old -> new` (secrets redacted, an absent leaf `(absent)`); a file the run would leave
 * byte-identical prints `unchanged`. The one renderer, so a command's dry run and its real
 * narration come from the same plan objects.
 */
export function renderDryRun(files: readonly FilePlan[]): string[] {
  const folded = foldFilePlans(files);
  if (folded.length === 0) return ["Nothing would be written."];
  const lines: string[] = [];
  for (const file of folded) {
    lines.push(`${VERDICT_LABEL[file.verdict]} ${file.path}${file.directory ? sep : ""}`);
    if (file.verdict === "same" || file.verdict === "delete") continue;
    const changed = file.attributes.filter((row) => row.status !== "same");
    if (changed.length === 0 && file.attributes.length > 0) {
      lines.push("  (every managed attribute already holds its value)");
    }
    if (file.attributes.length === 0 && file.content !== undefined && file.before !== undefined) {
      for (const line of textDiffLines(file.before, file.content)) lines.push(`  ${line}`);
    }
    for (const row of changed) {
      lines.push(
        `  ${row.key}  ${renderValue(row.current, row.secret)} -> ${
          renderValue(row.next, row.secret)
        }`,
      );
    }
  }
  return lines;
}
