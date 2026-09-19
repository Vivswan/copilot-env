import { consola } from "consola";
import { type CliSetup, installAgentClis } from "../agents/cli_install.ts";
import { configSetCommand, CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { runShellIntegration } from "../shell/integration.ts";
import { assertNonNegativeDays } from "../utils/time.ts";
import { runDryRun } from "./dry_run.ts";

/** Distinct from the autoupdate release cooldown, which happens to share the number. */
export const DEFAULT_CLI_COOLDOWN_DAYS = 7;

/** The cl/co/cx launchers belong to the `shell.launchers` config key (`agent profile env` emits them); a wire
 *  only reports that state. */
interface ShellArgs {
  remove?: boolean;
  clis?: boolean;
  /** Days of npm release aging; null = latest. */
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

export function parseShellAction(args: ShellArgs): ShellAction {
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

export function runShell(args: ShellArgs): void | Promise<void> {
  const action = parseShellAction(args);
  if (args.dryRun) return runDryRun(() => Promise.resolve(applyShell(action)));
  applyShell(action);
}

function applyShell(action: ShellAction): void {
  if (action.kind === "remove") {
    runShellIntegration({ kind: "remove", allHosts: action.allHosts });
    return;
  }
  if (action.clis !== null) installAgentClis(action.clis);
  runShellIntegration({ kind: "wire", allHosts: action.allHosts });
  consola.info(
    new CopilotEnvConfig().launchersEnabled()
      ? "Launchers: enabled (the shell.launchers config key) - cl / co / cx (+ clx / cox / cxx) load via `agent profile env`."
      : `Launchers: disabled (the shell.launchers config key) - \`${
        configSetCommand("shell.launchers", "true")
      }\` defines cl / co / cx.`,
  );
}
