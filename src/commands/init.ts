// `agent init`: the headline one-shot -- ensure a GitHub credential exists (running
// the auth flow first if not), then configure BOTH Codex and Claude (each auto-
// detects GitHub Copilot Direct vs the local proxy, or --direct / --proxy forces
// both), and print next-step guidance. The credential itself is managed by
// `agent auth` (--provider / --get / --del / --check); shell wiring + CLI install
// live in `agent shell`.

import { consola } from "consola";
import { CopilotEnvState } from "../copilot_api/env_state.ts";
import { assertSingleMode } from "../utils/direct_probe.ts";
import { ensureAuthenticated } from "./auth.ts";
import { configureBothAgents, printGuidance } from "./configure_agents.ts";

export interface InitArgs {
  direct?: boolean;
  proxy?: boolean;
  /**
   * `--auto-start` => enable the managed proxy lifecycle (agents auto-start the proxy on
   * open; it auto-stops when idle); `--no-auto-start` => disable it. Undefined leaves the
   * stored setting unchanged.
   */
  autoStart?: boolean;
  /**
   * `--get-auto-start`: report the managed-lifecycle flag and exit (0 enabled, 1 not),
   * WITHOUT configuring agents. The proxy-token resolver uses this as its auto-start gate.
   */
  getAutoStart?: boolean;
}

/**
 * `init`: ensure authentication, then configure both agents and explain the
 * result. `--direct`/`--proxy` force both; with no flag each auto-detects (live
 * Copilot Direct probe, else the proxy). If no credential exists, the GitHub login
 * flow runs first (`agent auth`) and ERRORS OUT if it fails -- init never proceeds
 * to configure agents without a credential.
 */
export async function runInit(args: InitArgs): Promise<void> {
  // `--get-auto-start` is a pure query the resolver gate uses -- report the flag and exit
  // before any setup work.
  if (args.getAutoStart) {
    process.exitCode = new CopilotEnvState().autoStartEnabled() ? 0 : 1;
    return;
  }

  assertSingleMode(args); // --direct/--proxy mutually exclusive (fail fast, before auth)

  // Managed proxy lifecycle toggle (account-wide, only meaningful for proxy mode). Apply
  // before configuring so the chosen state is in effect when the proxy first comes up.
  if (args.autoStart !== undefined) {
    new CopilotEnvState().set({ autoStart: args.autoStart });
    consola.info(
      args.autoStart
        ? "Managed proxy lifecycle ON: agents auto-start the proxy; it auto-stops when idle."
        : "Managed proxy lifecycle OFF: manage the proxy with `agent start` / `agent stop`.",
    );
  }

  // A credential is only needed for a Direct-capable setup. `--proxy` opts out of
  // Direct entirely (the daemon handles its own auth on `agent start`), so don't
  // prompt there. Otherwise ensure auth first -- when none, ask; never silently fall
  // back. Throws (propagated) if login fails, so we never configure half-broken.
  if (!args.proxy) {
    await ensureAuthenticated();
  }

  const { codex, claude } = configureBothAgents({ direct: args.direct, proxy: args.proxy });

  // A token is "in use" for guidance if one is now stored.
  printGuidance(codex, claude, new CopilotEnvState().read().githubToken !== null);
}
