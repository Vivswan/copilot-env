// Away from 4.0.2: gh-cli slots recorded before account pinning existed carry
// no pin, so they follow gh's ACTIVE account -- a later `gh auth login` (or
// switch) would silently move whose Copilot credit gets spent. The fix-up pins
// every pin-less gh-cli slot to the machine's SOLE gh account, but only after
// proving `gh auth token --user <login>` resolves (an env-only token lists a
// login gh has no saved credential for -- pinning it would break a working
// auto slot); a multi-account machine is left on auto (only the user can
// choose between accounts -- the next `agent auth` asks). Idempotent: pinned
// slots and non-gh-cli slots are untouched, and a re-run re-derives the same
// answer.
import { consola } from "consola";
import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { reconcileClaudeDesktopWiring } from "../agents/claude_desktop.ts";
import { desktopHelperScriptWiring } from "../claude/desktop.ts";
import { type GhAccountsLook, ghAccountsLook, ghAuthTokenLook } from "../copilot_api/credential.ts";
import { CopilotEnvState } from "../copilot_api/env_state.ts";
import { GH_COPILOT_HOST, GH_LOGIN_RE } from "../copilot_api/gh_cli.ts";
import { resolveRootHome } from "../copilot_api/paths.ts";
import type { Profile } from "../copilot_api/profile.ts";
import type { Migration } from "./index.ts";

/** The machine's sole pickable github.com login, or null: the same pin-or-ask
 *  rule the auth flow settles with. An unproven look pins nothing (a guess
 *  could spend the wrong account's credit), and so does any count but one --
 *  where EVERY github.com entry counts, broken ones included: a broken active
 *  login is still an account the user never chose to abandon, so a healthy
 *  bystander is never pinned over it. A login seen only broken could never
 *  verify its pin. */
function soleGhLogin(look: () => GhAccountsLook): string | null {
  const { accounts, unproven } = look();
  if (unproven) return null;
  const github = accounts.filter((a) => a.host === GH_COPILOT_HOST);
  const logins = [...new Set(github.map((a) => a.login))];
  if (logins.length !== 1) return null;
  if (!github.some((a) => a.broken !== true)) return null;
  const only = logins[0] ?? "";
  return GH_LOGIN_RE.test(only) ? only : null;
}

/** Pin `profile`'s pin-less gh-cli slot to `login`. setCredential is the one
 *  write path (it also invalidates the credential-derived identity cache). */
function pinSlot(state: CopilotEnvState, profile: Profile, login: string): void {
  state.setCredential(profile, { kind: "gh-cli", ghUser: login });
  consola.info(
    `  pinned ${
      profile === null ? "the default credential" : `profile '${profile}'`
    } to gh account ${login}`,
  );
}

/** Exported for the migration test; `look` and `resolves` substitute the gh
 *  spawns (`resolves` proves a pinned `gh auth token --user <login>` would
 *  serve a token -- the login of an env-only GH_TOKEN fails it). */
export function pinSoleGhAccount(
  look: () => GhAccountsLook = ghAccountsLook,
  resolves: (login: string) => boolean = (login) => ghAuthTokenLook(login).token !== null,
): void {
  const state = new CopilotEnvState();
  const data = state.read();
  const unpinned: Profile[] = [];
  if (data.authProvider === "gh-cli" && data.ghUser === null) unpinned.push(null);
  for (const name of state.profileNames()) {
    const credential = state.readCredential(name);
    if (credential.kind === "gh-cli" && credential.ghUser === null) unpinned.push(name);
  }
  if (unpinned.length === 0) return;
  const login = soleGhLogin(look);
  if (login === null) {
    consola.info(
      "  gh-cli slots left on auto (no single gh login to pin); " +
        "run `agent auth --provider gh-cli` to choose one",
    );
    return;
  }
  if (!resolves(login)) {
    consola.info(
      "  gh-cli slots stay on auto (still served by gh's active account): a pinned " +
        `\`gh auth token --user ${login}\` did not resolve - e.g. an env-only token. ` +
        "Run `gh auth login` to save the login, then `agent auth --provider gh-cli` to pin it.",
    );
    return;
  }
  for (const profile of unpinned) pinSlot(state, profile, login);
}

export const v402GhAccountPin: Migration = {
  version: "4.0.2",
  description:
    "pin pin-less gh-cli credentials (default + named profiles) to the machine's sole gh account",
  run: () => pinSoleGhAccount(),
};

// --- root-home layout ------------------------------------------------------------
//
// Away from 4.0.2: the root home predates its own directory -- its stores wore
// dot-prefixed `.copilot-env-*` names from the era when the root doubled as the
// proxy's flat daemon home, lock sidecars (permanent by design, file_lock.ts)
// piled up beside them, and the Claude Desktop helper scripts sat loose at the
// top level. The new layout is plain names (credentials.json / preferences.json
// / ownership.json), every root lock under `locks/`, and the helper scripts
// under `helpers/`. Readers know ONLY the new paths; these two fix-ups are the
// single place the old names exist. TWO steps because they need opposite ends
// of the run: the store renames are a `layout` step (hoisted, right after the
// 3.5.6 home move that may carry the old-name stores in), while the helper move
// runs LAST -- its wiring pass reads the agents' configs, which the v356/v400
// wiring rewrites must normalize first.

/** The three store renames, old basename -> new basename. */
const STORE_RENAMES: ReadonlyArray<readonly [string, string]> = [
  [".copilot-env-state.json", "credentials.json"],
  [".copilot-env-config.json", "preferences.json"],
  [".copilot-env-ownership.json", "ownership.json"],
];

/** Root-level lock debris the old layout left beside the stores: the markers and
 *  the permanent .oslock sidecars now live under `locks/`. */
const LOCK_DEBRIS: readonly string[] = [
  ".copilot-env-state.json.lock",
  ".copilot-env-config.json.lock",
  ".copilot-env-ownership.json.lock",
  ".copilot-env-ownership.json.ops.lock",
  "github_token.login.lock",
].flatMap((name) => [name, `${name}.oslock`]);

/** Loose Claude Desktop helper scripts at the root top level (desktopHelperPath
 *  now puts them under `helpers/`), recognized by the same filename grammar the
 *  sweeps use (desktopHelperScriptWiring) so a neighbour's lookalike -- a `.bak`
 *  copy, a reserved `default` suffix -- is never deleted. */
function isGeneratedHelperName(name: string): boolean {
  return desktopHelperScriptWiring(name) !== undefined;
}

/** The store renames + lock debris ONLY (the layout step, hoisted to the front
 *  of the run right after the 3.5.6 home move -- every later step reads the
 *  stores at their new paths). The Desktop helper move lives in its own LAST
 *  step (moveDesktopHelpers): its reconcile derives targets from the agents'
 *  wiring, which the v356/v400 wiring rewrites have not normalized yet this
 *  early -- reconciling now could misread a valid entry as an orphan.
 *  Exported for the migration test; `rootHome` isolates. */
export function moveRootStores(rootHome: string = resolveRootHome()): void {
  for (const [oldName, newName] of STORE_RENAMES) {
    const oldPath = join(rootHome, oldName);
    const newPath = join(rootHome, newName);
    if (!existsSync(oldPath)) continue;
    if (existsSync(newPath)) {
      consola.warn(
        `  both ${oldPath} and ${newPath} exist - keeping ${newName} (the one readers use); ` +
          `delete ${oldName} by hand after checking it holds nothing newer`,
      );
      continue;
    }
    renameSync(oldPath, newPath);
    consola.info(`  moved ${oldName} -> ${newName}`);
  }
  for (const name of LOCK_DEBRIS) {
    const path = join(rootHome, name);
    if (existsSync(path)) rmSync(path, { force: true });
  }
}

/** Delete the loose generated helper scripts and run ONE Desktop wiring pass to
 *  regenerate them under `helpers/` (and heal the Desktop entries to match).
 *  Exported for the migration test; `reconcile` substitutes the wiring pass.
 *  NOT quiet: quiet skips the per-target sync, and regenerating the deleted
 *  helpers IS the point. */
export async function moveDesktopHelpers(
  rootHome: string = resolveRootHome(),
  reconcile: () => Promise<void> = () => reconcileClaudeDesktopWiring(),
): Promise<void> {
  let helpersRemoved = false;
  let entries: string[] = [];
  try {
    entries = readdirSync(rootHome);
  } catch {
    // No root home yet: a fresh install has nothing to move.
  }
  for (const entry of entries) {
    if (isGeneratedHelperName(entry)) {
      rmSync(join(rootHome, entry), { force: true });
      helpersRemoved = true;
      consola.info(`  removed ${entry} (regenerated under helpers/ by the Desktop wiring)`);
    }
  }
  if (helpersRemoved) await reconcile();
}

export const v402RootLayout: Migration = {
  version: "4.0.2",
  layout: true,
  description:
    "root home layout: plain store names (credentials/preferences/ownership), locks/ dir",
  run: () => moveRootStores(),
};

export const v402DesktopHelpers: Migration = {
  version: "4.0.2",
  description: "move the Claude Desktop helper scripts under helpers/ (one wiring pass)",
  run: () => moveDesktopHelpers(),
};
