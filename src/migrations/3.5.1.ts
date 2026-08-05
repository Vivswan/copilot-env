// Migration from 3.5.1: re-bake the Copilot client identity into DIRECT agent configs.
//
// 3.5.2 probes which `Copilot-Integration-Id` a credential is accepted under and bakes the
// winner into the Direct configs (Claude `ANTHROPIC_CUSTOM_HEADERS`, Codex `http_headers`).
// A fine-grained PAT is REJECTED under the previously-hardcoded default identity and only
// works under `copilot-developer-cli`, so a PAT user's existing Direct wiring is broken
// ("Personal Access Tokens are not supported for this endpoint") until it is rewritten.
// The configs are only written by `agent init`/`agent claude`/`agent codex`, so an install
// that merely runs `agent update` would keep the stale headers -- re-derive them here.
//
// NAMED profiles need no fix-up: their store slot has no `integrationIdentity` yet, which
// already means "re-derive on next wiring", and every `cl`/`cx --profile` launch re-wires.
// Only the DEFAULT wiring is written once and then left alone, so only it is healed here.
//
// A non-PAT credential (gh-cli, device flow, OAuth) resolves to the default identity, so
// this rewrites the same bytes it read -- idempotent, and a no-op for most installs.
import { consola } from "consola";
import type { AgentProviderMode } from "../agents/provider_mode.ts";
import { configureClaudeConfig, effectiveClaudeProviderMode } from "../claude/config.ts";
import { resolveClaudeHome } from "../claude/paths.ts";
import {
  configureCodexConfig,
  effectiveCodexHome,
  effectiveCodexProviderMode,
  probeDirectIntegrationId,
} from "../codex/config.ts";
import { errMessage } from "../utils/error.ts";
import type { Migration } from "./index.ts";

/** The configured mode of an agent, treating any read error as "not ours to touch". */
function safeMode(read: () => AgentProviderMode): AgentProviderMode {
  try {
    return read();
  } catch {
    return "other";
  }
}

export const migration: Migration = {
  version: "3.5.1",
  description: "re-bake the Copilot client identity into direct Codex/Claude configs",
  run: async () => {
    const claudeDirect = safeMode(effectiveClaudeProviderMode) === "direct";
    const codexDirect = safeMode(effectiveCodexProviderMode) === "direct";
    if (!claudeDirect && !codexDirect) return; // proxy-only / unmanaged install -- nothing to do

    // ONE probe for the default credential, shared by both writers (it is memoized anyway).
    // A rejected credential throws -- surface it as a warning rather than failing the update,
    // since the user can still fix their auth and re-run `agent init`.
    let integrationId: string | null;
    try {
      integrationId = await probeDirectIntegrationId();
    } catch (e) {
      consola.warn(`Could not resolve the Copilot client identity (non-fatal): ${errMessage(e)}`);
      return;
    }
    if (integrationId === null) return; // the default identity works -- the configs are correct

    if (claudeDirect) {
      try {
        configureClaudeConfig(resolveClaudeHome(), "direct", {
          quiet: true,
          directIntegrationId: integrationId,
        });
        consola.info(
          `Re-baked the Claude direct headers with Copilot-Integration-Id: ${integrationId}`,
        );
      } catch (e) {
        consola.warn(`Could not re-bake the Claude direct config (non-fatal): ${errMessage(e)}`);
      }
    }
    if (codexDirect) {
      try {
        configureCodexConfig(effectiveCodexHome(), {
          mode: "direct",
          quiet: true,
          directIntegrationId: integrationId,
        });
        consola.info(
          `Re-baked the Codex direct headers with Copilot-Integration-Id: ${integrationId}`,
        );
      } catch (e) {
        consola.warn(`Could not re-bake the Codex direct config (non-fatal): ${errMessage(e)}`);
      }
    }
  },
};
