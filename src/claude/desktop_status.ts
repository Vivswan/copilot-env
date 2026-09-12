// The read-only side of the Claude Desktop wiring; desktop.ts is what writes it. `agent claude
// --check` and the health engine share these lines and repair commands so the two cannot disagree.
import { basename, join } from "node:path";
import type { ManagedWrite } from "../agents/configure.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { CopilotEnvState, type ProfileMode } from "../copilot_api/env_state.ts";
import {
  CODEX_IDENTITY_NAME,
  DEFAULT_COPILOT_API_BASE,
  INTEGRATION_ID_HEADER,
} from "../copilot_api/integration_identity.ts";
import { resolveRootHome } from "../copilot_api/paths.ts";
import { copilotApiResolvePort, proxyLoopbackOrigin } from "../copilot_api/port.ts";
import type { Profile } from "../copilot_api/profile.ts";
import { assertNever } from "../utils/assert.ts";
import { errMessage } from "../utils/error.ts";
import { isRecord } from "../utils/json.ts";
import {
  claudeDesktopInstalled,
  desktopConfigPayload,
  desktopEntryName,
  desktopHelperBody,
  desktopHelperPath,
  desktopHelperScriptWiring,
  entryExists,
  entryProfileAt,
  helperExecutable,
  META_FILENAME,
  type OwnedDesktopEntry,
  presentDesktopHelperScripts,
  readFileOrNull,
  readOwnedLibrary,
  recordedModelRows,
  resolveDesktopLibraryDir,
  sameBaseUrl,
} from "./desktop.ts";

/** `mode` is what the wiring's source of truth records: settings.json's managed mode for the
 *  default, the store slot for a profile. */
export interface DesktopTarget {
  profile: Profile;
  mode: ProfileMode;
}

export type DesktopEntryVerdict =
  | { kind: "wired"; path: string }
  | { kind: "missing" }
  /** `fix` overrides the target's rewire command when a rewire cannot repair it. */
  | { kind: "stale"; path: string; reason: string; fix?: string };

export type DesktopEntryStatus = DesktopTarget & { verdict: DesktopEntryVerdict };

/** `profile` is undefined when the document names no helper of ours (see entryProfileAt), which no
 *  target can claim. */
export interface DesktopClaim {
  path: string;
  profile: Profile | undefined;
}

/** The name is the user's. An orphan is an owned entry no current target promises. */
export type DesktopOwnedEntry = DesktopClaim & { name: string };

/** An unreadable or malformed settings.json is NOT "the default promises nothing": that reading is
 *  what would make the default's entry an orphan to delete. */
export type DesktopTargetResolution =
  | { kind: "resolved"; targets: readonly DesktopTarget[] }
  | { kind: "unresolvable"; reason: string };

interface DesktopStatusBase {
  enabled: boolean;
  installed: boolean;
  /** Every generated helper script present under the root home (key off: leftovers). */
  helperPaths: string[];
}

/** Each failed look is its own kind, so it can never render as a clean one. */
export type ClaudeDesktopStatus =
  | (DesktopStatusBase & { kind: "no-library" })
  | (DesktopStatusBase & { kind: "unreadable"; metaPath: string })
  /** The targets could not be known (Claude's settings.json unreadable or unparseable) or an owned
   *  document could not be read: no entry is judged and none may be swept as an orphan. */
  | (DesktopStatusBase & { kind: "unjudged"; reason: string })
  | (DesktopStatusBase & {
    kind: "inspected";
    libraryDir: string;
    /** Every owned entry the library lists, whatever the key says. */
    owned: DesktopOwnedEntry[];
    /** One verdict per target; empty when the key is off or the app is absent. */
    entries: DesktopEntryStatus[];
    /** Owned entries matching no target; empty when the key is off or the app is absent. */
    orphans: DesktopOwnedEntry[];
    /** Ledger claims under the library `_meta.json` no longer lists (interrupted removals),
     *  attributed like the listed entries. */
    unlisted: DesktopClaim[];
  });

/** Read-only port resolution: nothing is written or reserved. The caller supplies the targets (the
 *  default's mode lives in settings.json, read above this module); `dirOverride` as in
 *  removeAllClaudeDesktopWiring. */
export function inspectClaudeDesktopWiring(
  promised: readonly DesktopTarget[] | DesktopTargetResolution,
  dirOverride?: string | null,
): ClaudeDesktopStatus {
  const resolution: DesktopTargetResolution = "kind" in promised
    ? promised
    : { kind: "resolved", targets: promised };
  // Library facts first: with the key off or the app absent, leftovers must still show whatever the
  // targets are.
  const base = desktopStatusBase(dirOverride);
  const dir = dirOverride !== undefined ? dirOverride : resolveDesktopLibraryDir();
  if (dir === null) return { ...base, kind: "no-library" };
  const library = readOwnedLibrary(dir);
  if (library === null) return { ...base, kind: "unreadable", metaPath: join(dir, META_FILENAME) };
  // Attribution is read whatever the key says: the key-off report tells the default's entry, left
  // in place, from the leftovers by it.
  let judged: JudgedDesktopEntry[];
  let unlisted: DesktopClaim[];
  try {
    judged = library.owned.map((e) => ({ ...e, profile: entryProfileAt(e.path) }));
    unlisted = library.unlisted.map((path) => ({ path, profile: entryProfileAt(path) }));
  } catch (e) {
    return { ...base, kind: "unjudged", reason: errMessage(e) };
  }
  const status: ClaudeDesktopStatus = {
    ...base,
    kind: "inspected",
    libraryDir: dir,
    owned: judged.map((e) => ({ name: e.entry.name, path: e.path, profile: e.profile })),
    entries: [],
    orphans: [],
    unlisted,
  };
  if (!base.enabled || !base.installed) return status;
  if (resolution.kind === "unresolvable") {
    return { ...base, kind: "unjudged", reason: resolution.reason };
  }
  const rootHome = resolveRootHome();
  status.entries = resolution.targets.map((t) => ({
    ...t,
    verdict: entryVerdict(judged, t, rootHome),
  }));
  const wanted = new Set(resolution.targets.map((t) => t.profile));
  status.orphans = status.owned.filter((e) => e.profile === undefined || !wanted.has(e.profile));
  return status;
}

export function desktopStatusBase(dirOverride?: string | null): DesktopStatusBase {
  return {
    enabled: new CopilotEnvConfig().claudeDesktopEnabled(),
    installed: dirOverride !== undefined ? dirOverride !== null : claudeDesktopInstalled(),
    helperPaths: presentDesktopHelperScripts(resolveRootHome()),
  };
}

type JudgedDesktopEntry = OwnedDesktopEntry & { profile: ReturnType<typeof entryProfileAt> };

function entryVerdict(
  owned: JudgedDesktopEntry[],
  target: DesktopTarget,
  rootHome: string,
): DesktopEntryVerdict {
  const matches = owned.filter((e) => e.profile === target.profile);
  const found = matches[0];
  if (found === undefined) return { kind: "missing" };
  const path = found.path;
  const stale = (reason: string): DesktopEntryVerdict => ({ kind: "stale", path, reason });
  if (matches.length > 1) {
    // A rewire only ever touches one of them, so the repair is manual.
    return {
      kind: "stale",
      path,
      reason: `${matches.length} owned entries serve this wiring`,
      fix:
        "delete the duplicate copilot-env entries in Claude Desktop's config picker, then re-run `agent claude`",
    };
  }
  let raw: string | null;
  let doc: unknown;
  try {
    raw = readFileOrNull(path);
    if (raw === null) return stale("the config file is missing");
    doc = JSON.parse(raw);
  } catch {
    return stale("the config file could not be read or parsed");
  }
  if (!isRecord(doc)) return stale("the config file is not a JSON object");
  const expectedBase = target.mode === "direct"
    ? DEFAULT_COPILOT_API_BASE
    : proxyLoopbackOrigin(copilotApiResolvePort(target.profile));
  const gateway = doc["inferenceGatewayBaseUrl"];
  if (!sameBaseUrl(gateway, expectedBase)) {
    return stale(`gateway ${String(gateway)}, expected ${expectedBase}`);
  }
  const helper = desktopHelperPath(rootHome, target.mode, target.profile);
  const recorded = doc["inferenceCredentialHelper"];
  if (recorded !== helper) {
    return stale(`credential helper ${String(recorded)}, expected ${helper}`);
  }
  // The helper must be the body this wiring would write, and runnable; a failed look is stale,
  // never wired.
  try {
    if (readFileOrNull(helper) !== desktopHelperBody(target.mode, target.profile)) {
      return stale(`credential helper ${helper} is missing or has a stale body`);
    }
    if (!helperExecutable(helper)) return stale(`credential helper ${helper} is not executable`);
  } catch (e) {
    return stale(`credential helper ${helper} could not be checked: ${errMessage(e)}`);
  }
  // Wired means the QUIET rewire (recorded rows, the replayed identity, the live codex User-Agent,
  // no probe) would be a byte-identical no-op: the same bytes saveJsonIfChanged compares.
  const write: ManagedWrite = target.mode === "direct"
    ? { mode: "direct", directIntegrationId: expectedIntegrationId(target.profile, doc) }
    : { mode: "proxy" };
  const rewrite = desktopConfigPayload({
    ...write,
    profile: target.profile,
    baseUrl: expectedBase,
    helperPath: helper,
    models: recordedModelRows(doc) ?? undefined,
    existing: doc,
  });
  if (`${JSON.stringify(rewrite, null, 2)}\n` !== raw) {
    return stale("the managed keys drifted (a rewire would change the entry)");
  }
  const rows = doc["inferenceModels"];
  if (target.mode === "direct" && (!Array.isArray(rows) || rows.length === 0)) {
    return stale("no model rows (re-run `agent claude` online)");
  }
  return { kind: "wired", path };
}

/** The identity a rewire would bake, without probing:
 *    config pin -> the slot's persisted verdict (the replay every rewire uses)
 *    -> the header the document already carries (never probed yet) */
function expectedIntegrationId(profile: Profile, doc: Record<string, unknown>): string | null {
  const pin = new CopilotEnvConfig().pinnedIntegrationId();
  if (pin !== null) return pin;
  const slot = new CopilotEnvState().readProfileSlot(profile).integrationIdentity;
  if (slot !== null) return slot === CODEX_IDENTITY_NAME ? null : slot;
  return recordedHeader(doc, INTEGRATION_ID_HEADER);
}

function recordedHeader(doc: Record<string, unknown>, name: string): string | null {
  const headers = doc["inferenceCustomHeaders"];
  const value = isRecord(headers) ? headers[name] : undefined;
  return typeof value === "string" && value !== "" ? value : null;
}

/** A named profile repairs through its atomic re-add (mode sticky from the store). */
function desktopEntryFix(profile: Profile): string {
  return profile === null ? "agent claude" : `agent profile --add ${profile}`;
}

export function renderClaudeDesktopStatus(
  status: ClaudeDesktopStatus,
): { lines: string[]; fix: string | null } {
  if (status.kind === "unreadable") {
    return {
      lines: [`${status.metaPath} has an unexpected shape; the config library is left alone`],
      fix: `repair ${status.metaPath}, then re-run \`agent claude\``,
    };
  }
  // A failed look is reported before every other verdict: it must never render as clean.
  if (status.kind === "unjudged") {
    return {
      lines: [`${status.reason}; the Desktop entries were not judged`],
      fix: "fix the cause named above, then re-run `agent claude`",
    };
  }
  if (!status.enabled) {
    // The default's entry and helper stay by design; leftovers are the profile entries (listed or
    // not) and helper scripts an interrupted sweep can leave.
    const owned = status.kind === "inspected" ? status.owned : [];
    const unlisted = status.kind === "inspected" ? status.unlisted : [];
    const unmanaged = [
      ...owned.filter((e) => e.profile === null).map((e) =>
        `"${e.name}" present at ${e.path}, unmanaged (claude-desktop false)`
      ),
      ...unlisted.filter((c) => c.profile === null).map((c) =>
        `${c.path} present but not listed in ${META_FILENAME}, unmanaged (claude-desktop false)`
      ),
    ];
    // A claim of unknown wiring is one the key-off sweep deliberately keeps (it may be the
    // default's), so only the key-on reconcile (which removes it as an orphan) or uninstall clears
    // it.
    const claims = [...owned, ...unlisted];
    const unknown = claims.filter((c) => c.profile === undefined).map((c) => c.path);
    const left = [
      ...claims.filter((c) => c.profile !== null && c.profile !== undefined).map((c) => c.path),
      ...status.helperPaths.filter((p) => desktopHelperScriptWiring(basename(p))?.profile !== null),
    ];
    if (left.length === 0 && unknown.length === 0) {
      return {
        lines: [...unmanaged, "disabled (claude-desktop false); no copilot-env leftovers present"],
        fix: null,
      };
    }
    const total = left.length + unknown.length;
    const fixes = [
      ...(left.length > 0 ? ["agent claude"] : []),
      ...(unknown.length > 0
        ? [
          "for the entries of unknown wiring: set claude-desktop true and re-run `agent claude` (it removes them as orphans), or `agent uninstall`",
        ]
        : []),
    ];
    return {
      lines: [
        ...unmanaged,
        `disabled (claude-desktop false), but ${total} copilot-env leftover${
          total === 1 ? " remains" : "s remain"
        } (files or ownership claims)`,
        ...left,
        ...unknown.map((p) => `${p} (wiring unknown: it names no copilot-env credential helper)`),
      ],
      fix: fixes.join("; "),
    };
  }
  if (!status.installed || status.kind === "no-library") {
    return { lines: ["Claude Desktop not detected on this machine; nothing to wire"], fix: null };
  }
  if (status.entries.length === 0 && status.orphans.length === 0 && status.unlisted.length === 0) {
    return {
      lines: ["nothing to wire yet (Claude is not managed by copilot-env and no profile exists)"],
      fix: null,
    };
  }
  const lines: string[] = [];
  const fixes = new Set<string>();
  // An entry is labelled by the display name it carries in the app (the user's, possibly renamed);
  // a missing one by the name a wire would seed.
  const nameAt = (path: string) => status.owned.find((o) => o.path === path)?.name;
  for (const e of status.entries) {
    const shown = "path" in e.verdict ? nameAt(e.verdict.path) : undefined;
    const who = `"${shown ?? desktopEntryName(e.profile)}" (${e.mode})`;
    switch (e.verdict.kind) {
      case "wired":
        lines.push(`${who} wired at ${e.verdict.path}`);
        break;
      case "missing":
        lines.push(`${who} missing`);
        fixes.add(desktopEntryFix(e.profile));
        break;
      case "stale":
        lines.push(`${who} stale at ${e.verdict.path}: ${e.verdict.reason}`);
        fixes.add(e.verdict.fix ?? desktopEntryFix(e.profile));
        break;
      default:
        assertNever(e.verdict);
    }
  }
  for (const { path } of status.unlisted) {
    lines.push(
      `${path} is still claimed in the ownership ledger but no longer listed in ${META_FILENAME}${
        entryExists(path) ? "" : ", and its file is gone"
      } (an interrupted removal)`,
    );
    fixes.add("agent claude");
  }
  for (const o of status.orphans) {
    lines.push(`"${o.name}" orphaned at ${o.path} (no current wiring promises it)`);
    fixes.add("agent claude");
  }
  return { lines, fix: fixes.size === 0 ? null : [...fixes].join(", then ") };
}
