// copilot-env's shared, account/machine-wide state: the provisioned GitHub token
// (the SINGLE source of truth for the Direct credential + the proxy's
// `--github-token`) and the auth provider that produced it. Stored in
// `.copilot-env-state.json` under the copilot-api home -- NOT per-host `.run/` state
// (CopilotEnvRunState), since the credential applies regardless of which host/node
// runs an agent. Resolution is provider-driven (see `Credential.resolve()`):
// `gh-cli` runs `gh auth token`, `copilot`/`gh-token` return this stored token, and
// no recorded provider resolves to nothing -- there is no implicit `gh` fallback.
// `agent auth --del` clears both fields.
//
// Also carries the (equally account-wide) Codex model-catalog refresh throttle
// (`codexCatalogLastAttemptMs` + `codexCatalogCodexVersion`, src/codex/catalog.ts)
// -- one shared state file rather than a second store for two small fields, and
// exactly ONE write per due refresh: the underlying save is atomic per write and
// update() takes a best-effort cross-process lock, so extra writers mostly add
// contention rather than lost updates -- but the lock is advisory, so keeping the
// writer count minimal still matters.
import * as v from "valibot";
import { isRecord } from "../utils/json.ts";
import { CopilotApiConfig } from "./config.ts";
import { INTEGRATION_ID_RE } from "./env_config.ts";
import { CopilotApiPaths, profileHomeNames } from "./paths.ts";
import { isValidProfileName, parseProfileName, type Profile, type ProfileName } from "./profile.ts";

// The provider vocabulary lives HERE, with the store that persists `authProvider`,
// so env_state can validate it at the read boundary without importing from the
// auth/`Credential` layer (which would cycle -- Credential wraps this store).
// `src/commands/auth.ts` and `Credential` re-import these.
export const AUTH_PROVIDERS = ["copilot", "gh-cli", "gh-token"] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];
/** A provider that stores a token of our own (vs `gh-cli`, which holds none). */
export type TokenProvider = Extract<AuthProvider, "copilot" | "gh-token">;

// --- named credential profiles -----------------------------------------------
//
// A profile is an OPT-IN named unit beside the default: ONE credential slot plus
// ONE wiring mode (direct or proxy, never both), applied to BOTH agents by
// `agent profile`. The default credential stays in the top-level fields -- an
// absent `profiles` map plus the top-level pair IS the default profile, so
// existing installs need no migration and a store that never used profiles stays
// byte-identical to the pre-profile format. Named profiles NEVER fall back to
// the default credential (ask, never silently fall back); `Credential` enforces
// that by reading ONLY the addressed slot via readCredential/setCredential, the
// single routing point between the two layouts. The `mode` field makes THIS
// store the source of truth for a profile's wiring (the agent artifacts are
// derived from it), which is what lets one command create/check/delete a
// profile atomically.

/** A profile's wiring mode (mirrors ManagedAgentMode; declared here so the store
 *  layer stays dependency-light). */
export const PROFILE_MODES = ["direct", "proxy"] as const;
export type ProfileMode = (typeof PROFILE_MODES)[number];

/** One profile's credential slot (same semantics as the top-level pair). */
export interface ProfileCredentialData {
  githubToken: string | null;
  authProvider: AuthProvider | null;
}

/** A profile's full slot: its credential plus its single wiring mode. */
export interface ProfileSlotData extends ProfileCredentialData {
  mode: ProfileMode | null;
  /**
   * The probed direct-mode client identity NAME (an IntegrationIdentity name from
   * integration_identity.ts, e.g. `codex` for the default or `copilot-developer-cli`),
   * or null when never probed. Storing the NAME -- not the header value -- lets
   * "probed, the default won" be distinguished from "unknown", so the launcher hot path
   * (`--settings-for`/`--sync` on every profile launch) replays instead of re-probing.
   * It is a cache derived from the credential: `setCredential` clears it.
   */
  integrationIdentity: string | null;
}

/** The fields persisted in `.copilot-env-state.json` (absent/blank read back as null). */
export interface CopilotEnvStateData {
  /** Provisioned GitHub OAuth token (Copilot-enabled), or null when unset/blank. */
  githubToken: string | null;
  /** How the user authenticated, or null when unset/unrecognized. */
  authProvider: AuthProvider | null;
  /** Named profiles (empty when none were ever created). */
  profiles: Record<string, ProfileSlotData>;
  /** Epoch ms of the last Codex model-catalog generation ATTEMPT (0 if never). */
  codexCatalogLastAttemptMs: number;
  /** The codex CLI version the catalog was last generated against (null if never). */
  codexCatalogCodexVersion: string | null;
  /** The CATALOG_PATCH_VERSION the catalog was last generated with (0 if never):
   *  a copilot-env whose patch logic changed regenerates on the next refresh
   *  instead of serving the old patch for up to a day (src/codex/catalog.ts). */
  codexCatalogPatchVersion: number;
  /**
   * The settings.json PATHS whose `permissions.deny` copilot-env itself ADDED the
   * `WebSearch` entry to (the direct-wiring pair in src/claude/config.ts). Keying
   * ownership to the exact files means a deny the user already had - or one in a
   * different CLAUDE_CONFIG_DIR - is never ours to remove, and wiring one Claude
   * home never forgets ownership taken in another; a proxy switch / uninstall /
   * `agent mcp --remove` only ever takes back the entry we put in THAT file.
   */
  webSearchDenyOwnedPaths: string[];
  /**
   * The Claude Desktop config-library entry PATHS (absolute `<dir>/<uuid>.json`)
   * copilot-env itself created or adopted (src/claude/desktop.ts). Same exact-path
   * ownership doctrine as webSearchDenyOwnedPaths: an entry the user made - or one
   * in a differently-located library - is never ours to rewrite or remove.
   */
  claudeDesktopOwnedPaths: string[];
}

// Mirror CopilotEnvRunState/AutoupdateState's patch spelling (`Data[K] | null`).
type EnvStatePatch = {
  [K in keyof Omit<CopilotEnvStateData, "profiles">]?: CopilotEnvStateData[K] | null;
};
type ProfilePatch = { [K in keyof ProfileSlotData]?: ProfileSlotData[K] | null };
type ProfileCredentialPatch = {
  [K in keyof ProfileCredentialData]?: ProfileCredentialData[K] | null;
};

// One profile slot: the same lenient credential contract as the top-level pair,
// plus the profile's single wiring mode.
const PROFILE_SCHEMA = v.object({
  githubToken: v.fallback(v.nullable(v.pipe(v.string(), v.trim(), v.minLength(1))), null),
  authProvider: v.fallback(v.nullable(v.picklist(AUTH_PROVIDERS)), null),
  mode: v.fallback(v.nullable(v.picklist(PROFILE_MODES)), null),
  // Header-safe shape enforced at the read boundary: the cached identity flows
  // verbatim into HTTP headers, so a hand-mangled value reads as null = re-probe.
  integrationIdentity: v.fallback(
    v.nullable(v.pipe(v.string(), v.trim(), v.regex(INTEGRATION_ID_RE))),
    null,
  ),
});

// Lenient read schema: each field validates the value we own and FALLS BACK rather
// than throwing, so a blank/ill-typed/unknown value reads as null (the same
// forgiving contract the hand-rolled reader had). A trimmed-blank string is null;
// an unrecognized provider is null (validated against the picklist at the boundary).
const STATE_SCHEMA = v.object({
  githubToken: v.fallback(v.nullable(v.pipe(v.string(), v.trim(), v.minLength(1))), null),
  authProvider: v.fallback(v.nullable(v.picklist(AUTH_PROVIDERS)), null),
  profiles: v.fallback(v.record(v.string(), v.fallback(PROFILE_SCHEMA, emptyProfile())), {}),
  codexCatalogLastAttemptMs: v.fallback(v.pipe(v.number(), v.finite(), v.minValue(0)), 0),
  codexCatalogCodexVersion: v.fallback(
    v.nullable(v.pipe(v.string(), v.trim(), v.minLength(1))),
    null,
  ),
  codexCatalogPatchVersion: v.fallback(v.pipe(v.number(), v.finite(), v.minValue(0)), 0),
  // ownedPathList owns the shape; the fallback only covers an ABSENT key (the
  // pipe itself never issues -- junk entries are dropped inside the transform).
  webSearchDenyOwnedPaths: v.fallback(v.pipe(v.unknown(), v.transform(ownedPathList)), []),
  claudeDesktopOwnedPaths: v.fallback(v.pipe(v.unknown(), v.transform(ownedPathList)), []),
});

function emptyProfile(): ProfileSlotData {
  return { githubToken: null, authProvider: null, mode: null, integrationIdentity: null };
}

/**
 * Names of EVERY named profile the system knows about: the store's slots unioned
 * with the on-disk daemon homes, sorted -- so a half-created profile (a credential
 * without a home, or a home without a credential) is still seen. THE "every
 * profile" answer, shared by `agent profile --list` and `agent uninstall`.
 */
export function allProfileNames(): ProfileName[] {
  return [...new Set([...new CopilotEnvState().profileNames(), ...profileHomeNames()])].sort();
}

/**
 * Hard gate for read-only commands that ADDRESS an existing profile (`agent env`,
 * `agent models`): a typo'd `--profile` must error naming the known profiles, never
 * resolve against default (or half-default) wiring -- `agent env`'s stdout is evaled
 * by the shell wrapper, so a wrong-profile answer would be silently applied.
 */
export function assertKnownProfile(name: ProfileName): void {
  const names = allProfileNames();
  if (names.includes(name)) return;
  const hint = names.length === 0
    ? "no profiles exist - create one with `agent profile --add <name> --direct|--proxy`"
    : `known profiles: ${names.join(", ")}`;
  throw new Error(`no such profile '${name}' (${hint})`);
}

/**
 * THE parser for the owned-paths entry: junk entries (non-strings, blanks) are
 * dropped INDIVIDUALLY, never the whole list, and survivors come back TRIMMED so
 * a hand-padded entry still matches the exact-path ownership checks. Both the
 * read schema above and the in-place update paths below go through it, so the
 * two can never disagree about the entry's shape.
 */
function ownedPathList(value: unknown): string[] {
  return Array.isArray(value)
    ? value
      .filter((p): p is string => typeof p === "string")
      .map((p) => p.trim())
      .filter((p) => p !== "")
    : [];
}

/**
 * Read/write helper for the shared `.copilot-env-state.json`. Backed by
 * CopilotApiConfig (the project's atomic JSON store: sorted keys, 0600, atomic
 * rename, Windows EPERM/EBUSY retry) and mirroring CopilotEnvRunState -- one I/O
 * implementation. Holds the credential + catalog-refresh state; user preferences
 * live in CopilotEnvConfig.
 */
export class CopilotEnvState {
  private readonly store: CopilotApiConfig;

  constructor(path?: string) {
    this.store = new CopilotApiConfig(path ?? new CopilotApiPaths().sharedStateFile);
  }

  /** Current state; absent/ill-typed/blank/unknown fields come back null. */
  read(): CopilotEnvStateData {
    return v.parse(STATE_SCHEMA, this.store.load());
  }

  /**
   * Merge `patch`. String values are credentials/labels, so they're trimmed and a
   * null/undefined OR blank value deletes the key -- a blank token is never
   * meaningful, so it clears rather than persisting `""`. Numeric values (the
   * catalog attempt timestamp) are stored as-is; null/undefined deletes.
   */
  set(patch: EnvStatePatch): void {
    this.store.update((d) => {
      for (const key of Object.keys(patch) as (keyof EnvStatePatch)[]) {
        const value = patch[key];
        if (
          value === null ||
          value === undefined ||
          (typeof value === "string" && value.trim() === "")
        ) {
          delete d[key];
        } else {
          d[key] = typeof value === "string" ? value.trim() : value;
        }
      }
    });
  }

  /**
   * The credential slot addressed by `profile` (null = the default top-level
   * pair). THE single routing point between the two on-disk layouts; a
   * never-created named profile reads as empty (no fallback to the default).
   */
  readCredential(profile: Profile): ProfileCredentialData {
    const data = this.read();
    if (profile === null) {
      return { githubToken: data.githubToken, authProvider: data.authProvider };
    }
    // Object.hasOwn, not `?? emptyProfile()` alone: the profiles record carries
    // Object.prototype, so a name like "constructor" would otherwise resolve up the
    // chain to a truthy function instead of the empty slot.
    const slot = Object.hasOwn(data.profiles, profile) ? data.profiles[profile] : undefined;
    const { githubToken, authProvider } = slot ?? emptyProfile();
    return { githubToken, authProvider };
  }

  /** The full slot for a NAMED profile (credential + mode); never-created reads empty. */
  readProfileSlot(name: ProfileName): ProfileSlotData {
    return this.profileSlotStatus(name).slot;
  }

  /** Like readProfileSlot, plus whether the store actually carries the slot --
   *  both from ONE read, so existence and contents can never disagree under a
   *  concurrent write (health's fact-gathering seam). */
  profileSlotStatus(name: ProfileName): { exists: boolean; slot: ProfileSlotData } {
    const profiles = this.read().profiles;
    // Own-property check for the same prototype-chain reason as readCredential.
    const slot = Object.hasOwn(profiles, name) ? profiles[name] : undefined;
    return { exists: slot !== undefined, slot: slot ?? emptyProfile() };
  }

  /** Every named profile in the store, sorted. The `profiles` map lives in the
   *  user-editable state file, so its keys are a trust boundary: a key that is
   *  not a valid profile name (a hand-edited/corrupted file) is skipped -- the
   *  same sweep semantic as profileHomeNames' filter -- so an invalid key can
   *  never reach a path join. */
  profileNames(): ProfileName[] {
    return Object.keys(this.read().profiles)
      .filter((name) => isValidProfileName(name))
      .map((name) => parseProfileName(name))
      .sort();
  }

  /**
   * Merge `patch` into the credential slot addressed by `profile` (same
   * trim/blank-deletes contract as `set`). A named profile whose fields all
   * cleared is removed outright, and an empty map drops the `profiles` key --
   * so a store that never used profiles stays byte-identical to the
   * pre-profile format. A named profile's `mode` is untouched here (it is not
   * a credential field); `setProfileMode` owns it. The derived
   * `integrationIdentity` IS cleared, though: it is a probe result keyed to the
   * credential, so any credential change (re-auth, deletion) must invalidate it
   * -- the next wiring re-derives it.
   */
  setCredential(profile: Profile, patch: ProfileCredentialPatch): void {
    if (profile === null) {
      this.set(patch);
      return;
    }
    this.mergeProfileSlot(profile, { ...patch, integrationIdentity: null });
  }

  /** Record (or clear, with null) a NAMED profile's single wiring mode. */
  setProfileMode(name: ProfileName, mode: ProfileMode | null): void {
    this.mergeProfileSlot(name, { mode });
  }

  /** Record (or clear, with null) a NAMED profile's probed direct-mode identity. */
  setProfileIntegrationIdentity(name: ProfileName, integrationIdentity: string | null): void {
    this.mergeProfileSlot(name, { integrationIdentity });
  }

  /** Whether WE added the WebSearch deny to this exact settings file. */
  ownsWebSearchDeny(settingsPath: string): boolean {
    return this.read().webSearchDenyOwnedPaths.includes(settingsPath);
  }

  /** Record that we added the WebSearch deny to `settingsPath` (atomic, idempotent). */
  addWebSearchDenyOwnedPath(settingsPath: string): void {
    this.store.update((d) => {
      const list = ownedPathList(d.webSearchDenyOwnedPaths).filter((p) => p !== settingsPath);
      list.push(settingsPath);
      d.webSearchDenyOwnedPaths = list;
    });
  }

  /** Forget ownership for `settingsPath`; an emptied list drops the key entirely. */
  removeWebSearchDenyOwnedPath(settingsPath: string): void {
    this.store.update((d) => {
      const list = ownedPathList(d.webSearchDenyOwnedPaths).filter((p) => p !== settingsPath);
      if (list.length === 0) delete d.webSearchDenyOwnedPaths;
      else d.webSearchDenyOwnedPaths = list;
    });
  }

  /** Whether WE created or adopted this exact Claude Desktop config-library entry. */
  ownsClaudeDesktopEntry(configPath: string): boolean {
    return this.read().claudeDesktopOwnedPaths.includes(configPath);
  }

  /** Record ownership of the Desktop entry at `configPath` (atomic, idempotent). */
  addClaudeDesktopOwnedPath(configPath: string): void {
    this.store.update((d) => {
      const list = ownedPathList(d.claudeDesktopOwnedPaths).filter((p) => p !== configPath);
      list.push(configPath);
      d.claudeDesktopOwnedPaths = list;
    });
  }

  /** Forget ownership for `configPath`; an emptied list drops the key entirely. */
  removeClaudeDesktopOwnedPath(configPath: string): void {
    this.store.update((d) => {
      const list = ownedPathList(d.claudeDesktopOwnedPaths).filter((p) => p !== configPath);
      if (list.length === 0) delete d.claudeDesktopOwnedPaths;
      else d.claudeDesktopOwnedPaths = list;
    });
  }

  private mergeProfileSlot(name: ProfileName, patch: ProfilePatch): void {
    this.store.update((d) => {
      const profiles = isRecord(d.profiles) ? d.profiles : {};
      // Own-property read (see readProfileSlot); isRecord would also reject an
      // inherited function, but say what we mean.
      const slotRaw = Object.hasOwn(profiles, name) ? profiles[name] : undefined;
      const slot: Record<string, unknown> = isRecord(slotRaw) ? slotRaw : {};
      for (const key of Object.keys(patch) as (keyof ProfilePatch)[]) {
        const value = patch[key];
        if (value === null || value === undefined || value.trim() === "") {
          delete slot[key];
        } else {
          slot[key] = value.trim();
        }
      }
      if (Object.keys(slot).length === 0) {
        delete profiles[name];
      } else {
        profiles[name] = slot;
      }
      if (Object.keys(profiles).length === 0) {
        delete d.profiles;
      } else {
        d.profiles = profiles;
      }
    });
  }
}
