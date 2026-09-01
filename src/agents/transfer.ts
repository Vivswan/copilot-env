// The `agent settings` export/import domain: one JSON bundle carrying every
// PORTABLE copilot-env setting, for moving a setup to another machine.
//
// Portable state is exactly the two account-wide stores -- the preferences
// (`.copilot-env-config.json`, CopilotEnvConfig) and the credential store
// (`.copilot-env-state.json`, CopilotEnvState: default credential + named
// profile slots). Everything else is DERIVED or machine-local and is re-derived
// on import, never copied: agent config files, helper scripts, daemon homes,
// port reservations, the Codex catalog cache fields (`codexCatalog*`), and the
// WebSearch-deny ownership paths (they name THIS machine's settings files).
//
// Import is NON-destructive toward the target machine: profiles that exist only
// here are preserved, a bundle mode of "none" leaves that agent's wiring alone,
// and a slot whose credential would not resolve after the import is skipped
// whole (ask, never silently break a working setup). Proxy wiring is the one
// credential-independent write, exactly like `agent init --proxy` (the daemon
// acquires its own auth at `agent start`).
//
// Cross-agent by nature (import re-wires BOTH Codex and Claude), so it lives in
// src/agents/ beside wiring.ts and profile_wiring.ts.
import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import { claudeJsonPath } from "../claude/mcp_registration.ts";
import { resolveClaudeHome, settingsPathFor } from "../claude/paths.ts";
import type { CodexCatalogDeps } from "../codex/catalog.ts";
import { effectiveCodexHome } from "../codex/config.ts";
import { codexConfigPath } from "../codex/paths.ts";
import { Credential, ghAuthToken } from "../copilot_api/credential.ts";
import {
  CONFIG_REGISTRY,
  CONFIG_SCHEMA,
  configDefaultBoolean,
  type ConfigKey,
  type ConfigPatch,
  CopilotEnvConfig,
  type CopilotEnvConfigData,
  INTEGRATION_ID_RE,
} from "../copilot_api/env_config.ts";
import {
  AUTH_PROVIDERS,
  CopilotEnvState,
  PROFILE_MODES,
  type ProfileCredentialData,
  type ProfileSlotData,
} from "../copilot_api/env_state.ts";
import { resolveRootHome } from "../copilot_api/paths.ts";
import {
  isValidProfileName,
  parseProfileName,
  type Profile,
  type ProfileName,
} from "../copilot_api/profile.ts";
import { errMessage } from "../utils/error.ts";
import { isRecord } from "../utils/json.ts";
import { configureDefaultAgents } from "./configure_defaults.ts";
import { wireBothAgents } from "./profile_wiring.ts";
import {
  AGENT_PROVIDER_MODES,
  type AgentProviderMode,
  type ManagedAgentMode,
} from "./provider_mode.ts";
import { readAgentModesSafe } from "./wiring.ts";

/** The bundle format this copilot-env writes and reads; any other version is
 *  rejected outright (external contract). */
export const SETTINGS_BUNDLE_FORMAT_VERSION = 1;

/** Placeholder replacing every token in a credential-less export (the default).
 *  An external contract: import recognizes exactly this value as "not a token". */
export const REDACTED_TOKEN = "<redacted>";

/** One exported settings bundle (the `agent settings --export` JSON document). */
export interface SettingsBundle {
  formatVersion: typeof SETTINGS_BUNDLE_FORMAT_VERSION;
  /** Every STORED preference (unset keys are omitted; defaults never travel). */
  config: CopilotEnvConfigData;
  /** The default credential slot (token redacted unless `withCredentials`). */
  credential: ProfileCredentialData;
  /** Every named profile's store slot (tokens redacted the same way). */
  profiles: Record<string, ProfileSlotData>;
  /** Both agents' DEFAULT wiring at export time; import re-derives it. */
  modes: { codex: AgentProviderMode; claude: AgentProviderMode };
}

/** Copy `key` from the store read into the bundle's config section when set
 *  (generic so the per-key value type survives the assignment). */
function copyStoredPref<K extends ConfigKey>(
  from: CopilotEnvConfigData,
  to: CopilotEnvConfigData,
  key: K,
): void {
  const value = from[key];
  if (value !== undefined) to[key] = value;
}

/** Every stored preference, with unset keys omitted (defaults never travel). */
function storedPrefs(): CopilotEnvConfigData {
  const data = new CopilotEnvConfig().read();
  const out: CopilotEnvConfigData = {};
  for (const def of CONFIG_REGISTRY) copyStoredPref(data, out, def.key);
  return out;
}

/**
 * Build the export bundle from the current stores. Tokens are replaced by
 * REDACTED_TOKEN unless `withCredentials` -- redaction is the default so a
 * casually shared bundle never leaks a credential. The machine-local state
 * fields (`codexCatalog*`, `webSearchDenyOwnedPaths`, `claudeDesktopOwnedPaths`)
 * are never included.
 */
export function buildExportBundle(options: { withCredentials?: boolean } = {}): SettingsBundle {
  const withCredentials = options.withCredentials ?? false;
  const state = new CopilotEnvState().read();
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
    config: storedPrefs(),
    credential: { githubToken: redact(state.githubToken), authProvider: state.authProvider },
    profiles,
    // Safe read: a wiring-read failure must never abort an export (or an
    // unrelated import, via the pre-import backup). It collapses to "other",
    // which imports as "leave that agent alone" -- the right posture for
    // wiring we could not even read.
    modes: readAgentModesSafe(),
  };
}

/** The bundle as the on-disk/stdout JSON document (pretty, trailing newline). */
export function serializeSettingsBundle(bundle: SettingsBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

/** True when the bundle's STORES carry nothing: no stored preference, no
 *  default credential, no profiles. Deliberately silent about `modes` --
 *  wiring is derived state, so it matters to the import confirmation (which
 *  checks it separately) but not to backups (nothing to roll back). */
export function bundleIsEmpty(bundle: SettingsBundle): boolean {
  return (
    CONFIG_REGISTRY.every((def) => bundle.config[def.key] === undefined) &&
    bundle.credential.githubToken === null &&
    bundle.credential.authProvider === null &&
    Object.keys(bundle.profiles).length === 0
  );
}

// --- bundle parsing -------------------------------------------------------------
//
// A bundle is UNTRUSTED input (hand-carried between machines, possibly edited),
// so this is a strict parse boundary: unknown keys and malformed values are
// rejections -- never silently dropped or coerced to null the way the stores'
// own lenient read schemas would, because the full-replace import semantics
// would then quietly reset a local preference or wipe a credential. Error
// messages carry only text this parser owns: section paths, expected shapes,
// and profile names that already passed validation. No value and no unknown
// KEY name from the bundle is ever echoed (either could be a pasted token).

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

// The identity is interpolated into an HTTP header (Copilot-Integration-Id) by
// the config writers; INTEGRATION_ID_RE (env_config.ts, shared with the
// `integration-id` pin) is the single source of the header-safe token shape.
function parseNullableIdentity(value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !INTEGRATION_ID_RE.test(value)) {
    throw bundleError(
      `${path} must be a header-safe identity token (1-64 chars of [A-Za-z0-9._-]), or null`,
    );
  }
  return value;
}

/** The credential pair shared by the default slot and every profile slot. Two
 *  contradictions are rejected outright: a token without a provider could
 *  never resolve (resolution keys off `authProvider`), and a token WITH the
 *  gh-cli provider would sit ignored in the store (gh-cli holds no token of
 *  its own) until a later --with-credentials export exposed it. */
function parseCredentialFields(doc: Record<string, unknown>, path: string): ProfileCredentialData {
  const githubToken = parseNullableString(doc.githubToken, `${path}.githubToken`);
  const authProvider = parseNullableEnum(doc.authProvider, AUTH_PROVIDERS, `${path}.authProvider`);
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
  return { githubToken, authProvider };
}

const CREDENTIAL_KEYS = ["githubToken", "authProvider"] as const;
const PROFILE_SLOT_KEYS = [...CREDENTIAL_KEYS, "mode", "integrationIdentity"] as const;

/**
 * The config section: keys must be registry keys, and each present value must
 * satisfy the store's own per-key schema. The value validation deliberately
 * reuses CONFIG_SCHEMA (env_config owns every value shape, so new keys are
 * accepted here automatically); its lenient fallback is turned strict by
 * rejecting any present key the schema refused (fallback -> undefined) instead
 * of letting the full-replace import silently reset that preference.
 */
function parseConfigSection(raw: unknown): CopilotEnvConfigData {
  const doc = requireRecord(raw, "config");
  rejectUnknownKeys(
    doc,
    CONFIG_REGISTRY.map((def) => def.key),
    "config",
  );
  const parsed = v.parse(CONFIG_SCHEMA, doc);
  for (const def of CONFIG_REGISTRY) {
    if (doc[def.key] !== undefined && parsed[def.key] === undefined) {
      throw bundleError(`config.${def.key} is invalid (expected: ${def.describe})`);
    }
  }
  return parsed;
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
      integrationIdentity: parseNullableIdentity(
        slot.integrationIdentity,
        `${path}.integrationIdentity`,
      ),
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
  return {
    codex: parseMode(doc.codex, "modes.codex"),
    claude: parseMode(doc.claude, "modes.claude"),
  };
}

const BUNDLE_KEYS = ["formatVersion", "config", "credential", "profiles", "modes"] as const;

/**
 * Parse untrusted JSON into a SettingsBundle (strict; see the section comment
 * above). An unknown `formatVersion` is rejected with its own message -- the
 * one deliberate compatibility gate.
 */
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
  return {
    formatVersion: SETTINGS_BUNDLE_FORMAT_VERSION,
    config: parseConfigSection(raw.config),
    credential: parseCredentialSection(raw.credential),
    profiles: parseProfilesSection(raw.profiles),
    modes: parseModesSection(raw.modes),
  };
}

// --- import planning --------------------------------------------------------
//
// The import is computed as ONE plan up front -- every slot's landing, the
// default modes to write, and the exact store/file writes -- and both the
// confirmation summary and the apply execute that same plan. Modelling the
// writes once means the prompt can never claim (or miss) a write the apply
// would not (or would) perform, and the gh CLI is probed once per import.

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

/** Whether the bundle slot carries a credential the import could write: a real
 *  token, or the gh-cli provider (which holds no token by design). */
function bundleSlotWritesCredential(slot: ProfileCredentialData): boolean {
  if (slot.authProvider === "gh-cli") return true;
  return (
    slot.authProvider !== null && slot.githubToken !== null && slot.githubToken !== REDACTED_TOKEN
  );
}

/**
 * One slot's planned landing, judged on the RESULTING store slot:
 *   - write: the bundle's credential lands (a real token, or gh-cli once the
 *     local `gh` proved it resolves). `resolvedToken` is what that slot
 *     resolves to, handed to the wiring so nothing re-runs a resolver.
 *   - keep:  nothing usable travels -- the local slot survives untouched and
 *     ITS resolution decides wireability, so a redacted bundle over a working
 *     local credential still wires normally. A gh-cli slot whose `gh` does not
 *     resolve falls through to here for the same reason: gh failing only rules
 *     out the BUNDLE's credential, not the machine's.
 *   - skip:  nothing resolves at all; `reason` says why (with the gh hint when
 *     gh-cli was involved) and the apply writes nothing to the slot.
 */
type SlotPlan =
  | { action: "write"; credential: ProfileCredentialData; resolvedToken: string | null }
  | { action: "keep"; resolvedToken: string | null }
  | { action: "skip"; reason: string };

function localSlotToken(profile: Profile, gh: () => string | null): string | null {
  return new Credential(undefined, profile).resolve(gh);
}

function planSlotCredential(
  slot: ProfileCredentialData,
  profile: Profile,
  gh: () => string | null,
): SlotPlan {
  if (slot.authProvider === "gh-cli") {
    const ghToken = gh();
    if (ghToken !== null) {
      return {
        action: "write",
        credential: { githubToken: null, authProvider: "gh-cli" },
        resolvedToken: ghToken,
      };
    }
    const local = localSlotToken(profile, gh);
    if (local !== null) return { action: "keep", resolvedToken: local };
    return {
      action: "skip",
      reason: "the bundle relies on the gh CLI login, which does not resolve a token on this " +
        "machine (`gh auth login`), and no stored credential resolves either",
    };
  }
  if (bundleSlotWritesCredential(slot)) {
    return {
      action: "write",
      credential: { githubToken: slot.githubToken, authProvider: slot.authProvider },
      resolvedToken: slot.githubToken,
    };
  }
  const local = localSlotToken(profile, gh);
  if (local !== null) return { action: "keep", resolvedToken: local };
  return {
    action: "skip",
    reason: "the bundle carries no usable token and no stored credential resolves",
  };
}

/** The default wiring to write for one agent, or null to leave it alone:
 *  only managed modes are ours to write. Direct needs the default credential
 *  to resolve (its helper fetches the token at request time); proxy is written
 *  credential-free, exactly like `agent init --proxy` -- the daemon acquires
 *  its own auth at `agent start`. */
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
  /** Confirmation lines: every store section and file the apply writes. */
  writes: string[];
}

/**
 * The confirmation lines: every store section and config file the apply will
 * write, and nothing else -- a skipped slot produces no line, and preserved
 * local content appears only where it is actually overwritten. The file list
 * mirrors what the wiring writers touch (configureClaudeConfig /
 * applyCodexConfig / wireBothAgents); the writers expose no dry-run surface to
 * derive it from, so the mapping lives here, next to the plan it describes,
 * and dynamic sets (the catalog sync's host-config sweep) are summarized in
 * one honest line rather than enumerated stale.
 *
 * PLAN-INPUT RULE: everything read here must be either apply-immutable (env,
 * homes, the pre-import store content being described as overwritten) or
 * resolved as its POST-import value when the apply mutates it before the
 * writers read it. Two preferences gate the written file set: wire-mcp is
 * resolved post-import (the preference store is replaced before the Claude
 * writer consults it); codex-model-catalog is covered by the default-Codex
 * line's unconditional "may rewrite" hedge instead, so no write is ever missed.
 */
function planWrites(
  bundle: SettingsBundle,
  defaultSlot: SlotPlan,
  modes: ImportPlan["modes"],
  profiles: PlannedProfile[],
): string[] {
  const lines: string[] = [];
  const prefs = new CopilotEnvConfig().read();
  const storedPrefKeys = CONFIG_REGISTRY.filter((def) => prefs[def.key] !== undefined);
  if (storedPrefKeys.length > 0) {
    // Preferences are full-replace, so every locally stored key is rewritten
    // (or reset, when absent from the bundle).
    lines.push(`preferences (${storedPrefKeys.map((def) => def.cli).join(", ")})`);
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
  const wired = profiles.filter((p) => p.landing.action !== "skip" && p.slot.mode !== null);
  if (modes.codex !== null) {
    // The default write can reach beyond config.toml: direct wiring edits the
    // home's .env, and the catalog sync may rewrite other known host configs
    // and the generated model-catalog file. The exact set is dynamic, so one
    // honest summary line beats an enumeration that would go stale.
    lines.push(
      `Codex config: ${codexConfigPath(effectiveCodexHome())} (wiring may also clean its ` +
        ".env; the model-catalog sync may rewrite other known host configs and the " +
        "generated catalog file)",
    );
  } else if (wired.length > 0) {
    // Named-profile wiring writes its provider tables into the same config.toml, and its
    // writer may clean the home's .env too.
    lines.push(`Codex config: ${codexConfigPath(effectiveCodexHome())} (may also clean its .env)`);
  }
  const claudeHome = resolveClaudeHome();
  if (modes.claude !== null) {
    lines.push(`Claude settings (+ token helper script): ${settingsPathFor(claudeHome)}`);
    // POST-import resolution (the plan-input rule above): the apply replaces
    // the preference store BEFORE the Claude writer reads wire-mcp, so the
    // bundle's value (else the built-in default) decides -- the same
    // stored-else-default precedence as wireMcpResolved, against the store
    // this import is about to create.
    const wireMcp = bundle.config.wireMcp ?? configDefaultBoolean("wire-mcp");
    if (modes.claude === "direct" && wireMcp) {
      lines.push(`Claude MCP registration (+ WebSearch deny): ${claudeJsonPath()}`);
    }
  }
  for (const p of wired) {
    lines.push(
      `Claude profile settings (+ token helper script): ${settingsPathFor(claudeHome, p.name)}`,
    );
  }
  return lines;
}

/** Compute the whole import plan against the CURRENT stores (one gh probe,
 *  memoized, shared by every gh-cli slot and reused by the apply). */
export function planImport(bundle: SettingsBundle, deps: ImportDeps = {}): ImportPlan {
  let ghToken: string | null | undefined;
  const gh = (): string | null => {
    if (ghToken === undefined) ghToken = (deps.ghAuthToken ?? ghAuthToken)();
    return ghToken;
  };
  const skipped: string[] = [];
  const defaultSlot = planSlotCredential(bundle.credential, null, gh);
  if (defaultSlot.action === "skip" && bundle.credential.authProvider !== null) {
    // Only report a slot the bundle actually carried: an empty bundle
    // credential over an empty store is not an event, and any skipped wiring
    // still gets its own importableMode message.
    skipped.push(`default credential: ${defaultSlot.reason}; run \`agent auth\``);
  }
  const defaultUsable = defaultSlot.action !== "skip";
  const modes = {
    codex: importableMode(bundle.modes.codex, "Codex", defaultUsable, skipped),
    claude: importableMode(bundle.modes.claude, "Claude", defaultUsable, skipped),
  };
  const profiles: PlannedProfile[] = [];
  for (const [rawName, slot] of Object.entries(bundle.profiles)) {
    const name = parseProfileName(rawName);
    const landing = planSlotCredential(slot, name, gh);
    if (landing.action === "skip") {
      skipped.push(
        `profile '${name}': ${landing.reason} - not imported; run ` +
          `\`agent auth --profile ${name}\`, then \`agent profile --add ${name}\``,
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

/** Set `key` in a full-replace patch: the bundle's value, or null to delete
 *  (generic so the per-key value type survives the assignment). */
function restorePref<K extends ConfigKey>(
  patch: ConfigPatch,
  config: CopilotEnvConfigData,
  key: K,
): void {
  patch[key] = config[key] ?? null;
}

/** Replace the whole preference store with the bundle's `config` section: keys
 *  absent from the bundle revert to their defaults (restore, not merge -- safe
 *  because the strict parse already rejected junk instead of dropping it). */
function importPreferences(config: CopilotEnvConfigData): void {
  const patch: ConfigPatch = {};
  for (const def of CONFIG_REGISTRY) restorePref(patch, config, def.key);
  new CopilotEnvConfig().set(patch);
}

/**
 * Execute the profile half of the plan through the same atomic machinery
 * `agent profile --add` uses. A skipped slot was already reported at plan time
 * and writes nothing (never a half-updated slot). Per-profile resilient: one
 * failing profile never blocks the rest (mirrors `profile --sync`).
 *
 * Unlike the DEFAULT slot, a proxy-mode profile still requires a resolvable
 * credential: `agent profile --add` always ensures the profile's OWN
 * credential before wiring either mode (runAdd in src/commands/profile.ts), so
 * the import restores nothing weaker than what `--add` would create.
 */
async function importProfiles(plan: ImportPlan, outcome: ImportOutcome): Promise<void> {
  const state = new CopilotEnvState();
  for (const { name, slot, landing } of plan.profiles) {
    if (landing.action === "skip") continue;
    if (landing.action === "write") {
      state.setCredential(name, landing.credential);
      // The bundled identity is derived from the bundle's own credential, so
      // it is replayed ONLY when that exact token landed (letting a direct
      // profile wire without re-probing the network). gh-cli and kept slots
      // resolve a DIFFERENT credential here, so their identity is re-derived
      // by the normal probe at wire time instead of trusting the bundle's.
      if (landing.credential.githubToken !== null && slot.integrationIdentity !== null) {
        state.setProfileIntegrationIdentity(name, slot.integrationIdentity);
      }
    }
    if (slot.mode === null) continue;
    try {
      await wireBothAgents(name, slot.mode, false, landing.resolvedToken);
      // The store commit is LAST -- the success marker, exactly as `--add` does it.
      state.setProfileMode(name, slot.mode);
      outcome.wiredProfiles.push(name);
    } catch (e) {
      outcome.failures.push(`profile '${name}': ${errMessage(e)}`);
    }
  }
}

/**
 * Execute the plan: write both stores through their own classes, then
 * RE-DERIVE everything else -- the default agents through the same machinery
 * `agent init` uses (configureDefaultAgents) and each profile through the same
 * machinery `agent profile` uses (wireBothAgents). Every wiring path receives
 * the plan's already-resolved credential, so no resolver re-runs.
 */
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
      deps.catalogDeps,
    );
    outcome.modes = { codex, claude };
    outcome.failures.push(...failures);
  }
  await importProfiles(plan, outcome);
  return outcome;
}

/** Plan + apply in one call -- the whole-import entry for callers that need no
 *  confirmation step between the two (`agent settings` plans first to render
 *  the prompt, then applies that same plan). */
export async function applyImportBundle(
  bundle: SettingsBundle,
  deps: ImportDeps = {},
): Promise<ImportOutcome> {
  return applyImportPlan(planImport(bundle, deps), deps);
}

// --- pre-import backups -------------------------------------------------------

/** Directory (under the ROOT home) holding the pre-import settings backups. */
export const SETTINGS_BACKUP_DIR_NAME = "settings-backups";

/** How many backups survive a prune. Each backup holds plaintext tokens, so
 *  the pile is bounded instead of accumulating forever. */
export const SETTINGS_BACKUP_KEEP = 5;

export function settingsBackupDir(): string {
  return join(resolveRootHome(), SETTINGS_BACKUP_DIR_NAME);
}

const BACKUP_FILE_RE = /^settings-.*\.json$/;

// Appended to every backup filename after the millisecond timestamp: it
// uniquifies same-millisecond backups AND keeps the prune's lexicographic name
// sort chronological within one process (across processes the timestamp part
// already orders the names).
let backupSeq = 0;

/** Best-effort prune: keep only the newest SETTINGS_BACKUP_KEEP backups. */
function pruneSettingsBackups(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((name) => BACKUP_FILE_RE.test(name))
      .sort();
  } catch {
    return;
  }
  for (const name of names.slice(0, Math.max(0, names.length - SETTINGS_BACKUP_KEEP))) {
    try {
      rmSync(join(dir, name), { force: true });
    } catch {
      // best-effort: a stuck file only delays the next prune
    }
  }
}

/**
 * Write a full-fidelity backup of the CURRENT stores (credentials included --
 * a rollback without tokens is not a rollback; the file stays on this machine
 * in the same trust domain as the plaintext stores: dir 0700, file 0600 where
 * modes apply) and prune the pile to the newest SETTINGS_BACKUP_KEEP. Returns
 * the file path, or null when both stores are empty (nothing to roll back to;
 * wiring alone is re-derivable). Rolling back IS an import of the backup file:
 * it restores the STORE contents -- profiles a later import created are not
 * deleted by it, since import never deletes profiles.
 */
export function writeSettingsBackup(): string | null {
  const bundle = buildExportBundle({ withCredentials: true });
  if (bundleIsEmpty(bundle)) return null;
  const dir = settingsBackupDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdirSync's mode only applies on creation; a pre-existing looser dir must
  // still end up 0700 (it is about to hold plaintext tokens).
  if (process.platform !== "win32") chmodSync(dir, 0o700);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `settings-${stamp}-${String(++backupSeq).padStart(3, "0")}.json`);
  writeFileSync(path, serializeSettingsBundle(bundle), { mode: 0o600 });
  pruneSettingsBackups(dir);
  return path;
}
