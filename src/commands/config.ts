// configTable() is the one table both `agent config` and its `--help` print; the key registry is
// src/copilot_api/env_config.ts.
import { consola } from "consola";
import { anyTrackedDaemonAlive, trackedDaemonAlive } from "../copilot_api/daemon.ts";
import {
  CONFIG_GROUPS,
  CONFIG_REGISTRY,
  configDefaultValue,
  configGroup,
  type ConfigKeyDef,
  configKeyDef,
  type ConfigValueTypes,
  CopilotEnvConfig,
  type CopilotEnvConfigData,
  formatConfigValue,
  isProxyProjected,
  isStoredSource,
  isStoredValueInert,
  profileSettingsKey,
  resolveSettingIn,
  type SettingSource,
  type SettingTarget,
} from "../copilot_api/env_config.ts";
import { assertKnownProfile } from "../copilot_api/env_state.ts";
import { parseProfileFlag, type Profile, profileLabel } from "../copilot_api/profile.ts";
import { nextProxyVersion } from "../proxy_float.ts";
import { bold, COLOR_ENABLED, cyan, dim, green } from "../utils/ansi.ts";
import { assertNever } from "../utils/assert.ts";
import { errMessage } from "../utils/error.ts";
import { versionLessThan } from "../utils/semver.ts";
import { terminalWidth } from "../utils/table.ts";

export interface ConfigArgs {
  /** A Commander variadic; exactly two strings when well-formed. */
  set?: string[];
  get?: string | boolean;
  del?: string;
  /** The profile a profile-scoped key is set, deleted, or read for; absent = the default profile
   *  (and, for a profile-default key, the global value). */
  profile?: string;
}

function unknownKeyError(key: string): Error {
  const keys = CONFIG_REGISTRY.map((d) => d.key).join(", ");
  return new Error(`unknown config key '${key}'. Valid keys: ${keys}`);
}

/** The daemon that reads a projected or launch-time key is the profile's own, so the restart the
 *  hint names is that daemon's. Hints stay shell-neutral (no `&&`) for Windows PowerShell 5.1. */
export function proxyRestartHint(profile: Profile): string {
  const flag = profile === null ? "" : ` --profile ${profile}`;
  return `Applies on the next proxy start; restart it: \`agent stop${flag}\`, then \`agent start${flag}\`.`;
}

/** Shared with `agent settings --import`, whose bundle may touch every profile's knobs. */
export const PROXY_RESTART_HINT_ALL =
  "Applies on the next proxy start; restart the running daemons: `agent stop --all`, then " +
  "`agent start` (add `--profile <name>` for a profile's daemon).";

/** A global-map write (a global key, or a profile-default key's shared value) reaches every daemon
 *  that reads it at launch; a profile section's write reaches that profile's daemon alone. A key's
 *  own applyHint covers its other surfaces; the restart line is the target's, never the hint's. */
function noteHowItApplies(def: ConfigKeyDef, target: SettingTarget): void {
  if (def.applyHint !== undefined) consola.info(def.applyHint);
  if (!isProxyProjected(def) && def.restartToApply !== true) return;
  consola.info(
    target.kind === "global" ? PROXY_RESTART_HINT_ALL : proxyRestartHint(target.profile),
  );
}

/** A projected key the installed proxy is too old to read is a silent no-op until the float catches
 *  up. Null `installed` (a Direct-only setup) warns about nothing: the value applies once a
 *  new-enough proxy arrives. */
export function sinceProxyVersionWarning(
  def: ConfigKeyDef,
  installed: string | null,
): string | null {
  const since = def.sinceProxyVersion;
  if (since === undefined || installed === null) return null;
  if (!versionLessThan(installed, since)) return null;
  return (
    `The installed proxy ${installed} does not read '${def.key}' (added in copilot-api ` +
    `${since}); it applies once the proxy is >= ${since}.`
  );
}

/** `profile` is undefined when no --profile was given: a set/del then lands per the key's scope
 *  (settingTarget), and a get resolves for the default profile. */
export type ConfigAction =
  | { kind: "set"; key: string; value: string; profile: Profile | undefined }
  | { kind: "del"; key: string; profile: Profile | undefined }
  | { kind: "get"; key?: string; profile: Profile };

export function parseConfigAction(args: ConfigArgs): ConfigAction {
  if (args.set !== undefined && args.del !== undefined) {
    throw new Error("--set and --del are mutually exclusive");
  }
  if (args.get !== undefined && (args.set !== undefined || args.del !== undefined)) {
    throw new Error("--get reads a preference and cannot combine with --set/--del");
  }
  // A named profile must exist: a section for a profile the store never created would be a
  // hidden value with no reader.
  const profile = parseProfileFlag(args.profile);
  if (profile !== null) assertKnownProfile(profile);
  const named = args.profile === undefined ? undefined : profile;
  if (args.set !== undefined) {
    const [key, value] = args.set;
    if (args.set.length !== 2 || key === undefined || value === undefined) {
      throw new Error("usage: agent config --set <key> <value>");
    }
    return { kind: "set", key, value, profile: named };
  }
  if (args.del !== undefined) return { kind: "del", key: args.del, profile: named };
  return { kind: "get", key: typeof args.get === "string" ? args.get : undefined, profile };
}

/** `platform` is the POSIX-only key guard's test seam. */
export function runConfig(args: ConfigArgs, platform: NodeJS.Platform = process.platform): void {
  const action = parseConfigAction(args);
  switch (action.kind) {
    case "set":
      runSet(action.key, action.value, action.profile, platform);
      return;
    case "del":
      runDel(action.key, action.profile);
      return;
    case "get":
      runGet(action.key, action.profile, platform);
      return;
    default:
      assertNever(action);
  }
}

/** Where a write landed, for the set/del lines: empty for the global map. */
function targetSuffix(target: SettingTarget): string {
  return target.kind === "global" ? "" : ` (${profileLabel(target.profile)})`;
}

function runSet(
  key: string,
  raw: string,
  profile: Profile | undefined,
  platform: NodeJS.Platform,
): void {
  const def = configKeyDef(key);
  if (def === undefined) throw unknownKeyError(key);
  if (def.posixOnly && platform === "win32") {
    throw new Error(
      `'${def.key}' is only supported on Linux and macOS (this is ${platform}); it cannot be set here.`,
    );
  }
  let value: boolean | number | string;
  try {
    value = def.parse(raw);
  } catch (e) {
    throw new Error(`invalid value for '${def.key}': ${errMessage(e)}`);
  }
  const target = new CopilotEnvConfig().assign(def, value, profile);
  consola.success(`set ${def.key} = ${formatConfigValue(value)}${targetSuffix(target)}`);
  const warning = sinceProxyVersionWarning(def, nextProxyVersion());
  if (warning !== null) consola.warn(warning);
  // The warning supersedes only the generic restart hint (a restart cannot make an old proxy read
  // the key); a bespoke applyHint often covers a non-proxy surface and still applies.
  if (def.applyHint !== undefined || warning === null) noteHowItApplies(def, target);
}

/** `agent start` prints these after projecting for ITS profile, passing the version its resolved
 *  entry runs, so a key set before the first start still gets its warning; callers without a
 *  resolved entry (`--set`, the table, `settings --import`) take the read-only default. */
export function unreadProjectedKeyWarnings(
  envConfig: CopilotEnvConfig = new CopilotEnvConfig(),
  proxyVersion: string | null = nextProxyVersion(),
  profile: Profile = null,
): string[] {
  const data = envConfig.read();
  const warnings: string[] = [];
  for (const def of CONFIG_REGISTRY) {
    if (!isStoredSource(resolveSettingIn(data, def.key, { profile }).source)) continue;
    const warning = sinceProxyVersionWarning(def, proxyVersion);
    if (warning !== null) warnings.push(warning);
  }
  return warnings;
}

function runDel(key: string, profile: Profile | undefined): void {
  const def = configKeyDef(key);
  if (def === undefined) throw unknownKeyError(key);
  const config = new CopilotEnvConfig();
  const target = config.assign(def, null, profile);
  // What the key resolves to NOW, and from where: a deleted profile override may fall back to the
  // global value, not the built-in default.
  const now = config.resolve(def.key, {
    profile: target.kind === "global" ? null : target.profile,
  });
  const reads = now.value === undefined
    ? "unset"
    : `${formatConfigValue(now.value)} (${now.source})`;
  consola.success(`deleted ${def.key}${targetSuffix(target)}; now ${reads}`);
  noteHowItApplies(def, target);
}

function runGet(get: string | undefined, profile: Profile, platform: NodeJS.Platform): void {
  const data = new CopilotEnvConfig().read();

  if (typeof get === "string") {
    // Just the value, for scripts; a blank line when unset. A stored value inert on this platform
    // answers with the built-in default, which is what every read site sees.
    const def = configKeyDef(get);
    if (def === undefined) throw unknownKeyError(get);
    const resolved = resolveSettingIn(data, def.key, { profile });
    const value = isStoredValueInert(def, resolved, platform)
      ? configDefaultValue(def)
      : resolved.value;
    process.stdout.write(value === undefined ? "\n" : `${formatConfigValue(value)}\n`);
    return;
  }

  // Straight to stdout, not consola: consola reformats the backticks in the descriptions, and this
  // must match `agent config --help` byte for byte.
  process.stdout.write(`${configTableOutput(platform, profile)}\n`);
}

/** Below this the right column stops wrapping: a narrower ribbon reads worse than the terminal's
 *  own breaking. */
const MIN_RIGHT_COLUMNS = 30;
/** Indent of a right column stacked under its key row on a narrow terminal. */
const STACKED_INDENT = 6;
/** A group heading and its rows sit one level under the GLOBAL banner; the profile rows sit
 *  directly under theirs. */
const GROUP_INDENT = 2;
/** For a key that is unset AND has no built-in default. */
const UNSET_VALUE = "<unset>";
const RESTART_LINE = "restart the proxy to apply";
const PROFILE_FLAG = "--profile <name>";
/** Between the header's parts, on one line. */
const HEADER_GAP = "  |  ";

/** Never splits an item: one longer than `columns` stands on its own line. The one wrap rule for
 *  the header's parts, the description's words, and the right column's cells alike. */
function packToWidth<T>(
  items: T[],
  length: (item: T) => number,
  columns: number,
  gap = 1,
): T[][] {
  const lines: T[][] = [];
  let current: T[] = [];
  let used = 0;
  for (const item of items) {
    if (current.length > 0 && used + gap + length(item) > columns) {
      lines.push(current);
      current = [];
      used = 0;
    }
    used += (current.length > 0 ? gap : 0) + length(item);
    current.push(item);
  }
  lines.push(current);
  return lines;
}

interface Cell {
  text: string;
  paint: (text: string) => string;
}

export interface ConfigTableOptions {
  platform: NodeJS.Platform;
  width: number;
  /** Whose values the profile-scoped rows show; null is the default profile. */
  profile: Profile;
  /** A stored key a live daemon read at launch earns the restart line: any daemon for a value
   *  from the global map, the selected profile's own daemon for a value from its section. */
  daemonUp: boolean;
  profileDaemonUp: boolean;
  /** A stored projected key the next proxy is too old to read earns no restart line, since no
   *  restart makes it read. Null means the version cannot be known, and then NO row earns the line:
   *  a missing hint is cheaper than a wrong one. */
  proxyVersion: string | null;
  color: boolean;
}

/** A profile-default key is the selected profile's only while its own section sets it. */
function rowBanner(def: ConfigKeyDef, source: SettingSource): "profile" | "global" {
  if (def.scope === "profile") return "profile";
  return def.scope === "profile-default" && source === "profile" ? "profile" : "global";
}

/** The one table `agent config` and `agent config --help` both print: a PROFILE banner for the
 *  selected profile's own keys, a GLOBAL banner for the machine's, grouped by the key's group,
 *  each row resolved for `opts.profile`. Nothing breaks mid-word. */
export function configTable(data: CopilotEnvConfigData, opts: ConfigTableOptions): string {
  const plain = (text: string): string => text;
  const paint = opts.color ? { bold, cyan, dim, green } : {
    bold: plain,
    cyan: plain,
    dim: plain,
    green: plain,
  };
  const rows = CONFIG_REGISTRY.map((def) => {
    const resolved = resolveSettingIn(data, def.key, { profile: opts.profile });
    const stored = isStoredSource(resolved.source);
    const fallback = configDefaultValue(def);
    const value = resolved.value === undefined ? UNSET_VALUE : formatConfigValue(resolved.value);
    const banner = rowBanner(def, resolved.source);
    const indent = banner === "profile" ? 0 : GROUP_INDENT;
    return {
      def,
      resolved,
      stored,
      fallback,
      value,
      banner,
      indent,
      leadLength: indent + 2 + `${def.key}=${value}`.length,
    };
  });
  // The key=value column is the longest lead that still leaves the right column
  // MIN_RIGHT_COLUMNS; a longer one (a URL) gets its own line with its right column below. When
  // none fits, every right column stacks at STACKED_INDENT, and when even that leaves fewer than
  // the floor, wrapping stops altogether.
  const fitting = rows
    .map((row) => row.leadLength)
    .filter((n) => n + 2 + MIN_RIGHT_COLUMNS <= opts.width);
  const column = fitting.length > 0 ? Math.max(...fitting) + 2 : STACKED_INDENT;
  const rightWidth = opts.width - column >= MIN_RIGHT_COLUMNS
    ? opts.width - column
    : Number.POSITIVE_INFINITY;
  const indent = " ".repeat(column);
  /** A lead with its right column beside it when it fits, below it when not. */
  const layout = (lead: string, leadLength: number, right: string[]): string[] => {
    const [first = "", ...rest] = right;
    if (leadLength + 2 > column) return [lead, ...right.map((line) => indent + line)];
    return [
      `${lead}${" ".repeat(column - leadLength)}${first}`,
      ...rest.map((line) => indent + line),
    ];
  };
  const wrapNote = (note: string): string[] =>
    packToWidth(note.split(" "), (word) => word.length, rightWidth)
      .map((words) => paint.dim(words.join(" ")));

  // The global layer a profile override hides: the global map's value, else the built-in default.
  const globalLayer: Partial<ConfigValueTypes> = data.global;
  const renderRow = (row: (typeof rows)[number]): string[] => {
    const { def } = row;
    const cells: Cell[] = [{ text: `[${def.type}]`, paint: plain }];
    if (row.stored && row.fallback !== undefined) {
      cells.push({
        text: `default ${formatConfigValue(row.fallback)}`,
        paint: (text) => paint.dim(paint.green(text)),
      });
    }
    if (def.scope === "profile-default" && row.banner === "profile") {
      const shared = globalLayer[def.key] ?? row.fallback;
      cells.push({
        text: `(overrides global ${
          shared === undefined ? UNSET_VALUE : formatConfigValue(shared)
        })`,
        paint: paint.dim,
      });
    }
    if (isStoredValueInert(def, row.resolved, opts.platform)) {
      cells.push({ text: "(inert on this platform)", paint: paint.dim });
    }
    const right = packToWidth(cells, (cell) => cell.text.length, rightWidth)
      .map((line) => line.map((cell) => cell.paint(cell.text)).join(" "));
    const daemonReads = isProxyProjected(def) || def.restartToApply === true;
    const up = row.resolved.source === "profile" ? opts.profileDaemonUp : opts.daemonUp;
    if (
      row.stored && up && daemonReads && opts.proxyVersion !== null &&
      sinceProxyVersionWarning(def, opts.proxyVersion) === null
    ) {
      right.push(paint.dim(paint.green(RESTART_LINE)));
    }
    right.push(...wrapNote(def.describe));
    const shownValue = row.value === UNSET_VALUE
      ? paint.dim(UNSET_VALUE)
      : row.stored
      ? paint.bold(paint.green(row.value))
      : paint.green(row.value);
    const lead = `${" ".repeat(row.indent)}${row.stored ? paint.green("*") : " "} ${
      paint.cyan(def.key)
    }=${shownValue}`;
    return layout(lead, row.leadLength, right);
  };

  const storedCount = rows.filter((row) => row.stored).length;
  const headerParts = [
    `${storedCount} of ${rows.length} keys set (*).`,
    "agent config --set <key> <value>",
    "--del <key> reverts",
    `${PROFILE_FLAG} targets another profile`,
  ];
  const header = packToWidth(headerParts, (part) => part.length, opts.width, HEADER_GAP.length)
    .map((parts) => paint.dim(parts.join(HEADER_GAP)))
    .join("\n");

  /** A bold title with its note beside it and wrapped there while the note keeps
   *  MIN_RIGHT_COLUMNS; otherwise (a long profile name on a narrow terminal) the note stacks
   *  under the title at STACKED_INDENT, like a row's right column. */
  const banner = (title: string, note: string): string => {
    const beside = title.length + 3;
    const at = opts.width - beside >= MIN_RIGHT_COLUMNS ? beside : STACKED_INDENT;
    const noteWidth = opts.width - at >= MIN_RIGHT_COLUMNS
      ? opts.width - at
      : Number.POSITIVE_INFINITY;
    const lines = packToWidth(`(${note})`.split(" "), (word) => word.length, noteWidth)
      .map((words) => paint.dim(words.join(" ")));
    if (at !== beside) {
      return [paint.bold(title), ...lines.map((l) => " ".repeat(at) + l)].join("\n");
    }
    const [first = "", ...rest] = lines;
    return [`${paint.bold(title)}   ${first}`, ...rest.map((l) => " ".repeat(at) + l)].join("\n");
  };
  const groupIndent = " ".repeat(GROUP_INDENT);

  // The groups the notes name are the ones whose scope admits an override, so a new
  // profile-default group reaches them on its own.
  const ownRows = rows.filter((row) => row.def.scope === "profile");
  const overrides = rows.filter((row) => row.banner === "profile" && row.def.scope !== "profile");
  const overridable = [
    ...new Set(
      CONFIG_REGISTRY.filter((def) => def.scope === "profile-default")
        .map((def) => configGroup(def.key)),
    ),
  ];
  const noOverrides = (): string[] => {
    // Two in: the star slot, so the line sits under the keys.
    const lead = `  ${overridable.join("/")} overrides: none`;
    const note = `a ${overridable.map((g) => `${g}.*`).join(" / ")} key set with ${PROFILE_FLAG} ` +
      "shows here, overriding the global value";
    return layout(paint.dim(lead), lead.length, wrapNote(note));
  };
  const profileBlock = [
    banner(
      `PROFILE ${profileSettingsKey(opts.profile)}`,
      `per profile; another profile: ${PROFILE_FLAG}`,
    ),
    ...ownRows.flatMap(renderRow),
    ...overrides.flatMap(renderRow),
    ...(overrides.length === 0 && overridable.length > 0 ? noOverrides() : []),
  ].join("\n");

  const globalRows = rows.filter((row) => row.banner === "global");
  const groupBlocks = CONFIG_GROUPS.flatMap((group): string[] => {
    const lines = globalRows.filter((row) => configGroup(row.def.key) === group).flatMap(renderRow);
    if (lines.length === 0) return [];
    const heading = overridable.includes(group)
      ? banner(
        `${groupIndent}${group}:`,
        `global default; a profile may override with ${PROFILE_FLAG} --set`,
      )
      : paint.bold(`${groupIndent}${group}:`);
    return [[heading, ...lines].join("\n")];
  });
  const globalBlock = [
    banner("GLOBAL", "this machine, every profile"),
    groupBlocks.join("\n\n"),
  ].join("\n");
  return [header, profileBlock, globalBlock].join("\n\n");
}

/** The one string both `agent config` and `agent config --help` print, so their outputs are
 *  byte-identical. `platform` is the inert note's test seam. */
export function configTableOutput(
  platform: NodeJS.Platform = process.platform,
  profile: Profile = null,
): string {
  return configTable(new CopilotEnvConfig().read(), {
    platform,
    width: terminalWidth() ?? Number.POSITIVE_INFINITY,
    profile,
    daemonUp: anyTrackedDaemonAlive(),
    profileDaemonUp: trackedDaemonAlive(profile),
    proxyVersion: nextProxyVersion(),
    color: COLOR_ENABLED,
  });
}
