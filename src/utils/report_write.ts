// Every file a command creates, rewrites, deletes, moves or links outside copilot-env's own homes
// is named on stderr, once per process. Raw stderr, not consola (a CONSOLA_LEVEL could silence it),
// so the machine-readable stdout contracts survive and the lines cannot be turned off.
// test/lint/no_unreported_fs_writes.ts refuses a raw node:fs write anywhere else in src/, bar the
// lock protocol's internals (file_lock.ts), the preload that patches the proxy's own stream
// (log_mute_preload.ts), and src/migrations/.
//
// Dedup is per path, with a delete as the epoch boundary: five saves of one path print once, and a
// delete re-arms it. What does not print:
//
//   inside a home registered via hideWritesUnder -> silent; the root itself still prints
//   scratch this process creates and removes     -> silent
//   a recipe's transient side (a temp file)      -> silent
//   a write that failed                          -> only what a before/after look PROVES changed
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  type Stats,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { isDir, isEnoentOrNotdir, missingDirectories, readTextResult } from "./fs.ts";
import { terminalWidth, wrapMessage } from "./table.ts";
import { sleepSync } from "./time.ts";
import {
  dryRunActive,
  filePlan,
  type FileVerdict,
  landPlan,
  plannedDirectory,
  readPlannedDir,
  shadowedText,
} from "./write_session.ts";

export type WriteKind = "created" | "rewritten" | "deleted" | "moved" | "linked";

const REPORTED = new Map<string, Set<WriteKind>>();

declare const scratchBrand: unique symbol;

/** The only thing removeScratchDir accepts, so a permanent directory can never be removed silently
 *  through the scratch path. */
export type ScratchDir = string & { readonly [scratchBrand]: true };

const SCRATCH_ROOTS = new Set<string>();

/** Registered by each home's owner when it loads: src/copilot_api/paths.ts, src/utils/root.ts.
 *  Resolved per report, because a home follows the environment. */
const INTERNAL_ROOTS: (() => string)[] = [];

export function hideWritesUnder(root: () => string): void {
  INTERNAL_ROOTS.push(root);
}

/** A home itself always prints, even nested inside another home (the data home under the install
 *  root), so the exact match is checked against every root before any prefix test. The trailing
 *  separator is dropped so a filesystem root (`/`, `C:\`) prefixes correctly. */
function insideInternalRoot(path: string): boolean {
  // On POSIX a backslash is a byte of the name; stripping it would fold a home onto a sibling's
  // prefix.
  const trailing = process.platform === "win32" ? /[\\/]+$/ : /\/+$/;
  const fold = (p: string): string => {
    const r = resolve(p).replace(trailing, "");
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  const target = fold(path);
  const roots = INTERNAL_ROOTS.map((root) => fold(root()));
  if (roots.includes(target)) return false;
  return roots.some((root) => target.startsWith(root + sep));
}

let deferred: string[] | null = null;

function underScratch(path: string): boolean {
  for (const root of SCRATCH_ROOTS) {
    if (path === root || path.startsWith(root + sep)) return true;
  }
  return false;
}

const ENCODER = new TextEncoder();

/** Synchronous and in full: a buffered stream write could still be pending when a process.exit()
 *  ends the process. */
function emit(line: string): void {
  if (deferred !== null) {
    deferred.push(line);
    return;
  }
  const bytes = ENCODER.encode(`${wrapMessage(line, terminalWidth(process.stderr))}\n`);
  let written = 0;
  while (written < bytes.length) written += Deno.stderr.writeSync(bytes.subarray(written));
}

/** The primitive for a writer whose mutation happens through another API (the tree a spawned
 *  `codex exec` leaves, src/codex/host.ts); everything else uses the wrappers below. */
export function reportWrite(kind: WriteKind, path: string, detail?: string): void {
  if (underScratch(path) || insideInternalRoot(path)) return;
  const kinds = REPORTED.get(path) ?? new Set<WriteKind>();
  if (kind === "created" || kind === "rewritten") {
    if (kinds.has("created") || kinds.has("rewritten")) return;
  } else if (kinds.has(kind)) {
    return;
  }
  if (kind === "deleted") {
    kinds.clear();
    forgetBelow(path);
  } else {
    kinds.delete("deleted");
  }
  kinds.add(kind);
  REPORTED.set(path, kinds);
  emit(`${kind} -> ${path}${detail === undefined ? "" : ` (${detail})`}`);
}

/** A tree that went takes every recorded descendant with it, so a child re-created afterwards is
 *  announced again. */
function forgetBelow(path: string): void {
  for (const recorded of REPORTED.keys()) {
    if (recorded.startsWith(path + sep)) REPORTED.delete(recorded);
  }
}

// --- the before/after look -----------------------------------------------------------

/** A look that FAILED (permissions, a transient error) never reads as absent, or a report would be
 *  fabricated from it; a dangling symlink IS present. A deep look fingerprints the whole tree keyed
 *  by full relative path, so moving an entry between levels changes it even when no directory
 *  metadata does. */
type Look =
  | { kind: "present"; fingerprint: string }
  | { kind: "absent" }
  | { kind: "unknown" };

function look(path: string, deep = false): Look {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (e) {
    return isEnoentOrNotdir(e) ? { kind: "absent" } : { kind: "unknown" };
  }
  const own = entryFingerprint(stat);
  if (!deep || !stat.isDirectory()) return { kind: "present", fingerprint: own };
  const lines = [own];
  return fingerprintTree(path, "", lines)
    ? { kind: "present", fingerprint: lines.join("\n") }
    : { kind: "unknown" };
}

function entryFingerprint(stat: Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.size}`;
}

/** False when a level cannot be listed or an entry vanishes mid-walk: a tree that cannot be judged.
 */
function fingerprintTree(dir: string, rel: string, lines: string[]): boolean {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return false;
  }
  for (const name of names) {
    const childRel = rel === "" ? name : `${rel}/${name}`;
    let stat: Stats;
    try {
      stat = lstatSync(join(dir, name));
    } catch {
      return false;
    }
    lines.push(`${childRel}=${entryFingerprint(stat)}`);
    if (stat.isDirectory() && !fingerprintTree(join(dir, name), childRel, lines)) return false;
  }
  return true;
}

function reportTransition(path: string, was: Look, detail?: string, deep = false): void {
  const now = look(path, deep);
  if (was.kind === "unknown" || now.kind === "unknown") return;
  let kind: WriteKind;
  if (now.kind === "absent") {
    if (was.kind === "absent") return;
    kind = "deleted";
  } else if (was.kind === "absent") {
    kind = "created";
  } else if (was.fingerprint !== now.fingerprint) {
    kind = "rewritten";
  } else {
    return;
  }
  reportWrite(kind, path, detail);
}

/** A look that failed reads as present, so the weaker claim is made. */
function kindOf(was: Look): "created" | "rewritten" {
  return was.kind === "absent" ? "created" : "rewritten";
}

// --- deferral --------------------------------------------------------------------------

/** For a command that hands the terminal to another program, so the lines land after it returns
 *  instead of being cleared by its screen. */
export function deferWriteReports(): void {
  if (deferred !== null) return;
  deferred = [];
  process.once("exit", flushWriteReports);
}

export function flushWriteReports(): string[] {
  const lines = deferred ?? [];
  deferred = null;
  process.off("exit", flushWriteReports);
  for (const line of lines) emit(line);
  return lines;
}

// --- the wrappers ----------------------------------------------------------------------

/**
 * The seam's own dry-run gate: every wrapper below records the write as a plan and touches nothing
 * while a dry run collects, unless the path is scratch this process minted (a probe's throwaway
 * config must exist for the probe to run). So a mutation reached outside a plan's apply (a daemon's
 * activity mark cleared on stop) is previewed like one inside it, and nothing in src/ can write
 * behind a dry run: the fs-write lint keeps every raw write out of everything but this file, the
 * lock protocol (which takes no lock in a dry run), and the migrations.
 */
/** How a recorded write renders.
 *    diff       -> the text it replaces is read too, so the plan shows the changed lines
 *    path-only  -> the path alone: a file holding credentials (a settings bundle), or a move, whose
 *                  "change" is the whole source file and may hold a store's tokens; a move's text
 *                  is still shadowed at the destination for the run's later readers */
type PlannedRender = "diff" | "path-only";

/** The refusals the syscall a wrapper lands with makes, taken by the plan too: `syscall` is the
 *  phrase node:fs puts after the code; `directory` says which directory at the target the syscall
 *  refuses with EISDIR: the one an open reaches through a link (`followed`), the entry itself as a
 *  rename sees it (`entry`, a link there is replaced), or none (a directory move). */
interface PlanRefusals {
  syscall: string;
  directory: "followed" | "entry" | "none";
}

/** A look through the run's own landings: a path this dry run planned gone is absent, one it
 *  planned written is present, whatever the disk still shows. */
function plannedLook(path: string, deep = false): Look {
  const shadow = shadowedText(path);
  if (shadow === null) return { kind: "absent" };
  if (shadow !== undefined) return { kind: "present", fingerprint: "" };
  return look(path, deep);
}

function planned(
  kind: FileVerdict,
  path: string,
  text: { content?: string; render: PlannedRender; directory?: true } = { render: "diff" },
  refusals?: PlanRefusals,
): boolean {
  if (!dryRunActive() || underScratch(path)) return false;
  if (refusals !== undefined && kind !== "delete" && text.directory === undefined) {
    // Only a mkdir makes a parent: a create under one that is neither present nor planned by this
    // run is the syscall's ENOENT. A directory at a file's target is its EISDIR.
    // An open follows a link, so the parent that must be there is the link target's; the parent
    // itself is judged as the syscall reaches it (through its own links).
    const landing = refusals.directory === "followed"
      ? followedTarget(path, refusals.syscall)
      : path;
    const parent = dirname(landing);
    if (!plannedDirectory(parent)) {
      const refusal = parentRefusal(parent, refusals.syscall);
      if (refusal !== null) throw refusal;
    }
    // The target as the run leaves it: a directory this run planned gone is gone; one still there
    // is the syscall's EISDIR.
    const directory = refusals.directory === "none" || shadowedText(path) === null
      ? false
      : refusals.directory === "followed"
      ? isDir(path)
      : isDirectoryEntry(path);
    if (directory) {
      // Windows opens a directory for writing with EINVAL; every other refusal here is EISDIR.
      throw refusals.directory === "followed" && process.platform === "win32"
        ? errno("EINVAL", `invalid argument, ${refusals.syscall}`)
        : errno("EISDIR", `illegal operation on a directory, ${refusals.syscall}`);
    }
  }
  if (text.render === "path-only") {
    landPlan({
      files: [filePlan(path, kind, text.content === undefined ? {} : { content: text.content })],
      apply() {},
    });
    return true;
  }
  // A file that is not text (a directory, a binary) carries no `before`, and the plan names the
  // path alone.
  const was = kind === "create" ? null : readTextResult(path);
  const before = was === null ? null : was.kind === "text" ? was.text : undefined;
  landPlan({
    files: [
      filePlan(path, kind, {
        before,
        ...(text.content === undefined ? {} : { content: text.content }),
        ...(text.directory === undefined ? {} : { directory: text.directory }),
      }),
    ],
    apply() {},
  });
  return true;
}

/** The render a caller's `secret` flag asks for. */
function renderOf(secret: boolean | undefined): PlannedRender {
  return secret ? "path-only" : "diff";
}

/** Where an open of `path` lands: the end of its symlink chain (each link resolved beside itself),
 *  else `path`. A chain the kernel would refuse (40 hops) is the open's ELOOP; a link that cannot
 *  be read ends the walk where it stands. */
function followedTarget(path: string, syscall: string): string {
  let current = path;
  for (let hops = 0; hops < 40; hops++) {
    try {
      if (!lstatSync(current).isSymbolicLink()) return current;
      // A relative target is relative to the link's REAL directory (a link on the way there is
      // followed first), as the kernel resolves it; a directory that cannot be resolved stands.
      const dir = dirname(current);
      current = resolve(realpathOrSelf(dir), readlinkSync(current));
    } catch {
      return current;
    }
  }
  throw errno("ELOOP", `too many symbolic links encountered, ${syscall}`);
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The refusal a syscall makes reaching `parent` (followed, as it does): a missing component or a
 *  dangling link is ENOENT, a regular file on the way or at the end ENOTDIR, a link cycle ELOOP. */
function parentRefusal(parent: string, syscall: string): NodeJS.ErrnoException | null {
  try {
    return statSync(parent).isDirectory() ? null : errno("ENOTDIR", `not a directory, ${syscall}`);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ELOOP") return errno("ELOOP", `too many symbolic links encountered, ${syscall}`);
    if (code === "ENOTDIR") return errno("ENOTDIR", `not a directory, ${syscall}`);
    return errno("ENOENT", `no such file or directory, ${syscall}`);
  }
}

/** The error node:fs raises for `code`, spelled as it spells it. */
function errno(code: string, detail: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`${code}: ${detail}`);
  err.code = code;
  return err;
}

/** A write's verdict from the look that precedes it. */
function verdictOf(was: Look): FileVerdict {
  return was.kind === "absent" ? "create" : "rewrite";
}

export function writeFileReported(
  path: string,
  data: string | Uint8Array,
  options?: { mode?: number; detail?: string; secret?: boolean },
): void {
  const was = plannedLook(path);
  if (
    planned(verdictOf(was), path, {
      content: typeof data === "string" ? data : undefined,
      render: renderOf(options?.secret),
    }, { syscall: `open '${path}'`, directory: "followed" })
  ) return;
  try {
    writeFileSync(path, data, { mode: options?.mode });
  } catch (err) {
    reportTransition(path, was, "write failed");
    throw err;
  }
  reportWrite(kindOf(was), path, options?.detail);
}

export function copyFileReported(from: string, to: string, detail?: string): void {
  const was = plannedLook(to);
  if (
    planned(verdictOf(was), to, undefined, {
      syscall: `copyfile '${from}' -> '${to}'`,
      directory: "followed",
    })
  ) return;
  try {
    copyFileSync(from, to);
  } catch (err) {
    reportTransition(to, was, "copy failed");
    throw err;
  }
  reportWrite(kindOf(was), to, detail);
}

/** Names every directory actually created, outermost first; `detail` rides on the directory asked
 *  for. An ancestor that exists as a regular file is mkdir's ENOTDIR, in a dry run too. */
export function mkdirReported(path: string, mode?: number, detail?: string): void {
  const missing = missingDirectories(path);
  if (dryRunActive() && !underScratch(path)) {
    for (const made of missing) planned("create", made, { render: "diff", directory: true });
    return;
  }
  try {
    mkdirSync(path, { recursive: true, mode });
  } catch (err) {
    for (const made of missing) reportTransition(made, { kind: "absent" });
    throw err;
  }
  for (const made of missing) reportWrite("created", made, made === path ? detail : undefined);
}

/** A mode change is a rewrite of the entry, deduped away when this process already announced the
 *  path. */
export function chmodReported(path: string, mode: number, detail?: string): void {
  if (planned("rewrite", path)) return;
  chmodSync(path, mode);
  reportWrite("rewritten", path, detail);
}

/** A directory at the path is refused (a caller that meant a file must never take a tree; a
 *  symlink is the link, not what it points at) by the seam itself and before any plan, so a dry run
 *  refuses where the real run does. A path this dry run already landed reads through its plan:
 *  planned written is present, planned deleted is gone. */
export function removeReported(path: string, detail?: string): boolean {
  const shadow = shadowedText(path);
  if (shadow === null) return false;
  if (shadow === undefined) {
    if (look(path).kind === "absent") return false;
    assertNotDirectory(path);
  }
  if (planned("delete", path)) return true;
  rmSync(path, { force: true });
  reportWrite("deleted", path, detail);
  return true;
}

/** Whether the entry at `path` itself (a link never followed) is a directory. */
function isDirectoryEntry(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** removeReported's refusal, for a caller that plans a removal ahead of its apply: raised at plan
 *  time, a dry run refuses where the real run does instead of previewing a delete the apply would
 *  refuse. A symlink is the link, not what it points at. */
export function assertNotDirectory(path: string): void {
  if (isDirectoryEntry(path)) {
    throw new Error(`${path} is a directory; only a file can be removed here`);
  }
}

/** A removal that fails partway is named for what it provably changed. */
export function removeTreeReported(path: string, detail?: string): boolean {
  const was = look(path, true);
  if (was.kind === "absent") return false;
  if (planned("delete", path)) return true;
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (err) {
    reportTransition(path, was, "partly removed", true);
    throw err;
  }
  reportWrite("deleted", path, detail);
  return true;
}

/** A transient whose removal fails is a file the user now keeps, so it is named (the one moment a
 *  transient is reported), but only as the transition `was` proves: a recipe that never wrote it
 *  says nothing. */
function dropTransient(path: string, was: Look, recursive = false): void {
  try {
    rmSync(path, { recursive, force: true });
  } catch {
    reportTransition(path, was, "left behind", recursive);
  }
}

/** rmdir's own refusals, taken before any plan so a dry run refuses where the real run does: a
 *  regular file is not a directory, and a directory with entries (this run's planned deletions and
 *  creations counted) is unknown data. A link (a Windows junction at `current`) is the entry rmdir
 *  removes, never what it points at. Exported for the update planner, whose `current` flip takes
 *  the same decision. */
export function refuseRmdir(path: string): void {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) return;
  if (!stat.isDirectory()) throw errno("ENOTDIR", `not a directory, rmdir '${path}'`);
  if (readPlannedDir(path).length > 0) {
    throw errno("ENOTEMPTY", `directory not empty, rmdir '${path}'`);
  }
}

export function removeEmptyDirReported(path: string): void {
  if (look(path).kind === "absent") return;
  refuseRmdir(path);
  if (planned("delete", path)) return;
  rmdirSync(path);
  reportWrite("deleted", path);
}

/** A move OUT of a scratch dir is the creation of `to` (the source never existed for the user); a
 *  move INTO one is the deletion of `from`. */
export function renameReported(from: string, to: string): void {
  const was = plannedLook(to, true);
  if (dryRunActive() && !underScratch(to)) {
    // The moved file's text lands at `to` for the run's later readers; the plan names the move,
    // never the text (a moved store holds its tokens).
    const source = readTextResult(from);
    planned(verdictOf(was), to, {
      content: source.kind === "text" ? source.text : undefined,
      render: "path-only",
    }, {
      syscall: `rename '${from}' -> '${to}'`,
      directory: isDirectoryEntry(from) ? "none" : "entry",
    });
    planned("delete", from);
    return;
  }
  try {
    renameSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    const source = look(from, true);
    try {
      cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    } catch (err) {
      // A partial copy is a change.
      reportTransition(to, was, "copy failed", true);
      throw err;
    }
    try {
      rmSync(from, { recursive: true, force: true });
    } catch (err) {
      // The copy landed but the source would not (fully) go: no move happened.
      reportWrite(kindOf(was), to);
      reportTransition(from, source, "partly removed", true);
      throw err;
    }
  }
  if (underScratch(from)) {
    reportWrite(kindOf(was), to);
    return;
  }
  if (underScratch(to)) {
    reportWrite("deleted", from);
    return;
  }
  REPORTED.delete(from);
  forgetBelow(from);
  reportWrite("moved", to, `from ${from}`);
}

export function symlinkReported(target: string, path: string, type?: "junction"): void {
  if (
    planned(verdictOf(plannedLook(path)), path, undefined, {
      syscall: `symlink '${target}' -> '${path}'`,
      directory: "none",
    })
  ) return;
  symlinkSync(target, path, type);
  reportWrite("linked", path, `to ${target}`);
}

/** The replacement link is built aside and renamed over `link`, so a concurrent reader never sees a
 *  missing link. */
export function atomicSymlink(target: string, link: string): void {
  if (
    planned(verdictOf(plannedLook(link)), link, undefined, {
      syscall: `rename '${
        join(dirname(link), `.${basename(link)}-next-${process.pid}`)
      }' -> '${link}'`,
      directory: "entry",
    })
  ) return;
  const staged = join(dirname(link), `.${basename(link)}-next-${process.pid}`);
  rmSync(staged, { force: true });
  const was = look(staged);
  symlinkSync(target, staged);
  try {
    renameSync(staged, link);
  } catch (err) {
    dropTransient(staged, was);
    throw err;
  }
  reportWrite("linked", link, `to ${target}`);
}

/**
 * A file opened for writing (created or truncated at the open, which is the mutation reported):
 * the one way runtime code streams bytes to a path (a release download, the daemon's log), so the
 * fs-write lint can refuse a write-flag open anywhere else. A dry run has no handle to hand back
 * and refuses outside scratch: no dry-run path reaches a stream write, and one that did would be a
 * write behind the plan.
 */
export async function openWritableReported(path: string, detail?: string): Promise<Deno.FsFile> {
  const was = plannedLook(path);
  refuseHandleInDryRun(path);
  const file = await Deno.open(path, { write: true, create: true, truncate: true });
  reportWrite(kindOf(was), path, detail);
  return file;
}

/** openWritableReported as a node fd, for a child's stdio. */
export function openWriteFdReported(path: string, detail?: string): number {
  const was = plannedLook(path);
  refuseHandleInDryRun(path);
  const fd = openSync(path, "w");
  reportWrite(kindOf(was), path, detail);
  return fd;
}

function refuseHandleInDryRun(path: string): void {
  if (dryRunActive() && !underScratch(path)) {
    throw new Error(`${path}: a dry run opens no file for writing`);
  }
}

/** Nothing written under it is reported, because removeScratchDir takes it all away before exit. */
export function scratchDir(prefix: string): ScratchDir {
  const dir = mkdtempSync(prefix) as ScratchDir;
  SCRATCH_ROOTS.add(dir);
  return dir;
}

/** A removal that fails names the root it left behind, the one scratch fact the user then keeps. */
export function removeScratchDir(dir: ScratchDir): void {
  if (!SCRATCH_ROOTS.has(dir)) throw new Error(`${dir} is not a scratch dir of this process`);
  SCRATCH_ROOTS.delete(dir);
  // Minted by us from nothing: whatever a failed removal leaves is a creation.
  dropTransient(dir, { kind: "absent" }, true);
}

// --- the dry-run marker ------------------------------------------------------------------

/** Set in the environment of every process a dry run spawns (the Direct probes' agent CLIs, whose
 *  auth helper is this CLI again) so a child that finds it runs as a silent dry run, and nothing
 *  this CLI does on the child's behalf lands behind the plan either. The value is the marker the
 *  spawning run minted (underDryRunMarker): the path of a scratch directory named with a fresh
 *  nonce, whose hold file that run keeps under an exclusive OS lock for as long as it collects. A
 *  child honours the value only while a live process holds that lock (spawnedByDryRun), so a
 *  value that reached an environment any other way (`=1` exported in a shell, a pid, a nonce with
 *  no run behind it, a directory made by hand, a marker a crashed run left behind) names nothing
 *  and changes nothing: liveness of some process is not authorship of this one. */
export const DRY_RUN_ENV = "COPILOT_ENV_DRY_RUN";

const DRY_RUN_MARKER_PREFIX = "copilot-env-dry-run-";
const DRY_RUN_MARKER_NAME = new RegExp(`^${DRY_RUN_MARKER_PREFIX}[0-9a-f]{32}$`);
/** The file inside the marker the minting run holds locked (flock/LockFileEx, which a crashed
 *  holder releases automatically). */
const DRY_RUN_MARKER_HOLD = "held";

/** The marker this process minted, while its run collects: the OS may report a same-process
 *  attempt on our own lock either way, so our own marker answers from the record. */
let minted: string | null = null;

/**
 * Runs `body` with a dry run's marker minted, held, and exported (DRY_RUN_ENV), so every process
 * the body spawns inherits it and runs as a silent dry run. When the body ends the lock is
 * released, the marker removed, and the variable restored, so no value outlives the run that
 * minted it.
 */
export async function underDryRunMarker<T>(body: () => Promise<T>): Promise<T> {
  const marker = join(tmpdir(), `${DRY_RUN_MARKER_PREFIX}${randomBytes(16).toString("hex")}`);
  mkdirSync(marker, { mode: 0o700 });
  SCRATCH_ROOTS.add(marker);
  const hold = Deno.openSync(join(marker, DRY_RUN_MARKER_HOLD), {
    read: true,
    write: true,
    create: true,
  });
  if (!hold.tryLockSync(true)) {
    hold.close();
    removeScratchDir(marker as ScratchDir);
    throw new Error(`the dry-run marker ${marker} is held by another process`);
  }
  const inherited = process.env[DRY_RUN_ENV];
  process.env[DRY_RUN_ENV] = marker;
  minted = marker;
  try {
    return await body();
  } finally {
    minted = null;
    if (inherited === undefined) delete process.env[DRY_RUN_ENV];
    else process.env[DRY_RUN_ENV] = inherited;
    hold.unlockSync();
    hold.close();
    removeScratchDir(marker as ScratchDir);
  }
}

/** Whether `env` carries a dry run's marker this process must honour (see DRY_RUN_ENV). */
export function spawnedByDryRun(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[DRY_RUN_ENV];
  if (value === undefined || !isAbsolute(value) || !DRY_RUN_MARKER_NAME.test(basename(value))) {
    return false;
  }
  return value === minted || markerHeld(value);
}

/** A SHARED try-lock on the hold file that succeeds means no run holds the marker (a directory
 *  made by hand, a run that ended or crashed); only the minting run's EXCLUSIVE lock reads held. A
 *  hold file that cannot be opened is no marker either. */
function markerHeld(marker: string): boolean {
  let file: Deno.FsFile;
  try {
    file = Deno.openSync(join(marker, DRY_RUN_MARKER_HOLD), { read: true, write: true });
  } catch {
    return false;
  }
  try {
    if (!file.tryLockSync(false)) return true;
    file.unlockSync();
    return false;
  } catch {
    return false;
  } finally {
    file.close();
  }
}

/** A same-directory temp file (`<name>.tmp.<pid>`: one writer per process at a time, so the pid
 *  alone keeps writers apart) renamed over the target, so a reader never sees a torn file. `mode`
 *  restricts the temp file from creation, so the rename publishes an already-restricted inode. */
export function atomicWriteFile(
  path: string,
  text: string,
  mode?: number,
  detail?: string,
  options?: { secret?: boolean },
): void {
  mkdirReported(dirname(path));
  const was = plannedLook(path);
  const tmp = join(dirname(path), `${basename(path)}.tmp.${process.pid}`);
  // The rename over the target is the write's landing: a directory entry there is its EISDIR (a
  // link there is replaced, as rename replaces it).
  if (
    planned(verdictOf(was), path, { content: text, render: renderOf(options?.secret) }, {
      syscall: `rename '${tmp}' -> '${path}'`,
      directory: "entry",
    })
  ) return;
  // A stale temp from a crashed run under this pid goes first: `mode` applies only to a fresh
  // inode, so writing into it would publish its old permissions. Through the seam, because with pid
  // reuse the path could be a file the user made.
  removeReported(tmp, "stale temp file");
  const tmpWas = look(tmp);
  try {
    writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
  } catch (err) {
    dropTransient(tmp, tmpWas);
    throw err;
  }
  try {
    renameWithRetry(tmp, path);
  } catch (err) {
    dropTransient(tmp, tmpWas);
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== undefined && RENAME_REFUSED_CODES.has(code)) {
      throw new RenameRefusedError(path, err);
    }
    throw err;
  }
  reportWrite(kindOf(was), path, detail);
}

/** What a rename refused by an open handle on the destination surfaces (Windows: the daemon,
 *  antivirus, the search indexer). */
const RENAME_REFUSED_CODES: ReadonlySet<string> = new Set(["EPERM", "EBUSY", "EACCES"]);

/** The live file is untouched; the staged copy is dropped where removal succeeded, and a leftover
 *  is reported. The one failure a caller may answer with a direct write (the installer's launcher
 *  shims); every other failure propagates as itself. */
export class RenameRefusedError extends Error {
  constructor(readonly path: string, cause: unknown) {
    super(`rename over ${path} refused (the file is held open)`, { cause });
    this.name = "RenameRefusedError";
  }
}

/** A POSIX rename over an open destination always succeeds; Windows transiently refuses it while
 *  another process holds the file open. */
export function renameWithRetry(
  from: string,
  to: string,
  attempts = 5,
  rename: (f: string, t: string) => void = renameSync,
): void {
  for (let i = 0; i <= attempts; i++) {
    try {
      rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i >= attempts || code === undefined || !RENAME_REFUSED_CODES.has(code)) {
        throw err;
      }
      sleepSync(50);
    }
  }
}
