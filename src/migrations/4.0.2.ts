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
import { type GhAccountsLook, ghAccountsLook, ghAuthTokenLook } from "../copilot_api/credential.ts";
import { CopilotEnvState } from "../copilot_api/env_state.ts";
import { GH_COPILOT_HOST, GH_LOGIN_RE } from "../copilot_api/gh_cli.ts";
import type { Profile } from "../copilot_api/profile.ts";
import type { Migration } from "./index.ts";

/** The machine's sole pickable github.com login, or null: the same pin-or-ask
 *  rule the auth flow settles with. An unproven look pins nothing (a guess
 *  could spend the wrong account's credit), and so does any count but one. */
function soleGhLogin(look: () => GhAccountsLook): string | null {
  const { accounts, unproven } = look();
  if (unproven) return null;
  const logins = [
    ...new Set(
      accounts
        .filter((a) => a.host === GH_COPILOT_HOST && a.broken !== true)
        .map((a) => a.login),
    ),
  ];
  const only = logins.length === 1 ? logins[0] ?? "" : "";
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
      "  gh-cli slots left on the active account (no single gh login to pin); " +
        "run `agent auth` to choose one",
    );
    return;
  }
  if (!resolves(login)) {
    consola.info(
      `  gh-cli slots left on the active account (a pinned \`gh auth token ` +
        `--user ${login}\` did not resolve - e.g. an env-only token with no ` +
        "saved credential); run `agent auth` to choose one",
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
