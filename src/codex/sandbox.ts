// The ONE reader of Codex's `sandbox_mode` for a selection, shared by `agent health` and `agent
// codex --check`. Report only: copilot-env never writes the key.
//
// Why a proxy selection cares: Codex runs the managed `auth.command` inside its sandbox, and that
// command reaches the proxy on loopback. configureCodexConfig opens the network with
// `[sandbox_workspace_write] network_access`, which applies ONLY under workspace-write (Codex's
// default); Codex documents no network switch for read-only, so a read-only selection's proxy
// auth exits 1 with no hint. danger-full-access has the network open.
import { parse } from "smol-toml";
import { isValidProfileName, parseProfileName, type Profile } from "../copilot_api/profile.ts";
import type { TextReadResult } from "../utils/fs.ts";
import { isRecord } from "../utils/json.ts";
import type { CodexWiringStatus } from "./config.ts";

const PROXY_BLOCKING_SANDBOX_MODE = "read-only";
const SANDBOX_MODE_KEY = "sandbox_mode";

/** Which profile a `codex [--profile <launch>]` launch runs. Codex's rule: `profile` in config.toml
 *  is the default profile when --profile is absent, so plain `codex` under `profile = "work"` runs
 *  `[profiles.work]`, and the default selection's sandbox and wiring are that profile's. */
export type CodexSelection =
  | { profile: null; via: "none" }
  | { profile: Exclude<Profile, null>; via: "launch" | "config-key" };

/** Null when nothing copilot-env can judge runs: a non-string `profile` value is a config Codex
 *  rejects at startup for EVERY launch (--profile included), and a key naming a profile copilot-env
 *  cannot spell (isValidProfileName) has no managed wiring addressed at it. Unparseable text
 *  resolves to the launch alone (the wiring check owns that verdict). */
export function effectiveCodexProfile(
  configToml: TextReadResult | string,
  launch: Profile,
): CodexSelection | null {
  const doc = parseToml(configToml);
  const key = isRecord(doc) ? doc.profile : undefined;
  if (key !== undefined && typeof key !== "string") return null;
  if (launch !== null) return { profile: launch, via: "launch" };
  if (key === undefined) return { profile: null, via: "none" };
  if (!isValidProfileName(key)) return null;
  return { profile: parseProfileName(key), via: "config-key" };
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

/** Where the effective value comes from; `line` is null when no single line can be proven to own
 *  the assignment (a multi-line inline table), since the value is read from the parse, never from
 *  the scan. */
export type CodexSandboxMode =
  | { kind: "unset" }
  | { kind: "set"; mode: string; table: "top-level" | "profile"; line: number | null };

/** The effective `sandbox_mode` the way Codex layers it: the selected profile's table
 *  (effectiveCodexProfile) over the top level. Null when the file is not readable TOML (the
 *  wiring check owns that verdict). */
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
  const profile = selection.profile;
  if (profile !== null) {
    const path = ["profiles", profile, SANDBOX_MODE_KEY];
    const mode = valueAt(doc, path);
    if (typeof mode === "string") {
      return { kind: "set", mode, table: "profile", line: assignmentLine(text, path) };
    }
  }
  const path = [SANDBOX_MODE_KEY];
  const mode = valueAt(doc, path);
  if (typeof mode === "string") {
    return { kind: "set", mode, table: "top-level", line: assignmentLine(text, path) };
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

const STRING_ASSIGNMENT = /(sandbox_mode\s*=\s*)(?:"[^"]*"|'[^']*')/;
const PROBE_VALUE = "copilot-env-line-probe";

/** 1-based line of the assignment at `path`, proved rather than pattern-matched: the line is the
 *  one where rewriting the assigned string makes the parsed value at `path` read PROBE_VALUE. A
 *  look-alike inside a comment or a multi-line string, or a quoted key that only spells the path,
 *  changes something else or nothing, so it never passes. */
function assignmentLine(text: string, path: readonly string[]): number | null {
  const lines = text.split(/\r?\n/);
  for (const [i, line] of lines.entries()) {
    if (!STRING_ASSIGNMENT.test(line)) continue;
    const probed = lines
      .map((l, j) => j === i ? l.replace(STRING_ASSIGNMENT, `$1"${PROBE_VALUE}"`) : l)
      .join("\n");
    try {
      if (valueAt(parse(probed), path) === PROBE_VALUE) return i + 1;
    } catch {
      // The rewrite broke the syntax (a string body spanning lines): not the assignment.
    }
  }
  return null;
}

/** `sandbox_mode = "x" at <file>:<line> (in the profile table)`, the one spelling of where the
 *  value lives, or the unset reading. */
export function describeCodexSandboxMode(reading: CodexSandboxMode, configPath: string): string {
  if (reading.kind === "unset") {
    return `${SANDBOX_MODE_KEY} unset in ${configPath} (Codex defaults to workspace-write)`;
  }
  const at = reading.line === null ? configPath : `${configPath}:${reading.line}`;
  const table = reading.table === "profile" ? " (in the profile table)" : "";
  return `${SANDBOX_MODE_KEY} = "${reading.mode}" at ${at}${table}`;
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
  if (reading.kind !== "set" || reading.mode !== PROXY_BLOCKING_SANDBOX_MODE) return null;
  const directSwitch = selection.profile === null
    ? "agent codex --direct"
    : `agent profile --add ${selection.profile} --direct`;
  const selectedBy = selection.via === "config-key"
    ? `; the config's profile = "${selection.profile}" key selects that profile for plain codex`
    : "";
  return {
    detail: `${
      describeCodexSandboxMode(reading, configPath)
    } blocks the proxy auth command (Codex runs it inside the sandbox, and read-only has no network switch)${selectedBy}`,
    fix:
      `set ${SANDBOX_MODE_KEY} = "workspace-write" in ${configPath}, or switch Codex to Direct with \`${directSwitch}\``,
  };
}
