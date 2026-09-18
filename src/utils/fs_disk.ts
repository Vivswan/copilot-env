// The disk side of the fs seam (fs_facade.ts): the one place in src/ that mutates the filesystem.
// Every write outside copilot-env's own homes is named on stderr through the ledger in
// report_write.ts, and a write that failed is named only for what a before/after look PROVES
// changed. test/lint/no_unreported_fs_writes.ts refuses a raw node:fs write anywhere else, bar the
// lock protocol's internals (file_lock.ts), the dry-run marker (dry_run.ts), the preload that
// patches the proxy's own stream (log_mute_preload.ts), and src/migrations/.
//
// What does not print:
//
//   inside a home registered via hideWritesUnder -> silent; the root itself still prints
//   scratch this process creates and removes     -> silent
//   a recipe's transient side (a temp file)      -> silent
//   a write that failed                          -> only what a before/after look PROVES changed
//
// TRANSITION BRIDGE. While the plan collector (collectDryRun, write_session.ts) is active, every
// write here records itself as the plan rows the wrappers landed and touches nothing, and the
// facade's reads answer from the plan's shadows: that is how a writer already on the facade
// previews exactly as one still on the wrappers. The bridge (`planned` and what it calls) goes
// with write_session.ts once every writer is on the facade and the collector is withDryRun.
import {
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  fsyncSync,
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
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isDir, isEnoentOrNotdir, readTextResult } from "./fs.ts";
import { rmDirectoryRefused } from "./fs_overlay.ts";
import {
  forgetReported,
  kindOf,
  reportWrite,
  trackScratch,
  underScratch,
  untrackScratch,
} from "./report_write.ts";
import { sleepSync } from "./time.ts";
import {
  type AttributeRow,
  bridgeRows,
  carrySecret,
  dryRunActive as planCollecting,
  filePlan,
  type FileVerdict,
  landPlan,
  plannedContent,
  plannedMissingDirectories,
  plannedState,
  readPlannedDir,
  readPlannedText,
  recordBytes,
  recordPlannedMode,
  recordSecret,
  recordShadow,
  secretOf,
  textVerdict,
} from "./write_session.ts";

declare const scratchBrand: unique symbol;

/** The only thing removeScratchDir accepts, so a permanent directory can never be removed silently
 *  through the scratch path. */
export type ScratchDir = string & { readonly [scratchBrand]: true };

// --- the before/after look -----------------------------------------------------------------------

/** A look that FAILED (permissions, a transient error) never reads as absent, or a report would be
 *  fabricated from it; a dangling symlink IS present. A deep look fingerprints the whole tree keyed
 *  by full relative path, so moving an entry between levels changes it even when no directory
 *  metadata does. */
export type Look =
  | { kind: "present"; fingerprint: string }
  | { kind: "absent" }
  | { kind: "unknown" };

export function look(path: string, deep = false): Look {
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
  if (now.kind === "absent") {
    if (was.kind === "absent") return;
    reportWrite("deleted", path, detail);
  } else if (was.kind === "absent") {
    reportWrite("created", path, detail);
  } else if (was.fingerprint !== now.fingerprint) {
    reportWrite("rewritten", path, detail);
  }
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

// --- the transition bridge -------------------------------------------------------------------------

/** How a recorded write renders.
 *    diff       -> the text it replaces is read too, so the plan shows the changed lines
 *    path-only  -> the path alone: a file holding credentials (a settings bundle), or a move, whose
 *                  "change" is the whole source file and may hold a store's tokens; a move's text
 *                  is still shadowed at the destination for the run's later readers */
type PlannedRender = "diff" | "path-only";

/** The refusals the syscall a write lands with makes, taken by the plan too: `syscall` is the
 *  phrase node:fs puts after the code; `directory` says which directory at the target the syscall
 *  refuses with EISDIR: the one an open reaches through a link (`followed`), the entry itself as a
 *  rename sees it (`entry`, a link there is replaced), or none (a directory move). */
interface PlanRefusals {
  syscall: string;
  directory: "followed" | "entry" | "none";
}

/** A look through the run's own landings: a path this dry run planned gone is absent, one it
 *  planned written (text, bytes, a copy, a link, a directory) is present, whatever the disk still
 *  shows. */
function plannedLook(path: string, deep = false): Look {
  const state = plannedState(path);
  if (state === null) return look(path, deep);
  return state.kind === "gone" ? { kind: "absent" } : { kind: "present", fingerprint: "" };
}

function planned(
  kind: FileVerdict,
  path: string,
  text: {
    content?: string;
    render: PlannedRender;
    directory?: true;
    attributes?: AttributeRow[];
    /** The landing's text is secret: the renderer prints the verdict alone, whatever an earlier
     *  landing of the path compared or declared. */
    secret?: boolean;
    /** Leaves declared secret for the path by this landing (carried by a move or a copy). */
    secretKeys?: readonly string[];
  } = { render: "diff" },
  refusals?: PlanRefusals,
): boolean {
  if (!planCollecting() || underScratch(path)) return false;
  if (refusals !== undefined && kind !== "delete" && text.directory === undefined) {
    // Only a mkdir makes a parent: a create under one that is neither present nor planned by this
    // run is the syscall's ENOENT. A directory at a file's target is its EISDIR.
    // An open follows a link, so the parent that must be there is the link target's; the parent
    // itself is judged as the syscall reaches it (through its own links).
    const landing = refusals.directory === "followed"
      ? followedTarget(path, refusals.syscall)
      : path;
    const parent = dirname(landing);
    const parentState = plannedState(parent);
    if (parentState?.kind === "gone") {
      throw errno("ENOENT", `no such file or directory, ${refusals.syscall}`);
    }
    if (
      parentState?.kind === "text" || parentState?.kind === "bytes" ||
      (parentState?.kind === "opaque" && parentState.file)
    ) {
      throw underFileRefusal(refusals.syscall);
    }
    if (parentState === null || parentState.kind === "opaque") {
      const refusal = parentRefusal(parent, refusals.syscall);
      if (refusal !== null) throw refusal;
    }
    // The target as the run leaves it: a directory this run planned gone, or replaced with a
    // file, is no directory; one still there (the disk's, or one this run made) is the syscall's
    // EISDIR.
    const state = plannedState(path);
    const directory = refusals.directory === "none"
      ? false
      : state === null || (state.kind === "opaque" && !state.file)
      ? (refusals.directory === "followed" ? isDir(path) : isDirectoryEntry(path))
      : state.kind === "dir";
    if (directory) {
      // Windows opens a directory for writing with EINVAL; every other refusal here is EISDIR.
      throw refusals.directory === "followed" && process.platform === "win32"
        ? errno("EINVAL", `invalid argument, ${refusals.syscall}`)
        : errno("EISDIR", `illegal operation on a directory, ${refusals.syscall}`);
    }
  }
  if (text.render === "path-only") {
    landPlan({
      files: [{
        ...filePlan(path, kind, text.content === undefined ? {} : { content: text.content }),
        ...(text.secret ? { secret: true } : {}),
        ...(text.secretKeys !== undefined && text.secretKeys.length > 0
          ? { secretKeys: text.secretKeys }
          : {}),
      }],
      apply() {},
    });
    return true;
  }
  // A file that is not text (a directory, a binary) carries no `before`, and the plan names the
  // path alone. `before` is the text as the run sees it: an earlier landing's planned text, else
  // the disk's. So a second landing that restores the disk bytes records `rewrite` against the
  // first's text, and the fold (first `before`, last `content`) prints the path as unchanged.
  const was = kind === "create" ? null : readPlannedText(path);
  const before = was === null ? null : was.kind === "text" ? was.text : undefined;
  landPlan({
    files: [{
      ...filePlan(path, kind, {
        before,
        ...(text.content === undefined ? {} : { content: text.content }),
        ...(text.directory === undefined ? {} : { directory: text.directory }),
      }),
      attributes: text.attributes ?? [],
      ...(text.secretKeys !== undefined && text.secretKeys.length > 0
        ? { secretKeys: text.secretKeys }
        : {}),
    }],
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

/** What a lookup at or under a regular file raises: ENOTDIR on POSIX; Windows reports the path as
 *  not found (the overlay's table, fs_overlay.ts), except that node's own recursive mkdir says
 *  ENOTDIR. */
function underFileRefusal(syscall: string): NodeJS.ErrnoException {
  const notdir = process.platform !== "win32" || syscall.startsWith("mkdir");
  return notdir
    ? errno("ENOTDIR", `not a directory, ${syscall}`)
    : errno("ENOENT", `no such file or directory, ${syscall}`);
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

/** Whether the entry at `path` itself (a link never followed) is a directory. */
function isDirectoryEntry(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The refusal a caller that plans a removal ahead of its apply raises at plan time, so a dry run
 *  refuses where the real run does instead of previewing a delete the apply would refuse. A
 *  symlink is the link, not what it points at. */
export function assertNotDirectory(path: string): void {
  if (isDirectoryEntry(path)) {
    throw new Error(`${path} is a directory; only a file can be removed here`);
  }
}

/** rmdir's own refusals, taken before any plan so a dry run refuses where the real run does: a
 *  regular file (the disk's, or one this run planned) is not a directory, and a directory with
 *  entries (this run's planned deletions and creations counted) is unknown data. A link (a Windows
 *  junction at `current`) is the entry rmdir removes, never what it points at. Exported for the
 *  update planner, whose `current` flip takes the same decision. */
export function refuseRmdir(path: string): void {
  const state = plannedState(path);
  if (
    state?.kind === "text" || state?.kind === "bytes" ||
    (state?.kind === "opaque" && state.file)
  ) {
    throw underFileRefusal(`rmdir '${path}'`);
  }
  if (state === null || state.kind === "opaque") {
    // A plan without bytes (a chmod on a disk directory): the disk says which kind stands there.
    let stat: Stats;
    try {
      stat = lstatSync(path);
    } catch {
      if (state === null) return;
      throw underFileRefusal(`rmdir '${path}'`);
    }
    if (stat.isSymbolicLink()) return;
    if (!stat.isDirectory()) throw underFileRefusal(`rmdir '${path}'`);
  }
  if (state?.kind !== "gone" && readPlannedDir(path).length > 0) {
    throw errno("ENOTEMPTY", `directory not empty, rmdir '${path}'`);
  }
}

// --- the writes ------------------------------------------------------------------------------------

export interface WriteOptions {
  /** Set on the file whether it is fresh or exists (Deno chmods after the write). */
  mode?: number;
  /** Staged beside the target and renamed over it (the default); `false` writes in place, through
   *  a link, for a file another process holds open or a path that may be a user's own symlink. */
  atomic?: boolean;
  /** Rides on the stderr write line. */
  detail?: string;
  /** Dotted keys of this file whose values a dry run prints as `<redacted>`. Declaring them (even
   *  none) also lands the file's leaf rows under the plan collector. */
  secretKeys?: Iterable<string>;
  /** The whole file holds secrets (a settings bundle): a dry run prints its verdict alone. */
  secret?: boolean;
}

/** How a bridged write renders: the file's leaf rows before and after when the writer declared
 *  its secret keys (a whole-file writer declares none and gets the line diff and the wrapper's
 *  verdict, as today); a declared document that does not parse prints its path alone, so no
 *  secret reaches a line diff. A declared document's verdict is the byte comparison, so a
 *  same-content re-render prints `unchanged` as the plan writers did. Read only while the
 *  collector is active: outside it the destination is never opened. */
function bridgedRender(
  path: string,
  text: string,
  options: WriteOptions,
): {
  render: PlannedRender;
  attributes?: AttributeRow[];
  verdict?: FileVerdict;
  secret?: boolean;
  secretKeys?: readonly string[];
} {
  if (!planCollecting()) return { render: renderOf(options.secret) };
  recordSecret(path, { whole: options.secret, keys: options.secretKeys });
  const secret = secretOf(path);
  // A whole-file secret (declared now, or carried by a move or copy) prints its path alone
  // whatever this write declares; an undeclared write over declared keys does too, since a line
  // diff would print the old text.
  if (secret.whole) return { render: "path-only", secret: true };
  if (options.secretKeys === undefined) {
    return secret.keys.size > 0 ? { render: "path-only", secret: true } : { render: "diff" };
  }
  // The bytes the write replaces, as the run sees them. An entry that stands but cannot be read
  // (a dangling link the real write lands through) is a rewrite of unknown bytes, never a create.
  const state = plannedState(path);
  let before: string | null;
  let unreadable = false;
  if (state?.kind === "text") before = state.text;
  else if (state?.kind === "bytes") {
    before = new TextDecoder("utf-8", { ignoreBOM: true }).decode(state.bytes);
  } else if (state?.kind === "gone") before = null;
  else {
    const read = readTextResult(path);
    before = read.kind === "text" ? read.text : null;
    unreadable = read.kind === "unreadable";
  }
  const verdict: FileVerdict = unreadable ? "rewrite" : textVerdict(before, text);
  const rows = bridgeRows(path, before, text, secret.keys);
  return rows === null
    ? { render: "path-only", verdict, secret: true }
    : { render: "diff", attributes: rows, verdict, secretKeys: [...secret.keys] };
}

/** A moved or copied file's content, as the run sees it, lands at `to` for the run's later
 *  readers, and its secret declarations travel with it. */
function carryContent(from: string, to: string): void {
  const content = plannedContent(from);
  if (content instanceof Uint8Array) recordBytes(to, content);
  else if (content !== null) recordShadow(to, content);
  carrySecret(from, to);
}

/** The mode a fresh file takes with no explicit one: 0666 under the umask (none on Windows). */
function defaultFileMode(): number {
  try {
    return 0o666 & ~process.umask();
  } catch {
    return 0o666;
  }
}

export function writeText(path: string, text: string, options: WriteOptions = {}): void {
  if (options.atomic === false) writeInPlace(path, text, options);
  else writeStaged(path, text, options);
}

export function writeBytes(path: string, bytes: Uint8Array, options: WriteOptions = {}): void {
  if (options.atomic === false) writeInPlace(path, bytes, options);
  else writeStaged(path, bytes, options);
}

function writeInPlace(path: string, data: string | Uint8Array, options: WriteOptions): void {
  const was = plannedLook(path);
  const content = typeof data === "string" ? data : undefined;
  const bridged = content === undefined
    ? { render: renderOf(options.secret) }
    : bridgedRender(path, content, options);
  if (
    planned(bridged.verdict ?? verdictOf(was), path, { content, ...bridged }, {
      syscall: `open '${path}'`,
      directory: "followed",
    })
  ) {
    if (typeof data !== "string") recordBytes(path, data);
    if (options.mode !== undefined) recordPlannedMode(path, options.mode);
    return;
  }
  try {
    writeFileSync(path, data, { mode: options.mode });
  } catch (err) {
    reportTransition(path, was, "write failed");
    throw err;
  }
  reportWrite(kindOf(was), path, options.detail);
}

/** A same-directory temp file (`<name>.tmp.<pid>`: one writer per process at a time, so the pid
 *  alone keeps writers apart) written, fsynced, and renamed over the target, so a reader never
 *  sees a torn file. `mode` restricts the temp file from creation, so the rename publishes an
 *  already-restricted inode. */
function writeStaged(path: string, data: string | Uint8Array, options: WriteOptions): void {
  mkdir(dirname(path));
  const was = plannedLook(path);
  const tmp = join(dirname(path), `${basename(path)}.tmp.${process.pid}`);
  const content = typeof data === "string" ? data : undefined;
  const bridged = content === undefined
    ? { render: renderOf(options.secret) }
    : bridgedRender(path, content, options);
  // The rename over the target is the write's landing: a directory entry there is its EISDIR (a
  // link there is replaced, as rename replaces it).
  if (
    planned(bridged.verdict ?? verdictOf(was), path, { content, ...bridged }, {
      syscall: `rename '${tmp}' -> '${path}'`,
      directory: "entry",
    })
  ) {
    if (typeof data !== "string") recordBytes(path, data);
    // A staged write lands a fresh inode: its mode is the explicit one, else the default.
    recordPlannedMode(path, options.mode ?? defaultFileMode());
    return;
  }
  // A stale temp from a crashed run under this pid goes first: `mode` applies only to a fresh
  // inode, so writing into it would publish its old permissions. Through the seam, because with pid
  // reuse the path could be a file the user made.
  rm(tmp, { force: true, detail: "stale temp file" });
  const tmpWas = look(tmp);
  try {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const fd = openSync(tmp, "w", options.mode);
    try {
      for (let written = 0; written < bytes.length;) {
        written += writeSync(fd, bytes, written, bytes.length - written);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // The open applied the umask; an explicit mode lands exactly, as Deno's own write does.
    if (options.mode !== undefined) chmodSync(tmp, options.mode);
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
  reportWrite(kindOf(was), path, options.detail);
}

export function copyFile(from: string, to: string, detail?: string): void {
  const was = plannedLook(to);
  // A copy of content the run declared secret (as a whole, or by key) prints its path alone, now
  // and on a later write: a diff row would read the copied text as the text it replaces.
  const carried = secretOf(from);
  // A copy of declared content prints its path alone (a diff would read the copied text); a
  // whole-file secret also silences every row an earlier landing of the destination declared, and
  // carried keys redact them.
  const render: PlannedRender = carried.whole || carried.keys.size > 0 ? "path-only" : "diff";
  if (
    planned(verdictOf(was), to, {
      render,
      secret: carried.whole,
      secretKeys: [...carried.keys],
    }, {
      syscall: `copyfile '${from}' -> '${to}'`,
      directory: "followed",
    })
  ) {
    // The row is the wrapper's (the verdict alone); the source's content, as the run sees it, still
    // lands at `to` for the run's later readers, and its secret declarations travel with it.
    carryContent(from, to);
    return;
  }
  if (planCollecting() && underScratch(to) && plannedState(from) !== null) {
    // A probe's scratch copy of a file this run planned: the planned bytes land for real under
    // scratch (silent, as every scratch write), never the disk's stale ones.
    const source = plannedContent(from);
    if (source === null) {
      throw errno("ENOENT", `no such file or directory, copyfile '${from}' -> '${to}'`);
    }
    writeFileSync(to, source);
    reportWrite(kindOf(was), to, detail);
    return;
  }
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
export function mkdir(path: string, mode?: number, detail?: string): void {
  const missing = plannedMissingDirectories(path);
  if (planCollecting() && !underScratch(path)) {
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
export function chmod(path: string, mode: number, detail?: string): void {
  if (planned("rewrite", path)) {
    recordPlannedMode(path, mode);
    return;
  }
  chmodSync(path, mode);
  reportWrite("rewritten", path, detail);
}

export interface RemoveOptions {
  recursive?: boolean;
  /** An absent path is no error, as in node. */
  force?: boolean;
  detail?: string;
}

/** node's rmSync, named: a directory needs `recursive` (ERR_FS_EISDIR), an absent path needs
 *  `force` (ENOENT), and a lookup under a file is its ENOTDIR whatever `force` says. Returns
 *  whether anything was there. A removal that fails partway is named for what it provably changed. */
export function rm(path: string, options: RemoveOptions = {}): boolean {
  const recursive = options.recursive ?? false;
  const state = plannedState(path);
  if (state?.kind === "gone") {
    if (options.force) return false;
    throw errno("ENOENT", `no such file or directory, lstat '${path}'`);
  }
  let was: Look = { kind: "present", fingerprint: "" };
  if (state?.kind === "dir" && !recursive) throw rmDirectoryRefused(path);
  if (state === null || (state.kind === "opaque" && !state.file)) {
    // The disk's entry (unplanned, or planned without bytes: a chmod on a disk directory):
    // node's own refusals, and a look that failed for another reason (EACCES) is left to the
    // removal itself.
    let entry: Stats | null = null;
    try {
      entry = lstatSync(path);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" && state === null) {
        if (options.force) return false;
        throw errno("ENOENT", `no such file or directory, lstat '${path}'`);
      }
      if (code === "ENOTDIR") throw e;
    }
    if (entry !== null && entry.isDirectory() && !recursive) throw rmDirectoryRefused(path);
    if (state === null) was = look(path, recursive);
  }
  if (planned("delete", path)) return true;
  try {
    rmSync(path, { recursive, force: true });
  } catch (err) {
    reportTransition(path, was, "partly removed", recursive);
    throw err;
  }
  reportWrite("deleted", path, options.detail);
  return true;
}

/** node's rmdirSync, named: ENOENT for an absent path, and refuseRmdir's own refusals. */
export function rmdir(path: string): void {
  if (plannedLook(path).kind === "absent") {
    throw errno("ENOENT", `no such file or directory, rmdir '${path}'`);
  }
  refuseRmdir(path);
  if (planned("delete", path)) return;
  rmdirSync(path);
  reportWrite("deleted", path);
}

/** A move OUT of a scratch dir is the creation of `to` (the source never existed for the user); a
 *  move INTO one is the deletion of `from`. */
export function rename(from: string, to: string): void {
  const was = plannedLook(to, true);
  // Real only between scratch paths: a move touching anything else is planned whole, so a dry run
  // never takes a real source away.
  if (planCollecting() && !(underScratch(from) && underScratch(to))) {
    if (plannedLook(from).kind === "absent") {
      throw errno("ENOENT", `no such file or directory, rename '${from}' -> '${to}'`);
    }
    // The plan names the move, never the text (a moved store holds its tokens); the moved content,
    // as the run sees it, lands at `to` for the run's later readers with its secret declarations,
    // which also govern every row the destination already has.
    const carried = secretOf(from);
    planned(verdictOf(was), to, {
      render: "path-only",
      secret: carried.whole,
      secretKeys: [...carried.keys],
    }, {
      syscall: `rename '${from}' -> '${to}'`,
      directory: isDirectoryEntry(from) ? "none" : "entry",
    });
    carryContent(from, to);
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
  forgetReported(from);
  reportWrite("moved", to, `from ${from}`);
}

export function symlink(target: string, path: string, type?: "junction"): void {
  // node's symlinkSync never replaces: an entry at the path, the disk's or one this run planned,
  // is its EEXIST, in the plan too (atomicSymlink is the replacing shape).
  if (planCollecting() && plannedLook(path).kind !== "absent") {
    throw errno("EEXIST", `file already exists, symlink '${target}' -> '${path}'`);
  }
  if (
    planned("create", path, undefined, {
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
  const staged = join(dirname(link), `.${basename(link)}-next-${process.pid}`);
  if (
    planned(verdictOf(plannedLook(link)), link, undefined, {
      syscall: `rename '${staged}' -> '${link}'`,
      directory: "entry",
    })
  ) return;
  // A stale staging entry from a crashed run under this pid goes first, through the seam: with
  // pid reuse the path could be a file the user made, and its removal is then named.
  rm(staged, { force: true, detail: "stale staging file" });
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
 * the one way runtime code streams bytes to a path (a release download, the daemon's log). A dry
 * run has no handle to hand back and refuses outside scratch: no dry-run path reaches a stream
 * write, and one that did would be a write behind the plan.
 */
export async function openWritable(path: string, detail?: string): Promise<Deno.FsFile> {
  const was = plannedLook(path);
  refuseHandleInDryRun(path);
  const file = await Deno.open(path, { write: true, create: true, truncate: true });
  reportWrite(kindOf(was), path, detail);
  return file;
}

/** openWritable as a node fd, for a child's stdio. */
export function openWriteFd(path: string, detail?: string): number {
  const was = plannedLook(path);
  refuseHandleInDryRun(path);
  const fd = openSync(path, "w");
  reportWrite(kindOf(was), path, detail);
  return fd;
}

function refuseHandleInDryRun(path: string): void {
  if (planCollecting() && !underScratch(path)) {
    throw new Error(`${path}: a dry run opens no file for writing`);
  }
}

/** Nothing written under it is reported, because removeScratchDir takes it all away before exit. */
export function scratchDir(prefix: string): ScratchDir {
  const dir = mkdtempSync(prefix) as ScratchDir;
  trackScratch(dir);
  return dir;
}

/** A removal that fails names the root it left behind, the one scratch fact the user then keeps. */
export function removeScratchDir(dir: ScratchDir): void {
  untrackScratch(dir);
  // Minted by us from nothing: whatever a failed removal leaves is a creation.
  dropTransient(dir, { kind: "absent" }, true);
}

// --- the rename over a live file -------------------------------------------------------------------

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
