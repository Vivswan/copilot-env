// The managed config's `model_catalog_json` reference (catalog.ts generates the file; config.ts's
// managed write seeds the key): the wiring- and launch-time sync that heals or strips it, and the account-wide
// sweep that keeps a deleted catalog from leaving a dangling reference in any known Codex home.
// Best-effort throughout: stderr-only, never throws.
import { parse, stringify } from "smol-toml";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { CopilotEnvState } from "../copilot_api/env_state.ts";
import { OwnershipLedger } from "../copilot_api/ownership.ts";
import { CopilotApiPaths } from "../copilot_api/paths.ts";
import { errMessage } from "../utils/error.ts";
import { isEnoent } from "../utils/fs.ts";
import * as fs from "../utils/fs_facade.ts";
import { createStderrLogger } from "../utils/logger.ts";
import {
  catalogBookkeepingAllowed,
  type CatalogSource,
  type CodexCatalogDeps,
  inspectCatalogFile,
  refreshCodexModelCatalogIfStale,
  UNVERIFIED_SUFFIX,
  withCatalogRefreshDeadline,
} from "./catalog.ts";
import { effectiveCodexHome, knownCodexHomes } from "./host.ts";
import { CODEX_PROVIDER_ID, codexConfigPath } from "./paths.ts";
import { codexBearerLeaf, readCodexToml, saveCodexToml } from "./toml_io.ts";

const logger = createStderrLogger();

/** The default selection's table is the one these writes touch, so its bearer is the leaf a
 *  preview redacts. */
const DEFAULT_SECRETS: readonly string[] = [codexBearerLeaf(CODEX_PROVIDER_ID)];

/**
 * Runs after the default Codex wiring write and on a direct launch. ENABLED, it is an ADD-only self-heal for a config that predates a
 * usable catalog (the wiring-time seed failed, or the file appeared while mobile pairing had the
 * provider stripped).
 *
 * any other provider    -> left alone; `agent codex-mobile` runs OpenAI's default, whose limits
 *                          the patched catalog would misstate
 * a key already present -> never rewritten, ours or a user-pinned custom path; enforcing OUR path
 *                          is configureCodexConfig's
 */
export function syncCodexCatalogReference(catalogDeps: CodexCatalogDeps = {}): void {
  try {
    const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
    if (!new CopilotEnvConfig().codexModelCatalogEnabled()) {
      cleanupCodexCatalogArtifacts(catalogFile);
      return;
    }
    // Any reference to an unusable or rejected file (an upgrade that now requires a field the file
    // predates) is a Codex startup failure, so ours is stripped everywhere whatever the active
    // config's state; a rejected file stays for the next regeneration, and nothing is added
    // meanwhile.
    const verdict = inspectCatalogFile(catalogFile, catalogDeps);
    if (verdict === "unusable" || verdict === "rejected") {
      if (stripCodexCatalogReferences(catalogFile).stripped) {
        logger.warn(
          `codex model catalog: ${catalogFile} is ${
            verdict === "unusable" ? "missing or unreadable" : "rejected by the installed codex"
          }; reference removed (regenerate with \`agent profile sync --codex\`)`,
        );
      }
      return;
    }
    const configPath = codexConfigPath(effectiveCodexHome());
    const read = readCodexToml(configPath);
    // Absent (Codex never wired) or unparseable: the next full managed write owns both cases.
    if (read.kind !== "ok") return;
    const doc = read.doc;
    if (doc.model_provider !== CODEX_PROVIDER_ID) return;
    if (doc.model_catalog_json !== undefined) return;
    // The ledger is the inventory a later cleanup sweeps for configs outside the known homes: a
    // reference it does not know about could outlive the catalog it points at. So ownership is
    // recorded FIRST, and nothing is added when that cannot happen.
    if (!catalogBookkeepingAllowed() || !recordCatalogOwnership(configPath)) {
      logger.warn(
        `codex model catalog reference not set in ${configPath}: ownership could not be ` +
          "recorded; the next wiring or direct launch retries",
      );
      return;
    }
    saveCodexToml(
      configPath,
      { ...doc, model_catalog_json: catalogFile },
      `Codex config; model_catalog_json = "${catalogFile}" set` +
        (verdict === "unverifiable" ? UNVERIFIED_SUFFIX : ""),
      DEFAULT_SECRETS,
    );
  } catch {
    // An unreadable config (non-ENOENT) or a write race: the next `agent profile sync --codex`/`agent init` wiring
    // writes the key anyway.
  }
}

/** False when the ledger cannot be written. */
function recordCatalogOwnership(configPath: string): boolean {
  try {
    new OwnershipLedger().record("codexCatalog", configPath);
    return true;
  } catch {
    return false;
  }
}

/** The one catalog freshness hook every launch path runs (the wiring write seeds, then syncs): the throttled regeneration,
 *  then the reference sync, under ONE refresh deadline so the two paths cannot drift. */
export function refreshCodexCatalogAndSync(
  source: CatalogSource,
  deps: CodexCatalogDeps = {},
): Promise<void> {
  return withCatalogRefreshDeadline(deps, async () => {
    await refreshCodexModelCatalogIfStale(source, deps);
    syncCodexCatalogReference(deps);
  });
}

/** One config.toml per known Codex home: a farm home's config.toml is a host-LOCAL seeded copy, not
 *  a symlink, so each needs its own strip. An incomplete home sweep means unseen configs may still
 *  hold references, so deletion must not proceed on it. */
function codexCatalogConfigCandidates(): { configs: string[]; complete: boolean } {
  const { homes, complete } = knownCodexHomes();
  return { configs: homes.map((home) => codexConfigPath(home)), complete };
}

/** Callers act destructively on "no", so a resolve that could not RUN (EACCES on a path component,
 *  ELOOP, a path under a non-directory) must leave the question open rather than authorize deleting
 *  a catalog this config may still reference. The exact spelling is the caller's own test.
 *    a different spelling resolving to the same file (case, symlink, segmenting)  -> "yes"
 *    not a string, the exact spelling, resolves elsewhere, or proven absent      -> "no"
 *    the resolve itself failed                                                   -> "unknown" */
export function resolvesToCatalogFile(
  value: unknown,
  catalogFile: string,
): "yes" | "no" | "unknown" {
  if (typeof value !== "string" || value === catalogFile) return "no";
  try {
    return fs.realpath(value) === fs.realpath(catalogFile) ? "yes" : "no";
  } catch (e) {
    // A path proven absent cannot denote our existing file.
    return isEnoent(e) ? "no" : "unknown";
  }
}

/** Deletion fails closed while any readable config may still reference the file, and each step is
 *  skipped when already clean so a launch over a clean layout stays write-free.
 *    strip our reference from every config -> delete the file -> clear the throttle state
 *  Left after that: only a Codex that read the old config but has not opened the file yet. */
function cleanupCodexCatalogArtifacts(catalogFile: string): void {
  const { deletionSafe } = stripCodexCatalogReferences(catalogFile);
  if (deletionSafe && fs.readTextResult(catalogFile).kind !== "absent") {
    // A directory at the path is refused, in a dry run too: the warning is the same decision
    // either way.
    try {
      fs.assertNotDirectory(catalogFile);
      fs.rm(catalogFile, { force: true });
    } catch (e) {
      logger.warn(`codex model catalog cleanup failed: ${errMessage(e)}`);
    }
  }
  const state = new CopilotEnvState();
  const recorded = state.read();
  if (
    recorded.codexCatalogLastAttemptMs !== 0 || recorded.codexCatalogCodexVersion !== null ||
    recorded.codexCatalogPatchVersion !== 0 || recorded.codexCatalogAccepted !== null
  ) {
    state.set({
      codexCatalogLastAttemptMs: null,
      codexCatalogCodexVersion: null,
      codexCatalogPatchVersion: null,
      codexCatalogAccepted: null,
    });
  }
}

/** The exact value match alone proves ownership, with no provider check: a reference left behind
 *  while the file goes breaks Codex startup, and a user-pinned custom path survives.
 *
 *  the ledger     -> only EXTENDS the known homes
 *  `deletionSafe` -> the sweep's proof that no readable config still references the file */
function stripCodexCatalogReferences(
  catalogFile: string,
): { stripped: boolean; deletionSafe: boolean } {
  const ledger = new OwnershipLedger();
  const { configs, complete } = codexCatalogConfigCandidates();
  const recordedPaths = new Set(ledger.ownedPaths("codexCatalog"));
  let deletionSafe = complete;
  let stripped = false;
  for (const configPath of new Set([...configs, ...recordedPaths])) {
    // Absent (a recorded claim on it is stale) and unreadable (may still hold a reference) stay
    // apart, as the catch below keeps them for a raw read.
    const read = fs.readTextResult(configPath);
    if (read.kind === "absent") {
      if (recordedPaths.has(configPath) && catalogBookkeepingAllowed()) {
        ledger.release("codexCatalog", configPath);
      }
      continue;
    }
    if (read.kind === "unreadable") {
      deletionSafe = false;
      continue;
    }
    try {
      const doc = parse(read.text) as Record<string, unknown>;
      if (doc.model_catalog_json === catalogFile) {
        const { model_catalog_json: _dropped, ...next } = doc;
        fs.writeText(configPath, stringify(next), {
          atomic: false,
          detail: "Codex config; model_catalog_json removed",
          secretKeys: DEFAULT_SECRETS,
        });
        stripped = true;
        if (catalogBookkeepingAllowed()) ledger.release("codexCatalog", configPath);
      } else if (resolvesToCatalogFile(doc.model_catalog_json, catalogFile) !== "no") {
        // An alternate spelling of OUR path (case variant on Windows, a symlinked home), or a
        // resolve that could not RUN: not provably ours to strip, and deleting the file would
        // dangle it.
        deletionSafe = false;
      } else if (recordedPaths.has(configPath)) {
        // Recorded, but the config no longer references our file (the user removed or repointed the
        // key): a stale claim.
        if (catalogBookkeepingAllowed()) ledger.release("codexCatalog", configPath);
      }
    } catch {
      // Unparseable content might still hold a reference, so the file stays until every readable
      // config proves it unreferenced.
      deletionSafe = false;
    }
  }
  return { stripped, deletionSafe };
}
