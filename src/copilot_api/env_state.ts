// copilot-env's shared, account/machine-wide state: the provisioned GitHub token
// (the SINGLE source of truth for the Direct credential + the proxy's
// `--github-token`) and the auth provider that produced it. Stored in
// `.copilot-env-state.json` under the copilot-api home -- NOT per-host `.run/` state
// (CopilotEnvRunState), since the credential applies regardless of which host/node
// runs an agent. Resolution is provider-driven (see `Credential.resolve()`):
// `gh-cli` runs `gh auth token`, `copilot`/`gh-token` return this stored token, and
// no recorded provider resolves to nothing -- there is no implicit `gh` fallback.
// `agent auth --del` clears both fields.
import * as v from "valibot";
import { CopilotApiConfig } from "./config.ts";
import { CopilotApiPaths } from "./paths.ts";

// The provider vocabulary lives HERE, with the store that persists `authProvider`,
// so env_state can validate it at the read boundary without importing from the
// auth/`Credential` layer (which would cycle -- Credential wraps this store).
// `src/commands/auth.ts` and `Credential` re-import these.
export const AUTH_PROVIDERS = ["copilot", "gh-cli", "gh-token"] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];
/** A provider that stores a token of our own (vs `gh-cli`, which holds none). */
export type TokenProvider = Extract<AuthProvider, "copilot" | "gh-token">;

/** The fields persisted in `.copilot-env-state.json` (absent/blank read back as null). */
export interface CopilotEnvStateData {
  /** Provisioned GitHub OAuth token (Copilot-enabled), or null when unset/blank. */
  githubToken: string | null;
  /** How the user authenticated, or null when unset/unrecognized. */
  authProvider: AuthProvider | null;
  /**
   * Whether the managed proxy lifecycle is enabled (`agent init --auto-start`): the
   * agents' proxy resolvers auto-start the proxy on demand AND it auto-stops when idle.
   * Account/machine-wide, so it lives here beside the credential. Null/absent => off.
   */
  autoStart: boolean | null;
}

// Mirror CopilotEnvRunState/AutoupdateState's patch spelling (`Data[K] | null`).
type EnvStatePatch = { [K in keyof CopilotEnvStateData]?: CopilotEnvStateData[K] | null };

// Lenient read schema: each field validates the value we own and FALLS BACK rather
// than throwing, so a blank/ill-typed/unknown value reads as null (the same
// forgiving contract the hand-rolled reader had). A trimmed-blank string is null;
// an unrecognized provider is null (validated against the picklist at the boundary).
const STATE_SCHEMA = v.object({
  githubToken: v.fallback(v.nullable(v.pipe(v.string(), v.trim(), v.minLength(1))), null),
  authProvider: v.fallback(v.nullable(v.picklist(AUTH_PROVIDERS)), null),
  autoStart: v.fallback(v.nullable(v.boolean()), null),
});

/**
 * Read/write helper for the shared `.copilot-env-state.json`. Backed by
 * CopilotApiConfig (the project's atomic JSON store: sorted keys, 0600, atomic
 * rename, Windows EPERM/EBUSY retry) and mirroring CopilotEnvRunState -- one I/O
 * implementation.
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

  /** Whether the managed proxy lifecycle (auto-start + idle auto-stop) is enabled. */
  autoStartEnabled(): boolean {
    return this.read().autoStart === true;
  }

  /**
   * Merge `patch`. String values (credentials/labels) are trimmed and a null/undefined
   * OR blank value deletes the key -- a blank token is never meaningful, so it clears
   * rather than persisting `""`. Boolean values (e.g. `autoStart`) are stored as-is; a
   * null/undefined boolean deletes the key.
   */
  set(patch: EnvStatePatch): void {
    this.store.update((d) => {
      for (const key of Object.keys(patch) as (keyof EnvStatePatch)[]) {
        const value = patch[key];
        if (value === null || value === undefined) {
          delete d[key];
        } else if (typeof value === "string") {
          if (value.trim() === "") delete d[key];
          else d[key] = value.trim();
        } else {
          d[key] = value;
        }
      }
    });
  }
}
