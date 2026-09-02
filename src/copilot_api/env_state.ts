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

function isAuthProvider(provider: string): provider is AuthProvider {
  return (AUTH_PROVIDERS as readonly string[]).includes(provider);
}

/**
 * A credential slot the store can actually WRITE: a token-backed provider always
 * travels with its token, and `gh-cli` can never carry one -- the two
 * contradictions the settings-bundle parser rejects (token without a provider,
 * token with gh-cli) are unrepresentable here, so no writer needs to re-check.
 */
export type ProvisionedCredential =
  | { kind: "gh-cli" }
  | { kind: "stored"; provider: TokenProvider; token: string };

/**
 * A credential slot as the READ boundary parses it. "none" is fail-closed: a
 * null/unknown provider OR a token-backed provider whose token is gone both
 * resolve to nothing (no implicit gh fallback) -- `provider` keeps the recorded
 * choice for diagnostics ("provider 'gh-token' selected but no credential
 * resolves"), null when nothing was ever chosen.
 */
export type StoredCredential =
  | { kind: "none"; provider: TokenProvider | null }
  | ProvisionedCredential;

/**
 * The same fail-closed classification for consumers that carry only the
 * provider and token PRESENCE (health facts never hold the token itself).
 * Must agree with the read boundary's parse; pinned by test.
 */
export function storedCredentialKind(
  provider: string | null,
  hasStoredToken: boolean,
): StoredCredential["kind"] {
  if (provider === null || !isAuthProvider(provider)) return "none";
  if (provider === "gh-cli") return "gh-cli";
  return hasStoredToken ? "stored" : "none";
}

/** The recorded provider behind a parsed credential (null = never chosen). */
export function credentialProvider(credential: StoredCredential): AuthProvider | null {
  switch (credential.kind) {
    case "none":
      return credential.provider;
    case "gh-cli":
      return "gh-cli";
    case "stored":
      return credential.provider;
  }
}

/** Parse a raw stored pair into the credential union (the read boundary). */
function parseStoredCredential(
  githubToken: string | null,
  authProvider: AuthProvider | null,
): StoredCredential {
  if (authProvider === null) return { kind: "none", provider: null };
  if (authProvider === "gh-cli") return { kind: "gh-cli" };
  return githubToken === null
    ? { kind: "none", provider: authProvider }
    : { kind: "stored", provider: authProvider, token: githubToken };
}

/** The raw persisted pair for a provisioned credential (gh-cli holds no token).
 *  The token is trimmed on the way in, and a blank one is rejected here -- the
 *  single choke point every credential write funnels through, so a whitespace
 *  token can never persist as a provider-without-token partial. */
function rawCredentialPatch(
  credential: ProvisionedCredential,
): { githubToken: string | null; authProvider: AuthProvider } {
  if (credential.kind === "gh-cli") return { githubToken: null, authProvider: "gh-cli" };
  const token = credential.token.trim();
  if (token === "") {
    throw new Error(
      `a stored credential requires a non-empty token (provider '${credential.provider}')`,
    );
  }
  return { githubToken: token, authProvider: credential.provider };
}

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

/** A profile's full RAW slot as persisted (also the export bundle's shape). */
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

/**
 * A named profile's slot at the READ boundary, parsed into completeness.
 * "complete" is the atomic unit `agent profile` commits -- ONE resolvable
 * credential plus ONE wiring mode -- and the only kind the launch/wiring paths
 * act on. "partial" is everything else the store can still carry (a pre-atomic
 * install's interrupted add, a hand edit, a de-authed credential half, or a
 * never-created name reading back empty); consumers render its gaps for repair
 * instead of re-deriving completeness themselves.
 */
export type ProfileSlot =
  | {
    kind: "complete";
    credential: ProvisionedCredential;
    mode: ProfileMode;
    integrationIdentity: string | null;
  }
  | {
    kind: "partial";
    credential: StoredCredential;
    mode: ProfileMode | null;
    integrationIdentity: string | null;
  };

/** Parse a raw slot into the completeness union (the read boundary). */
function parseProfileSlot(data: ProfileSlotData): ProfileSlot {
  const credential = parseStoredCredential(data.githubToken, data.authProvider);
  if (credential.kind !== "none" && data.mode !== null) {
    return {
      kind: "complete",
      credential,
      mode: data.mode,
      integrationIdentity: data.integrationIdentity,
    };
  }
  return {
    kind: "partial",
    credential,
    mode: data.mode,
    integrationIdentity: data.integrationIdentity,
  };
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
   * Cached model-discovery verdicts, keyed
   * `<credentialDigest>|<integrationId|default>|<modelId>`
   * (src/copilot_api/discovery.ts): whether an unadvertised model verified as
   * servable and 1M-capable. The verification pings are billed requests, so the
   * shared cache (daily TTL) is what lets every consumer run the SAME pipeline
   * without re-paying probes per invocation. Machine-local, never exported.
   */
  claudeModelVerdicts: Record<string, ModelVerdict>;
}

/** One cached discovery verdict (see claudeModelVerdicts). */
export interface ModelVerdict {
  servable: boolean;
  is1m: boolean;
  atMs: number;
}

// Mirror CopilotEnvRunState/AutoupdateState's patch spelling (`Data[K] | null`).
type EnvStatePatch = {
  [K in keyof Omit<CopilotEnvStateData, "profiles">]?: CopilotEnvStateData[K] | null;
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
  // Recorded artifact ownership (the WebSearch-deny and Claude Desktop paths)
  // lived here before the ownership ledger (ownership.ts). The legacy keys are
  // deliberately NOT named in this schema: the lenient read ignores them and
  // update() preserves them in the file, so the ledger's reader tolerance can
  // still see them until the 3.5.6 ownership migration moves them out.
  claudeModelVerdicts: v.fallback(
    v.record(
      v.string(),
      v.object({
        servable: v.boolean(),
        is1m: v.boolean(),
        atMs: v.pipe(v.number(), v.finite(), v.minValue(0)),
      }),
    ),
    {},
  ),
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
 * Hard gate for commands that ADDRESS an existing profile (`agent env`, `agent
 * models`, `agent health --profile`): a typo'd `--profile` must error naming
 * the known profiles, never resolve against default (or half-default) wiring --
 * `agent env`'s stdout is evaled by the shell wrapper, so a wrong-profile
 * answer would be silently applied. Returns the addressed slot (one read, so
 * existence and contents can never disagree).
 */
export function assertKnownProfile(name: ProfileName): ProfileSlot {
  const { exists, slot } = new CopilotEnvState().profileSlotStatus(name);
  if (exists || profileHomeNames().includes(name)) return slot;
  throw unknownProfileError(name);
}

function unknownProfileError(name: ProfileName): Error {
  const names = allProfileNames();
  const hint = names.length === 0
    ? "no profiles exist - create one with `agent profile --add <name> --direct|--proxy`"
    : `known profiles: ${names.join(", ")}`;
  return new Error(`no such profile '${name}' (${hint})`);
}

/** The error for a named-credential write with no store slot to land in: a
 *  half-created profile (home without a slot) points at the atomic re-add; a
 *  never-created name gets the plain unknown-profile error. */
function missingProfileSlotError(name: ProfileName): Error {
  if (profileHomeNames().includes(name)) {
    return new Error(
      `profile '${name}' has no store slot (half-created; its daemon home exists) - ` +
        `re-create it with \`agent profile --add ${name} --direct|--proxy\``,
    );
  }
  return unknownProfileError(name);
}

/**
 * Gate for the named-credential RE-AUTH path (`agent auth --profile <name>`):
 * the profile's STORE slot must already exist -- creation belongs to
 * `commitProfile` alone, so a typo'd name can never leave a credential-only
 * half profile. Fires at the command boundary BEFORE any acquisition, so a bad
 * name never costs a device flow; the store's own in-update check is the
 * enforcing backstop. Returns the slot from the same read.
 */
export function assertProfileSlot(name: ProfileName): ProfileSlot {
  const { exists, slot } = new CopilotEnvState().profileSlotStatus(name);
  if (!exists) throw missingProfileSlotError(name);
  return slot;
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
   * pair), parsed into the StoredCredential union. THE single routing point
   * between the two on-disk layouts; a never-created named profile reads as
   * `none` (no fallback to the default).
   */
  readCredential(profile: Profile): StoredCredential {
    if (profile === null) {
      const data = this.read();
      return parseStoredCredential(data.githubToken, data.authProvider);
    }
    return this.readProfileSlot(profile).credential;
  }

  /** The full parsed slot for a NAMED profile; never-created reads empty partial. */
  readProfileSlot(name: ProfileName): ProfileSlot {
    return this.profileSlotStatus(name).slot;
  }

  /** Like readProfileSlot, plus whether the store actually carries the slot --
   *  both from ONE read, so existence and contents can never disagree under a
   *  concurrent write (health's fact-gathering seam). */
  profileSlotStatus(name: ProfileName): { exists: boolean; slot: ProfileSlot } {
    const profiles = this.read().profiles;
    // Own-property check: the profiles record carries Object.prototype, so a name
    // like "constructor" would otherwise resolve up the chain to a truthy function
    // instead of the empty slot.
    const slot = Object.hasOwn(profiles, name) ? profiles[name] : undefined;
    return { exists: slot !== undefined, slot: parseProfileSlot(slot ?? emptyProfile()) };
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
   * Record the credential slot addressed by `profile`. Takes the provisioned
   * union whole (never a patch), so a token without its provider or a token
   * paired with gh-cli cannot be written at all. A NAMED profile's STORE slot
   * must already exist -- profiles are CREATED only through `commitProfile` --
   * and the check runs INSIDE the same atomic update as the write, so a racing
   * `deleteProfile` cannot slip between the check and the merge and resurrect a
   * credential-only half slot. The derived `integrationIdentity` is cleared: it
   * is a probe result keyed to the credential, so any credential change
   * (re-auth) must invalidate it -- the next wiring re-derives it.
   */
  setCredential(profile: Profile, credential: ProvisionedCredential): void {
    const patch = rawCredentialPatch(credential);
    if (profile === null) {
      this.set(patch);
      return;
    }
    let missing = false;
    this.store.update((d) => {
      const profiles = isRecord(d.profiles) ? d.profiles : {};
      const raw = Object.hasOwn(profiles, profile) ? profiles[profile] : undefined;
      if (!isRecord(raw)) {
        missing = true;
        return;
      }
      if (patch.githubToken !== null) {
        raw.githubToken = patch.githubToken;
      } else {
        delete raw.githubToken;
      }
      raw.authProvider = patch.authProvider;
      delete raw.integrationIdentity;
    });
    if (missing) throw missingProfileSlotError(profile);
  }

  /**
   * Clear the credential slot addressed by `profile` (the `agent auth --del`
   * transition; a named profile keeps its mode -- de-auth is not deletion).
   * Judged and cleared in ONE update on the RAW fields, so even a stray token
   * the read boundary parses as `none` (hand edit, no provider) is really
   * removed. Returns whether anything was present to clear.
   */
  clearCredential(profile: Profile): boolean {
    let had = false;
    if (profile === null) {
      this.store.update((d) => {
        had = d.githubToken !== undefined || d.authProvider !== undefined;
        delete d.githubToken;
        delete d.authProvider;
      });
      return had;
    }
    this.store.update((d) => {
      const profiles = isRecord(d.profiles) ? d.profiles : {};
      const raw = Object.hasOwn(profiles, profile) ? profiles[profile] : undefined;
      if (!isRecord(raw)) return;
      had = raw.githubToken !== undefined || raw.authProvider !== undefined;
      delete raw.githubToken;
      delete raw.authProvider;
      delete raw.integrationIdentity; // credential-derived cache goes with it
      if (Object.keys(raw).length === 0) delete profiles[profile];
      if (Object.keys(profiles).length === 0) delete d.profiles;
    });
    return had;
  }

  /**
   * THE owning transition that makes a named profile exist: both halves of the
   * slot -- ONE credential + ONE mode -- written in a single atomic update, so
   * the store can never hold a freshly created half profile (no interleaving
   * write or crash window between the halves). The existing raw slot is
   * mutated, not replaced, so unknown keys a newer release wrote survive (the
   * store-wide preserve-unknown-keys contract). The cached
   * `integrationIdentity` survives only when the committed credential is
   * identical to the stored one (it is derived from the credential; a re-add
   * that keeps the credential must not force a re-probe).
   */
  commitProfile(
    name: ProfileName,
    slot: { credential: ProvisionedCredential; mode: ProfileMode },
  ): void {
    const next = rawCredentialPatch(slot.credential);
    this.store.update((d) => {
      const profiles = isRecord(d.profiles) ? d.profiles : {};
      const raw = Object.hasOwn(profiles, name) ? profiles[name] : undefined;
      const committed: Record<string, unknown> = isRecord(raw) ? raw : {};
      const credentialUnchanged = (committed.githubToken ?? null) === next.githubToken &&
        (committed.authProvider ?? null) === next.authProvider;
      if (next.githubToken !== null) {
        committed.githubToken = next.githubToken;
      } else {
        delete committed.githubToken;
      }
      committed.authProvider = next.authProvider;
      committed.mode = slot.mode;
      if (!credentialUnchanged) delete committed.integrationIdentity;
      profiles[name] = committed;
      d.profiles = profiles;
    });
  }

  /** Remove a named profile's WHOLE slot in one atomic update (the `--del` /
   *  uninstall transition; an empty map drops the `profiles` key, so a store
   *  that never used profiles stays byte-identical to the pre-profile format). */
  deleteProfile(name: ProfileName): void {
    this.store.update((d) => {
      const profiles = isRecord(d.profiles) ? d.profiles : {};
      delete profiles[name];
      if (Object.keys(profiles).length === 0) {
        delete d.profiles;
      } else {
        d.profiles = profiles;
      }
    });
  }

  /** Record (or clear, with null) a NAMED profile's probed direct-mode identity.
   *  A cache write DERIVED from `forCredential`: it lands only while the slot
   *  still holds that exact credential (compared inside the same atomic update,
   *  so a probe result can never outlive a rotation that raced the probe) and
   *  never creates or resurrects a slot -- `commitProfile` stays the only
   *  creator, and a deletion race just loses the cache. */
  setProfileIntegrationIdentity(
    name: ProfileName,
    integrationIdentity: string | null,
    forCredential: ProvisionedCredential,
  ): void {
    const expected = rawCredentialPatch(forCredential);
    this.store.update((d) => {
      const profiles = isRecord(d.profiles) ? d.profiles : {};
      const raw = Object.hasOwn(profiles, name) ? profiles[name] : undefined;
      if (!isRecord(raw)) return;
      if (
        (raw.githubToken ?? null) !== expected.githubToken ||
        raw.authProvider !== expected.authProvider
      ) {
        return;
      }
      if (integrationIdentity === null || integrationIdentity.trim() === "") {
        delete raw.integrationIdentity;
      } else {
        raw.integrationIdentity = integrationIdentity.trim();
      }
    });
  }

  /** The cached discovery verdict for `key`, or null when never probed. */
  readModelVerdict(key: string): ModelVerdict | null {
    return this.read().claudeModelVerdicts[key] ?? null;
  }

  /** Record a discovery verdict (atomic; replaces any prior verdict for `key`). */
  setModelVerdict(key: string, verdict: ModelVerdict): void {
    this.store.update((d) => {
      const verdicts = isRecord(d.claudeModelVerdicts) ? d.claudeModelVerdicts : {};
      d.claudeModelVerdicts = { ...verdicts, [key]: verdict };
    });
  }
}
