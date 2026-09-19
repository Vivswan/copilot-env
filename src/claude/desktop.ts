// The Claude Desktop reconcile: one entry per wired profile in the app's config library, derived on
// every pass from the `claude.desktop` key and the ownership ledger; a sweep never removes an entry
// it does not own. The files themselves are desktop_library.ts, the entry document
// desktop_payload.ts, the helper scripts desktop_helper_scripts.ts.
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { codexUserAgent } from "../codex/user_agent.ts";
import { type ManagedMode, type ManagedWrite, reservePlannedPort } from "../agents/configure.ts";
import { fetchRawModels } from "../copilot_api/catalog.ts";
import { Credential } from "../copilot_api/credential.ts";
import { discoverServableClaudeModels } from "../copilot_api/discovery.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { DEFAULT_COPILOT_API_BASE, type ProbeFetch } from "../copilot_api/integration_identity.ts";
import { OwnershipLedger } from "../copilot_api/ownership.ts";
import {
  claudeCatalogRows,
  ONE_M_SUFFIX,
  parseCatalogModels,
  parseModelList,
} from "../copilot_api/models.ts";
import { CopilotApiPaths, resolveRootHome } from "../copilot_api/paths.ts";
import { copilotApiResolvePort, proxyLoopbackOrigin } from "../copilot_api/port.ts";
import { agentStartCommand, type Profile, profileLabel } from "../copilot_api/profile.ts";
import { errMessage } from "../utils/error.ts";
import * as fs from "../utils/fs_facade.ts";
import { isRecord } from "../utils/json.ts";
import { createStderrLogger } from "../utils/logger.ts";
import {
  desktopHelperPath,
  desktopHelperScriptWiring,
  landDesktopHelperScript,
  prepareRemoveHelperScript,
  prepareRemoveHelperScripts,
  prepareRetireDesktopHelperScript,
  presentDesktopHelperScripts,
  readDesktopHelperScript,
} from "./desktop_helper_scripts.ts";
import {
  claudeDesktopInstalled,
  desktopEntryName,
  type DesktopMeta,
  type DesktopMetaEntry,
  META_FILENAME,
  parseDesktopMeta,
  parsedRecord,
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
  desktopConfigPayload,
  type DesktopCredential,
  desktopModelsFromPicks,
  type DesktopModelSpec,
  entryProfileAt,
  recordedModelRows,
} from "./desktop_payload.ts";
import type { DesktopOwnedEntry } from "./desktop_status.ts";

const logger = createStderrLogger();

/** How a removal's report names an entry file. */
const ENTRY = "Claude Desktop entry";

export type DesktopWireOptions = ManagedWrite & {
  profile: Profile;
  /** Direct only: credential for the catalog fetch (never re-resolved when given). */
  directToken?: string | null;
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

/**
 * Undefined when no live data exists: the caller then leaves an existing entry's rows untouched and
 * refuses to create a fresh direct one. Each mode shows what its own backend will actually serve.
 *   direct -> the full discovery pipeline (src/copilot_api/discovery.ts) under the wiring's own
 *             identity, so unadvertised-but-servable models get a PROBED 1m verdict
 *   proxy  -> what the daemon's /v1/models will discover: its catalog first, Copilot when down
 */
async function wiringModels(
  opts: DesktopWireOptions,
): Promise<readonly DesktopModelSpec[] | undefined> {
  if (opts.mode === "direct") {
    try {
      const resolved = typeof opts.directToken === "string"
        ? { token: opts.directToken, reason: null }
        : opts.credential.kind === "static"
        ? { token: opts.credential.token, reason: null }
        : new Credential(undefined, opts.profile).resolveWithReason();
      if (resolved.token === null) throw new Error(resolved.reason);
      const token = resolved.token;
      const discovered = await discoverServableClaudeModels(
        token,
        codexUserAgent(),
        opts.direct?.directIntegrationId ?? null,
        opts.direct?.directBaseUrl ?? DEFAULT_COPILOT_API_BASE,
        { fetchImpl: opts.fetchImpl },
      );
      const rows = claudeCatalogRows(discovered.models);
      if (rows.length > 0) {
        return desktopModelsFromPicks(rows, labelLookup(discovered.catalogBody));
      }
    } catch (e) {
      logger.warn(`  Claude Desktop: model discovery failed (${errMessage(e)}).`);
    }
  } else {
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
          `  Claude Desktop: could not fetch the ${source} model catalog (${errMessage(e)}).`,
        );
      }
    }
  }
  logger.warn(
    "  Claude Desktop: no live model data; leaving the entry's model rows as they are.",
  );
  return undefined;
}

/**
 * The entry wire. Throws on real read failures; syncClaudeDesktopWiring is the best-effort face.
 * `appliedId` is only ever SET when the library had none: an applied user config is never
 * displaced.
 *   ours (an owned path whose document names `profile`)
 *   -> adoptable (a foreign entry at the same gateway, taken over under its uuid and name)
 *   -> a foreign namesake (warn, never clobber)
 *   -> a fresh uuid
 */
export async function wireClaudeDesktopEntry(opts: DesktopWireOptions): Promise<void> {
  const dir = resolveDesktopLibraryDir();
  if (dir === null || !claudeDesktopInstalled()) return;

  // The text PEEKS a proxy port; the write reserves it (reservePlannedPort).
  const plannedPort = opts.mode === "proxy" ? copilotApiResolvePort(opts.profile) : null;
  const baseUrl = plannedPort === null
    ? opts.direct?.directBaseUrl ?? DEFAULT_COPILOT_API_BASE
    : proxyLoopbackOrigin(plannedPort);

  const metaRaw = readFileOrNull(join(dir, META_FILENAME));
  const meta = parseDesktopMeta(metaRaw);
  if (meta === null) {
    logger.warn(
      `  Claude Desktop: ${
        join(dir, META_FILENAME)
      } has an unexpected shape; leaving the config library alone.`,
    );
    return;
  }

  const ledger = new OwnershipLedger();
  const name = desktopEntryName(opts.profile);
  const configPathOf = (id: string) => join(dir, `${id}.json`);

  let entry = meta.entries.find(
    (e) =>
      ledger.owns("claudeDesktop", configPathOf(e.id)) &&
      entryProfileAt(configPathOf(e.id)) === opts.profile,
  );
  if (entry === undefined) {
    for (const candidate of meta.entries) {
      const path = configPathOf(candidate.id);
      if (ledger.owns("claudeDesktop", path)) continue;
      const raw = readFileOrNull(path);
      if (raw === null) continue;
      let doc: unknown;
      try {
        doc = JSON.parse(raw);
      } catch {
        continue; // malformed is foreign, never adopted
      }
      if (!isRecord(doc) || !sameBaseUrl(doc["inferenceGatewayBaseUrl"], baseUrl)) continue;
      entry = candidate;
      if (!opts.quiet) {
        logger.info(
          `  Claude Desktop: adopting the existing "${candidate.id}" entry (same gateway).`,
        );
      }
      break;
    }
  }
  // A foreign namesake at a DIFFERENT gateway (a same-gateway one was adopted above) is never
  // clobbered or twinned. An owned namesake is the user's rename of another wiring's entry.
  const foreignNamesake = meta.entries.some(
    (e) => e.name === name && !ledger.owns("claudeDesktop", configPathOf(e.id)),
  );
  if (entry === undefined && foreignNamesake) {
    logger.warn(
      `  Claude Desktop: a config entry named "${name}" already exists and is not ours; leaving it alone.`,
    );
    return;
  }
  const owned = entry !== undefined &&
    ledger.owns("claudeDesktop", configPathOf(entry.id));
  const created = entry === undefined;
  if (entry === undefined) {
    entry = { id: crypto.randomUUID(), name, extra: {} };
  }

  const configPath = configPathOf(entry.id);
  const existingRaw = readFileOrNull(configPath);
  // Unparseable content under our path (an in-app edit racing us) is rebuilt.
  const existing: Record<string, unknown> = parsedRecord(existingRaw) ?? {};

  // The launcher hot path (quiet) must NEVER run discovery: its probes are billed requests. It
  // reuses the recorded rows; `agent init`, `agent profile <name> add`, and `agent profile sync --claude` refresh live.
  const models = opts.quiet
    ? (owned ? recordedModelRows(existing) ?? undefined : undefined)
    : await wiringModels(opts);

  // A FRESH direct entry without model data would have neither discovery (Copilot 404s /v1/models)
  // nor a picker, so it is not created at all; an existing entry keeps its recorded rows.
  if (created && opts.mode === "direct" && models === undefined) {
    logger.warn(
      "  Claude Desktop: no model data available; not creating an unusable direct entry (re-run online).",
    );
    return;
  }
  if (created) meta.entries.push(entry);

  // The helper script exists only for the command shape; a static entry names none. Read now, so
  // an unreadable helper refuses the wire before anything is reserved or written.
  const credential: DesktopCredential = opts.credential.kind === "static" ? opts.credential : {
    kind: "command",
    helperPath: desktopHelperPath(resolveRootHome(), opts.mode, opts.profile),
  };
  const helper = credential.kind === "command"
    ? readDesktopHelperScript(opts.mode, opts.profile)
    : null;
  // Re-extracted so the payload receives the Direct facts only alongside a direct mode.
  const write: ManagedMode = opts.mode === "direct"
    ? { mode: "direct", direct: opts.direct }
    : { mode: "proxy" };
  // The write's own line announces the wiring; a byte-identical no-op states it instead, unless
  // quiet (the launcher hot path).
  const staticClause = credential.kind === "command"
    ? ""
    : opts.mode === "direct"
    ? "; static key"
    : `; static key, start the proxy yourself (${agentStartCommand(opts.profile)})`;
  const wiring = `${ENTRY} "${entry.name}" (${opts.mode}) wired${staticClause}`;
  const payload = desktopConfigPayload({
    ...write,
    profile: opts.profile,
    baseUrl,
    credential,
    models,
    existing,
  });
  // An applied slot that is empty, or names a row the library no longer lists, is ours to fill;
  // a slot naming a live entry (a user's own config) is never displaced.
  if (!meta.entries.some((e) => e.id === meta.appliedId)) meta.appliedId = entry.id;

  // The post-save steps take their looks before the first wiring write.
  const retire = credential.kind === "command"
    ? prepareRetireDesktopHelperScript(opts.mode, opts.profile)
    : prepareRemoveHelperScripts(opts.profile);
  const appFiles = prepareClaudeDesktopAppFiles();
  // Reserved now that everything is computed: a refusal above leaves no reservation behind.
  if (plannedPort !== null) reservePlannedPort(opts.profile, plannedPort);
  // The order is the safety: helper, config, then meta; the ownership claim, the helper
  // retirement, and the app files follow, in that order.
  //   config without its meta row  -> invisible junk
  //   meta row without its config  -> a broken picker row
  //   claim before the save        -> a claim on an entry that was never written
  //   retirement before the claim  -> a saved entry left unclaimed when the retirement fails
  if (helper !== null) landDesktopHelperScript(helper);
  const configWritten = writeJson(
    configPath,
    existingRaw,
    payload,
    `${wiring}; restart Claude Desktop to pick it up`,
    DESKTOP_SECRETS,
  );
  if (!configWritten && !opts.quiet) {
    logger.success(`  ${wiring} at ${configPath} already.`);
  }
  writeDesktopMeta(dir, metaRaw, meta);
  // Only a NEW claim is recorded, so the ledger write is a real change, never a byte-identical
  // one. What follows lands on its own, after the claim: the other mode's helper (the
  // still-current entry never names a deleted one) and the app files, independent of the entry,
  // so a failure in either leaves a complete, OWNED entry.
  if (!owned) ledger.record("claudeDesktop", configPath);
  retire();
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
  const profiles = doc["profiles"];
  return profiles === undefined ||
    (isRecord(profiles) && Object.values(profiles).every(isRecord));
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
      `  Could not wire Claude Desktop for ${profileLabel(opts.profile)}: ${errMessage(e)}`,
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
  removeOwned(
    `the Claude Desktop entry for ${profileLabel(profile)}`,
    (e) => entryProfileAt(e.path) === profile,
    profile,
  );
}

/** Best-effort. */
export function removeClaudeDesktopOrphan(orphan: DesktopOwnedEntry): void {
  removeOwned(
    `the orphaned Claude Desktop entry at ${orphan.path}`,
    (e) => e.path === orphan.path,
    orphan.profile,
  );
}

/** A failed removal is warned about, and its ownership stays with the entry it did not remove
 *  (the claims go last). A blocked sweep (malformed _meta.json) may leave a live entry pointing at
 *  the helper scripts, so they go only when the library was actually processed. */
function removeOwned(
  what: string,
  selects: (owned: OwnedDesktopEntry) => boolean,
  helpersOf: Profile | undefined,
): void {
  try {
    // The helpers' looks come before the library is touched.
    const helpers = helpersOf === undefined ? () => {} : prepareRemoveHelperScripts(helpersOf);
    const entries = sweepOwnedEntries(selects);
    if (entries.kind === "blocked") return;
    helpers();
    releaseClaims(entries.removed);
  } catch (e) {
    logger.warn(`  Could not remove ${what}: ${errMessage(e)}`);
  }
}

function releaseClaims(paths: readonly string[]): void {
  const ledger = new OwnershipLedger();
  for (const path of paths) ledger.release("claudeDesktop", path);
}

/** The uninstall sweep. `dirOverride` is the injected library dir (homedir() is not
 *  env-redirectable on Windows); null means "treat Desktop as absent". */
export function removeAllClaudeDesktopWiring(
  dirOverride?: string | null,
  artifacts: ClaudeDesktopOwnedArtifacts = listClaudeDesktopOwnedArtifacts(dirOverride),
): void {
  // `artifacts` is the plan uninstall rendered as its dry run: exactly those paths go, so a claim
  // that appeared after planning stays.
  if (artifacts.blocked) return;
  const planned = new Set([...artifacts.entries, ...artifacts.staleClaims]);
  const entries = sweepOwnedEntries((owned) => planned.has(owned.path), dirOverride);
  if (entries.kind === "blocked") return;
  releaseClaims(entries.removed);
  removeUnlistedClaudeDesktopClaims(dirOverride, (path) => planned.has(path));
  // Uninstall deletes the root home wholesale right after this step; the helpers still go here so
  // the step is complete on its own.
  for (const path of artifacts.helpers) removeFile(path);
}

/** The `claude.desktop false` sweep. Fail closed: only a claim POSITIVELY attributed to a named
 *  profile goes, since anything else may be the default's. Helper scripts go by FILENAME, so a
 *  named profile's script goes even when its entry was left. */
export function removeUnmanagedClaudeDesktopWiring(opts: { quiet?: boolean } = {}): void {
  const sweepable = (path: string): boolean => {
    let profile: Profile | undefined;
    try {
      profile = entryProfileAt(path);
    } catch (e) {
      logger.warn(`  Claude Desktop: ${errMessage(e)}; left alone.`);
      return false;
    }
    if (profile === undefined) {
      logger.warn(
        `  Claude Desktop: ${path} carries no copilot-env wiring, so its profile is unknown; left alone.`,
      );
    }
    return profile !== undefined && profile !== null;
  };
  // Every look before the first write: the helper listing and the unlisted claims are judged over
  // the library as it stands, and a listing that fails leaves it untouched.
  const helpers = presentDesktopHelperScripts(resolveRootHome())
    .filter((path) => desktopHelperScriptWiring(basename(path))?.profile !== null)
    .map(prepareRemoveHelperScript);
  const unlisted = unlistedClaims(undefined, sweepable);
  const entries = sweepOwnedEntries((e) => sweepable(e.path));
  if (entries.kind === "blocked") return;
  if (unlisted.kind === "listed") { for (const path of unlisted.paths) removeFile(path, ENTRY); }
  for (const remove of helpers) remove();
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
 *    helpers      -> the generated helper scripts
 *    blocked      -> a not-understood _meta.json; the library is left alone */
export interface ClaudeDesktopOwnedArtifacts {
  entries: string[];
  staleClaims: string[];
  helpers: string[];
  /** The `_meta.json` path when removing the listed owned rows will rewrite it (null: nothing
   *  listed is ours). Outside our homes, so the dry run names the rewrite like the live sweep. */
  metaRewrite: string | null;
  blocked: boolean;
}

export function listClaudeDesktopOwnedArtifacts(
  dirOverride?: string | null,
): ClaudeDesktopOwnedArtifacts {
  const helpers = presentDesktopHelperScripts(resolveRootHome());
  const dir = dirOverride !== undefined ? dirOverride : resolveDesktopLibraryDir();
  const none = { entries: [], staleClaims: [], helpers, metaRewrite: null };
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
    helpers,
    metaRewrite: library.owned.length > 0 ? join(dir, META_FILENAME) : null,
    blocked: false,
  };
}

export interface OwnedDesktopEntry {
  entry: DesktopMetaEntry;
  path: string;
}

interface OwnedLibrary {
  meta: DesktopMeta;
  owned: OwnedDesktopEntry[];
  /** Ledger claims under the dir that _meta.json no longer lists: an interrupted removal's
   *  invisible leftovers, config file present or not. */
  unlisted: string[];
}

/** DIRECT entry files of `dir` only (`<id>.json`, one segment down; a trailing separator on `dir`
 *  or a nested path changes nothing), as one snapshot: one ledger read, not one per row. */
function claimsUnder(ledger: OwnershipLedger, dir: string): Set<string> {
  return new Set(
    ledger.ownedPaths("claudeDesktop").filter((p) => {
      const rel = relative(dir, p);
      return rel !== "" && !isAbsolute(rel) && !rel.startsWith("..") && !rel.includes(sep) &&
        rel.endsWith(".json");
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
    const path = join(dir, `${entry.id}.json`);
    if (claims.has(path)) owned.push({ entry, path });
  }
  const listed = new Set(owned.map((e) => e.path));
  const unlisted = [...claims].filter((p) => !listed.has(p)).sort();
  return { meta, owned, unlisted };
}

/** The ledger claims under the library that _meta.json no longer lists, narrowed by `selects`;
 *  "blocked" when _meta.json cannot be judged. */
function unlistedClaims(
  dirOverride: string | null | undefined,
  selects: (path: string) => boolean,
): { kind: "blocked" } | { kind: "listed"; paths: string[] } {
  const dir = dirOverride !== undefined ? dirOverride : resolveDesktopLibraryDir();
  if (dir === null) return { kind: "listed", paths: [] };
  const library = readOwnedLibrary(dir);
  if (library === null) return { kind: "blocked" };
  return { kind: "listed", paths: library.unlisted.filter(selects) };
}

/** The leftovers of a removal that failed after the meta save: their files deleted when present,
 *  then the claims released. `dirOverride` as in removeAllClaudeDesktopWiring; `selects` narrows
 *  the sweep (the key-off attribution). "blocked" when _meta.json cannot be judged. */
export function removeUnlistedClaudeDesktopClaims(
  dirOverride?: string | null,
  selects: (path: string) => boolean = () => true,
): "swept" | "blocked" {
  const unlisted = unlistedClaims(dirOverride, selects);
  if (unlisted.kind === "blocked") return "blocked";
  for (const path of unlisted.paths) removeFile(path, ENTRY);
  releaseClaims(unlisted.paths);
  return "swept";
}

/** A foreign row is never a candidate. Meta FIRST, config files second; the caller releases the
 *  ownership of `removed` LAST, once everything that must go with them went: a failure mid-way can
 *  leave an orphaned (invisible) config file, never a picker row whose config is gone, and never a
 *  released claim on a file still there. "blocked" when _meta.json cannot be judged (a live entry
 *  may reference the helper scripts: keep them). */
function sweepOwnedEntries(
  selects: (owned: OwnedDesktopEntry) => boolean,
  dirOverride?: string | null,
): { kind: "blocked" } | { kind: "swept"; removed: string[] } {
  const swept = (removed: string[]) => ({ kind: "swept" as const, removed });
  const dir = dirOverride !== undefined ? dirOverride : resolveDesktopLibraryDir();
  if (dir === null) return swept([]);
  const metaPath = join(dir, META_FILENAME);
  const raw = readFileOrNull(metaPath);
  if (raw === null) return swept([]); // no library, nothing recorded here to remove
  const meta = parseDesktopMeta(raw);
  if (meta === null) {
    logger.warn(
      `  Claude Desktop: ${metaPath} has an unexpected shape; leaving the config library alone.`,
    );
    return { kind: "blocked" };
  }
  const ledger = new OwnershipLedger();
  const claims = claimsUnder(ledger, dir);
  const removedPaths: string[] = [];
  const kept: DesktopMetaEntry[] = [];
  let removedApplied = false;
  for (const entry of meta.entries) {
    const configPath = join(dir, `${entry.id}.json`);
    if (claims.has(configPath) && selects({ entry, path: configPath })) {
      removedPaths.push(configPath);
      if (meta.appliedId === entry.id) removedApplied = true;
    } else {
      kept.push(entry);
    }
  }
  if (removedPaths.length === 0) return swept([]);
  // The applied slot is handed to a remaining entry of ours (the default's first), never left
  // empty: an empty slot boots the app into claude.ai sign-in, and only the non-quiet wire could
  // refill it.
  if (removedApplied) {
    const ours = kept.filter((e) => claims.has(join(dir, `${e.id}.json`)));
    const next = ours.find((e) => entryProfileAt(join(dir, `${e.id}.json`)) === null) ?? ours[0];
    meta.appliedId = next?.id ?? null;
  }
  meta.entries = kept;
  writeDesktopMeta(dir, raw, meta);
  for (const path of removedPaths) removeFile(path, ENTRY);
  return swept(removedPaths);
}
