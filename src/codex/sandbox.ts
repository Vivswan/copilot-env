// The ONE reader of a Codex selection's sandbox, shared by `agent health` and `agent codex
// --check`. Report only: copilot-env never writes these keys.
//
// Why a proxy selection cares: Codex runs the managed `auth.command` inside its sandbox, and that
// command reaches the proxy on loopback. configureCodexConfig opens the network with
// `[sandbox_workspace_write] network_access`, which applies ONLY under the legacy
// `sandbox_mode = "workspace-write"` (Codex's default); Codex documents no network switch for
// read-only, and a permission profile (`default_permissions`, Codex >= 0.138) ignores the legacy
// tables altogether and keeps its network off unless the profile enables it. Either way the
// proxy auth exits 1 with no hint.
import { parse } from "smol-toml";
import { isValidProfileName, parseProfileName, type Profile } from "../copilot_api/profile.ts";
import type { TextReadResult } from "../utils/fs.ts";
import { isRecord } from "../utils/json.ts";
import type { CodexWiringStatus } from "./config.ts";

const SANDBOX_MODE_KEY = "sandbox_mode";
const PERMISSIONS_KEY = "default_permissions";
const LEGACY_READ_ONLY = "read-only";
const BUILTIN_FULL_ACCESS = ":danger-full-access";

/** Which profile a `codex [--profile <launch>]` launch runs. Codex's rule: `profile` in config.toml
 *  is the default profile when --profile is absent, so plain `codex` under `profile = "work"` runs
 *  `[profiles.work]`, and the default selection's sandbox and wiring are that profile's. */
export type CodexSelection =
  | { profile: null; via: "none" }
  | { profile: Exclude<Profile, null>; via: "launch" | "config-key" };

/** Null when nothing copilot-env can judge runs: a file Codex refuses at startup (rejectedByCodex)
 *  runs no launch at all, --profile included, and a `profile` key naming a profile copilot-env
 *  cannot spell (isValidProfileName) has no managed wiring addressed at it. Unparseable text
 *  resolves to the launch alone (the wiring check owns that verdict). */
export function effectiveCodexProfile(
  configToml: TextReadResult | string,
  launch: Profile,
): CodexSelection | null {
  const doc = parseToml(configToml);
  const key = isRecord(doc) ? doc.profile : undefined;
  if (key !== undefined && typeof key !== "string") return null;
  const selection: CodexSelection | null = launch !== null
    ? { profile: launch, via: "launch" }
    : key === undefined
    ? { profile: null, via: "none" }
    : isValidProfileName(key)
    ? { profile: parseProfileName(key), via: "config-key" }
    : null;
  if (selection === null || rejectedByCodex(doc)) return null;
  return selection;
}

const SANDBOX_MODES: ReadonlySet<string> = new Set([
  LEGACY_READ_ONLY,
  "workspace-write",
  BUILTIN_FULL_ACCESS.slice(1),
]);

/** Codex deserializes the WHOLE file before selecting anything and refuses it on a wrong-typed key
 *  ("invalid type: integer `1`, expected a string", verified on codex 0.153.4), so a present
 *  wrong-typed value, in an unselected profile included, must never be read as "unset" with the top
 *  level judged in its place. Only the keys this reader reads are checked; Codex's full schema is
 *  not re-validated here. */
function rejectedByCodex(doc: unknown): boolean {
  const permissions = valueAt(doc, [PERMISSIONS_KEY]);
  if (permissions !== undefined && typeof permissions !== "string") return true;
  const profiles = valueAt(doc, ["profiles"]);
  const modes = [
    valueAt(doc, [SANDBOX_MODE_KEY]),
    ...(isRecord(profiles)
      ? Object.values(profiles).map((table) => valueAt(table, [SANDBOX_MODE_KEY]))
      : []),
  ];
  return modes.some((mode) =>
    mode !== undefined && !(typeof mode === "string" && SANDBOX_MODES.has(mode))
  );
}

function parseToml(configToml: TextReadResult | string): unknown {
  const text = typeof configToml === "string"
    ? configToml
    : configToml.kind === "text"
    ? configToml.text
    : null;
  if (text === null) return null;
  try {
    return parse(text);
  } catch {
    return null;
  }
}

/** Only the command shape runs anything inside the sandbox: a static bearer rides in the table, a
 *  foreign or missing table has no command of ours, and Direct never talks to the proxy. */
export function runsSandboxedProxyAuth(
  wiring: Pick<CodexWiringStatus, "providerMode" | "credential">,
): boolean {
  return wiring.providerMode === "proxy" && wiring.credential === "command";
}

/** The setting that decides the selection's sandbox, and the verdict it implies, resolved HERE so
 *  no consumer re-derives Codex's rules. `line` is null when no single line can be proven to own
 *  the assignment (a multi-line inline table); the value is read from the parse, never the scan. */
export type CodexSandboxMode =
  /** Neither key set: Codex's workspace-write default, which the managed network toggle opens. */
  | { kind: "unset" }
  | {
    kind: "set";
    key: typeof SANDBOX_MODE_KEY | typeof PERMISSIONS_KEY;
    value: string;
    table: "top-level" | "profile";
    line: number | null;
    proxyAuthReaches: boolean;
  };

/**
 * The sandbox the way Codex layers it (verified against openai/codex config_toml.rs and the
 * permissions guide):
 *
 *   sandbox_mode in the selected profile table, else at the top level  -> legacy wins whenever set
 *   default_permissions (top level only; profiles carry no such key)   -> a permission profile
 *   neither                                                            -> workspace-write
 *
 * Legacy read-only has no network switch. A permission profile's network is off unless
 * `[permissions.<name>].network.enabled` is true, and `[sandbox_workspace_write]` does not apply
 * to it, so the built-ins `:read-only` and `:workspace` both block; `:danger-full-access` lifts
 * the sandbox. Null when the file is not readable TOML (the wiring check owns that verdict).
 */
export function readCodexSandboxMode(
  configToml: TextReadResult | string,
  selection: CodexSelection,
): CodexSandboxMode | null {
  const text = typeof configToml === "string"
    ? configToml
    : configToml.kind === "text"
    ? configToml.text
    : null;
  if (text === null) return null;
  const doc = parseToml(text);
  if (doc === null) return null;
  const legacy = (
    path: readonly string[],
    table: "top-level" | "profile",
  ): CodexSandboxMode | null => {
    const value = valueAt(doc, path);
    return typeof value !== "string" ? null : {
      kind: "set",
      key: SANDBOX_MODE_KEY,
      value,
      table,
      line: assignmentLine(text, path),
      proxyAuthReaches: value !== LEGACY_READ_ONLY,
    };
  };
  const profile = selection.profile;
  const fromProfile = profile === null
    ? null
    : legacy(["profiles", profile, SANDBOX_MODE_KEY], "profile");
  if (fromProfile !== null) return fromProfile;
  const fromTopLevel = legacy([SANDBOX_MODE_KEY], "top-level");
  if (fromTopLevel !== null) return fromTopLevel;
  const permissions = valueAt(doc, [PERMISSIONS_KEY]);
  if (typeof permissions === "string") {
    const proxyAuthReaches = permissions === BUILTIN_FULL_ACCESS ||
      (!permissions.startsWith(":") &&
        valueAt(doc, ["permissions", permissions, "network", "enabled"]) === true);
    return {
      kind: "set",
      key: PERMISSIONS_KEY,
      value: permissions,
      table: "top-level",
      line: assignmentLine(text, [PERMISSIONS_KEY]),
      proxyAuthReaches,
    };
  }
  return { kind: "unset" };
}

function valueAt(doc: unknown, path: readonly string[]): unknown {
  let node = doc;
  for (const key of path) {
    if (!isRecord(node)) return undefined;
    node = node[key];
  }
  return node;
}

const PROBE_VALUE = "copilot-env-line-probe";

/** 1-based line of the assignment at `path`, proved rather than pattern-matched: the line is the
 *  one where rewriting the assigned string makes the parsed value at `path` read PROBE_VALUE. A
 *  look-alike inside a comment or a multi-line string, or a quoted key that only spells the path,
 *  changes something else or nothing, so it never passes. */
function assignmentLine(text: string, path: readonly string[]): number | null {
  const assignment = new RegExp(`(${path[path.length - 1]}\\s*=\\s*)(?:"[^"]*"|'[^']*')`);
  const lines = text.split(/\r?\n/);
  for (const [i, line] of lines.entries()) {
    if (!assignment.test(line)) continue;
    const probed = lines
      .map((l, j) => j === i ? l.replace(assignment, `$1"${PROBE_VALUE}"`) : l)
      .join("\n");
    try {
      if (valueAt(parse(probed), path) === PROBE_VALUE) return i + 1;
    } catch {
      // The rewrite broke the syntax (a string body spanning lines): not the assignment.
    }
  }
  return null;
}

/** `<key> = "x" at <file>:<line> (in the profile table)`, the one spelling of where the value
 *  lives, or the unset reading. */
export function describeCodexSandboxMode(reading: CodexSandboxMode, configPath: string): string {
  if (reading.kind === "unset") {
    return `${SANDBOX_MODE_KEY} and ${PERMISSIONS_KEY} unset in ${configPath} (Codex defaults to workspace-write)`;
  }
  const at = reading.line === null ? configPath : `${configPath}:${reading.line}`;
  const table = reading.table === "profile" ? " (in the profile table)" : "";
  return `${reading.key} = "${reading.value}" at ${at}${table}`;
}

/** A profile name as a TOML key: bare when TOML allows it, else quoted so `permissions."team.net"`
 *  addresses one table and not a nested pair. */
function tomlKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
}

/** The warning both surfaces print for a selection that runsSandboxedProxyAuth and whose sandbox
 *  blocks that command; null when the network is open to it. The Direct switch addresses the
 *  profile Codex actually runs: under a `profile` key, `agent codex --direct` would rewire a table
 *  plain `codex` no longer selects. */
export function proxyAuthBlockedBySandbox(
  reading: CodexSandboxMode,
  configPath: string,
  selection: CodexSelection,
): { detail: string; fix: string } | null {
  if (reading.kind !== "set" || reading.proxyAuthReaches) return null;
  const directSwitch = selection.profile === null
    ? "agent codex --direct"
    : `agent profile --add ${selection.profile} --direct`;
  const selectedBy = selection.via === "config-key"
    ? `; the config's profile = "${selection.profile}" key selects that profile for plain codex`
    : "";
  const why = reading.key === SANDBOX_MODE_KEY
    ? "read-only has no network switch"
    : "a permission profile keeps its network off unless permissions.<name>.network.enabled = true, and [sandbox_workspace_write] does not apply to it";
  const setting = reading.key === PERMISSIONS_KEY && !reading.value.startsWith(":")
    ? `set permissions.${tomlKey(reading.value)}.network.enabled = true in ${configPath}`
    : `set ${SANDBOX_MODE_KEY} = "workspace-write" in ${configPath}${
      reading.key === PERMISSIONS_KEY ? ` (the legacy key overrides ${PERMISSIONS_KEY})` : ""
    }`;
  return {
    detail: `${
      describeCodexSandboxMode(reading, configPath)
    } blocks the proxy auth command (Codex runs it inside the sandbox, and ${why})${selectedBy}`,
    fix: `${setting}, or switch Codex to Direct with \`${directSwitch}\``,
  };
}
