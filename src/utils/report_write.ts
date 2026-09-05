// The one write-reporting seam: every file a command creates, rewrites, deletes, moves
// or links OUTSIDE copilot-env's own homes is named on stderr -- "<kind> -> <path>" --
// once per process, so nothing a command does to the user's disk is hidden. Always
// stderr, written raw (not through consola, whose level a CONSOLA_LEVEL could silence):
// the machine-readable stdout contracts (`agent env`, `--json`, `auth --get`, the
// proxy-token key line) survive, and the lines cannot be turned off.
//
// Every raw filesystem mutation in src/ goes through the wrappers below (the lint rule
// in test/lint/no_unreported_fs_writes.ts refuses a raw node:fs write anywhere else,
// bar the lock protocol's internals in file_lock.ts); the seam then decides what prints.
// Three things are NOT reported:
//   - copilot-env's own homes: everything INSIDE the install root (~/.copilot-env:
//     versions, the current link, shims, caches) and the data home
//     (~/.local/share/copilot-env: stores, lock sidecars, profile and daemon homes, the
//     usage index) is internal bookkeeping. Each home's owner registers its root through
//     hideWritesUnder; the roots THEMSELVES still report when created or removed.
//   - scratch: a temp dir this process creates AND removes before it exits
//     (scratchDir/removeScratchDir) -- nothing under it is a file the user keeps;
//   - the transient side of a recipe: the temp file an atomic write publishes by
//     rename, the marker file the lock protocol creates and deletes per acquisition.
//
// A line is printed only for a mutation that PROVABLY landed: on success, the kind the
// operation performed; after a failure, only what a before/after look at the path proves
// changed (absent then present, present then absent, or a different identity, mtime or
// size) -- never from "the path still exists", which a refused write leaves true.
//
// One line per path: a writer that has something to say about a write (which config it
// is, why the entry went) says it in the line's `detail` instead of a second line naming
// the same path. Dedup is per path, with a delete as the epoch boundary: a store saved five times in
// one run prints once, a create followed by a rewrite of the same path is one fact, and
// a delete clears the slate so a later re-creation (or re-link, or a second delete after
// it) is announced again.
import {
  chmodSync,
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  type Stats,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { isEnoentOrNotdir } from "./fs.ts";
import { sleepSync } from "./time.ts";

export type WriteKind = "created" | "rewritten" | "deleted" | "moved" | "linked";

/** The kinds already announced per path (see the dedup rule in the header). */
const REPORTED = new Map<string, Set<WriteKind>>();

declare const scratchBrand: unique symbol;

/** A temp root minted by scratchDir: the only thing removeScratchDir accepts, so a
 *  permanent directory can never be removed silently through the scratch path. */
export type ScratchDir = string & { readonly [scratchBrand]: true };

/** Temp roots this process owns for its own lifetime; writes under them are not reported. */
const SCRATCH_ROOTS = new Set<string>();

/** The resolvers of copilot-env's own homes (see the header), registered by each home's
 *  owner when it loads: the data home by src/copilot_api/paths.ts, the install root by
 *  src/utils/root.ts. Resolved per report, because a home follows the environment. */
const INTERNAL_ROOTS: (() => string)[] = [];

/** Register one of copilot-env's own homes: writes INSIDE it print nothing. */
export function hideWritesUnder(root: () => string): void {
  INTERNAL_ROOTS.push(root);
}

/** Whether `path` sits strictly inside one of the registered homes (the home itself is
 *  a path the user sees come and go, so it is not inside). Compared as resolved paths,
 *  case-insensitively on Windows. */
function insideInternalRoot(path: string): boolean {
  const fold = (p: string): string => {
    const r = resolve(p);
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  const target = fold(path);
  return INTERNAL_ROOTS.some((root) => target.startsWith(fold(root()) + sep));
}

/** Non-null while reports are deferred to process exit (deferWriteReports). */
let deferred: string[] | null = null;

function underScratch(path: string): boolean {
  for (const root of SCRATCH_ROOTS) {
    if (path === root || path.startsWith(root + sep)) return true;
  }
  return false;
}

const ENCODER = new TextEncoder();

/** Write one line to stderr synchronously, in full: a buffered stream write could still
 *  be pending when a process.exit() (a signal handler's) ends the process. */
function emit(line: string): void {
  if (deferred !== null) {
    deferred.push(line);
    return;
  }
  const bytes = ENCODER.encode(`${line}\n`);
  let written = 0;
  while (written < bytes.length) written += Deno.stderr.writeSync(bytes.subarray(written));
}

/** Announce one mutation of `path`. The primitive for writers whose mutation happens
 *  through another API (the lock sidecar's create-on-open); everything else uses the
 *  wrappers below, which pick the kind themselves. */
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

/** A tree that went (deleted, or moved away) takes every recorded descendant with it, so
 *  a child re-created afterwards is announced again. */
function forgetBelow(path: string): void {
  for (const recorded of REPORTED.keys()) {
    if (recorded.startsWith(path + sep)) REPORTED.delete(recorded);
  }
}

// --- the before/after look -----------------------------------------------------------

/** One look at a path: present, with a fingerprint of the identity a change would alter
 *  (dev, inode, mtime, size); proven absent (lstat's own ENOENT/ENOTDIR -- a dangling
 *  symlink IS present); or a look that FAILED (permissions, a transient error), which
 *  never reads as absent or a report would be fabricated from it. A DEEP look at a
 *  directory fingerprints its whole tree, one line per descendant keyed by its FULL
 *  relative path (so moving an entry between levels changes the fingerprint even when
 *  no directory metadata does), and a change anywhere below shows at the root -- the
 *  shape a tree operation (rm -rf, a cross-device copy, a `deno cache` run) is judged by. */
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

/** Append `<relative path>=<entry fingerprint>` for every descendant of `dir`, sorted;
 *  false when a level cannot be listed or an entry vanishes mid-walk (a tree that cannot
 *  be judged). */
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

/** Report what a second look at `path` PROVES changed since `was`: nothing when either
 *  look failed, or when the fingerprint is unchanged. */
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

/** The kind a write to `path` performs: creation when it is absent, else a rewrite (a
 *  look that failed reads as present, so the weaker claim is made). */
function kindOf(was: Look): "created" | "rewritten" {
  return was.kind === "absent" ? "created" : "rewritten";
}

// --- deferral --------------------------------------------------------------------------

/** Hold every report until the process exits (or flushWriteReports runs): for a command
 *  that hands the terminal to another program, so the lines land after it returns
 *  instead of being cleared by its screen. */
export function deferWriteReports(): void {
  if (deferred !== null) return;
  deferred = [];
  process.once("exit", flushWriteReports);
}

/** Print the deferred reports now and return to immediate reporting. Returns the lines
 *  it printed. */
export function flushWriteReports(): string[] {
  const lines = deferred ?? [];
  deferred = null;
  process.off("exit", flushWriteReports);
  for (const line of lines) emit(line);
  return lines;
}

// --- the wrappers ----------------------------------------------------------------------

export function writeFileReported(
  path: string,
  data: string | Uint8Array,
  options?: { mode?: number; detail?: string },
): void {
  const was = look(path);
  try {
    writeFileSync(path, data, { mode: options?.mode });
  } catch (err) {
    reportTransition(path, was, "write failed");
    throw err;
  }
  reportWrite(kindOf(was), path, options?.detail);
}

export function copyFileReported(from: string, to: string, detail?: string): void {
  const was = look(to);
  try {
    copyFileSync(from, to);
  } catch (err) {
    reportTransition(to, was, "copy failed");
    throw err;
  }
  reportWrite(kindOf(was), to, detail);
}

/** mkdir -p, naming every directory it actually creates (missing ancestors too,
 *  outermost first); `detail` rides on the directory asked for, not its ancestors. */
export function mkdirReported(path: string, mode?: number, detail?: string): void {
  const missing: string[] = [];
  for (let cur = path; look(cur).kind === "absent"; cur = dirname(cur)) {
    missing.unshift(cur);
    if (dirname(cur) === cur) break;
  }
  try {
    mkdirSync(path, { recursive: true, mode });
  } catch (err) {
    for (const made of missing) reportTransition(made, { kind: "absent" });
    throw err;
  }
  for (const made of missing) reportWrite("created", made, made === path ? detail : undefined);
}

/** A mode change is a rewrite of the entry; deduped away when this process already
 *  announced writing the path. */
export function chmodReported(path: string, mode: number, detail?: string): void {
  chmodSync(path, mode);
  reportWrite("rewritten", path, detail);
}

/** Remove ONE entry (a file, a symlink); a directory at the path throws, as rmSync does
 *  without `recursive` -- a caller that meant a file must never take a tree. Returns
 *  whether anything was there to remove. */
export function removeReported(path: string, detail?: string): boolean {
  if (look(path).kind === "absent") return false;
  rmSync(path, { force: true });
  reportWrite("deleted", path, detail);
  return true;
}

/** rm -rf; returns whether anything was there to remove. A removal that fails partway
 *  is named for what it provably changed (the tree's own entry, when a child went). */
export function removeTreeReported(path: string, detail?: string): boolean {
  const was = look(path, true);
  if (was.kind === "absent") return false;
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (err) {
    reportTransition(path, was, "partly removed", true);
    throw err;
  }
  reportWrite("deleted", path, detail);
  return true;
}

/** Discard a transient (a staged temp file or link, a scratch root) after the recipe it
 *  served is over. When the removal fails the transient is a file the user now keeps, so
 *  it is named -- the one moment a transient is reported -- but only as the transition
 *  `was` proves: a recipe that failed before it ever wrote the transient (a temp path
 *  already occupied by a directory) changed nothing, and says nothing. */
function dropTransient(path: string, was: Look, recursive = false): void {
  try {
    rmSync(path, { recursive, force: true });
  } catch {
    reportTransition(path, was, "left behind", recursive);
  }
}

/** rmdir (non-recursive: throws on a non-empty directory, like rmdirSync). Absent is a
 *  no-op. */
export function removeEmptyDirReported(path: string): void {
  if (look(path).kind === "absent") return;
  rmdirSync(path);
  reportWrite("deleted", path);
}

/** Move `from` to `to` (copy+delete across devices). A move OUT of a scratch dir is the
 *  creation of `to` (the source never existed for the user); a move INTO one is the
 *  deletion of `from`. */
export function renameReported(from: string, to: string): void {
  const was = look(to, true);
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
  symlinkSync(target, path, type);
  reportWrite("linked", path, `to ${target}`);
}

/** THE atomic link-replace recipe (POSIX): build the replacement link aside and rename it
 *  over `link`, so a concurrent reader never observes a missing link. The staged link is
 *  dropped when the rename fails. */
export function atomicSymlink(target: string, link: string): void {
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

/** A temp dir for this process's own lifetime (mkdtemp on `prefix`); nothing written
 *  under it is reported, because removeScratchDir takes it all away before exit. */
export function scratchDir(prefix: string): ScratchDir {
  const dir = mkdtempSync(prefix) as ScratchDir;
  SCRATCH_ROOTS.add(dir);
  return dir;
}

/** Remove a scratch dir. A root scratchDir never minted is refused outright; a removal
 *  that fails names the root it left behind (the one scratch fact the user then keeps). */
export function removeScratchDir(dir: ScratchDir): void {
  if (!SCRATCH_ROOTS.has(dir)) throw new Error(`${dir} is not a scratch dir of this process`);
  SCRATCH_ROOTS.delete(dir);
  // Minted by us from nothing: whatever a failed removal leaves is a creation.
  dropTransient(dir, { kind: "absent" }, true);
}

/**
 * THE atomic file-write recipe: write to a same-directory temp file (`<name>.tmp.<pid>`:
 * one writer per process at a time, so the pid alone keeps writers apart), then
 * renameWithRetry over the target -- a reader never sees a torn file. The temp file is
 * removed on failure.
 * `mode` (when given) restricts the temp file from creation, so the rename
 * publishes an already-restricted inode. Shared by the JSON store's save
 * (src/copilot_api/config.ts), saveClaudeJson (src/claude/mcp_registration.ts), the
 * proxy float's records and the installer's launcher shims.
 */
export function atomicWriteFile(
  path: string,
  text: string,
  mode?: number,
  detail?: string,
): void {
  mkdirReported(dirname(path));
  const was = look(path);
  const tmp = join(dirname(path), `${basename(path)}.tmp.${process.pid}`);
  // A stale temp (a crashed earlier run under this pid) goes first: `mode` applies only
  // to a fresh inode, so writing into it would publish its old permissions. Non-recursive,
  // so a directory at the path still refuses without being touched.
  rmSync(tmp, { force: true });
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

/** The error codes a rename refused by an open handle on the destination surfaces
 *  (Windows: the daemon, antivirus, the search indexer). renameWithRetry retries them. */
const RENAME_REFUSED_CODES: ReadonlySet<string> = new Set(["EPERM", "EBUSY", "EACCES"]);

/** atomicWriteFile staged the text but the publish (the rename over `path`) stayed
 *  refused past the retries: the text is intact and the live file untouched. The one
 *  failure a caller may answer with a direct write (the installer's launcher shims);
 *  every other failure is not a rename problem and must propagate as itself. */
export class RenameRefusedError extends Error {
  constructor(readonly path: string, cause: unknown) {
    super(`rename over ${path} refused (the file is held open)`, { cause });
    this.name = "RenameRefusedError";
  }
}

/**
 * Rename with a short retry. A POSIX rename over an open destination always
 * succeeds, but Windows can transiently throw EPERM/EBUSY/EACCES when another
 * process holds the file open. Retry briefly, then surface the original error.
 */
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
