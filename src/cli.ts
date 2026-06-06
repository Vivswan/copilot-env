import { defineCommand, runMain } from "citty";
import { consola } from "consola";
import { runCodexConfig } from "./commands/codex_config.ts";
import { runCodexHost } from "./commands/codex_host.ts";
import { runEnv } from "./commands/env.ts";
import { runHealth } from "./commands/health.ts";
import { runShellIntegration } from "./commands/shell_integration.ts";
import { runStart } from "./commands/start.ts";
import { runStop } from "./commands/stop.ts";
import { runUpdate } from "./commands/update.ts";
import { runCost } from "./usage/cost.ts";
import { OPENROUTER_MODELS_URL } from "./usage/pricing.ts";

// Thin citty wiring: each subcommand only declares its parameters and calls the
// matching run function from src/commands/* or src/usage/*. bin/agent runs
// `bun install` (in-place, in the checkout) before this, so the install/float is
// not a subcommand here.

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
    name: "codex_config",
    description: "(Re)write the default ~/.codex config.toml/.env wired to the local gateway.",
  },
  args: codexArgs,
  run: ({ args }) => runCodexConfig({ "codex-home": args["codex-home"] as string | undefined }),
});

const setupCodexHost = defineCommand({
  meta: {
    name: "host_codex",
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
      description:
        "Adopt the newest release aged >= --cooldown-days days, not strictly the latest.",
    },
    "cooldown-days": {
      type: "string",
      default: "7",
      description: "Cooldown window in days (with --cooldown). Default 7.",
    },
  },
  run: ({ args }) =>
    runUpdate({
      check: Boolean(args.check),
      cooldown: Boolean(args.cooldown),
      "cooldown-days": String(args["cooldown-days"]),
    }),
});

const shellIntegration = defineCommand({
  meta: {
    name: "shell-integration",
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
    runShellIntegration({ remove: Boolean(args.remove), "all-hosts": Boolean(args["all-hosts"]) }),
});

const cli = defineCommand({
  meta: {
    name: "copilot-api",
    description: "Manage the local copilot-api gateway and Codex wiring.",
  },
  subCommands: {
    start,
    stop,
    health,
    env,
    cost,
    codex_config: setupCodexConfig,
    host_codex: setupCodexHost,
    "shell-integration": shellIntegration,
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
