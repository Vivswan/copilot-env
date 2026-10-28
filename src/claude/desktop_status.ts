// The read-only side of the Claude Desktop wiring; desktop.ts is what writes it. `agent profile
// check --claude` and the health engine share these lines and repair commands so the two cannot
// disagree.
import { join } from "node:path";
import type { CredentialWiring, ManagedMode } from "../agents/configure.ts";
import { renderDirectWiring } from "../agents/profile_wiring.ts";
import type { DesktopEffortLevel } from "../copilot_api/config_registry.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import type { ProfileMode } from "../copilot_api/env_state.ts";
import { copilotApiResolvePort, proxyLoopbackOrigin } from "../copilot_api/port.ts";
import type { Profile } from "../copilot_api/profile.ts";
import { assertNever } from "../utils/assert.ts";
import { errMessage } from "../utils/error.ts";
import * as fs from "../utils/fs_facade.ts";
import { isRecord, sameStrings } from "../utils/json.ts";
import { type OwnedDesktopEntry, readOwnedLibrary } from "./desktop.ts";
import {
  claudeDesktopInstalled,
  type DesktopAppState,
  desktopEntryName,
  META_FILENAME,
  readDesktopAppState,
  readFileOrNull,
  resolveDesktopLibraryDir,
  sameBaseUrl,
} from "./desktop_library.ts";
import {
  type DesktopCredential,
  desktopConfigPayload,
  desktopHelperCredential,
  entryProfileAt,
  recordedModelRows,
} from "./desktop_payload.ts";

/** `mode` is what the store records: the default slot's recorded mode for the default, the named
 *  slot's mode for a profile; settings.json is an output and promises nothing. */
export interface DesktopTarget {
  profile: Profile;
  mode: ProfileMode;
}

type DesktopEntryVerdict =
  | { kind: "wired"; path: string }
  | { kind: "missing" }
  /** `fix` overrides the target's rewire command when a rewire cannot repair it. */
  | { kind: "stale"; path: string; reason: string; fix?: string };

type DesktopEntryStatus = DesktopTarget & { verdict: DesktopEntryVerdict };

/** `profile` is undefined when the document carries no copilot-env wiring (see entryProfileAt),
 *  which no target can claim. */
interface DesktopClaim {
  path: string;
  profile: Profile | undefined;
}

/** The name is the user's. An orphan is an owned entry no current target promises. */
export type DesktopOwnedEntry = DesktopClaim & { name: string };

/** An unreadable or malformed profile store is NOT "nothing is promised": that reading is what
 *  would make every entry an orphan to delete. */
export type DesktopTargetResolution =
  | { kind: "resolved"; targets: readonly DesktopTarget[] }
  | { kind: "unresolvable"; reason: string };

interface DesktopStatusBase {
  /** The `claude.desktop` key. */
  enabled: boolean;

  /** claudeDesktopInstalled's verdict; with the app absent no target gets a verdict. */
  installed: boolean;
}

/** Each failed look is its own kind, so it can never render as a clean one. */
export type ClaudeDesktopStatus =
  | (DesktopStatusBase & { kind: "no-library" })
  | (DesktopStatusBase & { kind: "unreadable"; metaPath: string })
  /** The targets could not be known (the profile store unreadable or malformed) or an owned
   *  document could not be read: no entry is judged and none may be swept as an orphan. */
  | (DesktopStatusBase & { kind: "unjudged"; reason: string })
  | (DesktopStatusBase & {
      /** The one arm with verdicts; each other arm is a look that could not judge. */
      kind: "inspected";

      /** resolveDesktopLibraryDir's answer: `_meta.json` and the entry files sit directly in it. */
      libraryDir: string;

      /** Every owned entry the library lists, whatever the key says. */
      owned: DesktopOwnedEntry[];

      /** One verdict per target; empty when the key is off or the app is absent. */
      entries: DesktopEntryStatus[];

      /** Owned entries matching no target; empty when the key is off or the app is absent. */
      orphans: DesktopOwnedEntry[];

      /** Claims `_meta.json` no longer lists (interrupted removals), attributed like the listed. */
      unlisted: DesktopClaim[];

      /** The row the app uses at launch; null when `_meta.json` names none or a missing row. */
      applied: { path: string; name: string } | null;

      /** What the app does at its next launch, read from its two app files. */
      app: DesktopAppState;
    });

/** Read-only port resolution: nothing is written or reserved. The caller supplies the targets (the
 *  default's and the profiles' modes come from the store, read above this module). */
export function inspectClaudeDesktopWiring(
  resolution: DesktopTargetResolution,
): ClaudeDesktopStatus {
  // Library facts first: with the key off or the app absent, leftovers must still show whatever the
  // targets are.
  const base = desktopStatusBase();
  const dir = resolveDesktopLibraryDir();
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
  const appliedRow = library.meta.entries.find((e) => e.id === library.meta.appliedId);
  const status: ClaudeDesktopStatus = {
    ...base,
    kind: "inspected",
    libraryDir: dir,
    owned: judged.map((e) => ({ name: e.entry.name, path: e.path, profile: e.profile })),
    entries: [],
    orphans: [],
    unlisted,
    applied:
      appliedRow === undefined
        ? null
        : { path: join(dir, `${appliedRow.id}.json`), name: appliedRow.name },
    app: readDesktopAppState(),
  };
  if (!base.enabled || !base.installed) return status;
  if (resolution.kind === "unresolvable") {
    return { ...base, kind: "unjudged", reason: resolution.reason };
  }
  // Desktop follows Claude's scope, resolved per target's profile: a rewire of that target would
  // bake this shape.
  const config = new CopilotEnvConfig();
  const effort = config.claudeDesktopEffort();
  status.entries = resolution.targets.map((t) => ({
    ...t,
    verdict: entryVerdict(
      judged,
      t,
      config.staticKeyFor("claude", t.profile) ? "static" : "command",
      effort,
    ),
  }));
  const wanted = new Set(resolution.targets.map((t) => t.profile));
  status.orphans = status.owned.filter((e) => e.profile === undefined || !wanted.has(e.profile));
  return status;
}

function desktopStatusBase(): DesktopStatusBase {
  return {
    enabled: new CopilotEnvConfig().claudeDesktopEnabled(),
    installed: claudeDesktopInstalled(),
  };
}

type JudgedDesktopEntry = OwnedDesktopEntry & { profile: ReturnType<typeof entryProfileAt> };

/** The entry's document and its bytes; a failed look is stale, never wired. */
function readEntryDocument(
  path: string,
): { raw: string; doc: Record<string, unknown> } | { stale: string } {
  let raw: string | null;
  let parsed: unknown;
  try {
    raw = readFileOrNull(path);
    parsed = raw === null ? null : JSON.parse(raw);
  } catch {
    return { stale: "the config file could not be read or parsed" };
  }
  if (raw === null) return { stale: "the config file is missing" };
  if (!isRecord(parsed)) return { stale: "the config file is not a JSON object" };
  return { raw, doc: parsed };
}

function entryVerdict(
  owned: JudgedDesktopEntry[],
  target: DesktopTarget,
  credential: CredentialWiring["kind"],
  effort: DesktopEffortLevel,
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
      fix: "delete the duplicate copilot-env entries in Claude Desktop's config picker, then re-run `agent profile sync --claude`",
    };
  }
  const read = readEntryDocument(path);
  if ("stale" in read) return stale(read.stale);
  const { raw, doc } = read;
  const gateway = doc.inferenceGatewayBaseUrl;
  // What a rewire of this target bakes: renderDirectWiring, the same overlay-over-the-slot every
  // re-render takes. A Direct slot holding no pair is stale by construction: nothing in the entry
  // may vouch for itself, and the reconcile never lands the pair (the repair command does, together
  // with both agents' files).
  const rendered = target.mode === "direct" ? renderDirectWiring(target.profile) : null;
  if (target.mode === "direct" && rendered === null) {
    return stale(
      "the slot holds no Direct pair (a credential landed since the last wiring); the repair " +
        "lands it together with both agents' files",
    );
  }
  const expectedBase =
    rendered?.directBaseUrl ?? proxyLoopbackOrigin(copilotApiResolvePort(target.profile));
  if (!sameBaseUrl(gateway, expectedBase)) {
    return stale(`gateway ${String(gateway)}, expected ${expectedBase}`);
  }
  const recordedCredential = expectedCredential(doc, target, credential);
  if ("stale" in recordedCredential) return stale(recordedCredential.stale);
  // Wired means the QUIET rewire (recorded rows, the pair above, no probe) would be a
  // byte-identical no-op: the same bytes the entry writer compares before it writes.
  const write: ManagedMode =
    rendered === null ? { mode: "proxy" } : { mode: "direct", direct: rendered };
  const rewrite = desktopConfigPayload({
    ...write,
    profile: target.profile,
    baseUrl: expectedBase,
    credential: recordedCredential,
    effort,
    models: recordedModelRows(doc) ?? undefined,
    existing: doc,
  });
  if (`${JSON.stringify(rewrite, null, 2)}\n` !== raw) {
    return stale("the managed keys drifted (a rewire would change the entry)");
  }
  const rows = doc.inferenceModels;
  if (target.mode === "direct" && (!Array.isArray(rows) || rows.length === 0)) {
    return stale("no model rows (re-run `agent profile sync --claude` online)");
  }
  return { kind: "wired", path };
}

/** The credential a rewire would bake, judged against what the document records, without resolving
 *  anything: the command shape needs the launcher and the resolver argv this wiring writes; the
 *  static shape needs the recorded key (its VALUE is never compared). */
function expectedCredential(
  doc: Record<string, unknown>,
  target: DesktopTarget,
  credential: CredentialWiring["kind"],
): DesktopCredential | { stale: string } {
  if (credential === "static") {
    if (doc.inferenceCredentialHelper !== undefined) {
      return { stale: "a credential helper is still recorded, but static-key covers Claude" };
    }
    const key = doc.inferenceGatewayApiKey;
    if (doc.inferenceCredentialKind !== "static" || typeof key !== "string" || key === "") {
      return { stale: "no static key recorded, but static-key covers Claude" };
    }
    return { kind: "static", token: key };
  }

  const expected = desktopHelperCredential(target.mode, target.profile);
  const recorded = doc.inferenceCredentialHelper;
  const recordedArgs = doc.inferenceCredentialHelperArgs;
  if (recorded !== expected.command) {
    return { stale: `credential helper ${String(recorded)}, expected ${expected.command}` };
  }
  if (!Array.isArray(recordedArgs) || !sameStrings(recordedArgs, expected.args)) {
    return {
      stale: `credential helper arguments ${JSON.stringify(recordedArgs)}, expected ${JSON.stringify(expected.args)}`,
    };
  }
  return expected;
}

/** A named profile repairs through its atomic re-add (mode sticky from the store); a flag-less
 *  `agent profile sync --claude` re-renders the default's recorded mode. */
function desktopEntryFix(profile: Profile): string {
  return profile === null ? "agent profile sync --claude" : `agent profile ${profile} add`;
}

type InspectedDesktopStatus = Extract<ClaudeDesktopStatus, { kind: "inspected" }>;

/** The lines and repair commands a render gathers; the fixes keep their first-seen order. */
interface StatusReport {
  lines: string[];
  fixes: Set<string>;
}

/** The key-off render. The default's entry stays by design; leftovers are the profile entries
 *  (listed or not) an interrupted sweep can leave. */
function renderDisabledStatus(
  status: Extract<ClaudeDesktopStatus, { kind: "no-library" | "inspected" }>,
): { lines: string[]; fix: string | null } {
  const owned = status.kind === "inspected" ? status.owned : [];
  const unlisted = status.kind === "inspected" ? status.unlisted : [];
  const unmanaged = [
    ...owned
      .filter((e) => e.profile === null)
      .map((e) => `"${e.name}" present at ${e.path}, unmanaged (claude.desktop false)`),
    ...unlisted
      .filter((c) => c.profile === null)
      .map(
        (c) =>
          `${c.path} present but not listed in ${META_FILENAME}, unmanaged (claude.desktop false)`,
      ),
  ];
  // A claim of unknown wiring is one the key-off sweep deliberately keeps (it may be the
  // default's), so only the key-on reconcile (which removes it as an orphan) or uninstall clears
  // it.
  const claims = [...owned, ...unlisted];
  const unknown = claims.filter((c) => c.profile === undefined).map((c) => c.path);
  const left = claims
    .filter((c) => c.profile !== null && c.profile !== undefined)
    .map((c) => c.path);
  if (left.length === 0 && unknown.length === 0) {
    return {
      lines: [...unmanaged, "disabled (claude.desktop false); no copilot-env leftovers present"],
      fix: null,
    };
  }
  const total = left.length + unknown.length;
  const fixes: string[] = [];
  if (left.length > 0) fixes.push("agent profile sync --claude");
  if (unknown.length > 0) {
    fixes.push(
      "for the entries of unknown wiring: set claude.desktop true and re-run `agent profile sync --claude` (it removes them as orphans), or `agent uninstall`",
    );
  }
  return {
    lines: [
      ...unmanaged,
      `disabled (claude.desktop false), but ${total} copilot-env leftover${
        total === 1 ? " remains" : "s remain"
      } (files or ownership claims)`,
      ...left,
      ...unknown.map((p) => `${p} (wiring unknown: it carries no copilot-env wiring)`),
    ],
    fix: fixes.join("; "),
  };
}

/** An entry is labelled by the display name it carries in the app (the user's, possibly renamed);
 *  a missing one by the name a wire would seed. */
function shownEntryName(status: InspectedDesktopStatus, path: string): string | undefined {
  return status.owned.find((o) => o.path === path)?.name;
}

function renderEntries(status: InspectedDesktopStatus, report: StatusReport): void {
  for (const e of status.entries) {
    const shown = "path" in e.verdict ? shownEntryName(status, e.verdict.path) : undefined;
    const who = `"${shown ?? desktopEntryName(e.profile)}" (${e.mode})`;
    switch (e.verdict.kind) {
      case "wired":
        report.lines.push(`${who} wired at ${e.verdict.path}`);
        break;
      case "missing":
        report.lines.push(`${who} missing`);
        report.fixes.add(desktopEntryFix(e.profile));
        break;
      case "stale":
        report.lines.push(`${who} stale at ${e.verdict.path}: ${e.verdict.reason}`);
        report.fixes.add(e.verdict.fix ?? desktopEntryFix(e.profile));
        break;
      default:
        assertNever(e.verdict);
    }
  }
}

/** The two app files read at launch: deploymentMode and Developer Mode. */
function renderAppFiles(
  status: InspectedDesktopStatus,
  hasExistingEntry: boolean,
  report: StatusReport,
): void {
  if (status.app.kind === "unreadable") {
    report.lines.push(
      `${status.app.path} is ${status.app.reason}; what the app reads from it is unknown`,
    );
    report.fixes.add(`repair ${status.app.path}, then re-run \`agent profile sync --claude\``);
    return;
  }
  if (!hasExistingEntry) return;
  if (status.app.deploymentMode !== "3p") {
    report.lines.push(
      `the app will show the sign-in chooser at launch (deploymentMode ${
        status.app.deploymentMode ?? "unset"
      })`,
    );
    report.fixes.add("agent profile sync --claude");
  }
  if (!status.app.developerMode) {
    report.lines.push("Developer Mode is off (no Developer menu)");
    report.fixes.add("agent profile sync --claude");
  }
}

/** The `_meta.json` applied slot: empty, one of ours, or the user's own config. */
function renderAppliedSlot(
  status: InspectedDesktopStatus,
  hasExistingEntry: boolean,
  report: StatusReport,
): void {
  const applied = status.applied;
  if (applied === null) {
    if (hasExistingEntry) {
      report.lines.push("no entry is applied in the app");
      report.fixes.add("agent profile sync --claude");
    }
    return;
  }
  if (status.owned.some((o) => o.path === applied.path)) {
    if (hasExistingEntry) report.lines.push(`applied in the app: "${applied.name}"`);
    return;
  }
  // The switch is the user's to make, to an entry a CURRENT target promises (the default's
  // when promised, else the first profile's), by the name the app shows for it. An entry that
  // does not exist yet has no name to give: its wire may adopt a same-gateway entry under
  // THAT entry's name, so the switch is named once the entry is there.
  report.lines.push(`the app applies "${applied.name}" (not a copilot-env entry)`);
  const target = status.entries.find((e) => e.profile === null) ?? status.entries[0];
  if (target !== undefined && "path" in target.verdict) {
    report.fixes.add(
      `in Claude Desktop (reopened): Developer > Configure Third-Party Inference..., select "${
        shownEntryName(status, target.verdict.path) ?? desktopEntryName(target.profile)
      }", Save & Restart`,
    );
  } else {
    report.fixes.add(
      "after that wire, `agent profile check --claude` names the entry to select in Claude Desktop",
    );
  }
}

/** The claims no current target explains: an interrupted removal's unlisted claims and the
 *  orphans. */
function renderLeftovers(status: InspectedDesktopStatus, report: StatusReport): void {
  for (const { path } of status.unlisted) {
    report.lines.push(
      `${path} is still claimed in the ownership ledger but no longer listed in ${META_FILENAME}${
        fs.entryAbsent(path) ? ", and its file is gone" : ""
      } (an interrupted removal)`,
    );
    report.fixes.add("agent profile sync --claude");
  }
  for (const o of status.orphans) {
    report.lines.push(`"${o.name}" orphaned at ${o.path} (no current wiring promises it)`);
    report.fixes.add("agent profile sync --claude");
  }
}

export function renderClaudeDesktopStatus(status: ClaudeDesktopStatus): {
  lines: string[];
  fix: string | null;
} {
  if (status.kind === "unreadable") {
    return {
      lines: [`${status.metaPath} has an unexpected shape; the config library is left alone`],
      fix: `repair ${status.metaPath}, then re-run \`agent profile sync --claude\``,
    };
  }
  // A failed look is reported before every other verdict: it must never render as clean.
  if (status.kind === "unjudged") {
    return {
      lines: [`${status.reason}; the Desktop entries were not judged`],
      fix: "fix the cause named above, then re-run `agent profile sync --claude`",
    };
  }
  if (!status.enabled) return renderDisabledStatus(status);
  if (!status.installed || status.kind === "no-library") {
    return { lines: ["Claude Desktop not detected on this machine; nothing to wire"], fix: null };
  }
  if (status.entries.length === 0 && status.orphans.length === 0 && status.unlisted.length === 0) {
    return {
      lines: ["nothing to wire yet (Claude is not managed by copilot-env and no profile exists)"],
      fix: null,
    };
  }

  const report: StatusReport = { lines: [], fixes: new Set() };
  renderEntries(status, report);
  if (status.entries.length > 0) {
    // App-side facts. What a rewire WRITES (deploymentMode, Developer Mode, an empty applied slot)
    // is reported once an entry exists (wired or stale): a missing entry's own fix writes them. What a rewire
    // LEAVES ALONE (an unreadable app file, a user's own applied config) is reported whatever the
    // entries say, since no rewire is the repair. The app files come first in the fixes: the
    // in-app switch needs the Developer menu they turn on.
    const hasExistingEntry = status.entries.some((e) => e.verdict.kind !== "missing");
    renderAppFiles(status, hasExistingEntry, report);
    renderAppliedSlot(status, hasExistingEntry, report);
  }
  renderLeftovers(status, report);

  return {
    lines: report.lines,
    fix: report.fixes.size === 0 ? null : [...report.fixes].join(", then "),
  };
}
