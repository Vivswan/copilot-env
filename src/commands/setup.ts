import { consola } from "consola";
import { type CliInstallDeps, type CliSetup, installAgentClis } from "../agents/cli_install.ts";
import { CopilotEnvConfig, configSetCommand } from "../copilot_api/env_config.ts";
import { runShellIntegration } from "../shell/integration.ts";
import { dryRunActive } from "../utils/fs_facade.ts";
import { assertNonNegativeDays } from "../utils/time.ts";
import { runDryRun } from "./dry_run.ts";

/** Distinct from the autoupdate release cooldown, which happens to share the number. */
export const DEFAULT_CLI_COOLDOWN_DAYS = 7;

/** The cl/co/cx launchers belong to the `shell.launchers` config key (`agent profile env` emits them); a wire
 *  only reports that state, and `--clis` turns it on. */
interface ShellArgs {
  remove?: boolean;
  clis?: boolean;
  /** Days of release aging for the CLI installs; null = each vendor's latest. */
  cooldown?: number | null;
  noSudo?: boolean;
  noPrereqs?: boolean;
  /** Windows only: the CurrentUserAllHosts profile. */
  allHosts?: boolean;
  /** Print each rc file the wiring would change with the block diff, and every install the
   *  --clis pass would run; write and install nothing. */
  dryRun?: boolean;
}

type ShellAction =
  | { kind: "remove"; allHosts: boolean }
  | { kind: "wire"; allHosts: boolean; clis: CliSetup | null };

function parseShellAction(args: ShellArgs): ShellAction {
  const remove = Boolean(args.remove);
  const clis = Boolean(args.clis);
  const cooldown = args.cooldown ?? null;
  const noSudo = Boolean(args.noSudo);
  const noPrereqs = Boolean(args.noPrereqs);
  const allHosts = Boolean(args.allHosts);

  if (!clis && (cooldown !== null || noSudo || noPrereqs)) {
    throw new Error("--cooldown, --no-sudo, and --no-prereqs require --clis");
  }
  if (remove) {
    if (clis) throw new Error("--clis installs CLIs and cannot be combined with --remove");
    return { kind: "remove", allHosts };
  }
  if (!clis) return { kind: "wire", allHosts, clis: null };
  if (noSudo && noPrereqs) {
    throw new Error("--no-sudo and --no-prereqs are mutually exclusive");
  }
  // --no-prereqs installs nothing, so a cooldown has nothing to steer.
  if (cooldown !== null && noPrereqs) {
    throw new Error("--cooldown and --no-prereqs are mutually exclusive");
  }
  assertNonNegativeDays(cooldown);
  return {
    kind: "wire",
    allHosts,
    clis: noPrereqs ? { mode: "verify-only" } : { mode: "install", cooldown, noSudo },
  };
}

/** The flag refusals throw before anything runs; `deps` is the install pass's test seam. */
export function runShell(args: ShellArgs, deps?: CliInstallDeps): Promise<void> {
  const action = parseShellAction(args);
  if (args.dryRun) return runDryRun(() => applyShell(action, deps));
  return applyShell(action, deps);
}

/** The write `agent config set shell.launchers true` makes, through the same store. */
function enableLaunchers(): void {
  const config = new CopilotEnvConfig();
  if (config.launchersEnabled()) return;
  config.set({ "shell.launchers": true });
  consola.info(
    `${dryRunActive() ? "Would set" : "Set"} shell.launchers to true (--clis turns the launchers on).`,
  );
}

async function applyShell(action: ShellAction, deps?: CliInstallDeps): Promise<void> {
  if (action.kind === "remove") {
    runShellIntegration({ kind: "remove", allHosts: action.allHosts });
    return;
  }
  if (action.clis !== null) await installAgentClis(action.clis, deps);
  // Before the wiring, so the same run defines cl / co / cx; --no-prereqs installs nothing and
  // turns nothing on.
  if (action.clis?.mode === "install") enableLaunchers();
  runShellIntegration({ kind: "wire", allHosts: action.allHosts });
  consola.info(
    new CopilotEnvConfig().launchersEnabled()
      ? "Launchers: enabled (the shell.launchers config key) - cl / co / cx (+ clx / cox / cxx) load via `agent profile env`."
      : `Launchers: disabled (the shell.launchers config key) - \`${configSetCommand(
          "shell.launchers",
          "true",
        )}\` defines cl / co / cx.`,
  );
}
