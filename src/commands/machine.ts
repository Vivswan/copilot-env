// The commands about this machine and its install, none about one profile: `agent config` (the
// machine's preferences), `agent cost`, `agent codex-mobile`, `agent update`, `agent shell`,
// `agent install`, `agent uninstall`, and `agent migrate`. Registered after the profile tree
// (src/commands/profile_verbs.ts, profile_ops.ts), in this order, so the help groups keep theirs.
import type { Command } from "commander";
import { runCodexMobile } from "../codex/mobile.ts";
import { OPENROUTER_MODELS_URL } from "../copilot_api/config_registry.ts";
import { runInstall } from "../install/installer.ts";
import { runMigrations } from "../migrations/index.ts";
import { runCost } from "../usage/cost.ts";
import { redirectConsolaToStderr } from "../utils/logger.ts";
import { configTableOutput, refuseProfileKey, runConfig } from "./config.ts";
import { runDryRun } from "./dry_run.ts";
import { DRY_RUN_HELP, helpNote, type Opts } from "./registration.ts";
import { DEFAULT_CLI_COOLDOWN_DAYS, runShell } from "./setup.ts";
import { runUninstall } from "./uninstall.ts";
import { runUpdate } from "./update.ts";

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

export function registerMachineCommands(program: Command): void {
  // `agent config <verb>`: the machine's preferences (daemon.*, codex.*, claude.*, shell.*, update.*,
  // cost.*) and the shared default every profile follows for proxy.* / probe.*. A key that follows
  // the credential (identity, host, passthrough, static-key) is a profile's own: `agent profile
  // [<name>] set|get|unset`, which for a proxy.* / probe.* key with no name writes the same store
  // bytes as this command (the default profile never carries its own override).
  const CONFIG_VIEW = { kind: "config" } as const;
  const config = program
    .command("config")
    .helpGroup("Settings:")
    .usage("<verb> [options]")
    .summary("Set, get, or unset this machine's preferences")
    .description(
      "Set, get, or unset this machine's preferences: `agent config set|get|unset <key>`. These " +
        "are the daemon.*, codex.*, claude.*, shell.*, update.*, and cost.* keys, plus the " +
        "shared default of every proxy.* / probe.* key. Bare `agent config` lists every key with " +
        "its value. See also: `agent profile [<name>] set|get|unset` for a profile's own keys " +
        "(identity, host, passthrough, static-key) and a named profile's overrides.",
    )
    // A function, not a string baked at startup, so the values are the store's at help-render time.
    .addHelpText("after", () => `\n${configTableOutput(process.platform, CONFIG_VIEW)}`)
    .action(() => runConfig({ kind: "get", view: CONFIG_VIEW }));
  config
    .command("set")
    .summary("Set a machine key or a shared default")
    .description("Set a machine key, or the shared default of a proxy.* / probe.* key.")
    .argument("<key>", "A key of the table `agent config --help` prints.")
    .argument("<value>", "The value, parsed by the key's type.")
    .option("--dry-run", DRY_RUN_HELP)
    .action((key: string, value: string, opts: Opts) => {
      refuseProfileKey(key);
      return runConfig({
        kind: "set",
        key,
        value,
        view: CONFIG_VIEW,
        dryRun: Boolean(opts.dryRun),
      });
    });
  config
    .command("get")
    .summary("Show a key's value and where it comes from")
    .description(
      "Show one key's value in effect (stdout) and where it comes from (stderr), or every key " +
        "with no key.",
    )
    .argument("[key]", "A key of the table `agent config --help` prints.")
    .action((key: string | undefined) => {
      if (key !== undefined) refuseProfileKey(key);
      return runConfig({ kind: "get", key, view: CONFIG_VIEW });
    });
  config
    .command("unset")
    .summary("Drop a key, back to its built-in default")
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
    .summary("Estimate token spend from proxy and agent logs")
    .description(
      "Estimate the cost of your usage: token totals from the proxy's usage databases, the Codex " +
        "session logs, and the Claude transcripts, priced at public OpenRouter rates (GitHub's " +
        "own where the two differ). --days or --month narrows the window, --per-day and " +
        "--sources break the totals down, --json emits the numbers as data.",
    )
    .option(
      "--days <days>",
      "Only include usage from the last N days (default: all). A whole number counts local " +
        "calendar days (1 = today, 7 = today plus the six days before); a decimal is an exact " +
        "span of 24-hour days (1.0 = the last 24 hours, 0.5 = the last 12).",
    )
    .option(
      "--month",
      "Only this month's usage, from 00:00 UTC on the 1st: the period agent credits meters. " +
        "Not with --days.",
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
            "all three and counts a request the proxy and a client log both recorded once; use " +
            "--sources for per-source tables.",
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
        month: Boolean(opts.month),
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
    .summary("Pair the Codex desktop app with your phone")
    .description(
      "Pair the Codex desktop app with its phone remote-control flow, interactively. macOS and " +
        "Windows only.",
    )
    .action(() => runCodexMobile());

  program
    .command("update")
    .helpGroup("Maintenance:")
    .summary("Update copilot-env to the latest release")
    .description(
      "Update copilot-env to the latest GitHub release: download it, verify its provenance " +
        "(unless --no-verify or the update.verify-provenance key opts out), swap it in, and run " +
        "the migrations due. --check only reports whether an update exists.",
    )
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
    .summary("Wire your shell; --clis also installs the CLIs")
    .description(
      "Wire copilot-env into your shell: one block in the rc file (bash, zsh) or the PowerShell " +
        "$PROFILE defines `agent` and, when the `shell.launchers` key is on, the cl / co / cx " +
        "launchers. --clis also installs or updates the claude, codex, and copilot CLIs; " +
        "--remove takes the block out again.",
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
    .option(
      "--remove",
      "Unwire the integration (the `shell.launchers` config key is left as it is).",
    )
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
    .summary("Finalize an install root (run by the installer)")
    .description(
      "Finalize this install root: write the runtime files and launcher shims shipped inside " +
        "this binary, then wire the shell integration. install.sh and install.ps1 run it for " +
        "you; run it by hand only to refresh the current version in place.",
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
    .summary("Remove copilot-env from this machine")
    .description(
      "Remove copilot-env from this machine: daemons, profiles, agent wiring, shell " +
        "integration, data, and the install itself. Asks first; --yes answers.",
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
    .summary("Run the migration steps between two versions")
    .description(
      "Run the migration steps due between two versions. `agent update` and a reinstall run it " +
        "for you after swapping in a release; run it by hand only when a message tells you to. " +
        "Safe to re-run: every step is idempotent.",
    )
    .argument("<from>", "Version being updated away from.")
    .argument("<to>", "Version being updated to.")
    .option("--dry-run", `${DRY_RUN_HELP} Each step's moves and removals, by path.`)
    .action((from: string, to: string, opts: Opts) =>
      opts.dryRun ? runDryRun(() => runMigrations(from, to)) : runMigrations(from, to)
    );
}
