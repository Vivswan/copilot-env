// Migration from 3.3.3: bring the GitHub credential onto the provider-driven store,
// and unify the Codex model provider under the single `copilot-env` id.
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { consola } from "consola";
import { parse, stringify } from "smol-toml";

import { CODEX_PROVIDER_ID, effectiveCodexHome } from "../codex/config.ts";
import { CopilotEnvState } from "../copilot_api/env_state.ts";
import { CopilotApiPaths } from "../copilot_api/paths.ts";
import { errMessage } from "../utils/error.ts";
import { isRecord } from "../utils/json.ts";
import type { Migration } from "./index.ts";

// The pre-unification Codex provider id. It lives ONLY here: the rest of the codebase
// is forward-only and knows just `copilot-env` (this migration rewrites every existing
// config during `agent update`, so forward code never meets the legacy name).
const LEGACY_CODEX_PROVIDER = "github-copilot-direct";

/**
 * Rewrite one Codex `config.toml` from the legacy `github-copilot-direct` provider to
 * the unified `copilot-env` provider: fold the legacy table into `copilot-env`
 * (rewriting the old display name), drop the legacy table, and repoint
 * `model_provider`. A targeted TOML edit that preserves the install's existing mode +
 * fields. Idempotent — a config with no legacy table/name is left untouched. Returns
 * whether it changed the file.
 */
function rewriteLegacyCodexProvider(codexHome: string): boolean {
  const configPath = join(codexHome, "config.toml");
  let doc: Record<string, unknown>;
  try {
    if (!statSync(configPath).isFile()) return false;
    doc = parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  } catch {
    return false; // absent or unparseable — nothing to rewrite
  }
  let changed = false;

  const providers = isRecord(doc.model_providers) ? doc.model_providers : null;
  if (providers !== null && isRecord(providers[LEGACY_CODEX_PROVIDER])) {
    const legacy = providers[LEGACY_CODEX_PROVIDER];
    const current = isRecord(providers[CODEX_PROVIDER_ID]) ? providers[CODEX_PROVIDER_ID] : {};
    // Which table is AUTHORITATIVE is decided by `model_provider`: if the install
    // selects the legacy direct provider, the legacy (direct) table must win — else a
    // stale leftover `copilot-env` proxy table would override it and silently flip the
    // install to proxy. If `copilot-env` is the selected/default, keep it and just fold
    // the legacy table under it. The unselected table's keys come second either way.
    const legacySelected = doc.model_provider === LEGACY_CODEX_PROVIDER;
    const merged: Record<string, unknown> = legacySelected
      ? { ...current, ...legacy }
      : { ...legacy, ...current };
    if (merged.name === "GitHub Copilot Direct") merged.name = CODEX_PROVIDER_ID;
    providers[CODEX_PROVIDER_ID] = merged;
    delete providers[LEGACY_CODEX_PROVIDER];
    changed = true;
  }
  if (doc.model_provider === LEGACY_CODEX_PROVIDER) {
    doc.model_provider = CODEX_PROVIDER_ID;
    changed = true;
  }

  if (changed) writeFileSync(configPath, stringify(doc));
  return changed;
}

// Rewrite the Codex config at the ACTIVE home — `effectiveCodexHome()` resolves
// state.codexHome (a `--host` farm) -> $CODEX_HOME -> ~/.codex, so this covers both the
// default and a configured farm. Other (non-active) farm homes heal on their next
// `agent codex --host`, which writes the unified provider. Best-effort: a failure warns.
function unifyCodexProvider(): void {
  const home = effectiveCodexHome();
  try {
    if (rewriteLegacyCodexProvider(home)) {
      consola.info(`Unified the Codex provider to '${CODEX_PROVIDER_ID}' in ${home}`);
    }
  } catch (e) {
    consola.warn(`Could not unify the Codex provider in ${home} (non-fatal): ${errMessage(e)}`);
  }
}

// Leaving 3.3.3 behind, two one-time fix-ups:
//
// 1. Credential store. The GitHub token is now copilot-env's single source of truth
//    (the state store), resolved at fetch time via `agent auth --get`. Bring two
//    pre-provider shapes onto the model so neither appears unauthenticated:
//      (a) A token already in OUR store but with no recorded provider (an unreleased
//          `--gh-token` flow). The resolver ignores a token with no provider, so
//          record `gh-token` to keep it resolving.
//      (b) A proxy user who logged in through copilot-api's OWN device flow has the
//          token only in copilot-api's `github_token` file. Import it recording
//          `copilot`, then scrub the redundant copy.
// 2. Codex provider unification: rewrite a pre-unification `github-copilot-direct`
//    config to the single `copilot-env` provider (see unifyCodexProvider).
export const migration: Migration = {
  version: "3.3.3",
  description: "provider-driven credential store + unify the Codex provider to copilot-env",
  run: () => {
    // (2) first, so the credential block's early returns can't skip it.
    unifyCodexProvider();

    const state = new CopilotEnvState();

    // (1a) Backfill a provider for a stored-but-unattributed token.
    {
      const { githubToken, authProvider } = state.read();
      if (githubToken !== null && authProvider === null) {
        state.set({ authProvider: "gh-token" });
        consola.info("Recorded the gh-token provider for the existing stored GitHub token");
      }
    }

    // (1b) Import copilot-api's own device-flow token, if any.
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
