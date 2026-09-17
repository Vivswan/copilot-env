// Which entries copilot-env ITSELF wrote into external config artifacts, so a removal takes back exactly
// what we added and never an entry the user or another program put there. It names THIS machine's files,
// so it is never part of the `agent settings` bundle.
//   webSearchDeny  -> settings.json files whose `permissions.deny` WE gave the `WebSearch` entry (src/claude/config.ts)
//   claudeDesktop  -> Claude Desktop config-library entries WE created or adopted (src/claude/desktop.ts)
//   codexCatalog   -> Codex config.toml files WE wrote the `model_catalog_json` reference into (src/codex/config.ts)
// Ordering doctrine for every kind, so a crash or a bad read lands on the safe side of a claim:
//   record AFTER the write                      -> a crash leaves the entry we wrote UNCLAIMED, never a false claim
//   release AFTER the take-back                 -> a crash leaves a claim on an entry already gone; a take-back
//                                                  that selects it finds nothing to strip and releases the claim
//   one exception, the Codex catalog reference  -> claims BEFORE its write (record(), src/codex/catalog_reference.ts),
//                                                  so a crash there claims an unwritten path
//   unreadable store                            -> loadStrict THROWS; "owns nothing" is a verdict, never a default
//   mutations under the store's lock, reads on none -> read-only commands write nothing; the lock covers
//                                                  the ledger write alone, never a take-back's owns() decision
// The ledger is the `ownership` map of the one account-wide store (src/copilot_api/state_store.ts).
import * as v from "valibot";
import { CopilotApiConfig } from "./config.ts";
import type { ProxyConfigPath } from "./env_config.ts";
import type { CopilotApiPaths } from "./paths.ts";
import { rootStateStore, StateSection } from "./state_store.ts";

/** The ledger's JSON key per ownership kind (external contracts: never rename). */
const LEDGER_KEYS = {
  webSearchDeny: "webSearchDenyPaths",
  claudeDesktop: "claudeDesktopPaths",
  codexCatalog: "codexCatalogConfigPaths",
} as const;

export type OwnedArtifactKind = keyof typeof LEDGER_KEYS;

/** The ledger's keys as stored: what `agent config` refuses to set by name (src/commands/config.ts). */
export const LEDGER_KEY_NAMES: readonly string[] = Object.values(LEDGER_KEYS);

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
  private readonly store: StateSection;

  constructor(paths?: CopilotApiPaths) {
    this.store = new StateSection(
      "ownership",
      paths === undefined
        ? rootStateStore()
        : new CopilotApiConfig(paths.stateStoreFile, paths.stateStoreLock),
    );
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
    this.store.update((d) => {
      const key = LEDGER_KEYS[kind];
      const list = ownedPathList(d[key]).filter((p) => p !== artifactPath);
      list.push(artifactPath);
      d[key] = list;
    });
  }

  /** No write fires when nothing records the path, so steady-state sweeps stay write-free; the
   *  list is re-read under the lock, so a record() landing in between is kept. */
  release(kind: OwnedArtifactKind, artifactPath: string): void {
    if (!this.ownedPaths(kind).includes(artifactPath)) return;
    const key = LEDGER_KEYS[kind];
    this.store.update((d) => {
      const list = ownedPathList(d[key]).filter((p) => p !== artifactPath);
      if (list.length === 0) delete d[key];
      else d[key] = list;
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
