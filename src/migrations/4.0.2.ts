// Away from 4.0.2: gh-cli slots recorded before account pinning follow gh's ACTIVE account, so a
// later `gh auth login` would silently move whose Copilot credit gets spent. The fix-up pins every
// pin-less gh-cli slot to the machine's SOLE gh account.
//
//   sole login, `gh auth token --user <login>` resolves -> pinned
//   sole login, no saved credential (env-only token)    -> auto; pinning would break a working slot
//   several logins, or the account look never ran       -> auto; only the user can choose
//   already pinned, or not gh-cli                       -> untouched
import { consola } from "consola";
import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join, normalize } from "node:path";
import { reconcileClaudeDesktopWiring } from "../agents/claude_desktop.ts";
import {
  claudeDesktopInstalled,
  desktopHelperScriptWiring,
  readFileOrNull,
} from "../claude/desktop.ts";
import { type GhAccountsLook, ghAccountsLook, ghAuthTokenLook } from "../copilot_api/credential.ts";
import { CopilotEnvState } from "../copilot_api/env_state.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { OwnershipLedger } from "../copilot_api/ownership.ts";
import { GH_COPILOT_HOST, GH_LOGIN_RE } from "../copilot_api/gh_cli.ts";
import { resolveRootHome } from "../copilot_api/paths.ts";
import type { Profile } from "../copilot_api/profile.ts";
import { isRecord } from "../utils/json.ts";
import type { Migration } from "./index.ts";

/** The same pin-or-ask rule the auth flow settles with. An unproven look pins nothing, and so
 *  does any count but one, where EVERY github.com entry counts, broken ones included: a broken
 *  active login is still an account the user never chose to abandon, so a healthy bystander is
 *  never pinned over it. A login seen only broken could never verify its pin. */
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
// Away from 4.0.2: the root home wore dot-prefixed `.copilot-env-*` stores, their lock sidecars,
// and loose Desktop helper scripts from the era when the root doubled as the flat daemon home.
// Readers know ONLY the new paths, so these two fix-ups are the single place the old names exist.
// They sit at opposite ends of the run:
//
//   store renames -> a `layout` step, right after the 3.5.6 home move, which may carry old-name
//                    stores in
//   helper move   -> LAST: its wiring pass reads agent configs the v356/v400 rewrites normalize
//                    first

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
  ".profile-ports.lock",
  "github_token.login.lock",
].flatMap((name) => [name, `${name}.oslock`]);

/** The layout step (hoisted; see the section comment). The Desktop helper move is its own LAST
 *  step (moveDesktopHelpers): reconciling this early, before the wiring rewrites, could misread
 *  a valid entry as an orphan. Exported for the migration test; `rootHome` isolates. */
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

/** Every helper path an owned Desktop entry still REFERENCES (`inferenceCredentialHelper`), one
 *  ledger read. Fail closed: an unreadable ledger or entry document THROWS (runMigrations warns
 *  and nothing gets deleted), while a proven-absent entry references nothing. */
function referencedDesktopHelpers(): Set<string> {
  const referenced = new Set<string>();
  for (const path of new OwnershipLedger().ownedPaths("claudeDesktop")) {
    const raw = readFileOrNull(path);
    if (raw === null) continue;
    let doc: unknown;
    try {
      doc = JSON.parse(raw);
    } catch {
      continue; // an unparseable entry document names no helper
    }
    const helper = isRecord(doc) ? doc["inferenceCredentialHelper"] : undefined;
    if (typeof helper === "string") referenced.add(helper);
  }
  return referenced;
}

/** Path equality as the filesystem judges it: case-blind on Windows, where an entry's recorded
 *  path can differ from today's resolved root home only in case. */
function samePath(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  return process.platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/** One Desktop wiring pass FIRST (it regenerates the helpers under `helpers/` and rewires the
 *  entries to them), then delete exactly the loose helpers NO entry of ours references: the
 *  direct safety property, not a proxy for it. The pass is never quiet, because quiet skips the
 *  per-target sync and regenerating the helpers IS the point.
 *
 *    an entry the pass rewired -> its loose helper goes
 *    an entry it could not     -> the helper stays and keeps WORKING, and the notice says how to
 *                                 finish by hand: a shipped migration range never re-runs */
export async function moveDesktopHelpers(
  rootHome: string = resolveRootHome(),
  reconcile: () => Promise<void> = () => reconcileClaudeDesktopWiring(),
  desktopWired: () => boolean = () =>
    claudeDesktopInstalled() && new CopilotEnvConfig().claudeDesktopEnabled(),
  referenced: () => Set<string> = referencedDesktopHelpers,
): Promise<void> {
  let entries: string[] = [];
  try {
    entries = readdirSync(rootHome);
  } catch {
    // No root home yet: a fresh install has nothing to move.
  }
  const loose = entries.filter((name) => desktopHelperScriptWiring(name) !== undefined);
  if (loose.length === 0) return;
  if (desktopWired()) await reconcile();
  const stillReferenced = [...referenced()];
  for (const name of loose) {
    const path = join(rootHome, name);
    if (stillReferenced.some((ref) => samePath(ref, path))) {
      consola.info(
        `  kept ${name} (a Claude Desktop entry still references it) - rewire with ` +
          "`agent claude`, then delete it by hand",
      );
      continue;
    }
    rmSync(path, { force: true });
    consola.info(`  removed ${name} (the Desktop wiring now lives under helpers/)`);
  }
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
