// Migration from 3.3.6: re-point existing agent configs at 127.0.0.1.
//
// 3.3.6 changed the agent-facing proxy base URL from http://localhost:<port> to
// http://127.0.0.1:<port> (the daemon binds IPv4; on Windows `localhost` resolves to ::1 first
// with no fallback, so the agent CLIs ECONNREFUSED the proxy). It also made the Claude
// apiKeyHelper a `.cmd` on Windows. Both only affect FRESHLY-written configs, so an existing
// install that merely runs `agent update` keeps its stale localhost base URLs (and, on Windows,
// a `.sh` helper inspectClaudeWiring no longer recognizes). Rewrite both on update.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { consola } from "consola";
import { parse, stringify } from "smol-toml";

import { configureClaudeConfig, resolveClaudeHome } from "../claude/config.ts";
import { CODEX_PROVIDER_ID, effectiveCodexHome } from "../codex/config.ts";
import { errMessage } from "../utils/error.ts";
import { isRecord, parseJsonRecord, readStringField } from "../utils/json.ts";
import type { ManagedAgentMode } from "../utils/provider_mode.ts";
import type { Migration } from "./index.ts";

// The stale base-URL host these configs were written with. Lives ONLY here: forward code
// emits 127.0.0.1 and never meets `localhost` (this migration heals existing installs).
const STALE_PREFIX = "http://localhost:";
const FRESH_PREFIX = "http://127.0.0.1:";

/** Every managed Claude apiKeyHelper basename across platforms (the `.cmd` set is 3.3.6+).
 *  Maps to the mode it selects, so a stale config's mode is recoverable even on Windows where
 *  inspectClaudeWiring no longer matches the `.sh` path. */
const MANAGED_HELPERS: Record<string, ManagedAgentMode> = {
  "copilot-token.sh": "direct",
  "copilot-token.cmd": "direct",
  "copilot-proxy-token.sh": "proxy",
  "copilot-proxy-token.cmd": "proxy",
};

/**
 * Rewrite the managed Codex provider's `base_url` from the localhost host to 127.0.0.1, in
 * place (a targeted TOML edit preserving the install's mode + fields). Idempotent: a config
 * already on 127.0.0.1 (or with no managed table / a non-local base_url) is left untouched.
 */
function repointCodexBaseUrl(): void {
  const home = effectiveCodexHome();
  const configPath = join(home, "config.toml");
  if (!existsSync(configPath)) return; // no Codex config -- nothing to re-point
  try {
    const doc = parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const providers = isRecord(doc.model_providers) ? doc.model_providers : null;
    const provider =
      providers && isRecord(providers[CODEX_PROVIDER_ID]) ? providers[CODEX_PROVIDER_ID] : null;
    if (provider === null) return;
    const baseUrl = typeof provider.base_url === "string" ? provider.base_url : null;
    if (baseUrl === null || !baseUrl.startsWith(STALE_PREFIX)) return;
    provider.base_url = FRESH_PREFIX + baseUrl.slice(STALE_PREFIX.length);
    writeFileSync(configPath, stringify(doc));
    consola.info(`Re-pointed the Codex proxy base_url to 127.0.0.1 in ${configPath}`);
  } catch (e) {
    consola.warn(`Could not re-point the Codex base_url (non-fatal): ${errMessage(e)}`);
  }
}

/**
 * Re-run the Claude config writer for the install's current managed mode. This regenerates the
 * apiKeyHelper at the CURRENT platform extension (`.cmd` on Windows, `.sh` elsewhere), repoints
 * settings.json's apiKeyHelper, and rewrites the proxy base URL to 127.0.0.1 -- the merge is
 * surgical, so unrelated user settings survive. The mode is recovered from the stale helper's
 * basename (not inspectClaudeWiring, which no longer matches a `.sh` path on Windows). A config
 * with a foreign/absent apiKeyHelper is left untouched.
 */
function repointClaudeConfig(): void {
  const home = resolveClaudeHome();
  const settingsPath = join(home, "settings.json");
  let helperPath: string | null;
  try {
    const doc = parseJsonRecord(readFileSync(settingsPath, "utf8"));
    if (doc === null) return; // absent/malformed -- not ours to touch
    helperPath = readStringField(doc, "apiKeyHelper");
  } catch {
    return; // no settings.json
  }
  if (helperPath === null) return;
  // Only OUR managed helper, and only one located in this Claude home (a foreign same-named
  // helper elsewhere is not ours).
  const mode = MANAGED_HELPERS[basename(helperPath)];
  if (mode === undefined || join(home, basename(helperPath)) !== helperPath) return;
  try {
    configureClaudeConfig(home, mode, true);
    consola.info(`Re-pointed the Claude ${mode} config to 127.0.0.1 in ${settingsPath}`);
  } catch (e) {
    consola.warn(`Could not re-point the Claude config (non-fatal): ${errMessage(e)}`);
  }
}

export const migration: Migration = {
  version: "3.3.6",
  description: "re-point existing Codex/Claude configs from localhost to 127.0.0.1",
  run: () => {
    repointCodexBaseUrl();
    repointClaudeConfig();
  },
};
