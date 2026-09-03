// Install-root and bundled-asset discovery for launchers, tests, and compiled binaries.
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Profile } from "../copilot_api/profile.ts";

/**
 * How this copy of copilot-env is running, and the ON-DISK install root that follows.
 *
 * - `checkout`: running from source (`deno run src/cli.ts`) -- a dev clone or a
 *   worktree. The root is the source tree itself, so the code we execute and the
 *   files we manage are the same directory.
 * - `compiled`: running as a `deno compile` binary installed at
 *   `<root>/bin/copilot-env`. The root is derived from `Deno.execPath()`, NEVER from
 *   `import.meta.url`: inside a compiled binary that URL points into the embedded
 *   virtual filesystem (a temp-dir-shaped path that exists only in-process). Paths
 *   we hand to OTHER programs -- Codex's `auth.command`, Claude's `apiKeyHelper`,
 *   the daemon's preload shims -- must be real on-disk paths, and a VFS path would
 *   also invert the checkout/installed distinction every destructive gate reads.
 *
 * The `kind` is the single source of that distinction: nothing downstream re-derives
 * it from an ambient file probe, so a test can inject a sandbox root and get the
 * matching policy with it.
 */
export type RootMode =
  | { readonly kind: "checkout"; readonly root: string }
  | { readonly kind: "compiled"; readonly root: string };

/** Overrides the compiled binary's install root (relocatable/staged installs). */
const ROOT_OVERRIDE_ENV = "COPILOT_ENV_INSTALL_ROOT";

/** The per-release roots directory of a VERSIONED install (`<top>/versions/vX.Y.Z`).
 *  Owned here because root detection reads the layout; the installer
 *  (src/install/installer.ts) builds it from these same names. */
export const VERSIONS_DIR = "versions";

/** The link naming the live version root (`<top>/current`): a POSIX symlink, a
 *  Windows directory junction. The one path prefix that survives updates and
 *  version GC, so it IS the compiled root in a versioned layout. */
export const CURRENT_LINK = "current";

/** Whether a directory ENTRY exists at `path` itself (lstat, no link-following):
 *  a dangling `current` link still marks a versioned layout -- broken, but
 *  repairable by the next install/update, and never a flat root. */
function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `top` is the top of a versioned install layout: `<top>/current` is a
 * LINK (symlink/junction) whose target names a dir inside `<top>/versions`,
 * and the versions dir entry exists. Names alone must never qualify -- a flat
 * install that happens to sit at `<x>/versions/<name>` beside an unrelated
 * `<x>/current` directory would otherwise be misrooted (and the destructive
 * gates then aim at `<x>`). A DANGLING link still qualifies: readlink works
 * without a target, and a broken link is a repairable versioned layout, not a
 * flat one.
 */
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
  // Junction targets read back absolute, possibly `\\?\`-prefixed and with a
  // trailing separator; a POSIX target is relative (`versions/<name>`).
  const normalized = target.replace(/^\\\\\?\\/, "").replace(/[\\/]+$/, "");
  const parent = dirname(resolve(top, normalized));
  const versionsDir = resolve(join(top, VERSIONS_DIR));
  const sameDir = process.platform === "win32"
    ? parent.toLowerCase() === versionsDir.toLowerCase()
    : parent === versionsDir;
  return sameDir && entryExists(versionsDir);
}

/**
 * Walk up from this module's own directory to the nearest ancestor holding a
 * package.json -- the project root, where node_modules lives. Robust to however
 * deep this file is nested (no fixed dirname() hop count), so moving it doesn't
 * break resolution. Bounded so a missing marker can't loop.
 */
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

/** The one facet of the Deno global this module needs (typed locally so the
 *  module also typechecks under non-Deno tooling). */
interface DenoRuntimeGlobal {
  execPath(): string;
  build: { standalone?: boolean };
}

/** The running Deno runtime's global, or null when not running under Deno. */
export function denoRuntime(): DenoRuntimeGlobal | null {
  const versions: Record<string, string | undefined> = process.versions;
  if (!versions.deno) return null;
  return (globalThis as { Deno?: DenoRuntimeGlobal }).Deno ?? null;
}

/**
 * True when we are a `deno compile` standalone binary rather than a script under a real
 * deno. It matters everywhere the runtime's own executable is treated as a deno: under a
 * standalone, `Deno.execPath()` is OUR binary, which cannot run `deno cache` or launch
 * the proxy. Deno reports this itself, so it is observed rather than inferred from paths.
 *
 * It is also what discriminates RootMode. Preferred over sniffing the shape of
 * `import.meta.url`: the compiled VFS path is a plain `file:` URL under the temp dir, so
 * it is indistinguishable from a legitimate source path by scheme, and its directory name
 * follows the output file name (not `--app-name`), which no contract pins.
 */
export function isStandaloneBinary(): boolean {
  return denoRuntime()?.build.standalone === true;
}

/**
 * Our own runtime's executable when it can act as a deno CLI, else null: running
 * under a real deno yields its binary; a compiled standalone (a deno runtime but
 * not a deno CLI -- it cannot `deno cache` or run scripts) and a non-deno process
 * yield null. The ONE owner of this guard; every "use our own deno" fast path
 * (resolveDenoBin, detectSidecar) goes through it rather than re-deriving it.
 */
export function devDenoExecPath(): string | null {
  const runtime = denoRuntime();
  if (runtime === null || isStandaloneBinary()) return null;
  return runtime.execPath();
}

/**
 * The compiled install root for a binary on disk at `binaryPath`. Exported for
 * tests (the live answer is locked into ROOT_MODE at startup): the versioned
 * mapping is a GC-survival property worth pinning -- a root naming
 * `versions/<name>` would put version-dir paths into every persisted artifact.
 *
 * <root>/bin/copilot-env -> <root>. The installers put the binary there and the
 * bin/agent shim next to it; nothing else may define the layout. In a VERSIONED
 * layout that derivation lands on the version dir (execPath resolves the
 * `current` link on most platforms) and the root must be the LINK instead:
 * every path persisted outside the install (agent configs, rc blocks, daemon
 * preload paths) is built from this root and has to survive version GC, which
 * `<top>/versions/<name>/...` never would. A derivation that already reads
 * `<top>/current` (an unresolved execPath) needs no mapping.
 */
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
  // An override is taken literally, never re-derived: `agent update` uses it to
  // aim the staged binary INSIDE a not-yet-live version root.
  if (override) return { kind: "compiled", root: resolve(override) };
  return { kind: "compiled", root: derivedCompiledRoot(denoRuntime()?.execPath() ?? "") };
}

const ROOT_MODE: RootMode = detectRootMode();

/** How this process is running, resolved once at startup. */
export function rootMode(): RootMode {
  return ROOT_MODE;
}

/** The on-disk install root: the checkout in dev, the binary's install dir when compiled. */
export const PROJECT_ROOT: string = ROOT_MODE.root;

/**
 * Where an install keeps its MACHINE state (`.env`, `.autoupdate`): the top
 * root of a versioned layout -- state must survive updates and version GC, so
 * it can never live inside (or resolve through the `current` link into) a
 * version dir -- and the root itself everywhere else (a flat install, a
 * checkout). Pure path logic over the layout names, so callers can pass any
 * root spelling they hold.
 *
 * Constraint: an update's provision stage aims the child binary (via
 * COPILOT_ENV_INSTALL_ROOT) at `<top>/versions/vNEW` before `current` points at
 * it, so for that child this resolves machine state inside the version dir --
 * safe only while `install --assets-only` reads none of it.
 */
export function installStateRoot(root: string = PROJECT_ROOT): string {
  const resolved = resolve(root);
  if (basename(resolved) === CURRENT_LINK && isVersionedInstallTop(dirname(resolved))) {
    return dirname(resolved);
  }
  return resolved;
}

/**
 * Where the files that SHIP WITH THIS BUILD are read from: the compiled binary's
 * embedded VFS, or the checkout root in dev. Readable in-process only -- never hand
 * an ASSET_ROOT path to another program, and never write under it.
 *
 * Distinct from PROJECT_ROOT because an installed binary materializes only some of
 * its embedded assets onto disk (the shell payload, the preload shims, the plugin
 * surface); everything else, `copilot-env.config` in particular, is read straight
 * out of the binary.
 */
export const ASSET_ROOT: string = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/**
 * Whether whole-root destructive operations (`agent uninstall`'s delete, `agent
 * update`'s in-place overwrite, the autoupdate preflight) must refuse without
 * `--force`.
 *
 * A source checkout is protected: it may hold uncommitted work, and a nuked clone is
 * unrecoverable while a leftover install directory is a one-line `rm`. A compiled
 * install root holds nothing the user authored, so it is freely replaceable.
 */
export function isProtectedRoot(mode: RootMode = rootMode()): boolean {
  return mode.kind === "checkout";
}

/** Directories every copilot-env root carries: a checkout ships them, and an install
 *  materializes them out of the binary (`bin` is the exception -- the installer writes
 *  launcher shims into it rather than unpacking one). `bin` alone would not identify a
 *  root anyway: ~/.local/bin/copilot-env would resolve its root to ~/.local, which has one.
 *  Exported so the installer's tests can assert it produces exactly this layout. */
export const INSTALL_ROOT_MARKERS = ["bin", "shell", join("src", "scripts")] as const;

/**
 * The sentinel manifest `agent install` writes into every installed root (JSON:
 * version, install kind, materialized-asset inventory). A checkout never has one,
 * so a valid manifest is positive proof a root is an install -- `looksLikeInstallRoot`
 * accepts it on its own. An external contract: renaming it would make every existing
 * install look pre-manifest again.
 */
export const INSTALL_MANIFEST_FILE = ".copilot-env-install.json";

/** What the manifest records: which release wrote the root and what it put there. */
export interface InstallManifest {
  version: string;
  kind: "installed";
  assets: string[];
}

/**
 * The manifest, read and validated. The states matter to different consumers:
 * `absent` is normal (a checkout, a pre-manifest install), `invalid` is a
 * corrupted or foreign file, and `unreadable` means we could not even look --
 * the destructive gates treat that last one as "cannot prove", never as "absent".
 */
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
    // A dangling symlink also reads as ENOENT; only a missing directory entry
    // is genuinely absent, anything else is an entry we could not read.
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

/** Whether `resolved` is the TOP of a versioned install: the real link layout
 *  (isVersionedInstallTop) plus a valid per-version manifest -- through the
 *  link, or in any version dir when the link dangles. The manifest requirement
 *  keeps the destructive gates honest: layout-shaped entries alone never
 *  qualify a directory for recursive deletion. */
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

/**
 * Whether `root` actually looks like a copilot-env root, i.e. is safe to delete
 * recursively. `agent uninstall` removes the resolved root wholesale, and that root is
 * DERIVED (two levels up from the binary, or an env override), so a binary copied
 * somewhere unexpected would otherwise aim `rm -rf` at an unrelated directory. The
 * mirror image of install.sh's refusal to install into `$HOME` or a filesystem root.
 */
export function looksLikeInstallRoot(root: string): boolean {
  const resolved = resolve(root);
  if (resolved === dirname(resolved)) return false; // a filesystem root
  if (resolved === resolve(homedir())) return false;
  // A valid manifest alone qualifies: it is the install's own record, and a
  // user-deleted asset dir must not make a real install invisible to uninstall.
  // Unreadable means we could not look, and a root we cannot inspect is not one
  // we may delete. Absent or invalid (a checkout, a pre-manifest install, a
  // corrupted file) falls back to the fixed marker layout.
  const reading = readInstallManifest(resolved);
  if (reading.kind === "valid") return true;
  if (reading.kind === "unreadable") return false;
  // A versioned TOP has no root manifest (the sentinel is per-version); its
  // layout entries plus a version manifest are the positive proof instead.
  if (looksLikeVersionedInstallTop(resolved)) return true;
  return INSTALL_ROOT_MARKERS.every((marker) => existsSync(join(resolved, marker)));
}

/** Absolute path to the POSIX `agent` launcher (bin/agent). */
const AGENT_LAUNCHER: string = join(PROJECT_ROOT, "bin", "agent");
/** Absolute path to the PowerShell `agent` launcher (bin/agent.ps1). */
const AGENT_LAUNCHER_PS1: string = join(PROJECT_ROOT, "bin", "agent.ps1");

/**
 * The argv for the credential resolver the agent Direct configs shell into. Single
 * source of truth so the WRITE sites (Codex `auth.command`, Claude apiKeyHelper) and
 * the health VERIFY site stay byte-identical -- if they drift, health stops
 * recognizing the very config the writer just wrote.
 */
export const AGENT_AUTH_GET_ARGS: readonly string[] = ["auth", "--get"];

/** `AGENT_AUTH_GET_ARGS` addressed at `profile` (null = the default credential). */
export function agentAuthGetArgs(profile: Profile = null): string[] {
  return profile === null
    ? [...AGENT_AUTH_GET_ARGS]
    : [...AGENT_AUTH_GET_ARGS, "--profile", profile];
}

/** The `agent proxy-token` argv for the HEADLESS path at `profile`: `--yes` (never
 *  prompt -- Codex/Claude run the resolver on a timer and can't answer one), plus the
 *  profile selector when named. Single source of truth, like AGENT_AUTH_GET_ARGS, so
 *  the write sites and the wiring inspectors stay byte-identical. */
export function proxyTokenArgs(profile: Profile = null): string[] {
  return profile === null
    ? ["proxy-token", "--yes"]
    : ["proxy-token", "--yes", "--profile", profile];
}

/**
 * The platform `{ command, args }` to run the proxy-mode credential resolver --
 * `agent proxy-token --yes` (src/commands/proxy_token.ts) -- as a NATIVE subprocess
 * (Codex's `auth.command`): it ensures the addressed proxy is up per the
 * managed-lifecycle rules, then prints its key on stdout. `profile` routes the
 * resolver at that profile's daemon. (src/scripts/proxy-token.{sh,ps1} remain only
 * as one-release forwarders onto this subcommand for configs older releases wrote.)
 */
export function proxyTokenCommand(profile: Profile = null): { command: string; args: string[] } {
  return agentLauncherCommand(proxyTokenArgs(profile));
}

/**
 * The platform `{ command, args }` to invoke `agent <subArgs...>` as a NATIVE
 * subprocess -- i.e. spawned directly by another program (Codex's `auth.command`,
 * which the codex binary runs itself), not from inside a shell. On Windows the
 * bash launcher isn't directly executable, so go through PowerShell + the `.ps1`.
 */
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
