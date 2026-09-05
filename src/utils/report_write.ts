// The one write-reporting seam: every file a command creates, rewrites, deletes, moves
// or links is named on stderr -- "<kind> -> <path>" -- once per process, so nothing a
// command does to the disk is hidden. Always stderr, written raw (not through consola,
// whose level a CONSOLA_LEVEL could silence): the machine-readable stdout contracts
// (`agent env`, `--json`, `auth --get`, the proxy-token key line) survive, and the lines
// cannot be turned off.
//
// Every raw filesystem mutation in src/ goes through the wrappers below (the lint rule
// in test/lint/no_unreported_fs_writes.ts refuses a raw node:fs write anywhere else,
// bar the lock protocol's internals in file_lock.ts). Two things are NOT reported:
//   - scratch: a temp dir this process creates AND removes before it exits
//     (scratchDir/removeScratchDir) -- nothing under it is a file the user keeps;
//   - the transient side of a recipe: the temp file an atomic write publishes by
//     rename, the marker file the lock protocol creates and deletes per acquisition.
//
// Dedup is per path, with a delete as the epoch boundary: a store saved five times in
// one run prints once, a create followed by a rewrite of the same path is one fact, and
// a delete clears the slate so a later re-creation (or re-link, or a second delete after
// it) is announced again.
import {
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { entryAbsent, isEnoentOrNotdir } from "./fs.ts";
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

/** After a mutation threw: whatever did land at `path` is a change the user keeps. */
function reportIfLanded(kind: WriteKind, path: string, detail?: string): void {
  if (!entryAbsent(path)) reportWrite(kind, path, detail);
}

/** Announce one mutation of `path`. The primitive for writers whose mutation happens
 *  through another API (the lock sidecar's create-on-open); everything else uses the
 *  wrappers below, which pick the kind themselves. */
export function reportWrite(kind: WriteKind, path: string, detail?: string): void {
  if (underScratch(path)) return;
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

/** One look at a path for withReportedPaths: present (mtime+size), proven absent, or a
 *  look that FAILED (permissions, a transient error) -- which never reads as absent, or
 *  a report would be fabricated from it. */
type PathStat =
  | { kind: "present"; mtimeMs: number; size: number }
  | { kind: "absent" }
  | { kind: "unknown" };

function pathStat(path: string): PathStat {
  try {
    const stat = statSync(path);
    return { kind: "present", mtimeMs: stat.mtimeMs, size: stat.size };
  } catch (e) {
    return isEnoentOrNotdir(e) ? { kind: "absent" } : { kind: "unknown" };
  }
}

/**
 * Run `fn` and name every one of `paths` it created, rewrote or removed -- for writes
 * another library makes on our behalf (SQLite's database and WAL sidecars), where the
 * mutation is not ours to wrap. Judged by a stat before and after, on every exit path;
 * a look that failed on either side proves nothing, so nothing is said about that path.
 */
export function withReportedPaths<T>(paths: readonly string[], fn: () => T): T {
  const before = paths.map((path) => [path, pathStat(path)] as const);
  try {
    return fn();
  } finally {
    for (const [path, was] of before) {
      const now = pathStat(path);
      if (was.kind === "unknown" || now.kind === "unknown") continue;
      if (now.kind === "absent") {
        if (was.kind === "present") reportWrite("deleted", path);
      } else if (was.kind === "absent") {
        reportWrite("created", path);
      } else if (was.mtimeMs !== now.mtimeMs || was.size !== now.size) {
        reportWrite("rewritten", path);
      }
    }
  }
}

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
  for (const line of lines) emit(line);
  return lines;
}

function kindFor(path: string): "created" | "rewritten" {
  return entryAbsent(path) ? "created" : "rewritten";
}

export function writeFileReported(
  path: string,
  data: string | Uint8Array,
  options?: { mode?: number },
): void {
  const kind = kindFor(path);
  try {
    writeFileSync(path, data, options);
  } catch (err) {
    reportIfLanded(kind, path, "write failed");
    throw err;
  }
  reportWrite(kind, path);
}

export function copyFileReported(from: string, to: string): void {
  const kind = kindFor(to);
  try {
    copyFileSync(from, to);
  } catch (err) {
    reportIfLanded(kind, to, "copy failed");
    throw err;
  }
  reportWrite(kind, to);
}

/** mkdir -p, naming every directory it actually creates (missing ancestors too,
 *  outermost first). */
export function mkdirReported(path: string, mode?: number): void {
  const missing: string[] = [];
  for (let cur = path; entryAbsent(cur); cur = dirname(cur)) {
    missing.unshift(cur);
    if (dirname(cur) === cur) break;
  }
  try {
    mkdirSync(path, { recursive: true, mode });
  } catch (err) {
    for (const made of missing) reportIfLanded("created", made);
    throw err;
  }
  for (const made of missing) reportWrite("created", made);
}

/** A mode change is a rewrite of the entry; deduped away when this process already
 *  announced writing the path. */
export function chmodReported(path: string, mode: number): void {
  chmodSync(path, mode);
  reportWrite("rewritten", path);
}

/** Remove ONE entry (a file, a symlink); a directory at the path throws, as rmSync does
 *  without `recursive` -- a caller that meant a file must never take a tree. Returns
 *  whether anything was there to remove. */
export function removeReported(path: string): boolean {
  if (entryAbsent(path)) return false;
  rmSync(path, { force: true });
  reportWrite("deleted", path);
  return true;
}

/** rm -rf; returns whether anything was there to remove. A removal that fails partway
 *  has still changed the tree, which is named as such. */
export function removeTreeReported(path: string): boolean {
  if (entryAbsent(path)) return false;
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (err) {
    reportIfLanded("rewritten", path, "partly removed");
    throw err;
  }
  reportWrite("deleted", path);
  return true;
}

/** Discard a transient (a staged temp file or link, a scratch root) after the recipe it
 *  served is over. When the removal fails the transient is a file the user now keeps, so
 *  it is named -- the one moment a transient is reported. */
function dropTransient(path: string, recursive = false): void {
  try {
    rmSync(path, { recursive, force: true });
  } catch {
    reportWrite("created", path, "left behind");
  }
}

/** rmdir (non-recursive: throws on a non-empty directory, like rmdirSync). Absent is a
 *  no-op. */
export function removeEmptyDirReported(path: string): void {
  if (entryAbsent(path)) return;
  rmdirSync(path);
  reportWrite("deleted", path);
}

/** Move `from` to `to` (copy+delete across devices). A move OUT of a scratch dir is the
 *  creation of `to` (the source never existed for the user); a move INTO one is the
 *  deletion of `from`. */
export function renameReported(from: string, to: string): void {
  const kind = kindFor(to);
  try {
    renameSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    try {
      cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    } catch (err) {
      reportIfLanded(kind, to, "copy failed"); // a partial copy is still a change
      throw err;
    }
    try {
      rmSync(from, { recursive: true, force: true });
    } catch (err) {
      // The copy landed but the source would not (fully) go: no move happened.
      reportWrite(kind, to);
      reportIfLanded("rewritten", from, "partly removed");
      throw err;
    }
  }
  if (underScratch(from)) {
    reportWrite(kind, to);
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
  const staged = join(dirname(link), `.${basename(link)}-next-${process.pid}-${Date.now()}`);
  rmSync(staged, { force: true });
  symlinkSync(target, staged);
  try {
    renameSync(staged, link);
  } catch (err) {
    dropTransient(staged);
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
  dropTransient(dir, true);
}

/**
 * THE atomic file-write recipe: write to a fresh same-directory temp file
 * (`<name>.tmp.<pid>.<now>`, unique per writer), then renameWithRetry over the
 * target -- a reader never sees a torn file. The temp file is removed on failure.
 * `mode` (when given) restricts the temp file from creation, so the rename
 * publishes an already-restricted inode. Shared by the JSON store's save
 * (src/copilot_api/config.ts), saveClaudeJson (src/claude/mcp_registration.ts), the
 * proxy float's records and the installer's launcher shims.
 */
export function atomicWriteFile(path: string, text: string, mode?: number): void {
  mkdirReported(dirname(path));
  const kind = kindFor(path);
  const tmp = join(dirname(path), `${basename(path)}.tmp.${process.pid}.${Date.now()}`);
  try {
    writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
  } catch (err) {
    dropTransient(tmp);
    throw err;
  }
  try {
    renameWithRetry(tmp, path);
  } catch (err) {
    dropTransient(tmp);
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== undefined && RENAME_REFUSED_CODES.has(code)) {
      throw new RenameRefusedError(path, err);
    }
    throw err;
  }
  reportWrite(kind, path);
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
