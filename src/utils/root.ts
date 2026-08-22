// Install-root and bundled-asset discovery for launchers, tests, and compiled binaries.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Profile } from "../copilot_api/profile.ts";

/**
 * How this copy of copilot-env is running, and the ON-DISK install root that follows.
 *
 * - `checkout`: running from source (`deno run src/cli.ts`) -- a dev clone or a
 *   worktree. The root is the source tree itself, so the code we execute and the
 *   files we manage are the same directory.
 * - `compiled`: running as a `deno compile` binary installed at
 *   `<root>/bin/agent-bin`. The root is derived from `Deno.execPath()`, NEVER from
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

/**
 * `Deno.build.standalone` is the runtime's own answer to "am I a compiled binary",
 * true only inside a `deno compile` executable. Preferred over sniffing the shape of
 * `import.meta.url`: the VFS path is a plain `file:` URL under the temp dir, so it is
 * indistinguishable from a legitimate source path by scheme, and its directory name
 * follows the output file name (not `--app-name`), which no contract pins.
 */
function detectRootMode(): RootMode {
  if (!Deno.build.standalone) return { kind: "checkout", root: findCheckoutRoot() };
  const override = process.env[ROOT_OVERRIDE_ENV];
  // <root>/bin/agent-bin -> <root>. The installers put the binary there and the
  // bin/agent shim next to it; nothing else may define the layout.
  const root = override ? resolve(override) : dirname(dirname(Deno.execPath()));
  return { kind: "compiled", root };
}

const ROOT_MODE: RootMode = detectRootMode();

/** How this process is running, resolved once at startup. */
export function rootMode(): RootMode {
  return ROOT_MODE;
}

/** The on-disk install root: the checkout in dev, the binary's install dir when compiled. */
export const PROJECT_ROOT: string = ROOT_MODE.root;

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
 *  materializes them out of the binary. `bin` alone is not enough to identify a root --
 *  ~/.local/bin/agent-bin would resolve its root to ~/.local, which has one. */
const INSTALL_ROOT_MARKERS = ["bin", "shell", join("src", "scripts")] as const;

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

/** The shared proxy-token scripts (ensure the proxy + print its key); .ps1 is the
 *  Windows parity. Referenced by Codex's `auth.command` and Claude's `apiKeyHelper`. */
export const PROXY_TOKEN_SCRIPT_SH: string = join(PROJECT_ROOT, "src", "scripts", "proxy-token.sh");
const PROXY_TOKEN_SCRIPT_PS1: string = join(PROJECT_ROOT, "src", "scripts", "proxy-token.ps1");

/** The proxy-token script arguments for the HEADLESS path at `profile`:
 *  `--yes` (never prompt), plus the profile selector when named. */
export function proxyTokenScriptArgs(profile: Profile = null): string[] {
  return profile === null ? ["--yes"] : ["--yes", "--profile", profile];
}

/**
 * The platform `{ command, args }` to run the shared proxy-token script as a NATIVE
 * subprocess (Codex's `auth.command`): `/bin/sh <script>.sh --yes` on POSIX,
 * `powershell -File <script>.ps1 --yes` on Windows. `--yes` selects the headless path
 * (never prompt) -- Codex/Claude run this on a timer and can't answer a prompt.
 * `profile` routes the resolver at that profile's daemon.
 */
export function proxyTokenCommand(profile: Profile = null): { command: string; args: string[] } {
  const scriptArgs = proxyTokenScriptArgs(profile);
  if (process.platform === "win32") {
    return {
      command: "powershell",
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        PROXY_TOKEN_SCRIPT_PS1,
        ...scriptArgs,
      ],
    };
  }
  return { command: "/bin/sh", args: [PROXY_TOKEN_SCRIPT_SH, ...scriptArgs] };
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
