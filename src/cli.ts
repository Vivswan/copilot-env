// The entry behind bin/agent, bin/agent.ps1, and the `deno compile` binary. Commander rather than
// citty so unknown flags are rejected (`error: unknown option '--x'`, exit 1) instead of silently
// accepted, and so help wraps to the terminal width natively.
import "./utils/dotenv.ts";
import { Command } from "commander";
import { consola } from "consola";
import { parseModeFlags } from "./agents/provider_mode.ts";
import { runCodexMobile } from "./codex/mobile.ts";
import { configTableOutput, refuseProfileKey, runConfig } from "./commands/config.ts";
import { runCredits } from "./commands/credits.ts";
import { runDryRun } from "./commands/dry_run.ts";
import { runEnv } from "./commands/env.ts";
import { spawnedByDryRun } from "./utils/dry_run.ts";
import { collectDryRun } from "./utils/write_session.ts";
import { runHealth } from "./commands/health.ts";
import { parseLaunchAction, runLaunch } from "./commands/launch.ts";
import { runMcp } from "./commands/mcp.ts";
import { runModels } from "./commands/models.ts";
import {
  DRY_RUN_HELP,
  type Opts,
  registerAuthCommand,
  registerInitCommand,
  registerListCommand,
  registerProfileCommand,
  registerSyncCommand,
  splitProfileInvocation,
} from "./commands/profile_verbs.ts";
import { runProxyToken } from "./commands/proxy_token.ts";
import { runSettings } from "./commands/settings.ts";
import { DEFAULT_CLI_COOLDOWN_DAYS, runShell } from "./commands/setup.ts";
import { parseStartAction, runStart } from "./commands/start.ts";
import { runStop } from "./commands/stop.ts";
import { runUninstall } from "./commands/uninstall.ts";
import { runUpdate } from "./commands/update.ts";
import { OPENROUTER_MODELS_URL } from "./copilot_api/env_config.ts";
import { runInstall } from "./install/installer.ts";
import { runMigrations } from "./migrations/index.ts";
import { runCost } from "./usage/cost.ts";
import { bold, cyan, gray } from "./utils/ansi.ts";
import { errMessage } from "./utils/error.ts";
import { configureConsolaOutput, redirectConsolaToStderr } from "./utils/logger.ts";
import { terminalWidth, wrapMessage } from "./utils/table.ts";
import { packageVersion } from "./utils/version.ts";

configureConsolaOutput();

// `agent profile <name> <verb>` carries the name in the word position, which Commander has no
// slot for: it is split off here, before the tree is built, and the profile verbs close over it.
const invocation = splitProfileInvocation(process.argv.slice(2));

function parseNonNegativeDays(raw: string, flag: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${flag} expects a non-negative whole number of days (got '${raw}')`);
  }
  return Number.parseInt(raw, 10);
}

function coerceDays(raw: string): number {
  return parseNonNegativeDays(raw, "--cooldown");
}

/** A bare `--cooldown` reaches here as `true`: Commander skips the coercion when the optional value
 *  is absent. */
function resolveCooldown(value: unknown, defaultDays: number): number | null {
  if (value === undefined) return null;
  if (value === true) return defaultDays;
  return value as number;
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

const program = new Command();

program
  .name("agent")
  .description("Manage the local proxy and wire Codex + Claude.")
  .version(packageVersion(), "--version", "Print the version and exit.")
  .helpOption("--help", "Show this help.")
  // Options are read up to the command word and the rest handed on, so a flag `agent profile` and
  // one of its verbs both spell (`--set`, `--dry-run`) reaches the verb. The root's own flags
  // (`--version`, `--full-help`) then come before the command, as they always have.
  .enablePositionalOptions()
  .option("--full-help", "Print help for `agent` and every subcommand, then exit.");

// The option:full-help listener fires during parse, before any "missing command" handling, so it
// works with no subcommand.
/** Commander's own help wraps at this width, so the divider never runs past it. */
const HELP_DIVIDER_COLUMNS = 72;

/** Help paragraphs Commander prints verbatim: dim, one blank line before each, wrapped at help
 *  time to the terminal the way the option descriptions above them are. */
function helpNote(...paragraphs: string[]): string {
  return wrapMessage(paragraphs.map((p) => `\n${gray(p)}`).join("\n"), terminalWidth());
}

program.on("option:full-help", () => {
  const sep = "─".repeat(Math.min(terminalWidth() ?? HELP_DIVIDER_COLUMNS, HELP_DIVIDER_COLUMNS));
  // `helpInformation()` omits `addHelpText('after', ...)` (the `config` key list), which is emitted
  // via help events during outputHelp(); those events are captured into a string instead.
  const renderHelp = (cmd: Command): string => {
    let out = "";
    const saved = cmd.configureOutput();
    cmd.configureOutput({
      writeOut: (s) => {
        out += s;
      },
    });
    cmd.outputHelp();
    cmd.configureOutput(saved);
    return out;
  };
  const parts = [renderHelp(program)];
  for (const cmd of program.commands) {
    if (cmd.name() === "help") continue;
    parts.push(`${sep}\nagent ${cmd.name()}\n${sep}\n${renderHelp(cmd)}`);
    for (const sub of cmd.commands) {
      if (sub.name() === "help") continue;
      parts.push(`${sep}\nagent ${cmd.name()} ${sub.name()}\n${sep}\n${renderHelp(sub)}`);
    }
  }
  process.stdout.write(parts.join("\n"));
  process.exit(0);
});

// The ansi.ts helpers no-op under NO_COLOR / TERM=dumb / CI / test runs, so these hooks degrade to
// plain text on their own; Commander still owns all layout and width-wrapping.
program.configureHelp({
  styleTitle: bold,
  styleCommandText: cyan,
  styleOptionTerm: cyan,
  styleSubcommandTerm: cyan,
  styleDescriptionText: gray,
});

// Commander renders help groups in first-appearance order, so `init` and `profile` come first.
registerInitCommand(program);
registerProfileCommand(program, invocation.profile);
registerAuthCommand(program);
registerListCommand(program);
registerSyncCommand(program);

program
  .command("launch")
  .helpGroup("Setup:")
  .description(
    "Launch an agent CLI (claude | codex | copilot) with the managed flags, provider " +
      "wiring, and environment - what the opt-in cl / co / cx shell launchers run.",
  )
  .argument("<cli>", "Which agent CLI to launch: claude | codex | copilot.")
  .argument(
    "[args...]",
    "Arguments for the agent CLI, passed through verbatim (put them after --).",
  )
  .option(
    "--profile <name>",
    "Launch under the named profile (its own credential, wiring, and daemon; " +
      "never falls back to the default). Not for copilot.",
  )
  .option(
    "--relaxed",
    "Add the agent's most-relaxed flag: Claude --dangerously-skip-permissions " +
      "(with IS_SANDBOX=1), Codex --sandbox danger-full-access, Copilot --allow-all.",
  )
  .option("--dry-run", `${DRY_RUN_HELP} The wiring the launch lands; the agent is not spawned.`)
  .action((cli: string, args: string[], opts: Opts) =>
    runLaunch(
      parseLaunchAction({
        cli,
        args,
        profile: opts.profile as string | undefined,
        relaxed: Boolean(opts.relaxed),
      }),
      undefined,
      Boolean(opts.dryRun),
    )
  );

program
  .command("start")
  .helpGroup("Daemon:")
  .description("Start the proxy in the background, detached.")
  .option("--dry-run", "Print the resolved startup plan without changing proxy runtime state.")
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
  )
  .option(
    "--profile <name>",
    "Operate on the named profile's isolated daemon (own home/port, the profile's own credential).",
  )
  .action((opts: Opts) =>
    runStart(
      parseStartAction({
        dryRun: Boolean(opts.dryRun),
        port: parsePort(opts.port),
        recordEvent: Boolean(opts.recordEvent),
        check: Boolean(opts.check),
        force: Boolean(opts.force),
        profile: opts.profile as string | undefined,
      }),
    )
  );

program
  .command("stop")
  .helpGroup("Daemon:")
  .description("Stop the proxy on this host.")
  .option("--profile <name>", "Stop the named profile's daemon instead of the default.")
  .option("--all", "Stop the default daemon and every named profile's daemon.")
  .option("--dry-run", `${DRY_RUN_HELP} The daemon is named, not signalled.`)
  .action((opts: Opts) =>
    runStop({
      profile: opts.profile as string | undefined,
      all: Boolean(opts.all),
      dryRun: Boolean(opts.dryRun),
    })
  );

program
  .command("proxy-token")
  .helpGroup("Daemon:")
  .description(
    "Print the local proxy's API key, auto-starting the proxy when the managed " +
      "lifecycle (`daemon.auto-start`) is on - the resolver behind the proxy-mode " +
      "Codex/Claude wiring and the cl/cx launchers. Only the key touches stdout.",
  )
  .option(
    "--yes",
    "Never prompt (headless): when the proxy is down and daemon.auto-start is off, exit 1 " +
      "instead of offering to start it.",
  )
  .option(
    "--profile <name>",
    "Resolve against the named profile's isolated daemon instead of the default.",
  )
  .option("--dry-run", `${DRY_RUN_HELP} No daemon starts and no key prints.`)
  .action((opts: Opts) =>
    runProxyToken({
      yes: Boolean(opts.yes),
      profile: opts.profile as string | undefined,
      dryRun: Boolean(opts.dryRun),
    })
  );

// `agent config <verb>`: the machine's preferences (daemon.*, codex.*, claude.*, shell.*, update.*,
// cost.*) and the shared default every profile follows for proxy.* / probe.*. A key that follows the
// credential (identity, host, passthrough, static-key) is a profile's own: `agent profile [<name>]
// set|get|unset`, which for a proxy.* / probe.* key with no name writes the same store bytes as
// this command (the default profile never carries its own override).
const CONFIG_VIEW = { kind: "config" } as const;
const config = program
  .command("config")
  .helpGroup("Settings:")
  .usage("<verb> [options]")
  .description(
    "This machine's preferences (daemon.auto-start, daemon.idle-timeout, shell.launchers, ...) " +
      "and the shared default of every proxy.* / probe.* key: agent config set|get|unset. A " +
      "profile's own keys (identity, host, passthrough, static-key) and a named profile's " +
      "overrides are `agent profile [<name>] set|get|unset`. Bare `agent config` lists every key.",
  )
  // A function, not a string baked at startup, so the values are the store's at help-render time.
  .addHelpText("after", () => `\n${configTableOutput(process.platform, CONFIG_VIEW)}`)
  .action(() => runConfig({ kind: "get", view: CONFIG_VIEW }));
config
  .command("set")
  .description("Set a machine key, or the shared default of a proxy.* / probe.* key.")
  .argument("<key>", "A key of the table `agent config --help` prints.")
  .argument("<value>", "The value, parsed by the key's type.")
  .option("--dry-run", DRY_RUN_HELP)
  .action((key: string, value: string, opts: Opts) => {
    refuseProfileKey(key);
    return runConfig({ kind: "set", key, value, view: CONFIG_VIEW, dryRun: Boolean(opts.dryRun) });
  });
config
  .command("get")
  .description(
    "Print one key's value in effect (stdout) and its origin (stderr), or every key with no key.",
  )
  .argument("[key]", "A key of the table `agent config --help` prints.")
  .action((key: string | undefined) => {
    if (key !== undefined) refuseProfileKey(key);
    return runConfig({ kind: "get", key, view: CONFIG_VIEW });
  });
config
  .command("unset")
  .description("Drop a key: back to its built-in default.")
  .argument("<key>", "A key of the table `agent config --help` prints.")
  .option("--dry-run", DRY_RUN_HELP)
  .action((key: string, opts: Opts) => {
    refuseProfileKey(key);
    return runConfig({ kind: "unset", key, view: CONFIG_VIEW, dryRun: Boolean(opts.dryRun) });
  });

program
  .command("settings")
  .helpGroup("Settings:")
  .description(
    "Export/import every portable copilot-env setting (preferences, credential, " +
      "profiles, wiring modes) as one JSON bundle.",
  )
  .option(
    "--export [file]",
    "Write the bundle to <file>, or stdout when no file is given. Tokens are " +
      "redacted unless --with-credentials.",
  )
  .option(
    "--import <file>",
    "Restore a bundle: back up + overwrite the stores, then re-derive both agents' " +
      "wiring and every profile from them. Non-destructive: profiles that exist only " +
      "on this machine are kept. The default is one mode for both agents: a bundle wiring one " +
      "agent re-renders the recorded mode (a different mode is refused), or lands both on a " +
      "default with none.",
  )
  .option(
    "--with-credentials",
    "With --export: include the real tokens (treat the output like a password).",
  )
  .option("--force", "With --import: skip the confirmation prompt (headless use).")
  .option("--no-backup", "With --import: skip the automatic pre-import settings backup.")
  .option("--dry-run", `${DRY_RUN_HELP} With --import (no confirmation) or --export <file>.`)
  .addHelpText(
    "after",
    () =>
      helpNote(
        "Import semantics: preferences are FULL-REPLACE (a key absent from the bundle resets " +
          "to its built-in default), while credentials are PRESERVE-IF-ABSENT (a slot whose " +
          "token is redacted or missing never overwrites a working local credential).",
      ),
  )
  .action((opts: Opts) =>
    runSettings({
      exportTo: opts.export as string | boolean | undefined,
      importFrom: opts.import as string | undefined,
      withCredentials: Boolean(opts.withCredentials),
      force: Boolean(opts.force),
      noBackup: opts.backup === false,
      dryRun: Boolean(opts.dryRun),
    })
  );

program
  .command("health")
  .helpGroup("Daemon:")
  .description("Diagnose the local proxy and setup (exit 1 on any failure).")
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
  )
  .option(
    "--profile <name>",
    "Narrow the diagnosis to the named profile: its daemon, consistency, credential " +
      "slot, and per-agent wiring (account-wide checks are excluded); unknown names " +
      "are a hard error.",
  )
  .action((opts: Opts) =>
    runHealth({
      scope: String(opts.scope),
      json: Boolean(opts.json),
      live: Boolean(opts.live),
      profile: opts.profile as string | undefined,
    })
  );

program
  .command("models")
  .helpGroup("Daemon:")
  .description(
    "List the model ids + names GitHub Copilot serves (auto-picks: the running proxy, else Direct).",
  )
  .option("--proxy", "Read the running local proxy's catalog (fails if the proxy is down).")
  .option("--direct", "Fetch upstream from GitHub Copilot Direct with the resolved credential.")
  .option("--json", "Emit a JSON object ({source, models}) instead of the table.")
  .option(
    "--profile <name>",
    "List via the named profile's wiring: its own daemon (proxy) or its own " +
      "credential (direct); never falls back to the default.",
  )
  .action((opts: Opts) =>
    runModels({
      mode: parseModeFlags(opts),
      json: Boolean(opts.json),
      profile: opts.profile as string | undefined,
    })
  );

program
  .command("env")
  .helpGroup("Daemon:")
  .description("Print env assignments for the proxy, evaluated by the calling shell.")
  .option(
    "--format <format>",
    "Output syntax: 'posix' (default; `export KEY=VALUE`, eval-able by sh/bash/zsh) " +
      "or 'powershell' (`$env:KEY = '...'`, Invoke-Expression-able by PowerShell).",
    "posix",
  )
  .option(
    "--profile <name>",
    "Resolve the exports for the named profile's wiring (its settings file and " +
      "reserved port) instead of the default; unknown names are a hard error.",
  )
  .action((opts: Opts) =>
    runEnv({ format: String(opts.format), profile: opts.profile as string | undefined })
  );

program
  .command("cost")
  .helpGroup("Daemon:")
  .description(
    "Aggregate token usage (proxy SQLite DBs + Codex session logs + Claude transcripts) and estimate cost.",
  )
  .option(
    "--days <days>",
    "Only include usage from the last N days (default: all). A whole number counts local " +
      "calendar days (1 = today, 7 = today plus the six days before); a decimal is an exact " +
      "span of 24-hour days (1.0 = the last 24 hours, 0.5 = the last 12).",
  )
  .option("--json", "Emit a JSON object instead of a formatted report.")
  .option("--per-day", "Also print a day-by-day cost/token breakdown.")
  .option(
    "--sources",
    "Print full per-source tables (proxy + each Codex provider + Claude) with day stats instead of the combined table.",
  )
  .option(
    "--pricing-url <url>",
    "OpenRouter models API URL for the public price list (cached for a day), overriding the " +
      `cost.pricing-url config key for this run (built-in: ${OPENROUTER_MODELS_URL}).`,
  )
  .option(
    "--no-index",
    "Parse every session log instead of reading through the usage index (never opens or writes it).",
  )
  .addHelpText(
    "after",
    () =>
      helpNote(
        "Sources: the proxy's per-host SQLite DBs (default + every profile daemon home; " +
          "proxied traffic only), the Codex CLI's local session logs, and Claude Code's local " +
          "transcripts (each agent's FULL traffic, Direct included). The default table merges " +
          "all three, so traffic through the proxy can be double counted; use --sources for " +
          "per-source tables.",
        "Active days: distinct local calendar days (your timezone) that recorded at " +
          "least one request, unioned across the displayed sources. The header also shows " +
          "the inclusive min..max calendar span and what percent of it was active. Avg/day " +
          "divides each total by the active-day count; Median/day takes the median of each " +
          "column independently across the active days (so columns need not sum, but " +
          "each is robust to a few outlier days). Idle days are never counted in either.",
      ),
  )
  .action((opts: Opts) => {
    // The report (and the --json payload) owns stdout; every consola line from any module the
    // readers reach is narration.
    redirectConsolaToStderr();
    return runCost({
      days: opts.days as string | undefined,
      json: Boolean(opts.json),
      perDay: Boolean(opts.perDay),
      pricingUrl: opts.pricingUrl === undefined ? undefined : String(opts.pricingUrl),
      sources: Boolean(opts.sources),
      // Commander stores a `--no-<name>` flag as `<name>: false`.
      noIndex: opts.index === false,
    });
  });

program
  .command("credits")
  .helpGroup("Daemon:")
  .description(
    "This month's Copilot AI credits (100 to the dollar): spent, projected, and paced against the " +
      "plan's entitlement and an optional target. One live read of GitHub's meter; nothing local.",
  )
  .option("--json", "Emit a JSON object instead of the block.")
  .option(
    "--target <credits>",
    "Credits to stay under this month, overriding COPILOT_CREDITS_TARGET and the cost.credits-target " +
      "config key for this run.",
  )
  .action((opts: Opts) =>
    runCredits({
      json: Boolean(opts.json),
      creditsTarget: opts.target === undefined ? undefined : String(opts.target),
    })
  );

program
  .command("codex-mobile")
  .helpGroup("Setup:")
  .description(
    "Interactive: pair the Codex desktop app with its phone remote-control flow (macOS/Windows).",
  )
  .action(() => runCodexMobile());

program
  .command("mcp")
  .helpGroup("Setup:")
  .description(
    "Status of the copilot-env MCP server wiring; --serve runs the stdio server " +
      "(web_search via GitHub Copilot /responses) for Claude, Codex, or any MCP client.",
  )
  .option("--serve", "Run the MCP stdio server on stdio (the argv MCP clients register).")
  .option("--remove", "Unregister from Claude Code, lift the managed WebSearch deny, and opt out.")
  .option(
    "--profile <name>",
    "With --serve: resolve the credential from this named profile (never falls back).",
  )
  .option(
    "--model <id>",
    "With --serve: web-search model for this process (overrides proxy.message-websearch-model).",
  )
  .option("--dry-run", `${DRY_RUN_HELP} With --remove.`)
  .action((opts: Opts) =>
    runMcp({
      serve: Boolean(opts.serve),
      remove: Boolean(opts.remove),
      profile: opts.profile === undefined ? undefined : String(opts.profile),
      model: opts.model === undefined ? undefined : String(opts.model),
      dryRun: Boolean(opts.dryRun),
    })
  );

program
  .command("update")
  .helpGroup("Maintenance:")
  .description("Update the copilot-env checkout to the latest GitHub release.")
  .option(
    "--check",
    "Report update status and exit - no changes (0 up to date, 1 update available, 2 no release resolved).",
  )
  .option(
    "--force",
    "Update even when this is a source checkout; the sync overwrites local files.",
  )
  .option(
    "--auto-status",
    "Report autoupdate status and exit (the update.auto config key, cooldown, last check, last result).",
  )
  .option(
    "--verify",
    "Verify the download against the release's Sigstore build-provenance attestation " +
      "(the default; the update.verify-provenance config key persists a choice).",
  )
  .option(
    "--no-verify",
    "Skip build-provenance verification for this run (the SHA256 check against checksums.txt " +
      "still applies).",
  )
  .option("--dry-run", `${DRY_RUN_HELP} The release is resolved, nothing is downloaded.`)
  .action((opts: Opts) =>
    runUpdate({
      check: Boolean(opts.check),
      force: Boolean(opts.force),
      autoStatus: Boolean(opts.autoStatus),
      verify: opts.verify as boolean | undefined,
      dryRun: Boolean(opts.dryRun),
    })
  );

program
  .command("shell")
  .helpGroup("Setup:")
  .description(
    "Set up the shell environment: wire the copilot-env integration (rc / PowerShell $PROFILE) " +
      "and optionally install the agent CLIs (the cl / co / cx launchers follow the `shell.launchers` config key).",
  )
  .option(
    "--clis",
    "Also install the optional claude / copilot / codex agent CLIs, updating an outdated npm install.",
  )
  .option(
    "--cooldown [days]",
    `With --clis: target the newest agent-CLI npm releases aged >= DAYS. Bare --cooldown uses ${DEFAULT_CLI_COOLDOWN_DAYS} days.`,
    coerceDays,
  )
  .option(
    "--no-sudo",
    "With --clis: avoid sudo/system package managers; use only user-local tooling.",
  )
  .option("--no-prereqs", "With --clis: verify prerequisites and CLIs only; install nothing.")
  .option("--all-hosts", "Windows only: target the CurrentUserAllHosts profile.")
  .option("--remove", "Unwire the integration (the `shell.launchers` config key is left as it is).")
  .option("--dry-run", `${DRY_RUN_HELP} Each rc file with its block diff; no CLI installs.`)
  .action((opts: Opts) =>
    runShell({
      remove: Boolean(opts.remove),
      clis: Boolean(opts.clis),
      cooldown: resolveCooldown(opts.cooldown, DEFAULT_CLI_COOLDOWN_DAYS),
      noSudo: opts.sudo === false,
      noPrereqs: opts.prereqs === false,
      allHosts: Boolean(opts.allHosts),
      dryRun: Boolean(opts.dryRun),
    })
  );

program
  .command("install")
  .helpGroup("Maintenance:")
  .description(
    "Finalize this install root: write the runtime files and launcher shims " +
      "shipped inside this binary, then wire shell integration. Run by install.sh / install.ps1.",
  )
  .option(
    "--no-shell-integration",
    "Skip the shell wiring pass (no block is added to your rc file). A reinstall over an older " +
      "release still runs its migrations, which may rewrite or remove a copilot-env block already there.",
  )
  .option("--all-hosts", "Windows only: wire the AllHosts PowerShell profile.")
  .option(
    "--assets-only",
    "Refresh the runtime files and shims only - no shell wiring, no summary. Used by `agent update` after it swaps the binary.",
  )
  .option("--dry-run", DRY_RUN_HELP)
  .action((opts: Opts) => {
    // Commander's --no-<x> sets opts.shellIntegration=false, so read the positive form.
    const options = {
      noShellIntegration: opts.shellIntegration === false,
      allHosts: Boolean(opts.allHosts),
      assetsOnly: Boolean(opts.assetsOnly),
      dryRun: Boolean(opts.dryRun),
    };
    // Collected here: the install layer never imports the command layer.
    return options.dryRun
      ? runDryRun(() => Promise.resolve(runInstall(options)))
      : runInstall(options);
  });

program
  .command("uninstall")
  .helpGroup("Maintenance:")
  .description(
    "Remove copilot-env from this machine: daemons, profiles, agent wiring, " +
      "shell integration, data, and the install itself.",
  )
  .option("--yes", "Skip the confirmation prompt (headless use).")
  .option("--dry-run", "Print what would be removed without changing anything.")
  .option("--force", "Also delete the install directory when it is a source checkout.")
  .action((opts: Opts) =>
    runUninstall({
      yes: Boolean(opts.yes),
      dryRun: Boolean(opts.dryRun),
      force: Boolean(opts.force),
    })
  );

// `agent update` and an `agent install` over a prior version invoke this on the NEW install after
// swapping it in, so the migrations run from the new code. A compiled binary has no
// `src/migrations/index.ts` on disk, hence a subcommand rather than a script path.
program
  .command("migrate")
  .helpGroup("Maintenance:")
  .description(
    "Run the migration steps due between two versions (what `agent update` and a reinstall " +
      "run after swapping in a release). Safe to re-run: steps are idempotent.",
  )
  .argument("<from>", "Version being updated away from.")
  .argument("<to>", "Version being updated to.")
  .option("--dry-run", `${DRY_RUN_HELP} Each step's moves and removals, by path.`)
  .action((from: string, to: string, opts: Opts) =>
    opts.dryRun ? runDryRun(() => runMigrations(from, to)) : runMigrations(from, to)
  );

if (import.meta.main) {
  // A child of a dry run (the Direct probes' agent CLIs run this CLI as their auth helper) is a
  // silent dry run: its bookkeeping lands nothing, and it prints no plan of its own. The marker is
  // the one the spawning dry run minted (DRY_RUN_ENV), so a value that reached the environment any
  // other way changes nothing here.
  const run = (): Promise<unknown> => program.parseAsync(invocation.args, { from: "user" });
  (spawnedByDryRun() ? collectDryRun(run) : run()).catch((e: unknown) => {
    consola.error(errMessage(e));
    // exitCode, not process.exit, so pending stderr writes flush.
    process.exitCode = 1;
  });
}
