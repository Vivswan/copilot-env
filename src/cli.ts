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
import { defineCommand, runMain } from "citty";
import { consola } from "consola";
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
import { packageVersion } from "./utils/version.ts";

// Thin citty wiring: each subcommand only declares its parameters and calls the
// matching domain/command run function. bin/agent runs `bun install` (in-place,
// in the checkout) before this, so the install/float is not a subcommand here.

type CliArgs = Record<string, unknown>;

function boolArg(args: CliArgs, dashed: string, camel = dashed): boolean {
  return Boolean(args[dashed] ?? args[camel]);
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
    description: "Check whether the local gateway is reachable (exit 1 if not).",
  },
  run: () => runHealth(),
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
} as const;

const setupCodexConfig = defineCommand({
  meta: {
    name: "codex-config",
    description: "(Re)write the default ~/.codex config.toml/.env wired to the local gateway.",
  },
  args: codexArgs,
  run: ({ args }) => runCodexConfig({ "codex-home": args["codex-home"] as string | undefined }),
});

const setupCodexHost = defineCommand({
  meta: {
    name: "host-codex",
    description: "Build the per-host CODEX_HOME symlink farm (Linux-only) and wire its config.",
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
  },
  run: ({ args, rawArgs }) =>
    runUpdate({
      check: Boolean(args.check),
      cooldown: optionalDaysArg(rawArgs, "cooldown", 7),
      force: Boolean(args.force),
    }),
});

const setupShell = defineCommand({
  meta: {
    name: "shell",
    description:
      "Wire (or --remove) the copilot-env shell integration into your rc files / PowerShell $PROFILE.",
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
    name: "launchers",
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
    name: "clis",
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

const setup = defineCommand({
  meta: {
    name: "setup",
    description: "Configure optional shell, launcher, and agent-CLI integrations.",
  },
  subCommands: {
    shell: setupShell,
    launchers: setupLaunchers,
    clis: setupClis,
  },
});

const cli = defineCommand({
  meta: {
    name: "copilot-api",
    version: packageVersion(),
    description: "Manage the local copilot-api gateway and Codex wiring.",
  },
  subCommands: {
    start,
    stop,
    health,
    env,
    cost,
    "codex-config": setupCodexConfig,
    "host-codex": setupCodexHost,
    setup,
    update,
  },
});

if (import.meta.main) {
  runMain(cli).catch((e: unknown) => {
    consola.error(e instanceof Error ? e.message : String(e));
    // Set exitCode (not process.exit) so pending stderr writes flush.
    process.exitCode = 1;
  });
}
