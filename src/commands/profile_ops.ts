// The runtime verbs of `agent profile [<name>] <verb>`: launch, env, proxy-token, mcp, start, stop,
// health, models, credits, settings, each routed onto the command function that owned the flat
// `--profile <name>` spelling. Registered from src/commands/profile_verbs.ts, which owns the tree
// and hands over the name. The top-level `start` and `stop` are the default profile's aliases;
// the top-level `health`, `credits`, and `settings` are the every-profile scope of the same words.
import type { Command } from "commander";
import { parseModeFlags } from "../agents/provider_mode.ts";
import type { ProfileVerb } from "../copilot_api/profile.ts";
import { runCredits, runCreditsEverywhere } from "./credits.ts";
import { runEnv } from "./env.ts";
import { runHealth, runHealthEverywhere } from "./health.ts";
import { parseLaunchAction, runLaunch } from "./launch.ts";
import { runMcp } from "./mcp.ts";
import { runModels } from "./models.ts";
import { runProxyToken } from "./proxy_token.ts";
import { DRY_RUN_HELP, type Opts, valueList } from "./registration.ts";
import { runProfileSettings, runSettings, type SettingsArgs } from "./settings.ts";
import { parseStartAction, runStart } from "./start.ts";
import { runStop } from "./stop.ts";

/** What the tree owner (registerProfileCommand) lends the verbs: the name from the word position,
 *  the verb factory, and the stray-word refusal. */
export interface ProfileOpsContext {
  rawProfile: string | null;
  /** `summary` is the verb's one-line row in the listings; `description` its own help. */
  verb(name: ProfileVerb, summary: string, description: string): Command;
  refuseStrayWords(cmd: Command, verb: ProfileVerb): void;
}

function parsePort(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const value = String(raw);
  if (!/^\d+$/.test(value)) {
    throw new Error(`--port expects a whole number (got '${value}')`);
  }
  const port = Number.parseInt(value, 10);
  if (port < 1 || port > 65535) {
    throw new Error(`--port must be between 1 and 65535 (got ${port})`);
  }
  return port;
}

// --- the flags each alias and its verb share, in one wording ------------------------------------

function addStartOptions(cmd: Command): Command {
  return cmd
    .option("--dry-run", DRY_RUN_HELP)
    .option("--port <port>", "Use this port; fail if it is busy.")
    .option("--record-event", "Record a heartbeat for the idle stop and exit.")
    .option("--check", "Exit 0 if the proxy is running, else 1.")
    .option("--force", "Start a fresh daemon even if one is healthy.");
}

function startAction(opts: Opts, profile: string | undefined): Promise<void> {
  return runStart(
    parseStartAction({
      dryRun: Boolean(opts.dryRun),
      port: parsePort(opts.port),
      recordEvent: Boolean(opts.recordEvent),
      check: Boolean(opts.check),
      force: Boolean(opts.force),
      profile,
    }),
  );
}

function addStopOptions(cmd: Command): Command {
  return cmd
    .option("--all", "Stop every profile's daemon (no name).")
    .option("--dry-run", DRY_RUN_HELP);
}

function stopAction(opts: Opts, profile: string | undefined): Promise<void> {
  return runStop({ profile, all: Boolean(opts.all), dryRun: Boolean(opts.dryRun) });
}

function addProxyTokenOptions(cmd: Command): Command {
  return cmd
    .option("--yes", "Never prompt: exit 1 rather than offer a start.")
    .option("--dry-run", DRY_RUN_HELP);
}

function proxyTokenAction(opts: Opts, profile: string | undefined): Promise<void> {
  return runProxyToken({ yes: Boolean(opts.yes), profile, dryRun: Boolean(opts.dryRun) });
}

function addMcpOptions(cmd: Command): Command {
  return cmd
    .option("--serve", "Run the MCP server on stdio.")
    .option("--remove", "Unregister the server (no profile name).")
    .option("--model <id>", "Web-search model for --serve.")
    .option("--dry-run", "Preview --remove.");
}

function mcpAction(opts: Opts, profile: string | undefined): Promise<void> {
  return runMcp({
    serve: Boolean(opts.serve),
    remove: Boolean(opts.remove),
    profile,
    model: opts.model === undefined ? undefined : String(opts.model),
    dryRun: Boolean(opts.dryRun),
  });
}

function addHealthOptions(cmd: Command): Command {
  return cmd
    .option(
      "--scope <scope>",
      valueList("Which checks to run (no flag: full):", [
        ["full", "everything"],
        ["runtime", "is the proxy ready"],
        ["proxy", "bootstrap, proxy, runtime"],
        ["setup", "shell, CLIs, Codex, Claude"],
        ["auth", "the GitHub credential"],
        ["codex", "Codex wiring"],
        ["claude", "Claude wiring"],
      ]),
    )
    .option("--json", "Print the report as JSON.")
    .option("--live", "Also run a live prompt (full, codex, claude scopes).");
}

function healthFlags(opts: Opts): { scope: string; json: boolean; live: boolean } {
  return {
    scope: String(opts.scope ?? "full"),
    json: Boolean(opts.json),
    live: Boolean(opts.live),
  };
}

function addCreditsOptions(cmd: Command): Command {
  return cmd
    .option("--json", "Print JSON instead of the block.")
    .option("--target <credits>", "Credits to stay under this month.");
}

function creditsFlags(opts: Opts): { json: boolean; creditsTarget: string | undefined } {
  return {
    json: Boolean(opts.json),
    creditsTarget: opts.target === undefined ? undefined : String(opts.target),
  };
}

function addSettingsOptions(cmd: Command): Command {
  return cmd
    .option("--export [file]", "Write the bundle to a file, or to stdout.")
    .option("--import <file>", "Restore a bundle; asks first, backs up first.")
    .option("--with-credentials", "Export the real tokens too.")
    .option("--force", "Import without asking.")
    .option("--no-backup", "Import without the backup.")
    .option("--dry-run", "Show what would change: --import, --export <file>.");
}

function settingsFlags(opts: Opts): SettingsArgs {
  return {
    exportTo: opts.export as string | boolean | undefined,
    importFrom: opts.import as string | undefined,
    withCredentials: Boolean(opts.withCredentials),
    force: Boolean(opts.force),
    noBackup: opts.backup === false,
    dryRun: Boolean(opts.dryRun),
  };
}

// --- the verbs -----------------------------------------------------------------------------------

/** The ten runtime verbs on the `profile` tree; `rawProfile` is the word-position name, passed on
 *  as the string each command function validates in its own order (null = the default). */
export function registerProfileOps(ctx: ProfileOpsContext): void {
  const { rawProfile, verb, refuseStrayWords } = ctx;
  const profile = rawProfile ?? undefined;

  verb(
    "launch",
    "Run an agent CLI (claude | codex | copilot)",
    "Run an agent CLI under this profile's wiring, as the cl / co / cx launchers do. " +
      "Put the CLI's own arguments after --.",
  )
    .argument("<cli>", "claude | codex | copilot (copilot: default profile only).")
    .argument("[args...]", "Arguments for the CLI, passed on as-is.")
    .option("--relaxed", "Add the CLI's most-relaxed flag (clx / cox / cxx).")
    .option("--dry-run", DRY_RUN_HELP)
    .action((cli: string, args: string[], opts: Opts) =>
      runLaunch(
        parseLaunchAction({ cli, args, profile, relaxed: Boolean(opts.relaxed) }),
        Boolean(opts.dryRun),
      )
    );

  verb(
    "env",
    "Print its shell exports, for eval",
    "Print this profile's shell exports for your shell to eval. " +
      "The shell wrapper evals the default profile's in every new shell.",
  )
    .option(
      "--format <format>",
      valueList("Output syntax (no flag: posix):", [
        ["posix", "export KEY=VALUE, for sh / bash / zsh"],
        ["powershell", "$env:KEY = '...', for PowerShell"],
      ]),
    )
    .action((opts: Opts, cmd: Command) => {
      refuseStrayWords(cmd, "env");
      runEnv({ format: opts.format === undefined ? undefined : String(opts.format), profile });
    });

  addProxyTokenOptions(
    verb(
      "proxy-token",
      "Print its proxy daemon's API key",
      "Print the API key of this profile's proxy daemon; only the key goes to stdout. " +
        "Codex, Claude, and the launchers call this in proxy mode.",
    ),
  ).action((opts: Opts, cmd: Command) => {
    refuseStrayWords(cmd, "proxy-token");
    return proxyTokenAction(opts, profile);
  });

  addMcpOptions(
    verb(
      "mcp",
      "Show or run the web-search MCP server",
      "Show how the copilot-env MCP server, Claude Code's web search through Copilot, is " +
        "wired; run it, or remove it. The registration is machine-wide.",
    ),
  ).action((opts: Opts, cmd: Command) => {
    refuseStrayWords(cmd, "mcp");
    return mcpAction(opts, profile);
  });

  addStartOptions(
    verb(
      "start",
      "Start its proxy daemon in the background",
      "Start this profile's proxy daemon in the background and return. " +
        "A named profile runs its own daemon on its own port and credential.",
    ),
  ).action((opts: Opts, cmd: Command) => {
    refuseStrayWords(cmd, "start");
    return startAction(opts, profile);
  });

  addStopOptions(
    verb(
      "stop",
      "Stop its proxy daemon; --all stops them all",
      "Stop this profile's proxy daemon on this host.",
    ),
  ).action((opts: Opts, cmd: Command) => {
    refuseStrayWords(cmd, "stop");
    return stopAction(opts, profile);
  });

  addHealthOptions(
    verb(
      "health",
      "Diagnose its daemon, credential, and wiring",
      "Check this profile's daemon, credential, and Codex and Claude wiring; exit 1 on any " +
        "failure. Every profile at once: `agent health`.",
    ),
  ).action((opts: Opts, cmd: Command) => {
    refuseStrayWords(cmd, "health");
    return runHealth({ ...healthFlags(opts), profile });
  });

  verb(
    "models",
    "List the models its credential can use",
    "List the models GitHub Copilot serves this profile's credential, from its running proxy " +
      "or from Direct.",
  )
    .option("--proxy", "Read the running proxy's catalog.")
    .option("--direct", "Fetch from GitHub Copilot Direct.")
    .option("--json", "Print JSON instead of the table.")
    .action((opts: Opts, cmd: Command) => {
      refuseStrayWords(cmd, "models");
      return runModels({ mode: parseModeFlags(opts), json: Boolean(opts.json), profile });
    });

  addCreditsOptions(
    verb(
      "credits",
      "Show its Copilot credits for this month",
      "Show this month's Copilot credits of this profile's account: spent, projected, and " +
        "paced against the plan. Every account at once: `agent credits`.",
    ),
  ).action((opts: Opts, cmd: Command) => {
    refuseStrayWords(cmd, "credits");
    return runCredits({ ...creditsFlags(opts), profile });
  });

  addSettingsOptions(
    verb(
      "settings",
      "Export or import its settings as JSON",
      "Export this profile's settings as one JSON bundle, or import one back. " +
        "The whole store: `agent settings`.",
    ),
  ).action((opts: Opts, cmd: Command) => {
    refuseStrayWords(cmd, "settings");
    return runProfileSettings(profile, settingsFlags(opts));
  });
}

// --- the top level -------------------------------------------------------------------------------

/** `agent start` and `agent stop`: the default profile's verbs, as their own commands. */
export function registerDaemonAliases(program: Command): void {
  addStartOptions(
    program
      .command("start")
      .helpGroup("Daemon:")
      .summary("Start the default profile's proxy daemon")
      .description(
        "Start the default profile's proxy daemon in the background and return. " +
          "Named profile: `agent profile <name> start`.",
      ),
  ).action((opts: Opts) => startAction(opts, undefined));

  addStopOptions(
    program
      .command("stop")
      .helpGroup("Daemon:")
      .summary("Stop the default profile's proxy daemon")
      .description(
        "Stop the default profile's proxy daemon on this host. " +
          "Named profile: `agent profile <name> stop`.",
      ),
  ).action((opts: Opts) => stopAction(opts, undefined));
}

/** `agent health`, `agent credits`, `agent settings`: every profile, every distinct account, the
 *  whole store. One profile's scope is the verb of the same name. */
export function registerEverywhereCommands(program: Command): void {
  addHealthOptions(
    program
      .command("health")
      .helpGroup("Daemon:")
      .summary("Diagnose the whole setup and every profile")
      .description(
        "Check the whole setup: shell, CLIs, and credential, then every profile's daemon and " +
          "wiring; exit 1 on any failure. One profile: `agent profile [<name>] health`.",
      ),
  ).action((opts: Opts) => runHealthEverywhere(healthFlags(opts)));

  addCreditsOptions(
    program
      .command("credits")
      .helpGroup("Daemon:")
      .summary("Show this month's Copilot credits per account")
      .description(
        "Show this month's Copilot credits for every account across your profiles: spent, " +
          "projected, and paced against the plan. One profile: `agent profile [<name>] credits`.",
      ),
  ).action((opts: Opts) => runCreditsEverywhere(creditsFlags(opts)));

  addSettingsOptions(
    program
      .command("settings")
      .helpGroup("Settings:")
      .summary("Export or import every setting as one JSON file")
      .description(
        "Export every copilot-env setting as one JSON bundle, or import one back. " +
          "One profile: `agent profile [<name>] settings`.",
      ),
  ).action((opts: Opts) => runSettings(settingsFlags(opts)));
}
