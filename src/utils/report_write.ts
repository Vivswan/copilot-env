// The stderr ledger of the fs seam: every file a command creates, rewrites, deletes, moves or links
// outside copilot-env's own homes is named here, once per process. Raw stderr, not consola (a
// CONSOLA_LEVEL could silence it), so the machine-readable stdout contracts survive and the lines
// cannot be turned off. The writes themselves are src/utils/fs_disk.ts's, reached through the
// facade (src/utils/fs_facade.ts).
//
// Dedup is per path, with a delete as the epoch boundary: five saves of one path print once, and a
// delete re-arms it.
import { resolve, sep } from "node:path";
import type { ScratchDir } from "./fs_disk.ts";
import { terminalWidth, wrapMessage } from "./table.ts";

export type WriteKind = "created" | "rewritten" | "deleted" | "moved" | "linked";

const REPORTED = new Map<string, Set<WriteKind>>();

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
