// Claude Code sends the model it resolved verbatim, and Copilot answers an id outside its catalog
// with an empty result on every turn while the Direct wiring still probes fine. The launcher warns
// once and never writes a model: the saved choice stays the user's.
import { homedir } from "node:os";
import { join, sep } from "node:path";
import type { ManagedAgentMode } from "../agents/provider_mode.ts";
import { DEFAULT_COPILOT_API_BASE as DIRECT_BASE_URL } from "../copilot_api/integration_identity.ts";
import {
  type CatalogModel,
  cheapestClaudeModel,
  claudeCatalogRows,
  generateAliases,
  ONE_M_SUFFIX,
} from "../copilot_api/models.ts";
import { readTextOrNull } from "../utils/fs.ts";
import { isRecord, parseJsonRecord, readStringField } from "../utils/json.ts";
import { WIN } from "./paths.ts";
import { parseLoopbackProxyUrl } from "../copilot_api/port.ts";
import type { Profile } from "../copilot_api/profile.ts";

const MODEL_ENV = "ANTHROPIC_MODEL";

/** One parsed settings layer; `label` is what the warning names, `path` is absent for an inline
 *  `--settings` document. */
export interface SettingsLayer {
  label: string;
  path?: string;
  doc: Record<string, unknown>;
}

/**
 * Precedence verified against Claude Code 2.1.258 with a capture server recording the model each
 * launch sent. Later layers win per key; a blank env value in a winning layer reads as unset.
 *   --model  >  ANTHROPIC_MODEL (settings env blocks over the process env)  >  merged `model`  >  built-in default
 *   user ~/.claude/settings.json < project <cwd>/.claude/settings.json < local <cwd>/.claude/settings.local.json < --settings (file or inline JSON, last flag wins) < managed-settings.json
 *   --setting-sources user,project,local keeps only the named file layers; aliases (opus, sonnet, haiku, opusplan) are trimmed and lowercased; `[1m]` is stripped before the request
 */
export function claudeSettingsLayers(
  args: readonly string[],
  opts: { claudeHome: string; projectDir: string; managedPath: string },
): SettingsLayer[] {
  const layers: SettingsLayer[] = [];
  const fileLayer = (path: string): void => {
    const text = readTextOrNull(path);
    const doc = text === null ? null : parseJsonRecord(text);
    if (doc !== null) layers.push({ label: displayPath(path), path, doc });
  };
  const sources = lastFlagValue(args, "--setting-sources")?.split(",").map((s) => s.trim()) ??
    ["user", "project", "local"];
  if (sources.includes("user")) fileLayer(join(opts.claudeHome, "settings.json"));
  if (sources.includes("project")) fileLayer(join(opts.projectDir, ".claude", "settings.json"));
  if (sources.includes("local")) {
    fileLayer(join(opts.projectDir, ".claude", "settings.local.json"));
  }
  const flag = lastFlagValue(args, "--settings");
  if (flag !== null) {
    if (flag.trimStart().startsWith("{")) {
      const doc = parseJsonRecord(flag);
      if (doc !== null) layers.push({ label: "--settings", doc });
    } else {
      fileLayer(flag);
    }
  }
  fileLayer(opts.managedPath);
  return layers;
}

/** Claude Code's managed (policy) settings file, the top layer; the paths its 2.1.258 binary holds. */
export function managedSettingsPath(): string {
  if (WIN) return "C:\\Program Files\\ClaudeCode\\managed-settings.json";
  if (process.platform === "darwin") {
    return "/Library/Application Support/ClaudeCode/managed-settings.json";
  }
  return "/etc/claude-code/managed-settings.json";
}

/** The last occurrence wins, as it does for Claude Code's own parser; `--flag=value` counts. Like
 *  that parser the scan stops at `--` (everything after is the prompt) and steps over the plain
 *  value an unrelated option consumes. A flag-shaped value (`--append-system-prompt '--x'`) needs
 *  Claude's option table to tell apart and is read as a flag here. */
function lastFlagValue(args: readonly string[], flag: string): string | null {
  let value: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--") break;
    if (arg === flag) value = args[i + 1] ?? null;
    else if (arg.startsWith(`${flag}=`)) value = arg.slice(flag.length + 1);
    if (arg.startsWith("-") && !arg.includes("=") && !(args[i + 1] ?? "-").startsWith("-")) i++;
  }
  return value;
}

/** What the session authenticates with, or null when it is not a credential copilot-env can fetch
 *  the catalog with. Claude Code prefers an env token to the helper, so a baked (static-key) or
 *  inherited ANTHROPIC_AUTH_TOKEN is used AS-IS even when the store has since moved on; with no
 *  token the layer naming `apiKeyHelper` must be the launch's own file, whose helper serves the
 *  store's credential for `profile`. An ANTHROPIC_API_KEY (x-api-key, not bearer) is not ours. */
export type SessionCredential =
  | { kind: "token"; token: string }
  | { kind: "store"; profile: Profile };

export function sessionCredential(
  layers: readonly SettingsLayer[],
  env: SessionEnv,
  ownSettings: string,
  profile: Profile,
): SessionCredential | null {
  const token = env.values.ANTHROPIC_AUTH_TOKEN;
  if (token !== undefined) return { kind: "token", token };
  if (env.values.ANTHROPIC_API_KEY !== undefined) return null;
  let helperLayer: SettingsLayer | undefined;
  for (const layer of layers) {
    if (readStringField(layer.doc, "apiKeyHelper") !== null) helperLayer = layer;
  }
  return helperLayer?.path === ownSettings ? { kind: "store", profile } : null;
}

/** The env Claude Code runs under: its settings env blocks laid over the process env, blank values
 *  removed. The base URL and the baked headers are read from here too, so the check judges the
 *  endpoint the session really uses. `sources` names the layer that set a key; absent = the
 *  process env. */
export interface SessionEnv {
  values: Record<string, string>;
  sources: Record<string, string>;
}

/** Windows env names are case-insensitive (`$env:anthropic_model` reads as ANTHROPIC_MODEL), so
 *  every key is stored upper-case there. */
function envKey(key: string): string {
  return WIN ? key.toUpperCase() : key;
}

export function sessionEnv(
  layers: readonly SettingsLayer[],
  processEnv: Record<string, string | undefined>,
): SessionEnv {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(processEnv)) {
    if (value !== undefined && value !== "") values[envKey(key)] = value;
  }
  const sources: Record<string, string> = {};
  for (const layer of layers) {
    if (!isRecord(layer.doc.env)) continue;
    for (const [rawKey, value] of Object.entries(layer.doc.env)) {
      if (typeof value !== "string") continue;
      const key = envKey(rawKey);
      if (value === "") {
        delete values[key];
        delete sources[key];
      } else {
        values[key] = value;
        sources[key] = layer.label;
      }
    }
  }
  return { values, sources };
}

/** Where the session's requests go, by mode: Copilot's host for Direct, a loopback proxy port for
 *  proxy. Null = another endpoint (a gateway of the user's own), not ours to judge. */
export function sessionEndpoint(
  env: SessionEnv,
  mode: ManagedAgentMode,
): { mode: "direct" } | { mode: "proxy"; port: string } | null {
  const baseUrl = env.values.ANTHROPIC_BASE_URL;
  if (baseUrl === undefined) return null;
  if (mode === "direct") return baseUrl === DIRECT_BASE_URL ? { mode } : null;
  const loopback = parseLoopbackProxyUrl(baseUrl);
  return loopback === null ? null : { mode, port: loopback.port };
}

/** `ANTHROPIC_CUSTOM_HEADERS` as Claude Code sends it: one `Name: value` per line. */
export function sessionHeaders(env: SessionEnv): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of (env.values.ANTHROPIC_CUSTOM_HEADERS ?? "").split("\n")) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name !== "" && value !== "") headers[name] = value;
  }
  return headers;
}

/** `--model` is the user's own call and is never judged; the built-in default is one copilot-env
 *  cannot know. */
export type ClaudeModelChoice =
  | { kind: "user-supplied" }
  | { kind: "known"; model: string; source: string }
  | { kind: "builtin" };

export function claudeModelChoice(
  args: readonly string[],
  layers: readonly SettingsLayer[],
  env: SessionEnv,
): ClaudeModelChoice {
  if (lastFlagValue(args, "--model") !== null) return { kind: "user-supplied" };
  const fromEnv = env.values[MODEL_ENV];
  if (fromEnv !== undefined) {
    const layer = env.sources[MODEL_ENV];
    const source = layer === undefined ? `$${MODEL_ENV}` : `env.${MODEL_ENV} in ${layer}`;
    return { kind: "known", model: fromEnv, source };
  }
  let choice: ClaudeModelChoice = { kind: "builtin" };
  for (const layer of layers) {
    const model = readStringField(layer.doc, "model");
    if (model !== null) {
      choice = model === "" ? { kind: "builtin" } : { kind: "known", model, source: layer.label };
    }
  }
  return choice;
}

/** The family each short alias runs as; `opusplan` is Sonnet outside plan mode. Upstream contracts. */
const ALIAS_FAMILY = new Map([
  ["opus", "opus"],
  ["sonnet", "sonnet"],
  ["haiku", "haiku"],
  ["opusplan", "sonnet"],
]);

function stripOneM(model: string): string {
  return model.endsWith(ONE_M_SUFFIX) ? model.slice(0, -ONE_M_SUFFIX.length) : model;
}

/** Claude Code strips `[1m]` before the request, so the bare value is what the endpoint judges. */
function servable(
  model: string,
  catalog: CatalogModel[],
  mode: ManagedAgentMode,
  env: SessionEnv,
): boolean {
  const bare = stripOneM(model.trim());
  const family = ALIAS_FAMILY.get(bare.toLowerCase());
  if (family !== undefined) {
    // ANTHROPIC_DEFAULT_<FAMILY>_MODEL repoints the alias at an exact id.
    const pinned = env.values[`ANTHROPIC_DEFAULT_${family.toUpperCase()}_MODEL`];
    if (pinned !== undefined) return idServable(stripOneM(pinned.trim()), catalog, mode);
    return claudeCatalogRows(catalog).some((r) => r.family === family);
  }
  return idServable(bare, catalog, mode);
}

/** The proxy resolves every generated alias (dash forms, claude-latest); Direct resolves nothing. */
function idServable(bare: string, catalog: CatalogModel[], mode: ManagedAgentMode): boolean {
  if (catalog.some((m) => m.id === bare)) return true;
  return mode === "proxy" && Object.hasOwn(generateAliases(catalog), bare);
}

function displayPath(path: string): string {
  const home = homedir();
  return path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

/** The warning is one ASCII stderr line whatever a settings file held. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").replace(/[^\x20-\x7e]/g, "?");
}

/** Null = the session's model is servable, or unknown with a catalog that can serve some Claude
 *  model. A user-supplied choice never reaches here: the caller skips the fetch. */
export function unservableClaudeModelWarning(
  choice: Exclude<ClaudeModelChoice, { kind: "user-supplied" }>,
  catalog: CatalogModel[],
  mode: ManagedAgentMode,
  env: SessionEnv,
): string | null {
  const suggestion = cheapestClaudeModel(catalog);
  if (choice.kind === "builtin") {
    return suggestion === null
      ? "WARN the Copilot catalog lists no Claude model, so Claude Code's built-in default model cannot be served"
      : null;
  }
  if (servable(choice.model, catalog, mode, env)) return null;
  const hint = suggestion === null ? "it lists no Claude model" : `try /model ${suggestion}`;
  return `WARN Claude model '${oneLine(choice.model)}' (from ${oneLine(choice.source)}) ` +
    `is not in the Copilot catalog; ${hint}`;
}
