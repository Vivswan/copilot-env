// CLI entrypoint: declares citty commands and delegates behavior to command modules.
//
// Direct run:
//   bun src/cli.ts <command> [args]
//
// This is the implementation behind bin/agent and bin/agent.ps1. The launchers
// normally run this after ensuring Bun/deps are present; direct runs are useful
// for tests and local command debugging. Run `bun src/cli.ts --help` for the
// command tree and per-command arguments.
import "./utils/dotenv.ts";
import {
  type ArgsDef,
  type CommandDef,
  defineCommand,
  type RunMainOptions,
  renderUsage,
  runMain,
} from "citty";
import { consola } from "consola";
import { runClaudeConfig } from "./claude/config.ts";
import { runCodexConfig } from "./codex/config.ts";
import { runCodexHost } from "./codex/host.ts";
import { runEnv } from "./commands/env.ts";
import { runHealth } from "./commands/health.ts";
import { runSetupClis, runSetupLaunchers, runSetupShell } from "./commands/setup.ts";
import { runStart } from "./commands/start.ts";
import { runStop } from "./commands/stop.ts";
import { runUpdate } from "./commands/update.ts";
import { runCost } from "./usage/cost.ts";
import { OPENROUTER_MODELS_URL } from "./usage/pricing.ts";
import { bold, cyan, gray, underline } from "./utils/ansi.ts";
import { packageVersion } from "./utils/version.ts";

// Thin citty wiring: each subcommand only declares its parameters and calls the
// matching domain/command run function. bin/agent runs `bun install` (in-place,
// in the checkout) before this, so the install/float is not a subcommand here.

type CliArgs = Record<string, unknown>;

function boolArg(args: CliArgs, dashed: string, camel = dashed): boolean {
  return Boolean(args[dashed] ?? args[camel]);
}

/**
 * Run a command action, rendering any thrown Error as a friendly one-line
 * message (no stack trace) with a non-zero exit code. citty's runMain prints
 * raw Errors with a code-frame and process.exit(1)s before the outer .catch
 * below can run, so we intercept here — inside cmd.run — before citty ever sees
 * the throw. An unexpected platform/arg/IO failure thus reads as `✖ <message>`
 * instead of dumping a Bun stack frame at the user.
 */
async function runSafe(action: () => void | Promise<void>): Promise<void> {
  try {
    await action();
  } catch (e) {
    consola.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}

/** Wrap a command's `run` with runSafe in place, preserving its arg types. */
function safe<T extends ArgsDef>(cmd: CommandDef<T>): CommandDef<T> {
  const orig = cmd.run;
  if (typeof orig === "function") {
    cmd.run = (ctx) => runSafe(() => orig(ctx));
  }
  return cmd;
}

function parseNonNegativeDays(raw: string, flag: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${flag} expects a non-negative whole number of days (got '${raw}')`);
  }
  return Number.parseInt(raw, 10);
}

function optionalDaysArg(rawArgs: string[], name: string, defaultDays: number): number | null {
  const flag = `--${name}`;
  let days: number | null = null;

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === undefined) continue;
    if (arg === `--no-${name}`) {
      days = null;
      continue;
    }
    if (arg === flag) {
      const next = rawArgs[i + 1];
      if (next !== undefined && (!next.startsWith("-") || /^-\d/.test(next))) {
        days = parseNonNegativeDays(next, flag);
        i++;
      } else {
        days = defaultDays;
      }
      continue;
    }
    if (arg.startsWith(`${flag}=`)) {
      const raw = arg.slice(flag.length + 1);
      days = parseNonNegativeDays(raw, flag);
    }
  }

  return days;
}

const start = defineCommand({
  meta: { name: "start", description: "Start copilot-api in the background, detached." },
  args: {
    "dry-run": {
      type: "boolean",
      default: false,
      description: "Print the resolved startup plan without changing gateway runtime state.",
    },
  },
  run: ({ args }) => runStart({ "dry-run": Boolean(args["dry-run"]) }),
});

const stop = defineCommand({
  meta: { name: "stop", description: "Stop the copilot-api server on this host." },
  run: () => runStop(),
});

const health = defineCommand({
  meta: {
    name: "health",
    description: "Diagnose the local gateway and setup (exit 1 on any failure).",
  },
  args: {
    scope: {
      type: "string",
      default: "full",
      description:
        "Checks to run: full (default; whole environment) | runtime (fast gateway " +
        "readiness probe) | gateway (bootstrap + gateway + runtime) | setup (shell, " +
        "CLIs, Codex, Claude) | codex (Codex wiring only) | claude (Claude wiring only).",
    },
    json: {
      type: "boolean",
      default: false,
      description: "Emit a JSON report instead of the formatted text report.",
    },
  },
  run: ({ args }) => runHealth({ scope: String(args.scope), json: Boolean(args.json) }),
});

const env = defineCommand({
  meta: {
    name: "env",
    description: "Print env assignments for copilot-api, evaluated by the calling shell.",
  },
  args: {
    format: {
      type: "string",
      default: "posix",
      description:
        "Output syntax: 'posix' (default; `export KEY=VALUE`, eval-able by sh/bash/zsh) " +
        "or 'powershell' (`$env:KEY = '...'`, Invoke-Expression-able by PowerShell).",
    },
  },
  run: ({ args }) => {
    runEnv({ format: String(args.format) });
  },
});

const cost = defineCommand({
  meta: {
    name: "cost",
    description: "Aggregate token usage across all per-host SQLite DBs and estimate cost.",
  },
  args: {
    days: {
      type: "string",
      description: "Only include usage from the last N days (default: all).",
    },
    json: { type: "boolean", description: "Emit a JSON object instead of a formatted report." },
    "pricing-url": {
      type: "string",
      description: "OpenRouter models API URL for live pricing.",
      default: OPENROUTER_MODELS_URL,
    },
  },
  run: ({ args }) =>
    runCost({
      days: args.days as string | undefined,
      json: Boolean(args.json),
      "pricing-url": String(args["pricing-url"]),
    }),
});

const codexArgs = {
  "codex-home": {
    type: "string",
    description:
      "CODEX_HOME path to operate on. Default: ~/.codex (%USERPROFILE%\\.codex on Windows).",
  },
  proxy: {
    type: "boolean",
    default: false,
    description:
      "Write Codex config for the local copilot-api proxy instead of GitHub Copilot Direct.",
  },
  direct: {
    type: "boolean",
    default: false,
    description: "Write Codex config for GitHub Copilot Direct, overwriting proxy/custom wiring.",
  },
} as const;

const setupCodexConfig = defineCommand({
  meta: {
    name: "setup-codex-config",
    description: "Update the default ~/.codex config.toml for GitHub Copilot Direct.",
  },
  args: {
    ...codexArgs,
    check: {
      type: "boolean",
      default: false,
      description:
        "Check the effective Codex provider without changing config: exit 0 direct, 2 proxy, 1 other/error.",
    },
  },
  run: ({ args }) =>
    runCodexConfig({
      "codex-home": args["codex-home"] as string | undefined,
      check: Boolean(args.check),
      direct: Boolean(args.direct),
      proxy: Boolean(args.proxy),
    }),
});

const setupClaudeConfig = defineCommand({
  meta: {
    name: "setup-claude-config",
    description: "Wire ~/.claude/settings.json for GitHub Copilot Direct (or the gateway proxy).",
  },
  args: {
    "claude-home": {
      type: "string",
      description:
        "Claude home to operate on. Default: $CLAUDE_CONFIG_DIR, else ~/.claude " +
        "(%USERPROFILE%\\.claude on Windows).",
    },
    proxy: {
      type: "boolean",
      default: false,
      description: "Remove the managed direct wiring so Claude uses the local copilot-api gateway.",
    },
    direct: {
      type: "boolean",
      default: false,
      description:
        "Write GitHub Copilot Direct wiring (managed apiKeyHelper + ANTHROPIC_BASE_URL).",
    },
    check: {
      type: "boolean",
      default: false,
      description:
        "Check the effective Claude provider without changing config: exit 0 direct, 2 proxy, 1 other/error.",
    },
  },
  run: ({ args }) =>
    runClaudeConfig({
      "claude-home": args["claude-home"] as string | undefined,
      check: Boolean(args.check),
      direct: Boolean(args.direct),
      proxy: Boolean(args.proxy),
    }),
});

const setupCodexHost = defineCommand({
  meta: {
    name: "setup-codex-host",
    description: "(Linux/macOS) Build the per-host CODEX_HOME symlink farm and wire its config.",
  },
  args: {
    ...codexArgs,
    delete: {
      type: "boolean",
      default: false,
      description: "Remove the per-host CODEX_HOME dir and stop exporting CODEX_HOME.",
    },
  },
  run: ({ args }) =>
    runCodexHost({
      "codex-home": args["codex-home"] as string | undefined,
      delete: Boolean(args.delete),
      direct: Boolean(args.direct),
      proxy: Boolean(args.proxy),
    }),
});

const update = defineCommand({
  meta: {
    name: "update",
    description: "Update the copilot-env checkout to the latest GitHub release.",
  },
  args: {
    check: {
      type: "boolean",
      default: false,
      description:
        "Only report status, make no changes. Exit 0 = up to date, 1 = update available, 2 = no release resolved.",
    },
    cooldown: {
      type: "boolean",
      default: false,
      description: "Adopt the newest release aged >= DAYS. Bare --cooldown uses 7 days.",
    },
    force: {
      type: "boolean",
      default: false,
      description:
        "Update even when this is a git checkout (.git present); the sync overwrites local files.",
    },
    auto: {
      type: "boolean",
      description:
        "Enable autoupdate: once a day, adopt the newest release aged >= cooldown (default 7) days, and apply once now. Use --no-auto to disable.",
    },
    "auto-status": {
      type: "boolean",
      default: false,
      description: "Print autoupdate status (enabled, cooldown, last check, last result).",
    },
  },
  run: ({ args, rawArgs }) =>
    runUpdate({
      check: Boolean(args.check),
      cooldown: optionalDaysArg(rawArgs, "cooldown", 7),
      force: Boolean(args.force),
      auto: rawArgs.includes("--auto"),
      noAuto: rawArgs.includes("--no-auto"),
      autoStatus: Boolean(args["auto-status"]) || rawArgs.includes("--auto-status"),
    }),
});

const setupShell = defineCommand({
  meta: {
    name: "setup-shell",
    description: "Wire the copilot-env shell integration into your rc files / PowerShell $PROFILE.",
  },
  args: {
    remove: {
      type: "boolean",
      default: false,
      description: "Remove the integration instead of adding it.",
    },
    "all-hosts": {
      type: "boolean",
      default: false,
      description: "Windows only: target the CurrentUserAllHosts profile.",
    },
  },
  run: ({ args }) =>
    runSetupShell({
      remove: boolArg(args, "remove"),
      "all-hosts": boolArg(args, "all-hosts", "allHosts"),
    }),
});

const setupLaunchers = defineCommand({
  meta: {
    name: "setup-launchers",
    description: "Wire or remove the opt-in cl / co / cx launchers.",
  },
  args: {
    remove: {
      type: "boolean",
      default: false,
      description: "Remove only the launcher block.",
    },
    "all-hosts": {
      type: "boolean",
      default: false,
      description: "Windows only: target the CurrentUserAllHosts profile.",
    },
  },
  run: ({ args }) =>
    runSetupLaunchers({
      remove: boolArg(args, "remove"),
      "all-hosts": boolArg(args, "all-hosts", "allHosts"),
    }),
});

const setupClis = defineCommand({
  meta: {
    name: "setup-clis",
    description: "Install or verify the optional claude / copilot / codex agent CLIs.",
  },
  args: {
    cooldown: {
      type: "boolean",
      default: false,
      description:
        "Install the newest agent-CLI npm releases aged >= DAYS. Bare --cooldown uses 7 days.",
    },
    "no-sudo": {
      type: "boolean",
      default: false,
      description: "Avoid sudo/system package managers; use only user-local tooling.",
    },
    launchers: {
      type: "boolean",
      default: false,
      description: "Also wire the opt-in cl / co / cx launchers after CLI setup.",
    },
    "all-hosts": {
      type: "boolean",
      default: false,
      description: "Windows only: with --launchers, target the CurrentUserAllHosts profile.",
    },
    prereqs: {
      type: "boolean",
      default: true,
      description: "Install missing prerequisites before installing agent CLIs.",
      negativeDescription: "Verify prerequisites and CLIs only; install nothing.",
    },
  },
  run: ({ args, rawArgs }) => {
    runSetupClis({
      "all-hosts": boolArg(args, "all-hosts", "allHosts"),
      cooldown: optionalDaysArg(rawArgs, "cooldown", 7),
      launchers: boolArg(args, "launchers"),
      noSudo: boolArg(args, "no-sudo", "noSudo"),
      noPrereqs: args.prereqs === false || boolArg(args, "no-prereqs", "noPrereqs"),
    });
  },
});

// --- help rendering --------------------------------------------------------
// The root `agent --help` gets a hand-rolled, left-aligned command table that
// drops citty's auto `USAGE agent a|b|c ...` line and surfaces the global
// --version / --help flags. Per-subcommand help (`agent start --help`) still
// uses citty's renderer. ANSI styling is shared with the health report (see
// utils/ansi.ts) and mirrors citty's own so the two help screens look identical.

async function resolveValue<T>(value: T | Promise<T> | (() => T | Promise<T>)): Promise<T> {
  return typeof value === "function" ? await (value as () => T | Promise<T>)() : await value;
}

// Two-column block: cyan name padded to the widest name, then its description.
function helpColumns(rows: [string, string][], width: number): string {
  return rows.map(([name, desc]) => `  ${cyan(name.padEnd(width))}  ${desc}`).join("\n");
}

async function renderRootUsage<T extends ArgsDef>(cmd: CommandDef<T>): Promise<string> {
  const meta = await resolveValue(cmd.meta ?? {});
  const name = meta.name ?? "agent";
  const subCommands = await resolveValue(cmd.subCommands ?? {});

  const commandRows: [string, string][] = [];
  for (const [key, sub] of Object.entries(subCommands)) {
    const subMeta = await resolveValue((await resolveValue(sub)).meta ?? {});
    if (subMeta.hidden) continue;
    commandRows.push([key, subMeta.description ?? ""]);
  }
  const optionRows: [string, string][] = [
    ["--version", "Print the version and exit."],
    ["--help", `Show this help (or \`${name} <command> --help\`).`],
  ];

  const width = Math.max(...[...commandRows, ...optionRows].map(([n]) => n.length));
  const version = meta.version ? ` v${meta.version}` : "";
  return [
    gray(`${meta.description ?? ""} (${name}${version})`),
    "",
    underline(bold("COMMANDS")),
    "",
    helpColumns(commandRows, width),
    "",
    underline(bold("OPTIONS")),
    "",
    helpColumns(optionRows, width),
    "",
    `Use ${cyan(`${name} <command> --help`)} for more information about a command.`,
  ].join("\n");
}

// Root help (no parent) gets the custom table; subcommand help keeps citty's.
const showUsage: RunMainOptions["showUsage"] = async (cmd, parent) => {
  const usage = parent ? await renderUsage(cmd, parent) : await renderRootUsage(cmd);
  console.log(`${usage}\n`);
};

const cli = defineCommand({
  meta: {
    name: "agent",
    version: packageVersion(),
    description: "Manage the local copilot-api gateway and Codex wiring.",
  },
  subCommands: {
    start: safe(start),
    stop: safe(stop),
    health: safe(health),
    env: safe(env),
    cost: safe(cost),
    update: safe(update),
    "setup-shell": safe(setupShell),
    "setup-launchers": safe(setupLaunchers),
    "setup-clis": safe(setupClis),
    "setup-codex-config": safe(setupCodexConfig),
    "setup-codex-host": safe(setupCodexHost),
    "setup-claude-config": safe(setupClaudeConfig),
  },
});

if (import.meta.main) {
  runMain(cli, { showUsage }).catch((e: unknown) => {
    consola.error(e instanceof Error ? e.message : String(e));
    // Set exitCode (not process.exit) so pending stderr writes flush.
    process.exitCode = 1;
  });
}
