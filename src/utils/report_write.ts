// The stderr ledger of the fs seam: every file a command creates, rewrites, deletes, moves or links
// outside copilot-env's own homes is named here, once per process. Raw stderr, not consola (a
// CONSOLA_LEVEL could silence it), so the machine-readable stdout contracts survive and the lines
// cannot be turned off. The writes themselves are src/utils/fs_disk.ts's, reached through the
// facade (src/utils/fs_facade.ts).
//
// Dedup is per path, with a delete as the epoch boundary: five saves of one path print once, and a
// delete re-arms it.
import { writeSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { ScratchDir } from "./fs_disk.ts";
import { terminalWidth, wrapMessage } from "./table.ts";
import { sleepSync } from "./time.ts";

type WriteKind = "created" | "rewritten" | "deleted" | "moved" | "linked";

const REPORTED = new Map<string, Set<WriteKind>>();

const SCRATCH_ROOTS = new Set<string>();

/** Registered by each home's owner when it loads: src/copilot_api/paths.ts, src/utils/root.ts.
 *  Resolved per report, because a home follows the environment. */
const INTERNAL_ROOTS: (() => string)[] = [];

export function hideWritesUnder(root: () => string): void {
  INTERNAL_ROOTS.push(root);
}

/** The trailing separator is dropped so a filesystem root (`/`, `C:\`) prefixes correctly. On
 *  POSIX a backslash is a byte of the name; stripping it would fold a home onto a sibling's
 *  prefix. */
function fold(path: string): string {
  const trailing = process.platform === "win32" ? /[\\/]+$/ : /\/+$/;
  const folded = resolve(path).replace(trailing, "");
  return process.platform === "win32" ? folded.toLowerCase() : folded;
}

/** Whether `path` is one of copilot-env's own homes or lies inside one: a write there is
 *  bookkeeping, which the import's confirmation lists only when it overwrites. */
export function underInternalRoot(path: string): boolean {
  const target = fold(path);
  return INTERNAL_ROOTS.map((root) => fold(root())).some(
    (root) => target === root || target.startsWith(root + sep),
  );
}

/** A home itself always prints, even nested inside another home (the data home under the install
 *  root), so the exact match is checked against every root before any prefix test. */
function insideInternalRoot(path: string): boolean {
  const target = fold(path);
  return !INTERNAL_ROOTS.some((root) => fold(root()) === target) && underInternalRoot(path);
}

let deferred: string[] | null = null;

/** Scratch this process minted (fs_disk.ts scratchDir, the dry-run marker): silent until removed. */
export function trackScratch(dir: ScratchDir): void {
  SCRATCH_ROOTS.add(dir);
}

export function untrackScratch(dir: ScratchDir): void {
  if (!SCRATCH_ROOTS.has(dir)) throw new Error(`${dir} is not a scratch dir of this process`);
  SCRATCH_ROOTS.delete(dir);
}

export function underScratch(path: string): boolean {
  for (const root of SCRATCH_ROOTS) {
    if (path === root || path.startsWith(root + sep)) return true;
  }
  return false;
}

const ENCODER = new TextEncoder();

const STDERR_FD = 2;

/** Synchronous and in full: a buffered stream write could still be pending when a process.exit()
 *  ends the process. A stderr the parent left non-blocking answers EAGAIN when its pipe is full;
 *  the write waits it out rather than dropping the line. */
function emit(line: string): void {
  if (deferred !== null) {
    deferred.push(line);
    return;
  }
  const bytes = ENCODER.encode(`${wrapMessage(line, terminalWidth(process.stderr))}\n`);
  let written = 0;
  while (written < bytes.length) {
    try {
      written += writeSync(STDERR_FD, bytes, written, bytes.length - written);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EAGAIN") throw e;
      sleepSync(1);
    }
  }
}

/** The primitive for a writer whose mutation happens through another API (the tree a spawned
 *  `codex exec` leaves, src/codex/host.ts); everything else goes through the facade. */
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

/** A write to a value that is no file (the Windows User PATH, a registry value an installer
 *  edits), on the same ledger: no home can contain it, so only the per-value dedup applies and
 *  it always reads as rewritten. */
export function reportValueWrite(label: string, detail: string): void {
  if (REPORTED.has(label)) return;
  REPORTED.set(label, new Set(["rewritten"]));
  emit(`rewritten -> ${label} (${detail})`);
}

/** A path that moved away is a fresh epoch at its old name, and every recorded descendant goes
 *  with it. */
export function forgetReported(path: string): void {
  REPORTED.delete(path);
  forgetBelow(path);
}

/** A tree that went takes every recorded descendant with it, so a child re-created afterwards is
 *  announced again. */
function forgetBelow(path: string): void {
  for (const recorded of REPORTED.keys()) {
    if (recorded.startsWith(path + sep)) REPORTED.delete(recorded);
  }
}

/** A look that failed reads as present, so the weaker claim is made. */
export function kindOf(was: { kind: "present" | "absent" | "unknown" }): "created" | "rewritten" {
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
