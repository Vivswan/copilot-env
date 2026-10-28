// The Claude Desktop reconcile: one entry per wired profile in the app's config library, derived on
// every pass from the `claude.desktop` key and the ownership ledger; a sweep never removes an entry
// it does not own. The files themselves are desktop_library.ts, the entry document
// desktop_payload.ts.
import { isAbsolute, join, relative, sep } from "node:path";
import { type ManagedMode, type ManagedWrite, reservePlannedPort } from "../agents/configure.ts";
import { codexUserAgent } from "../codex/user_agent.ts";
import { fetchRawModels } from "../copilot_api/catalog.ts";
import { Credential } from "../copilot_api/credential.ts";
import { staticKeyDetail } from "../copilot_api/credential_detail.ts";
import { discoverServableClaudeModels } from "../copilot_api/discovery.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { DEFAULT_COPILOT_API_BASE, type ProbeFetch } from "../copilot_api/integration_identity.ts";
import {
  claudeCatalogRows,
  ONE_M_SUFFIX,
  parseCatalogModels,
  parseModelList,
} from "../copilot_api/models.ts";
import { OwnershipLedger } from "../copilot_api/ownership.ts";
import { CopilotApiPaths } from "../copilot_api/paths.ts";
import { copilotApiResolvePort, proxyLoopbackOrigin } from "../copilot_api/port.ts";
import { type Profile, profileKey, profileLabel } from "../copilot_api/profile.ts";
import * as fs from "../utils/fs_facade.ts";
import { isRecord, parseJsonRecord } from "../utils/json.ts";
import { createStderrLogger } from "../utils/logger.ts";
import { caught, scannable } from "../utils/message.ts";
import {
  claudeDesktopInstalled,
  type DesktopMeta,
  type DesktopMetaEntry,
  desktopEntryName,
  META_FILENAME,
  parseDesktopMeta,
  prepareClaudeDesktopAppFiles,
  readFileOrNull,
  removeFile,
  resolveDesktopLibraryDir,
  sameBaseUrl,
  writeDesktopMeta,
  writeJson,
} from "./desktop_library.ts";
import {
  DESKTOP_SECRETS,
  type DesktopCredential,
  type DesktopModelSpec,
  desktopConfigPayload,
  desktopHelperCredential,
  desktopModelsFromPicks,
  entryProfileAt,
  recordedModelRows,
} from "./desktop_payload.ts";
import type { DesktopOwnedEntry } from "./desktop_status.ts";

// Narration goes to stderr, like every writer's, so no stdout contract ever picks it up.
const logger = createStderrLogger();

/** How a removal's report names an entry file. */
const ENTRY = "Claude Desktop entry";

/** A new entry's uuid, kept from the preview to the wire while free, so both name the same file. */
const mintedEntryIds = new Map<string, string>();

function mintedEntryId(dir: string, profile: Profile, free: (id: string) => boolean): string {
  const key = `${dir}|${profileKey(profile)}`;
  const remembered = mintedEntryIds.get(key);
  const id = remembered !== undefined && free(remembered) ? remembered : crypto.randomUUID();
  mintedEntryIds.set(key, id);
  return id;
}

export type DesktopWireOptions = ManagedWrite & {
  /** Null is the default profile; it names the entry and the resolver the entry runs. */
  profile: Profile;

  /** Direct only: credential for the catalog fetch (never re-resolved when given). */
  directToken?: string | null;

  /** The launcher hot path: no discovery (its probes are billed requests) and no notices. */
  quiet?: boolean;

  /** Test seam, threaded to fetchRawModels. */
  fetchImpl?: ProbeFetch;
};

/** The same parse `agent profile models` renders: one pipeline for both surfaces. */
function labelLookup(body: unknown): (id: string) => string | null {
  const names = new Map<string, string>();
  try {
    for (const entry of parseModelList(body)) {
      const base = entry.id.endsWith(ONE_M_SUFFIX)
        ? entry.id.slice(0, -ONE_M_SUFFIX.length)
        : entry.id;
      if (entry.name !== null && !names.has(base)) names.set(base, entry.name);
    }
  } catch {
    // No labels is only a cosmetic loss; ids still synthesize labels.
  }
  return (id) => names.get(id) ?? null;
}

/** The Direct credential the catalog fetch uses: the caller's token, else a static key's, else
 *  the slot's own resolution. Throws with the slot's reason when none resolves. */
function directWiringToken(opts: DesktopWireOptions): string {
  if (typeof opts.directToken === "string") return opts.directToken;
  if (opts.credential.kind === "static") return opts.credential.token;
  const resolved = new Credential(undefined, opts.profile).resolveWithReason();
  if (resolved.token === null) throw new Error(resolved.reason);
  return resolved.token;
}

/** The direct arm: the full discovery pipeline (src/copilot_api/discovery.ts) under the wiring's
 *  own identity, so unadvertised-but-servable models get a PROBED 1m verdict. */
async function directWiringModels(
  opts: DesktopWireOptions,
): Promise<readonly DesktopModelSpec[] | undefined> {
  try {
    const discovered = await discoverServableClaudeModels(
      directWiringToken(opts),
      codexUserAgent(),
      opts.direct?.directIntegrationId ?? null,
      opts.direct?.directBaseUrl ?? DEFAULT_COPILOT_API_BASE,
      { fetchImpl: opts.fetchImpl },
    );
    const rows = claudeCatalogRows(discovered.models);
    if (rows.length === 0) return undefined;
    return desktopModelsFromPicks(rows, labelLookup(discovered.catalogBody));
  } catch (e) {
    logger.warn(caught(e, (message) => `  Claude Desktop: model discovery failed (${message}).`));
    return undefined;
  }
}

/** The proxy arm: what the daemon's /v1/models will discover, its catalog first, Copilot when
 *  down. */
async function proxyWiringModels(
  opts: DesktopWireOptions,
): Promise<readonly DesktopModelSpec[] | undefined> {
  for (const source of ["proxy", "direct"] as const) {
    try {
      const body = await fetchRawModels(source, {
        directToken: opts.directToken ?? undefined,
        profile: opts.profile,
        fetchImpl: opts.fetchImpl,
      });
      const rows = claudeCatalogRows(parseCatalogModels(body));
      if (rows.length > 0) return desktopModelsFromPicks(rows, labelLookup(body));
    } catch (e) {
      logger.warn(
        caught(
          e,
          (message) =>
            `  Claude Desktop: could not fetch the ${source} model catalog (${message}).`,
        ),
      );
    }
  }
  return undefined;
}

/** Undefined when no live data exists: the caller then leaves an existing entry's rows untouched
 *  and refuses to create a fresh direct one. Each mode shows what its own backend will actually
 *  serve. */
async function wiringModels(
  opts: DesktopWireOptions,
): Promise<readonly DesktopModelSpec[] | undefined> {
  const models =
    opts.mode === "direct" ? await directWiringModels(opts) : await proxyWiringModels(opts);
  if (models === undefined) {
    logger.warn(
      "  Claude Desktop: no live model data; leaving the entry's model rows as they are.",
    );
  }
  return models;
}

/** The gateway the entry names. The text PEEKS a proxy port; the write reserves it
 *  (reservePlannedPort), so the peeked port rides along. */
function plannedGateway(opts: DesktopWireOptions): { plannedPort: string | null; baseUrl: string } {
  if (opts.mode === "proxy") {
    const plannedPort = copilotApiResolvePort(opts.profile);
    return { plannedPort, baseUrl: proxyLoopbackOrigin(plannedPort) };
  }
  return { plannedPort: null, baseUrl: opts.direct?.directBaseUrl ?? DEFAULT_COPILOT_API_BASE };
}

/** `<id>.json`: the one entry file an index row names. */
function entryConfigPath(dir: string, id: string): string {
  return join(dir, `${id}.json`);
}

/** The library index, parsed; null after the warning when it cannot be judged, so the caller
 *  leaves the library alone. A missing file is an empty library. */
function readDesktopMetaOrWarn(dir: string): { raw: string | null; meta: DesktopMeta } | null {
  const metaPath = join(dir, META_FILENAME);
  const raw = readFileOrNull(metaPath);
  const meta = parseDesktopMeta(raw);
  if (meta === null) {
    logger.warn(
      `  Claude Desktop: ${metaPath} has an unexpected shape; leaving the config library alone.`,
    );
    return null;
  }
  return { raw, meta };
}

/** The library a wire lands in, judged once per pass; `baseUrl` is the gateway the entry names,
 *  so a foreign entry at the same one is adoptable. */
interface WireLibrary {
  dir: string;
  meta: DesktopMeta;
  ledger: OwnershipLedger;
  baseUrl: string;
}

/** The entry a wire lands on: `owned` when the ledger already claims it (a re-render records no
 *  new claim), `created` when minted now (its index row is added once the wire is sure to land). */
interface LocatedEntry {
  entry: DesktopMetaEntry;
  owned: boolean;
  created: boolean;
}

/** A foreign entry at the same gateway, taken over under its uuid and name; undefined when there
 *  is none. */
function adoptableEntry(
  library: WireLibrary,
  opts: DesktopWireOptions,
): DesktopMetaEntry | undefined {
  for (const candidate of library.meta.entries) {
    const path = entryConfigPath(library.dir, candidate.id);
    if (library.ledger.owns("claudeDesktop", path)) continue;
    const raw = readFileOrNull(path);
    if (raw === null) continue;
    // Malformed is foreign, never adopted.
    const doc = parseJsonRecord(raw);
    if (doc === null || !sameBaseUrl(doc.inferenceGatewayBaseUrl, library.baseUrl)) continue;
    if (!opts.quiet) {
      logger.info(
        `  Claude Desktop: adopting the existing "${candidate.id}" entry (same gateway).`,
      );
    }
    return candidate;
  }
  return undefined;
}

/**
 * The entry a wire lands on, in this order:
 *   ours (an owned path whose document names `profile`)
 *   -> adoptable (a foreign entry at the same gateway, taken over under its uuid and name)
 *   -> a foreign namesake (warn, never clobber)
 *   -> a fresh uuid
 * A foreign namesake at a DIFFERENT gateway (a same-gateway one was adopted above) is never
 * clobbered or twinned, so the wire returns null there. An owned namesake is the user's rename of
 * another wiring's entry.
 */
function locateDesktopEntry(library: WireLibrary, opts: DesktopWireOptions): LocatedEntry | null {
  const { dir, meta, ledger } = library;
  const name = desktopEntryName(opts.profile);

  const ours = meta.entries.find(
    (e) =>
      ledger.owns("claudeDesktop", entryConfigPath(dir, e.id)) &&
      entryProfileAt(entryConfigPath(dir, e.id)) === opts.profile,
  );
  if (ours !== undefined) return { entry: ours, owned: true, created: false };

  const adopted = adoptableEntry(library, opts);
  if (adopted !== undefined) return { entry: adopted, owned: false, created: false };

  const foreignNamesake = meta.entries.some(
    (e) => e.name === name && !ledger.owns("claudeDesktop", entryConfigPath(dir, e.id)),
  );
  if (foreignNamesake) {
    logger.warn(
      `  Claude Desktop: a config entry named "${name}" already exists and is not ours; leaving it alone.`,
    );
    return null;
  }

  const id = mintedEntryId(
    dir,
    opts.profile,
    (id) => !meta.entries.some((e) => e.id === id) && fs.entryAbsent(entryConfigPath(dir, id)),
  );
  return { entry: { id, name, extra: {} }, owned: false, created: true };
}

/** The entry's current document; unparseable content under our path (an in-app edit racing us)
 *  is rebuilt. */
function existingEntryDocument(configPath: string): {
  raw: string | null;
  doc: Record<string, unknown>;
} {
  const raw = readFileOrNull(configPath);
  if (raw === null) return { raw, doc: {} };
  return { raw, doc: parseJsonRecord(raw) ?? {} };
}

/** The launcher hot path (quiet) must NEVER run discovery: its probes are billed requests. It
 *  reuses the recorded rows; `agent init`, `agent profile <name> add`, and `agent profile sync
 *  --claude` refresh live. */
async function entryModels(
  opts: DesktopWireOptions,
  owned: boolean,
  existing: Record<string, unknown>,
): Promise<readonly DesktopModelSpec[] | undefined> {
  if (!opts.quiet) return await wiringModels(opts);
  if (!owned) return undefined;
  return recordedModelRows(existing) ?? undefined;
}

/** What one wire writes: the entry document and the line announcing the wiring. */
interface DesktopEntryWrite {
  wiring: string;
  payload: Record<string, unknown>;
}

function plannedEntryWrite(
  opts: DesktopWireOptions,
  entry: DesktopMetaEntry,
  baseUrl: string,
  models: readonly DesktopModelSpec[] | undefined,
  existing: Record<string, unknown>,
): DesktopEntryWrite {
  const credential: DesktopCredential =
    opts.credential.kind === "static"
      ? opts.credential
      : desktopHelperCredential(opts.mode, opts.profile);
  // Re-extracted so the payload receives the Direct facts only alongside a direct mode.
  const write: ManagedMode =
    opts.mode === "direct" ? { mode: "direct", direct: opts.direct } : { mode: "proxy" };
  // The write's own line announces the wiring.
  const staticClause =
    credential.kind === "command" ? "" : `; ${staticKeyDetail(opts.mode, opts.profile)}`;
  const wiring = `${ENTRY} "${entry.name}" (${opts.mode}) wired${staticClause}`;
  const payload = desktopConfigPayload({
    ...write,
    profile: opts.profile,
    baseUrl,
    credential,
    effort: new CopilotEnvConfig().claudeDesktopEffort(),
    models,
    existing,
  });
  return { wiring, payload };
}

/** An applied slot that is empty, or names a row the library no longer lists, is ours to fill; a
 *  slot naming a live entry (a user's own config) is never displaced. */
function fillAppliedSlot(meta: DesktopMeta, entry: DesktopMetaEntry): void {
  if (meta.entries.some((e) => e.id === meta.appliedId)) return;
  meta.appliedId = entry.id;
}

/**
 * The entry wire. Throws on real read failures; syncClaudeDesktopWiring is the best-effort face.
 * `appliedId` is only ever SET when the library had none: an applied user config is never
 * displaced.
 */
export async function wireClaudeDesktopEntry(opts: DesktopWireOptions): Promise<void> {
  const dir = resolveDesktopLibraryDir();
  if (dir === null || !claudeDesktopInstalled()) return;

  const { plannedPort, baseUrl } = plannedGateway(opts);
  const index = readDesktopMetaOrWarn(dir);
  if (index === null) return;
  const { raw: metaRaw, meta } = index;
  const ledger = new OwnershipLedger();
  const located = locateDesktopEntry({ dir, meta, ledger, baseUrl }, opts);
  if (located === null) return;
  const { entry, owned, created } = located;

  const configPath = entryConfigPath(dir, entry.id);
  const { raw: existingRaw, doc: existing } = existingEntryDocument(configPath);
  const models = await entryModels(opts, owned, existing);

  // A FRESH direct entry without model data would have neither discovery (Copilot 404s /v1/models)
  // nor a picker, so it is not created at all; an existing entry keeps its recorded rows.
  if (created && opts.mode === "direct" && models === undefined) {
    logger.warn(
      "  Claude Desktop: no model data available; not creating an unusable direct entry (re-run online).",
    );
    return;
  }
  if (created) meta.entries.push(entry);

  const write = plannedEntryWrite(opts, entry, baseUrl, models, existing);
  fillAppliedSlot(meta, entry);

  // The post-save step takes its look before the first wiring write.
  const appFiles = prepareClaudeDesktopAppFiles();
  // Reserved now that everything is computed: a refusal above leaves no reservation behind.
  if (plannedPort !== null) reservePlannedPort(opts.profile, plannedPort);
  // The order is the safety: config, then meta; the ownership claim and the app files follow.
  //   config without its meta row  -> invisible junk
  //   meta row without its config  -> a broken picker row
  //   claim before the save        -> a claim on an entry that was never written
  const configWritten = writeJson(
    configPath,
    existingRaw,
    write.payload,
    `${write.wiring}; restart Claude Desktop to pick it up`,
    DESKTOP_SECRETS,
  );
  // A byte-identical no-op states the wiring instead, unless quiet (the launcher hot path).
  if (!configWritten && !opts.quiet) {
    logger.success(`  ${write.wiring} at ${configPath} already.`);
  }
  writeDesktopMeta(dir, metaRaw, meta);
  // Only a NEW claim is recorded, so the ledger write is a real change, never a byte-identical
  // one. The app files land on their own, after the claim, so a failure there leaves a complete,
  // OWNED entry.
  if (!owned) ledger.record("claudeDesktop", configPath);
  appFiles();
}

/** The lenient store reader degrades any other shape to "no profiles", which would make every named
 *  entry an orphan to delete, so every removal decision checks this first and touches nothing when
 *  it fails. */
export function profileStoreWellFormed(storeFile: string): boolean {
  const read = fs.readTextResult(storeFile);
  if (read.kind === "absent") return true;
  if (read.kind === "unreadable") throw new Error(`could not read ${storeFile}: ${read.error}`);
  if (read.text.trim() === "") return true; // the canonical reader's empty store
  let doc: unknown;
  try {
    doc = JSON.parse(read.text);
  } catch {
    return false;
  }
  if (!isRecord(doc)) return false;
  const profiles = doc.profiles;
  return profiles === undefined || (isRecord(profiles) && Object.values(profiles).every(isRecord));
}

/** Best-effort: a Desktop failure warns, never fails the caller. Key off leaves the default's
 *  entry alone and says nothing, because the whole-library reconcile in
 *  src/agents/claude_desktop.ts names it once and the launcher's default repair stays quiet.
 *
 *    key on                    -> upserts `profile`'s entry
 *    key off, named profile    -> removes that entry
 *    key off, malformed store  -> warns, touches nothing (the guard that sweep sits behind too)
 */
export async function syncClaudeDesktopWiring(opts: DesktopWireOptions): Promise<void> {
  try {
    await syncClaudeDesktopWiringOrThrow(opts);
  } catch (e) {
    logger.warn(
      caught(
        e,
        (message) =>
          `  Could not wire Claude Desktop for ${profileLabel(opts.profile)}: ${message}`,
      ),
    );
  }
}

async function syncClaudeDesktopWiringOrThrow(opts: DesktopWireOptions): Promise<void> {
  // The one store holds the key AND the profiles: judged once, before either is read.
  const storeFile = new CopilotApiPaths().stateStoreFile;
  if (!profileStoreWellFormed(storeFile)) {
    logger.warn(
      `  Claude Desktop: the state store ${storeFile} is malformed; leaving the config library alone.`,
    );
    return;
  }
  if (new CopilotEnvConfig().claudeDesktopEnabled()) {
    await wireClaudeDesktopEntry(opts);
    return;
  }
  if (opts.profile === null) return;
  removeClaudeDesktopEntry(opts.profile);
}

/** A foreign entry, even one carrying our name, is never touched. Best-effort. */
export function removeClaudeDesktopEntry(profile: Profile): void {
  const selects = (e: OwnedDesktopEntry): boolean => entryProfileAt(e.path) === profile;
  removeOwned(`the Claude Desktop entry for ${profileLabel(profile)}`, selects);
}

/** Best-effort. */
export function removeClaudeDesktopOrphan(orphan: DesktopOwnedEntry): void {
  removeOwned(`the orphaned Claude Desktop entry at ${orphan.path}`, (e) => e.path === orphan.path);
}

/** A failed removal is warned about, and its ownership stays with the entry it did not remove
 *  (the claims go last). */
function removeOwned(what: string, selects: (owned: OwnedDesktopEntry) => boolean): void {
  try {
    const entries = sweepOwnedEntries(selects);
    if (entries.kind === "blocked") return;
    releaseClaims(entries.removed);
  } catch (e) {
    logger.warn(caught(e, (message) => `  Could not remove ${what}: ${message}`));
  }
}

function releaseClaims(paths: readonly string[]): void {
  const ledger = new OwnershipLedger();
  for (const path of paths) ledger.release("claudeDesktop", path);
}

/** The uninstall sweep. */
export function removeAllClaudeDesktopWiring(
  artifacts: ClaudeDesktopOwnedArtifacts = listClaudeDesktopOwnedArtifacts(),
): void {
  // `artifacts` is the plan uninstall rendered as its dry run: exactly those paths go, so a claim
  // that appeared after planning stays.
  if (artifacts.blocked) {
    // The live run leaves the library silently; the preview names the consequence, since the plan
    // has no row to carry it.
    if (fs.dryRunActive()) {
      logger.warn(
        scannable({
          headline: "Would leave Claude Desktop's config library alone.",
          evidence: [
            "_meta.json unreadable or unparsable",
            "its copilot-env entries left pointing at the agent launcher the uninstall removes",
          ],
        }),
      );
    }
    return;
  }
  const planned = new Set([...artifacts.entries, ...artifacts.staleClaims]);
  const entries = sweepOwnedEntries((owned) => planned.has(owned.path));
  if (entries.kind === "blocked") return;
  releaseClaims(entries.removed);
  removeUnlistedClaudeDesktopClaims((path) => planned.has(path));
}

/** The `claude.desktop false` sweep. Fail closed: only a claim POSITIVELY attributed to a named
 *  profile goes, since anything else may be the default's. */
export function removeUnmanagedClaudeDesktopWiring(opts: { quiet?: boolean } = {}): void {
  const sweepable = (path: string): boolean => {
    let profile: Profile | undefined;
    try {
      profile = entryProfileAt(path);
    } catch (e) {
      logger.warn(caught(e, (message) => `  Claude Desktop: ${message}; left alone.`));
      return false;
    }
    if (profile === undefined) {
      logger.warn(
        `  Claude Desktop: ${path} carries no copilot-env wiring, so its profile is unknown; left alone.`,
      );
    }
    return profile !== undefined && profile !== null;
  };
  // Every look before the first write: the unlisted claims are judged over the library as it
  // stands, and a listing that fails leaves it untouched.
  const unlisted = unlistedClaims(sweepable);
  const entries = sweepOwnedEntries((e) => sweepable(e.path));
  if (entries.kind === "blocked") return;
  if (unlisted.kind === "listed") {
    for (const path of unlisted.paths) removeFile(path, ENTRY);
  }
  if (!opts.quiet) announceUnmanagedDefault();
  releaseClaims(entries.removed);
  if (unlisted.kind === "listed") releaseClaims(unlisted.paths);
}

/** Name every claim the key-off sweep leaves as the default's, so the user knows it is theirs now
 *  and nothing was rewritten. One that could not be attributed is skipped: the sweep already
 *  warned. */
function announceUnmanagedDefault(): void {
  const dir = resolveDesktopLibraryDir();
  const library = dir === null ? null : readOwnedLibrary(dir);
  if (library === null) return;
  const claims = [
    ...library.owned.map((e) => [`"${e.entry.name}" at ${e.path}`, e.path] as const),
    ...library.unlisted.map((p) => [`${p} (not listed in ${META_FILENAME})`, p] as const),
  ];
  for (const [label, path] of claims) {
    try {
      if (entryProfileAt(path) !== null) continue;
    } catch {
      continue;
    }
    logger.info(`  Claude Desktop: ${label} left in place, unmanaged (claude.desktop false).`);
  }
}

/** What removeAllClaudeDesktopWiring removes and the uninstall dry run names. Read-only.
 *    entries      -> owned config files present (listed and unlisted claims alike)
 *    staleClaims  -> owned paths whose file is gone (their _meta.json row and claim still go)
 *    metaRewrite  -> the `_meta.json` path when removing the listed owned rows will rewrite it
 *                    (null: nothing listed is ours); outside our homes, so the dry run names the
 *                    rewrite like the live sweep
 *    blocked      -> a not-understood _meta.json; the library is left alone */
export interface ClaudeDesktopOwnedArtifacts {
  entries: string[];
  staleClaims: string[];
  metaRewrite: string | null;
  blocked: boolean;
}

export function listClaudeDesktopOwnedArtifacts(): ClaudeDesktopOwnedArtifacts {
  const dir = resolveDesktopLibraryDir();
  const none = { entries: [], staleClaims: [], metaRewrite: null };
  if (dir === null) return { ...none, blocked: false };
  const library = readOwnedLibrary(dir);
  if (library === null) return { ...none, blocked: true };
  // One look per path: a file appearing or vanishing between two looks would land in neither list
  // or both.
  const entries: string[] = [];
  const staleClaims: string[] = [];
  for (const path of [...library.owned.map((e) => e.path), ...library.unlisted]) {
    (fs.entryAbsent(path) ? staleClaims : entries).push(path);
  }
  return {
    entries,
    staleClaims,
    metaRewrite: library.owned.length > 0 ? join(dir, META_FILENAME) : null,
    blocked: false,
  };
}

export interface OwnedDesktopEntry {
  entry: DesktopMetaEntry;
  path: string;
}

interface OwnedLibrary {
  /** The parsed `_meta.json`, every row ours or not, so a save keeps the foreign ones. */
  meta: DesktopMeta;

  /** The listed rows whose entry file the ledger claims, each with its path. */
  owned: OwnedDesktopEntry[];

  /** Claims `_meta.json` no longer lists: an interrupted removal's leftovers, file there or not. */
  unlisted: string[];
}

/** DIRECT entry files of `dir` only (`<id>.json`, one segment down; a trailing separator on `dir`
 *  or a nested path changes nothing), as one snapshot: one ledger read, not one per row. */
function claimsUnder(ledger: OwnershipLedger, dir: string): Set<string> {
  return new Set(
    ledger.ownedPaths("claudeDesktop").filter((p) => {
      const rel = relative(dir, p);
      return (
        rel !== "" &&
        !isAbsolute(rel) &&
        !rel.startsWith("..") &&
        !rel.includes(sep) &&
        rel.endsWith(".json")
      );
    }),
  );
}

/** Null when _meta.json is unreadable or not understood (nothing can be judged or swept); a missing
 *  _meta.json is an empty library. */
export function readOwnedLibrary(dir: string): OwnedLibrary | null {
  let raw: string | null;
  try {
    raw = readFileOrNull(join(dir, META_FILENAME));
  } catch {
    return null;
  }
  const meta = parseDesktopMeta(raw);
  if (meta === null) return null;
  const claims = claimsUnder(new OwnershipLedger(), dir);
  const owned: OwnedDesktopEntry[] = [];
  for (const entry of meta.entries) {
    const path = entryConfigPath(dir, entry.id);
    if (claims.has(path)) owned.push({ entry, path });
  }
  const listed = new Set(owned.map((e) => e.path));
  const unlisted = [...claims].filter((p) => !listed.has(p)).sort();
  return { meta, owned, unlisted };
}

/** The ledger claims under the library that _meta.json no longer lists, narrowed by `selects`;
 *  "blocked" when _meta.json cannot be judged. */
function unlistedClaims(
  selects: (path: string) => boolean,
): { kind: "blocked" } | { kind: "listed"; paths: string[] } {
  const dir = resolveDesktopLibraryDir();
  if (dir === null) return { kind: "listed", paths: [] };
  const library = readOwnedLibrary(dir);
  if (library === null) return { kind: "blocked" };
  return { kind: "listed", paths: library.unlisted.filter(selects) };
}

/** The leftovers of a removal that failed after the meta save: their files deleted when present,
 *  then the claims released. `selects` narrows the sweep (the key-off attribution). "blocked" when
 *  _meta.json cannot be judged. */
export function removeUnlistedClaudeDesktopClaims(
  selects: (path: string) => boolean = () => true,
): "swept" | "blocked" {
  const unlisted = unlistedClaims(selects);
  if (unlisted.kind === "blocked") return "blocked";
  for (const path of unlisted.paths) removeFile(path, ENTRY);
  releaseClaims(unlisted.paths);
  return "swept";
}

/** The applied slot is handed to a remaining entry of ours (the default's first), never left
 *  empty: an empty slot boots the app into claude.ai sign-in, and only the non-quiet wire could
 *  refill it. */
function nextAppliedId(
  dir: string,
  kept: readonly DesktopMetaEntry[],
  claims: ReadonlySet<string>,
): string | null {
  const ours = kept.filter((e) => claims.has(entryConfigPath(dir, e.id)));
  const next = ours.find((e) => entryProfileAt(entryConfigPath(dir, e.id)) === null) ?? ours[0];
  return next?.id ?? null;
}

/** A foreign row is never a candidate. Meta FIRST, config files second; the caller releases the
 *  ownership of `removed` LAST, once everything that must go with them went: a failure mid-way can
 *  leave an orphaned (invisible) config file, never a picker row whose config is gone, and never a
 *  released claim on a file still there. "blocked" when _meta.json cannot be judged. */
function sweepOwnedEntries(
  selects: (owned: OwnedDesktopEntry) => boolean,
): { kind: "blocked" } | { kind: "swept"; removed: string[] } {
  const swept = (removed: string[]) => ({ kind: "swept" as const, removed });
  const dir = resolveDesktopLibraryDir();
  if (dir === null) return swept([]);
  const index = readDesktopMetaOrWarn(dir);
  if (index === null) return { kind: "blocked" };
  if (index.raw === null) return swept([]); // no library, nothing recorded here to remove
  const { raw, meta } = index;
  const ledger = new OwnershipLedger();
  const claims = claimsUnder(ledger, dir);
  const removedPaths: string[] = [];
  const kept: DesktopMetaEntry[] = [];
  let removedApplied = false;
  for (const entry of meta.entries) {
    const configPath = entryConfigPath(dir, entry.id);
    if (!claims.has(configPath) || !selects({ entry, path: configPath })) {
      kept.push(entry);
      continue;
    }
    removedPaths.push(configPath);
    if (meta.appliedId === entry.id) removedApplied = true;
  }
  if (removedPaths.length === 0) return swept([]);
  if (removedApplied) meta.appliedId = nextAppliedId(dir, kept, claims);
  meta.entries = kept;
  writeDesktopMeta(dir, raw, meta);
  for (const path of removedPaths) removeFile(path, ENTRY);
  return swept(removedPaths);
}
