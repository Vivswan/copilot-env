// The landing of every planned write, and the one switch between performing it and recording it.
// A writer computes a WritePlan (the files it touches, attribute by attribute, plus the step that
// lands them) and hands it to landPlan. Outside a dry run the step runs; inside one the plan's
// files are recorded for the command to print, nothing is applied, and the content the plan would
// have written is shadowed so a later reader in the same run (the store re-read after a commit,
// a config.toml re-inspected after its write) sees the planned state, not the disk. utils layer:
// the JSON store (src/copilot_api/config.ts) lands through here too.
import { lstatSync, readdirSync, readFileSync, type Stats, statSync } from "node:fs";
import { basename, dirname, extname, join, sep } from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  isEnoent,
  isEnoentOrNotdir,
  missingDirectories,
  readTextResult,
  type TextReadResult,
} from "./fs.ts";
import { parseJsonRecord } from "./json.ts";

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
  /** The landing's text is secret (a bundle, a move, a copy of declared content): the renderer
   *  prints the path's verdict alone, whatever text an earlier landing of the path compared. */
  secret?: true;
  /** Leaves this landing declares secret for the path (its own, or carried by a move or a copy):
   *  every row of the path, an earlier landing's included, redacts them. */
  secretKeys?: readonly string[];
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

/** The error a dry run raises where the real command would prompt: a preview never asks, and
 *  guessing the answer would plan a run the user did not choose. `what` names the question. */
export function promptRefusedInDryRun(what: string): Error {
  return new Error(
    `a dry run never prompts (${what}); pass the flag that answers it, or run for real`,
  );
}

interface DryRunSession {
  files: FilePlan[];
  /** Planned content by path; null is a planned deletion. */
  shadows: Map<string, string | null>;
  /** Directories the run has planned to create, so an ancestor is listed once. */
  dirs: Set<string>;
  /** The mode a planned chmod or an explicit-mode write left at a path (the facade's stat reads
   *  it; a plan row carries no mode). */
  modes: Map<string, number>;
  /** Directories made where the run had planned a deletion: nothing the disk holds under one is
   *  visible, as after the real `rm -r d; mkdir d`. */
  fresh: Set<string>;
  /** Files landed without their bytes (a copy, a byte write, a link) where the run had planned a
   *  deletion: files, whatever the disk still holds at the path. */
  opaqueFiles: Set<string>;
  /** Planned bytes by path (a byte write, a copied binary), for the run's later readers. */
  bytes: Map<string, Uint8Array>;
  /** Paths whose planned content is secret as a whole: every later write of one prints its path
   *  alone, whatever it declares. */
  secretFiles: Set<string>;
  /** Per path, every leaf a write declared secret, kept across the run's later writes and carried
   *  by a move or a copy: a key once declared never prints. */
  secretKeys: Map<string, Set<string>>;
}

let session: DryRunSession | null = null;

export function dryRunActive(): boolean {
  return session !== null;
}

/** A directory this run makes at `path`: fresh when made over a planned deletion (its own, or an
 *  ancestor's tree), which is what hides the disk below it; its own tombstone is spent. */
function noteDirectory(path: string): void {
  if (session === null) return;
  if (shadowedText(path) === null) session.fresh.add(path);
  session.dirs.add(path);
  if (session.shadows.get(path) === null) session.shadows.delete(path);
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
    if (file.directory) noteDirectory(file.path);
    session.files.push(file);
    if (file.verdict === "delete") {
      // The tree goes: every landing below it is spent, and a later one starts over.
      session.shadows.set(file.path, null);
      const below = (key: string): boolean => key === file.path || key.startsWith(file.path + sep);
      for (const key of [...session.shadows.keys()]) {
        if (key !== file.path && below(key)) session.shadows.delete(key);
      }
      for (const key of [...session.modes.keys()]) if (below(key)) session.modes.delete(key);
      for (const key of [...session.bytes.keys()]) if (below(key)) session.bytes.delete(key);
      // A secret declaration outlives the deletion: the report folds a path's landings across it,
      // and a path once declared never prints (the overlay keeps its declarations the same way).
      for (const set of [session.dirs, session.fresh, session.opaqueFiles]) {
        for (const key of [...set]) if (below(key)) set.delete(key);
      }
    } else if (file.content !== undefined) {
      session.shadows.set(file.path, file.content);
      session.bytes.delete(file.path);
    } // A landing whose bytes the plan does not carry (a copy, a link, a byte write) over a planned
    // deletion is a file there whatever the disk held, and ends the deletion of the path itself;
    // earlier planned text stays (a chmod carries none).
    else if (!file.directory && shadowedText(file.path) === null) {
      session.opaqueFiles.add(file.path);
      session.shadows.delete(file.path);
    }
  }
  plan.commit?.();
}

/** The directories above `path` that neither exist nor were planned by this run, as directory
 *  creates, outermost first. The walk is the apply's own (plannedMissingDirectories), so an
 *  ancestor that exists as a regular file fails the plan with the ENOTDIR the real mkdir raises. */
function missingAncestors(path: string): FilePlan[] {
  if (session === null) return [];
  const made: FilePlan[] = [];
  for (const dir of plannedMissingDirectories(dirname(path))) {
    if (session.dirs.has(dir)) continue;
    noteDirectory(dir);
    made.push(filePlan(dir, "create", { before: null, directory: true }));
  }
  return made;
}

/** The directories a `mkdir -p` would make, this run's landings in front of the disk, component
 *  by component from `path` upward: a planned directory exists; planned text (or a planned file
 *  without bytes) is mkdir's own EEXIST (the path itself) or ENOTDIR (above it); a tombstoned path,
 *  or one under a tombstoned or fresh ancestor, is absent (the mkdir re-creates it); where the plan
 *  says nothing, the disk entry decides as in missingDirectories. Outside a dry run it is that
 *  walk. */
export function plannedMissingDirectories(path: string): string[] {
  if (session === null) return missingDirectories(path);
  const missing: string[] = [];
  for (let cur = path;; cur = dirname(cur)) {
    const state = plannedState(cur);
    if (state?.kind === "dir") return missing;
    if (
      state?.kind === "text" || state?.kind === "bytes" ||
      (state?.kind === "opaque" && state.file)
    ) {
      throw mkdirRefusal(cur, path);
    }
    if (state === null || state.kind === "opaque") {
      // A plan without bytes (a chmod on a disk directory, a copy): the disk says which kind.
      const entry = lookEntry(cur);
      if (entry === "unreadable" || entry === "dir") return missing;
      if (entry !== "absent" || state !== null) throw mkdirRefusal(cur, path);
    }
    missing.unshift(cur);
    if (dirname(cur) === cur) return missing;
  }
}

/** mkdir's own error for a non-directory at `cur` on the way to `path`: EEXIST for the path
 *  itself or a dangling link above it, ENOTDIR for a file above it. */
function mkdirRefusal(cur: string, path: string): NodeJS.ErrnoException {
  const code = cur === path || lookEntry(cur) === "dangling" ? "EEXIST" : "ENOTDIR";
  const err: NodeJS.ErrnoException = new Error(
    `${code}: ${code === "EEXIST" ? "file already exists" : "not a directory"}, mkdir '${path}'`,
  );
  err.code = code;
  err.syscall = "mkdir";
  err.path = path;
  return err;
}

/** What mkdir meets on the disk at `path`: a directory (a symlink to one followed), another
 *  entry, a dangling link, nothing, or a look that failed for another reason. */
function lookEntry(path: string): "dir" | "other" | "dangling" | "absent" | "unreadable" {
  let entry: Stats;
  try {
    entry = lstatSync(path);
  } catch (e) {
    return isEnoentOrNotdir(e) ? "absent" : "unreadable";
  }
  if (!entry.isSymbolicLink()) return entry.isDirectory() ? "dir" : "other";
  try {
    return statSync(path).isDirectory() ? "dir" : "other";
  } catch (e) {
    return isEnoentOrNotdir(e) ? "dangling" : "unreadable";
  }
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
  session = {
    files,
    shadows: new Map(),
    dirs: new Set(),
    modes: new Map(),
    fresh: new Set(),
    opaqueFiles: new Set(),
    bytes: new Map(),
    secretFiles: new Set(),
    secretKeys: new Map(),
  };
  try {
    const result = await body();
    return { files: session.files, result };
  } finally {
    session = null;
  }
}

/** A dry run's planned content for `path`: the text an earlier landing would have written, null
 *  for a planned deletion (the path's own, or that of a directory above it: a tree the run removes
 *  takes every descendant with it, as the real rm does, and a directory made fresh over one holds
 *  nothing of the disk), undefined when no landing of this run touched it. */
export function shadowedText(path: string): string | null | undefined {
  if (session === null) return undefined;
  const own = session.shadows.get(path);
  if (own !== undefined) return own;
  for (let cur = dirname(path); dirname(cur) !== cur; cur = dirname(cur)) {
    if (session.shadows.get(cur) === null || session.fresh.has(cur)) return null;
  }
  return undefined;
}

/** What this run has planned at `path`, in one answer: a directory it made, text it wrote, a
 *  deletion (its own, or an ancestor's tree, or a fresh ancestor hiding the disk), a file it landed
 *  without carrying the bytes (a copy, a link, a chmod), or nothing (the disk speaks). The seam's
 *  bridge reads through this alone. */
export type PlannedState =
  | { kind: "dir" }
  | { kind: "text"; text: string }
  | { kind: "bytes"; bytes: Uint8Array }
  | { kind: "gone" }
  /** `file` is certain when the landing replaced a planned deletion; otherwise the disk says. */
  | { kind: "opaque"; file: boolean }
  | null;

export function plannedState(path: string): PlannedState {
  if (session === null) return null;
  if (session.dirs.has(path)) return { kind: "dir" };
  const own = session.shadows.get(path);
  if (own === null) return { kind: "gone" };
  if (own !== undefined) return { kind: "text", text: own };
  const bytes = session.bytes.get(path);
  if (bytes !== undefined && plannedPresence(path) === true) return { kind: "bytes", bytes };
  const present = plannedPresence(path);
  if (present === true) return { kind: "opaque", file: session.opaqueFiles.has(path) };
  return present === false || shadowedText(path) === null ? { kind: "gone" } : null;
}

/** Bytes a landing put at `path` (a byte write, a copied binary), for the run's later readers. */
export function recordBytes(path: string, bytes: Uint8Array): void {
  if (session === null) return;
  session.bytes.set(path, bytes.slice());
  if (session.shadows.get(path) !== null) session.shadows.delete(path);
}

/** The content a landing left at `path` as the run sees it: planned bytes, planned text, the
 *  disk's bytes (never decoded: a copied binary stays a binary), or null (absent, or a planned
 *  deletion). */
export function plannedContent(path: string): string | Uint8Array | null {
  const state = plannedState(path);
  if (state?.kind === "bytes") return state.bytes;
  if (state?.kind === "text") return state.text;
  if (state?.kind === "gone") return null;
  try {
    return new Uint8Array(readFileSync(path));
  } catch {
    return null;
  }
}

/** What a path's planned content holds as secret: the whole file, or declared leaves. */
export interface PlannedSecret {
  whole: boolean;
  keys: ReadonlySet<string>;
}

/** A write's declaration joins the path's: a key once declared never prints, and a whole-file
 *  secret stays one for the run. */
export function recordSecret(
  path: string,
  secret: { whole?: boolean; keys?: Iterable<string> },
): void {
  if (session === null) return;
  if (secret.whole) session.secretFiles.add(path);
  if (secret.keys !== undefined) {
    const declared = session.secretKeys.get(path) ?? new Set<string>();
    for (const k of secret.keys) declared.add(k);
    session.secretKeys.set(path, declared);
  }
}

/** The declarations travel with a move or a copy, so the destination redacts the same values. */
export function carrySecret(from: string, to: string): void {
  if (session === null) return;
  const carried = secretOf(from);
  recordSecret(to, {
    whole: carried.whole,
    keys: carried.keys.size > 0 ? carried.keys : undefined,
  });
}

export function secretOf(path: string): PlannedSecret {
  return {
    whole: session?.secretFiles.has(path) ?? false,
    keys: session?.secretKeys.get(path) ?? new Set(),
  };
}

/** Whether `path` exists as the run has planned it, landing by landing: true after a planned
 *  create or rewrite of the path, false after a planned delete of it or of a tree above it,
 *  undefined when no landing of this run touched it (a copied binary has no text to shadow, so a
 *  reader that checks existence asks this). */
export function plannedPresence(path: string): boolean | undefined {
  if (session === null) return undefined;
  let present: boolean | undefined;
  for (const file of session.files) {
    if (file.path === path) present = file.verdict !== "delete";
    else if (file.verdict === "delete" && path.startsWith(file.path + sep)) present = false;
  }
  return present;
}

/** Whether this dry run planned `path` as a directory (a home an earlier landing would create). */
export function plannedDirectory(path: string): boolean {
  return session?.dirs.has(path) ?? false;
}

/** The mode a landing of this run left at `path` (a chmod, an explicit-mode write), for the
 *  facade's stat under the collector; a planned deletion forgets it. Windows keeps one bit, as
 *  its stat reports: 0666 for anything writable, 0444 otherwise. */
export function recordPlannedMode(path: string, mode: number): void {
  if (session === null) return;
  const platform = process.platform === "win32"
    ? (mode & 0o222) === 0 ? 0o444 : 0o666
    : mode & 0o777;
  session.modes.set(path, platform);
}

export function plannedMode(path: string): number | undefined {
  return session?.modes.get(path);
}

/** Text a landing put at `path` without a plan row carrying it (a copy's source text), so the
 *  run's later readers see it while the row prints as the wrapper's did. */
export function recordShadow(path: string, text: string): void {
  if (session === null) return;
  session.shadows.set(path, text);
  session.bytes.delete(path);
}

/** readdirSync, with a dry run's landings in front of the disk: an entry this run planned to
 *  delete is gone, one it planned to create (a file, a copy, a link, or a directory) is there, and
 *  a directory made fresh over a planned deletion lists nothing the disk holds. Absent reads as
 *  empty; a regular file at the path is readdir's own ENOTDIR, never an empty directory. */
export function readPlannedDir(dir: string): string[] {
  let names: string[] = [];
  if (!(session?.fresh.has(dir) ?? false)) {
    try {
      names = readdirSync(dir);
    } catch (e) {
      if (!isEnoent(e)) throw e;
    }
  }
  if (session === null) return names;
  // Every name the disk or a landing ever put under `dir`, kept when the run's state says it
  // stands there now (a disk name with no plan stands; a planned one stands unless planned gone).
  const candidates = new Set(names);
  for (const file of session.files) {
    if (dirname(file.path) === dir) candidates.add(basename(file.path));
  }
  for (const path of session.shadows.keys()) {
    if (dirname(path) === dir) candidates.add(basename(path));
  }
  for (const path of session.dirs) if (dirname(path) === dir) candidates.add(basename(path));
  const present: string[] = [];
  for (const name of candidates) {
    const state = plannedState(join(dir, name));
    if (state === null ? names.includes(name) : state.kind !== "gone") present.push(name);
  }
  return present.sort();
}

/** readTextResult, with a dry run's planned content in front of the disk: a file this run planned
 *  to write reads as written (planned bytes decoded), one it planned to delete reads as absent.
 *  Readers that decide a later write on a file an earlier landing touched read through here. */
export function readPlannedText(path: string): TextReadResult {
  const state = plannedState(path);
  if (state?.kind === "bytes") {
    return {
      kind: "text",
      text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(state.bytes),
    };
  }
  const shadow = shadowedText(path);
  if (shadow === undefined) return readTextResult(path);
  return shadow === null ? { kind: "absent" } : { kind: "text", text: shadow };
}

function isDoc(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    !(value instanceof Date);
}

/** Every leaf under `value`, keyed by dotted path; arrays and scalars are leaves. An empty record
 *  is no leaf of its own: a map emptied by the last slot's deletion is told by the slot keys that
 *  go, not by the container. `empties` collects the empty records, for the one case they do print
 *  (see emptyLeaves). */
function leaves(
  value: unknown,
  prefix: readonly string[],
  out: Map<string, unknown>,
  empties: Set<string>,
): void {
  if (!isDoc(value)) {
    if (prefix.length > 0) out.set(dottedKey(prefix), value);
    return;
  }
  if (prefix.length > 0 && Object.keys(value).length === 0) empties.add(dottedKey(prefix));
  for (const [k, v] of Object.entries(value)) leaves(v, [...prefix, k], out, empties);
}

/** An empty record the run DROPS stands as a leaf (`{} -> (absent)`), as the patch writers printed
 *  it, when the other side has nothing at or under its key; a map emptied slot by slot prints only
 *  its slots, and an empty record gained or kept is no row (the store never printed one). */
export function emptyLeaves(
  empties: ReadonlySet<string>,
  own: Map<string, unknown>,
  other: ReadonlyMap<string, unknown>,
  otherEmpties: ReadonlySet<string>,
): void {
  for (const key of empties) {
    if (other.has(key) || otherEmpties.has(key)) continue;
    // A table whose subtree still stands (a leaf, or an empty table, below it) is not absent.
    const under = (k: string): boolean => k.startsWith(`${key}.`);
    if ([...other.keys()].some(under) || [...otherEmpties].some(under)) continue;
    own.set(key, {});
  }
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
  emptyDrops = false,
): AttributeRow[] {
  const before = new Map<string, unknown>();
  const after = new Map<string, unknown>();
  const beforeEmpties = new Set<string>();
  const afterEmpties = new Set<string>();
  leaves(current, [], before, beforeEmpties);
  leaves(next, [], after, afterEmpties);
  // A dropped empty table is a row where the writer's rows printed one (TOML); one kept on both
  // sides is neither; the JSON store never printed a container.
  for (const key of afterEmpties) beforeEmpties.delete(key);
  if (emptyDrops) emptyLeaves(beforeEmpties, before, after, afterEmpties);
  const rows: AttributeRow[] = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(key);
    const now = after.get(key);
    // A TOML datetime and its ISO string serialize alike, yet the file changes shape: the kind
    // compares too.
    const status: AttributeStatus = !before.has(key)
      ? "set"
      : !after.has(key)
      ? "remove"
      : (was instanceof Date) === (now instanceof Date) &&
          JSON.stringify(was) === JSON.stringify(now)
      ? "same"
      : "change";
    rows.push({ key, status, current: was, next: now, secret: secret(key) });
  }
  return rows;
}

// --- the transition bridge ---------------------------------------------------------------------
// The rows a write through the fs facade lands while this collector is active (fs_disk.ts): the
// file's leaves before and after, by its syntax. Goes with this module.

/** A parsed JSON or TOML document, `{}` for an absent or blank file (what the store and settings
 *  readers make of blank content), null when the text is neither or does not parse (the verdict
 *  alone is then what can be said). */
function parseDoc(path: string, text: string | null): Record<string, unknown> | null {
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

/** The leaf rows of a bridged document write, or null when either side does not parse: the
 *  caller then prints the path alone, so a declared secret never reaches a line diff. */
export function bridgeRows(
  path: string,
  before: string | null,
  after: string,
  secretKeys: ReadonlySet<string>,
): AttributeRow[] | null {
  const current = parseDoc(path, before);
  const next = parseDoc(path, after);
  if (current === null || next === null) return null;
  return planDocReplace(
    current,
    next,
    (key) => secretKeys.has(key),
    extname(path).toLowerCase() === ".toml",
  );
}
