// The landing of every planned write, and the one switch between performing it and recording it.
// A writer computes a WritePlan (the files it touches, attribute by attribute, plus the step that
// lands them) and hands it to landPlan. Outside a dry run the step runs; inside one the plan's
// files are recorded for the command to print, nothing is applied, and the content the plan would
// have written is shadowed so a later reader in the same run (the store re-read after a commit,
// a config.toml re-inspected after its write) sees the planned state, not the disk. utils layer:
// the JSON store (src/copilot_api/config.ts) lands through here too.
import { dirname } from "node:path";
import { missingDirectories, readTextResult, type TextReadResult } from "./fs.ts";

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
 *  attributes, only the verdict. `before` is the text the plan compared against (null: absent) and
 *  `content` the text the apply lands, when the plan knows them: a dry run serves `content` to the
 *  run's later readers in place of the file, and the renderer folds a path landed twice by
 *  comparing the first `before` with the last `content`. */
export interface FilePlan {
  path: string;
  verdict: FileVerdict;
  attributes: AttributeRow[];
  before?: string | null;
  content?: string;
  /** A directory (a home, a config library): rendered with a trailing separator. */
  directory?: true;
}

/**
 * A computed write: the files it touches, the one step that lands their bytes, and the store
 * bookkeeping that follows a successful landing (`commit`: ownership claims and releases). A dry
 * run skips `apply` and still runs `commit`, since a store write lands through the store's own
 * plan: the claim is recorded, not written, and the run's later readers see it.
 */
export interface WritePlan {
  files: FilePlan[];
  apply(): void;
  commit?(): void;
}

/** A whole-file artifact with no attribute rows. */
export function filePlan(
  path: string,
  verdict: FileVerdict,
  text: { before?: string | null; content?: string; directory?: true } = {},
): FilePlan {
  return { path, verdict, attributes: [], ...text };
}

/** A write with nothing to do (Desktop absent, a write refused and reported). */
export const NO_WRITE: WritePlan = { files: [], apply() {} };

/** How a text file's content changes: byte comparison, so a same-content rewrite reads `same`. */
export function textVerdict(currentText: string | null, nextText: string): FileVerdict {
  if (currentText === null) return "create";
  return currentText === nextText ? "same" : "rewrite";
}

/** A segment carrying a dot or a space is quoted, so a dotted key never reads as two levels. */
export function dottedKey(path: readonly string[]): string {
  return path.map((s) => (s.includes(".") || s.includes(" ") ? JSON.stringify(s) : s)).join(".");
}

/** The value a dry run lands in place of a secret it never acquires (a login that did not run).
 *  A store leaf holding it is redacted like any secret, so it never prints, and nothing in the
 *  same run may bake or send it: a Direct wiring or a model discovery planned from it would select
 *  nothing. */
export const PLANNED_SECRET = "<the value the real run lands>";

interface DryRunSession {
  files: FilePlan[];
  /** Planned content by path; null is a planned deletion. */
  shadows: Map<string, string | null>;
  /** Directories the run has planned to create, so an ancestor is listed once. */
  dirs: Set<string>;
}

let session: DryRunSession | null = null;

export function dryRunActive(): boolean {
  return session !== null;
}

/**
 * The ONE landing. Outside a dry run: the step runs, then the commit. Inside one: the files are
 * recorded and their planned content shadowed (a deletion shadows as absent), nothing is applied,
 * and the commit runs (its store writes record themselves).
 */
export function landPlan(plan: WritePlan): void {
  if (session === null) {
    plan.apply();
    plan.commit?.();
    return;
  }
  for (const file of plan.files) {
    // A create under a directory that does not exist yet creates that directory too (the apply's
    // mkdir, which a dry run never runs), so the plan names the missing ancestors, outermost
    // first, the way the real run's own lines do.
    if (file.verdict === "create") session.files.push(...missingAncestors(file.path));
    if (file.directory) session.dirs.add(file.path);
    session.files.push(file);
    if (file.verdict === "delete") session.shadows.set(file.path, null);
    else if (file.content !== undefined) session.shadows.set(file.path, file.content);
  }
  plan.commit?.();
}

/** The directories above `path` that neither exist nor were planned by this run, as directory
 *  creates, outermost first. The walk is the apply's own (missingDirectories), so an ancestor that
 *  exists as a regular file fails the plan with the ENOTDIR the real mkdir raises. */
function missingAncestors(path: string): FilePlan[] {
  if (session === null) return [];
  const made: FilePlan[] = [];
  for (const dir of missingDirectories(dirname(path))) {
    if (session.dirs.has(dir)) continue;
    session.dirs.add(dir);
    made.push(filePlan(dir, "create", { before: null, directory: true }));
  }
  return made;
}

/** Runs `body` as a dry run and returns every file the landings would have written, in landing
 *  order (one path may appear more than once; the renderer folds it). One dry run at a time.
 *  `files` is the caller's list: a body that throws has still recorded into it what it landed
 *  before the failure (the real command's writes up to that point). The session alone: the marker
 *  a run hands its children (DRY_RUN_ENV, report_write.ts) is minted around it by runDryRun. */
export async function collectDryRun<T>(
  body: () => Promise<T>,
  files: FilePlan[] = [],
): Promise<{ files: FilePlan[]; result: T }> {
  if (session !== null) throw new Error("a dry run is already collecting");
  session = { files, shadows: new Map(), dirs: new Set() };
  try {
    const result = await body();
    return { files: session.files, result };
  } finally {
    session = null;
  }
}

/** A dry run's planned content for `path`: the text an earlier landing would have written, null
 *  for a planned deletion (the path's own, or that of a directory above it: a tree the run removes
 *  takes every descendant with it, as the real rm does), undefined when no landing of this run
 *  touched it. */
export function shadowedText(path: string): string | null | undefined {
  if (session === null) return undefined;
  const own = session.shadows.get(path);
  if (own !== undefined) return own;
  for (let cur = dirname(path); dirname(cur) !== cur; cur = dirname(cur)) {
    if (session.shadows.get(cur) === null) return null;
  }
  return undefined;
}

/** readTextResult, with a dry run's planned content in front of the disk: a file this run planned
 *  to write reads as written, one it planned to delete reads as absent. Readers that decide a
 *  later write on a file an earlier landing touched read through here. */
export function readPlannedText(path: string): TextReadResult {
  const shadow = shadowedText(path);
  if (shadow === undefined) return readTextResult(path);
  return shadow === null ? { kind: "absent" } : { kind: "text", text: shadow };
}

function isDoc(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    !(value instanceof Date);
}

/** Every leaf under `value`, keyed by dotted path; arrays and scalars are leaves. An empty record
 *  is no leaf: a map emptied by the last slot's deletion is told by the slot keys that go, not by
 *  the container. */
function leaves(value: unknown, prefix: readonly string[], out: Map<string, unknown>): void {
  if (!isDoc(value)) {
    if (prefix.length > 0) out.set(dottedKey(prefix), value);
    return;
  }
  for (const [k, v] of Object.entries(value)) leaves(v, [...prefix, k], out);
}

/**
 * The rows a whole-document replacement yields: every leaf of `current` or `next`, judged by
 * value. For a store whose writer mutates the document in place (the JSON store's update), where
 * no patch exists to plan from. `secret` names the leaves a renderer must redact (dotted).
 */
export function planDocReplace(
  current: Record<string, unknown>,
  next: Record<string, unknown>,
  secret: (key: string) => boolean,
): AttributeRow[] {
  const before = new Map<string, unknown>();
  const after = new Map<string, unknown>();
  leaves(current, [], before);
  leaves(next, [], after);
  const rows: AttributeRow[] = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(key);
    const now = after.get(key);
    const status: AttributeStatus = !before.has(key)
      ? "set"
      : !after.has(key)
      ? "remove"
      : JSON.stringify(was) === JSON.stringify(now)
      ? "same"
      : "change";
    rows.push({ key, status, current: was, next: now, secret: secret(key) });
  }
  return rows;
}
