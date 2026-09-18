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
import { claudeJsonPath } from "../claude/mcp_registration.ts";
import { resolveClaudeHome, settingsPathFor } from "../claude/paths.ts";
import type { CodexCatalogDeps } from "../codex/catalog.ts";
import { codexHostFarm, effectiveCodexHomeFor, planCodexHostFarm } from "../codex/host.ts";
import { codexConfigPath, codexProfileConfigPath } from "../codex/paths.ts";
import { Credential, ghAuthToken } from "../copilot_api/credential.ts";
import { GH_LOGIN_RE } from "../copilot_api/gh_cli.ts";
import {
  codexHomePrefsFor,
  CONFIG_REGISTRY,
  configDefaultBoolean,
  configKeyDef,
  CopilotEnvConfig,
  type CopilotEnvConfigData,
  GLOBAL_CONFIG_SCHEMA,
  type GlobalConfigData,
  type GlobalMapKey,
  PROFILE_CONFIG_SCHEMA,
  PROFILE_SETTINGS_DEFAULT_KEY,
  type ProfileConfigData,
} from "../copilot_api/env_config.ts";
import {
  AUTH_PROVIDERS,
  CopilotEnvState,
  PROFILE_MODES,
  type ProfileCredentialData,
  type ProfileSlotData,
  type ProvisionedCredential,
} from "../copilot_api/env_state.ts";
import { resolveRootHome } from "../copilot_api/paths.ts";
import {
  isValidProfileName,
  parseProfileName,
  type Profile,
  type ProfileName,
} from "../copilot_api/profile.ts";
import { errMessage } from "../utils/error.ts";
import * as fs from "../utils/fs_facade.ts";
import { isRecord } from "../utils/json.ts";
import { quotePosix, quotePowerShell } from "../utils/shell_quote.ts";
import { configureDefaultAgents } from "./configure_defaults.ts";
import { reconcileClaudeDesktopWiring } from "./claude_desktop.ts";
import { bothAgents, directPairIncomplete, wireBothAgents } from "./profile_wiring.ts";
import { directOverlayIn } from "../copilot_api/direct_pair.ts";
import {
  AGENT_PROVIDER_MODES,
  type AgentProviderMode,
  type ManagedAgentMode,
} from "./provider_mode.ts";

/** The bundle format this copilot-env writes and reads; any other version is
 *  rejected outright (external contract). */
export const SETTINGS_BUNDLE_FORMAT_VERSION = 2;

/** Placeholder replacing every token in a credential-less export (the default).
 *  An external contract: import recognizes exactly this value as "not a token". */
export const REDACTED_TOKEN = "<redacted>";

/** One exported settings bundle (the `agent settings --export` JSON document). */
export interface SettingsBundle {
  formatVersion: typeof SETTINGS_BUNDLE_FORMAT_VERSION;
  /** The preference store as stored: the global map and every profile's section (unset keys are
   *  omitted; defaults never travel); a credential-bearing key reads REDACTED_TOKEN unless exported
   *  `withCredentials`. */
  config: CopilotEnvConfigData;
  /** The default credential slot (token redacted unless `withCredentials`). */
  credential: ProfileCredentialData;
  /** Every named profile's store slot (tokens redacted the same way). */
  profiles: Record<string, ProfileSlotData>;
  /** Both agents' DEFAULT wiring at export time; import re-derives it. */
  modes: { codex: AgentProviderMode; claude: AgentProviderMode };
  /** Set by parseSettingsBundle alone, never serialized: the `config` values that cannot apply on
   *  this OS, each as the warning the import prints for leaving it out. */
  skippedConfig?: readonly string[];
}

/** Preferences whose VALUE may carry a credential (a price-list URL can hold a token in its
 *  query): exported as REDACTED_TOKEN by default and, on import, treated like a redacted token
 *  (the local value stays). Absence still means unset, as for every other preference. */
const CREDENTIAL_BEARING_PREFS = ["cost.pricing-url"] as const satisfies readonly GlobalMapKey[];

/** Whether the bundle carries the redaction marker for `key` instead of a value. */
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
export function bundleIsEmpty(bundle: SettingsBundle): boolean {
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
// echoed, since either could be a pasted token.

function bundleError(detail: string): Error {
  return new Error(`invalid settings bundle: ${detail}`);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw bundleError(`${path} must be a JSON object`);
  return value;
}

function rejectUnknownKeys(
  doc: Record<string, unknown>,
  allowed: readonly string[],
  parent: string,
): void {
  for (const key of Object.keys(doc)) {
    if (!allowed.includes(key)) throw bundleError(`unknown key under ${parent}`);
  }
}

/** An absent key reads as null (unambiguously "none"); anything present must be
 *  null or a non-blank string. */
function parseNullableString(value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw bundleError(`${path} must be a non-empty string or null`);
  }
  return value.trim();
}

function parseNullableEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T | null {
  if (value === undefined || value === null) return null;
  const hit = allowed.find((a) => a === value);
  if (hit === undefined) {
    throw bundleError(`${path} must be one of ${allowed.join("|")}, or null`);
  }
  return hit;
}

/** Three contradictions the store would otherwise carry dead or dangerous:
 *    token, no provider     -> could never resolve (resolution keys off authProvider)
 *    token + gh-cli         -> sits ignored until a --with-credentials export exposes it
 *    ghUser + non-gh-cli    -> a dead account pin */
function parseCredentialFields(doc: Record<string, unknown>, path: string): ProfileCredentialData {
  const githubToken = parseNullableString(doc.githubToken, `${path}.githubToken`);
  const authProvider = parseNullableEnum(doc.authProvider, AUTH_PROVIDERS, `${path}.authProvider`);
  const ghUser = parseNullableString(doc.ghUser, `${path}.ghUser`);
  if (githubToken !== null && authProvider === null) {
    throw bundleError(
      `${path} carries a token without an authProvider (credentials are provider-driven)`,
    );
  }
  if (githubToken !== null && authProvider === "gh-cli") {
    throw bundleError(
      `${path} pairs a token with the gh-cli provider (gh-cli stores no token; the local gh login resolves it)`,
    );
  }
  if (ghUser !== null && authProvider !== "gh-cli") {
    throw bundleError(
      `${path} pairs a ghUser account pin with a non-gh-cli provider (only gh-cli resolves via a gh account)`,
    );
  }
  // Same login-shape gate as the store's write choke point: the pin becomes a
  // `gh auth token --user` argv token, so a shell metacharacter never travels.
  if (ghUser !== null && !GH_LOGIN_RE.test(ghUser)) {
    throw bundleError(
      `${path}.ghUser must be a GitHub login (1-39 letters, digits, dashes, or underscores)`,
    );
  }
  return { githubToken, authProvider, ghUser };
}

const CREDENTIAL_KEYS = ["githubToken", "authProvider", "ghUser"] as const;
const PROFILE_SLOT_KEYS = [...CREDENTIAL_KEYS, "mode"] as const;

/** A bundle travels between OS families, and `codex.home` is the one preference whose value is a
 *  machine path: an absolute path of the OTHER family (a Linux export read on Windows, or the
 *  reverse) is left out with a warning instead of failing the whole import. Anything else the
 *  domain rejects (a relative path, `~`) is still a rejection. */
function codexHomeFromOtherOs(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return process.platform === "win32"
    ? posix.isAbsolute(value)
    : win32.isAbsolute(value) && win32.parse(value).root.length > 1;
}

const GLOBAL_MAP_KEYS = CONFIG_REGISTRY.filter((def) => def.scope !== "profile").map((d) => d.key);
const PROFILE_MAP_KEYS = CONFIG_REGISTRY.filter((def) => def.scope !== "global").map((d) => d.key);
/** The default profile's proxy knobs are the global map (what `--set` writes without `--profile`),
 *  so its section admits the profile keys alone: an override there could be removed by no command. */
const DEFAULT_SECTION_KEYS = CONFIG_REGISTRY.filter((def) => def.scope === "profile").map((d) =>
  d.key
);

/** A present key the lenient schema turned into undefined is a rejection here. */
function rejectInvalidValues(
  values: Record<string, unknown>,
  parsed: Record<string, unknown>,
  path: string,
): void {
  for (const key of Object.keys(values)) {
    if (values[key] !== undefined && parsed[key] === undefined) {
      const def = configKeyDef(key);
      throw bundleError(
        `${path}.${key} is invalid (expected: ${def?.describe ?? "a valid value"})`,
      );
    }
  }
}

/** Values are validated by the store's own schemas (env_config owns every value shape, so new keys
 *  are accepted here automatically); their lenient fallback is made strict by rejecting any
 *  present key a schema turned into undefined. */
function parseGlobalSection(raw: unknown): { global: GlobalConfigData; skipped: string[] } {
  const doc = requireRecord(raw, "config.global");
  rejectUnknownKeys(doc, GLOBAL_MAP_KEYS, "config.global");
  // The redaction marker is admitted ONLY on the credential-bearing keys, and kept
  // aside: the store's domain would (rightly) reject it as a value.
  const redacted: GlobalConfigData = {};
  const values = { ...doc };
  for (const key of CREDENTIAL_BEARING_PREFS) {
    if (values[key] === REDACTED_TOKEN) {
      redacted[key] = REDACTED_TOKEN;
      delete values[key];
    }
  }
  const skipped: string[] = [];
  let parsed = v.parse(GLOBAL_CONFIG_SCHEMA, values);
  if (parsed["codex.home"] === undefined && codexHomeFromOtherOs(values["codex.home"])) {
    skipped.push(
      `codex.home "${
        values["codex.home"]
      }" is not a path on this OS; skipped, set it here with agent config`,
    );
    delete values["codex.home"];
    parsed = v.parse(GLOBAL_CONFIG_SCHEMA, values);
  }
  rejectInvalidValues(values, parsed, "config.global");
  return { global: { ...parsed, ...redacted }, skipped };
}

/** Section names are the default's own key or a valid profile name; the name itself is untrusted
 *  input, so an invalid one is not echoed. */
function parseProfileSettingsSection(raw: unknown): Record<string, ProfileConfigData> {
  const doc = requireRecord(raw, "config.profiles");
  const out: Record<string, ProfileConfigData> = {};
  for (const [name, sectionRaw] of Object.entries(doc)) {
    if (name !== PROFILE_SETTINGS_DEFAULT_KEY && !isValidProfileName(name)) {
      throw bundleError(
        "config.profiles carries an invalid profile name (want `default` or 1-32 chars of [a-z0-9-], non-reserved)",
      );
    }
    const path = `config.profiles.${name}`;
    const section = requireRecord(sectionRaw, path);
    rejectUnknownKeys(
      section,
      name === PROFILE_SETTINGS_DEFAULT_KEY ? DEFAULT_SECTION_KEYS : PROFILE_MAP_KEYS,
      path,
    );
    const parsed = v.parse(PROFILE_CONFIG_SCHEMA, section);
    rejectInvalidValues(section, parsed, path);
    out[name] = parsed;
  }
  return out;
}

function parseConfigSection(
  raw: unknown,
): { config: CopilotEnvConfigData; skipped: string[] } {
  const doc = requireRecord(raw, "config");
  rejectUnknownKeys(doc, ["global", "profiles"], "config");
  const { global, skipped } = parseGlobalSection(doc.global);
  return { config: { global, profiles: parseProfileSettingsSection(doc.profiles) }, skipped };
}

function parseCredentialSection(raw: unknown): ProfileCredentialData {
  const doc = requireRecord(raw, "credential");
  rejectUnknownKeys(doc, CREDENTIAL_KEYS, "credential");
  return parseCredentialFields(doc, "credential");
}

function parseProfilesSection(raw: unknown): Record<string, ProfileSlotData> {
  const doc = requireRecord(raw, "profiles");
  const out: Record<string, ProfileSlotData> = {};
  for (const [name, slotRaw] of Object.entries(doc)) {
    if (!isValidProfileName(name)) {
      // The name itself is untrusted input, so it is not echoed either.
      throw bundleError(
        "profiles carries an invalid profile name (want 1-32 chars of [a-z0-9-], non-reserved)",
      );
    }
    const path = `profiles.${name}`;
    const slot = requireRecord(slotRaw, path);
    rejectUnknownKeys(slot, PROFILE_SLOT_KEYS, path);
    out[name] = {
      ...parseCredentialFields(slot, path),
      mode: parseNullableEnum(slot.mode, PROFILE_MODES, `${path}.mode`),
    };
  }
  return out;
}

function parseModesSection(raw: unknown): { codex: AgentProviderMode; claude: AgentProviderMode } {
  const doc = requireRecord(raw, "modes");
  rejectUnknownKeys(doc, ["codex", "claude"], "modes");
  const parseMode = (value: unknown, path: string): AgentProviderMode => {
    const hit = AGENT_PROVIDER_MODES.find((m) => m === value);
    if (hit === undefined) {
      throw bundleError(`${path} must be one of ${AGENT_PROVIDER_MODES.join("|")}`);
    }
    return hit;
  };
  const modes = {
    codex: parseMode(doc.codex, "modes.codex"),
    claude: parseMode(doc.claude, "modes.claude"),
  };
  // The default is a profile: one mode for both agents. Two managed modes cannot land, so a bundle
  // carrying them is refused before any store or file is written (the single-agent writes would
  // refuse the second anyway, after the first landed).
  const managed = [modes.codex, modes.claude].filter((m) => m === "direct" || m === "proxy");
  if (managed.length === 2 && managed[0] !== managed[1]) {
    throw bundleError(
      `modes names ${modes.codex} for Codex and ${modes.claude} for Claude; the default profile ` +
        "is one mode for both agents",
    );
  }
  return modes;
}

const BUNDLE_KEYS = ["formatVersion", "config", "credential", "profiles", "modes"] as const;

/** An unknown `formatVersion` is rejected with its own message: the one deliberate
 *  compatibility gate. */
export function parseSettingsBundle(raw: unknown): SettingsBundle {
  if (!isRecord(raw)) {
    throw new Error("not a settings bundle (expected a JSON object)");
  }
  if (raw.formatVersion !== SETTINGS_BUNDLE_FORMAT_VERSION) {
    throw new Error(
      "unsupported settings bundle formatVersion - this copilot-env reads " +
        `version ${SETTINGS_BUNDLE_FORMAT_VERSION}`,
    );
  }
  rejectUnknownKeys(raw, BUNDLE_KEYS, "the bundle root");
  const config = parseConfigSection(raw.config);
  return {
    formatVersion: SETTINGS_BUNDLE_FORMAT_VERSION,
    config: config.config,
    credential: parseCredentialSection(raw.credential),
    profiles: parseProfilesSection(raw.profiles),
    modes: parseModesSection(raw.modes),
    skippedConfig: config.skipped,
  };
}

// --- import planning --------------------------------------------------------
//
// The import is ONE plan computed up front (every slot's landing, the default modes, the exact
// writes); the confirmation summary and the apply both execute that plan, so the prompt cannot
// describe a landing the apply would not perform. Its `writes` lines are overwrite-only
// (planWrites), so a bundle preference with no local counterpart lands without a line. The gh CLI
// is probed once per pinned account (ghUser; null is gh's active account) per import.

/** Import test seams, threaded through to the wiring layers untouched.
 *  `ghAuthToken` substitutes the gh CLI token probe so gh-cli slot handling is
 *  testable without spawning the machine's real `gh`. */
export interface ImportDeps {
  catalogDeps?: CodexCatalogDeps;
  ghAuthToken?: typeof ghAuthToken;
}

/** What applyImportPlan did, for the command layer to render. */
export interface ImportOutcome {
  /** Both agents' modes after the default re-derivation, or null when neither
   *  agent was written (nothing managed in the bundle, or all slots skipped). */
  modes: { codex: AgentProviderMode; claude: AgentProviderMode } | null;
  /** Named profiles fully restored (credential + mode + both agents wired). */
  wiredProfiles: ProfileName[];
  /** Human-readable reasons for slots/wiring intentionally left alone. */
  skipped: string[];
  /** Wiring failures, default or per-profile (the import continued past them;
   *  the command layer exits non-zero on any). */
  failures: string[];
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
      reason: "the bundle relies on the gh CLI login, which does not resolve a token on this " +
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
  skipped: string[],
): ManagedAgentMode | null {
  if (mode === "none") return null;
  if (mode === "other") {
    skipped.push(`${label} wiring: the bundle recorded an unmanaged provider - left untouched`);
    return null;
  }
  if (mode === "direct" && !defaultUsable) {
    skipped.push(
      `${label} direct wiring: no credential resolves for the default slot - run ` +
        "`agent auth`, then `agent init --direct`",
    );
    return null;
  }
  return mode;
}

/** One profile's parsed bundle slot plus its planned landing. */
interface PlannedProfile {
  name: ProfileName;
  slot: ProfileSlotData;
  landing: SlotPlan;
}

/** The complete import plan: what lands where, what gets wired, what gets
 *  skipped (and why), and every write the apply will perform. */
export interface ImportPlan {
  bundle: SettingsBundle;
  defaultSlot: SlotPlan;
  /** Per-agent default modes the apply will write (null = leave alone). */
  modes: { codex: ManagedAgentMode | null; claude: ManagedAgentMode | null };
  profiles: PlannedProfile[];
  /** Skip messages, decided here so the summary and the apply agree. */
  skipped: string[];
  /** Confirmation lines from planWrites: what the apply OVERWRITES, not all it writes. */
  writes: string[];
}

// PLAN-INPUT RULE for planWrites: everything read there is either apply-immutable (env, homes,
// the pre-import store content described as overwritten) or resolved as its POST-import value
// when the apply mutates it before the writers read it. wire-mcp is resolved post-import (the
// preference store is replaced before the Claude writer consults it); codex-model-catalog is
// covered by the default-Codex line's unconditional "may rewrite" hedge.

/**
 * The lines name what the apply OVERWRITES locally, never everything it writes. The file list
 * mirrors what the wiring writers touch (configureClaudeConfig / applyCodexConfig /
 * wireBothAgents); they expose no dry run to derive it from, so the mapping lives here beside
 * the plan.
 *
 *   no locally stored pref key       -> no line; the bundle's preferences still land
 *   skipped slot, or an empty one    -> no line
 *   catalog sync's host-config sweep -> one summary line, the set is dynamic
 */
function planWrites(
  bundle: SettingsBundle,
  defaultSlot: SlotPlan,
  modes: ImportPlan["modes"],
  profiles: PlannedProfile[],
): string[] {
  const lines: string[] = [];
  const prefs = new CopilotEnvConfig().read();
  // Preferences are full-replace: every locally stored key, global or per profile, is rewritten or
  // reset, except one the bundle redacted, which keeps the local value like a redacted token.
  const storedPrefKeys = [
    ...GLOBAL_MAP_KEYS.filter(
      (key) => prefs.global[key] !== undefined && !isRedactedPref(bundle.config, key),
    ),
    ...Object.entries(prefs.profiles).flatMap(([name, section]) =>
      setKeys(section).map((key) => `${key} [${name}]`)
    ),
  ];
  if (storedPrefKeys.length > 0) {
    lines.push(`preferences (${storedPrefKeys.join(", ")})`);
  }
  const local = new CopilotEnvState().read();
  if (
    defaultSlot.action === "write" &&
    (local.githubToken !== null || local.authProvider !== null)
  ) {
    lines.push(`the default credential (${local.authProvider ?? "token only"})`);
  }
  const overwritten = profiles
    .filter((p) => p.landing.action === "write" && Object.hasOwn(local.profiles, p.name))
    .map((p) => p.name);
  if (overwritten.length > 0) {
    lines.push(`profile slot${overwritten.length === 1 ? "" : "s"}: ${overwritten.join(", ")}`);
  }
  // A mode-less bundle slot landing a credential on a local Direct profile rebakes it too
  // (importProfiles), so its files are named like a mode-bearing one's.
  const wired = profiles.filter((p) =>
    p.landing.action !== "skip" &&
    (p.slot.mode !== null ||
      (p.landing.action === "write" && Object.hasOwn(local.profiles, p.name) &&
        local.profiles[p.name]?.mode === "direct"))
  );
  // Named-profile wiring writes its provider table into config.toml and its selector into
  // `<name>.config.toml` of the effective home. The apply replaces the preference store before it
  // wires, so the home is resolved under the BUNDLE's codex-home and codex-host values, not the
  // local ones.
  const homePrefs = codexHomePrefsFor(bundle.config.global);
  const profileCodexHome = effectiveCodexHomeFor(homePrefs);
  if (modes.codex !== null) {
    // Post-import resolution (the plan-input rule): the farm decision is the SAME one the apply
    // takes, so its action and landing can be named.
    const farm = codexHostFarm(homePrefs);
    const plan = planCodexHostFarm(homePrefs.hostFarm, farm);
    if (plan.action === "build") lines.push(`Per-host CODEX_HOME farm (built): ${farm.hostHome}`);
    if (plan.action === "remove") {
      lines.push(`Per-host CODEX_HOME farm (removed): ${farm.hostHome}`);
    }
    if (plan.action === "leave") {
      lines.push(`Per-host CODEX_HOME farm path (left alone, not proven ours): ${farm.hostHome}`);
    }
    // The catalog sync may rewrite other host configs and the generated catalog file; the set is
    // dynamic, so one honest line beats an enumeration that would go stale.
    lines.push(
      `Codex config: ${codexConfigPath(profileCodexHome)} (the model-catalog sync may rewrite ` +
        "other known host configs and the generated catalog file)",
    );
  } else if (wired.length > 0) {
    lines.push(`Codex config: ${codexConfigPath(profileCodexHome)}`);
  }
  const claudeHome = resolveClaudeHome();
  if (modes.claude !== null) {
    lines.push(`Claude settings: ${settingsPathFor(claudeHome)}`);
    // Post-import resolution: the bundle's claude.wire-mcp (else the default) decides, the same
    // stored-else-default precedence wireMcpResolved applies to the store this import creates.
    const wireMcp = bundle.config.global["claude.wire-mcp"] ??
      configDefaultBoolean("claude.wire-mcp");
    if (modes.claude === "direct" && wireMcp) {
      lines.push(`Claude MCP registration (+ WebSearch deny): ${claudeJsonPath()}`);
    }
  }
  for (const p of wired) {
    lines.push(`Codex profile config: ${codexProfileConfigPath(profileCodexHome, p.name)}`);
    lines.push(`Claude profile settings: ${settingsPathFor(claudeHome, p.name)}`);
  }
  return lines;
}

/** Compute the whole import plan against the CURRENT stores (one gh probe per
 *  pinned account, memoized, shared by every gh-cli slot and reused by the apply). */
/** How far an import reaches. The whole store lands the default's credential and wiring; one
 *  named profile's bundle (`agent profile <name> settings --import`) never touches the default,
 *  so the default's rebake rules below stay off for it. */
export interface ImportScope {
  defaultWiring: boolean;
}

export function planImport(
  bundle: SettingsBundle,
  deps: ImportDeps = {},
  scope: ImportScope = { defaultWiring: true },
): ImportPlan {
  const ghTokens = new Map<string | null, string | null>();
  const gh = (ghUser: string | null): string | null => {
    let token = ghTokens.get(ghUser);
    if (token === undefined) {
      token = (deps.ghAuthToken ?? ghAuthToken)(ghUser);
      ghTokens.set(ghUser, token);
    }
    return token;
  };
  const skipped: string[] = [...(bundle.skippedConfig ?? [])];
  const defaultSlot = planSlotCredential(bundle.credential, null, gh);
  if (defaultSlot.action === "skip" && bundle.credential.authProvider !== null) {
    // Only a slot the bundle carried is an event; skipped wiring gets its own importableMode
    // message.
    skipped.push(`default credential: ${defaultSlot.reason}; run \`agent auth\``);
  }
  const defaultUsable = defaultSlot.action !== "skip";
  const modes = {
    codex: importableMode(bundle.modes.codex, "Codex", defaultUsable, skipped),
    claude: importableMode(bundle.modes.claude, "Claude", defaultUsable, skipped),
  };
  const profiles: PlannedProfile[] = [];
  const state = new CopilotEnvState();
  const recorded = state.readProfileSlot(null).mode;
  // The default is one mode for both agents, decided at PLAN time so planWrites names every file
  // the apply touches and the outcome reports both agents. Three bundles land BOTH agents:
  //   NO default wiring (`none` for both, never a skipped or unmanaged mode) on a recorded Direct
  //   default whose pair will not be stored at apply time -> rebakes both, as a named profile's
  //   slot does below (importProfiles): a landing is where the pair is probed and stored;
  //   one managed mode on a default with no record -> the first landing wires both;
  //   one Direct agent on a recorded Direct default whose pair will not be stored -> the one-agent
  //   write would land both anyway (runAgentConfig): decided here, so the preview names the other
  //   agent's file too.
  // "Not stored at apply time" is the apply's own test (runAgentConfig's directPairIncomplete: a half
  // is present when stored OR covered by the pin or literal in force), judged here under the overlay
  // the BUNDLE puts in force (the apply replaces the preferences before it wires, so the local ones
  // would answer for the wrong document), plus the one fact only the plan knows: this import lands
  // the default credential, whose write takes the pair with it.
  const named = modes.codex ?? modes.claude;
  const oneNamed = named !== null && (modes.codex === null) !== (modes.claude === null);
  /** A landing overrides a skip line for the OTHER agent (an unmanaged or gated mode there): the
   *  write sets the mode both agents share, so the line says what lands instead. A plain `none`
   *  for that agent is no event and gets no line. */
  const landBoth = (mode: ManagedAgentMode, why: string): void => {
    const other = modes.codex === null ? "Codex" : "Claude";
    const overridden = skipped.findIndex((line) => line.startsWith(`${other} `));
    if (overridden !== -1) {
      skipped.splice(overridden, 1, `${other} wiring: ${why} (one mode for both)`);
    }
    modes.codex = mode;
    modes.claude = mode;
  };
  const pairUnstored = scope.defaultWiring && recorded === "direct" &&
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
  for (const [rawName, slot] of Object.entries(bundle.profiles)) {
    const name = parseProfileName(rawName);
    let landing = planSlotCredential(slot, name, gh);
    if (
      landing.action === "write" && slot.mode === null &&
      !state.profileSlotStatus(name).exists
    ) {
      // A credential with no mode can only RE-AUTH an existing profile; with none here, writing
      // it would create the half profile the atomic slot commit exists to prevent.
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
  return {
    bundle,
    defaultSlot,
    modes,
    profiles,
    skipped,
    writes: planWrites(bundle, defaultSlot, modes, profiles),
  };
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
      // No mode: a re-auth. planImport skipped the no-profile case; the store's own guard still
      // fires if a concurrent --del raced the plan, hence the try. A complete Direct slot is rebaked
      // with a fresh selection, as `agent profile <name> auth` does: the credential write took the
      // previous pair with it, and the Desktop reconcile below renders the slot's pair.
      if (landing.action === "write") {
        try {
          state.setCredential(name, landing.credential);
          const landed = state.readProfileSlot(name);
          if (landed.kind === "complete" && landed.mode === "direct") {
            await wireBothAgents(name, "direct", false, "probe", landing.resolvedToken);
            outcome.wiredProfiles.push(name);
          }
        } catch (e) {
          outcome.failures.push(`profile '${name}': ${errMessage(e)}`);
        }
      }
      continue;
    }
    const credential = landing.action === "write"
      ? landing.credential
      : keptCredential(state, name);
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
      outcome.failures.push(`profile '${name}': ${errMessage(e)}`);
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
  deps: ImportDeps = {},
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
      bothAgents(deps.catalogDeps),
    );
    outcome.modes = { codex, claude };
    outcome.failures.push(...failures);
  }
  await importProfiles(plan, outcome);
  // The imported `claude.desktop` preference lands even when no wiring was re-derived.
  await reconcileClaudeDesktopWiring();
  return outcome;
}

/** Plan + apply in one call, for callers that need no confirmation step between the two
 *  (`agent settings` plans first to render the prompt, then applies that same plan). */
export async function applyImportBundle(
  bundle: SettingsBundle,
  deps: ImportDeps = {},
): Promise<ImportOutcome> {
  return applyImportPlan(planImport(bundle, deps), deps);
}

// --- pre-import backups -------------------------------------------------------

/** The rollback invocation, path quoted for THIS machine's shell. */
export function rollbackCommand(backupPath: string): string {
  const quoted = process.platform === "win32"
    ? quotePowerShell(backupPath)
    : quotePosix(backupPath);
  return `agent settings --import ${quoted}`;
}

/** Directory (under the ROOT home) holding the pre-import settings backups. */
export const SETTINGS_BACKUP_DIR_NAME = "settings-backups";

/** How many backups survive a prune. Each backup holds plaintext tokens, so
 *  the pile is bounded instead of accumulating forever. */
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
 *  the one credential-bearing preference. */
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
