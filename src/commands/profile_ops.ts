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
import { DRY_RUN_HELP, helpNote, type Opts } from "./registration.ts";
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
    .option(
      "--dry-run",
      `${DRY_RUN_HELP} The resolved startup plan; proxy runtime state is untouched.`,
    )
    .option(
      "--port <port>",
      "Pin the proxy to this port instead of auto-resolving from the default (fails if it is busy).",
    )
    .option(
      "--record-event",
      "Record an activity heartbeat for the idle watchdog and exit, without launching (used by the proxy resolver).",
    )
    .option("--check", "Exit 0 if the proxy is running, 1 otherwise; do not launch.")
    .option(
      "--force",
      "Launch a fresh daemon (in the managed lifecycle, a plain start otherwise leaves a healthy proxy up).",
    );
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
    .option("--all", "Stop the default daemon and every named profile's daemon.")
    .option("--dry-run", `${DRY_RUN_HELP} The daemon is named, not signalled.`);
}

function stopAction(opts: Opts, profile: string | undefined): Promise<void> {
  return runStop({ profile, all: Boolean(opts.all), dryRun: Boolean(opts.dryRun) });
}

function addProxyTokenOptions(cmd: Command): Command {
  return cmd
    .option(
      "--yes",
      "Never prompt (headless): when the proxy is down and daemon.auto-start is off, exit 1 " +
        "instead of offering to start it.",
    )
    .option("--dry-run", `${DRY_RUN_HELP} No daemon starts and no key prints.`);
}

function proxyTokenAction(opts: Opts, profile: string | undefined): Promise<void> {
  return runProxyToken({ yes: Boolean(opts.yes), profile, dryRun: Boolean(opts.dryRun) });
}

function addMcpOptions(cmd: Command): Command {
  return cmd
    .option("--serve", "Run the MCP stdio server on stdio (the argv MCP clients register).")
    .option(
      "--remove",
      "Unregister from Claude Code, lift the managed WebSearch deny, and opt out (the default " +
        "profile alone: the registration is machine-global).",
    )
    .option(
      "--model <id>",
      "With --serve: web-search model for this process (overrides proxy.message-websearch-model).",
    )
    .option("--dry-run", `${DRY_RUN_HELP} With --remove.`);
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
      "Checks to run: full (default; whole environment) | runtime (fast proxy " +
        "readiness probe) | proxy (bootstrap + proxy + runtime) | setup (shell, " +
        "CLIs, Codex, Claude) | auth (the GitHub credential) | codex (Codex wiring " +
        "only) | claude (Claude wiring only).",
      "full",
    )
    .option("--json", "Emit a JSON report instead of the formatted text report.")
    .option(
      "--live",
      "Also run a live read-only prompt through Codex/Claude to verify the configured backend end-to-end (codex/claude/full scopes).",
    );
}

function healthFlags(opts: Opts): { scope: string; json: boolean; live: boolean } {
  return { scope: String(opts.scope), json: Boolean(opts.json), live: Boolean(opts.live) };
}

function addCreditsOptions(cmd: Command): Command {
  return cmd
    .option("--json", "Emit a JSON object instead of the block.")
    .option(
      "--target <credits>",
      "Credits to stay under this month, overriding COPILOT_CREDITS_TARGET and the cost.credits-target " +
        "config key for this run.",
    );
}

function creditsFlags(opts: Opts): { json: boolean; creditsTarget: string | undefined } {
  return {
    json: Boolean(opts.json),
    creditsTarget: opts.target === undefined ? undefined : String(opts.target),
  };
}

const IMPORT_SEMANTICS_HELP =
  "Import semantics: preferences are FULL-REPLACE (a key absent from the bundle resets to its " +
  "built-in default), while credentials are PRESERVE-IF-ABSENT (a slot whose token is redacted " +
  "or missing never overwrites a working local credential).";

function addSettingsOptions(cmd: Command): Command {
  return cmd
    .option(
      "--export [file]",
      "Write the bundle to <file>, or stdout when no file is given. Tokens are " +
        "redacted unless --with-credentials.",
    )
    .option(
      "--import <file>",
      "Restore a bundle: back up + overwrite the stores, then re-derive the agent wiring from " +
        "them. Non-destructive: profiles that exist only on this machine are kept. The default is " +
        "one mode for both agents: a bundle wiring one agent re-renders the recorded mode (a " +
        "different mode is refused), or lands both on a default with none.",
    )
    .option(
      "--with-credentials",
      "With --export: include the real tokens (treat the output like a password).",
    )
    .option("--force", "With --import: skip the confirmation prompt (headless use).")
    .option("--no-backup", "With --import: skip the automatic pre-import settings backup.")
    .option("--dry-run", `${DRY_RUN_HELP} With --import (no confirmation) or --export <file>.`)
    .addHelpText("after", () => helpNote(IMPORT_SEMANTICS_HELP));
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
  const forWhom = "the named profile, or the default profile when no name is given";

  verb(
    "launch",
    "Run an agent CLI (claude | codex | copilot)",
    `Launch an agent CLI (claude | codex | copilot) under the wiring of ${forWhom}: its ` +
      "provider, managed flags, and environment. This is what the cl / co / cx shell launchers " +
      "run. Put the CLI's own arguments after --. copilot takes no profile.",
  )
    .argument("<cli>", "Which agent CLI to launch: claude | codex | copilot.")
    .argument(
      "[args...]",
      "Arguments for the agent CLI, passed through verbatim (put them after --).",
    )
    .option(
      "--relaxed",
      "Add the agent's most-relaxed flag: Claude --dangerously-skip-permissions " +
        "(with IS_SANDBOX=1), Codex --sandbox danger-full-access, Copilot --allow-all.",
    )
    .option("--dry-run", `${DRY_RUN_HELP} The wiring the launch lands; the agent is not spawned.`)
    .action((cli: string, args: string[], opts: Opts) =>
      runLaunch(
        parseLaunchAction({ cli, args, profile, relaxed: Boolean(opts.relaxed) }),
        Boolean(opts.dryRun),
      )
    );

  verb(
    "env",
    "Print its shell exports, for eval",
    `Print the shell directives of ${forWhom} for your shell to eval: the proxy base URL, the ` +
      "Codex home, and the opt-in launchers. Each new shell evals the default profile's through " +
      "the shell wrapper. --format powershell for PowerShell.",
  )
    .option(
      "--format <format>",
      "Output syntax: 'posix' (default; `export KEY=VALUE`, eval-able by sh/bash/zsh) " +
        "or 'powershell' (`$env:KEY = '...'`, Invoke-Expression-able by PowerShell).",
      "posix",
    )
    .action((opts: Opts, cmd: Command) => {
      refuseStrayWords(cmd, "env");
      runEnv({ format: String(opts.format), profile });
    });

  addProxyTokenOptions(
    verb(
      "proxy-token",
      "Print its proxy daemon's API key",
      `Print the API key of the proxy daemon of ${forWhom}; only the key goes to stdout. When ` +
        "the managed lifecycle (`daemon.auto-start`) is on, a downed daemon is started first. " +
        "Codex and Claude call this in proxy mode, as do the cl / cx launchers.",
    ),
  ).action((opts: Opts, cmd: Command) => {
    refuseStrayWords(cmd, "proxy-token");
    return proxyTokenAction(opts, profile);
  });

  addMcpOptions(
    verb(
      "mcp",
      "Show or run the web-search MCP server",
      "Show the wiring status of the copilot-env MCP server, which gives Claude Code web search " +
        "through GitHub Copilot (the registration is machine-global). --serve runs the stdio " +
        `server with the credential of ${forWhom}, for Claude, Codex, or any MCP client; ` +
        "--remove unregisters it.",
    ),
  ).action((opts: Opts, cmd: Command) => {
    refuseStrayWords(cmd, "mcp");
    return mcpAction(opts, profile);
  });

  addStartOptions(
    verb(
      "start",
      "Start its proxy daemon in the background",
      `Start the proxy daemon of ${forWhom} in the background, detached. A named profile runs ` +
        "its own daemon: its own home, port, and credential. " +
        "See also: `agent start`, the same command for the default profile.",
    ),
  ).action((opts: Opts, cmd: Command) => {
    refuseStrayWords(cmd, "start");
    return startAction(opts, profile);
  });

  addStopOptions(
    verb(
      "stop",
      "Stop its proxy daemon; --all stops them all",
      `Stop the proxy daemon of ${forWhom} on this host; --all stops every profile's. ` +
        "See also: `agent stop`, the same command for the default profile.",
    ),
  ).action((opts: Opts, cmd: Command) => {
    refuseStrayWords(cmd, "stop");
    return stopAction(opts, profile);
  });

  addHealthOptions(
    verb(
      "health",
      "Diagnose its daemon, credential, and wiring",
      `Diagnose ${forWhom}: its daemon, consistency, credential slot, and Codex and Claude ` +
        "wiring (the default profile adds the account-wide checks). Exit 1 on any failure; " +
        "--scope narrows the checks, --json emits the report as data. " +
        "See also: `agent health` for every profile at once.",
    ),
  ).action((opts: Opts, cmd: Command) => {
    refuseStrayWords(cmd, "health");
    return runHealth({ ...healthFlags(opts), profile });
  });

  verb(
    "models",
    "List the models its credential can use",
    `List the model ids and names GitHub Copilot serves ${forWhom}: from its running proxy ` +
      "daemon, else from Direct with its own credential (never the default's). --json emits " +
      "the list as data.",
  )
    .option("--proxy", "Read the running local proxy's catalog (fails if the proxy is down).")
    .option("--direct", "Fetch upstream from GitHub Copilot Direct with the resolved credential.")
    .option("--json", "Emit a JSON object ({source, models}) instead of the table.")
    .action((opts: Opts, cmd: Command) => {
      refuseStrayWords(cmd, "models");
      return runModels({ mode: parseModeFlags(opts), json: Boolean(opts.json), profile });
    });

  addCreditsOptions(
    verb(
      "credits",
      "Show its Copilot credits for this month",
      `Show this month's Copilot AI credits (100 to the dollar) of the account of ${forWhom}: ` +
        "spent, projected for the month, and paced against the plan's entitlement and an " +
        "optional target. One live read of GitHub's meter; nothing is stored locally. " +
        "See also: `agent credits` for every account at once.",
    ),
  ).action((opts: Opts, cmd: Command) => {
    refuseStrayWords(cmd, "credits");
    return runCredits({ ...creditsFlags(opts), profile });
  });

  addSettingsOptions(
    verb(
      "settings",
      "Export or import its settings as JSON",
      `Export the portable settings of ${forWhom} alone as one JSON bundle, or import one ` +
        "back: its credential, mode, and preferences (the default profile's bundle also carries " +
        "both agents' mode and the shared proxy.* / probe.* defaults). " +
        "See also: `agent settings` for the whole store.",
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
        "Start the default profile's proxy daemon in the background, detached, and return. " +
          "See also: `agent profile <name> start` for a named profile's daemon.",
      ),
  ).action((opts: Opts) => startAction(opts, undefined));

  addStopOptions(
    program
      .command("stop")
      .helpGroup("Daemon:")
      .summary("Stop the default profile's proxy daemon")
      .description(
        "Stop the default profile's proxy daemon on this host; --all stops the default and every " +
          "named profile's daemon. See also: `agent profile <name> stop`.",
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
        "Diagnose the whole setup: the account-wide checks (shell, CLIs, credential) first, then " +
          "each profile's daemon, credential slot, and Codex and Claude wiring. Exit 1 on any " +
          "failure; --scope narrows the checks, --json emits the report as data. " +
          "See also: `agent profile [<name>] health` for one profile.",
      ),
  ).action((opts: Opts) => runHealthEverywhere(healthFlags(opts)));

  addCreditsOptions(
    program
      .command("credits")
      .helpGroup("Daemon:")
      .summary("Show this month's Copilot credits per account")
      .description(
        "Show this month's Copilot AI credits (100 to the dollar) for every GitHub account " +
          "across your profiles: spent, projected for the month, and paced against the plan's " +
          "entitlement and an optional target. Profiles on one account share one meter. One " +
          "live read of GitHub's meter per account; nothing is stored locally. " +
          "See also: `agent profile [<name>] credits` for one profile.",
      ),
  ).action((opts: Opts) => runCreditsEverywhere(creditsFlags(opts)));

  addSettingsOptions(
    program
      .command("settings")
      .helpGroup("Settings:")
      .summary("Export or import every setting as one JSON file")
      .description(
        "Export every portable copilot-env setting (preferences, credentials, profiles, wiring " +
          "modes) as one JSON bundle, or import a bundle back. Tokens are redacted on export " +
          "unless --with-credentials. " +
          "See also: `agent profile [<name>] settings` for one profile's bundle.",
      ),
  ).action((opts: Opts) => runSettings(settingsFlags(opts)));
}
