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
import { runShell } from "./commands/setup.ts";
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
  .helpOption("--help", "Show this help.")
  .option("--full-help", "Print help for `agent` and every subcommand, then exit.");

// `agent --full-help`: dump the top-level help plus each subcommand's help in one
// shot. The option:full-help listener fires during parse — before any "missing
// command" handling — so it works with no subcommand.
program.on("option:full-help", () => {
  const sep = "─".repeat(72);
  const parts = [program.helpInformation()];
  for (const cmd of program.commands) {
    if (cmd.name() === "help") continue;
    parts.push(`${sep}\nagent ${cmd.name()}\n${sep}\n${cmd.helpInformation()}`);
  }
  process.stdout.write(parts.join("\n"));
  process.exit(0);
});

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
  .option("--direct", "Force both agents to GitHub Copilot Direct (no auto-detect probe).")
  .option("--proxy", "Force both agents to the local copilot-api proxy (no auto-detect probe).")
  .option(
    "--gh-token [token]",
    "Provision this GitHub token (stored in state; used for Direct + the proxy) so no `gh` login " +
      "is needed. Bare flag reads $GH_TOKEN/$GITHUB_TOKEN. Implies Direct; the token must be a " +
      "Copilot-enabled GitHub token (a generic PAT won't work).",
  )
  .option(
    "--remove-gh-token",
    "Revert a prior --gh-token: reconfigure both agents to gh Direct and clear the stored token, " +
      "so everything uses the gh CLI / proxy login again.",
  )
  .action((opts: Opts) =>
    runSafe(() =>
      runInit({
        direct: Boolean(opts.direct),
        proxy: Boolean(opts.proxy),
        "gh-token": opts.ghToken as string | boolean | undefined,
        "remove-gh-token": Boolean(opts.removeGhToken),
      }),
    ),
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
  .description(
    "Configure Codex: GitHub Copilot Direct or the local proxy (auto-detects with no flag).",
  )
  .option("--direct", "Force GitHub Copilot Direct (no auto-detect probe).")
  .option("--proxy", "Force the local copilot-api proxy (no auto-detect probe).")
  .option(
    "--check",
    "Report the configured provider and exit — no changes, no probe (0 direct, 2 proxy, 1 other).",
  )
  .option("--host", "(Linux/macOS) Build the per-host CODEX_HOME symlink farm and wire its config.")
  .option("--delete-host", "With --host: remove the per-host CODEX_HOME and stop exporting it.")
  .option("--mobile", "Interactive: pair the Codex desktop app with its phone remote-control flow.")
  .action((opts: Opts) =>
    runSafe(() => {
      const common = { direct: Boolean(opts.direct), proxy: Boolean(opts.proxy) };
      // --mobile is its own interactive flow (toggles config around app pairing).
      if (opts.mobile) {
        return runCodexMobile();
      }
      // --check is read-only: never build/delete the host farm or probe, even when
      // combined with --host/--delete-host. Route it to the check path first.
      if (opts.check) {
        runCodex({ ...common, check: true });
        return;
      }
      // --host (and --delete-host, which only makes sense with it) route to the
      // per-host symlink farm; everything else configures the active CODEX_HOME.
      if (opts.host || opts.deleteHost) {
        runCodexHost({ ...common, delete: Boolean(opts.deleteHost) });
      } else {
        runCodex(common);
      }
    }),
  );

program
  .command("claude")
  .description(
    "Configure Claude Code: GitHub Copilot Direct or the local proxy (auto-detects with no flag).",
  )
  .option("--direct", "Force GitHub Copilot Direct (no auto-detect probe).")
  .option("--proxy", "Force the local copilot-api proxy (no auto-detect probe).")
  .option(
    "--check",
    "Report the configured provider and exit — no changes, no probe (0 direct, 2 proxy, 1 other).",
  )
  .action((opts: Opts) =>
    runSafe(() =>
      runClaude({
        check: Boolean(opts.check),
        direct: Boolean(opts.direct),
        proxy: Boolean(opts.proxy),
      }),
    ),
  );

program
  .command("update")
  .description("Update the copilot-env checkout to the latest GitHub release.")
  .option(
    "--check",
    "Report update status and exit — no changes (0 up to date, 1 update available, 2 no release resolved).",
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
  .option(
    "--auto-status",
    "Report autoupdate status and exit (enabled, cooldown, last check, last result).",
  )
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
  .command("shell")
  .description(
    "Set up the shell environment: wire the copilot-env integration (rc / PowerShell $PROFILE), " +
      "optionally the cl / co / cx launchers and the optional agent CLIs.",
  )
  .option("--clis", "Also install the optional claude / copilot / codex agent CLIs.")
  .option(
    "--cooldown [days]",
    "With --clis: install the newest agent-CLI npm releases aged >= DAYS. Bare --cooldown uses 7 days.",
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
    runSafe(() =>
      runShell({
        remove: Boolean(opts.remove),
        launchers: Boolean(opts.launchers),
        clis: Boolean(opts.clis),
        cooldown: resolveCooldown(opts.cooldown, 7),
        noSudo: opts.sudo === false,
        noPrereqs: opts.prereqs === false,
        "all-hosts": Boolean(opts.allHosts),
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
