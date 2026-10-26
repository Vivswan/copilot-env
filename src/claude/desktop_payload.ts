// The entry document Claude Desktop reads: the payload the wire writes (desktop.ts) and the readers
// that attribute an existing document to a profile (the status view, the sweeps, the migrations).
// Desktop discovers models at `<gateway>/v1/models`, hardcoded: Copilot Direct 404s it, so direct
// entries carry an explicit inferenceModels list; the proxy serves it, so proxy entries discover.
import type { ManagedMode } from "../agents/configure.ts";
import { codexUserAgent } from "../codex/user_agent.ts";
import type { DesktopEffortLevel } from "../copilot_api/config_registry.ts";
import { directClientHeaders } from "../copilot_api/integration_identity.ts";
import type { ClaudeCatalogRow } from "../copilot_api/models.ts";
import {
  isValidProfileName,
  type Profile,
  type ProfileName,
  parseProfileName,
} from "../copilot_api/profile.ts";
import { MCP_SERVER_NAME } from "../mcp/server.ts";
import { isRecord, sameStrings } from "../utils/json.ts";
import { agentLauncherCommand } from "../utils/root.ts";
import { type Doc, readFileOrNull } from "./desktop_library.ts";

/** A leaf in the way is replaced, as the writers always did. */
function tableAt(doc: Doc, key: string): Doc {
  const table = isRecord(doc[key]) ? doc[key] : {};
  doc[key] = table;
  return table;
}

/** One inferenceModels row (Desktop's documented shape). */
export interface DesktopModelSpec {
  name: string;
  labelOverride: string;
  supports1m: boolean;
  prefer1m: boolean;
  anthropicFamilyTier: string;
  isFamilyDefault: boolean;
}

/** `claude-fable-5` -> `Claude Fable 5`; `claude-opus-4.8` and `claude-opus-4-8` -> `Claude Opus
 *  4.8`. Without a labelOverride the app's config editor shows the row's Display name blank. */
export function desktopModelLabel(id: string): string {
  const words: string[] = [];
  for (const token of id.split("-")) {
    const last = words[words.length - 1];
    // Only PURE 1-2 digit tokens fold into a dotted version (the model-id grammar's minor cap), so
    // "20251001" or "1m" stays its own word.
    if (/^\d{1,2}$/.test(token) && last !== undefined && /^\d+(\.\d+)*$/.test(last)) {
      words[words.length - 1] = `${last}.${token}`;
    } else {
      words.push(/^[a-z]/.test(token) ? `${token[0]?.toUpperCase()}${token.slice(1)}` : token);
    }
  }
  return words.join(" ");
}

/** The provider label Desktop shows (sidebar footer / user menu). */
export const DESKTOP_DISPLAY_NAME = "GitHub Copilot";

/** The `agent` subcommand a profile's entry spawns, `agent profile [<name>] mcp --serve`: one
 *  spelling for the writer, the two readers below, and the 4.0.9 migration's rewrite of the old
 *  shape. */
export function mcpServeArgs(profile: Profile): string[] {
  return ["profile", ...(profile === null ? [] : [profile]), "mcp", "--serve"];
}

/** The profile selector rides along so a named profile's web search resolves ITS credential (a
 *  named profile never falls back to the default). Rows are Desktop's documented managedMcpServers
 *  shape (an ARRAY; an object keyed by name is rejected as invalid_type and silently dropped).
 *  Foreign rows survive by name; a value of any other shape is our own former object and goes. */
function managedMcpServers(profile: Profile, existing: unknown): Record<string, unknown>[] {
  const { command, args } = agentLauncherCommand(mcpServeArgs(profile));
  const foreign = Array.isArray(existing)
    ? existing.filter(
        (row): row is Record<string, unknown> => isRecord(row) && row.name !== MCP_SERVER_NAME,
      )
    : [];
  return [...foreign, { name: MCP_SERVER_NAME, transport: "stdio", command: command, args: args }];
}

/** Both payload branches strip these, so a stale one outlives no mode switch or rotation. */
const MANAGED_HEADER_NAMES: readonly string[] = Object.keys(directClientHeaders("x", "x"));

/** How the entry obtains its credential. Desktop's helper is a FILE path (unlike Claude Code's
 *  inline command), so the command shape carries the script the writer produced. */
export type DesktopCredential =
  | { kind: "command"; helperPath: string }
  | { kind: "static"; token: string };

type DesktopPayloadOptions = ManagedMode & {
  /** Null is the default profile; managedMcpServers' row serves this profile's credential. */
  profile: Profile;

  /** The gateway Desktop discovers models at (`<baseUrl>/v1/models`); Copilot Direct 404s that. */
  baseUrl: string;

  /** A helper FILE path (unlike Claude Code's inline command), or the token to bake. */
  credential: DesktopCredential;

  /** The `claude.desktop-effort` preference, resolved once by the caller. */
  effort: DesktopEffortLevel;

  /** The entry's inferenceModels: Direct's whole list, a proxy entry's 1m annotations beside discovery. */
  models?: readonly DesktopModelSpec[];

  /** The entry's current document; foreign keys survive the merge. */
  existing?: Record<string, unknown>;
};

/** The one Desktop value a preview must redact. */
export const DESKTOP_SECRETS: readonly string[] = ["inferenceGatewayApiKey"];

/** The credential kind names the ONE source the app may use (a recorded helper would otherwise win
 *  over static fields), so each shape sets its own kind and deletes the other's keys. */
function writeCredentialKeys(
  doc: Doc,
  credential: DesktopCredential,
  mode: ManagedMode["mode"],
): void {
  if (credential.kind === "command") {
    doc.inferenceCredentialKind = "helper-script";
    doc.inferenceCredentialHelper = credential.helperPath;
    // The proxy helper may float and launch the daemon on first call, so it gets headroom.
    doc.inferenceCredentialHelperTimeoutSec = mode === "direct" ? 30 : 120;
    delete doc.inferenceGatewayApiKey;
    delete doc.inferenceGatewayAuthScheme;
    return;
  }
  delete doc.inferenceCredentialHelper;
  delete doc.inferenceCredentialHelperTimeoutSec;
  doc.inferenceCredentialKind = "static";
  doc.inferenceGatewayApiKey = credential.token;
  doc.inferenceGatewayAuthScheme = "bearer";
}

/** The Direct client headers, written over the managed names; user-added headers survive. */
function writeDirectKeys(doc: Doc, integrationId: string | null): void {
  // directClientHeaders OMITS the integration id when null, so a rotation to a null identity must
  // drop the stale header rather than inherit it.
  if (isRecord(doc.inferenceCustomHeaders)) {
    for (const name of MANAGED_HEADER_NAMES) delete doc.inferenceCustomHeaders[name];
  }
  const table = tableAt(doc, "inferenceCustomHeaders");
  for (const [name, value] of Object.entries(
    directClientHeaders(codexUserAgent(), integrationId),
  )) {
    table[name] = value;
  }
  // Copilot Direct 404s /v1/models -- discovery must stay off; the list is the picker.
  delete doc.modelDiscoveryEnabled;
}

/** Discovery on, and the managed Direct headers stripped from `existingHeaders` (the whole table
 *  goes when nothing foreign is left). */
function writeProxyKeys(doc: Doc, existingHeaders: unknown): void {
  // Discovery alone carries no capability metadata (anthropics/claude-code#88345: 1m models
  // silently cap at 200k), so the inferenceModels list stays as ANNOTATIONS marking 1m support.
  doc.modelDiscoveryEnabled = true;
  if (!isRecord(existingHeaders) || !isRecord(doc.inferenceCustomHeaders)) return;
  const foreign = Object.keys(existingHeaders).filter(
    (name) => !MANAGED_HEADER_NAMES.includes(name),
  );
  if (foreign.length === 0) {
    delete doc.inferenceCustomHeaders;
    return;
  }
  for (const name of MANAGED_HEADER_NAMES) delete doc.inferenceCustomHeaders[name];
}

/** Every key below is an external contract (Desktop's documented flat config vocabulary): never
 *  rename. The entry's current document with the managed keys written over it; foreign keys
 *  survive. MANAGED_HEADER_NAMES is names only (any placeholder value yields the same key set), so
 *  no UA lookup runs at import. */
export function desktopConfigPayload(opts: DesktopPayloadOptions): Record<string, unknown> {
  const existing = opts.existing ?? {};
  const doc: Doc = structuredClone(existing);
  // inferenceProvider is what activates third-party mode: without it the app treats the entry as
  // incomplete and boots into claude.ai sign-in.
  doc.inferenceProvider = "gateway";
  doc.inferenceGatewayBaseUrl = opts.baseUrl;
  writeCredentialKeys(doc, opts.credential, opts.mode);
  doc.deploymentDisplayName = DESKTOP_DISPLAY_NAME;
  doc.managedMcpServers = managedMcpServers(opts.profile, existing.managedMcpServers);
  // Every capability the app ships OFF is turned on (user decision). A switch the app already
  // ships on is not written, so an in-app change to it stands. autoModeEnabled is on for Code only
  // by default; true adds Cowork. chatTabEnabled and modelPrefer1mContext have no documented
  // unset behavior, so they stay written.
  doc.chatTabEnabled = true;
  doc.isDesktopExtensionEnabled = true;
  doc.chatAdvancedFileAnalysisEnabled = true;
  doc.autoModeEnabled = true;
  doc.builtinBrowserEnabled = true;
  // Show estimated cost in the UI, default to the 1M window (user decisions).
  doc.inferenceModelPricingEnabled = true;
  doc.modelPrefer1mContext = true;
  // The default model's starting effort in Chat, Cowork, and Code (the user's own pick for that
  // model, and Claude Code's own effort settings, still win in the app).
  doc.defaultModelEffort = opts.effort;
  // Claude.ai data import/export switches all on (user decision; the app ships them off, and
  // automatic3pImport has no documented unset behavior); leaf writes, so a hand-set field like
  // bannerBehavior survives.
  const claudeAiImport = tableAt(doc, "claudeAiImport");
  claudeAiImport.enabled = true;
  claudeAiImport.automatic3pImport = true;
  claudeAiImport.exportEnabled = true;
  // No telemetry at all (user decision), essential included.
  doc.disableEssentialTelemetry = true;
  doc.disableNonessentialTelemetry = true;
  doc.disableNonessentialServices = true;
  if (opts.mode === "direct") {
    writeDirectKeys(doc, opts.direct?.directIntegrationId ?? null);
  } else {
    writeProxyKeys(doc, existing.inferenceCustomHeaders);
  }
  // No live rows (an offline wire): the entry keeps whatever it carries; a fresh offline entry has
  // none until the first online wire.
  if (opts.models !== undefined) {
    doc.inferenceModels = opts.models.map((m) => ({
      name: m.name,
      labelOverride: m.labelOverride,
      supports1m: m.supports1m,
      prefer1m: m.prefer1m,
      anthropicFamilyTier: m.anthropicFamilyTier,
      isFamilyDefault: m.isFamilyDefault,
    }));
  }
  return doc;
}

export function desktopModelsFromPicks(
  rows: ClaudeCatalogRow[],
  labelOf?: (id: string) => string | null,
): DesktopModelSpec[] {
  return rows.map((r) => ({
    name: r.id,
    labelOverride: labelOf?.(r.id) ?? desktopModelLabel(r.id),
    supports1m: r.is1m,
    prefer1m: r.is1m,
    anthropicFamilyTier: r.family,
    isFamilyDefault: r.familyDefault,
  }));
}

/** The entry's recorded inferenceModels rows when they are OUR shape, else null (fetch). */
export function recordedModelRows(existing: Record<string, unknown>): DesktopModelSpec[] | null {
  const rows = existing.inferenceModels;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const parsed: DesktopModelSpec[] = [];
  for (const row of rows) {
    if (!isRecord(row) || typeof row.name !== "string") return null;
    parsed.push({
      name: row.name,
      // Rows written before labels existed heal on the quiet path too.
      labelOverride:
        typeof row.labelOverride === "string" && row.labelOverride !== ""
          ? row.labelOverride
          : desktopModelLabel(row.name),
      supports1m: row.supports1m === true,
      prefer1m: row.prefer1m === true,
      anthropicFamilyTier:
        typeof row.anthropicFamilyTier === "string" ? row.anthropicFamilyTier : "",
      isFamilyDefault: row.isFamilyDefault === true,
    });
  }
  return parsed;
}

/** The entry's `copilot-env` MCP row with an argv, or undefined. Exported for src/migrations/4.0.9.ts. */
export function ownMcpRow(
  doc: Record<string, unknown>,
): (Record<string, unknown> & { args: unknown[] }) | undefined {
  const servers = doc.managedMcpServers;
  const ours = Array.isArray(servers)
    ? servers.find((row) => isRecord(row) && row.name === MCP_SERVER_NAME)
    : undefined;
  if (!isRecord(ours) || !Array.isArray(ours.args)) return undefined;
  return ours as Record<string, unknown> & { args: unknown[] };
}

/** The subcommand words of an `agent` launcher argv, whichever checkout the launcher path names:
 *  on Windows the PowerShell prefix (`-NoProfile -ExecutionPolicy Bypass -File <path>`) is dropped
 *  when its flags are there, so a row written by a moved checkout still reads as ours (the ledger,
 *  not the path, says whose the entry is); on POSIX the argv is the subcommand. Exported for the
 *  migration. */
export function launcherSubcommandArgs(args: readonly unknown[]): unknown[] {
  const prefix = agentLauncherCommand([]).args;
  const fileIdx = prefix.indexOf("-File");
  if (fileIdx === -1) return [...args];
  const flagged =
    prefix.slice(0, fileIdx + 1).every((a, i) => args[i] === a) &&
    typeof args[fileIdx + 1] === "string";
  return flagged ? args.slice(prefix.length) : [...args];
}

/** The profile an entry's own MCP row serves: its subcommand is `mcpServeArgs(profile)`, so the
 *  default is the three-word shape and a named profile the four-word one with its name second.
 *  Undefined for a row of another shape, or no row of ours. */
function profileOfMcpRow(doc: Record<string, unknown>): Profile | undefined {
  const ours = ownMcpRow(doc);
  if (ours === undefined) return undefined;
  const args = launcherSubcommandArgs(ours.args);
  if (sameStrings(args, mcpServeArgs(null))) return null;
  const name = args[1];
  if (typeof name !== "string" || !isValidProfileName(name)) return undefined;
  const profile = parseProfileName(name);
  return sameStrings(args, mcpServeArgs(profile)) ? profile : undefined;
}

/** The rename's retarget of an entry's own MCP row: the row serving `from` is rewritten to serve
 *  `to`. True when a row changed. */
export function retargetEntryProfile(
  doc: Record<string, unknown>,
  from: ProfileName,
  to: ProfileName,
): boolean {
  if (profileOfMcpRow(doc) !== from) return false;
  const ours = ownMcpRow(doc);
  if (ours === undefined) return false;
  ours.args = agentLauncherCommand(mcpServeArgs(to)).args;
  return true;
}

/** Undefined when the document carries no wiring of ours (absent or damaged: no target can claim
 *  it, so it is an orphan). Attribution reads the managed MCP server's argv, the one key both
 *  credential shapes write (a static entry names no helper script). An UNREADABLE document throws:
 *  a failed look is never "not ours". */
export function entryProfileAt(path: string): Profile | undefined {
  const raw = readFileOrNull(path);
  if (raw === null) return undefined;
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return isRecord(doc) ? profileOfMcpRow(doc) : undefined;
}
