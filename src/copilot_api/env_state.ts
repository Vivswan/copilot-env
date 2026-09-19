// The state half of the account-wide store (`state.json`, src/copilot_api/state_store.ts): each
// `profiles.<name>` map's credential slot, the SINGLE source of truth for the Direct credential and
// the proxy's `--github-token`, and the account-wide state under `global` (the Codex catalog refresh
// throttle, src/codex/catalog.ts, and the Claude model verdicts). Account-wide, not per-host: the
// credential applies whichever host runs an agent. The settings keys sharing those maps are
// CopilotEnvConfig's; this reader picks its own keys out and preserves the rest.
import * as v from "valibot";
import { isRecord } from "../utils/json.ts";
import { type CopilotApiConfig, ensureDict } from "./config.ts";
import { CODEX_IDENTITY_NAME, INTEGRATION_ID_RE, isLoopbackHostname } from "./env_config.ts";
import { GH_LOGIN_RE } from "./gh_cli.ts";
import { profileHomeNames } from "./paths.ts";
import {
  DEFAULT_PROFILE_NAME,
  isReservedProfileWord,
  isValidProfileName,
  parseProfileName,
  type Profile,
  profileLabel,
  type ProfileName,
} from "./profile.ts";
import { rootStateStore } from "./state_store.ts";

// The provider vocabulary lives with the store that persists it: importing it from credential.ts
// would cycle, since Credential wraps this store.
export const AUTH_PROVIDERS = ["copilot", "gh-cli", "gh-token", "gh-env"] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];
export type TokenProvider = Extract<AuthProvider, "copilot" | "gh-token" | "gh-env">;

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
//   the default      -> `mode` is the one mode both agents share, written by the wiring commands (a single-agent write
//                       that would differ is refused); the slot is the truth and the agent files are its outputs

/** Mirrors ManagedAgentMode; declared here so the store layer stays dependency-light. */
export const PROFILE_MODES = ["direct", "proxy"] as const;
export type ProfileMode = (typeof PROFILE_MODES)[number];

/** parseProfileName rejects `default`, so no named profile can collide with this key. */
export const DEFAULT_PROFILE_KEY = DEFAULT_PROFILE_NAME;

/** The two creators refuse a word `agent profile` routes as a verb, so it can never become a
 *  profile; a profile named before its word became a verb is read as it is. */
function refuseReservedWord(name: ProfileName): void {
  if (isReservedProfileWord(name)) {
    throw new Error(`profile name '${name}' is reserved (it is a verb of \`agent profile\`)`);
  }
}

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
}

/**
 * "complete" is the atomic unit `agent profile` commits and the only kind the launch/wiring paths act
 * on. "partial" is everything else the store can still carry (an interrupted add, a hand edit, a
 * de-authed half, a never-created name); consumers render its gaps for repair via partialSlotGap.
 */
export type ProfileSlot =
  | { kind: "complete"; credential: ProvisionedCredential; mode: ProfileMode }
  | { kind: "partial"; credential: StoredCredential; mode: ProfileMode | null };

function parseProfileSlot(data: ProfileSlotData): ProfileSlot {
  const credential = parseStoredCredential(data.githubToken, data.authProvider, data.ghUser);
  if (credential.kind !== "none" && data.mode !== null) {
    return { kind: "complete", credential, mode: data.mode };
  }
  return { kind: "partial", credential, mode: data.mode };
}

/** The ONE spelling of a partial slot's repair line, shared by `agent profile` and `agent profile launch`.
 *  The rendered strings are output contracts pinned by test. */
export function partialSlotGap(
  name: ProfileName,
  slot: Extract<ProfileSlot, { kind: "partial" }>,
): string {
  return slot.mode === null
    ? `${profileLabel(name)} does not exist - create it with ` +
      `\`agent profile ${name} add --direct|--proxy\``
    : `${profileLabel(name)} has no credential - repair it with ` +
      `\`agent profile ${name} auth\` or \`agent profile ${name} add\``;
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
  /** The catalog (by content hash) the installed codex (by version) last parsed, so the reference
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
});

// The probed Direct pair, state beside the credential (never a cache): the identity NAME the last
// landing baked (CODEX_IDENTITY_NAME for the default, which sends no header) and the Copilot host
// origin it was accepted on. Written by the probing callers only; read by every re-render. A
// hand-mangled value reads as null = never probed, so the next re-render probes and writes it.
const DIRECT_PAIR_SCHEMA = v.object({
  integrationIdentity: v.fallback(
    v.nullable(v.pipe(v.string(), v.trim(), v.regex(INTEGRATION_ID_RE))),
    null,
  ),
  copilotHost: v.fallback(
    v.nullable(
      // The same origin shape the `host` literal takes (an https origin, no path, not loopback):
      // anything else is a hand edit and reads as never probed.
      v.pipe(
        v.string(),
        v.trim(),
        v.check((s) =>
          URL.canParse(s) && new URL(s).protocol === "https:" && new URL(s).origin === s &&
          !isLoopbackHostname(new URL(s).hostname)
        ),
      ),
    ),
    null,
  ),
});

/** What the slot holds of a Direct wiring, half by half: `integrationId` null = the default identity
 *  (no header), a half `undefined` = never probed (the pin or literal was in force at every landing,
 *  so no probe ever answered for it). Overlays render over it and never enter it. */
export interface StoredDirectPair {
  integrationId?: string | null;
  host?: string;
}

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
  // Unnamed keys (a hand edit, a newer release's, the settings sharing the map) never surface here
  // and survive every write: update() preserves what it does not name.
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
  };
}

/** As parsed off disk: the reserved slot still inside `profiles`. */
type RawStateData = v.InferOutput<typeof STATE_SCHEMA>;

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
 * A typo'd profile name must error, never resolve against default wiring: `agent profile env`'s stdout is
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
    ? "no profiles exist - create one with `agent profile <name> add --direct|--proxy`"
    : `known profiles: ${names.join(", ")}`;
  return new Error(`no such profile '${name}' (${hint})`);
}

function missingProfileSlotError(name: ProfileName): Error {
  if (profileHomeNames().includes(name)) {
    return new Error(
      `profile '${name}' has no store slot (half-created; its daemon home exists) - ` +
        `re-create it with \`agent profile ${name} add --direct|--proxy\``,
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

/** The state keys of a `profiles.<name>` map and of `global`, as the schemas spell them: what
 *  `agent config` refuses to set by name (src/commands/config.ts). Derived, never restated. */
export const PROFILE_STATE_KEYS: readonly string[] = [
  ...Object.keys(PROFILE_SCHEMA.entries),
  ...Object.keys(DIRECT_PAIR_SCHEMA.entries),
];
export const GLOBAL_STATE_KEYS: readonly string[] = Object.keys(STATE_SCHEMA.entries).filter(
  (key) => key !== "profiles",
);

export class CopilotEnvState {
  private readonly store: CopilotApiConfig;

  /** `path` = another `state.json` (the migration test's fixture). */
  constructor(path?: string) {
    this.store = rootStateStore(path);
  }

  read(): CopilotEnvStateData {
    const data = this.rawRead();
    const { [DEFAULT_PROFILE_KEY]: slot = emptyProfile(), ...profiles } = data.profiles;
    return {
      ...data,
      githubToken: slot.githubToken,
      authProvider: slot.authProvider,
      ghUser: slot.ghUser,
      profiles,
    };
  }

  /** loadStrict: an unreadable credential store THROWS rather than reading as "no credential", so auth
   *  resolution and the named-profile hard-fail diagnose the failed read instead of fabricating an empty store. */
  private rawRead(): RawStateData {
    const doc = this.store.loadStrict();
    // The account-wide state keys sit in `global` beside the global settings; the schema picks
    // its own out.
    return v.parse(STATE_SCHEMA, {
      ...(isRecord(doc.global) ? doc.global : {}),
      profiles: doc.profiles,
    });
  }

  /** A blank string deletes its key: a blank value is never meaningful, so it clears rather than persisting `""`. */
  set(patch: EnvStatePatch): void {
    this.store.update((d) => {
      const global = ensureDict(d, "global");
      for (const key of Object.keys(patch) as (keyof EnvStatePatch)[]) {
        const value = patch[key];
        if (
          value === null ||
          value === undefined ||
          (typeof value === "string" && value.trim() === "")
        ) {
          delete global[key];
        } else {
          global[key] = typeof value === "string" ? value.trim() : value;
        }
      }
      if (Object.keys(global).length === 0) delete d.global;
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
   * A NAMED slot must already exist (commitProfile and recordProfileMode are the two creators),
   * checked INSIDE the same update as the write, so a racing deleteProfile resurrects no
   * credential-only half slot under update()'s lock (a holder past its bounded wait is an error,
   * never a second writer).
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
      // The pair was probed for the credential this write replaces: it goes with it, so the next
      // Direct re-render probes (the one gap) instead of baking another credential's pair.
      delete raw.integrationIdentity;
      delete raw.copilotHost;
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
      tidyEmptySlot(d, profiles, key);
    });
    return had;
  }

  /**
   * THE transition that makes a named profile exist: credential and mode land in one update, so the
   * store can never hold a half profile. The raw slot is mutated, not replaced, so unknown keys a
   * newer release wrote survive; a changed credential takes its probed pair with it (setCredential).
   */
  commitProfile(
    name: ProfileName,
    slot: { credential: ProvisionedCredential; mode: ProfileMode },
  ): void {
    refuseReservedWord(name);
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
      if (!credentialUnchanged) {
        delete committed.integrationIdentity;
        delete committed.copilotHost;
      }
      profiles[name] = committed;
      d.profiles = profiles;
    });
  }

  /** `agent profile <name> add`: the mode lands first, the credential follows through `auth`
   *  (setCredential), so a new profile is a partial slot until then. The one other creator
   *  beside commitProfile; the raw slot is mutated, so a credential already there survives. */
  recordProfileMode(name: ProfileName, mode: ProfileMode): void {
    refuseReservedWord(name);
    this.store.update((d) => {
      const profiles = isRecord(d.profiles) ? d.profiles : {};
      const raw = Object.hasOwn(profiles, name) ? profiles[name] : undefined;
      const slot: Record<string, unknown> = isRecord(raw) ? raw : {};
      slot.mode = mode;
      profiles[name] = slot;
      d.profiles = profiles;
    });
  }

  /** The slot's state keys go with the profile (`agent profile <name> del`); its settings keys are
   *  CopilotEnvConfig.deleteProfile's. A map left with nothing is dropped. */
  deleteProfile(name: ProfileName): void {
    this.store.update((d) => {
      const profiles = d.profiles;
      if (!isRecord(profiles) || !isRecord(profiles[name])) return;
      const section = profiles[name];
      for (const key of PROFILE_STATE_KEYS) delete section[key];
      if (Object.keys(section).length === 0) delete profiles[name];
    });
  }

  /** The slot's probed Direct halves; a half that fails its shape is a hand edit and reads as
   *  never probed. */
  readProfileDirectPair(profile: Profile): StoredDirectPair {
    const profiles = this.store.loadStrict().profiles;
    const raw = isRecord(profiles) ? profiles[slotKey(profile)] : undefined;
    if (!isRecord(raw)) return {};
    const pair = v.parse(DIRECT_PAIR_SCHEMA, raw);
    return {
      ...(pair.integrationIdentity === null ? {} : {
        integrationId: pair.integrationIdentity === CODEX_IDENTITY_NAME
          ? null
          : pair.integrationIdentity,
      }),
      ...(pair.copilotHost === null ? {} : { host: new URL(pair.copilotHost).origin }),
    };
  }

  /** The probing commands' write (a credential landing, or a re-render whose slot holds no pair):
   *  only the halves a probe ANSWERED land, so a pin or literal in force at the landing leaves its
   *  half as it was (a pin renders at read time and never enters the slot). The default slot is
   *  created for it like setCredential does; a named slot must exist (a deletion that raced the
   *  probe just loses the pair). */
  setProfileDirectPair(profile: Profile, probed: StoredDirectPair): void {
    this.store.update((d) => {
      const profiles = isRecord(d.profiles) ? d.profiles : {};
      const key = slotKey(profile);
      const existing = Object.hasOwn(profiles, key) ? profiles[key] : undefined;
      if (!isRecord(existing) && profile !== null) return;
      const raw: Record<string, unknown> = isRecord(existing) ? existing : {};
      if (probed.integrationId !== undefined) {
        raw.integrationIdentity = probed.integrationId ?? CODEX_IDENTITY_NAME;
      }
      if (probed.host !== undefined) raw.copilotHost = new URL(probed.host).origin;
      profiles[key] = raw;
      d.profiles = profiles;
    });
  }

  /** The mode both agents share. Its writers: commitDefaultWiring (src/agents/configure_defaults.ts)
   *  after both agents' writes of a landing (`agent init`, an import naming both agents, the first
   *  write on a fresh default) succeeded, and the default's `add` with no credential to land with,
   *  which records the mode alone for the landing that follows the credential; a single-agent
   *  command re-renders it and never moves it. The default Desktop entry's promise
   *  (resolveClaudeDesktopTargets). Never read back off the agent files. */
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

  readModelVerdict(key: string): ModelVerdict | null {
    return this.read().claudeModelVerdicts[key] ?? null;
  }

  /** Account-wide state: lands in `global` beside the catalog throttle (see set()). */
  setModelVerdict(key: string, verdict: ModelVerdict): void {
    this.store.update((d) => {
      const global = ensureDict(d, "global");
      const verdicts = isRecord(global.claudeModelVerdicts) ? global.claudeModelVerdicts : {};
      global.claudeModelVerdicts = { ...verdicts, [key]: verdict };
    });
  }
}
