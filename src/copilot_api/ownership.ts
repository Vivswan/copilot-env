// Which entries copilot-env ITSELF wrote into external config artifacts, so a removal takes back exactly
// what we added and never an entry the user or another program put there. It names THIS machine's files,
// so it is never part of the `agent settings` bundle.
//   webSearchDeny  -> settings.json files whose `permissions.deny` WE gave the `WebSearch` entry (src/claude/config.ts)
//   claudeDesktop  -> Claude Desktop config-library entries WE created or adopted (src/claude/desktop.ts)
//   codexCatalog   -> Codex config.toml files WE wrote the `model_catalog_json` reference into (src/codex/config.ts)
// Ordering doctrine for every kind, so a crash or a bad read lands on the safe side of a claim:
//   record AFTER the write                      -> a crash leaves the entry we wrote UNCLAIMED, never a false claim
//   release AFTER the take-back                 -> a crash leaves a claim on an entry already gone; a take-back that selects it finds nothing to strip and releases the claim
//   one exception, the Codex catalog reference  -> claims BEFORE its write (record(), src/codex/catalog_reference.ts), so a crash there claims an unwritten path
//   unreadable store                            -> loadStrict THROWS; "owns nothing" is a verdict, never a default
//   mutations on ONE ops lock, reads on none    -> read-only commands write nothing; the lock covers the ledger write alone, never a take-back's owns() decision
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

export type OwnedArtifactKind = keyof typeof LEDGER_KEYS;

// Pre-ledger keys in the shared state store (`credentials.json`). ONLY adoptLegacyRecords reads them: the
// ledger's own readers answer from the ledger file alone, so an unmigrated record owns nothing until
// `agent update` has moved it.
const LEGACY_STATE_KEYS: Partial<Record<OwnedArtifactKind, string>> = {
  webSearchDeny: "webSearchDenyOwnedPaths",
  claudeDesktop: "claudeDesktopOwnedPaths",
};

/** Junk entries are dropped INDIVIDUALLY, never the whole list, and survivors come back TRIMMED so a
 *  hand-padded entry still matches the exact-path checks. The read schema and every in-place update
 *  share it, so the two can never disagree about the entry shape. */
function ownedPathList(value: unknown): string[] {
  return Array.isArray(value)
    ? value
      .filter((p): p is string => typeof p === "string")
      .map((p) => p.trim())
      .filter((p) => p !== "")
    : [];
}

// Each list falls back independently, so a hand-mangled file degrades to owning less.
const LEDGER_SCHEMA = v.object({
  webSearchDenyPaths: v.fallback(v.pipe(v.unknown(), v.transform(ownedPathList)), []),
  claudeDesktopPaths: v.fallback(v.pipe(v.unknown(), v.transform(ownedPathList)), []),
  codexCatalogConfigPaths: v.fallback(v.pipe(v.unknown(), v.transform(ownedPathList)), []),
});

export class OwnershipLedger {
  private readonly store: CopilotApiConfig;
  /** The shared state store, read/cleared ONLY by adoptLegacyRecords. */
  private readonly legacyStore: CopilotApiConfig;
  /** Distinct from each store's own update `.lock`: the adoption reads the legacy store, then writes the
   *  ledger, and a release landing between the two could clear the ledger's copy just before the
   *  adoption re-adds the one it read. */
  private readonly opsLock: string;

  constructor(paths: CopilotApiPaths = new CopilotApiPaths()) {
    this.store = new CopilotApiConfig(paths.ownershipFile, paths.ownershipLock);
    this.legacyStore = new CopilotApiConfig(paths.sharedStateFile, paths.sharedStateLock);
    this.opsLock = paths.ownershipOpsLock;
  }

  /** STRICT: this feeds owns(), the predicate every take-back gates on, and an unreadable store must
   *  surface rather than read as owns-nothing (which would strip a deny's replacement while leaving the
   *  deny). Lock-free: it writes nothing. */
  ownedPaths(kind: OwnedArtifactKind): string[] {
    return v.parse(LEDGER_SCHEMA, this.store.loadStrict())[LEDGER_KEYS[kind]];
  }

  owns(kind: OwnedArtifactKind, artifactPath: string): boolean {
    return this.ownedPaths(kind).includes(artifactPath);
  }

  /** Call AFTER the successful artifact write. The one exception is a claim reserved BEFORE a best-effort
   *  write that must never leave an unrecorded artifact behind (the Codex catalog reference's auth-time
   *  sync); the next cleanup sweep releases a claim on an unwritten path. */
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

  /** No write fires when nothing records the path, so steady-state sweeps stay write-free. */
  release(kind: OwnedArtifactKind, artifactPath: string): void {
    withFileLockSync(this.opsLock, BOUNDED_LOCK_POLICY, () => {
      if (!this.ownedPaths(kind).includes(artifactPath)) return;
      const key = LEDGER_KEYS[kind];
      this.store.update((d) => {
        const list = ownedPathList(d[key]).filter((p) => p !== artifactPath);
        if (list.length === 0) delete d[key];
        else d[key] = list;
      });
    });
  }

  /** Merge, never replace: ledger entries recorded since the update survive, and a re-run finds no
   *  legacy keys and writes nothing. */
  adoptLegacyRecords(): void {
    withFileLockSync(this.opsLock, BOUNDED_LOCK_POLICY, () => {
      // "No legacy records" is the decision to skip the move, so it must be proven, not flattened from a
      // failed read; the runner is best-effort, so the throw defers the adoption instead of falsely completing it.
      const legacy = this.legacyStore.loadStrict();
      const present = (Object.entries(LEGACY_STATE_KEYS) as [OwnedArtifactKind, string][])
        .filter(([, key]) => key in legacy);
      if (present.length === 0) return;
      const moves = present
        .map(([kind, key]) => [kind, ownedPathList(legacy[key])] as const)
        .filter(([, paths]) => paths.length > 0);
      // The ledger's read-side refusals are cleared BEFORE the legacy delete: a malformed ledger refused
      // after it would lose the record (the runner carries on past a failed step).
      if (moves.length > 0) this.store.loadForUpdate();
      // Legacy delete FIRST: a crash between the two loses the claim (the safe direction), whereas the other
      // order leaves a second copy a re-run could re-adopt AFTER a take-back released the ledger's, resurrecting it.
      this.legacyStore.update((d) => {
        for (const [, key] of present) delete d[key];
      });
      if (moves.length === 0) return;
      this.store.update((d) => {
        for (const [kind, paths] of moves) {
          const key = LEDGER_KEYS[kind];
          d[key] = [...new Set([...ownedPathList(d[key]), ...paths])];
        }
      });
    });
  }
}

// --- the per-daemon-home projection record ---------------------------------------
//
// Which paths copilot-env itself wrote into a daemon's config.json (the OPT-IN projections), so a later
// `agent start` clears OUR leftover once its `agent config` key is unset, while a value at the same path
// we never projected (a hand edit, or the daemon's own write) is never deleted. Per home, beside the
// config.json (ProxyProjectionState says why).

/** Junk entries are dropped WHOLE, never truncated to a parent path, and never fail the read. A
 *  well-formed path that is not ours still claims nothing: applyDefaultConfig intersects the record with
 *  the registry's own opt-in paths before deleting anything. */
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
 * Kept OUTSIDE the ledger on purpose: applyDefaultConfig's read-modify-write lock derives from the record
 * path (per HOME, so hosts sharing a daemon home exclude each other), and a deleted profile home takes its
 * record with it; a global ledger would keep stale claims for dead homes and widen that lock to every daemon.
 * Same doctrine as the ledger: written AFTER the config.json apply, so a crash leaves an unclaimed value.
 */
export class ProxyProjectionState {
  private readonly store: CopilotApiConfig;
  /** The applyDefaultConfig RMW lock derives from this path. */
  readonly path: string;

  constructor(paths: CopilotApiPaths) {
    this.path = paths.projectionsFile;
    this.store = new CopilotApiConfig(this.path);
  }

  /** Strict: the record decides which config.json paths applyDefaultConfig may DELETE, so an unreadable
   *  record throws rather than reading as "we projected nothing". */
  ownedPaths(): ProxyConfigPath[] {
    return v.parse(PROJECTION_STATE_SCHEMA, this.store.loadStrict()).optInPaths;
  }

  /** No write when nothing was recorded before or after, so a default-configured start never
   *  materializes an empty record file. */
  setOwnedPaths(paths: readonly ProxyConfigPath[]): void {
    if (paths.length === 0 && this.ownedPaths().length === 0) return;
    this.store.update((d) => {
      if (paths.length === 0) delete d.optInPaths;
      else d.optInPaths = paths.map((p) => [...p]);
    });
  }
}
