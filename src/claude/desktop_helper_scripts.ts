// The credential-helper scripts a Desktop entry names (Desktop's inferenceCredentialHelper is a
// file path, not a command): their paths, bodies, landing, retirement, and the filename grammar the
// sweeps read them back by.
import { join } from "node:path";
import type { ProfileMode } from "../copilot_api/env_state.ts";
import { HELPERS_DIR_NAME, resolveRootHome } from "../copilot_api/paths.ts";
import { parseProfileName, type Profile } from "../copilot_api/profile.ts";
import { errMessage } from "../utils/error.ts";
import { isEnoentOrNotdir, WIN } from "../utils/fs.ts";
import * as fs from "../utils/fs_facade.ts";
import { createStderrLogger } from "../utils/logger.ts";
import { agentAuthGetArgs, agentLauncherCommand, proxyTokenArgs } from "../utils/root.ts";
import { readFileOrNull, removeFile } from "./desktop_library.ts";
import { cmdHelperBody, posixExecBody } from "./helper_body.ts";

const logger = createStderrLogger();

/** Under the root home's helpers/ dir (a foreign program executes it), which uninstall already
 *  sweeps. */
export function desktopHelperPath(rootHome: string, mode: ProfileMode, profile: Profile): string {
  const base = mode === "direct" ? "claude-desktop-token" : "claude-desktop-proxy-token";
  const name = profile === null ? base : `${base}-${profile}`;
  return join(rootHome, HELPERS_DIR_NAME, `${name}${WIN ? ".cmd" : ".sh"}`);
}

/** A helper script as the writer judges it: the body this wiring wants, the file's current body
 *  (null: absent), and its path. Read up front, so a wire refuses on an unreadable helper before it
 *  reserves or writes anything. */
interface DesktopHelperScript {
  path: string;
  body: string;
  current: string | null;
}

export function readDesktopHelperScript(mode: ProfileMode, profile: Profile): DesktopHelperScript {
  const path = desktopHelperPath(resolveRootHome(), mode, profile);
  return { path, body: desktopHelperBody(mode, profile), current: readFileOrNull(path) };
}

/** The executable bit is healed even when the body matched (a chmod'd-away +x would otherwise
 *  survive every wire). The OTHER mode's script is retired separately (planRemoveHelperScripts)
 *  AFTER the entry saves, so a failed save never leaves the current entry pointing at a deleted
 *  helper. */
export function landDesktopHelperScript({ path, body, current }: DesktopHelperScript): void {
  if (current !== body) fs.writeText(path, body, { mode: 0o755 });
  else if (!helperExecutable(path)) fs.chmod(path, 0o755);
}

/** Read and landed in one step; returns the script's path. */
export function writeDesktopHelperScript(mode: ProfileMode, profile: Profile): string {
  const helper = readDesktopHelperScript(mode, profile);
  landDesktopHelperScript(helper);
  return helper.path;
}

/** ONE builder for the writer and the status inspector, so "wired" always means "this body". */
export function desktopHelperBody(mode: ProfileMode, profile: Profile): string {
  const { command, args } = agentLauncherCommand(
    mode === "direct" ? agentAuthGetArgs(profile) : proxyTokenArgs(profile),
  );
  return WIN ? cmdHelperBody(command, args) : posixExecBody(command, args);
}

/** A Windows .cmd runs by extension, never stat'ed; on POSIX a file that cannot be stat'ed throws.
 *  Through the facade, so a body this dry run landed 0755 reads executable. */
export function helperExecutable(path: string): boolean {
  return WIN || (fs.stat(path).mode & 0o111) === 0o111;
}

/** The look now, the removal when the returned step runs (post-save). A directory at a path is
 *  warned once and left alone, in both runs; the entry the script served still lands or goes on its
 *  own. Any other failure is the caller's. */
export function planRemoveFiles(paths: readonly string[]): () => void {
  const removable = paths.filter((path) => {
    try {
      fs.assertNotDirectory(path);
      return true;
    } catch (e) {
      logger.warn(`  Claude Desktop: ${errMessage(e)}; left alone.`);
      return false;
    }
  });
  return () => {
    for (const path of removable) removeFile(path);
  };
}

/** `profile`'s helper scripts: both modes', or with `keep` (the mode a wire just landed) the OTHER
 *  mode's alone. */
export function planRemoveHelperScripts(profile: Profile, keep?: ProfileMode): () => void {
  const rootHome = resolveRootHome();
  const modes: ProfileMode[] = ["direct", "proxy"];
  return planRemoveFiles(
    modes.filter((mode) => mode !== keep).map((mode) => desktopHelperPath(rootHome, mode, profile)),
  );
}

/** The filename grammar desktopHelperPath produces, either platform's extension. */
const HELPER_SCRIPT_NAME_RE = /^claude-desktop-(proxy-)?token(?:-([a-z0-9-]+))?\.(?:sh|cmd)$/;

/** The inverse of desktopHelperPath; undefined for a name that is not ours (a reserved word like
 *  `default` included), so a sweep by filename names every generated script without a store, yet
 *  never a neighbour's file. */
export function desktopHelperScriptWiring(
  name: string,
): { mode: ProfileMode; profile: Profile } | undefined {
  const match = HELPER_SCRIPT_NAME_RE.exec(name);
  if (match === null) return undefined;
  const mode: ProfileMode = match[1] === undefined ? "direct" : "proxy";
  if (match[2] === undefined) return { mode, profile: null };
  try {
    return { mode, profile: parseProfileName(match[2]) };
  } catch {
    return undefined;
  }
}

/** An absent root home is an empty list; any other failure throws, since a sweep must not claim
 *  completeness over a directory it could not list. Listed through the facade, so a script this
 *  dry run removed is gone to the run's later readers (the status read that decides a re-sync). */
export function presentDesktopHelperScripts(rootHome: string): string[] {
  const helpersDir = join(rootHome, HELPERS_DIR_NAME);
  let names: string[];
  try {
    names = fs.readdir(helpersDir);
  } catch (e) {
    if (isEnoentOrNotdir(e)) return [];
    throw e;
  }
  return names
    .filter((n) => desktopHelperScriptWiring(n) !== undefined)
    .sort()
    .map((n) => join(helpersDir, n));
}
