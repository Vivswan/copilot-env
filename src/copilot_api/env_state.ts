// The account-wide credential store (`credentials.json`), the SINGLE source of truth for the Direct
// credential and the proxy's `--github-token`. Account-wide, not per-host: the credential applies
// whichever host runs an agent. The Codex catalog refresh throttle rides here too (src/codex/catalog.ts)
// rather than in a second store for two small fields.
import * as v from "valibot";
import { isRecord } from "../utils/json.ts";
import { CopilotApiConfig } from "./config.ts";
import { INTEGRATION_ID_RE } from "./env_config.ts";
import { GH_LOGIN_RE } from "./gh_cli.ts";
import { CopilotApiPaths, profileHomeNames } from "./paths.ts";
import {
  isValidProfileName,
  parseProfileName,
  type Profile,
  profileLabel,
  type ProfileName,
} from "./profile.ts";

// The provider vocabulary lives with the store that persists it: importing it from credential.ts
// would cycle, since Credential wraps this store.
export const AUTH_PROVIDERS = ["copilot", "gh-cli", "gh-token"] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];
export type TokenProvider = Extract<AuthProvider, "copilot" | "gh-token">;

function isAuthProvider(provider: string): provider is AuthProvider {
  return (AUTH_PROVIDERS as readonly string[]).includes(provider);
}

/**
 * The shape a writer must hand over: a token without a provider, or a token with gh-cli, is
 * unrepresentable, so no writer re-checks. A null `ghUser` follows gh's active account at every resolve.
 */
export type ProvisionedCredential =
  | { kind: "gh-cli"; ghUser: string | null }
  | { kind: "stored"; provider: TokenProvider; token: string };

/**
 * "none" is fail-closed: a token-backed provider whose token is gone resolves to nothing, no implicit
 * gh fallback. Its `provider` keeps the recorded choice so diagnostics can name it.
 */
export type StoredCredential =
  | { kind: "none"; provider: TokenProvider | null }
  | ProvisionedCredential;

/** For consumers that carry only token PRESENCE (health facts never hold the token). Must agree with
 *  parseStoredCredential; test/state.test.ts pins the pair. */
export function storedCredentialKind(
  provider: string | null,
  hasStoredToken: boolean,
): StoredCredential["kind"] {
  if (provider === null || !isAuthProvider(provider)) return "none";
  if (provider === "gh-cli") return "gh-cli";
  return hasStoredToken ? "stored" : "none";
}

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

function parseStoredCredential(
  githubToken: string | null,
  authProvider: AuthProvider | null,
  ghUser: string | null,
): StoredCredential {
  if (authProvider === null) return { kind: "none", provider: null };
  if (authProvider === "gh-cli") return { kind: "gh-cli", ghUser };
  return githubToken === null
    ? { kind: "none", provider: authProvider }
    : { kind: "stored", provider: authProvider, token: githubToken };
}

/** The one choke point every credential write funnels through. The pin must match GH_LOGIN_RE
 *  because it becomes a `gh auth token --user` argv token: the shape gate keeps shell metacharacters out. */
function rawCredentialPatch(
  credential: ProvisionedCredential,
): { githubToken: string | null; authProvider: AuthProvider; ghUser: string | null } {
  if (credential.kind === "gh-cli") {
    const ghUser = credential.ghUser?.trim() ?? null;
    if (ghUser !== null && !GH_LOGIN_RE.test(ghUser)) {
      throw new Error(
        "a gh-cli account pin must be a GitHub login (1-39 letters, digits, dashes, or underscores)",
      );
    }
    return { githubToken: null, authProvider: "gh-cli", ghUser };
  }
  const token = credential.token.trim();
  if (token === "") {
    throw new Error(
      `a stored credential requires a non-empty token (provider '${credential.provider}')`,
    );
  }
  return { githubToken: token, authProvider: credential.provider, ghUser: null };
}

// A profile is ONE credential slot plus ONE wiring mode, applied to BOTH agents; the default is a profile
// too, under the reserved `default` key.
//   a named profile  -> never falls back to the default credential; `mode` is the truth its agent artifacts derive from
//   the default      -> `mode` only records what `agent init` wrote, the artifacts staying the live truth

/** Mirrors ManagedAgentMode; declared here so the store layer stays dependency-light. */
export const PROFILE_MODES = ["direct", "proxy"] as const;
export type ProfileMode = (typeof PROFILE_MODES)[number];

/** parseProfileName rejects `default`, so no named profile can collide with this key. */
export const DEFAULT_PROFILE_KEY = "default";

function slotKey(profile: Profile): string {
  return profile ?? DEFAULT_PROFILE_KEY;
}

export interface ProfileCredentialData {
  githubToken: string | null;
  authProvider: AuthProvider | null;
  /** gh-cli only; null = follow gh's active account. */
  ghUser: string | null;
}

/** The raw slot as persisted; also the export bundle's shape. */
export interface ProfileSlotData extends ProfileCredentialData {
  mode: ProfileMode | null;
  /**
   * The probed direct-mode IntegrationIdentity NAME (integration_identity.ts), null when never probed.
   * The name, not the header value, distinguishes "probed, the default won" from "unknown", so the
   * launcher hot path replays instead of re-probing. Derived from the credential: setCredential clears it.
   */
  integrationIdentity: string | null;
}

/**
 * "complete" is the atomic unit `agent profile` commits and the only kind the launch/wiring paths act
 * on. "partial" is everything else the store can still carry (an interrupted add, a hand edit, a
 * de-authed half, a never-created name); consumers render its gaps for repair via partialSlotGap.
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

function parseProfileSlot(data: ProfileSlotData): ProfileSlot {
  const credential = parseStoredCredential(data.githubToken, data.authProvider, data.ghUser);
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

/** The ONE spelling of a partial slot's repair line, shared by `agent profile` and `agent launch`.
 *  The rendered strings are output contracts pinned by test. */
export function partialSlotGap(
  name: ProfileName,
  slot: Extract<ProfileSlot, { kind: "partial" }>,
): string {
  return slot.mode === null
    ? `${profileLabel(name)} does not exist - create it with ` +
      `\`agent profile --add ${name} --direct|--proxy\``
    : `${profileLabel(name)} has no credential - repair it with ` +
      `\`agent auth --profile ${name}\` or \`agent profile --add ${name}\``;
}

/** The READ view, not the disk layout: the default slot's credential is projected to the top level
 *  and `profiles` holds the NAMED slots only. */
export interface CopilotEnvStateData {
  githubToken: string | null;
  authProvider: AuthProvider | null;
  ghUser: string | null;
  profiles: Record<string, ProfileSlotData>;
  /** Epoch ms of the last catalog generation ATTEMPT, 0 if never (src/codex/catalog.ts). */
  codexCatalogLastAttemptMs: number;
  codexCatalogCodexVersion: string | null;
  /** A copilot-env whose patch logic changed regenerates on the next refresh instead of serving the
   *  old patch for up to a day (src/codex/catalog.ts). */
  codexCatalogPatchVersion: number;
  /** The catalog (by content hash) the installed codex (by version) last parsed, so the auth-time
   *  sync re-asks only when either changes (src/codex/catalog.ts). */
  codexCatalogAccepted: { sha256: string; codexVersion: string } | null;
  /** Keyed `<credentialDigest>|<integrationId|default>|<modelId>` (src/copilot_api/discovery.ts). The
   *  verification pings are billed requests, so this cache is shared by every consumer. Never exported. */
  claudeModelVerdicts: Record<string, ModelVerdict>;
}

export interface ModelVerdict {
  servable: boolean;
  is1m: boolean;
  atMs: number;
}

// The credential fields are NOT patchable: every credential write goes through the slot transitions,
// so a top-level credential pair can never be written.
type EnvStatePatch = {
  [K in keyof Omit<CopilotEnvStateData, "profiles" | "githubToken" | "authProvider" | "ghUser">]?:
    | CopilotEnvStateData[K]
    | null;
};

const PROFILE_SCHEMA = v.object({
  githubToken: v.fallback(v.nullable(v.pipe(v.string(), v.trim(), v.minLength(1))), null),
  authProvider: v.fallback(v.nullable(v.picklist(AUTH_PROVIDERS)), null),
  // The pin flows into `gh auth token --user` argv (through cmd.exe on Windows), so a hand-mangled
  // value reads as null instead of reaching a shell.
  ghUser: v.fallback(v.nullable(v.pipe(v.string(), v.trim(), v.regex(GH_LOGIN_RE))), null),
  mode: v.fallback(v.nullable(v.picklist(PROFILE_MODES)), null),
  // The cached identity flows verbatim into HTTP headers, so a hand-mangled value reads as null = re-probe.
  integrationIdentity: v.fallback(
    v.nullable(v.pipe(v.string(), v.trim(), v.regex(INTEGRATION_ID_RE))),
    null,
  ),
});

// Every field FALLS BACK rather than throwing: a hand-mangled value reads as unset.
const STATE_SCHEMA = v.object({
  profiles: v.fallback(v.record(v.string(), v.fallback(PROFILE_SCHEMA, emptyProfile())), {}),
  codexCatalogLastAttemptMs: v.fallback(v.pipe(v.number(), v.finite(), v.minValue(0)), 0),
  codexCatalogCodexVersion: v.fallback(
    v.nullable(v.pipe(v.string(), v.trim(), v.minLength(1))),
    null,
  ),
  codexCatalogPatchVersion: v.fallback(v.pipe(v.number(), v.finite(), v.minValue(0)), 0),
  codexCatalogAccepted: v.fallback(
    v.nullable(v.object({
      sha256: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
      codexVersion: v.pipe(v.string(), v.trim(), v.minLength(1)),
    })),
    null,
  ),
  // The pre-slot top-level credential pair and the pre-ledger ownership keys are deliberately NOT
  // named here: update() preserves unnamed keys, so the 3.5.6 migrations that move them out still find them.
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
  return {
    githubToken: null,
    authProvider: null,
    ghUser: null,
    mode: null,
    integrationIdentity: null,
  };
}

/** As parsed off disk: the reserved slot still inside `profiles`. */
type RawStateData = v.InferOutput<typeof STATE_SCHEMA>;

// The 3.5.6 default-slot lift. These helpers must accept exactly what STATE_SCHEMA's fallbacks accept,
// so the lifted slot reads back as the same credential the legacy pair described.

function rawToken(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function rawProvider(value: unknown): AuthProvider | null {
  return typeof value === "string" && isAuthProvider(value) ? value : null;
}

function rawSlotHasCredential(slot: Record<string, unknown>): boolean {
  return rawToken(slot.githubToken) !== null || rawProvider(slot.authProvider) !== null;
}

/** A slot already holding its own credential wins over the legacy pair (they can only disagree after
 *  a hand edit); the legacy keys are removed either way. */
function liftLegacyDefaultPair(d: Record<string, unknown>): void {
  const legacyToken = rawToken(d.githubToken);
  const legacyProvider = rawProvider(d.authProvider);
  delete d.githubToken;
  delete d.authProvider;
  if (legacyToken === null && legacyProvider === null) return;
  const profiles = isRecord(d.profiles) ? d.profiles : {};
  const raw = Object.hasOwn(profiles, DEFAULT_PROFILE_KEY)
    ? profiles[DEFAULT_PROFILE_KEY]
    : undefined;
  const slot: Record<string, unknown> = isRecord(raw) ? raw : {};
  if (!rawSlotHasCredential(slot)) {
    if (legacyToken !== null) slot.githubToken = legacyToken;
    if (legacyProvider !== null) slot.authProvider = legacyProvider;
  }
  profiles[DEFAULT_PROFILE_KEY] = slot;
  d.profiles = profiles;
}

function tidyEmptySlot(
  d: Record<string, unknown>,
  profiles: Record<string, unknown>,
  key: string,
): void {
  const raw = profiles[key];
  if (isRecord(raw) && Object.keys(raw).length === 0) delete profiles[key];
  if (Object.keys(profiles).length === 0) delete d.profiles;
}

/** Store slots unioned with on-disk daemon homes, so a half-created profile (credential without a
 *  home, or home without a credential) is still seen. */
export function allProfileNames(): ProfileName[] {
  return [...new Set([...new CopilotEnvState().profileNames(), ...profileHomeNames()])].sort();
}

/**
 * A typo'd `--profile` must error, never resolve against default wiring: `agent env`'s stdout is
 * evaled by the shell wrapper, so a wrong-profile answer would be silently applied.
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
 * Creation belongs to commitProfile alone, so a re-auth of a typo'd name can never leave a
 * credential-only half profile. Fires BEFORE any acquisition so a bad name never costs a device flow;
 * setCredential's in-update check is the enforcing backstop.
 */
export function assertProfileSlot(name: ProfileName): ProfileSlot {
  const { exists, slot } = new CopilotEnvState().profileSlotStatus(name);
  if (!exists) throw missingProfileSlotError(name);
  return slot;
}

export class CopilotEnvState {
  private readonly store: CopilotApiConfig;

  constructor(path?: string) {
    if (path === undefined) {
      const paths = new CopilotApiPaths();
      this.store = new CopilotApiConfig(paths.sharedStateFile, paths.sharedStateLock);
    } else {
      this.store = new CopilotApiConfig(path);
    }
  }

  read(): CopilotEnvStateData {
    const data = this.rawRead();
    const { [DEFAULT_PROFILE_KEY]: slot = emptyProfile(), ...named } = data.profiles;
    return {
      ...data,
      githubToken: slot.githubToken,
      authProvider: slot.authProvider,
      ghUser: slot.ghUser,
      profiles: named,
    };
  }

  /** loadStrict: an unreadable credential store THROWS rather than reading as "no credential", so auth
   *  resolution and the named-profile hard-fail diagnose the failed read instead of fabricating an empty store. */
  private rawRead(): RawStateData {
    return v.parse(STATE_SCHEMA, this.store.loadStrict());
  }

  /** A blank string deletes its key: a blank value is never meaningful, so it clears rather than persisting `""`. */
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

  /** A never-created named profile reads as `none`: no fallback to the default slot. */
  readCredential(profile: Profile): StoredCredential {
    return this.readProfileSlot(profile).credential;
  }

  readProfileSlot(profile: Profile): ProfileSlot {
    if (profile !== null) return this.profileSlotStatus(profile).slot;
    return parseProfileSlot(this.rawRead().profiles[DEFAULT_PROFILE_KEY] ?? emptyProfile());
  }

  /** Existence and contents come from ONE read, so they can never disagree under a concurrent write. */
  profileSlotStatus(name: ProfileName): { exists: boolean; slot: ProfileSlot } {
    const profiles = this.read().profiles;
    // Own-property check: a name like "constructor" would otherwise resolve up the prototype chain.
    const slot = Object.hasOwn(profiles, name) ? profiles[name] : undefined;
    return { exists: slot !== undefined, slot: parseProfileSlot(slot ?? emptyProfile()) };
  }

  /** The keys are a trust boundary (user-editable file): an invalid name is skipped so it can never
   *  reach a path join, the same filter profileHomeNames applies. */
  profileNames(): ProfileName[] {
    return Object.keys(this.read().profiles)
      .filter((name) => isValidProfileName(name))
      .map((name) => parseProfileName(name))
      .sort();
  }

  /**
   * A NAMED slot must already exist (commitProfile is the only creator), checked INSIDE the same update
   * as the write, so a racing deleteProfile resurrects no credential-only half slot under update()'s
   * best-effort lock; past its bounded wait both writers proceed unlocked. The cached
   * `integrationIdentity` is keyed to the credential, so a credential change must invalidate it.
   */
  setCredential(profile: Profile, credential: ProvisionedCredential): void {
    const patch = rawCredentialPatch(credential);
    let missing = false;
    this.store.update((d) => {
      const profiles = isRecord(d.profiles) ? d.profiles : {};
      const key = slotKey(profile);
      const existing = Object.hasOwn(profiles, key) ? profiles[key] : undefined;
      let raw: Record<string, unknown>;
      if (isRecord(existing)) {
        raw = existing;
      } else if (profile === null) {
        raw = {};
      } else {
        missing = true;
        return;
      }
      if (patch.githubToken !== null) {
        raw.githubToken = patch.githubToken;
      } else {
        delete raw.githubToken;
      }
      if (patch.ghUser !== null) {
        raw.ghUser = patch.ghUser;
      } else {
        delete raw.ghUser;
      }
      raw.authProvider = patch.authProvider;
      delete raw.integrationIdentity;
      profiles[key] = raw;
      d.profiles = profiles;
    });
    if (missing && profile !== null) throw missingProfileSlotError(profile);
  }

  /**
   * De-auth is not deletion: the slot keeps its mode. Judged on the RAW fields so even a stray token
   * the read boundary parses as `none` (hand edit, no provider) is really removed.
   */
  clearCredential(profile: Profile): boolean {
    let had = false;
    this.store.update((d) => {
      const profiles = isRecord(d.profiles) ? d.profiles : {};
      const key = slotKey(profile);
      const raw = Object.hasOwn(profiles, key) ? profiles[key] : undefined;
      if (!isRecord(raw)) return;
      had = raw.githubToken !== undefined || raw.authProvider !== undefined;
      delete raw.githubToken;
      delete raw.authProvider;
      delete raw.ghUser;
      delete raw.integrationIdentity;
      tidyEmptySlot(d, profiles, key);
    });
    return had;
  }

  /**
   * THE transition that makes a named profile exist: credential and mode land in one update, so the
   * store can never hold a half profile.
   *
   *   the raw slot is mutated, not replaced  -> unknown keys a newer release wrote survive
   *   the credential changed                 -> the cached identity goes; it was that credential's verdict
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
        (committed.authProvider ?? null) === next.authProvider &&
        (committed.ghUser ?? null) === next.ghUser;
      if (next.githubToken !== null) {
        committed.githubToken = next.githubToken;
      } else {
        delete committed.githubToken;
      }
      if (next.ghUser !== null) {
        committed.ghUser = next.ghUser;
      } else {
        delete committed.ghUser;
      }
      committed.authProvider = next.authProvider;
      committed.mode = slot.mode;
      if (!credentialUnchanged) delete committed.integrationIdentity;
      profiles[name] = committed;
      d.profiles = profiles;
    });
  }

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

  /** Lands only while the slot still holds `forCredential`, compared inside the same update, so a probe
   *  result outlives no rotation that raced it under update()'s best-effort lock; past its bounded wait
   *  both writers proceed unlocked. Never creates a slot: a deletion race just loses the cache. */
  setProfileIntegrationIdentity(
    profile: Profile,
    integrationIdentity: string | null,
    forCredential: ProvisionedCredential,
  ): void {
    const expected = rawCredentialPatch(forCredential);
    this.store.update((d) => {
      const profiles = isRecord(d.profiles) ? d.profiles : {};
      const key = slotKey(profile);
      const raw = Object.hasOwn(profiles, key) ? profiles[key] : undefined;
      if (!isRecord(raw)) return;
      if (
        (raw.githubToken ?? null) !== expected.githubToken ||
        raw.authProvider !== expected.authProvider ||
        (raw.ghUser ?? null) !== expected.ghUser
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

  /** Written when BOTH agents land on one managed mode, cleared when they diverge. A record of
   *  intent only: the per-agent artifacts stay the live truth the wiring readers sniff. */
  recordDefaultMode(mode: ProfileMode | null): void {
    this.store.update((d) => {
      const profiles = isRecord(d.profiles) ? d.profiles : {};
      const raw = Object.hasOwn(profiles, DEFAULT_PROFILE_KEY)
        ? profiles[DEFAULT_PROFILE_KEY]
        : undefined;
      if (mode === null) {
        if (!isRecord(raw)) return;
        delete raw.mode;
        tidyEmptySlot(d, profiles, DEFAULT_PROFILE_KEY);
        return;
      }
      const slot: Record<string, unknown> = isRecord(raw) ? raw : {};
      slot.mode = mode;
      profiles[DEFAULT_PROFILE_KEY] = slot;
      d.profiles = profiles;
    });
  }

  /** The 3.5.6 migration's entry point (src/migrations/3.5.6.ts), and the ONLY code that knows the
   *  legacy pair. A store without legacy keys is not written or created. */
  adoptLegacyDefaultCredential(): void {
    // "no legacy keys" is the decision to skip the lift, so it must be proven, not flattened from a failed read.
    const raw = this.store.loadStrict();
    if (raw.githubToken === undefined && raw.authProvider === undefined) return;
    this.store.update((d) => liftLegacyDefaultPair(d));
  }

  readModelVerdict(key: string): ModelVerdict | null {
    return this.read().claudeModelVerdicts[key] ?? null;
  }

  setModelVerdict(key: string, verdict: ModelVerdict): void {
    this.store.update((d) => {
      const verdicts = isRecord(d.claudeModelVerdicts) ? d.claudeModelVerdicts : {};
      d.claudeModelVerdicts = { ...verdicts, [key]: verdict };
    });
  }
}
