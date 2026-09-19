// The entry behind bin/agent, bin/agent.ps1, and the `deno compile` binary. Commander rather than
// citty so unknown flags are rejected (`error: unknown option '--x'`, exit 1) instead of silently
// accepted, and so help wraps to the terminal width natively.
import "./utils/dotenv.ts";
import { Command } from "commander";
import { consola } from "consola";
import { runCodexMobile } from "./codex/mobile.ts";
import { configTableOutput, refuseProfileKey, runConfig } from "./commands/config.ts";
import { runDryRun } from "./commands/dry_run.ts";
import { spawnedByDryRun, withDryRun } from "./utils/dry_run.ts";
import {
  helpNote,
  registerDaemonAliases,
  registerEverywhereCommands,
} from "./commands/profile_ops.ts";
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
import { DEFAULT_CLI_COOLDOWN_DAYS, runShell } from "./commands/setup.ts";
import { runUninstall } from "./commands/uninstall.ts";
import { runUpdate } from "./commands/update.ts";
import { OPENROUTER_MODELS_URL } from "./copilot_api/env_config.ts";
import { runInstall } from "./install/installer.ts";
import { runMigrations } from "./migrations/index.ts";
import { runCost } from "./usage/cost.ts";
import { bold, cyan, gray } from "./utils/ansi.ts";
import { errMessage } from "./utils/error.ts";
import { configureConsolaOutput, redirectConsolaToStderr } from "./utils/logger.ts";
import { terminalWidth } from "./utils/table.ts";
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
// The default profile's `start` and `stop`, then the every-profile `health`, `credits`, and
// `settings` (src/commands/profile_ops.ts).
registerDaemonAliases(program, DRY_RUN_HELP);
registerEverywhereCommands(program, DRY_RUN_HELP);

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
  .command("codex-mobile")
  .helpGroup("Setup:")
  .description(
    "Interactive: pair the Codex desktop app with its phone remote-control flow (macOS/Windows).",
  )
  .action(() => runCodexMobile());

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
  const silent = async (): Promise<void> => {
    const outcome = await withDryRun(run);
    if (outcome.status === "failed") throw outcome.error;
  };
  (spawnedByDryRun() ? silent() : run()).catch((e: unknown) => {
    consola.error(errMessage(e));
    // exitCode, not process.exit, so pending stderr writes flush.
    process.exitCode = 1;
  });
}
