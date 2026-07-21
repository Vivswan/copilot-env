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
import { CopilotApiPaths } from "./paths.ts";
import type { Profile } from "./profile.ts";

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
});

function emptyProfile(): ProfileSlotData {
  return { githubToken: null, authProvider: null, mode: null };
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
    const { githubToken, authProvider } = data.profiles[profile] ?? emptyProfile();
    return { githubToken, authProvider };
  }

  /** The full slot for a NAMED profile (credential + mode); never-created reads empty. */
  readProfileSlot(name: string): ProfileSlotData {
    return this.read().profiles[name] ?? emptyProfile();
  }

  /** Every named profile in the store, sorted. */
  profileNames(): string[] {
    return Object.keys(this.read().profiles).sort();
  }

  /**
   * Merge `patch` into the credential slot addressed by `profile` (same
   * trim/blank-deletes contract as `set`). A named profile whose fields all
   * cleared is removed outright, and an empty map drops the `profiles` key --
   * so a store that never used profiles stays byte-identical to the
   * pre-profile format. A named profile's `mode` is untouched here (it is not
   * a credential field); `setProfileMode` owns it.
   */
  setCredential(profile: Profile, patch: ProfileCredentialPatch): void {
    if (profile === null) {
      this.set(patch);
      return;
    }
    this.mergeProfileSlot(profile, patch);
  }

  /** Record (or clear, with null) a NAMED profile's single wiring mode. */
  setProfileMode(name: string, mode: ProfileMode | null): void {
    this.mergeProfileSlot(name, { mode });
  }

  private mergeProfileSlot(name: string, patch: ProfilePatch): void {
    this.store.update((d) => {
      const profiles = isRecord(d.profiles) ? d.profiles : {};
      const slotRaw = profiles[name];
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
