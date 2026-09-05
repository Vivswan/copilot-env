// The machine-local artifact-ownership ledger: the record of which entries
// copilot-env ITSELF wrote into external config artifacts, so a removal path
// can take back exactly what we added and never an entry the user (or another
// program) put there. One store (`.copilot-env-ownership.json` under the ROOT
// home) for every exact-path ownership kind:
//   - webSearchDeny:  settings.json files whose `permissions.deny` WE added the
//     `WebSearch` entry to (src/claude/config.ts).
//   - claudeDesktop:  Claude Desktop config-library entries WE created or
//     adopted (src/claude/desktop.ts).
//   - codexCatalog:   Codex config.toml files WE wrote the `model_catalog_json`
//     reference into (src/codex/config.ts; pre-ledger installs recorded
//     nothing, so the cleanup there keeps its value-match fallback).
// The ledger names THIS machine's files, so it is machine-local by nature and
// is never part of the `agent settings` bundle (src/agents/transfer.ts exports
// the two account-wide stores; this file is neither).
//
// Doctrine, shared by every kind:
//   - record AFTER the successful artifact write, release AFTER the successful
//     take-back. A crash between the two leaves an UNCLAIMED entry -- the safe
//     direction: an unclaimed entry is never deleted (a writer that later
//     reproduces it re-claims it, e.g. the catalog reference; otherwise it is a
//     harmless orphan the user removes by hand) -- never a claim on something
//     we did not write.
//   - a junk-degraded record file reads as "owns less", never as a crash. An
//     UNREADABLE store, by contrast, THROWS (loadStrict): "owns nothing" is a
//     verdict take-back paths act on, never assumed from a read that failed.
//   - every mutation serializes on ONE ops lock, so a take-back racing the
//     legacy adoption cannot resurrect a released claim (advisory, like every
//     lock in this codebase: bounded wait, then proceed).
//
// The per-daemon-home proxy config.json projections (ProxyProjectionState,
// below) stay OUTSIDE the ledger file on purpose: their record must sit beside
// the config.json it describes, because applyDefaultConfig's read-modify-write
// lock derives from the record path (per HOME, so hosts sharing a daemon home
// exclude each other) and because a deleted profile home takes its record with
// it -- a global ledger would keep stale claims for dead homes and widen that
// lock to every daemon at once. Same doctrine, per-home store.
import * as v from "valibot";
import { BOUNDED_LOCK_POLICY, withFileLockSync } from "../utils/file_lock.ts";
import { CopilotApiConfig } from "./config.ts";
import type { ProxyConfigPath } from "./env_config.ts";
import { CopilotApiPaths } from "./paths.ts";

/** The ledger's JSON key per ownership kind (external contracts: never rename). */
const LEDGER_KEYS = {
  webSearchDeny: "webSearchDenyPaths",
  claudeDesktop: "claudeDesktopPaths",
  codexCatalog: "codexCatalogConfigPaths",
} as const;

/** An ownership kind the ledger records (see the module header for each). */
export type OwnedArtifactKind = keyof typeof LEDGER_KEYS;

// Pre-ledger releases recorded the same ownership under these keys in the
// shared state store (`.copilot-env-state.json`). The 3.5.6 ownership migration
// moves them here; until it has run (dev checkouts never run migrations), every
// read below tolerates them and release() clears them too, so a pre-ledger
// claim keeps working and can never resurrect after a take-back.
const LEGACY_STATE_KEYS: Partial<Record<OwnedArtifactKind, string>> = {
  webSearchDeny: "webSearchDenyOwnedPaths",
  claudeDesktop: "claudeDesktopOwnedPaths",
};

/**
 * THE parser for a recorded path list: junk entries (non-strings, blanks) are
 * dropped INDIVIDUALLY, never the whole list, and survivors come back TRIMMED
 * so a hand-padded entry still matches the exact-path ownership checks. The
 * read schema and every in-place update go through it, so the two can never
 * disagree about the entry shape.
 */
function ownedPathList(value: unknown): string[] {
  return Array.isArray(value)
    ? value
      .filter((p): p is string => typeof p === "string")
      .map((p) => p.trim())
      .filter((p) => p !== "")
    : [];
}

// Lenient read schema: each list validates independently and falls back to
// empty rather than throwing -- a hand-mangled file degrades to owning less.
const LEDGER_SCHEMA = v.object({
  webSearchDenyPaths: v.fallback(v.pipe(v.unknown(), v.transform(ownedPathList)), []),
  claudeDesktopPaths: v.fallback(v.pipe(v.unknown(), v.transform(ownedPathList)), []),
  codexCatalogConfigPaths: v.fallback(v.pipe(v.unknown(), v.transform(ownedPathList)), []),
});

/**
 * Read/write helper for the ownership ledger. Backed by CopilotApiConfig (the
 * project's atomic JSON store: sorted keys, 0600, atomic rename, Windows
 * EPERM/EBUSY retry, best-effort cross-process update lock), like every other
 * copilot-env store.
 */
export class OwnershipLedger {
  private readonly store: CopilotApiConfig;
  /** The shared state store, read/cleared ONLY for the legacy pre-ledger keys. */
  private readonly legacyStore: CopilotApiConfig;
  /** The cross-store MUTATION lock (`.ops.lock`, distinct from each store's own
   *  update `.lock`): record/release/adopt each read one store to decide what to
   *  write into the other, so without one shared scope a release racing the
   *  adoption could see "not in the ledger yet" while adopt re-writes the claim
   *  it just cleared from the legacy store -- resurrecting a released claim. */
  private readonly opsLock: string;

  constructor(paths: CopilotApiPaths = new CopilotApiPaths()) {
    this.store = new CopilotApiConfig(paths.ownershipFile);
    this.legacyStore = new CopilotApiConfig(paths.sharedStateFile);
    this.opsLock = `${paths.ownershipFile}.ops.lock`;
  }

  // Both record reads are STRICT (loadStrict): they feed owns()/ownedPaths(),
  // the predicate every take-back gates on -- an unreadable store must surface,
  // never read as owns-nothing (which would strip a deny's replacement while
  // leaving the deny). Junk CONTENT still degrades via the lenient schemas.
  private ledgerPaths(kind: OwnedArtifactKind): string[] {
    return v.parse(LEDGER_SCHEMA, this.store.loadStrict())[LEDGER_KEYS[kind]];
  }

  private legacyPaths(kind: OwnedArtifactKind): string[] {
    const key = LEGACY_STATE_KEYS[kind];
    return key === undefined ? [] : ownedPathList(this.legacyStore.loadStrict()[key]);
  }

  /** Every artifact path recorded for `kind` -- ledger entries plus any legacy
   *  pre-ledger record still in the state store -- deduped. Under the ops lock (the
   *  same best-effort bounded scope every mutation takes) so a read does not observe
   *  the adoption's mid-move half-state (ledger written, legacy not yet cleared, or
   *  vice versa). */
  ownedPaths(kind: OwnedArtifactKind): string[] {
    return withFileLockSync(this.opsLock, BOUNDED_LOCK_POLICY, () => [
      ...new Set([...this.ledgerPaths(kind), ...this.legacyPaths(kind)]),
    ]);
  }

  /** Whether WE wrote the `kind` entry at this exact artifact path. */
  owns(kind: OwnedArtifactKind, artifactPath: string): boolean {
    return this.ownedPaths(kind).includes(artifactPath);
  }

  /** Record ownership of the `kind` entry at `artifactPath` (atomic, idempotent).
   *  Call AFTER the successful artifact write (the module header's crash-direction
   *  contract); the one exception is a claim reserved BEFORE a best-effort write
   *  that must never leave an unrecorded artifact behind (the Codex catalog
   *  reference's auth-time sync) -- a claim on an unwritten path is released by
   *  the next cleanup sweep. */
  record(kind: OwnedArtifactKind, artifactPath: string): void {
    withFileLockSync(this.opsLock, BOUNDED_LOCK_POLICY, () => {
      this.store.update((d) => {
        const key = LEDGER_KEYS[kind];
        const list = ownedPathList(d[key]).filter((p) => p !== artifactPath);
        list.push(artifactPath);
        d[key] = list;
      });
    });
  }

  /** Forget ownership for `artifactPath` (an emptied list drops its key, and a
   *  legacy pre-ledger record of the same path is cleared too). No write fires
   *  when nothing records the path, so steady-state sweeps stay write-free. */
  release(kind: OwnedArtifactKind, artifactPath: string): void {
    withFileLockSync(this.opsLock, BOUNDED_LOCK_POLICY, () => {
      const key = LEDGER_KEYS[kind];
      if (this.ledgerPaths(kind).includes(artifactPath)) {
        this.store.update((d) => {
          const list = ownedPathList(d[key]).filter((p) => p !== artifactPath);
          if (list.length === 0) delete d[key];
          else d[key] = list;
        });
      }
      const legacyKey = LEGACY_STATE_KEYS[kind];
      if (legacyKey !== undefined && this.legacyPaths(kind).includes(artifactPath)) {
        this.legacyStore.update((d) => {
          const list = ownedPathList(d[legacyKey]).filter((p) => p !== artifactPath);
          if (list.length === 0) delete d[legacyKey];
          else d[legacyKey] = list;
        });
      }
    });
  }

  /**
   * Move every legacy pre-ledger record from the shared state store into the
   * ledger and drop the legacy keys (the away-from-3.5.6 ownership migration).
   * Merge, never replace: ledger entries recorded since the update survive.
   * Idempotent -- a re-run finds no legacy keys and writes nothing.
   */
  adoptLegacyRecords(): void {
    withFileLockSync(this.opsLock, BOUNDED_LOCK_POLICY, () => {
      // Strict: "no legacy records" is the decision to skip the move, so it must
      // be proven, not flattened from a failed read (the runner is best-effort,
      // so the throw defers the adoption instead of falsely completing it).
      const legacy = this.legacyStore.loadStrict();
      const present = (Object.entries(LEGACY_STATE_KEYS) as [OwnedArtifactKind, string][])
        .filter(([, key]) => key in legacy);
      if (present.length === 0) return;
      const moves = present
        .map(([kind, key]) => [kind, ownedPathList(legacy[key])] as const)
        .filter(([, paths]) => paths.length > 0);
      if (moves.length > 0) {
        this.store.update((d) => {
          for (const [kind, paths] of moves) {
            const key = LEDGER_KEYS[kind];
            d[key] = [...new Set([...ownedPathList(d[key]), ...paths])];
          }
        });
      }
      // Ledger first, legacy delete second: a crash between the two leaves both
      // records (still owned, via either), and the re-run converges.
      this.legacyStore.update((d) => {
        for (const [, key] of present) delete d[key];
      });
    });
  }
}

// --- the per-daemon-home projection record ---------------------------------------
//
// Ownership record for the OPT-IN proxy config.json projections: which paths copilot-env
// itself wrote into a daemon's config.json. Recorded ownership is what lets a later
// `agent start` clear OUR leftover value once its `agent config` key is unset (`--del`),
// while a value at the same path we never projected -- a hand edit, or the daemon's own
// write -- is never deleted. The record lives in `.copilot-env-projections.json`
// (CopilotApiPaths.projectionsFile, beside the config.json it describes), NOT in the
// ledger file: per-home by design (the module header says why).

/** THE parser for the recorded path list: junk entries (non-arrays, blank or non-string
 *  keys, empty paths) are dropped WHOLE, never truncated to a parent path, and never fail
 *  the read -- a hand-mangled file degrades to "owns less", not to a crash. A well-formed
 *  path that is not ours parses fine but still claims nothing: applyDefaultConfig
 *  intersects the record with the registry's own opt-in paths before deleting anything. */
function recordedPathList(value: unknown): ProxyConfigPath[] {
  if (!Array.isArray(value)) return [];
  const out: ProxyConfigPath[] = [];
  for (const entry of value) {
    if (!Array.isArray(entry)) continue;
    const keys = entry.filter((k): k is string => typeof k === "string" && k !== "");
    const [head, ...rest] = keys;
    if (head !== undefined && keys.length === entry.length) out.push([head, ...rest]);
  }
  return out;
}

const PROJECTION_STATE_SCHEMA = v.object({
  optInPaths: v.fallback(v.pipe(v.unknown(), v.transform(recordedPathList)), []),
});

/**
 * Read/write helper for the per-daemon-home projection-ownership record. Backed by
 * CopilotApiConfig (sorted keys, 0600, atomic rename, Windows EPERM/EBUSY retry),
 * mirroring CopilotEnvRunState. applyDefaultConfig writes the record AFTER the config.json
 * apply, so a crash between the two writes can leave a projected value the record does not
 * claim -- the safe direction: an unclaimed value is never deleted, and the next successful
 * apply rewrites both files.
 */
export class ProxyProjectionState {
  private readonly store: CopilotApiConfig;
  /** The record file (`paths.projectionsFile`); the applyDefaultConfig RMW lock derives
   *  from it. */
  readonly path: string;

  constructor(paths: CopilotApiPaths) {
    this.path = paths.projectionsFile;
    this.store = new CopilotApiConfig(this.path);
  }

  /** The opt-in paths copilot-env last projected into this home's config.json.
   *  Strict read: the record decides which config.json paths applyDefaultConfig
   *  may DELETE (and whether setOwnedPaths skips its write), so an unreadable
   *  record throws rather than reading as "we projected nothing". */
  ownedPaths(): ProxyConfigPath[] {
    return v.parse(PROJECTION_STATE_SCHEMA, this.store.loadStrict()).optInPaths;
  }

  /** Replace the record with the paths the CURRENT apply projected. An empty record drops
   *  the key -- and when nothing was recorded before either, skips the write entirely, so
   *  a default-configured start never materializes an empty record file. */
  setOwnedPaths(paths: readonly ProxyConfigPath[]): void {
    if (paths.length === 0 && this.ownedPaths().length === 0) return;
    this.store.update((d) => {
      if (paths.length === 0) delete d.optInPaths;
      else d.optInPaths = paths.map((p) => [...p]);
    });
  }
}
