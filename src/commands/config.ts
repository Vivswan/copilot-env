// `agent config`: get/set/delete copilot-env preferences (the typed key-value store in
// src/copilot_api/env_config.ts). The CONFIG_REGISTRY there is the single source of truth for
// the keys; this command just parses/validates `--set` values and formats `--get` output.
import { consola } from "consola";
import {
  CONFIG_REGISTRY,
  type ConfigKeyDef,
  CopilotEnvConfig,
  configDefaultLabel,
  configKeyDef,
  isProxyProjected,
} from "../copilot_api/env_config.ts";
import { installedProxyVersion } from "../copilot_api/version.ts";
import { errMessage } from "../utils/error.ts";
import { versionLessThan } from "../utils/semver.ts";
import { formatTable } from "../utils/table.ts";

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

/** The warning for a projected key the installed proxy is too old to read (its
 *  `sinceProxyVersion` postdates `installed`): the projection would be a silent no-op until
 *  the float catches up. Null `installed` (no proxy installed -- e.g. a Direct-only setup)
 *  warns about nothing: the value applies once a new-enough proxy arrives. */
export function sinceProxyVersionWarning(
  def: ConfigKeyDef,
  installed: string | null,
): string | null {
  const since = def.sinceProxyVersion;
  if (since === undefined || installed === null) return null;
  if (!versionLessThan(installed, since)) return null;
  return (
    `The installed proxy ${installed} does not read '${def.cli}' (added in copilot-api ` +
    `${since}); it applies once the proxy is >= ${since}.`
  );
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
  const warning = sinceProxyVersionWarning(def, installedProxyVersion());
  if (warning !== null) consola.warn(warning);
  // The warning supersedes only the GENERIC restart hint (a restart cannot make an old proxy
  // read the key); a bespoke applyHint often covers a non-proxy surface and still applies.
  if (def.applyHint !== undefined || warning === null) noteHowItApplies(def);
}

/** The warnings for every STORED projected key the installed proxy is too old to read: the
 *  projection just wrote values the daemon will ignore. `agent start` prints these after
 *  projecting -- the moment the actual proxy version is known -- so a key set before the
 *  first start (when no proxy existed to compare against) still gets its warning. */
export function unreadProjectedKeyWarnings(
  envConfig: CopilotEnvConfig = new CopilotEnvConfig(),
  installed: string | null = installedProxyVersion(),
): string[] {
  const stored = envConfig.read();
  const warnings: string[] = [];
  for (const def of CONFIG_REGISTRY) {
    if (stored[def.key] === undefined) continue;
    const warning = sinceProxyVersionWarning(def, installed);
    if (warning !== null) warnings.push(warning);
  }
  return warnings;
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
  const rows = CONFIG_REGISTRY.map((def) => {
    const value = data[def.key];
    const shown =
      value === undefined ? `(default: ${configDefaultLabel(def)})` : formatValue(value);
    return [def.cli, shown];
  });
  consola.log(`copilot-env config:\n${formatTable(rows).join("\n")}`);
}
