// The managed config's `model_catalog_json` reference to the generated Codex model
// catalog (catalog.ts generates the file; config.ts's managed write seeds the key):
// the auth-time sync that heals or strips the reference, and the account-wide sweep
// over every known Codex home that keeps a deleted catalog from leaving a dangling
// reference anywhere. Best-effort throughout: stderr-only, never throws.
import * as fs from "node:fs";
import { parse, stringify } from "smol-toml";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { CopilotEnvState } from "../copilot_api/env_state.ts";
import { OwnershipLedger } from "../copilot_api/ownership.ts";
import { CopilotApiPaths } from "../copilot_api/paths.ts";
import { errMessage } from "../utils/error.ts";
import { isEnoent } from "../utils/fs.ts";
import { createStderrLogger } from "../utils/logger.ts";
import { removeReported, writeFileReported } from "../utils/report_write.ts";
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
import { readCodexToml, saveCodexToml } from "./toml_io.ts";

const logger = createStderrLogger();

/**
 * Auth-time sync: keep the managed config's `model_catalog_json` in step with the
 * opt-in `codex-model-catalog` preference. Called on every auth resolution (one
 * cheap TOML read; writes only fire when something is actually out of step).
 * Best-effort: never throws, stderr-only.
 *
 * ENABLED -- self-heal: when a usable catalog exists but the managed config
 * predates it (e.g. the wiring-time seed failed because the proxy was down or no
 * credential existed yet, or the file was generated while mobile pairing had the
 * provider stripped), add the reference in place -- WITHOUT re-running the full
 * managed write, and only when the config currently selects OUR provider. The
 * provider check keeps the key out during `agent codex --mobile` pairing, which
 * strips `model_provider` to run the app on its default OpenAI provider (whose
 * limits the patched catalog would misstate). ADD-only: a present key -- ours or
 * a user-pinned custom catalog path -- is never rewritten here; enforcing OUR
 * path over a custom one is the full managed write's job (configureCodexConfig).
 * The one subtraction, judged BEFORE the active config is even read: when the
 * file is unusable (gone, malformed, empty) or the installed codex REJECTS its
 * schema (a codex upgrade that now requires a field the file predates), our
 * reference is stripped from every known config, whatever the active config's
 * state, because that reference is exactly what fails Codex's startup; a
 * rejected file stays for the next regeneration, and nothing is added meanwhile.
 *
 * DISABLED -- cleanup: strip the reference from every known Codex config, then
 * delete the generated file, then clear the refresh-throttle state. "Every
 * known config" sweeps the active home, the default ~/.codex, and the per-host
 * symlink-farm homes (~/.codex/hosts/*): all of them reference the ONE
 * account-wide file, so stripping only the active home could leave a dangling
 * reference elsewhere. The reference is stripped only when its value IS our
 * generated path (the value match alone proves ownership -- no provider check,
 * because leaving our reference behind while the file goes would break Codex
 * startup; a user-pinned custom path survives). Strip-BEFORE-delete keeps the
 * dangling-reference window to the one unavoidable TOCTOU sliver (a Codex that
 * read the old config but has not opened the file yet); anything wider --
 * every config on disk -- always sees (reference + file) or (no reference).
 * Deletion FAILS CLOSED: when any config is unreadable for a reason other
 * than "no config.toml", when the farm directory cannot be enumerated, or
 * when a NON-matching reference still resolves to the same file (a case
 * variant / symlinked spelling of our path), the file is kept this round; a
 * possibly-live reference to a deleted file is a Codex startup error, and
 * Codex re-runs auth every 300s, so the retry is near. Steady state is
 * write-free.
 */
export function syncCodexCatalogReference(catalogDeps: CodexCatalogDeps = {}): void {
  try {
    const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
    if (!new CopilotEnvConfig().codexModelCatalogEnabled()) {
      cleanupCodexCatalogArtifacts(catalogFile);
      return;
    }
    // Absent, malformed, or empty, or rejected by the installed codex: any
    // reference to it is a Codex startup failure, so strip ours everywhere.
    const verdict = inspectCatalogFile(catalogFile, catalogDeps);
    if (verdict === "unusable" || verdict === "rejected") {
      if (stripCodexCatalogReferences(catalogFile).stripped) {
        logger.warn(
          `codex model catalog: ${catalogFile} is ${
            verdict === "unusable" ? "missing or unreadable" : "rejected by the installed codex"
          }; reference removed (regenerate with \`agent codex\`)`,
        );
      }
      return;
    }
    const configPath = codexConfigPath(effectiveCodexHome());
    const read = readCodexToml(configPath);
    // Absent (Codex never wired) or unparseable: nothing to heal in place -- the
    // next full managed write owns both cases.
    if (read.kind !== "ok") return;
    const doc = read.doc;
    if (doc.model_provider !== CODEX_PROVIDER_ID) return;
    if (doc.model_catalog_json !== undefined) return;
    // The ledger is the inventory a later cleanup sweeps for configs outside the
    // known homes: a reference it does not know about could outlive the catalog it
    // points at. So record ownership FIRST, and add nothing when that cannot happen.
    if (!catalogBookkeepingAllowed() || !recordCatalogOwnership(configPath)) {
      logger.warn(
        `codex model catalog reference not set in ${configPath}: ownership could not be ` +
          "recorded; the next auth refresh retries",
      );
      return;
    }
    doc.model_catalog_json = catalogFile;
    saveCodexToml(
      configPath,
      doc,
      `Codex config; model_catalog_json = "${catalogFile}" set` +
        (verdict === "unverifiable" ? UNVERIFIED_SUFFIX : ""),
    );
  } catch {
    // An unreadable config (non-ENOENT) or a write race: the next
    // `agent codex`/`agent init` wiring writes the key anyway.
  }
}

/** Record the ledger claim for `configPath`; false when the ledger cannot be written. */
function recordCatalogOwnership(configPath: string): boolean {
  try {
    new OwnershipLedger().record("codexCatalog", configPath);
    return true;
  } catch {
    return false;
  }
}

/** The one catalog freshness hook every auth-time and launch path runs: the throttled,
 *  version-aware regeneration from `source`, then the reference sync (self-heal when
 *  enabled, cleanup when disabled), under ONE refresh deadline so the paths cannot drift. */
export function refreshCodexCatalogAndSync(
  source: CatalogSource,
  deps: CodexCatalogDeps = {},
): Promise<void> {
  return withCatalogRefreshDeadline(deps, async () => {
    await refreshCodexModelCatalogIfStale(source, deps);
    syncCodexCatalogReference(deps);
  });
}

/** Every config.toml that may reference the account-wide catalog file: one per
 *  known Codex home (a farm home's config.toml is a host-LOCAL seeded copy,
 *  not a symlink -- each needs its own strip). An incomplete home sweep means
 *  unseen configs may still hold references, so deletion must not proceed on
 *  that sweep. */
function codexCatalogConfigCandidates(): { configs: string[]; complete: boolean } {
  const { homes, complete } = knownCodexHomes();
  return { configs: homes.map((home) => codexConfigPath(home)), complete };
}

/** Whether `value` may denote `catalogFile` ALIAS-wise: "yes" when it is a
 *  non-identical spelling that still resolves to the same file (case variant,
 *  symlink, relative segmenting), "no" when it is not a candidate at all (not a
 *  string, the exact spelling -- which callers test themselves before asking -- or a
 *  path that resolves elsewhere or does not exist), "unknown" when the resolve
 *  itself FAILED and the question stays open. The three-state matters because the
 *  callers act destructively on "no": a resolve that could not run (EACCES on a path
 *  component, ELOOP, a path under a non-directory) must not authorize deleting a
 *  catalog file this config may still reference -- the same fail-closed direction the
 *  sibling catch in cleanupCodexCatalogArtifacts takes. */
export function resolvesToCatalogFile(
  value: unknown,
  catalogFile: string,
): "yes" | "no" | "unknown" {
  if (typeof value !== "string" || value === catalogFile) return "no";
  try {
    return fs.realpathSync(value) === fs.realpathSync(catalogFile) ? "yes" : "no";
  } catch (e) {
    // A path proven absent is a proven "no": it cannot denote our existing file.
    // Every other failure leaves the question open.
    return isEnoent(e) ? "no" : "unknown";
  }
}

/** The disabled branch of syncCodexCatalogReference: strip our reference from
 *  every candidate config, delete the generated file, clear the throttle state
 *  -- in that order, each step skipped when already clean so the 300s auth
 *  cadence stays write-free. The ownership ledger EXTENDS the sweep (a recorded
 *  config outside the enumerated homes still gets its reference stripped), but
 *  the exact value match below stays the per-config proof for every candidate:
 *  pre-ledger installs recorded nothing, and a user-repointed key is no longer
 *  ours even at a recorded path. */
function cleanupCodexCatalogArtifacts(catalogFile: string): void {
  const { deletionSafe } = stripCodexCatalogReferences(catalogFile);
  if (deletionSafe && fs.existsSync(catalogFile)) {
    try {
      removeReported(catalogFile);
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

/** Strip our `model_catalog_json` reference from every candidate config (the
 *  sweep cleanupCodexCatalogArtifacts describes), releasing each claim as it
 *  goes. `stripped` reports whether any config changed; `deletionSafe` is the
 *  sweep's proof that no readable config still references the file. */
function stripCodexCatalogReferences(
  catalogFile: string,
): { stripped: boolean; deletionSafe: boolean } {
  const ledger = new OwnershipLedger();
  const { configs, complete } = codexCatalogConfigCandidates();
  const recordedPaths = new Set(ledger.ownedPaths("codexCatalog"));
  let deletionSafe = complete;
  let stripped = false;
  for (const configPath of new Set([...configs, ...recordedPaths])) {
    try {
      const doc = parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
      if (doc.model_catalog_json === catalogFile) {
        delete doc.model_catalog_json;
        writeFileReported(configPath, stringify(doc), {
          detail: "Codex config; model_catalog_json removed",
        });
        stripped = true;
        if (catalogBookkeepingAllowed()) ledger.release("codexCatalog", configPath);
      } else if (resolvesToCatalogFile(doc.model_catalog_json, catalogFile) !== "no") {
        // An alternate spelling of OUR path (case variant on Windows, a
        // symlinked home) -- or a resolve that could not RUN, which leaves the
        // question open. Either way not provably ours to strip, and deleting the
        // file would dangle it -- keep the file.
        deletionSafe = false;
      } else if (recordedPaths.has(configPath)) {
        // Recorded, but the config no longer references our file (the user
        // removed or repointed the key since we wrote it): a stale claim.
        if (catalogBookkeepingAllowed()) ledger.release("codexCatalog", configPath);
      }
    } catch (e) {
      // ENOENT (no config there anymore) cannot hold a reference -- a recorded
      // claim on it is stale; any other failure might hold one, so keep the
      // file until every readable config proves it unreferenced.
      if (!isEnoent(e)) deletionSafe = false;
      else if (recordedPaths.has(configPath)) {
        if (catalogBookkeepingAllowed()) ledger.release("codexCatalog", configPath);
      }
    }
  }
  return { stripped, deletionSafe };
}
