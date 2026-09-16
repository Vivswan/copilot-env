// The ONE reader of a Codex launch's sandbox, shared by `agent health` and `agent codex --check`.
// Report only: copilot-env never writes these keys.
//
// Why a proxy selection cares: Codex runs the managed `auth.command` inside its sandbox, and that
// command reaches the proxy on loopback. configureCodexConfig opens the network with
// `[sandbox_workspace_write] network_access`, which applies ONLY under the legacy
// `sandbox_mode = "workspace-write"` (interactive Codex's default); read-only has no network
// switch, and a permission profile (`default_permissions`) ignores the legacy tables altogether and
// keeps its network off unless the profile enables it. Either way the proxy auth exits 1 with no
// hint.
//
// Every rule below was verified live on codex 0.153.4 (`codex exec` banners and config-load
// errors), and two of them contradict Codex's own docs, so the docs are not the reference here:
//   default_permissions set            -> it wins over ANY sandbox_mode (docs claim the reverse)
//   `profile = "<name>"` key           -> "legacy profile config is no longer supported": no launch runs
//   `[profiles.<name>]` table          -> `--profile <name>` refuses to start; plain codex still runs
//   wrong-typed key / unknown mode     -> the whole file is refused, unselected profiles included
import { parse } from "smol-toml";
import type { Profile } from "../copilot_api/profile.ts";
import type { TextReadResult } from "../utils/fs.ts";
import { isRecord } from "../utils/json.ts";
import type { CodexWiringStatus } from "./config.ts";

const SANDBOX_MODE_KEY = "sandbox_mode";
const PERMISSIONS_KEY = "default_permissions";
const PROFILE_KEY = "profile";
const LEGACY_READ_ONLY = "read-only";
const BUILTIN_FULL_ACCESS = ":danger-full-access";
const SANDBOX_MODES: ReadonlySet<string> = new Set([
  LEGACY_READ_ONLY,
  "workspace-write",
  BUILTIN_FULL_ACCESS.slice(1),
]);

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

/** True when Codex refuses to start `codex [--profile <launch>]` on this file, so nothing of ours
 *  runs and no sandbox verdict may be given in its place. Only the keys this reader reads are
 *  type-checked; Codex's full schema is not re-validated. Unparseable text is not a refusal here
 *  (the wiring check owns that verdict). */
export function codexRefusesLaunch(configToml: TextReadResult | string, launch: Profile): boolean {
  const doc = parseToml(configToml);
  if (!isRecord(doc)) return false;
  if (doc[PROFILE_KEY] !== undefined) return true;
  const permissions = doc[PERMISSIONS_KEY];
  if (permissions !== undefined && typeof permissions !== "string") return true;
  if (
    typeof permissions === "string" && !permissions.startsWith(":") &&
    customProfileNetwork(doc, permissions) === "rejected"
  ) return true;
  const profiles = doc.profiles;
  if (launch !== null && isRecord(profiles) && profiles[launch] !== undefined) return true;
  const modes = [
    doc[SANDBOX_MODE_KEY],
    ...(isRecord(profiles)
      ? Object.values(profiles).map((table) =>
        isRecord(table) ? table[SANDBOX_MODE_KEY] : undefined
      )
      : []),
  ];
  return modes.some((mode) =>
    mode !== undefined && !(typeof mode === "string" && SANDBOX_MODES.has(mode))
  );
}

const BUILTIN_PARENTS: ReadonlySet<string> = new Set([":read-only", ":workspace"]);

/** A custom permission profile's network switch, the nearest `network.enabled` along its `extends`
 *  chain (a built-in parent has it off). "rejected" is a chain Codex refuses to load anywhere along
 *  its length, even past the nearest switch: a missing profile or parent, a cycle, a non-string
 *  `extends`, or a parent that is not `:read-only`, `:workspace`, or a named profile. */
function customProfileNetwork(doc: unknown, name: string): boolean | "rejected" {
  const seen = new Set<string>();
  let nearest: boolean | null = null;
  for (let current = name;;) {
    if (current.startsWith(":")) {
      return BUILTIN_PARENTS.has(current) ? nearest ?? false : "rejected";
    }
    if (seen.has(current)) return "rejected";
    seen.add(current);
    const table = valueAt(doc, ["permissions", current]);
    if (!isRecord(table)) return "rejected";
    const enabled = valueAt(table, ["network", "enabled"]);
    if (nearest === null && typeof enabled === "boolean") nearest = enabled;
    if (table.extends === undefined) return nearest ?? false;
    if (typeof table.extends !== "string") return "rejected";
    current = table.extends;
  }
}

/** Only the command shape runs anything inside the sandbox: a static bearer rides in the table, a
 *  foreign or missing table has no command of ours, and Direct never talks to the proxy. */
export function runsSandboxedProxyAuth(
  wiring: Pick<CodexWiringStatus, "providerMode" | "credential">,
): boolean {
  return wiring.providerMode === "proxy" && wiring.credential === "command";
}

/** The setting that decides the sandbox, and the verdict it implies, resolved HERE so no consumer
 *  re-derives Codex's rules. `line` is null when no single line can be proven to own the
 *  assignment (a multi-line inline table); the value is read from the parse, never the scan. */
export type CodexSandboxMode =
  /** Neither key set: interactive Codex's workspace-write default, which the managed toggle opens. */
  | { kind: "unset" }
  | (SandboxSetting & { key: typeof SANDBOX_MODE_KEY })
  | (SandboxSetting & {
    key: typeof PERMISSIONS_KEY;
    /** The legacy `sandbox_mode` the profile overrides (null = none set): what removing the
     *  profile key would expose, so the fix can say whether that alone opens the network. */
    overrides: string | null;
  });

interface SandboxSetting {
  kind: "set";
  value: string;
  line: number | null;
  proxyAuthReaches: boolean;
}

/** The top-level sandbox of config.toml: `default_permissions` when set, else `sandbox_mode`. A
 *  permission profile's network is off unless `[permissions.<name>].network.enabled` is true and
 *  `[sandbox_workspace_write]` does not apply to it, so the built-ins `:read-only` and `:workspace`
 *  both block while `:danger-full-access` lifts the sandbox. A `--profile <name>` launch layers
 *  `<name>.config.toml` on top, which nothing of ours writes yet, so it is not read here. Null when
 *  the file is not readable TOML. */
export function readCodexSandboxMode(configToml: TextReadResult | string): CodexSandboxMode | null {
  const text = typeof configToml === "string"
    ? configToml
    : configToml.kind === "text"
    ? configToml.text
    : null;
  if (text === null) return null;
  const doc = parseToml(text);
  if (!isRecord(doc)) return null;
  const permissions = doc[PERMISSIONS_KEY];
  const mode = doc[SANDBOX_MODE_KEY];
  if (typeof permissions === "string") {
    return {
      kind: "set",
      key: PERMISSIONS_KEY,
      value: permissions,
      line: assignmentLine(text, [PERMISSIONS_KEY], permissions),
      proxyAuthReaches: permissions === BUILTIN_FULL_ACCESS ||
        (!permissions.startsWith(":") && customProfileNetwork(doc, permissions) === true),
      overrides: typeof mode === "string" ? mode : null,
    };
  }
  if (typeof mode === "string") {
    return {
      kind: "set",
      key: SANDBOX_MODE_KEY,
      value: mode,
      line: assignmentLine(text, [SANDBOX_MODE_KEY], mode),
      proxyAuthReaches: mode !== LEGACY_READ_ONLY,
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
 *  one where rewriting the assigned string makes the parsed value at `path` read a probe value the
 *  file does not already hold. A look-alike inside a comment or a multi-line string, or a quoted
 *  key that only spells the path, changes something else or nothing, so it never passes. */
function assignmentLine(text: string, path: readonly string[], current: string): number | null {
  const probe = current === PROBE_VALUE ? `${PROBE_VALUE}-2` : PROBE_VALUE;
  const assignment = new RegExp(`(${path[path.length - 1]}\\s*=\\s*)(?:"[^"]*"|'[^']*')`);
  const lines = text.split(/\r?\n/);
  for (const [i, line] of lines.entries()) {
    if (!assignment.test(line)) continue;
    const probed = lines
      .map((l, j) => j === i ? l.replace(assignment, `$1"${probe}"`) : l)
      .join("\n");
    try {
      if (valueAt(parse(probed), path) === probe) return i + 1;
    } catch {
      // The rewrite broke the syntax (a string body spanning lines): not the assignment.
    }
  }
  return null;
}

/** `<key> = "x" at <file>:<line>`, the one spelling of where the value lives, or the unset reading. */
export function describeCodexSandboxMode(reading: CodexSandboxMode, configPath: string): string {
  if (reading.kind === "unset") {
    return `${SANDBOX_MODE_KEY} and ${PERMISSIONS_KEY} unset in ${configPath} (interactive Codex defaults to workspace-write)`;
  }
  const at = reading.line === null ? configPath : `${configPath}:${reading.line}`;
  return `${reading.key} = "${reading.value}" at ${at}`;
}

/** A profile name as a TOML key: bare when TOML allows it, else quoted so `permissions."team.net"`
 *  addresses one table and not a nested pair. */
function tomlKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
}

/** The warning both surfaces print for a launch that runsSandboxedProxyAuth and whose sandbox
 *  blocks that command; null when the network is open to it. The Direct switch addresses the
 *  launch's own wiring: a named profile is rewired by `agent profile`, never `agent codex`. */
export function proxyAuthBlockedBySandbox(
  reading: CodexSandboxMode,
  configPath: string,
  launch: Profile,
): { detail: string; fix: string } | null {
  if (reading.kind !== "set" || reading.proxyAuthReaches) return null;
  const directSwitch = launch === null
    ? "agent codex --direct"
    : `agent profile --add ${launch} --direct`;
  const why = reading.key === SANDBOX_MODE_KEY
    ? "read-only has no network switch"
    : "a permission profile keeps its network off unless permissions.<name>.network.enabled = true, and [sandbox_workspace_write] does not apply to it";
  const setting = reading.key === SANDBOX_MODE_KEY
    ? `set ${SANDBOX_MODE_KEY} = "workspace-write" in ${configPath}`
    : reading.value.startsWith(":")
    ? `remove ${PERMISSIONS_KEY} from ${configPath} (it overrides ${SANDBOX_MODE_KEY})${
      reading.overrides === LEGACY_READ_ONLY
        ? ` and set ${SANDBOX_MODE_KEY} = "workspace-write"`
        : ""
    } or select a custom [permissions.<name>] with network.enabled = true`
    : `set permissions.${tomlKey(reading.value)}.network.enabled = true in ${configPath}`;
  return {
    detail: `${
      describeCodexSandboxMode(reading, configPath)
    } blocks the proxy auth command (Codex runs it inside the sandbox, and ${why})`,
    fix: `${setting}, or switch Codex to Direct with \`${directSwitch}\``,
  };
}
