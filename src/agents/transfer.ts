// The `agent settings` export/import domain: one JSON bundle of every PORTABLE setting, for
// moving a setup to another machine. Cross-agent (import re-wires BOTH agents), so it lives in
// src/agents/.
//
// Portable is exactly the settings (CopilotEnvConfig) and the credential slots (CopilotEnvState) of
// the account-wide store (state.json). Everything else is re-derived on import, never copied:
// agent config files, daemon homes, port reservations, the Codex catalog cache fields, and the
// machine-local ownership ledger (src/copilot_api/ownership.ts).
//
// The bundle wins where it resolves: a bundle credential this machine can resolve REPLACES the
// local slot, and a store write is not rolled back when the wiring after it fails (the slot
// stays committed-but-unwired for a re-add or `agent sync`). Proxy wiring is the one
// credential-free write: `agent start` resolves the credential itself and refuses without one.
//
//   bundle credential unresolvable here -> local slot kept; skipped whole when it is unresolvable too
//   profile absent from the bundle      -> untouched
//   bundle mode "none"                  -> that agent left alone
import { basename, join, posix, win32 } from "node:path";
import * as v from "valibot";
import {
  CONFIG_REGISTRY,
  type ConfigKeyDef,
  type ConfigValue,
  type GlobalConfigData,
  type GlobalMapKey,
  type ProfileConfigData,
} from "../copilot_api/config_registry.ts";
import { Credential, ghAuthToken } from "../copilot_api/credential.ts";
import { directOverlayIn } from "../copilot_api/direct_pair.ts";
import { CopilotEnvConfig, type CopilotEnvConfigData } from "../copilot_api/env_config.ts";
import {
  AUTH_PROVIDERS,
  CopilotEnvState,
  PROFILE_MODES,
  type ProfileCredentialData,
  type ProfileSlotData,
  type ProvisionedCredential,
} from "../copilot_api/env_state.ts";
import { GH_LOGIN_RE } from "../copilot_api/gh_cli.ts";
import { resolveRootHome } from "../copilot_api/paths.ts";
import {
  DEFAULT_PROFILE_NAME,
  isValidProfileName,
  type Profile,
  type ProfileName,
  parseProfileName,
} from "../copilot_api/profile.ts";
import { type FileChange, underDryRunMarker, withDryRun } from "../utils/dry_run.ts";
import * as fs from "../utils/fs_facade.ts";
import { isRecord } from "../utils/json.ts";
import { withNarrationMuted } from "../utils/logger.ts";
import { caught, type Message, scannable } from "../utils/message.ts";
import { underInternalRoot } from "../utils/report_write.ts";
import { quotePosix, quotePowerShell } from "../utils/shell_quote.ts";
import { reconcileClaudeDesktopWiring } from "./claude_desktop.ts";
import { configureDefaultAgents } from "./configure_defaults.ts";
import { bothAgents, directPairIncomplete, wireBothAgents } from "./profile_wiring.ts";
import {
  AGENT_PROVIDER_MODES,
  type AgentProviderMode,
  type ManagedAgentMode,
} from "./provider_mode.ts";

// Both are external contracts: a bundle one copilot-env wrote is read by another.

/** The format this copilot-env writes and reads; any other version is rejected outright. */
const SETTINGS_BUNDLE_FORMAT_VERSION = 2;

/** Stands in for every token of a default (credential-less) export; import reads it as no token. */
export const REDACTED_TOKEN = "<redacted>";

/** One exported settings bundle (the `agent settings --export` JSON document). `config` is the
 *  global map and every profile's section as stored: unset keys are omitted (defaults never
 *  travel), and a credential-bearing key reads REDACTED_TOKEN unless exported `withCredentials`;
 *  `skippedConfig` holds each value this OS cannot apply as the warning the import prints for
 *  leaving it out. */
export interface SettingsBundle {
  /** Only SETTINGS_BUNDLE_FORMAT_VERSION parses; any other version is rejected outright. */
  formatVersion: typeof SETTINGS_BUNDLE_FORMAT_VERSION;

  /** The store as stored: unset keys omitted, credential-bearing values redacted by default. */
  config: CopilotEnvConfigData;

  /** The default credential slot (token redacted unless `withCredentials`). */
  credential: ProfileCredentialData;

  /** Every named profile's store slot (tokens redacted the same way). */
  profiles: Record<string, ProfileSlotData>;

  /** Both agents' DEFAULT wiring at export time; import re-derives it. */
  modes: { codex: AgentProviderMode; claude: AgentProviderMode };

  /** parseSettingsBundle's alone, never serialized: the `config` values this OS cannot apply. */
  skippedConfig?: readonly Message[];
}

/** Preferences whose VALUE may carry a credential, such as a price-list URL's query. */
const CREDENTIAL_BEARING_PREFS = [
  "cost.pricing-url",
  "cost.github-pricing-url",
] as const satisfies readonly GlobalMapKey[];

/** A credential-bearing preference is exported as REDACTED_TOKEN by default and, on import, treated
 *  like a redacted token (the local value stays). Absence still means unset, as for every other
 *  preference. */
function isRedactedPref(config: CopilotEnvConfigData, key: GlobalMapKey): boolean {
  return CREDENTIAL_BEARING_PREFS.some((k) => k === key) && config.global[key] === REDACTED_TOKEN;
}

/** The keys with a value: a lenient read leaves absent keys undefined, and undefined is "unset". */
function setKeys(section: Record<string, unknown>): string[] {
  return Object.keys(section).filter((key) => section[key] !== undefined);
}

function storedPrefs(withCredentials: boolean): CopilotEnvConfigData {
  const data = new CopilotEnvConfig().read();
  const global: GlobalConfigData = { ...data.global };
  if (!withCredentials) {
    for (const key of CREDENTIAL_BEARING_PREFS) {
      if (global[key] !== undefined) global[key] = REDACTED_TOKEN;
    }
  }
  return { global, profiles: data.profiles };
}

/** Redaction is the default so a casually shared bundle never leaks a credential. */
export function buildExportBundle(options: { withCredentials?: boolean } = {}): SettingsBundle {
  const withCredentials = options.withCredentials ?? false;
  const store = new CopilotEnvState();
  const state = store.read();
  const defaultMode: AgentProviderMode = store.readProfileSlot(null).mode ?? "none";
  const redact = (token: string | null): string | null =>
    token !== null && !withCredentials ? REDACTED_TOKEN : token;
  const profiles: Record<string, ProfileSlotData> = {};
  for (const [name, slot] of Object.entries(state.profiles)) {
    // Same trust boundary as CopilotEnvState.profileNames: a hand-edited key
    // that is not a valid profile name never travels.
    if (!isValidProfileName(name)) continue;
    profiles[name] = { ...slot, githubToken: redact(slot.githubToken) };
  }
  return {
    formatVersion: SETTINGS_BUNDLE_FORMAT_VERSION,
    config: storedPrefs(withCredentials),
    credential: {
      githubToken: redact(state.githubToken),
      authProvider: state.authProvider,
      ghUser: state.ghUser,
    },
    profiles,
    // The default slot's recorded mode, the truth for both agents (the agent files are outputs);
    // an unrecorded mode exports as "none", which imports as "leave alone".
    modes: { codex: defaultMode, claude: defaultMode },
  };
}

export function serializeSettingsBundle(bundle: SettingsBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

/** Deliberately silent about `modes`: wiring is derived state, so it matters to the import
 *  confirmation (checked separately) but not to a backup (nothing to roll back). */
function bundleIsEmpty(bundle: SettingsBundle): boolean {
  return (
    setKeys(bundle.config.global).length === 0 &&
    Object.values(bundle.config.profiles).every((section) => setKeys(section).length === 0) &&
    bundle.credential.githubToken === null &&
    bundle.credential.authProvider === null &&
    Object.keys(bundle.profiles).length === 0
  );
}

// --- bundle parsing -------------------------------------------------------------
//
// A bundle is UNTRUSTED input (hand-carried, possibly edited), so this is a strict parse
// boundary: unknown keys and malformed values are rejections, never dropped or coerced the way
// the stores' lenient read schemas would, because a full-replace import would then quietly
// reset a preference or wipe a credential. Error messages carry only text this parser owns
// (section paths, expected shapes, validated profile names); no bundle value or unknown KEY is
// echoed, since either could be a pasted token: every node below names its own wording
// (valibot's defaults echo the received value) and bundleError prefixes the dotted path.
// The default profile's section admits the profile-only keys alone (DEFAULT_SECTION_DEFS): its
// proxy knobs are the global map, what `--set` writes without `--profile`, so an override there
// could be removed by no command.

/** The wording every object-shaped section rejects a non-object with, the top level included. */
const JSON_OBJECT = "must be a JSON object";

/** The wording NULLABLE_STRING and the ghUser pin share for a blank or non-string value. */
const NON_EMPTY_OR_NULL = "must be a non-empty string or null";

/** valibot takes any object, an array included, where a bundle section is a JSON object. */
const jsonObject = v.custom<Record<string, unknown>>(isRecord, JSON_OBJECT);

/** Absent reads as null (unambiguously "none"); present must be null or a non-blank string. */
const NULLABLE_STRING = v.nullish(
  v.pipe(v.string(NON_EMPTY_OR_NULL), v.trim(), v.minLength(1, NON_EMPTY_OR_NULL)),
  null,
);

function nullableEnum<const TOptions extends v.PicklistOptions>(allowed: TOptions) {
  return v.nullish(v.picklist(allowed, `must be one of ${allowed.join("|")}, or null`), null);
}

const CREDENTIAL_ENTRIES = {
  githubToken: NULLABLE_STRING,
  authProvider: nullableEnum(AUTH_PROVIDERS),
  // Same login-shape gate as the store's write choke point: the pin becomes a
  // `gh auth token --user` argv token, so a shell metacharacter never travels.
  ghUser: v.nullish(
    v.pipe(
      v.string(NON_EMPTY_OR_NULL),
      v.trim(),
      v.minLength(1, NON_EMPTY_OR_NULL),
      v.regex(GH_LOGIN_RE, "must be a GitHub login (1-39 letters, digits, dashes, or underscores)"),
    ),
    null,
  ),
};

/** Three contradictions the store would otherwise carry dead or dangerous:
 *    token, no provider     -> could never resolve (resolution keys off authProvider)
 *    token + gh-cli         -> sits ignored until a --with-credentials export exposes it
 *    ghUser + non-gh-cli    -> a dead account pin */
function withoutContradictions<TSlot extends ProfileCredentialData>(
  slot: v.GenericSchema<unknown, TSlot>,
) {
  return v.pipe(
    slot,
    v.check(
      (s: TSlot) => s.githubToken === null || s.authProvider !== null,
      "carries a token without an authProvider (credentials are provider-driven)",
    ),
    v.check(
      (s: TSlot) => s.githubToken === null || s.authProvider !== "gh-cli",
      "pairs a token with the gh-cli provider (gh-cli stores no token; the local gh login resolves it)",
    ),
    v.check(
      (s: TSlot) => s.ghUser === null || s.authProvider === "gh-cli",
      "pairs a ghUser account pin with a non-gh-cli provider (only gh-cli resolves via a gh account)",
    ),
  );
}

const CREDENTIAL = withoutContradictions(v.pipe(jsonObject, v.strictObject(CREDENTIAL_ENTRIES)));
const PROFILE_SLOT = withoutContradictions(
  v.pipe(jsonObject, v.strictObject({ ...CREDENTIAL_ENTRIES, mode: nullableEnum(PROFILE_MODES) })),
);

/** Every name is judged before the section it names (an invalid one is untrusted input and not
 *  echoed), and before valibot walks the map: its record and rest walks skip `__proto__`,
 *  `prototype`, and `constructor` as a pollution guard, so a section by one of those names would
 *  vanish silently. The stores' own reads skip them the same way, so no profile can carry one. */
function namedSections(isName: (name: string) => boolean, message: string) {
  const skipped = new Set(["__proto__", "prototype", "constructor"]);
  return v.check(
    (map: Record<string, unknown>) =>
      Object.keys(map).every((name) => isName(name) && !skipped.has(name)),
    message,
  );
}

/** The named profiles' map; each name is judged before its slot (namedSections says why). */
const PROFILE_SLOTS = v.pipe(
  jsonObject,
  namedSections(
    isValidProfileName,
    "carries an invalid profile name (want 1-32 chars of [a-z0-9-], non-reserved)",
  ),
  v.record(v.string(), PROFILE_SLOT),
);

/** One wording for both entries and their object: valibot blames a missing entry on the object. */
const MODE_MESSAGE = `must be one of ${AGENT_PROVIDER_MODES.join("|")}`;

/** The default's one mode for both agents: two managed modes are refused before any write. */
const MODES = v.pipe(
  jsonObject,
  v.strictObject(
    {
      codex: v.picklist(AGENT_PROVIDER_MODES, MODE_MESSAGE),
      claude: v.picklist(AGENT_PROVIDER_MODES, MODE_MESSAGE),
    },
    MODE_MESSAGE,
  ),
  v.check(
    ({ codex, claude }) => {
      // The default is a profile: one mode for both agents. Two managed modes cannot land, so a
      // bundle carrying them is refused before any store or file is written (the single-agent
      // writes would refuse the second anyway, after the first landed).
      const managed = [codex, claude].filter((m) => m === "direct" || m === "proxy");
      return managed.length < 2 || managed[0] === managed[1];
    },
    (issue) =>
      `names ${issue.input.codex} for Codex and ${issue.input.claude} for Claude; the default ` +
      "profile is one mode for both agents",
  ),
);

/** The `global` section's keys: every registry key but the profile-only ones. */
const GLOBAL_DEFS = CONFIG_REGISTRY.filter((def) => def.scope !== "profile");

/** A named profile's section keys: every registry key but the global-only ones. */
const PROFILE_DEFS = CONFIG_REGISTRY.filter((def) => def.scope !== "global");

/** The default's section: the profile-only keys; its proxy knobs are the global map (see above). */
const DEFAULT_SECTION_DEFS = CONFIG_REGISTRY.filter((def) => def.scope === "profile");

/** One map of the preference store, each value judged by its registry domain (env_config owns the
 *  shapes, so a new key is admitted here automatically) and refused where the store's own read
 *  would fall back to unset.
 *
 *    the domain's message  -> can echo the value, so the key's describe is the wording
 *    REDACTED_TOKEN        -> admitted on the credential-bearing keys alone (the domain refuses it)
 *    the cast              -> the fromEntries fold erases the per-key types `satisfies` checked */
function strictMap<T>(defs: readonly ConfigKeyDef[]): v.GenericSchema<unknown, T> {
  const entries = defs.map((def): [string, v.GenericSchema<unknown, ConfigValue | undefined>] => {
    const redactable = CREDENTIAL_BEARING_PREFS.some((key) => key === def.key);
    const judged = v.rawTransform(({ dataset, addIssue, NEVER }) => {
      if (redactable && dataset.value === REDACTED_TOKEN) return REDACTED_TOKEN;
      const parsed = v.safeParse(def.schema, dataset.value);
      if (parsed.success) return parsed.output;
      addIssue({ message: `is invalid (expected: ${def.describe})` });
      return NEVER;
    });
    return [def.key, v.optional(v.pipe(v.unknown(), judged))];
  });
  const map = v.pipe(jsonObject, v.strictObject(Object.fromEntries(entries)));
  return map as unknown as v.GenericSchema<unknown, T>;
}

const GLOBAL_MAP = strictMap<GlobalConfigData>(GLOBAL_DEFS);

const PROFILE_SECTIONS = v.pipe(
  jsonObject,
  namedSections(
    (name) => name === DEFAULT_PROFILE_NAME || isValidProfileName(name),
    "carries an invalid profile name (want `default` or 1-32 chars of [a-z0-9-], non-reserved)",
  ),
  v.objectWithRest(
    {
      [DEFAULT_PROFILE_NAME]: v.optional(strictMap<ProfileConfigData>(DEFAULT_SECTION_DEFS)),
    },
    strictMap<ProfileConfigData>(PROFILE_DEFS),
  ),
);

const BUNDLE_SCHEMA = v.pipe(
  jsonObject,
  v.strictObject(
    {
      formatVersion: v.literal(SETTINGS_BUNDLE_FORMAT_VERSION),
      config: v.pipe(
        jsonObject,
        v.strictObject({ global: GLOBAL_MAP, profiles: PROFILE_SECTIONS }, JSON_OBJECT),
      ),
      credential: CREDENTIAL,
      profiles: PROFILE_SLOTS,
      modes: MODES,
    },
    JSON_OBJECT,
  ),
);

/** A bundle travels between OS families, and `codex.home` is the one preference whose value is a
 *  machine path: an absolute path of the OTHER family (a Linux export read on Windows, or the
 *  reverse) is left out with a warning instead of failing the whole import. Anything else the
 *  domain rejects (a relative path, `~`) is still a rejection, and the domain's own verdict comes
 *  first because `//server/share` is absolute on both families. */
function liftForeignCodexHome(raw: unknown): { input: unknown; skipped: Message[] } {
  const kept = { input: raw, skipped: [] };
  if (!isRecord(raw) || !isRecord(raw.config) || !isRecord(raw.config.global)) return kept;
  const { "codex.home": home, ...global } = raw.config.global;
  if (typeof home !== "string" || v.is(GLOBAL_MAP, { "codex.home": home })) return kept;
  const foreign =
    process.platform === "win32"
      ? posix.isAbsolute(home)
      : win32.isAbsolute(home) && win32.parse(home).root.length > 1;
  if (!foreign) return kept;
  return {
    input: { ...raw, config: { ...raw.config, global } },
    skipped: [
      `codex.home "${home}" is not a path on this OS; skipped, set it here with agent config`,
    ],
  };
}

/** The node's wording behind the dotted path, which valibot completes only after the parse. A
 *  strict object reports an unknown entry as `expected: "never"` at the key's own path, and the
 *  parent is named, never the key. */
function bundleError(issue: v.BaseIssue<unknown>): Error {
  const path = issue.path ?? [];
  if (path.length === 0) return new Error("not a settings bundle (expected a JSON object)");
  const dotted = (items: readonly v.IssuePathItem[]) =>
    items.map((item) => String(item.key)).join(".");
  if (dotted(path) === "formatVersion") {
    return new Error(
      "unsupported settings bundle formatVersion - this copilot-env reads " +
        `version ${SETTINGS_BUNDLE_FORMAT_VERSION}`,
    );
  }
  const detail =
    issue.expected === "never"
      ? `unknown key under ${dotted(path.slice(0, -1)) || "the bundle root"}`
      : `${dotted(path)} ${issue.message}`;
  return new Error(`invalid settings bundle: ${detail}`);
}

/** An unknown `formatVersion` is rejected with its own message: the one deliberate
 *  compatibility gate. */
export function parseSettingsBundle(raw: unknown): SettingsBundle {
  const { input, skipped } = liftForeignCodexHome(raw);
  const result = v.safeParse(BUNDLE_SCHEMA, input, { abortEarly: true });
  if (!result.success) throw bundleError(result.issues[0]);
  return { ...result.output, skippedConfig: skipped };
}

// --- import planning --------------------------------------------------------
//
// The import is ONE plan computed up front (every slot's landing, the default modes); the
// confirmation and the apply both execute that plan, so the prompt cannot describe a landing the
// apply would not perform. The confirmation's file list is the apply itself run on the fs seam's
// overlay (previewImportChanges). The gh CLI is probed once per pinned account (ghUser; null is
// gh's active account) per import.

/** Import test seams, threaded through to the wiring layers untouched.
 *  `ghAuthToken` substitutes the gh CLI token probe so gh-cli slot handling is
 *  testable without spawning the machine's real `gh`. */
export interface ImportDeps {
  ghAuthToken?: typeof ghAuthToken;
}

/** What applyImportPlan did, for the command layer to render. `modes` is null when nothing managed
 *  was in the bundle or every slot was skipped; the command layer prints each failure at its
 *  stream's width. */
export interface ImportOutcome {
  /** Both agents' modes after the default re-derivation; null when neither agent was written. */
  modes: { codex: AgentProviderMode; claude: AgentProviderMode } | null;

  /** Named profiles fully restored (credential + mode + both agents wired). */
  wiredProfiles: ProfileName[];

  /** Human-readable reasons for slots/wiring intentionally left alone. */
  skipped: Message[];

  /** Wiring failures the import went past, default or per-profile; any makes the exit non-zero. */
  failures: Message[];
}

/**
 * One slot's planned landing, judged on the RESULTING store slot. A gh-cli slot whose `gh`
 * does not resolve lands as `keep`: gh failing only rules out the BUNDLE's credential, not
 * the machine's.
 */
type SlotPlan =
  // The bundle's credential lands (a real token, or gh-cli once the local `gh` proved it
  // resolves); already in the store's provisioned union, so the apply can never write half
  // a credential. `resolvedToken` is what the slot resolves to, handed to the wiring so
  // nothing re-runs a resolver.
  | { action: "write"; credential: ProvisionedCredential; resolvedToken: string | null }
  // Nothing usable travels: the local slot survives untouched and ITS resolution decides
  // wireability, so a redacted bundle over a working local credential still wires normally.
  | { action: "keep"; resolvedToken: string | null }
  // Nothing resolves at all; `reason` says why (with the gh hint when gh-cli was involved)
  // and the apply writes nothing to the slot.
  | { action: "skip"; reason: string };

function localSlotToken(
  profile: Profile,
  gh: (ghUser: string | null) => string | null,
): string | null {
  return new Credential(undefined, profile).resolve(gh);
}

function planSlotCredential(
  slot: ProfileCredentialData,
  profile: Profile,
  gh: (ghUser: string | null) => string | null,
): SlotPlan {
  const { githubToken, authProvider, ghUser } = slot;
  if (authProvider === "gh-cli") {
    const ghToken = gh(ghUser);
    if (ghToken !== null) {
      return { action: "write", credential: { kind: "gh-cli", ghUser }, resolvedToken: ghToken };
    }
    const local = localSlotToken(profile, gh);
    if (local !== null) return { action: "keep", resolvedToken: local };
    return {
      action: "skip",
      reason:
        "the bundle relies on the gh CLI login, which does not resolve a token on this " +
        "machine (`gh auth login`), and no stored credential resolves either",
    };
  }
  // A redacted placeholder is not a token, so that slot falls through to keep/skip.
  if (authProvider !== null && githubToken !== null && githubToken !== REDACTED_TOKEN) {
    return {
      action: "write",
      credential: { kind: "stored", provider: authProvider, token: githubToken },
      resolvedToken: githubToken,
    };
  }
  const local = localSlotToken(profile, gh);
  if (local !== null) return { action: "keep", resolvedToken: local };
  return {
    action: "skip",
    reason: "the bundle carries no usable token and no stored credential resolves",
  };
}

/** Only managed modes are ours to write. Direct needs the default credential to resolve (its
 *  helper fetches the token at request time); proxy is written credential-free, and `agent start`
 *  resolves the credential itself, refusing without one. */
function importableMode(
  mode: AgentProviderMode,
  label: string,
  defaultUsable: boolean,
): { mode: ManagedAgentMode | null; skipped: Message | null } {
  if (mode === "none") return { mode: null, skipped: null };
  if (mode === "other") {
    return {
      mode: null,
      skipped: `${label} wiring: the bundle recorded an unmanaged provider - left untouched`,
    };
  }
  if (mode === "direct" && !defaultUsable) {
    return {
      mode: null,
      skipped: scannable({
        headline: `${label} direct wiring: no credential resolves for the default slot.`,
        lead: "Fix:",
        actions: [
          ["agent auth", "log in"],
          ["agent init --direct", "then wire it"],
        ],
      }),
    };
  }
  return { mode, skipped: null };
}

/** One profile's parsed bundle slot plus its planned landing. */
interface PlannedProfile {
  name: ProfileName;
  slot: ProfileSlotData;
  landing: SlotPlan;
}

/** The complete import plan: what lands where, what gets wired, and what gets skipped (and why).
 *  `modes` are the per-agent default modes the apply will write (null = leave alone); `skipped` is
 *  decided here so the summary and the apply agree. */
export interface ImportPlan {
  bundle: SettingsBundle;
  defaultSlot: SlotPlan;
  modes: { codex: ManagedAgentMode | null; claude: ManagedAgentMode | null };
  profiles: PlannedProfile[];
  skipped: Message[];
}

/** How far an import reaches. The whole store lands the default's credential and wiring and
 *  reconciles every Desktop entry; one named profile's bundle (`agent profile <name> settings
 *  --import`) never touches the default, so the default's rebake rules below stay off for it and
 *  the apply leaves every other profile's Desktop entry as it is (its own profile's write carries
 *  that profile's entry). */
export interface ImportScope {
  defaultWiring: boolean;
}

/** One gh probe per pinned account, memoized, shared by every gh-cli slot and reused by the
 *  apply. */
function memoizedGhToken(probe: typeof ghAuthToken): (ghUser: string | null) => string | null {
  const tokens = new Map<string | null, string | null>();
  return (ghUser) => {
    let token = tokens.get(ghUser);
    if (token === undefined) {
      token = probe(ghUser);
      tokens.set(ghUser, token);
    }
    return token;
  };
}

/** Both agents' default landing, decided at PLAN time, so the skip lines and the preview name both
 *  agents' files. `pairUnstored` is the apply's own test (runAgentConfig), judged under the
 *  BUNDLE's overlay: the apply replaces the preferences before it wires, so the local ones would
 *  answer for the wrong document. The plan alone knows one more fact: a default credential landing
 *  takes the pair with it.
 *
 *  A bundle with no default wiring still rebakes both on such a default: a landing is where the
 *  pair is probed and stored, and nothing else in the import would wire it. */
function planDefaultModes(
  bundle: SettingsBundle,
  defaultSlot: SlotPlan,
  scope: ImportScope,
): { modes: ImportPlan["modes"]; skipped: Message[] } {
  const defaultUsable = defaultSlot.action !== "skip";
  const codexWiring = importableMode(bundle.modes.codex, "Codex", defaultUsable);
  const claudeWiring = importableMode(bundle.modes.claude, "Claude", defaultUsable);
  const modes = { codex: codexWiring.mode, claude: claudeWiring.mode };
  const wiringSkips = { codex: codexWiring.skipped, claude: claudeWiring.skipped };
  const recorded = new CopilotEnvState().readProfileSlot(null).mode;
  const named = modes.codex ?? modes.claude;
  const oneNamed = named !== null && (modes.codex === null) !== (modes.claude === null);
  /** A landing overrides a skip line for the OTHER agent (an unmanaged or gated mode there): the
   *  write sets the mode both agents share, so the line says what lands instead. A plain `none`
   *  for that agent is no event and gets no line. */
  const landBoth = (mode: ManagedAgentMode, why: string): void => {
    const other = modes.codex === null ? "codex" : "claude";
    if (wiringSkips[other] !== null) {
      const label = other === "codex" ? "Codex" : "Claude";
      wiringSkips[other] = `${label} wiring: ${why} (one mode for both)`;
    }
    modes.codex = mode;
    modes.claude = mode;
  };
  const pairUnstored =
    scope.defaultWiring &&
    recorded === "direct" &&
    (defaultSlot.action === "write" ||
      directPairIncomplete(null, directOverlayIn(bundle.config, null)));
  if (bundle.modes.codex === "none" && bundle.modes.claude === "none" && pairUnstored) {
    modes.codex = "direct";
    modes.claude = "direct";
  } else if (scope.defaultWiring && oneNamed && recorded === null) {
    landBoth(
      named,
      `the default profile has no recorded mode, so the bundle's ${named} wiring lands for both agents`,
    );
  } else if (oneNamed && named === "direct" && pairUnstored) {
    landBoth("direct", "the default's Direct pair is not stored, so both agents are rebaked");
  }
  const skipped = [wiringSkips.codex, wiringSkips.claude].filter(
    (line): line is Message => line !== null,
  );
  return { modes, skipped };
}

/** Each named slot's landing. A credential with no mode can only RE-AUTH an existing profile; with
 *  none here, writing it would create the half profile the atomic slot commit exists to prevent,
 *  so that slot is skipped whole. */
function planProfiles(
  bundle: SettingsBundle,
  gh: (ghUser: string | null) => string | null,
): { profiles: PlannedProfile[]; skipped: Message[] } {
  const state = new CopilotEnvState();
  const profiles: PlannedProfile[] = [];
  const skipped: Message[] = [];
  for (const [rawName, slot] of Object.entries(bundle.profiles)) {
    const name = parseProfileName(rawName);
    let landing = planSlotCredential(slot, name, gh);
    if (landing.action === "write" && slot.mode === null && !state.profileSlotStatus(name).exists) {
      landing = {
        action: "skip",
        reason:
          "the bundle records a credential but no mode, and no profile exists here to re-auth",
      };
    }
    if (landing.action === "skip") {
      // The re-add acquires the profile's own credential itself, so it is the
      // one repair that works whether or not the profile already exists here.
      skipped.push(
        `profile '${name}': ${landing.reason} - not imported; run ` +
          `\`agent profile ${name} add --direct|--proxy\``,
      );
    }
    profiles.push({ name, slot, landing });
  }
  return { profiles, skipped };
}

/** Compute the whole import plan against the CURRENT stores. */
export function planImport(
  bundle: SettingsBundle,
  deps: ImportDeps = {},
  scope: ImportScope = { defaultWiring: true },
): ImportPlan {
  const gh = memoizedGhToken(deps.ghAuthToken ?? ghAuthToken);
  const skipped: Message[] = [...(bundle.skippedConfig ?? [])];
  const defaultSlot = planSlotCredential(bundle.credential, null, gh);
  if (defaultSlot.action === "skip" && bundle.credential.authProvider !== null) {
    // Only a slot the bundle carried is an event; skipped wiring gets its own importableMode
    // message.
    skipped.push(`default credential: ${defaultSlot.reason}; run \`agent auth\``);
  }
  const wiring = planDefaultModes(bundle, defaultSlot, scope);
  skipped.push(...wiring.skipped);
  const planned = planProfiles(bundle, gh);
  skipped.push(...planned.skipped);
  return { bundle, defaultSlot, modes: wiring.modes, profiles: planned.profiles, skipped };
}

// --- import apply -------------------------------------------------------------

/** Restore, not merge: keys absent from the bundle revert to their defaults, per profile section
 *  too, which is safe only because the strict parse rejected junk instead of dropping it. A
 *  redacted key keeps the local value, as a redacted token keeps the local credential. */
function importPreferences(config: CopilotEnvConfigData): void {
  const store = new CopilotEnvConfig();
  const global: GlobalConfigData = { ...config.global };
  for (const key of CREDENTIAL_BEARING_PREFS) {
    if (isRedactedPref(config, key)) global[key] = store.read().global[key];
  }
  store.replace({ global, profiles: config.profiles });
}

/** No mode: a re-auth. planImport skipped the no-profile case; the store's own guard still fires
 *  if a concurrent --del raced the plan, hence the try. A complete Direct slot is rebaked with a
 *  fresh selection, as `agent profile <name> auth` does: the credential write took the previous
 *  pair with it, and the Desktop reconcile after the profiles renders the slot's pair. */
async function reauthProfile(
  state: CopilotEnvState,
  name: ProfileName,
  landing: SlotPlan,
  outcome: ImportOutcome,
): Promise<void> {
  if (landing.action !== "write") return;
  try {
    state.setCredential(name, landing.credential);
    const landed = state.readProfileSlot(name);
    if (landed.kind === "complete" && landed.mode === "direct") {
      await wireBothAgents(name, "direct", false, "probe", landing.resolvedToken);
      outcome.wiredProfiles.push(name);
    }
  } catch (e) {
    outcome.failures.push(caught(e, (message) => `profile '${name}': ${message}`));
  }
}

/**
 * Credential + mode land as ONE commitProfile write, the machinery `agent profile <name> add` uses.
 * Each profile stands alone: a failure is recorded and the next profile still runs.
 *
 *   a crash mid-import   -> at worst a complete-but-unwired slot, re-derived by `agent sync`
 *   a proxy-mode profile -> still needs its OWN resolvable credential, unlike the default slot
 *                           (the rule runAdd enforces in src/commands/profile.ts)
 */
async function importProfiles(plan: ImportPlan, outcome: ImportOutcome): Promise<void> {
  const state = new CopilotEnvState();
  for (const { name, slot, landing } of plan.profiles) {
    if (landing.action === "skip") continue;
    if (slot.mode === null) {
      await reauthProfile(state, name, landing, outcome);
      continue;
    }
    const credential =
      landing.action === "write" ? landing.credential : keptCredential(state, name);
    if (credential === null) {
      // Only reachable if the local credential vanished between plan and apply.
      outcome.failures.push(`profile '${name}': its stored credential no longer resolves`);
      continue;
    }
    try {
      // A new credential probes (its stored pair went with the old one); a kept credential renders
      // the slot's pair, or probes through the gap when none was stored.
      state.commitProfile(name, { credential, mode: slot.mode });
      await wireBothAgents(
        name,
        slot.mode,
        false,
        landing.action === "write" ? "probe" : "stored",
        landing.resolvedToken,
      );
      outcome.wiredProfiles.push(name);
    } catch (e) {
      outcome.failures.push(caught(e, (message) => `profile '${name}': ${message}`));
    }
  }
}

/** A kept slot's own credential for the atomic mode commit; null only when the
 *  slot stopped resolving after the plan judged it (a plan/apply race). */
function keptCredential(state: CopilotEnvState, name: ProfileName): ProvisionedCredential | null {
  const credential = state.readProfileSlot(name).credential;
  return credential.kind === "none" ? null : credential;
}

/** Stores first, then everything else is RE-DERIVED through the same machinery `agent init`
 *  (configureDefaultAgents) and `agent profile` (wireBothAgents) use. Every wiring path takes the
 *  plan's already-resolved credential except the Claude Desktop syncs:
 *
 *    a named profile's Desktop sync -> claudeAdapter.configureProfile passes no directToken
 *    an unwired default entry       -> syncTarget resolves that slot itself, and the reconcile
 *                                      below runs even for a config-only import */
export async function applyImportPlan(
  plan: ImportPlan,
  scope: ImportScope = { defaultWiring: true },
): Promise<ImportOutcome> {
  const outcome: ImportOutcome = {
    modes: null,
    wiredProfiles: [],
    skipped: [...plan.skipped],
    failures: [],
  };
  importPreferences(plan.bundle.config);
  if (plan.defaultSlot.action === "write") {
    new CopilotEnvState().setCredential(null, plan.defaultSlot.credential);
  }
  if (plan.modes.codex !== null || plan.modes.claude !== null) {
    const { codex, claude, failures } = await configureDefaultAgents(
      {
        codex: plan.modes.codex,
        claude: plan.modes.claude,
        // null = wire credential-free (only proxy modes survive the gate
        // without a resolvable slot).
        ghToken: plan.defaultSlot.action === "skip" ? null : plan.defaultSlot.resolvedToken,
      },
      bothAgents(),
    );
    outcome.modes = { codex, claude };
    outcome.failures.push(...failures);
  }
  await importProfiles(plan, outcome);
  if (scope.defaultWiring) {
    // The imported `claude.desktop` preference lands even when no wiring was re-derived.
    await reconcileClaudeDesktopWiring();
  } else {
    // A named bundle reaches its profile's entry alone: a re-auth with no mode, or a preference
    // its entry bakes (static-key), lands there and nowhere else.
    for (const { name, landing } of plan.profiles) {
      if (landing.action !== "skip") await reconcileClaudeDesktopWiring({ only: name });
    }
  }
  return outcome;
}

/** The files the import would create or rewrite: the apply itself, run on the fs seam's overlay
 *  with every spawned child a silent dry run and its narration muted (the real run's follows the
 *  confirmation). A create of copilot-env's own homes or inside them is bookkeeping, as the write
 *  ledger treats it; a rewrite or delete there changes recorded state and is listed. A throw is the
 *  real apply's, raised here before anything lands. */
export async function previewImportChanges(
  plan: ImportPlan,
  scope: ImportScope = { defaultWiring: true },
  apply: typeof applyImportPlan = applyImportPlan,
): Promise<FileChange[]> {
  const run = await withNarrationMuted(() =>
    underDryRunMarker(() => withDryRun(() => apply(plan, scope))),
  );
  if (run.status === "failed") throw run.error;
  return run.changes.filter(
    (change) =>
      change.verdict === "rewrite" ||
      change.verdict === "delete" ||
      (change.verdict === "create" && !underInternalRoot(change.path)),
  );
}

// --- pre-import backups -------------------------------------------------------

/** The rollback invocation, path quoted for THIS machine's shell. */
export function rollbackCommand(backupPath: string): string {
  const quoted =
    process.platform === "win32" ? quotePowerShell(backupPath) : quotePosix(backupPath);
  return `agent settings --import ${quoted}`;
}

/** Directory (under the ROOT home) holding the pre-import settings backups. */
const SETTINGS_BACKUP_DIR_NAME = "settings-backups";

/** How many backups survive a prune: each holds plaintext tokens, so the pile is bounded. */
export const SETTINGS_BACKUP_KEEP = 5;

export function settingsBackupDir(): string {
  return join(resolveRootHome(), SETTINGS_BACKUP_DIR_NAME);
}

const BACKUP_FILE_RE = /^settings-.*\.json$/;

// Appended after the millisecond timestamp: uniquifies same-millisecond backups and keeps the
// prune's lexicographic sort chronological within one process.
let backupSeq = 0;

/** Best-effort prune: keep only the newest SETTINGS_BACKUP_KEEP backups. `landed` is the backup
 *  this run just wrote, counted with the listing so the prune's set is the real one. */
function pruneSettingsBackups(dir: string, landed: string): void {
  let names: string[];
  try {
    names = [...new Set([...fs.readdir(dir), basename(landed)])]
      .filter((name) => BACKUP_FILE_RE.test(name))
      .sort();
  } catch {
    return;
  }
  for (const name of names.slice(0, Math.max(0, names.length - SETTINGS_BACKUP_KEEP))) {
    try {
      fs.rm(join(dir, name), { force: true });
    } catch {
      // best-effort: a stuck file only delays the next prune
    }
  }
}

/** The bundle's token-bearing leaves, redacted in a preview of the backup: every slot's token and
 *  the credential-bearing preferences. */
function backupSecretKeys(bundle: SettingsBundle): string[] {
  return [
    "credential.githubToken",
    ...Object.keys(bundle.profiles).map((name) => `profiles.${name}.githubToken`),
    ...CREDENTIAL_BEARING_PREFS.map((key) => `config.global."${key}"`),
  ];
}

/**
 * Credentials included: a rollback without tokens is not a rollback, so the file stays in the
 * same trust domain as the plaintext stores.
 *
 *   dir 0700, file 0600 where modes apply -> the tokens never widen past the stores
 *   both stores empty                     -> null, nothing to roll back to and wiring re-derives
 *   a rollback IS an import of the file   -> profiles a later import created survive it
 */
export function writeSettingsBackup(): string | null {
  const bundle = buildExportBundle({ withCredentials: true });
  if (bundleIsEmpty(bundle)) return null;
  const dir = settingsBackupDir();
  fs.mkdir(dir, { mode: 0o700 });
  // mkdirSync's mode only applies on creation; a pre-existing looser dir must
  // still end up 0700 (it is about to hold plaintext tokens).
  if (process.platform !== "win32") fs.chmod(dir, 0o700);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `settings-${stamp}-${String(++backupSeq).padStart(3, "0")}.json`);
  fs.writeText(path, serializeSettingsBundle(bundle), {
    atomic: false,
    mode: 0o600,
    detail: `pre-import settings backup; roll back with: ${rollbackCommand(path)}`,
    secretKeys: backupSecretKeys(bundle),
  });
  pruneSettingsBackups(dir, path);
  return path;
}
