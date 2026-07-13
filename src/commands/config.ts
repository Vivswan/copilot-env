// `agent config`: get/set/delete copilot-env preferences (the typed key-value store in
// src/copilot_api/env_config.ts). The CONFIG_REGISTRY there is the single source of truth for
// the keys; this command just parses/validates `--set` values and formats `--get` output.
import { consola } from "consola";
import {
  CONFIG_REGISTRY,
  type ConfigKeyDef,
  CopilotEnvConfig,
  configKeyDef,
  isProxyProjected,
} from "../copilot_api/env_config.ts";
import { errMessage } from "../utils/error.ts";

export interface ConfigArgs {
  /** `--set <key> <value>` (Commander variadic -> exactly two strings). */
  set?: string[];
  /** `--get [key]`: a key string for one value, `true` for all, undefined when not passed. */
  get?: string | boolean;
  /** `--del <key>`: delete the key (revert to its default). */
  del?: string;
}

function unknownKeyError(cli: string): Error {
  const keys = CONFIG_REGISTRY.map((d) => d.cli).join(", ");
  return new Error(`unknown config key '${cli}'. Valid keys: ${keys}`);
}

function formatValue(value: boolean | number | string): string {
  return String(value);
}

/** Keys projected into the proxy's config.json -- or read by `agent start`'s launch wiring
 *  (`restartToApply`) -- take effect only when a daemon launches, so a running proxy won't see
 *  the change until it restarts. Nudge the user when that applies. Keys applied through some
 *  other mechanism carry their own `applyHint`. The hints stay shell-neutral (no `&&`) for
 *  Windows PowerShell 5.1. */
function noteHowItApplies(def: ConfigKeyDef): void {
  if (def.applyHint !== undefined) {
    consola.info(def.applyHint);
    return;
  }
  if (!isProxyProjected(def) && def.restartToApply !== true) return;
  consola.info("Applies on the next proxy start; restart it: `agent stop`, then `agent start`.");
}

/** `agent config`: get (default/`--get`), set, or delete one preference. */
export function runConfig(args: ConfigArgs): void {
  const actions = [args.set !== undefined, args.del !== undefined].filter(Boolean).length;
  if (actions > 1) {
    throw new Error("--set and --del are mutually exclusive");
  }

  if (args.set !== undefined) {
    runSet(args.set);
    return;
  }
  if (args.del !== undefined) {
    runDel(args.del);
    return;
  }
  // No --set/--del: print one key (`--get <key>`) or all (bare `agent config` / `--get`).
  runGet(args.get);
}

function runSet(pair: string[]): void {
  const cli = pair[0];
  const raw = pair[1];
  if (pair.length !== 2 || cli === undefined || raw === undefined) {
    throw new Error("usage: agent config --set <key> <value>");
  }
  const def = configKeyDef(cli);
  if (def === undefined) throw unknownKeyError(cli);
  let value: boolean | number | string;
  try {
    value = def.parse(raw);
  } catch (e) {
    throw new Error(`invalid value for '${def.cli}': ${errMessage(e)}`);
  }
  new CopilotEnvConfig().set({ [def.key]: value });
  consola.success(`set ${def.cli} = ${formatValue(value)}`);
  noteHowItApplies(def);
}

function runDel(cli: string): void {
  const def = configKeyDef(cli);
  if (def === undefined) throw unknownKeyError(cli);
  new CopilotEnvConfig().del(def.key);
  consola.success(`deleted ${def.cli} (reverted to default)`);
  noteHowItApplies(def);
}

function runGet(get: string | boolean | undefined): void {
  const data = new CopilotEnvConfig().read();

  if (typeof get === "string") {
    // One key -> print just the value on stdout (script-friendly); blank line when unset.
    const def = configKeyDef(get);
    if (def === undefined) throw unknownKeyError(get);
    const value = data[def.key];
    process.stdout.write(value === undefined ? "\n" : `${formatValue(value)}\n`);
    return;
  }

  // All keys -> a formatted table (stored value or "(default: <built-in>)").
  const width = CONFIG_REGISTRY.reduce((m, d) => Math.max(m, d.cli.length), 0);
  const rows = CONFIG_REGISTRY.map((def) => {
    const value = data[def.key];
    const shown = value === undefined ? `(default: ${def.defaultLabel})` : formatValue(value);
    return `  ${def.cli.padEnd(width)}  ${shown}`;
  });
  consola.log(`copilot-env config:\n${rows.join("\n")}`);
}
