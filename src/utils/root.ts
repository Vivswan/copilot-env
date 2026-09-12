import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Profile } from "../copilot_api/profile.ts";
import { hideWritesUnder } from "./report_write.ts";

/** `kind` is the single source of the checkout/installed distinction: nothing downstream re-derives
 *  it from an ambient file probe, so a test can inject a sandbox root and get the matching policy
 *  with it. */
export type RootMode =
  /** The root is the source tree itself: the code we execute and the files we manage are one
   *  directory. */
  | { readonly kind: "checkout"; readonly root: string }
  /** Derived from `Deno.execPath()`, never `import.meta.url`: inside a compiled binary that URL
   *  points into the embedded VFS, a temp-dir-shaped path that exists only in-process. Paths handed
   *  to other programs (Codex's `auth.command`, Claude's `apiKeyHelper`, the preload shims) must be
   *  real on-disk paths. */
  | { readonly kind: "compiled"; readonly root: string };

/** For relocatable and staged installs. */
const ROOT_OVERRIDE_ENV = "COPILOT_ENV_INSTALL_ROOT";

/** `<top>/versions/vX.Y.Z`. Owned here because root detection reads the layout; the installer
 *  (src/install/installer.ts) builds it from these same names. */
export const VERSIONS_DIR = "versions";

/** `<top>/current`: a POSIX symlink or a Windows junction, and the one path prefix that survives
 *  updates and version GC, so it IS the compiled root in a versioned layout. */
export const CURRENT_LINK = "current";

/** lstat, no link-following: a dangling `current` link still marks a versioned layout, broken but
 *  repairable by the next install, never a flat root. */
function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Names alone must never qualify: a flat install that happens to sit at `<x>/versions/<name>`
 *  beside an unrelated `<x>/current` directory would be misrooted, and the destructive gates would
 *  then aim at `<x>`. A dangling link still qualifies: readlink works without a target, and a
 *  broken link is repairable. */
export function isVersionedInstallTop(top: string): boolean {
  const link = join(top, CURRENT_LINK);
  try {
    if (!lstatSync(link).isSymbolicLink()) return false;
  } catch {
    return false;
  }
  let target: string;
  try {
    target = readlinkSync(link);
  } catch {
    return false;
  }
  // Junction targets read back absolute, possibly `\\?\`-prefixed and with a trailing separator; a
  // POSIX target is relative (`versions/<name>`).
  const normalized = target.replace(/^\\\\\?\\/, "").replace(/[\\/]+$/, "");
  const parent = dirname(resolve(top, normalized));
  const versionsDir = resolve(join(top, VERSIONS_DIR));
  const sameDir = process.platform === "win32"
    ? parent.toLowerCase() === versionsDir.toLowerCase()
    : parent === versionsDir;
  return sameDir && entryExists(versionsDir);
}

/** No fixed dirname() hop count, so moving this file does not break resolution; bounded so a
 *  missing marker cannot loop. */
function findCheckoutRoot(): string {
  const start = dirname(fileURLToPath(import.meta.url));
  let dir = start;
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }
  return start;
}

/** Typed locally so the module also typechecks under non-Deno tooling. */
interface DenoRuntimeGlobal {
  execPath(): string;
  build: { standalone?: boolean };
}

export function denoRuntime(): DenoRuntimeGlobal | null {
  const versions: Record<string, string | undefined> = process.versions;
  if (!versions.deno) return null;
  return (globalThis as { Deno?: DenoRuntimeGlobal }).Deno ?? null;
}

/** Under a standalone, `Deno.execPath()` is OUR binary, which cannot run `deno cache` or launch the
 *  proxy. Observed from deno's own report rather than sniffed from `import.meta.url`: the compiled
 *  VFS path is a plain `file:` URL under the temp dir, and its directory name follows the output
 *  file name, which no contract pins. */
export function isStandaloneBinary(): boolean {
  return denoRuntime()?.build.standalone === true;
}

/** The one owner of the "can our runtime act as a deno CLI" guard; every fast path (resolveDenoBin,
 *  detectSidecar) goes through it rather than re-deriving it. */
export function devDenoExecPath(): string | null {
  const runtime = denoRuntime();
  if (runtime === null || isStandaloneBinary()) return null;
  return runtime.execPath();
}

/** `<root>/bin/copilot-env` -> `<root>`; nothing else may define the layout. In a versioned layout
 *  execPath resolves the `current` link, so the derivation lands on the version dir and the root
 *  must be the link instead: every path persisted outside the install (agent configs, rc blocks,
 *  preload paths) is built from this root and has to survive version GC. Exported for tests. */
export function derivedCompiledRoot(binaryPath: string): string {
  const derived = dirname(dirname(binaryPath));
  const versionsDir = dirname(derived);
  if (basename(versionsDir) === VERSIONS_DIR && isVersionedInstallTop(dirname(versionsDir))) {
    return join(dirname(versionsDir), CURRENT_LINK);
  }
  return derived;
}

function detectRootMode(): RootMode {
  if (!isStandaloneBinary()) return { kind: "checkout", root: findCheckoutRoot() };
  const override = process.env[ROOT_OVERRIDE_ENV];
  // Taken literally, never re-derived: `agent update` uses it to aim the staged binary inside a
  // not-yet-live version root.
  if (override) return { kind: "compiled", root: resolve(override) };
  return { kind: "compiled", root: derivedCompiledRoot(denoRuntime()?.execPath() ?? "") };
}

const ROOT_MODE: RootMode = detectRootMode();

export function rootMode(): RootMode {
  return ROOT_MODE;
}

export const PROJECT_ROOT: string = ROOT_MODE.root;

/** Machine state (`.env`, `.autoupdate`) must survive updates and version GC, so it lives at the
 *  top of a versioned layout, never in a version dir.
 *
 *    <top>/current     -> <top>
 *    <top>/versions/vN -> itself, where an update's provision stage aims the child binary before
 *                         `current` moves; safe while `install --assets-only` reads no state */
export function installStateRoot(root: string = PROJECT_ROOT): string {
  const resolved = resolve(root);
  if (basename(resolved) === CURRENT_LINK && isVersionedInstallTop(dirname(resolved))) {
    return dirname(resolved);
  }
  return resolved;
}

/** The compiled binary's embedded VFS, or the checkout root in dev. Readable in-process only: never
 *  hand an ASSET_ROOT path to another program, and never write under it. Distinct from PROJECT_ROOT
 *  because an install materializes only some assets onto disk; `copilot-env.config` in particular
 *  is read out of the binary. */
export const ASSET_ROOT: string = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** Whole-root destructive operations (uninstall, update, the autoupdate preflight) refuse without
 *  `--force` on a checkout: it may hold uncommitted work, and a nuked clone is unrecoverable while
 *  a leftover install directory is a one-line `rm`. */
export function isProtectedRoot(mode: RootMode = rootMode()): boolean {
  return mode.kind === "checkout";
}

/** `bin` alone would not identify a root: ~/.local/bin/copilot-env would resolve its root to
 *  ~/.local, which has one. Exported so the installer's tests can assert it produces exactly this
 *  layout. */
export const INSTALL_ROOT_MARKERS = ["bin", "shell", join("src", "scripts")] as const;

/** A checkout never has one, so a valid manifest is positive proof a root is an install. An
 *  external contract: renaming it would make every existing install look pre-manifest again. */
export const INSTALL_MANIFEST_FILE = ".copilot-env-install.json";

export interface InstallManifest {
  version: string;
  kind: "installed";
  assets: string[];
}

/** `unreadable` means we could not even look; the destructive gates read it as "cannot prove",
 *  never as `absent`. */
export type InstallManifestReading =
  | { kind: "absent" }
  | { kind: "unreadable" }
  | { kind: "invalid" }
  | { kind: "valid"; manifest: InstallManifest };

export function readInstallManifest(root: string): InstallManifestReading {
  const path = join(root, INSTALL_MANIFEST_FILE);
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") return { kind: "unreadable" };
    // A dangling symlink also reads as ENOENT; only a missing directory entry is genuinely absent.
    try {
      lstatSync(path);
      return { kind: "unreadable" };
    } catch (statError) {
      return (statError as { code?: string }).code === "ENOENT"
        ? { kind: "absent" }
        : { kind: "unreadable" };
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "invalid" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "invalid" };
  }
  const record = parsed as Record<string, unknown>;
  const { version, kind, assets } = record;
  if (typeof version !== "string" || kind !== "installed" || !Array.isArray(assets)) {
    return { kind: "invalid" };
  }
  if (!assets.every((entry): entry is string => typeof entry === "string")) {
    return { kind: "invalid" };
  }
  return { kind: "valid", manifest: { version, kind, assets } };
}

/** The manifest requirement (through the link, or in any version dir when the link dangles) keeps
 *  the destructive gates honest: layout-shaped entries alone never qualify a versioned top for
 *  recursive deletion. */
function looksLikeVersionedInstallTop(resolved: string): boolean {
  if (!isVersionedInstallTop(resolved)) return false;
  if (readInstallManifest(join(resolved, CURRENT_LINK)).kind === "valid") return true;
  let names: string[];
  try {
    names = readdirSync(join(resolved, VERSIONS_DIR));
  } catch {
    return false;
  }
  return names.some(
    (name) => readInstallManifest(join(resolved, VERSIONS_DIR, name)).kind === "valid",
  );
}

/** `agent uninstall` removes the resolved root wholesale, and that root is derived (two levels up
 *  from the binary, or an env override), so a binary copied somewhere unexpected would otherwise
 *  aim `rm -rf` at an unrelated directory. The mirror image of install.sh's refusal to install into
 *  `$HOME` or a filesystem root. */
export function looksLikeInstallRoot(root: string): boolean {
  const resolved = resolve(root);
  if (resolved === dirname(resolved)) return false; // a filesystem root
  if (resolved === resolve(homedir())) return false;
  // A valid manifest alone qualifies: a user-deleted asset dir must not make a real install
  // invisible to uninstall. A root we cannot inspect is not one we may delete. Absent or invalid
  // falls back to the markers.
  const reading = readInstallManifest(resolved);
  if (reading.kind === "valid") return true;
  if (reading.kind === "unreadable") return false;
  // A versioned top has no root manifest (the sentinel is per-version).
  if (looksLikeVersionedInstallTop(resolved)) return true;
  return INSTALL_ROOT_MARKERS.every((marker) => existsSync(join(resolved, marker)));
}

const AGENT_LAUNCHER: string = join(PROJECT_ROOT, "bin", "agent");
const AGENT_LAUNCHER_PS1: string = join(PROJECT_ROOT, "bin", "agent.ps1");

/** One spelling so the write sites (Codex `auth.command`, Claude apiKeyHelper) and the health
 *  verify site stay byte-identical; if they drift, health stops recognizing the config the writer
 *  just wrote. */
export const AGENT_AUTH_GET_ARGS: readonly string[] = ["auth", "--get"];

export function agentAuthGetArgs(profile: Profile = null): string[] {
  return profile === null
    ? [...AGENT_AUTH_GET_ARGS]
    : [...AGENT_AUTH_GET_ARGS, "--profile", profile];
}

/** `--yes` because Codex and Claude run the resolver on a timer and cannot answer a prompt. One
 *  spelling, like AGENT_AUTH_GET_ARGS, so the write sites and the wiring inspectors stay
 *  byte-identical. */
export function proxyTokenArgs(profile: Profile = null): string[] {
  return profile === null
    ? ["proxy-token", "--yes"]
    : ["proxy-token", "--yes", "--profile", profile];
}

export function proxyTokenCommand(profile: Profile = null): { command: string; args: string[] } {
  return agentLauncherCommand(proxyTokenArgs(profile));
}

/** For a program (Codex's `auth.command`) spawning `agent` directly, not from a shell: on Windows
 *  the bash launcher is not executable, so it goes through PowerShell and the `.ps1`. */
export function agentLauncherCommand(subArgs: readonly string[]): {
  command: string;
  args: string[];
} {
  if (process.platform === "win32") {
    return {
      command: "powershell",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", AGENT_LAUNCHER_PS1, ...subArgs],
    };
  }
  return { command: AGENT_LAUNCHER, args: [...subArgs] };
}

// The install root is copilot-env's own: writes inside it are bookkeeping, never reported.
hideWritesUnder(() => installStateRoot(PROJECT_ROOT));
