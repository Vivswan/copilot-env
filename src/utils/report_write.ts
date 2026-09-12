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
  const bytes = ENCODER.encode(`${line}\n`);
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

/** Names every directory actually created, outermost first; `detail` rides on the directory asked
 *  for. */
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

/** A mode change is a rewrite of the entry, deduped away when this process already announced the
 *  path. */
export function chmodReported(path: string, mode: number, detail?: string): void {
  chmodSync(path, mode);
  reportWrite("rewritten", path, detail);
}

/** A directory at the path throws, as rmSync does without `recursive`: a caller that meant a file
 *  must never take a tree. */
export function removeReported(path: string, detail?: string): boolean {
  if (look(path).kind === "absent") return false;
  rmSync(path, { force: true });
  reportWrite("deleted", path, detail);
  return true;
}

/** A removal that fails partway is named for what it provably changed. */
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

export function removeEmptyDirReported(path: string): void {
  if (look(path).kind === "absent") return;
  rmdirSync(path);
  reportWrite("deleted", path);
}

/** A move OUT of a scratch dir is the creation of `to` (the source never existed for the user); a
 *  move INTO one is the deletion of `from`. */
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

/** The replacement link is built aside and renamed over `link`, so a concurrent reader never sees a
 *  missing link. */
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

/** A same-directory temp file (`<name>.tmp.<pid>`: one writer per process at a time, so the pid
 *  alone keeps writers apart) renamed over the target, so a reader never sees a torn file. `mode`
 *  restricts the temp file from creation, so the rename publishes an already-restricted inode. */
export function atomicWriteFile(
  path: string,
  text: string,
  mode?: number,
  detail?: string,
): void {
  mkdirReported(dirname(path));
  const was = look(path);
  const tmp = join(dirname(path), `${basename(path)}.tmp.${process.pid}`);
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
