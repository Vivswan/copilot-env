// configTable() is the one table both `agent config` and its `--help` print; the key registry is
// src/copilot_api/env_config.ts.
import { consola } from "consola";
import { anyTrackedDaemonAlive, trackedDaemonAlive } from "../copilot_api/daemon.ts";
import {
  CONFIG_GROUPS,
  CONFIG_REGISTRY,
  configDefaultValue,
  type ConfigGroup,
  configGroup,
  type ConfigKeyDef,
  configKeyDef,
  type ConfigScope,
  type ConfigValueTypes,
  CopilotEnvConfig,
  type CopilotEnvConfigData,
  formatConfigValue,
  isProxyProjected,
  isStoredSource,
  isStoredValueInert,
  profileSettingsKey,
  resolveSettingIn,
  type SettingTarget,
} from "../copilot_api/env_config.ts";
import {
  assertKnownProfile,
  GLOBAL_STATE_KEYS,
  PROFILE_STATE_KEYS,
} from "../copilot_api/env_state.ts";
import { LEDGER_KEY_NAMES } from "../copilot_api/ownership.ts";
import { type Profile, profileLabel } from "../copilot_api/profile.ts";
import { nextProxyVersion } from "../proxy_float.ts";
import { COLOR_ENABLED, paintFor } from "../utils/ansi.ts";
import { assertNever } from "../utils/assert.ts";
import { errMessage } from "../utils/error.ts";
import { versionLessThan } from "../utils/semver.ts";
import { terminalWidth, wrapMessage } from "../utils/table.ts";
import stringWidth from "string-width";
import { runDryRun } from "./dry_run.ts";

export interface ConfigArgs {
  /** A Commander variadic; exactly two strings when well-formed. */
  set?: string[];
  get?: string | boolean;
  del?: string;
  /** The profile a profile-scoped key is set, deleted, or read for; null is the default profile,
   *  whose profile-default keys (proxy.*, probe.*) are the shared default in the global map. */
  profile: Profile;
  /** With --set/--del: print the store key the write would change, old -> new, and write nothing. */
  dryRun?: boolean;
}

/** The state keys sharing the store's maps with the settings, each with the commands that write
 *  it. The spellings are the schemas' own (derived there), so a renamed key cannot leave this list
 *  stale. */
const STATE_KEY_OWNERS: ReadonlyArray<readonly [readonly string[], string]> = [
  [
    PROFILE_STATE_KEYS,
    "`agent auth`, `agent profile`, and the wiring commands (the profile's slot)",
  ],
  [GLOBAL_STATE_KEYS, "the Codex catalog sync and the Claude model discovery"],
  [LEDGER_KEY_NAMES, "the wiring commands (their claims on the files they wrote)"],
  [["ownership"], "the wiring commands (their claims on the files they wrote)"],
];

/** `agent config` writes settings only: a state key (spelled bare, or as a path into the file such
 *  as `profiles.default.githubToken`) is refused with its owner, never written or deleted here. */
function refuseStateKey(key: string): void {
  const leaf = key.split(".").at(-1) ?? key;
  const owner = STATE_KEY_OWNERS.find(([keys]) => keys.includes(leaf))?.[1];
  if (owner === undefined) return;
  throw new Error(
    `'${key}' is state written by ${owner}; the \`agent config\` command sets preferences only ` +
      "(its --help lists them)",
  );
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

/** A set/del lands per the key's scope for `profile` (settingTarget); a get resolves for it. */
export type ConfigAction =
  | { kind: "set"; key: string; value: string; profile: Profile }
  | { kind: "del"; key: string; profile: Profile }
  | { kind: "get"; key?: string; profile: Profile };

export function parseConfigAction(args: ConfigArgs): ConfigAction {
  if (args.set !== undefined && args.del !== undefined) {
    throw new Error("--set and --del are mutually exclusive");
  }
  if (args.get !== undefined && (args.set !== undefined || args.del !== undefined)) {
    throw new Error("--get reads a preference and cannot combine with --set/--del");
  }
  if (args.dryRun && args.set === undefined && args.del === undefined) {
    throw new Error("--dry-run previews a write (--set or --del); a read has nothing to preview");
  }
  // A named profile must exist: a section for a profile the store never created would be a
  // hidden value with no reader.
  const profile = args.profile;
  if (profile !== null) assertKnownProfile(profile);
  if (args.set !== undefined) {
    const [key, value] = args.set;
    if (args.set.length !== 2 || key === undefined || value === undefined) {
      throw new Error("usage: agent config --set <key> <value>");
    }
    return { kind: "set", key, value, profile };
  }
  if (args.del !== undefined) return { kind: "del", key: args.del, profile };
  return { kind: "get", key: typeof args.get === "string" ? args.get : undefined, profile };
}

/** `platform` is the POSIX-only key guard's test seam. Synchronous unless it is a dry run (the
 *  plan print awaits the recording), so a flag error still throws at the call. A write handler
 *  returns what to say once it landed; a dry run prints the plan in its place. */
export function runConfig(
  args: ConfigArgs,
  platform: NodeJS.Platform = process.platform,
): void | Promise<void> {
  const action = parseConfigAction(args);
  const run = (): () => void => {
    switch (action.kind) {
      case "set":
        return runSet(action.key, action.value, action.profile, platform);
      case "del":
        return runDel(action.key, action.profile);
      case "get":
        runGet(action.key, action.profile, platform);
        return () => {};
      default:
        return assertNever(action);
    }
  };
  if (args.dryRun) return runDryRun(() => Promise.resolve(run()));
  run()();
}

/** Where a write landed, for the set/del lines: empty for the global map. */
function targetSuffix(target: SettingTarget): string {
  return target.kind === "global" ? "" : ` (${profileLabel(target.profile)})`;
}

function runSet(
  key: string,
  raw: string,
  profile: Profile,
  platform: NodeJS.Platform,
): () => void {
  refuseStateKey(key);
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
  return () => {
    consola.success(`set ${def.key} = ${formatConfigValue(value)}${targetSuffix(target)}`);
    const warning = sinceProxyVersionWarning(def, nextProxyVersion());
    if (warning !== null) consola.warn(warning);
    // The warning supersedes only the generic restart hint (a restart cannot make an old proxy read
    // the key); a bespoke applyHint often covers a non-proxy surface and still applies.
    if (def.applyHint !== undefined || warning === null) noteHowItApplies(def, target);
  };
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

function runDel(key: string, profile: Profile): () => void {
  refuseStateKey(key);
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
  return () => {
    consola.success(`deleted ${def.key}${targetSuffix(target)}; now ${reads}`);
    noteHowItApplies(def, target);
  };
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

/** A lead that leaves the right column fewer than this goes on its own line instead. */
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

/** The one table `agent config` and `agent config --help` both print: a PROFILE banner for every
 *  key the selected profile's daemon and wiring consume (its own keys, then the profile-default
 *  groups resolved for it), a GLOBAL banner for the machine's keys, grouped by the key's group.
 *  Prose breaks between words; a value wider than its column (a URL) splits at the edge. */
export function configTable(data: CopilotEnvConfigData, opts: ConfigTableOptions): string {
  const plain = (text: string): string => text;
  const paint = paintFor(opts.color);
  const rows = CONFIG_REGISTRY.map((def) => {
    const resolved = resolveSettingIn(data, def.key, { profile: opts.profile });
    const stored = isStoredSource(resolved.source);
    const fallback = configDefaultValue(def);
    const value = resolved.value === undefined ? UNSET_VALUE : formatConfigValue(resolved.value);
    const indent = def.scope === "profile" ? 0 : GROUP_INDENT;
    return {
      def,
      resolved,
      stored,
      fallback,
      value,
      indent,
      leadLength: indent + 2 + stringWidth(`${def.key}=${value}`),
    };
  });
  // The key=value column is the longest lead that still leaves the right column
  // MIN_RIGHT_COLUMNS; a longer one (a URL) gets its own line, split at the width when it is
  // wider still, with its right column below. When none fits, every right column stacks at
  // STACKED_INDENT and takes what is left of the width.
  const fitting = rows
    .map((row) => row.leadLength)
    .filter((n) => n + 2 + MIN_RIGHT_COLUMNS <= opts.width);
  const column = fitting.length > 0 ? Math.max(...fitting) + 2 : STACKED_INDENT;
  const rightWidth = Math.max(opts.width - column, 1);
  const indent = " ".repeat(column);
  const fit = (text: string, width: number): string[] =>
    wrapMessage(text, Number.isFinite(width) ? width : null).split("\n");
  /** A lead with its right column beside it when it fits, below it when not; a cell wider than
   *  the right column (a URL) splits at its edge. */
  const layout = (lead: string, leadLength: number, right: string[]): string[] => {
    const [first = "", ...rest] = right.flatMap((line) => fit(line, rightWidth));
    if (leadLength + 2 > column) {
      return [...fit(lead, opts.width), ...[first, ...rest].map((line) => indent + line)];
    }
    return [
      `${lead}${" ".repeat(column - leadLength)}${first}`,
      ...rest.map((line) => indent + line),
    ];
  };
  const wrapNote = (note: string): string[] =>
    packToWidth(note.split(" "), stringWidth, rightWidth)
      .map((words) => paint.dim(words.join(" ")));

  // The global layer a profile override hides: the global map's value, else the built-in default.
  const globalLayer: Partial<ConfigValueTypes> = data.global;
  const renderRow = (row: (typeof rows)[number]): string[] => {
    const { def } = row;
    const cells: Cell[] = [{ text: `[${def.type}]`, paint: plain }];
    // A profile-default row names where its value came from: the global map (`(global)`), or its
    // own section, which then names the layer it hides once: the global map's value, or the
    // built-in default in place of the `default` cell.
    const inherits = def.scope === "profile-default";
    const overrides = inherits && row.resolved.source === "profile";
    const shared = inherits ? globalLayer[def.key] : undefined;
    if (row.stored && row.fallback !== undefined && !(overrides && shared === undefined)) {
      cells.push({
        text: `default ${formatConfigValue(row.fallback)}`,
        paint: (text) => paint.dim(paint.green(text)),
      });
    }
    if (overrides) {
      cells.push({
        text: shared !== undefined
          ? `(overrides global ${formatConfigValue(shared)})`
          : `(overrides the default ${
            row.fallback === undefined ? UNSET_VALUE : formatConfigValue(row.fallback)
          })`,
        paint: paint.dim,
      });
    } else if (inherits && row.resolved.source === "global") {
      cells.push({ text: "(global)", paint: paint.dim });
    }
    if (isStoredValueInert(def, row.resolved, opts.platform)) {
      cells.push({ text: "(inert on this platform)", paint: paint.dim });
    }
    const right = packToWidth(cells, (cell) => stringWidth(cell.text), rightWidth)
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

  // The groups the header and the PROFILE headings name are the ones whose scope every profile
  // inherits, so a new profile-default group reaches them on its own.
  const inherited = [
    ...new Set(
      CONFIG_REGISTRY.filter((def) => def.scope === "profile-default")
        .map((def) => `${configGroup(def.key)}.*`),
    ),
  ].join(" / ");
  const storedCount = rows.filter((row) => row.stored).length;
  const headerParts = [
    `${storedCount} of ${rows.length} keys set (*).`,
    "agent config --set <key> <value>",
    "--del <key> reverts",
    `${PROFILE_FLAG} targets another profile`,
    ...(inherited === "" ? [] : [`${inherited} set without --profile is every profile's default`]),
  ];
  // A part wider than the terminal stands alone on its line; its words then wrap like prose.
  const header = packToWidth(headerParts, stringWidth, opts.width, HEADER_GAP.length)
    .flatMap((parts) => {
      const [only = ""] = parts;
      return parts.length === 1 && only.length > opts.width
        ? packToWidth(only.split(" "), stringWidth, opts.width)
          .map((words) => words.join(" "))
        : [parts.join(HEADER_GAP)];
    })
    .map((line) => paint.dim(line))
    .join("\n");

  /** A bold title whose note is its right column: on the shared column, or under the title
   *  when the title runs past it. */
  const banner = (title: string, note: string): string =>
    layout(paint.bold(title), stringWidth(title), wrapNote(`(${note})`)).join("\n");
  const groupIndent = " ".repeat(GROUP_INDENT);

  /** One block per group that has a key of `scope`, in CONFIG_GROUPS order. */
  const groupBlocks = (scope: ConfigScope, heading: (group: ConfigGroup) => string): string[] =>
    CONFIG_GROUPS.flatMap((group): string[] => {
      const lines = rows
        .filter((row) => row.def.scope === scope && configGroup(row.def.key) === group)
        .flatMap(renderRow);
      return lines.length === 0 ? [] : [[heading(group), ...lines].join("\n")];
    });

  const profileBlock = [
    [
      banner(
        `PROFILE ${profileSettingsKey(opts.profile)}`,
        `per profile; another profile: ${PROFILE_FLAG}`,
      ),
      ...rows.filter((row) => row.def.scope === "profile").flatMap(renderRow),
    ].join("\n"),
    ...groupBlocks("profile-default", (group) =>
      banner(
        `${groupIndent}${group}:`,
        `${profileDefaultConsumer(group)}; global rows set without --profile`,
      )),
  ].join("\n\n");
  const globalBlock = [
    banner("GLOBAL", "this machine, every profile"),
    groupBlocks("global", (group) => paint.bold(`${groupIndent}${group}:`)).join("\n\n"),
  ].join("\n");
  return [header, profileBlock, globalBlock].join("\n\n");
}

/** What reads a profile-default group's value for the profile: the PROFILE heading's note. A
 *  group with no profile-default key needs no entry; one that gains such a key must add its, or
 *  its heading throws (the table test renders every group). */
const PROFILE_DEFAULT_CONSUMER: Partial<Record<ConfigGroup, string>> = {
  probe: "this profile's Direct probe",
  proxy: "this profile's daemon",
};

function profileDefaultConsumer(group: ConfigGroup): string {
  const consumer = PROFILE_DEFAULT_CONSUMER[group];
  if (consumer === undefined) throw new Error(`no PROFILE heading note for the ${group} group`);
  return consumer;
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
