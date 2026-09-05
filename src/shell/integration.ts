// Cross-platform shell/profile integration writer for the `agent` wrapper block.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { consola } from "consola";

import { isEnoent } from "../utils/fs.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { CopilotApiPaths } from "../copilot_api/paths.ts";
import { PROJECT_ROOT } from "../utils/root.ts";
import { quotePosix, quotePowerShell } from "../utils/shell_quote.ts";

// `agent shell` owns wiring the copilot-env integration into the
// user's shell startup -- the logic install.sh / install.ps1 used to duplicate.
// File wiring is done here in TS for BOTH platforms; we only shell out to tiny
// `powershell -Command` one-liners for the two Windows-only needs TS can't cover
// (resolve the (OneDrive-redirectable) Documents folder, toggle execution policy).
// The marker is a comment in both bash and PowerShell, so the wire/remove core is
// shared; only the block body and the target files differ per OS.

export const MARKER = "# copilot-env shell integration";
export const LAUNCHERS_MARKER = "# copilot-env launchers";
export const MARKER_END = `${MARKER} end`;
export const LAUNCHERS_MARKER_END = `${LAUNCHERS_MARKER} end`;
/** A marker this module owns a block under. Every shape lookup is typed against this
 *  union, so an unknown marker is a compile error rather than a runtime throw.
 *  LAUNCHERS_MARKER is retired as a WRITE target (the launchers are `agent env`
 *  function emissions now, gated by the `launchers` config key) but stays owned so
 *  blocks older releases wrote are still recognized and stripped. */
export type BlockMarker = typeof MARKER | typeof LAUNCHERS_MARKER;

// Per marker: the end-marker line that closes a fenced block, and the ordered
// [assignment, guard] line pair every released copilot-env (or the pre-TS installers)
// wrote under that marker -- how a LEGACY block (no end marker) is bounded without
// eating user lines. Order matters: a lookalike line in the guard position (say a
// user's own AGENTS_BASHRC= assignment right after ours) must not be consumed. Only
// the assignment VALUE varied across releases (literal, "$HOME"'tail', "$HOME/tail"),
// so the assignments match on prefix; the guards match whole, in both their
// historical (no -LiteralPath) and current spellings.
interface BlockShape {
  end: string;
  legacyBody: ReadonlyArray<readonly [RegExp, RegExp]>;
}

const BLOCK_SHAPES: Record<BlockMarker, BlockShape> = {
  [MARKER]: {
    end: MARKER_END,
    legacyBody: [
      [/^AGENTS_BASHRC=/, /^\[ -f "\$AGENTS_BASHRC" \] && source "\$AGENTS_BASHRC"$/],
      [/^\$AgentsPs1 = /, /^if \(Test-Path (-LiteralPath )?\$AgentsPs1\) \{ \. \$AgentsPs1 \}$/],
    ],
  },
  [LAUNCHERS_MARKER]: {
    end: LAUNCHERS_MARKER_END,
    legacyBody: [
      [/^AGENTS_LAUNCHERS=/, /^\[ -f "\$AGENTS_LAUNCHERS" \] && source "\$AGENTS_LAUNCHERS"$/],
      [
        /^\$AgentsLaunchers = /,
        /^if \(Test-Path (-LiteralPath )?\$AgentsLaunchers\) \{ \. \$AgentsLaunchers \}$/,
      ],
    ],
  },
};

// Derived from BLOCK_SHAPES (the Record is exhaustive over BlockMarker), so a new
// marker cannot land without joining these lists.
const ALL_MARKERS = Object.keys(BLOCK_SHAPES) as readonly BlockMarker[];
const ALL_FENCE_LINES: readonly string[] = [
  ...ALL_MARKERS,
  ...ALL_MARKERS.map((m) => BLOCK_SHAPES[m].end),
];

/** The one spelling of an owned block: leading blank, open fence, body, end fence,
 *  trailing blank -- the trailing blank separates the block from whatever the user
 *  has next in the file, and the writer owns exactly that one line. */
function fencedBlock(marker: BlockMarker, body: string[]): string {
  return `\n${marker}\n${body.join("\n")}\n${BLOCK_SHAPES[marker].end}\n\n`;
}

/**
 * What ONE `agent shell` file operation does: wire (or refresh) the integration
 * block, or strip every owned block (retired launchers blocks included). A union
 * so a wire can never carry removal knobs and vice versa.
 */
export type ShellIntegrationAction =
  | { kind: "wire"; allHosts: boolean }
  | { kind: "remove"; allHosts: boolean };

/** A line equals the given marker ignoring a trailing CR (rc/profile files may be CRLF). */
const lineIs = (line: string, marker: string): boolean => line.replace(/\r$/, "") === marker;

/** A blank line, CR-tolerant. NOTE: the final "" a trailing newline splits into is the
 *  file TERMINATOR, not a blank line -- callers that walk split arrays must exclude it. */
const isBlankLine = (line: string | undefined): boolean => (line ?? "").replace(/\r$/, "") === "";

export function runShellIntegration(action: ShellIntegrationAction): void {
  const windows = process.platform === "win32";

  if (action.kind === "remove") {
    const files = windows ? windowsProfileTarget(action.allHosts).paths : rcFiles(true);
    const restartHint = windows ? "Restart PowerShell." : "Restart your shell.";
    if (removeFrom(files)) consola.info(restartHint);
    return;
  }
  if (windows) {
    const target = windowsProfileTarget(action.allHosts);
    migrateLaunchersOptIn(target.paths);
    wireBlocks(target.paths, windowsBlock(join(PROJECT_ROOT, "shell", "agents.ps1")));
    // Only relax execution policy for a "system" target -- a redirected run owns no
    // machine state (the type enforces it).
    if (target.source === "system") relaxWindowsExecutionPolicy(target);
    consola.info("Restart PowerShell or run: . $PROFILE");
  } else {
    const files = rcFiles(false);
    migrateLaunchersOptIn(files);
    wireBlocks(files, posixBlock(join(PROJECT_ROOT, "shell", "agents.bashrc")));
    consola.info("Restart your shell or run: source ~/.bashrc (or ~/.zshrc)");
  }
}

/**
 * A launchers rc block is the pre-`agent launch` opt-in artifact: wiring strips it,
 * so the opt-in it carried must move to the `launchers` config key first, or an
 * upgrading user would silently lose cl/co/cx. BEFORE the strip writes on purpose
 * (a failed write can retry the migration; stripping first would destroy the only
 * record of the opt-in), and only when the preference is UNSET -- a stored value,
 * either way, is the user's own decision and is never overwritten.
 */
function migrateLaunchersOptIn(files: string[]): void {
  const hadLaunchers = files.some(
    (file) => existsSync(file) && hasMarker(readFileSync(file, "utf-8"), LAUNCHERS_MARKER),
  );
  if (!hadLaunchers) return;
  if (!new CopilotEnvConfig().adopt("launchers", true)) return;
  consola.info(
    "Carried the launcher opt-in over to the `launchers` config key " +
      `(cl/co/cx now load via \`agent env\`) -> ${new CopilotApiPaths().envConfigFile}`,
  );
}
// --- shared wire/remove core --------------------------------------------------

/**
 * The extent of the owned block whose marker sits at `idx`: through the end-marker
 * line when one closes the block (everything fenced between the markers is ours),
 * else -- a legacy or truncated block -- through the trailing lines matching one of
 * this marker's ordered legacy [assignment, guard] pairs, stopping at the first line
 * that breaks the pair. `end` is the inclusive index of the block's last line;
 * `leftBehind` is the user line such a stop refused to consume (null when the stop
 * was blank, another fence line, or EOF), for the caller to warn about. A user's
 * line is never inside the extent.
 */
function blockExtent(
  lines: string[],
  idx: number,
  marker: BlockMarker,
): { end: number; leftBehind: string | null } {
  const shapes = BLOCK_SHAPES[marker];
  const lineAt = (i: number): string | null =>
    i < lines.length ? (lines[i] ?? "").replace(/\r$/, "") : null;
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lineAt(i);
    if (line === shapes.end) return { end: i, leftBehind: null };
    // Any other fence line means this block was never closed: fall back to legacy.
    if (line !== null && ALL_FENCE_LINES.includes(line)) break;
  }
  const stop = (end: number, at: number): { end: number; leftBehind: string | null } => {
    const line = lineAt(at);
    const isUsers = line !== null && line !== "" && !ALL_FENCE_LINES.includes(line);
    return { end, leftBehind: isUsers ? line : null };
  };
  const assignment = lineAt(idx + 1);
  const pairs = shapes.legacyBody.filter(
    ([assign]) => assignment !== null && assign.test(assignment),
  );
  if (pairs.length === 0) return stop(idx, idx + 1);
  const guard = lineAt(idx + 2);
  if (guard === null || !pairs.some(([, g]) => g.test(guard))) return stop(idx + 1, idx + 2);
  return { end: idx + 2, leftBehind: null };
}

/** The skip-set covering every owned block among `lines` (each block's extent plus the
 *  blank line before it and the ONE blank after its end fence -- both only when actually
 *  blank, and never the file terminator, so a legacy block with no trailing blank still
 *  strips cleanly and user spacing beyond the one owned line survives), and the user
 *  lines conservative legacy scans refused to remove, for the caller to warn about. */
function ownedLineIndexes(
  lines: string[],
  markers: readonly BlockMarker[],
): { skip: Set<number>; leftBehind: string[] } {
  const skip = new Set<number>();
  const leftBehind: string[] = [];
  lines.forEach((line, idx) => {
    const marker = markers.find((m) => lineIs(line, m));
    if (marker === undefined) return;
    if (idx > 0 && isBlankLine(lines[idx - 1])) skip.add(idx - 1);
    const extent = blockExtent(lines, idx, marker);
    for (let i = idx; i <= extent.end; i++) skip.add(i);
    // The ONE separating blank the block writes after its end fence is owned too --
    // but the lone final "" is the file terminator, not a blank line, so eating it
    // would strip the file's final newline.
    const after = extent.end + 1;
    if (
      after < lines.length && isBlankLine(lines[after]) &&
      !(after === lines.length - 1 && lines[after] === "")
    ) skip.add(after);
    if (extent.leftBehind !== null) leftBehind.push(extent.leftBehind);
  });
  return { skip, leftBehind };
}

/**
 * Strip owned blocks from rc/profile content, each bounded by its own extent (see
 * blockExtent) plus the blank line the block prepends and the ONE separating blank it
 * appends. Pure: `leftBehind` reports the lines conservative legacy scans refused to
 * remove. Exported for tests only.
 */
export function stripBlocks(
  content: string,
  markers: readonly BlockMarker[],
): { content: string; leftBehind: string[] } {
  const lines = content.split("\n");
  const { skip, leftBehind } = ownedLineIndexes(lines, markers);
  if (skip.size === 0) return { content, leftBehind };
  return { content: lines.filter((_, idx) => !skip.has(idx)).join("\n"), leftBehind };
}

/** True if any line of `content` is exactly `marker` (CR-tolerant). */
export function hasMarker(content: string, marker: string): boolean {
  return content.split("\n").some((l) => lineIs(l, marker));
}

/** The file's dominant line ending: CRLF only when strictly more lines end CRLF than
 *  LF, so a stray CRLF in an LF file (or an empty file) stays LF. */
function dominantEol(content: string): "\n" | "\r\n" {
  const crlf = content.match(/\r\n/g)?.length ?? 0;
  const lf = (content.match(/\n/g)?.length ?? 0) - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

/**
 * Insert or refresh ONE owned block, IN PLACE: the first `marker` block is replaced
 * where it sits (extent-bounded, plus its preceding blank and the one separating blank
 * after its end fence), so a stale or legacy block migrates without reordering the file
 * and an already-current one reproduces it byte-for-byte; later duplicates of the same
 * marker (a bad hand-merge, say) are stripped, extent-bounded, so the file converges on
 * ONE owned block and user lines are never deleted. When absent, the block is appended
 * at EOF (it leads with a blank and ends in its separating blank) in the file's dominant
 * line ending. `leftBehind` reports the user lines the duplicate strips refused to
 * consume -- the same warning contract stripBlocks gives removal. Exported for tests
 * only.
 */
export function upsertBlock(
  content: string,
  marker: BlockMarker,
  block: string,
): { content: string; leftBehind: string[] } {
  const lines = content.split("\n");
  const idx = lines.findIndex((l) => lineIs(l, marker));
  if (idx === -1) {
    return {
      content: content +
        (dominantEol(content) === "\r\n" ? block.replaceAll("\n", "\r\n") : block),
      leftBehind: [],
    };
  }
  const start = idx > 0 && isBlankLine(lines[idx - 1]) ? idx - 1 : idx;
  const { end } = blockExtent(lines, idx, marker);
  let blockLines = block.split("\n");
  if (blockLines[blockLines.length - 1] === "") blockLines = blockLines.slice(0, -1); // trailing newline
  if (start === idx && blockLines[0] === "") blockLines = blockLines.slice(1); // no preceding blank to keep
  // A CRLF rc keeps its endings: the refreshed block adopts the marker line's, so
  // re-upserting an already-current block stays byte-idempotent there too.
  if ((lines[idx] ?? "").endsWith("\r")) {
    blockLines = blockLines.map((l) => `${l}\r`);
  }
  // Dedupe on the LINE array, not a string round-trip: "" is ambiguous there (no tail
  // vs one terminator line), which would flip the termination of USER content at EOF.
  const rest = lines.slice(end + 1);
  const { skip: dupes, leftBehind } = ownedLineIndexes(rest, [marker]);
  let tail = dupes.size === 0 ? rest : rest.filter((_, i) => !dupes.has(i));
  // blockLines already ends in the block's ONE owned separating blank (fencedBlock
  // emits it), so a blank left over from the previous wire is REUSED: consume one
  // leading blank from the tail rather than stacking a second -- but never the lone
  // final "", the file terminator, whose loss would drop the file's final newline.
  if (tail.length > 0 && isBlankLine(tail[0]) && !(tail.length === 1 && tail[0] === "")) {
    tail = tail.slice(1);
  }
  // An owned region reaching EOF (empty tail: the file ended inside the old extent or
  // a deduped duplicate) normalizes to the terminated, blank-followed form an append
  // produces -- ONE shape at EOF, so re-runs converge instead of accumulating blanks.
  // User content past the block keeps the file's own termination state (tail's last
  // element is untouched).
  if (tail.length === 0) tail = [""];
  return {
    content: [...lines.slice(0, start), ...blockLines, ...tail].join("\n"),
    leftBehind,
  };
}

/** The removal warning for a user line a conservative legacy/duplicate scan refused
 *  to consume -- ONE spelling for the wire (dedupe + launcher strip) and remove paths. */
function warnLeftBehind(file: string, lines: readonly string[]): void {
  for (const line of lines) {
    consola.warn(
      `Unrecognized line under a copilot-env marker in ${file} -- ` +
        `not written by copilot-env, so it (and everything after it) was left in place: ${line}`,
    );
  }
}

/**
 * Wire (or refresh) the integration block. It is upserted IN PLACE, so re-running is
 * byte-idempotent and a stale (pre-`shell/`-move) path migrates without moving the block
 * or reordering the rest of the file. Any launchers block an older release wrote is
 * stripped in the same pass (the launchers are `agent env` emissions now, so a leftover
 * block would source a file that no longer ships); the caller migrated its opt-in first.
 * The strip runs BEFORE the upsert: a launchers block directly below the main one shares
 * the separating blank, so stripping after would claim the separator the upsert just
 * emitted and the first run would not converge.
 */
function wireBlocks(files: string[], mainBlock: string): void {
  for (const file of files) {
    const original = existsSync(file) ? readFileSync(file, "utf-8") : "";
    const stripped = stripBlocks(original, [LAUNCHERS_MARKER]);
    const upserted = upsertBlock(stripped.content, MARKER, mainBlock);
    warnLeftBehind(file, [...stripped.leftBehind, ...upserted.leftBehind]);
    if (upserted.content === original) {
      consola.info(`Shell integration already wired in ${file} -- skipping.`);
      continue;
    }
    // OneDrive-backed Documents folders are reparse points; Node's recursive mkdir throws
    // EEXIST on an existing reparse point instead of no-op'ing, so skip when it already exists.
    if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, upserted.content);
    consola.success(`Wired shell integration into ${file}`);
  }
}

function removeBlocksFrom(
  files: string[],
  markers: readonly BlockMarker[],
  removedMessage: (file: string) => string,
  missingMessage: string,
): boolean {
  let removedAny = false;
  for (const file of files) {
    if (!existsSync(file)) continue;
    const content = readFileSync(file, "utf-8");
    const stripped = stripBlocks(content, markers);
    if (stripped.content === content) continue; // no owned block present
    writeFileSync(file, stripped.content);
    warnLeftBehind(file, stripped.leftBehind);
    consola.success(removedMessage(file));
    removedAny = true;
  }
  if (!removedAny) consola.info(missingMessage);
  return removedAny;
}

function removeFrom(files: string[]): boolean {
  return removeBlocksFrom(
    files,
    ALL_MARKERS,
    (file) => `Removed shell integration from ${file}`,
    "No copilot-env shell integration found to remove.",
  );
}

// --- block builders (path-quoted; quote helpers re-exported for tests) --------

// Re-exported so test/shell_integration.test.ts can import them from here.
export { quotePosix, quotePowerShell };

/** The `$HOME` tail of `path` when it lives under the user's home directory, else null.
 *  Anchoring the written block at `$HOME` keeps a synced rc/profile file working across
 *  machines and usernames; a path outside home (e.g. a dev checkout) stays literal.
 *  relative() rather than a lexical prefix test: it normalizes separators and compares
 *  the way the platform does (case-insensitive on Windows), so a differently-cased home
 *  still anchors; outside-home walks up ("..") or lands on another drive (absolute). */
function homeTail(path: string): string | null {
  const tail = relative(homedir(), path);
  if (tail === "" || tail.startsWith("..") || isAbsolute(tail)) return null;
  return sep + tail;
}

/** Tails that stay literal inside a double-quoted string (no $, backtick, ", \\,
 *  or newline in POSIX; no $, backtick, or " in PowerShell) -- every real install.
 *  `!` is also excluded on the POSIX side: sourced rc files skip history expansion,
 *  but a user pasting the line into an interactive bash would not. Anything else
 *  falls back to the concatenated form below. */
const POSIX_DQ_SAFE = /^[^$`"\\\n!]*$/;
const PS_DQ_SAFE = /^[^$`"\n]*$/;

/** Quote `path` for a POSIX assignment, `$HOME`-anchored when possible: the readable
 *  `"$HOME/tail"` when the tail needs no escaping, else `"$HOME"'<tail>'` so only
 *  `$HOME` expands and the tail's metacharacters remain literal. */
function quotePosixHomeAnchored(path: string): string {
  const tail = homeTail(path);
  if (tail === null) return quotePosix(path);
  if (POSIX_DQ_SAFE.test(tail)) return `"$HOME${tail}"`;
  return `"$HOME"${quotePosix(tail)}`;
}

/** PowerShell twin of quotePosixHomeAnchored: `"$HOME\tail"` when safe (`\` ends the
 *  variable name, so nothing else expands), else `$HOME + '<tail>'`. */
function quotePowerShellHomeAnchored(path: string): string {
  const tail = homeTail(path);
  if (tail === null) return quotePowerShell(path);
  if (PS_DQ_SAFE.test(tail)) return `"$HOME${tail}"`;
  return `$HOME + ${quotePowerShell(tail)}`;
}

export function posixBlock(agentsBashrc: string): string {
  return fencedBlock(MARKER, [
    `AGENTS_BASHRC=${quotePosixHomeAnchored(agentsBashrc)}`,
    `[ -f "$AGENTS_BASHRC" ] && source "$AGENTS_BASHRC"`,
  ]);
}

export function windowsBlock(agentsPs1: string): string {
  // -LiteralPath so a path with PowerShell wildcard chars ([ ] * ?) isn't treated
  // as a pattern (the quoting handles spaces/quotes, not wildcard semantics).
  return fencedBlock(MARKER, [
    `$AgentsPs1 = ${quotePowerShellHomeAnchored(agentsPs1)}`,
    `if (Test-Path -LiteralPath $AgentsPs1) { . $AgentsPs1 }`,
  ]);
}

export function windowsExecutionPolicyCommand(): string {
  return (
    "$ErrorActionPreference='Stop'; " +
    // When Windows PowerShell 5.1 is spawned as a child of pwsh 7 (the usual case -- the
    // user runs `agent` from pwsh), it inherits pwsh's PSModulePath, loads pwsh's
    // Microsoft.PowerShell.Security, and the policy cmdlets fail to autoload. Reset the
    // Desktop edition to its own machine module path so the cmdlets resolve. Core (pwsh)
    // resolves them fine, so leave its path alone.
    "if ($PSVersionTable.PSEdition -eq 'Desktop') { " +
    "$env:PSModulePath = [Environment]::GetEnvironmentVariable('PSModulePath','Machine') }; " +
    "try { " +
    "Get-Command Get-ExecutionPolicy -ErrorAction Stop | Out-Null; " +
    "Get-Command Set-ExecutionPolicy -ErrorAction Stop | Out-Null " +
    "} catch { " +
    "Write-Host 'Execution policy cmdlets unavailable; skipping execution policy update.'; exit 0 " +
    "}; " +
    "if ((Get-ExecutionPolicy) -in 'Restricted','AllSigned','Undefined') { " +
    "Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force; " +
    "Write-Host 'Set CurrentUser execution policy to RemoteSigned so the profile can load agents.ps1.' }"
  );
}

// --- test/CI seams ------------------------------------------------------------
//
// One override per platform family for WHERE this module writes. They exist for different
// reasons: the Windows $PROFILE location comes from a Windows API call that no environment
// variable can move, while the POSIX rc lookup does follow $HOME -- but only if every test
// remembers to set it, which is exactly what a structural isolation floor must not depend
// on. Set them ONLY from tests, like the other COPILOT_ENV_CI_* variables.

/** The Documents FOLDER the Windows `$PROFILE` resolvers build on -- the parent of the
 *  per-edition `WindowsPowerShell/` and `PowerShell/` directories, not a profile dir. */
export const CI_PS_DOCUMENTS_DIR_ENV = "COPILOT_ENV_CI_PS_DOCUMENTS_DIR";

/** The directory the POSIX rc files (`.bashrc` / `.zshrc`) resolve under, in place of
 *  `homedir()`. Takes precedence over `$HOME`. */
export const CI_RC_DIR_ENV = "COPILOT_ENV_CI_RC_DIR";

/**
 * Read one seam. Absolute paths only, and set-but-unusable is a hard ERROR for both: an
 * empty value is an unexpanded interpolation and a relative one resolves against whatever
 * cwd the CLI ran from. Quietly falling back to the machine's real startup file is the one
 * outcome a seam whose entire job is isolation must never have. The ONE place they are read.
 */
function absolutePathEnv(name: string): string | null {
  const dir = process.env[name];
  if (dir === undefined) return null;
  if (!isAbsolute(dir)) throw new Error(`${name} must be an absolute path (got: ${dir})`);
  return dir;
}

// --- POSIX target files -------------------------------------------------------

/** Existing ~/.bashrc + ~/.zshrc; for wiring, fall back to one named for $SHELL. */
export function rcFiles(remove: boolean): string[] {
  const home = absolutePathEnv(CI_RC_DIR_ENV) ?? homedir();
  const existing = [".bashrc", ".zshrc"]
    .map((f) => join(home, f))
    .filter((p) => existsSync(p));
  if (existing.length > 0 || remove) return existing;
  const shell = basename(process.env.SHELL ?? "/bin/bash");
  return [join(home, shell === "zsh" ? ".zshrc" : ".bashrc")];
}

/**
 * Shell rc/profile files to INSPECT for owned blocks (read-only) on this platform:
 * existing POSIX rc files, or the Windows `$PROFILE` candidates (both the
 * current-host and all-hosts profiles, so a `--all-hosts` wiring is still seen).
 * Used by `agent health` to report shell-integration wiring without mutating anything.
 */
export function shellTargetFiles(): string[] {
  if (process.platform !== "win32") return rcFiles(true);
  return [
    ...new Set([...windowsProfileTarget(false).paths, ...windowsProfileTarget(true).paths]),
  ];
}

// --- Windows $PROFILE vocabulary ------------------------------------------------
//
// The per-edition dirs under Documents (5.1 vs pwsh 7) and the current-host /
// all-hosts profile filenames. The CI redirect short-circuits the Documents lookup,
// so a redirected run cannot wire one tree and inspect another.
const PS_PROFILE_DIRS = ["WindowsPowerShell", "PowerShell"] as const;
const PS_PROFILE_CURRENT_HOST = "Microsoft.PowerShell_profile.ps1";
const PS_PROFILE_ALL_HOSTS = "profile.ps1";
/** The two PowerShell editions, in the order to try them: 5.1, then 7. Index-for-index
 *  with PS_PROFILE_DIRS above (WindowsPowerShell = 5.1, PowerShell = 7). */
const PS_EXES = ["powershell", "pwsh"] as const;

/** Every `<root>/<edition>/<name>` profile path, deduped -- the one spelling of the
 *  layout the resolver produces. */
function profilePathsUnder(documentRoots: string[], names: string[]): string[] {
  const paths: string[] = [];
  for (const root of documentRoots) {
    for (const sub of PS_PROFILE_DIRS) {
      for (const name of names) paths.push(join(root, sub, name));
    }
  }
  return [...new Set(paths)];
}

// --- Windows (file ops in TS; PS only for what it must) ------------------------

/** The Windows `$PROFILE` files to act on. `source` is the proof of whose profile these
 *  are: only a "system" target owns the machine's execution policy, and
 *  relaxWindowsExecutionPolicy accepts nothing else -- so a redirected run cannot relax
 *  it even by mistake. `paths` is ONE filename (current-host or all-hosts) under BOTH
 *  edition directories, present or not: wireBlocks creates the one that is missing. */
export type WindowsProfileTarget =
  | { paths: string[]; source: "system" }
  | { paths: string[]; source: "redirected" };

/** Resolve this run's `$PROFILE` target: the machine's own, or the seam's throwaway tree. */
export function windowsProfileTarget(allHosts: boolean): WindowsProfileTarget {
  const override = absolutePathEnv(CI_PS_DOCUMENTS_DIR_ENV);
  const name = allHosts ? PS_PROFILE_ALL_HOSTS : PS_PROFILE_CURRENT_HOST;
  if (override !== null) {
    return { paths: profilePathsUnder([override], [name]), source: "redirected" };
  }
  // Off Windows the lookup answers for $HOME: plausible-looking nonsense, not a profile.
  if (process.platform !== "win32") {
    throw new Error("the Windows $PROFILE target is only resolvable on Windows");
  }
  // DoNotVerify: the one-argument call verifies the folder and answers with an empty
  // string when it was never created. We create it on write, so the unverified answer
  // is the useful one.
  const documents = psEval("[Environment]::GetFolderPath('MyDocuments','DoNotVerify')");
  if (!documents) throw new Error("could not resolve the Documents folder via PowerShell");
  return { paths: profilePathsUnder([documents], [name]), source: "system" };
}

/** Ask PowerShell for one value, from whichever edition answers. The query is read-only
 *  and both editions return the same thing, so a missing OR broken 5.1 falls through to
 *  pwsh rather than failing the command. */
function psEval(command: string): string {
  const failures: string[] = [];
  for (const exe of PS_EXES) {
    const result = spawnSync(exe, ["-NoProfile", "-Command", command], { encoding: "utf-8" });
    if (isEnoent(result.error)) {
      failures.push(`${exe}: not on PATH`);
      continue;
    }
    if (result.error || result.status !== 0) {
      failures.push(`${exe}: ${
        result.error?.message ??
          `exit ${result.status}: ${(result.stderr ?? "").toString().trim()}`
      }`);
      continue;
    }
    return (result.stdout ?? "").toString().trim();
  }
  throw new Error(`no PowerShell edition could run the command (${failures.join("; ")})`);
}

// The profile dot-sources the unsigned agents.ps1; under Restricted/AllSigned the
// profile would silently refuse to load it. Relax CurrentUser to RemoteSigned. CurrentUser
// policy keys are per-edition, so run it in each installed edition (5.1 + pwsh 7).
// Takes the system target as proof this run owns the policy it is about to change.
function relaxWindowsExecutionPolicy(_target: { source: "system" }): void {
  const command = windowsExecutionPolicyCommand();
  for (const exe of PS_EXES) {
    const result = spawnSync(exe, ["-NoProfile", "-Command", command], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    // Edition not installed (pwsh-only or 5.1-only machine): nothing to relax there.
    if (isEnoent(result.error)) continue;
    if (result.error || result.status !== 0) {
      consola.warn(
        `Could not relax the ${exe} execution policy; the profile may not load agents.ps1. ` +
          `Run: ${exe} -Command "Set-ExecutionPolicy -Scope CurrentUser RemoteSigned"`,
      );
    }
  }
}
