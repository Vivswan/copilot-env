// Migration from 3.3.3: bring the GitHub credential onto the provider-driven store.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { consola } from "consola";

import { CopilotEnvState } from "../copilot_api/env_state.ts";
import { CopilotApiPaths } from "../copilot_api/paths.ts";
import type { Migration } from "./index.ts";

// Leaving 3.3.3 behind: the GitHub token is now copilot-env's single source of truth
// (the state store), resolved at fetch time via `agent auth --get` by the new
// provider-driven `Credential`. This migration brings two pre-provider shapes onto
// the model so neither appears unauthenticated after the update:
//   (a) A token already in OUR store but with no recorded provider (an unreleased
//       `--gh-token` flow wrote exactly that). The resolver now ignores a token with
//       no provider, so record `gh-token` to keep it resolving.
//   (b) A proxy user who logged in through copilot-api's OWN device flow has the
//       token only in copilot-api's `github_token` file. Import it (so Direct + the
//       proxy resolve from one place) recording `copilot`, then scrub the redundant
//       copy — the proxy receives the token via `--github-token` from the store.
export const migration: Migration = {
  version: "3.3.3",
  description: "bring the GitHub credential onto the provider-driven store (backfill + import)",
  run: () => {
    const state = new CopilotEnvState();

    // (a) Backfill a provider for a stored-but-unattributed token.
    {
      const { githubToken, authProvider } = state.read();
      if (githubToken !== null && authProvider === null) {
        state.set({ authProvider: "gh-token" });
        consola.info("Recorded the gh-token provider for the existing stored GitHub token");
      }
    }

    // (b) Import copilot-api's own device-flow token, if any.
    const tokenFile = new CopilotApiPaths().githubTokenFile;
    if (!existsSync(tokenFile)) return; // nothing to consolidate (idempotent)

    let theirs: string;
    try {
      theirs = readFileSync(tokenFile, "utf8").trim();
    } catch {
      return; // unreadable — leave it alone
    }
    if (!theirs) return;

    // Import ONLY when copilot-env has no credential of its own (no token AND no
    // chosen provider) — so a token or provider the user already set via `agent auth`
    // (including a no-token `gh-cli` choice, or the backfill above) is never
    // overwritten on a retry. The imported token came from copilot-api's device flow,
    // so record `copilot`.
    const { githubToken: ours, authProvider } = state.read();
    if (ours === null && authProvider === null) {
      state.set({ githubToken: theirs, authProvider: "copilot" });
      consola.info("Imported copilot-api's GitHub token into the copilot-env store");
    }

    // Scrub copilot-api's copy now that the store holds a token (it's redundant —
    // `agent start` passes the stored token to the daemon via --github-token).
    if (state.read().githubToken !== null) {
      try {
        rmSync(tokenFile, { force: true });
        consola.info("Removed copilot-api's redundant github_token file");
      } catch {
        // best-effort scrub
      }
    }
  },
};
