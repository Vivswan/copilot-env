// The preference verbs behind `agent config set|get|unset` and `agent profile [<name>] set|get|unset`:
// one body, told which face called it. configTable() is the listing a keyless `get` prints, in the
// view of the face (the machine's keys and the shared defaults, or one profile's keys); `agent
// config --help` prints the config view. The key registry is src/copilot_api/config_registry.ts.
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
  isProxyProjected,
} from "../copilot_api/config_registry.ts";
import {
  configDelCommand,
  configGetCommand,
  configSetCommand,
  CopilotEnvConfig,
  type CopilotEnvConfigData,
  formatConfigValue,
  isStoredSource,
  isStoredValueInert,
  profileSettingsKey,
  resolveSettingIn,
  type SettingSource,
  type SettingTarget,
} from "../copilot_api/env_config.ts";
import {
  assertKnownProfile,
  GLOBAL_STATE_KEYS,
  PROFILE_STATE_KEYS,
} from "../copilot_api/env_state.ts";
import { LEDGER_KEY_NAMES } from "../copilot_api/ownership.ts";
import {
  agentStartCommand,
  agentStopCommand,
  type Profile,
  profileLabel,
} from "../copilot_api/profile.ts";
import { colorEnabled, paintFor } from "../utils/ansi.ts";
import { assertNever } from "../utils/assert.ts";
import { errMessage } from "../utils/error.ts";
import { terminalWidth, wrapMessage } from "../utils/table.ts";
import stringWidth from "string-width";
import { runDryRun } from "./dry_run.ts";

/** Which face called: `agent config` (the machine's keys and the shared default of every
 *  profile-default key) or `agent profile [<name>]` (that profile's keys, its overrides included).
 *  With no name, the profile face and the config face write and read the same store bytes for a
 *  profile-default key: the default profile never carries its own override. */
export type ConfigView = { kind: "config" } | { kind: "profile"; profile: Profile };

/** A verb's arguments as the CLI parsed them: the key's scope decides the map (settingTarget). */
type ConfigAction =
  | { kind: "set"; key: string; value: string; view: ConfigView; dryRun: boolean }
  | { kind: "unset"; key: string; view: ConfigView; dryRun: boolean }
  | { kind: "get"; key?: string; view: ConfigView };

/** The profile a view resolves for: the config face reads the shared layer, which is the default
 *  profile's own resolution. */
function viewProfile(view: ConfigView): Profile {
  return view.kind === "config" ? null : view.profile;
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

/** The verbs write settings only: a state key (spelled bare, or as a path into the file such as
 *  `profiles.default.githubToken`) is refused with its owner, never written or deleted here. */
function refuseStateKey(key: string): void {
  const leaf = key.split(".").at(-1) ?? key;
  const owner = STATE_KEY_OWNERS.find(([keys]) => keys.includes(leaf))?.[1];
  if (owner === undefined) return;
  throw new Error(
    `'${key}' is state written by ${owner}; a preference verb sets preferences only ` +
      "(`agent config get` lists the machine's keys and the shared defaults, `agent profile " +
      "[<name>] get` a profile's)",
  );
}

function unknownKeyError(key: string): Error {
  const keys = CONFIG_REGISTRY.map((d) => d.key).join(", ");
  return new Error(`unknown config key '${key}'. Valid keys: ${keys}`);
}

/** `agent config` holds the machine's keys and the shared defaults; a key that follows the
 *  credential (identity, host, passthrough, static-key) is a profile's own, so its verb is
 *  `agent profile [<name>] set|get|unset`. The config face's guard, total over the key's scope. */
export function refuseProfileKey(key: string): void {
  const def = configKeyDef(key);
  if (def === undefined || def.scope !== "profile") return;
  throw new Error(
    `'${def.key}' is a profile preference (it follows the credential), not a machine key: \`${
      configGetCommand(def.key)
    }\`, \`${configSetCommand(def.key, "<value>")}\`, or \`${configDelCommand(def.key)}\` (a ` +
      "named profile's: `agent profile <name> ...`)",
  );
}

/** The set verbs take two spellings, `set <key> <value>` and `set <key>=<value>`, and the body
 *  takes one pair. The one-word form splits at the first `=`, so a URL value keeps its query; an
 *  empty value after it (`<key>=`) reaches the key's parser, which decides. `face` is the verb's
 *  own spelling for the refusals (`agent config set`, `agent profile work set`). Neither refusal
 *  echoes an operand: a value may be a credential (static-key, a price-list URL's userinfo). */
export function resolveSetPair(
  key: string,
  value: string | undefined,
  face: string,
): { key: string; value: string } {
  const at = key.indexOf("=");
  const forms = `\`${face} <key> <value>\` or \`${face} <key>=<value>\``;
  if (value === undefined) {
    if (at === -1) throw new Error(`missing value: use ${forms}`);
    return { key: key.slice(0, at), value: key.slice(at + 1) };
  }
  if (at !== -1) {
    throw new Error(`the value is given twice (after \`=\` and as a second word): use ${forms}`);
  }
  return { key, value };
}

/** The daemon that reads a projected or launch-time key is the profile's own, so the restart the
 *  hint names is that daemon's. Hints stay shell-neutral (no `&&`) for Windows PowerShell 5.1. */
function proxyRestartHint(profile: Profile): string {
  return `Applies on the next proxy start; restart it: \`${agentStopCommand(profile)}\`, then \`${
    agentStartCommand(profile)
  }\`.`;
}

/** Shared with `agent settings --import`, whose bundle may touch every profile's knobs. */
export const PROXY_RESTART_HINT_ALL =
  "Applies on the next proxy start; restart the running daemons: `agent stop --all`, then " +
  "`agent start` (`agent profile <name> start` for a profile's daemon).";

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

/** `platform` is the POSIX-only key guard's test seam. Synchronous unless it is a dry run (the
 *  plan print awaits the recording), so a key error still throws at the call. A write handler
 *  returns what to say once it landed; a dry run prints the plan in its place. */
export function runConfig(
  action: ConfigAction,
  platform: NodeJS.Platform = process.platform,
): void | Promise<void> {
  // A named profile must exist: a section for a profile the store never created would be a
  // hidden value with no reader.
  const profile = viewProfile(action.view);
  if (profile !== null) assertKnownProfile(profile);
  const run = (): () => void => {
    switch (action.kind) {
      case "set":
        return runSet(action.key, action.value, profile, platform);
      case "unset":
        return runUnset(action.key, profile);
      case "get":
        runGet(action.key, action.view, platform);
        return () => {};
      default:
        return assertNever(action);
    }
  };
  if (action.kind !== "get" && action.dryRun) return runDryRun(() => Promise.resolve(run()));
  run()();
}

/** Where a write landed, for the set/unset lines: empty for the global map. */
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
    noteHowItApplies(def, target);
  };
}

function runUnset(key: string, profile: Profile): () => void {
  refuseStateKey(key);
  const def = configKeyDef(key);
  if (def === undefined) throw unknownKeyError(key);
  const config = new CopilotEnvConfig();
  const target = config.assign(def, null, profile);
  // What the key resolves to NOW, and from where: a dropped profile override may fall back to the
  // shared default, not the built-in one.
  const now = config.resolve(def.key, {
    profile: target.kind === "global" ? null : target.profile,
  });
  const reads = now.value === undefined
    ? "unset"
    : `${formatConfigValue(now.value)} (${originLabel(def, now.source, profile)})`;
  return () => {
    consola.success(`unset ${def.key}${targetSuffix(target)}; now ${reads}`);
    noteHowItApplies(def, target);
  };
}

/** Where a resolved value came from, in the store's terms: the profile's own section, the global
 *  map (the machine's value for a global key, the shared default for a profile-default one), or
 *  the built-in default. The flag/env layer is per invocation and stays at each read site. */
function originLabel(def: ConfigKeyDef, source: SettingSource, profile: Profile): string {
  switch (source) {
    case "profile":
      return `stored for ${profileLabel(profile)}`;
    case "global":
      return def.scope === "global" ? "stored" : "the shared default";
    case "default":
      return "built-in default";
    case "flag":
      return "this invocation's flag";
    default:
      return assertNever(source);
  }
}

function runGet(get: string | undefined, view: ConfigView, platform: NodeJS.Platform): void {
  const data = new CopilotEnvConfig().read();
  const profile = viewProfile(view);

  if (typeof get === "string") {
    // Just the value on stdout, for scripts (a blank line when unset); the origin on stderr. A
    // stored value inert on this platform answers with the built-in default, which is what every
    // read site sees.
    const def = configKeyDef(get);
    if (def === undefined) throw unknownKeyError(get);
    const resolved = resolveSettingIn(data, def.key, { profile });
    const inert = isStoredValueInert(def, resolved, platform);
    const value = inert ? configDefaultValue(def) : resolved.value;
    process.stdout.write(value === undefined ? "\n" : `${formatConfigValue(value)}\n`);
    const origin = inert
      ? `${originLabel(def, "default", profile)} (the stored value is inert on this platform)`
      : originLabel(def, resolved.source, profile);
    process.stderr.write(`${paintFor(colorEnabled()).dim(`${def.key}: ${origin}`)}\n`);
    return;
  }

  // Straight to stdout, not consola: consola reformats the backticks in the descriptions, and this
  // must match `agent config --help` byte for byte.
  process.stdout.write(`${configTableOutput(platform, view)}\n`);
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

interface ConfigTableOptions {
  platform: NodeJS.Platform;
  width: number;
  /** Which face is listing: the config view (the shared defaults, then the machine's keys) or one
   *  profile's view (its own keys, then the profile-default groups resolved for it). */
  view: ConfigView;
  /** A stored key a live daemon read at launch earns the restart line: any daemon for a value
   *  from the global map, the viewed profile's own daemon for a value from its section. */
  daemonUp: boolean;
  profileDaemonUp: boolean;
  color: boolean;
}

/** The listing a keyless `get` prints, and `agent config --help` in the config view. The config
 *  view: a SHARED DEFAULTS banner for the profile-default groups as every profile inherits them,
 *  then a GLOBAL banner for the machine's keys, grouped by the key's group. A profile's view: a
 *  PROFILE banner for every key its daemon and wiring consume (its own keys, then the
 *  profile-default groups resolved for it). Prose breaks between words; a value wider than its
 *  column (a URL) splits at the edge. */
export function configTable(data: CopilotEnvConfigData, opts: ConfigTableOptions): string {
  const plain = (text: string): string => text;
  const paint = paintFor(opts.color);
  const profile = viewProfile(opts.view);
  const excludedScope: ConfigScope = opts.view.kind === "config" ? "profile" : "global";
  const rows = CONFIG_REGISTRY.filter((def) => def.scope !== excludedScope).map((def) => {
    const resolved = resolveSettingIn(data, def.key, { profile });
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

  // The shared layer a profile override hides: the global map's value, else the built-in default.
  const globalLayer: Partial<ConfigValueTypes> = data.global;
  const renderRow = (row: (typeof rows)[number]): string[] => {
    const { def } = row;
    const cells: Cell[] = [{ text: `[${def.type}]`, paint: plain }];
    // In a profile's view a profile-default row names where its value came from: the shared
    // default (`(shared default)`), or its own section, which then names the layer it hides once:
    // the shared default's value, or the built-in default in place of the `default` cell. In the
    // config view the row IS the shared default, and the star alone says it is stored.
    const inherits = def.scope === "profile-default" && opts.view.kind === "profile";
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
          ? `(overrides the shared default ${formatConfigValue(shared)})`
          : `(overrides the built-in default ${
            row.fallback === undefined ? UNSET_VALUE : formatConfigValue(row.fallback)
          })`,
        paint: paint.dim,
      });
    } else if (inherits && row.resolved.source === "global") {
      cells.push({ text: "(shared default)", paint: paint.dim });
    }
    if (isStoredValueInert(def, row.resolved, opts.platform)) {
      cells.push({ text: "(inert on this platform)", paint: paint.dim });
    }
    const right = packToWidth(cells, (cell) => stringWidth(cell.text), rightWidth)
      .map((line) => line.map((cell) => cell.paint(cell.text)).join(" "));
    const daemonReads = isProxyProjected(def) || def.restartToApply === true;
    const up = row.resolved.source === "profile" ? opts.profileDaemonUp : opts.daemonUp;
    if (row.stored && up && daemonReads) right.push(paint.dim(paint.green(RESTART_LINE)));
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

  // The groups the banners name are the ones whose scope every profile inherits, so a new
  // profile-default group reaches them on its own.
  const inherited = [
    ...new Set(
      CONFIG_REGISTRY.filter((def) => def.scope === "profile-default")
        .map((def) => `${configGroup(def.key)}.*`),
    ),
  ].join(" / ");
  const storedCount = rows.filter((row) => row.stored).length;
  // The face's own verbs, then where the keys it does not list live.
  const face = opts.view.kind === "config"
    ? "agent config"
    : `agent profile${profile === null ? "" : ` ${profile}`}`;
  const headerParts = [
    `${storedCount} of ${rows.length} keys set (*).`,
    `${face} set <key> <value> (or <key>=<value>)`,
    `${face} unset <key> reverts`,
    opts.view.kind === "config"
      ? "a profile's own keys: agent profile [<name>] set|unset|get"
      : "this machine's keys: agent config get",
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

  if (opts.view.kind === "profile") {
    const profileBlock = [
      [
        banner(
          `PROFILE ${profileSettingsKey(profile)}`,
          `this profile's keys; another profile: agent profile <name> get`,
        ),
        ...rows.filter((row) => row.def.scope === "profile").flatMap(renderRow),
      ].join("\n"),
      ...groupBlocks("profile-default", (group) =>
        banner(
          `${groupIndent}${group}:`,
          `${profileDefaultConsumer(group)}; the shared default is agent config's`,
        )),
    ].join("\n\n");
    return [header, profileBlock].join("\n\n");
  }
  const sharedBlock = [
    banner(
      "SHARED DEFAULTS",
      `${inherited}: every profile's default; a named profile overrides its own with ` +
        "agent profile <name> set",
    ),
    ...groupBlocks("profile-default", (group) => paint.bold(`${groupIndent}${group}:`)),
  ].join("\n");
  const globalBlock = [
    banner("GLOBAL", "this machine, every profile"),
    groupBlocks("global", (group) => paint.bold(`${groupIndent}${group}:`)).join("\n\n"),
  ].join("\n");
  return [header, sharedBlock, globalBlock].join("\n\n");
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

/** The one string a keyless `agent config get` and `agent config --help` both print, so their
 *  outputs are byte-identical. `platform` is the inert note's test seam. */
export function configTableOutput(
  platform: NodeJS.Platform = process.platform,
  view: ConfigView = { kind: "config" },
): string {
  return configTable(new CopilotEnvConfig().read(), {
    platform,
    width: terminalWidth() ?? Number.POSITIVE_INFINITY,
    view,
    daemonUp: anyTrackedDaemonAlive(),
    profileDaemonUp: trackedDaemonAlive(viewProfile(view)),
    color: colorEnabled(),
  });
}
