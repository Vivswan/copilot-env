// The commands about this machine and its install, none about one profile: `agent config` (the
// machine's preferences), `agent cost`, `agent codex-mobile`, `agent update`, `agent shell`,
// `agent install`, `agent uninstall`, and `agent migrate`. Registered after the profile tree
// (src/commands/profile_verbs.ts, profile_ops.ts), in this order, so the help groups keep theirs.
import type { Command } from "commander";
import { runCodexMobile } from "../codex/mobile.ts";
import { runInstall } from "../install/installer.ts";
import { runMigrations } from "../migrations/index.ts";
import { runCost } from "../usage/cost.ts";
import { redirectConsolaToStderr } from "../utils/logger.ts";
import { configTableOutput, refuseProfileKey, resolveSetPair, runConfig } from "./config.ts";
import { runDryRun } from "./dry_run.ts";
import { DRY_RUN_HELP, type Opts } from "./registration.ts";
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
      "Set, get, or unset this machine's preferences and the shared proxy.* / probe.* " +
        "defaults; bare `agent config` lists every key. A profile's own keys: " +
        "`agent profile [<name>] set|get|unset`.",
    )
    // A function, not a string baked at startup, so the values are the store's at help-render time.
    .addHelpText("after", () => `\n${configTableOutput(process.platform, CONFIG_VIEW)}`)
    .action(() => runConfig({ kind: "get", view: CONFIG_VIEW }));
  config
    .command("set")
    .summary("Set a machine key or a shared default")
    .description(
      "Set a machine key, or the shared default of a proxy.* / probe.* key.",
    )
    .argument("<key>", "A key of `agent config`, or `<key>=<value>`.")
    .argument("[value]", "The value; omit it with `<key>=<value>`.")
    .option("--dry-run", DRY_RUN_HELP)
    .action((rawKey: string, rawValue: string | undefined, opts: Opts) => {
      const { key, value } = resolveSetPair(rawKey, rawValue, "agent config set");
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
      "Show a key's value (stdout) and its origin (stderr). No key: every key.",
    )
    .argument("[key]", "A key of `agent config`.")
    .action((key: string | undefined) => {
      if (key !== undefined) refuseProfileKey(key);
      return runConfig({ kind: "get", key, view: CONFIG_VIEW });
    });
  config
    .command("unset")
    .summary("Drop a key, back to its built-in default")
    .description("Drop a key, back to its built-in default.")
    .argument("<key>", "A key of `agent config`.")
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
      "Estimate your token spend from the proxy's usage databases and the Codex and Claude " +
        "session logs, at OpenRouter rates with GitHub's Copilot rate card over them. " +
        "A request both the proxy and a log recorded counts once.",
    )
    .option("--days <days>", "Only the last N days; 0.5 = the last 12 hours.")
    .option("--month", "Only this month, from 00:00 UTC on the 1st.")
    .option("--json", "Print JSON instead of the report.")
    .option("--per-day", "Also print a day-by-day breakdown.")
    .option("--sources", "One table per source instead of the merged one.")
    .option("--pricing-url <url>", "OpenRouter price list URL for this run.")
    .option("--no-index", "Parse every log; never touch the usage index.")
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
      "Update copilot-env to the latest release: download it, verify its provenance, swap it " +
        "in, and run the migrations due.",
    )
    .option("--check", "Report only; exit 0 current, 1 update, 2 no release.")
    .option("--force", "Update a source checkout too (overwrites local files).")
    .option("--auto-status", "Report the daily self-update's status and exit.")
    .option("--verify", "Verify Sigstore provenance (the default).")
    .option("--no-verify", "Skip provenance verification; SHA256 is still checked.")
    .option("--dry-run", "Resolve the release; download nothing.")
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
      "Wire copilot-env into your shell: one block in your rc file or PowerShell $PROFILE " +
        "defines `agent` and, with `shell.launchers` on, cl / co / cx. " +
        "--clis also installs or updates the agent CLIs.",
    )
    .option("--clis", "Also install or update the claude, codex, copilot CLIs.")
    .option(
      "--cooldown [days]",
      `With --clis: CLI releases at least N days old (bare: ${DEFAULT_CLI_COOLDOWN_DAYS}).`,
      coerceDays,
    )
    .option("--no-sudo", "With --clis: no sudo or system package managers.")
    .option("--no-prereqs", "With --clis: check prerequisites only, install nothing.")
    .option("--all-hosts", "Windows: wire the CurrentUserAllHosts profile.")
    .option("--remove", "Take the block out again (config keys untouched).")
    .option("--dry-run", DRY_RUN_HELP)
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
      "Finalize this install root: write the runtime files and shims inside this binary, then " +
        "wire the shell. The installer runs it for you; by hand it refreshes the current version.",
    )
    .option("--no-shell-integration", "Skip the shell wiring pass.")
    .option("--all-hosts", "Windows: wire the AllHosts PowerShell profile.")
    .option("--assets-only", "Runtime files and shims only; used by `agent update`.")
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
    .option("--yes", "Remove without asking.")
    .option("--dry-run", "Show what would be removed and remove nothing.")
    .option("--force", "Also delete a source-checkout install directory.")
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
      "Run the migration steps due between two versions; `agent update` and a reinstall run it " +
        "for you. Safe to re-run.",
    )
    .argument("<from>", "The version updated away from.")
    .argument("<to>", "The version updated to.")
    .option("--dry-run", "Show each step's moves and removals; change nothing.")
    .action((from: string, to: string, opts: Opts) =>
      opts.dryRun ? runDryRun(() => runMigrations(from, to)) : runMigrations(from, to)
    );
}
