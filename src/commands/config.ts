// `agent config`: get/set/delete copilot-env preferences (the typed key-value store in
// src/copilot_api/env_config.ts). The CONFIG_REGISTRY there is the single source of truth for
// the keys; configTable() below is the one table both `agent config` and its `--help` print.
import { consola } from "consola";
import { anyTrackedDaemonAlive } from "../copilot_api/daemon.ts";
import {
  CONFIG_REGISTRY,
  CONFIG_SECTIONS,
  configDefaultValue,
  type ConfigKeyDef,
  configKeyDef,
  CopilotEnvConfig,
  type CopilotEnvConfigData,
  formatConfigValue,
  isProxyProjected,
  isStoredValueInert,
} from "../copilot_api/env_config.ts";
import { installedProxyVersion } from "../copilot_api/version.ts";
import { bold, COLOR_ENABLED, cyan, dim, green } from "../utils/ansi.ts";
import { assertNever } from "../utils/assert.ts";
import { errMessage } from "../utils/error.ts";
import { versionLessThan } from "../utils/semver.ts";

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

/** Keys projected into the proxy's config.json -- or read by `agent start`'s launch wiring
 *  (`restartToApply`) -- take effect only when a daemon launches, so a running proxy won't see
 *  the change until it restarts. Nudge the user when that applies. Keys applied through some
 *  other mechanism carry their own `applyHint`. The hints stay shell-neutral (no `&&`) for
 *  Windows PowerShell 5.1. */
/** The generic restart hint for keys a running daemon will not re-read (shared
 *  with `agent settings --import`, which writes such keys in bulk). */
export const PROXY_RESTART_HINT =
  "Applies on the next proxy start; restart it: `agent stop`, then `agent start`.";

function noteHowItApplies(def: ConfigKeyDef): void {
  if (def.applyHint !== undefined) {
    consola.info(def.applyHint);
    return;
  }
  if (!isProxyProjected(def) && def.restartToApply !== true) return;
  consola.info(PROXY_RESTART_HINT);
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

/**
 * What ONE `agent config` invocation does -- exactly one of set, delete, or read
 * (one key or all), parsed ONCE by `parseConfigAction` at the CLI boundary so a
 * conflicting combination (e.g. `--set port 5000 --get`) is rejected instead of
 * one flag being silently dropped.
 */
export type ConfigAction =
  | { kind: "set"; key: string; value: string }
  | { kind: "del"; key: string }
  | { kind: "get"; key?: string };

/** Parse the raw `agent config` flags into a ConfigAction (the CLI boundary). */
export function parseConfigAction(args: ConfigArgs): ConfigAction {
  if (args.set !== undefined && args.del !== undefined) {
    throw new Error("--set and --del are mutually exclusive");
  }
  if (args.get !== undefined && (args.set !== undefined || args.del !== undefined)) {
    throw new Error("--get reads a preference and cannot combine with --set/--del");
  }
  if (args.set !== undefined) {
    const [key, value] = args.set;
    if (args.set.length !== 2 || key === undefined || value === undefined) {
      throw new Error("usage: agent config --set <key> <value>");
    }
    return { kind: "set", key, value };
  }
  if (args.del !== undefined) return { kind: "del", key: args.del };
  // No --set/--del: print one key (`--get <key>`) or all (bare `agent config` / `--get`).
  return { kind: "get", key: typeof args.get === "string" ? args.get : undefined };
}

/** `agent config`: get (default/`--get`), set, or delete one preference. `platform` is
 *  the POSIX-only key guard's test seam. */
export function runConfig(args: ConfigArgs, platform: NodeJS.Platform = process.platform): void {
  const action = parseConfigAction(args);
  switch (action.kind) {
    case "set":
      runSet(action.key, action.value, platform);
      return;
    case "del":
      runDel(action.key);
      return;
    case "get":
      runGet(action.key, platform);
      return;
    default:
      assertNever(action);
  }
}

function runSet(cli: string, raw: string, platform: NodeJS.Platform): void {
  const def = configKeyDef(cli);
  if (def === undefined) throw unknownKeyError(cli);
  if (def.posixOnly && platform === "win32") {
    throw new Error(
      `'${def.cli}' is only supported on Linux and macOS (this is ${platform}); it cannot be set here.`,
    );
  }
  let value: boolean | number | string;
  try {
    value = def.parse(raw);
  } catch (e) {
    throw new Error(`invalid value for '${def.cli}': ${errMessage(e)}`);
  }
  new CopilotEnvConfig().set({ [def.key]: value });
  consola.success(`set ${def.cli} = ${formatConfigValue(value)}`);
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

function runGet(get: string | undefined, platform: NodeJS.Platform): void {
  const data = new CopilotEnvConfig().read();

  if (typeof get === "string") {
    // One key -> print just the value on stdout (script-friendly); blank line when unset.
    // A stored value that is inert on this platform answers with the built-in default,
    // which is what every read site sees.
    const def = configKeyDef(get);
    if (def === undefined) throw unknownKeyError(get);
    const value = isStoredValueInert(def, data, platform) ? configDefaultValue(def) : data[def.key];
    process.stdout.write(value === undefined ? "\n" : `${formatConfigValue(value)}\n`);
    return;
  }

  // All keys -> the same grouped table `agent config --help` prints, with current values.
  // Straight to stdout, not consola: consola reformats the backticks in the descriptions,
  // and the two outputs must match byte for byte.
  process.stdout.write(`${configTableOutput(platform)}\n`);
}

/** The table never spreads wider than this, however wide the terminal. */
const TABLE_WIDTH_MAX = 80;
/** Fewest columns the right column (type, default, description) keeps before the key=value
 *  column stops growing for it (a longer key=value overflows onto its own line) and below
 *  which wrapping stops (a narrower ribbon reads worse than the terminal's own breaking). */
const MIN_RIGHT_COLUMNS = 30;
/** The value cell of a key that is unset AND has no built-in default. */
const UNSET_VALUE = "<unset>";
const RESTART_LINE = "restart the proxy to apply";

/** Pack `items` into lines of at most `columns` characters, one space between items, never
 *  splitting an item: an item longer than `columns` stands on its own line. The one wrap rule
 *  for the description's words and the right column's cells alike. */
function packToWidth<T>(items: T[], length: (item: T) => number, columns: number): T[][] {
  const lines: T[][] = [];
  let current: T[] = [];
  let used = 0;
  for (const item of items) {
    if (current.length > 0 && used + 1 + length(item) > columns) {
      lines.push(current);
      current = [];
      used = 0;
    }
    used += (current.length > 0 ? 1 : 0) + length(item);
    current.push(item);
  }
  lines.push(current);
  return lines;
}

/** One styled cell of the right column's first line(s): `[type]`, `default x`, the inert note. */
interface Cell {
  text: string;
  paint: (text: string) => string;
}

export interface ConfigTableOptions {
  /** Decides which stored values are inert (a POSIX-only key's on Windows). */
  platform: NodeJS.Platform;
  /** Columns the table may use (already capped at TABLE_WIDTH_MAX by the caller). */
  width: number;
  /** A tracked daemon is alive, so a stored key it read at launch earns the restart line. */
  daemonUp: boolean;
  /** The installed proxy's version (null when none): a stored projected key it is too old to
   *  read (sinceProxyVersionWarning) earns no restart line, since no restart makes it read. */
  installedProxy: string | null;
  /** Emit ANSI styling; off yields the same bytes minus the escapes. */
  color: boolean;
}

/** The ONE table `agent config` and `agent config --help` both print. A header counting the
 *  stored keys and naming the set/del syntax; then every key under its section
 *  (CONFIG_SECTIONS order, registry order within) as `key=value` (the stored value, else the
 *  built-in default, else `<unset>`; `* ` marks a stored key) with a right column holding
 *  `[type]` (plus ` default <x>` on a stored key, and the inert note), the restart line when
 *  it applies, and the description wrapped to the width. The key=value column is the longest
 *  key=value that still leaves the right column MIN_RIGHT_COLUMNS; a longer one (a URL) gets
 *  its own line and its right column starts on the next. Nothing breaks mid-word. */
export function configTable(data: CopilotEnvConfigData, opts: ConfigTableOptions): string {
  const plain = (text: string): string => text;
  const paint = opts.color ? { bold, cyan, dim, green } : {
    bold: plain,
    cyan: plain,
    dim: plain,
    green: plain,
  };
  const rows = CONFIG_REGISTRY.map((def) => {
    const stored = data[def.key];
    const fallback = configDefaultValue(def);
    const value = stored !== undefined
      ? formatConfigValue(stored)
      : fallback === undefined
      ? UNSET_VALUE
      : formatConfigValue(fallback);
    return { def, stored: stored !== undefined, fallback, value, keyValue: `${def.cli}=${value}` };
  });
  const lengths = rows.map((row) => row.keyValue.length);
  const fitting = lengths.filter((n) => 2 + n + 2 + MIN_RIGHT_COLUMNS <= opts.width);
  const column = 2 + Math.max(...(fitting.length > 0 ? fitting : lengths)) + 2;
  // Below the floor the right column stops wrapping: everything packs onto one line.
  const rightWidth = Math.max(opts.width - column, MIN_RIGHT_COLUMNS) === opts.width - column
    ? opts.width - column
    : Number.POSITIVE_INFINITY;
  const indent = " ".repeat(column);

  const renderRow = (row: (typeof rows)[number]): string[] => {
    const { def } = row;
    const cells: Cell[] = [{ text: `[${def.type}]`, paint: plain }];
    if (row.stored && row.fallback !== undefined) {
      cells.push({
        text: `default ${formatConfigValue(row.fallback)}`,
        paint: (text) => paint.dim(paint.green(text)),
      });
    }
    if (isStoredValueInert(def, data, opts.platform)) {
      cells.push({ text: "(inert on this platform)", paint: paint.dim });
    }
    const right = packToWidth(cells, (cell) => cell.text.length, rightWidth)
      .map((line) => line.map((cell) => cell.paint(cell.text)).join(" "));
    const daemonReads = isProxyProjected(def) || def.restartToApply === true;
    if (
      row.stored && opts.daemonUp && daemonReads &&
      sinceProxyVersionWarning(def, opts.installedProxy) === null
    ) {
      right.push(paint.dim(paint.green(RESTART_LINE)));
    }
    right.push(
      ...packToWidth(def.describe.split(" "), (word) => word.length, rightWidth)
        .map((words) => paint.dim(words.join(" "))),
    );
    const shownValue = row.value === UNSET_VALUE
      ? paint.dim(UNSET_VALUE)
      : row.stored
      ? paint.bold(paint.green(row.value))
      : paint.green(row.value);
    const lead = `${row.stored ? paint.green("*") : " "} ${paint.cyan(def.cli)}=${shownValue}`;
    const leadLength = 2 + row.keyValue.length;
    const [first = "", ...rest] = right;
    if (leadLength + 2 > column) return [lead, ...right.map((line) => indent + line)];
    return [
      `${lead}${" ".repeat(column - leadLength)}${first}`,
      ...rest.map((line) => indent + line),
    ];
  };

  const storedCount = rows.filter((row) => row.stored).length;
  const header = paint.dim(
    `${storedCount} of ${rows.length} keys set (*).  agent config --set <key> <value>  |  --del <key> reverts`,
  );
  const blocks = CONFIG_SECTIONS.map((section) => {
    const lines = rows.filter((row) => row.def.section === section).flatMap(renderRow);
    return [paint.bold(`${section}:`), ...lines].join("\n");
  });
  return [header, ...blocks].join("\n\n");
}

/** The table for the CURRENT store, terminal, and daemon: the one string both `agent config`
 *  and `agent config --help` print, so their outputs are byte-identical. `platform` is the
 *  POSIX-only inert note's test seam. */
export function configTableOutput(platform: NodeJS.Platform = process.platform): string {
  return configTable(new CopilotEnvConfig().read(), {
    platform,
    // `columns` is undefined off a TTY and 0 on a size-less pty: both mean the cap.
    width: Math.min(process.stdout.columns || TABLE_WIDTH_MAX, TABLE_WIDTH_MAX),
    daemonUp: anyTrackedDaemonAlive(),
    installedProxy: installedProxyVersion(),
    color: COLOR_ENABLED,
  });
}
