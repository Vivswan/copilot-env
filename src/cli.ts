// CLI entrypoint: declares Commander commands and delegates behavior to command modules.
//
// Direct run:
//   deno run -P=cli src/cli.ts <command> [args]
//
// This is the implementation behind bin/agent and bin/agent.ps1, and the entry
// `deno compile` builds the released binary from. In a dev checkout the
// launchers run this after ensuring the pinned deno and the locked deps are
// present; direct runs are useful for tests and local command debugging. Run
// `deno run -P=cli src/cli.ts --help` for the command tree and per-command
// arguments.
//
// Commander (not citty) so unknown flags are rejected (`error: unknown option
// '--x'`, exit 1) instead of silently accepted, and so help wraps to the
// terminal width natively (no hand-rolled renderer needed).
import "./utils/dotenv.ts";
import { Command } from "commander";
import { consola } from "consola";
import { parseModeFlags } from "./agents/provider_mode.ts";
import { DEFAULT_AUTOUPDATE_COOLDOWN_DAYS } from "./autoupdate/state.ts";
import { runClaude } from "./claude/config.ts";
import { runCodex } from "./codex/config.ts";
import { runCodexHost } from "./codex/host.ts";
import { runCodexMobile } from "./codex/mobile.ts";
import { runAuth } from "./commands/auth.ts";
import { runConfig } from "./commands/config.ts";
import { runEnv } from "./commands/env.ts";
import { runHealth } from "./commands/health.ts";
import { runInit } from "./commands/init.ts";
import { runMcp } from "./commands/mcp.ts";
import { runModels } from "./commands/models.ts";
import { runProfile } from "./commands/profile.ts";
import { runSettings } from "./commands/settings.ts";
import { DEFAULT_CLI_COOLDOWN_DAYS, runShell } from "./commands/setup.ts";
import { parseStartAction, runStart } from "./commands/start.ts";
import { runStop } from "./commands/stop.ts";
import { runUninstall } from "./commands/uninstall.ts";
import { runUpdate } from "./commands/update.ts";
import { configKeysHelp } from "./copilot_api/env_config.ts";
import { AUTH_PROVIDERS, type AuthProvider } from "./copilot_api/env_state.ts";
import { ghTokenEnvVarsLabel } from "./copilot_api/gh_cli.ts";
import { runInstall } from "./install/installer.ts";
import { runMigrations } from "./migrations/index.ts";
import { runCost } from "./usage/cost.ts";
import { OPENROUTER_MODELS_URL } from "./usage/pricing.ts";
import { bold, cyan, gray } from "./utils/ansi.ts";
import { errMessage } from "./utils/error.ts";
import { disableConsolaTimestamps } from "./utils/logger.ts";
import { packageVersion } from "./utils/version.ts";

// Drop consola's right-aligned wall-clock timestamp from all command output.
disableConsolaTimestamps();

// Thin Commander wiring: each subcommand only declares its parameters and calls
// the matching domain/command run function.

/** Commander hands action callbacks an options bag of mixed-typed values. */
type Opts = Record<string, unknown>;

// Per-provider help details, keyed EXHAUSTIVELY on AuthProvider so the provider list
// in the help text is derived from AUTH_PROVIDERS (env_state.ts owns the vocabulary)
// and a membership change fails the compile here instead of drifting the help.
const AUTH_PROVIDER_HELP: Record<AuthProvider, string> = {
  "copilot": "device flow, read:user scope",
  "gh-cli": "use the machine's gh login",
  "gh-token": `store ${ghTokenEnvVarsLabel()} - for headless servers`,
};

/** The providers as natural-language help: "'a' (...), 'b' (...), or 'c' (...)". */
function authProviderChoicesHelp(): string {
  const parts = AUTH_PROVIDERS.map((p) => `'${p}' (${AUTH_PROVIDER_HELP[p]})`);
  return `${parts.slice(0, -1).join(", ")}, or ${parts[parts.length - 1]}`;
}

/** The providers as a bare quoted list: "'copilot' | 'gh-cli' | 'gh-token'". */
function authProviderNamesHelp(): string {
  return AUTH_PROVIDERS.map((p) => `'${p}'`).join(" | ");
}

function parseNonNegativeDays(raw: string, flag: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${flag} expects a non-negative whole number of days (got '${raw}')`);
  }
  return Number.parseInt(raw, 10);
}

/** Commander value coercion for the optional-valued `--cooldown [days]`. */
function coerceDays(raw: string): number {
  return parseNonNegativeDays(raw, "--cooldown");
}

/**
 * Resolve `--cooldown [days]` to a day count or null: absent -> null, bare
 * `--cooldown` -> Commander passes `true` (coercion skipped) -> default days,
 * `--cooldown=N` / `--cooldown N` -> already coerced to the number N.
 */
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
  .option("--full-help", "Print help for `agent` and every subcommand, then exit.");

// `agent --full-help`: dump the top-level help plus each subcommand's help in one
// shot. The option:full-help listener fires during parse -- before any "missing
// command" handling -- so it works with no subcommand.
program.on("option:full-help", () => {
  const sep = "─".repeat(72);
  // Render a command's FULL help -- including any `addHelpText('after', ...)` (e.g. the
  // `config` key list), which `helpInformation()` omits because that text is emitted via
  // help events during outputHelp(). Capture those events into a string.
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
  }
  process.stdout.write(parts.join("\n"));
  process.exit(0);
});

// Tint Commander's native help to match the `agent health` report: bold section
// titles, cyan command/option names, gray descriptions. The ansi.ts helpers
// no-op under NO_COLOR / TERM=dumb / CI / test runs, so these hooks degrade to
// plain text on their own -- Commander still owns all layout and width-wrapping.
program.configureHelp({
  styleTitle: bold,
  styleCommandText: cyan,
  styleOptionTerm: cyan,
  styleSubcommandTerm: cyan,
  styleDescriptionText: gray,
});

// Subcommands are added in display order and grouped into help sections via
// .helpGroup (Commander renders the groups in first-appearance order), so
// `init` (the headline command) appears first under the first heading.

program
  .command("init")
  .helpGroup("Setup:")
  .description("Set up both Codex and Claude (auto-detect GitHub Copilot Direct vs the proxy).")
  .option("--direct", "Force both agents to GitHub Copilot Direct (no auto-detect probe).")
  .option("--proxy", "Force both agents to the local copilot-api proxy (no auto-detect probe).")
  .action((opts: Opts) => runInit({ mode: parseModeFlags(opts) }));

program
  .command("auth")
  .helpGroup("Settings:")
  .description("Manage the GitHub Copilot credential (the single source of truth for Direct).")
  .option(
    "--provider <provider>",
    `How to authenticate (no flag => interactive choice): ${authProviderChoicesHelp()}.`,
  )
  .option(
    "--set [token]",
    `Non-interactive gh-token: store this token verbatim, or read ${ghTokenEnvVarsLabel()} ` +
      "when given no value. Implies --provider gh-token.",
  )
  .option(
    "--get",
    "Print the resolved token to stdout (provider-driven: gh-cli → `gh auth token`, " +
      "copilot/gh-token → the stored token).",
  )
  .option("--del", "Clear the stored token (de-authenticate).")
  .option("--check", "Report auth status and exit (0 authenticated, 1 not).")
  .option(
    "--print-proxy-token",
    "Print the local proxy's API key to stdout (used by the proxy-mode resolver after it ensures the proxy).",
  )
  .option(
    "--profile <name>",
    "Address a named credential profile instead of the default (named profiles never " +
      "fall back to the default credential).",
  )
  .option("--list", "List the default + named credential profiles (providers only, never tokens).")
  .action((opts: Opts) =>
    runAuth({
      provider: opts.provider as string | undefined,
      set: opts.set as string | boolean | undefined,
      get: Boolean(opts.get),
      del: Boolean(opts.del),
      check: Boolean(opts.check),
      printProxyToken: Boolean(opts.printProxyToken),
      profile: opts.profile as string | undefined,
      list: Boolean(opts.list),
    })
  );

program
  .command("profile")
  .helpGroup("Settings:")
  .description(
    "Manage named profiles: one credential + one mode (direct or proxy), wired into BOTH agents.",
  )
  .option(
    "--add <name>",
    "Create (or re-wire) a profile: acquires its own credential, records the mode, " +
      "wires Codex + Claude. Re-add with the other mode flag to switch modes.",
  )
  .option(
    "--del <name>",
    "Delete a profile everywhere: stop its daemon, clear its credential, strip both " +
      "agents' wiring, remove its daemon home.",
  )
  .option("--list", "List every profile with its provider, mode, and daemon status.")
  .option(
    "--check <name>",
    "Report the profile's mode and exit (0 direct, 2 proxy, 1 no such profile) - the launcher probe.",
  )
  .option(
    "--settings-for <name>",
    "Re-sync the profile's Claude settings file and print its absolute path (the `cl --profile` hook).",
  )
  .option(
    "--sync",
    "Refresh every profile's wiring against the live proxy ports (the `cx --profile` hook).",
  )
  .option("--direct", "With --add: wire the profile to GitHub Copilot Direct.")
  .option("--proxy", "With --add: wire the profile to its own local proxy daemon.")
  .option(
    "--provider <provider>",
    `With --add: how the profile authenticates (${authProviderNamesHelp()}); no flag prompts.`,
  )
  .option(
    "--set [token]",
    "With --add: non-interactive gh-token - store this token verbatim, or read " +
      `${ghTokenEnvVarsLabel()} when given no value.`,
  )
  .action((opts: Opts) =>
    runProfile({
      add: opts.add as string | undefined,
      del: opts.del as string | undefined,
      list: Boolean(opts.list),
      check: opts.check as string | undefined,
      settingsFor: opts.settingsFor as string | undefined,
      sync: Boolean(opts.sync),
      mode: parseModeFlags(
        opts,
        "--direct and --proxy are mutually exclusive (a profile has ONE mode)",
      ),
      provider: opts.provider as string | undefined,
      set: opts.set as string | boolean | undefined,
    })
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
  .action((opts: Opts) =>
    runStop({ profile: opts.profile as string | undefined, all: Boolean(opts.all) })
  );

program
  .command("config")
  .helpGroup("Settings:")
  .description("Get/set copilot-env preferences (auto-start, passthrough, idle-timeout, ...).")
  .option("--set <key...>", "Set a preference: --set <key> <value>.")
  .option("--get [key]", "Print all preferences, or just one key's value.")
  .option("--del <key>", "Delete a preference (revert to its default).")
  .addHelpText("after", `\n${configKeysHelp()}`)
  .action((opts: Opts) =>
    runConfig({
      set: opts.set as string[] | undefined,
      get: opts.get as string | boolean | undefined,
      del: opts.del as string | undefined,
    })
  );

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
      "on this machine are kept, and agents the bundle leaves unconfigured are not touched.",
  )
  .option(
    "--with-credentials",
    "With --export: include the real tokens (treat the output like a password).",
  )
  .option("--force", "With --import: skip the confirmation prompt (headless use).")
  .option("--no-backup", "With --import: skip the automatic pre-import settings backup.")
  .addHelpText(
    "after",
    "\nImport semantics: preferences are FULL-REPLACE (a key absent from the bundle resets " +
      "to its built-in default), while credentials are PRESERVE-IF-ABSENT (a slot whose " +
      "token is redacted or missing never overwrites a working local credential).",
  )
  .action((opts: Opts) =>
    runSettings({
      exportTo: opts.export as string | boolean | undefined,
      importFrom: opts.import as string | undefined,
      withCredentials: Boolean(opts.withCredentials),
      force: Boolean(opts.force),
      noBackup: opts.backup === false,
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
  .option("--days <days>", "Only include usage from the last N days (default: all).")
  .option("--json", "Emit a JSON object instead of a formatted report.")
  .option("--per-day", "Also print a day-by-day cost/token breakdown.")
  .option(
    "--sources",
    "Print full per-source tables (proxy + each Codex provider + Claude) with day stats instead of the combined table.",
  )
  .option(
    "--pricing-url <url>",
    "OpenRouter models API URL for live pricing.",
    OPENROUTER_MODELS_URL,
  )
  .addHelpText(
    "after",
    [
      "",
      "Sources: the proxy's per-host SQLite DBs (default + every profile daemon home;",
      "proxied traffic only), the Codex CLI's local session logs, and Claude Code's local",
      "transcripts (each agent's FULL traffic, Direct included). The default table merges",
      "all three, so traffic through the proxy can be double counted; use --sources for",
      "per-source tables.",
      "",
      "Active days: distinct local calendar days (your timezone) that recorded at",
      "least one request, unioned across the displayed sources. The header also shows",
      "the inclusive min..max calendar span and what percent of it was active. Avg/day",
      "divides each total by the active-day count; Median/day takes the median of each",
      "column independently across the active days (so columns need not sum, but",
      "each is robust to a few outlier days). Idle days are never counted in either.",
    ].join("\n"),
  )
  .action((opts: Opts) =>
    runCost({
      days: opts.days as string | undefined,
      json: Boolean(opts.json),
      perDay: Boolean(opts.perDay),
      pricingUrl: String(opts.pricingUrl),
      sources: Boolean(opts.sources),
    })
  );

program
  .command("codex")
  .helpGroup("Setup:")
  .description(
    "Configure Codex: GitHub Copilot Direct or the local proxy (auto-detects with no flag).",
  )
  .option("--direct", "Force GitHub Copilot Direct (no auto-detect probe).")
  .option("--proxy", "Force the local copilot-api proxy (no auto-detect probe).")
  .option(
    "--check",
    "Report the configured provider and exit - no changes, no probe (0 direct, 1 other, 2 proxy/none).",
  )
  .option("--host", "(Linux/macOS) Build the per-host CODEX_HOME symlink farm and wire its config.")
  .option("--delete-host", "With --host: remove the per-host CODEX_HOME and stop exporting it.")
  .option("--mobile", "Interactive: pair the Codex desktop app with its phone remote-control flow.")
  .action(async (opts: Opts) => {
    const common = { mode: parseModeFlags(opts) };
    // --mobile is its own interactive flow (toggles config around app pairing).
    if (opts.mobile) {
      return runCodexMobile();
    }
    // --check is read-only: never build/delete the host farm or probe, even when
    // combined with --host/--delete-host. Route it to the check path first.
    if (opts.check) {
      await runCodex({ ...common, check: true });
      return;
    }
    // --host (and --delete-host, which only makes sense with it) route to the
    // per-host symlink farm; everything else configures the active CODEX_HOME.
    if (opts.host || opts.deleteHost) {
      await runCodexHost({ ...common, delete: Boolean(opts.deleteHost) });
    } else {
      await runCodex(common);
    }
  });

program
  .command("claude")
  .helpGroup("Setup:")
  .description(
    "Configure Claude Code: GitHub Copilot Direct or the local proxy (auto-detects with no flag).",
  )
  .option("--direct", "Force GitHub Copilot Direct (no auto-detect probe).")
  .option("--proxy", "Force the local copilot-api proxy (no auto-detect probe).")
  .option(
    "--check",
    "Report the configured provider and exit - no changes, no probe (0 direct, 1 other, 2 proxy/none).",
  )
  .action((opts: Opts) =>
    runClaude({
      check: Boolean(opts.check),
      mode: parseModeFlags(opts),
    })
  );

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
    "With --serve: web-search model for this process (overrides message-websearch-model).",
  )
  .action((opts: Opts) =>
    runMcp({
      serve: Boolean(opts.serve),
      remove: Boolean(opts.remove),
      profile: opts.profile === undefined ? undefined : String(opts.profile),
      model: opts.model === undefined ? undefined : String(opts.model),
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
    "--auto",
    "Enable autoupdate: once a day, adopt the newest release aged >= the configured " +
      `update-cooldown (default ${DEFAULT_AUTOUPDATE_COOLDOWN_DAYS}) days, and apply once now.`,
  )
  .option("--no-auto", "Disable autoupdate.")
  .option(
    "--auto-status",
    "Report autoupdate status and exit (enabled, cooldown, last check, last result).",
  )
  .action((opts: Opts) =>
    runUpdate({
      check: Boolean(opts.check),
      force: Boolean(opts.force),
      auto: opts.auto === true,
      noAuto: opts.auto === false,
      autoStatus: Boolean(opts.autoStatus),
    })
  );

program
  .command("shell")
  .helpGroup("Setup:")
  .description(
    "Set up the shell environment: wire the copilot-env integration (rc / PowerShell $PROFILE), " +
      "optionally the cl / co / cx launchers and the optional agent CLIs.",
  )
  .option("--clis", "Also install the optional claude / copilot / codex agent CLIs.")
  .option(
    "--cooldown [days]",
    `With --clis: install the newest agent-CLI npm releases aged >= DAYS. Bare --cooldown uses ${DEFAULT_CLI_COOLDOWN_DAYS} days.`,
    coerceDays,
  )
  .option(
    "--no-sudo",
    "With --clis: avoid sudo/system package managers; use only user-local tooling.",
  )
  .option("--no-prereqs", "With --clis: verify prerequisites and CLIs only; install nothing.")
  .option("--launchers", "Also wire the opt-in cl / co / cx launchers.")
  .option("--all-hosts", "Windows only: target the CurrentUserAllHosts profile.")
  .option(
    "--remove",
    "Unwire the integration (and launchers); with --launchers, remove only the launcher block.",
  )
  .action((opts: Opts) =>
    runShell({
      remove: Boolean(opts.remove),
      launchers: Boolean(opts.launchers),
      clis: Boolean(opts.clis),
      cooldown: resolveCooldown(opts.cooldown, DEFAULT_CLI_COOLDOWN_DAYS),
      noSudo: opts.sudo === false,
      noPrereqs: opts.prereqs === false,
      allHosts: Boolean(opts.allHosts),
    })
  );

program
  .command("install")
  .helpGroup("Maintenance:")
  .description(
    "Finalize this install root: write the runtime files and launcher shims " +
      "shipped inside this binary, then wire shell integration. Run by install.sh / install.ps1.",
  )
  .option("--no-shell-integration", "Materialize the runtime files only; don't touch your rc file.")
  .option("--all-hosts", "Windows only: wire the AllHosts PowerShell profile.")
  .option(
    "--assets-only",
    "Refresh the runtime files and shims only - no shell wiring, no summary. Used by `agent update` after it swaps the binary.",
  )
  .action((opts: Opts) =>
    runInstall({
      // Commander's --no-<x> sets opts.shellIntegration=false, so read the positive form.
      noShellIntegration: opts.shellIntegration === false,
      allHosts: Boolean(opts.allHosts),
      assetsOnly: Boolean(opts.assetsOnly),
    })
  );

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

// `agent update` invokes this on the NEW install after swapping it in, so the
// migrations run from the new code rather than from the pre-update process's memory.
// A compiled binary has no `src/migrations/index.ts` on disk to run, so the runner is
// imported statically and reached through this subcommand instead of a script path
// (`deno run src/migrations/index.ts <from> <to>` keeps working in a dev checkout).
program
  .command("migrate")
  .helpGroup("Maintenance:")
  .description(
    "Run the migration steps due between two versions (what `agent update` runs after " +
      "swapping in a release). Safe to re-run: steps are idempotent.",
  )
  .argument("<from>", "Version being updated away from.")
  .argument("<to>", "Version being updated to.")
  .action((from: string, to: string) => runMigrations(from, to));

if (import.meta.main) {
  // Single error renderer for both option-coercion and action errors.
  program.parseAsync(process.argv).catch((e: unknown) => {
    consola.error(errMessage(e));
    // Set exitCode (not process.exit) so pending stderr writes flush.
    process.exitCode = 1;
  });
}
