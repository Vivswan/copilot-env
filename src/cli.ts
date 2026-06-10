// CLI entrypoint: declares Commander commands and delegates behavior to command modules.
//
// Direct run:
//   bun src/cli.ts <command> [args]
//
// This is the implementation behind bin/agent and bin/agent.ps1. The launchers
// normally run this after ensuring Bun/deps are present; direct runs are useful
// for tests and local command debugging. Run `bun src/cli.ts --help` for the
// command tree and per-command arguments.
//
// Commander (not citty) so unknown flags are rejected (`error: unknown option
// '--x'`, exit 1) instead of silently accepted, and so help wraps to the
// terminal width natively (no hand-rolled renderer needed).
import "./utils/dotenv.ts";
import { Command } from "commander";
import { consola } from "consola";
import { runClaude } from "./claude/config.ts";
import { runCodex } from "./codex/config.ts";
import { runCodexHost } from "./codex/host.ts";
import { runCodexMobile } from "./codex/mobile.ts";
import { runEnv } from "./commands/env.ts";
import { runHealth } from "./commands/health.ts";
import { runInit } from "./commands/init.ts";
import { runSetupClis, runSetupLaunchers, runSetupShell } from "./commands/setup.ts";
import { runStart } from "./commands/start.ts";
import { runStop } from "./commands/stop.ts";
import { runUpdate } from "./commands/update.ts";
import { runCost } from "./usage/cost.ts";
import { OPENROUTER_MODELS_URL } from "./usage/pricing.ts";
import { bold, cyan, gray } from "./utils/ansi.ts";
import { disableConsolaTimestamps } from "./utils/logger.ts";
import { packageVersion } from "./utils/version.ts";

// Drop consola's right-aligned wall-clock timestamp from all command output.
disableConsolaTimestamps();

// Thin Commander wiring: each subcommand only declares its parameters and calls
// the matching domain/command run function. bin/agent runs `bun install` (in-place,
// in the checkout) before this, so the install/float is not a subcommand here.

/** Commander hands action callbacks an options bag of mixed-typed values. */
type Opts = Record<string, unknown>;

/**
 * Run a command action, rendering any thrown Error as a friendly one-line
 * message (no stack trace) with a non-zero exit code. Commander surfaces a
 * rejected action as an unhandled error; intercepting here — inside the action —
 * keeps an unexpected platform/arg/IO failure reading as `✖ <message>` instead
 * of dumping a Bun stack frame at the user. runSafe never rethrows, so the
 * action resolves cleanly and the exit code is carried by process.exitCode.
 */
async function runSafe(action: () => void | Promise<void>): Promise<void> {
  try {
    await action();
  } catch (e) {
    consola.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
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
 * Resolve `--cooldown [days]` to a day count or null: absent → null, bare
 * `--cooldown` → Commander passes `true` (coercion skipped) → default days,
 * `--cooldown=N` / `--cooldown N` → already coerced to the number N.
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
  .helpOption("--help", "Show this help.");

// Tint Commander's native help to match the `agent health` report: bold section
// titles, cyan command/option names, gray descriptions. The ansi.ts helpers
// no-op under NO_COLOR / TERM=dumb / CI / test runs, so these hooks degrade to
// plain text on their own — Commander still owns all layout and width-wrapping.
program.configureHelp({
  styleTitle: bold,
  styleCommandText: cyan,
  styleOptionTerm: cyan,
  styleSubcommandTerm: cyan,
  styleDescriptionText: gray,
});

// Subcommands are added in display order; the root help lists them in this order,
// so `init` (the headline command) appears first.

program
  .command("init")
  .description("Set up both Codex and Claude (auto-detect GitHub Copilot Direct vs the proxy).")
  .option("--direct", "Force both agents to GitHub Copilot Direct (no probe).")
  .option("--proxy", "Force both agents to the local proxy (no probe).")
  .action((opts: Opts) =>
    runSafe(() => runInit({ direct: Boolean(opts.direct), proxy: Boolean(opts.proxy) })),
  );

program
  .command("start")
  .description("Start the proxy in the background, detached.")
  .option("--dry-run", "Print the resolved startup plan without changing proxy runtime state.")
  .option(
    "--port <port>",
    "Pin the proxy to this port instead of auto-resolving from the default (fails if it is busy).",
  )
  .action((opts: Opts) =>
    runSafe(() => runStart({ "dry-run": Boolean(opts.dryRun), port: parsePort(opts.port) })),
  );

program
  .command("stop")
  .description("Stop the proxy on this host.")
  .action(() => runSafe(() => runStop()));

program
  .command("health")
  .description("Diagnose the local proxy and setup (exit 1 on any failure).")
  .option(
    "--scope <scope>",
    "Checks to run: full (default; whole environment) | runtime (fast proxy " +
      "readiness probe) | proxy (bootstrap + proxy + runtime) | setup (shell, " +
      "CLIs, Codex, Claude) | codex (Codex wiring only) | claude (Claude wiring only).",
    "full",
  )
  .option("--json", "Emit a JSON report instead of the formatted text report.")
  .option(
    "--live",
    "Also run a live read-only prompt through Codex/Claude to verify the configured backend end-to-end (codex/claude/full scopes).",
  )
  .action((opts: Opts) =>
    runSafe(() =>
      runHealth({ scope: String(opts.scope), json: Boolean(opts.json), live: Boolean(opts.live) }),
    ),
  );

program
  .command("env")
  .description("Print env assignments for the proxy, evaluated by the calling shell.")
  .option(
    "--format <format>",
    "Output syntax: 'posix' (default; `export KEY=VALUE`, eval-able by sh/bash/zsh) " +
      "or 'powershell' (`$env:KEY = '...'`, Invoke-Expression-able by PowerShell).",
    "posix",
  )
  .action((opts: Opts) => runSafe(() => runEnv({ format: String(opts.format) })));

program
  .command("cost")
  .description("Aggregate token usage across all per-host SQLite DBs and estimate cost.")
  .option("--days <days>", "Only include usage from the last N days (default: all).")
  .option("--json", "Emit a JSON object instead of a formatted report.")
  .option(
    "--pricing-url <url>",
    "OpenRouter models API URL for live pricing.",
    OPENROUTER_MODELS_URL,
  )
  .action((opts: Opts) =>
    runSafe(() =>
      runCost({
        days: opts.days as string | undefined,
        json: Boolean(opts.json),
        "pricing-url": String(opts.pricingUrl),
      }),
    ),
  );

program
  .command("codex")
  .description("Configure Codex: GitHub Copilot Direct, the local proxy, or auto-detect.")
  .option(
    "--codex-home <path>",
    "CODEX_HOME path to operate on. Default: ~/.codex (%USERPROFILE%\\.codex on Windows).",
  )
  .option("--proxy", "Force the local proxy (no probe).")
  .option("--direct", "Force GitHub Copilot Direct (no probe).")
  .option(
    "--auto",
    "Auto-detect: write direct when a live read-only Copilot Direct probe succeeds, else the proxy.",
  )
  .option(
    "--check",
    "Report the configured Codex provider without changing config or probing: exit 0 direct, 2 proxy, 1 other.",
  )
  .option("--host", "(Linux/macOS) Build the per-host CODEX_HOME symlink farm and wire its config.")
  .option(
    "--delete-host",
    "With --host: remove the per-host CODEX_HOME dir and stop exporting CODEX_HOME.",
  )
  .option(
    "--mobile",
    "Interactive: pair the Codex desktop app with its phone remote-control flow (toggles model_provider).",
  )
  .action((opts: Opts) =>
    runSafe(() => {
      const codexHome = opts.codexHome as string | undefined;
      const common = {
        "codex-home": codexHome,
        direct: Boolean(opts.direct),
        proxy: Boolean(opts.proxy),
        auto: Boolean(opts.auto),
      };
      // --mobile is its own interactive flow (toggles config around app pairing).
      if (opts.mobile) {
        return runCodexMobile({ "codex-home": codexHome });
      }
      // --check is read-only: never build/delete the host farm or probe, even when
      // combined with --host/--delete-host. Route it to the check path first.
      if (opts.check) {
        return runCodex({ ...common, check: true });
      }
      // --host (and --delete-host, which only makes sense with it) route to the
      // per-host symlink farm; everything else configures the active CODEX_HOME.
      if (opts.host || opts.deleteHost) {
        return runCodexHost({ ...common, delete: Boolean(opts.deleteHost) });
      }
      return runCodex(common);
    }),
  );

program
  .command("claude")
  .description("Configure Claude Code: GitHub Copilot Direct, the local proxy, or auto-detect.")
  .option(
    "--claude-home <path>",
    "Claude home to operate on. Default: $CLAUDE_CONFIG_DIR, else ~/.claude " +
      "(%USERPROFILE%\\.claude on Windows).",
  )
  .option("--proxy", "Force the local proxy (no probe).")
  .option("--direct", "Force GitHub Copilot Direct (no probe).")
  .option(
    "--auto",
    "Auto-detect: write direct when a live `claude -p` Copilot Direct probe succeeds, else the proxy.",
  )
  .option(
    "--check",
    "Report the configured Claude provider without changing config or probing: exit 0 direct, 2 proxy, 1 other.",
  )
  .action((opts: Opts) =>
    runSafe(() =>
      runClaude({
        "claude-home": opts.claudeHome as string | undefined,
        check: Boolean(opts.check),
        direct: Boolean(opts.direct),
        proxy: Boolean(opts.proxy),
        auto: Boolean(opts.auto),
      }),
    ),
  );

program
  .command("update")
  .description("Update the copilot-env checkout to the latest GitHub release.")
  .option(
    "--check",
    "Only report status, make no changes. Exit 0 = up to date, 1 = update available, 2 = no release resolved.",
  )
  .option(
    "--cooldown [days]",
    "Adopt the newest release aged >= DAYS. Bare --cooldown uses 7 days.",
    coerceDays,
  )
  .option(
    "--force",
    "Update even when this is a git checkout (.git present); the sync overwrites local files.",
  )
  .option(
    "--auto",
    "Enable autoupdate: once a day, adopt the newest release aged >= cooldown (default 7) days, and apply once now.",
  )
  .option("--no-auto", "Disable autoupdate.")
  .option("--auto-status", "Print autoupdate status (enabled, cooldown, last check, last result).")
  .action((opts: Opts) =>
    runSafe(() =>
      runUpdate({
        check: Boolean(opts.check),
        cooldown: resolveCooldown(opts.cooldown, 7),
        force: Boolean(opts.force),
        auto: opts.auto === true,
        noAuto: opts.auto === false,
        autoStatus: Boolean(opts.autoStatus),
      }),
    ),
  );

program
  .command("setup-shell")
  .description("Wire the copilot-env shell integration into your rc files / PowerShell $PROFILE.")
  .option("--remove", "Remove the integration instead of adding it.")
  .option("--all-hosts", "Windows only: target the CurrentUserAllHosts profile.")
  .action((opts: Opts) =>
    runSafe(() =>
      runSetupShell({ remove: Boolean(opts.remove), "all-hosts": Boolean(opts.allHosts) }),
    ),
  );

program
  .command("setup-launchers")
  .description("Wire or remove the opt-in cl / co / cx launchers.")
  .option("--remove", "Remove only the launcher block.")
  .option("--all-hosts", "Windows only: target the CurrentUserAllHosts profile.")
  .action((opts: Opts) =>
    runSafe(() =>
      runSetupLaunchers({ remove: Boolean(opts.remove), "all-hosts": Boolean(opts.allHosts) }),
    ),
  );

program
  .command("setup-clis")
  .description("Install or verify the optional claude / copilot / codex agent CLIs.")
  .option(
    "--cooldown [days]",
    "Install the newest agent-CLI npm releases aged >= DAYS. Bare --cooldown uses 7 days.",
    coerceDays,
  )
  .option("--no-sudo", "Avoid sudo/system package managers; use only user-local tooling.")
  .option("--launchers", "Also wire the opt-in cl / co / cx launchers after CLI setup.")
  .option("--all-hosts", "Windows only: with --launchers, target the CurrentUserAllHosts profile.")
  .option("--no-prereqs", "Verify prerequisites and CLIs only; install nothing.")
  .action((opts: Opts) =>
    runSafe(() =>
      runSetupClis({
        "all-hosts": Boolean(opts.allHosts),
        cooldown: resolveCooldown(opts.cooldown, 7),
        launchers: Boolean(opts.launchers),
        noSudo: opts.sudo === false,
        noPrereqs: opts.prereqs === false,
      }),
    ),
  );

if (import.meta.main) {
  program.parseAsync(process.argv).catch((e: unknown) => {
    consola.error(e instanceof Error ? e.message : String(e));
    // Set exitCode (not process.exit) so pending stderr writes flush.
    process.exitCode = 1;
  });
}
