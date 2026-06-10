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
import { type ArgsDef, type CommandDef, defineCommand, type RunMainOptions, runMain } from "citty";
import { consola } from "consola";
import { runClaude } from "./claude/config.ts";
import { runCodex } from "./codex/config.ts";
import { runCodexHost } from "./codex/host.ts";
import { runEnv } from "./commands/env.ts";
import { runHealth } from "./commands/health.ts";
import { runInit } from "./commands/init.ts";
import { runSetupClis, runSetupLaunchers, runSetupShell } from "./commands/setup.ts";
import { runStart } from "./commands/start.ts";
import { runStop } from "./commands/stop.ts";
import { runUpdate } from "./commands/update.ts";
import { runCost } from "./usage/cost.ts";
import { OPENROUTER_MODELS_URL } from "./usage/pricing.ts";
import { bold, cyan, gray, underline } from "./utils/ansi.ts";
import { disableConsolaTimestamps } from "./utils/logger.ts";
import { packageVersion } from "./utils/version.ts";

// Drop consola's right-aligned wall-clock timestamp from all command output.
disableConsolaTimestamps();

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

const init = defineCommand({
  meta: {
    name: "init",
    description: "Set up both Codex and Claude (auto-detect GitHub Copilot Direct vs the gateway).",
  },
  args: {
    direct: {
      type: "boolean",
      default: false,
      description: "Force both agents to GitHub Copilot Direct (no probe).",
    },
    proxy: {
      type: "boolean",
      default: false,
      description: "Force both agents to the local copilot-api gateway proxy (no probe).",
    },
  },
  run: ({ args }) => runInit({ direct: Boolean(args.direct), proxy: Boolean(args.proxy) }),
});

const start = defineCommand({
  meta: { name: "start", description: "Start copilot-api in the background, detached." },
  args: {
    "dry-run": {
      type: "boolean",
      default: false,
      description: "Print the resolved startup plan without changing gateway runtime state.",
    },
    port: {
      type: "string",
      description:
        "Pin the gateway to this port instead of auto-resolving from the default (fails if it is busy).",
    },
  },
  run: ({ args }) => runStart({ "dry-run": Boolean(args["dry-run"]), port: parsePort(args.port) }),
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
    live: {
      type: "boolean",
      default: false,
      description:
        "Also run a live read-only prompt through Codex/Claude to verify the configured backend end-to-end (codex/claude/full scopes).",
    },
  },
  run: ({ args }) =>
    runHealth({ scope: String(args.scope), json: Boolean(args.json), live: Boolean(args.live) }),
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
    description: "Force the local copilot-api gateway provider (no probe).",
  },
  direct: {
    type: "boolean",
    default: false,
    description: "Force GitHub Copilot Direct (no probe).",
  },
  auto: {
    type: "boolean",
    default: false,
    description:
      "Auto-detect: write direct when a live read-only Copilot Direct probe succeeds, else the gateway proxy.",
  },
} as const;

const codex = defineCommand({
  meta: {
    name: "codex",
    description: "Configure Codex: GitHub Copilot Direct, the local gateway proxy, or auto-detect.",
  },
  args: {
    ...codexArgs,
    check: {
      type: "boolean",
      default: false,
      description:
        "Report the configured Codex provider without changing config or probing: exit 0 direct, 2 proxy, 1 other.",
    },
    host: {
      type: "boolean",
      default: false,
      description: "(Linux/macOS) Build the per-host CODEX_HOME symlink farm and wire its config.",
    },
    "delete-host": {
      type: "boolean",
      default: false,
      description: "With --host: remove the per-host CODEX_HOME dir and stop exporting CODEX_HOME.",
    },
  },
  run: ({ args }) => {
    const common = {
      "codex-home": args["codex-home"] as string | undefined,
      direct: Boolean(args.direct),
      proxy: Boolean(args.proxy),
      auto: Boolean(args.auto),
    };
    // --check is read-only: never build/delete the host farm or probe, even when
    // combined with --host/--delete-host. Route it to the check path first.
    if (args.check) {
      runCodex({ ...common, check: true });
      return;
    }
    // --host (and --delete-host, which only makes sense with it) route to the
    // per-host symlink farm; everything else configures the active CODEX_HOME.
    if (args.host || args["delete-host"]) {
      runCodexHost({ ...common, delete: Boolean(args["delete-host"]) });
    } else {
      runCodex(common);
    }
  },
});

const claude = defineCommand({
  meta: {
    name: "claude",
    description:
      "Configure Claude Code: GitHub Copilot Direct, the local gateway proxy, or auto-detect.",
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
      description: "Force the local copilot-api gateway (no probe).",
    },
    direct: {
      type: "boolean",
      default: false,
      description: "Force GitHub Copilot Direct (no probe).",
    },
    auto: {
      type: "boolean",
      default: false,
      description:
        "Auto-detect: write direct when a live `claude -p` Copilot Direct probe succeeds, else the gateway proxy.",
    },
    check: {
      type: "boolean",
      default: false,
      description:
        "Report the configured Claude provider without changing config or probing: exit 0 direct, 2 proxy, 1 other.",
    },
  },
  run: ({ args }) =>
    runClaude({
      "claude-home": args["claude-home"] as string | undefined,
      check: Boolean(args.check),
      direct: Boolean(args.direct),
      proxy: Boolean(args.proxy),
      auto: Boolean(args.auto),
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

/** Greedy word-wrap to `width` columns (>=1 line, never splits a word). */
function wrapToWidth(text: string, width: number): string[] {
  if (width <= 0 || text === "") return [text];
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line === "") line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines.length > 0 ? lines : [""];
}

/** One arg definition, narrowed to just what the help renderer reads. */
interface RenderableArg {
  type?: string;
  description?: string;
  negativeDescription?: string;
  default?: unknown;
  hidden?: boolean;
}

/**
 * Wrapped two-column option block: cyan name, then the description word-wrapped
 * to the terminal width with continuation lines hanging under the description
 * column. This is what fixes citty's default subcommand help overflowing the
 * terminal and wrapping back to column 0.
 */
function helpColumnsWrapped(
  rows: [string, string][],
  nameWidth: number,
  termWidth: number,
): string {
  const gap = 2;
  const descWidth = Math.max(20, termWidth - 2 - nameWidth - gap);
  const out: string[] = [];
  for (const [name, desc] of rows) {
    const wrapped = wrapToWidth(desc, descWidth);
    out.push(`  ${cyan(name.padEnd(nameWidth))}${" ".repeat(gap)}${wrapped[0] ?? ""}`);
    const indent = " ".repeat(2 + nameWidth + gap);
    for (const cont of wrapped.slice(1)) out.push(`${indent}${cont}`);
  }
  return out.join("\n");
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
  const termWidth = helpTermWidth();
  const version = meta.version ? ` v${meta.version}` : "";
  return [
    gray(`${meta.description ?? ""} (${name}${version})`),
    "",
    underline(bold("COMMANDS")),
    "",
    helpColumnsWrapped(commandRows, width, termWidth),
    "",
    underline(bold("OPTIONS")),
    "",
    helpColumnsWrapped(optionRows, width, termWidth),
    "",
    `Use ${cyan(`${name} <command> --help`)} for more information about a command.`,
  ].join("\n");
}

/** Terminal width to wrap help to, clamped to a sane range when undetectable. */
function helpTermWidth(): number {
  const cols = process.stdout.columns ?? 0;
  return cols >= 40 ? Math.min(cols, 120) : 100;
}

/**
 * Wrapped per-subcommand help (`agent codex --help`). Replaces citty's default
 * renderer, which leaves long option descriptions overflowing the terminal.
 */
async function renderSubUsage<T extends ArgsDef, P extends ArgsDef>(
  cmd: CommandDef<T>,
  parent: CommandDef<P>,
): Promise<string> {
  const meta = await resolveValue(cmd.meta ?? {});
  const parentMeta = await resolveValue(parent.meta ?? {});
  const name = [parentMeta.name, meta.name].filter(Boolean).join(" ") || "agent";
  const args = (await resolveValue(cmd.args ?? {})) as Record<string, RenderableArg>;

  const rows: [string, string][] = [];
  for (const [key, def] of Object.entries(args)) {
    if (!def || def.hidden) continue;
    const valueHint = def.type === "string" ? `=<${key.replace(/-/g, "_")}>` : "";
    let desc = def.description ?? "";
    // Show a default only when it's meaningful — the common boolean `false`
    // default is noise, so it's omitted.
    if (def.default !== undefined && def.default !== false && def.default !== "") {
      desc += ` (default: ${String(def.default)})`;
    }
    rows.push([`--${key}${valueHint}`, desc.trim()]);
    // citty supports a `--no-<key>` negation; surface it so the disable path
    // (e.g. `--no-prereqs`) is discoverable instead of being a hidden runtime flag.
    if (def.negativeDescription) {
      rows.push([`--no-${key}`, def.negativeDescription]);
    }
  }
  rows.push(["--help", "Show this help."]);

  const nameWidth = Math.min(Math.max(...rows.map(([n]) => n.length)), 30);
  const version = parentMeta.version ? ` v${parentMeta.version}` : "";
  return [
    gray(`${meta.description ?? ""} (${name}${version})`),
    "",
    `${underline(bold("USAGE"))} ${cyan(`${name} [OPTIONS]`)}`,
    "",
    underline(bold("OPTIONS")),
    "",
    helpColumnsWrapped(rows, nameWidth, helpTermWidth()),
  ].join("\n");
}

// Root help (no parent) gets the command table; subcommand help gets the wrapped
// option block — both replace citty's default renderer so nothing overflows.
const showUsage: RunMainOptions["showUsage"] = async (cmd, parent) => {
  const usage = parent ? await renderSubUsage(cmd, parent) : await renderRootUsage(cmd);
  console.log(`${usage}\n`);
};

const cli = defineCommand({
  meta: {
    name: "agent",
    version: packageVersion(),
    description: "Manage the local copilot-api gateway and Codex wiring.",
  },
  subCommands: {
    init: safe(init),
    start: safe(start),
    stop: safe(stop),
    health: safe(health),
    env: safe(env),
    cost: safe(cost),
    update: safe(update),
    codex: safe(codex),
    claude: safe(claude),
    "setup-shell": safe(setupShell),
    "setup-launchers": safe(setupLaunchers),
    "setup-clis": safe(setupClis),
  },
});

if (import.meta.main) {
  runMain(cli, { showUsage }).catch((e: unknown) => {
    consola.error(e instanceof Error ? e.message : String(e));
    // Set exitCode (not process.exit) so pending stderr writes flush.
    process.exitCode = 1;
  });
}
