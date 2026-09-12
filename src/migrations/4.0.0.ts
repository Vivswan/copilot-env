// Away from 4.0.0: 4.0.0's readers still tolerated the 3.5.6 shapes and today's know only the
// new ones, so these fix-ups convert what a 3.5.6-shaped install still carries. Each is
// idempotent, and a converted install reads back unchanged.
//
//   rc block with no end marker          -> fenced in place, body kept
//   `src/scripts/proxy-token.{sh,ps1}`   -> `agent proxy-token`
//   Claude apiKeyHelper as a helper FILE -> the inline command
//   autoupdate state's `enabled` field   -> the `auto-update` config key
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { consola } from "consola";
import { autoupdateStateFile } from "../autoupdate/paths.ts";
import { directHelperCommand, proxyHelperCommand } from "../claude/config.ts";
import { resolveClaudeHome, settingsPathFor, WIN } from "../claude/paths.ts";
import { managedProxyProvider } from "../codex/config.ts";
import { knownCodexHomes } from "../codex/host.ts";
import { CODEX_PROVIDER_ID, codexConfigPath } from "../codex/paths.ts";
import { readCodexToml, saveCodexToml } from "../codex/toml_io.ts";
import { CopilotApiConfig } from "../copilot_api/config.ts";
import {
  isValidProfileName,
  parseProfileName,
  type Profile,
  type ProfileName,
} from "../copilot_api/profile.ts";
import {
  LAUNCHERS_MARKER,
  LAUNCHERS_MARKER_END,
  MARKER,
  MARKER_END,
  shellTargetFiles,
} from "../shell/integration.ts";
import { errMessage } from "../utils/error.ts";
import { isEnoent, readTextResult } from "../utils/fs.ts";
import { chmodReported, removeReported, writeFileReported } from "../utils/report_write.ts";
import { isRecord, parseJsonRecord } from "../utils/json.ts";
import type { Migration } from "./index.ts";

/** Each file converts independently, but any file left unconverted fails the whole step, so
 *  the runner warns and names the re-run instead of reporting a clean pass over broken wiring. */
function failIfAny(failed: readonly string[]): void {
  if (failed.length === 0) return;
  throw new Error(`${failed.length} file(s) were not converted: ${failed.join(", ")}`);
}

// --- the shell rc block ----------------------------------------------------------

/** The [assignment, guard] pair every 3.5.6-or-older release (and the pre-TS installers) wrote
 *  under each rc marker, frozen here: how an UNFENCED block is bounded without eating user
 *  lines. Order matters: a lookalike in the guard position must not be consumed. Only the
 *  assignment VALUE varied, so assignments match on prefix; guards match whole, in both their
 *  spellings (with and without -LiteralPath). */
const UNFENCED_BLOCKS: Record<
  string,
  { end: string; pairs: readonly (readonly [RegExp, RegExp])[] }
> = {
  [MARKER]: {
    end: MARKER_END,
    pairs: [
      [/^AGENTS_BASHRC=/, /^\[ -f "\$AGENTS_BASHRC" \] && source "\$AGENTS_BASHRC"$/],
      [/^\$AgentsPs1 = /, /^if \(Test-Path (-LiteralPath )?\$AgentsPs1\) \{ \. \$AgentsPs1 \}$/],
    ],
  },
  [LAUNCHERS_MARKER]: {
    end: LAUNCHERS_MARKER_END,
    pairs: [
      [/^AGENTS_LAUNCHERS=/, /^\[ -f "\$AGENTS_LAUNCHERS" \] && source "\$AGENTS_LAUNCHERS"$/],
      [
        /^\$AgentsLaunchers = /,
        /^if \(Test-Path (-LiteralPath )?\$AgentsLaunchers\) \{ \. \$AgentsLaunchers \}$/,
      ],
    ],
  },
};
const FENCE_LINES: readonly string[] = [MARKER, MARKER_END, LAUNCHERS_MARKER, LAUNCHERS_MARKER_END];

/** An unfenced marker block whose two body lines are its release's pair gets the end fence
 *  inserted after the guard, so the current writer (fenced blocks only) refreshes or strips it
 *  like any other. Anything else is left byte-identical. CR-tolerant; the fence adopts the
 *  marker line's ending. */
export function fenceUnfencedBlocks(content: string): string {
  const lines = content.split("\n");
  const bare = (i: number): string | null =>
    i < lines.length ? (lines[i] ?? "").replace(/\r$/, "") : null;
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    out.push(line);
    const shape = UNFENCED_BLOCKS[bare(i) ?? ""];
    if (shape === undefined) continue;
    let fenced = false;
    for (let j = i + 1; j < lines.length; j++) {
      const later = bare(j);
      if (later === shape.end) fenced = true;
      if (later !== null && FENCE_LINES.includes(later)) break;
    }
    if (fenced) continue;
    const assignment = bare(i + 1);
    const guard = bare(i + 2);
    const pair = shape.pairs.find(([assign]) => assignment !== null && assign.test(assignment));
    if (pair === undefined || guard === null || !pair[1].test(guard)) continue;
    out.push(
      lines[i + 1] ?? "",
      lines[i + 2] ?? "",
      `${shape.end}${line.endsWith("\r") ? "\r" : ""}`,
    );
    i += 2;
  }
  return out.join("\n");
}

/** Shared with the 3.5.6 step (v356ShellFence), which must run BEFORE the versioned-layout
 *  adoption re-wires the shell: that writer owns only the marker line of an unfenced block and
 *  would strand its body. */
export function fenceShellBlocks(): void {
  const failed: string[] = [];
  for (const file of shellTargetFiles()) {
    try {
      const read = readTextResult(file);
      if (read.kind === "absent") continue;
      if (read.kind === "unreadable") throw new Error(read.error);
      const fenced = fenceUnfencedBlocks(read.text);
      if (fenced === read.text) continue;
      writeFileReported(file, fenced, { detail: "copilot-env shell block fenced" });
    } catch (e) {
      consola.warn(`  could not fence ${file}: ${errMessage(e)}`);
      failed.push(file);
    }
  }
  failIfAny(failed);
}

/** The rc blocks 3.5.6 wrote carry no end fence; fenced in place, body kept. */
export const v400ShellFence: Migration = {
  version: "4.0.0",
  description: "fence the shell rc blocks written without an end marker",
  run: fenceShellBlocks,
};

// --- the Codex provider tables -----------------------------------------------------

/** The `.env` key an older direct-mode release baked the Copilot bearer into (frozen
 *  here; no current writer knows it). */
const LEGACY_DIRECT_ENV_KEY = "COPILOT_ENV_GH_TOKEN";

/** Returns whether the file changed; an absent file or key changes nothing (the file is never
 *  created or rewritten needlessly). Kept lines are rejoined with LF and a final newline, the
 *  file's managed shape. */
export function removeEnvKey(envFile: string, key: string): boolean {
  let existing: string;
  try {
    existing = readFileSync(envFile, "utf8");
  } catch (e) {
    if (isEnoent(e)) return false;
    throw e;
  }
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- key is our own env var name
  const matcher = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
  const lines = existing.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const kept = lines.filter((line) => !matcher.test(line));
  if (kept.length === lines.length) return false;
  writeFileReported(envFile, kept.length ? `${kept.join("\n")}\n` : "", {
    detail: `${key} removed`,
  });
  try {
    chmodReported(envFile, 0o600);
  } catch {
    // the content is what matters; a mode the platform refuses stays as it was
  }
  return true;
}

/** The profile a managed provider table id addresses: null for `copilot-env`, the
 *  name for `copilot-env-<name>`, undefined for a foreign id. */
function profileOfProviderId(id: string): Profile | undefined {
  if (id === CODEX_PROVIDER_ID) return null;
  const prefix = `${CODEX_PROVIDER_ID}-`;
  if (!id.startsWith(prefix)) return undefined;
  const name = id.slice(prefix.length);
  return isValidProfileName(name) ? parseProfileName(name) : undefined;
}

/** The 3.5.6 proxy resolver as its `auth` block spelled it for `profile`, at any
 *  install root: `/bin/sh <root>/src/scripts/proxy-token.sh --yes [--profile <name>]`,
 *  or on Windows `powershell -NoProfile -ExecutionPolicy Bypass -File
 *  <root>\src\scripts\proxy-token.ps1 --yes [--profile <name>]`. Exact argv: a
 *  resolver addressed elsewhere, or carrying extra arguments, is not this shape. */
function isScriptShapedProxyAuth(auth: unknown, profile: Profile): boolean {
  if (!isRecord(auth) || !Array.isArray(auth.args)) return false;
  const args = auth.args.filter((a): a is string => typeof a === "string");
  if (args.length !== auth.args.length) return false;
  const lead = auth.command === "/bin/sh" ? 0 : auth.command === "powershell" &&
      args.slice(0, 4).join(" ") === "-NoProfile -ExecutionPolicy Bypass -File"
    ? 4
    : -1;
  if (lead === -1) return false;
  const script = args[lead];
  const ext = auth.command === "/bin/sh" ? "sh" : "ps1";
  if (
    script === undefined ||
    !new RegExp(String.raw`[\\/]src[\\/]scripts[\\/]proxy-token\.${ext}$`).test(script)
  ) {
    return false;
  }
  const tail = profile === null ? ["--yes"] : ["--yes", "--profile", profile];
  return args.length === lead + 1 + tail.length &&
    tail.every((t, i) => args[lead + 1 + i] === t);
}

/** Every managed `copilot-env[-<name>]` table still wired the pre-4.0.0 way (the script-shaped
 *  auth.command, or the older `env_key = "OPENAI_API_KEY"` wiring) becomes the current managed
 *  proxy table over its user keys; any other env_key on a managed table is dropped (Codex
 *  rejects `auth` + `env_key` on one provider). Foreign tables are never touched. Returns
 *  whether anything changed. */
export function rewriteLegacyCodexTables(doc: Record<string, unknown>): boolean {
  const providers = isRecord(doc.model_providers) ? doc.model_providers : null;
  if (providers === null) return false;
  let changed = false;
  for (const [id, table] of Object.entries(providers)) {
    const profile = profileOfProviderId(id);
    if (profile === undefined || !isRecord(table)) continue;
    const legacyProxy = table.env_key === "OPENAI_API_KEY" ||
      isScriptShapedProxyAuth(table.auth, profile);
    if (legacyProxy && typeof table.base_url === "string") {
      const userKeys = { ...table };
      delete userKeys.env_key;
      providers[id] = { ...userKeys, ...managedProxyProvider(table.base_url, profile) };
      changed = true;
    } else if (table.env_key !== undefined) {
      delete table.env_key;
      changed = true;
    }
  }
  return changed;
}

/** Every known Codex home: the managed provider tables move to the current auth block, and the
 *  baked direct bearer leaves `.env`. Shared with the 3.5.6 registration (see v356ShellFence). */
export function rewriteCodexWiring(): void {
  const { homes, complete } = knownCodexHomes();
  if (!complete) {
    consola.warn(
      "  could not enumerate every ~/.codex/hosts home; a config there may keep the old wiring.",
    );
  }
  const failed: string[] = [];
  for (const home of homes) {
    const configPath = codexConfigPath(home);
    try {
      const read = readCodexToml(configPath);
      if (read.kind === "ok" && rewriteLegacyCodexTables(read.doc)) {
        saveCodexToml(configPath, read.doc, "pre-4.0.0 proxy wiring rewritten");
      }
    } catch (e) {
      consola.warn(`  could not rewrite ${configPath}: ${errMessage(e)}`);
      failed.push(configPath);
    }
    const envFile = join(home, ".env");
    try {
      removeEnvKey(envFile, LEGACY_DIRECT_ENV_KEY);
    } catch (e) {
      consola.warn(`  could not rewrite ${envFile}: ${errMessage(e)}`);
      failed.push(envFile);
    }
  }
  failIfAny(failed);
}

export const v400CodexWiring: Migration = {
  version: "4.0.0",
  description: "rewrite the pre-4.0.0 Codex proxy wiring to the current auth.command",
  run: rewriteCodexWiring,
};

// --- Claude's apiKeyHelper ---------------------------------------------------------

/** The helper FILES 3.5.6 wrote apiKeyHelper as the path of (a `.cmd` on Windows):
 *  `copilot-token[-<name>]` for direct, `copilot-proxy-token[-<name>]` for proxy. */
function legacyHelperPaths(
  claudeHome: string,
  profile: Profile,
): { direct: string; proxy: string } {
  const ext = WIN ? "cmd" : "sh";
  const suffix = profile === null ? "" : `-${profile}`;
  return {
    direct: join(claudeHome, `copilot-token${suffix}.${ext}`),
    proxy: join(claudeHome, `copilot-proxy-token${suffix}.${ext}`),
  };
}

/**
 * The helper-file bodies the releases wrote on THIS platform, frozen from tag history. Each
 * platform only ever wrote its own frame, so the match is by platform, never by extension.
 *
 *   cmd path class admits `%%` only      -> batch escapes `%` so; a raw `%` or line break never landed
 *   bare `--yes` row, default profile    -> v3.3.x wrote the proxy args unquoted
 *   profile unescaped in both quotings   -> names are `[a-z0-9-]`
 */
function releasedHelperBodies(mode: "direct" | "proxy", profile: Profile): RegExp[] {
  const sh = (path: string, args: string) =>
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- our helper body, our paths
    new RegExp(String.raw`^#!/bin/sh\nexec '(?:[^']|'\\'')*${path}' ${args}\n$`);
  const cmd = (path: string, args: string) =>
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- our helper body, our paths
    new RegExp(
      String
        .raw`^@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "(?:[^"%\r\n]|%%)*${path}" ${args}\r\n$`,
    );
  const shProfile = profile === null ? "" : ` '--profile' '${profile}'`;
  const cmdProfile = profile === null ? "" : ` --profile ${profile}`;
  const agent = String.raw`/bin/agent`;
  const agentPs1 = String.raw`\\bin\\agent\.ps1`;
  const script = String.raw`/src/scripts/proxy-token\.sh`;
  const scriptPs1 = String.raw`\\src\\scripts\\proxy-token\.ps1`;
  if (mode === "direct") {
    return WIN
      ? [cmd(agentPs1, `auth --get${cmdProfile}`)]
      : [sh(agent, `'auth' '--get'${shProfile}`)];
  }
  return WIN
    ? [cmd(scriptPs1, `--yes${cmdProfile}`)]
    : [sh(script, `'--yes'${shProfile}`), ...(profile === null ? [sh(script, "--yes")] : [])];
}

/** The profiles a Claude home carries settings for: the default (settings.json)
 *  plus every `settings-<name>.json` whose name is a valid profile name. */
function claudeSettingsProfiles(claudeHome: string): Profile[] {
  const names: ProfileName[] = [];
  try {
    for (const entry of readdirSync(claudeHome)) {
      const m = /^settings-(.+)\.json$/.exec(entry);
      if (m !== null && m[1] !== undefined && isValidProfileName(m[1])) {
        names.push(parseProfileName(m[1]));
      }
    }
  } catch (e) {
    if (!isEnoent(e)) throw e;
  }
  return [null, ...names.sort()];
}

/**
 * Only a helper copilot-env itself wrote is converted; the BODY proves that, since nothing
 * copilot-env wrote pointed anything else at that path.
 *
 *   helper path + a released body -> inlined, the file removed, returns true
 *   helper path, any other body   -> the user's: left alone, the reader calls it "custom"
 */
export function rewriteLegacyClaudeHelper(claudeHome: string, profile: Profile): boolean {
  const settingsPath = settingsPathFor(claudeHome, profile);
  const read = readTextResult(settingsPath);
  if (read.kind === "absent") return false;
  if (read.kind === "unreadable") throw new Error(`could not read it (${read.error})`);
  const doc = parseJsonRecord(read.text);
  if (doc === null) return false;
  const helper = doc.apiKeyHelper;
  if (typeof helper !== "string") return false;
  const paths = legacyHelperPaths(claudeHome, profile);
  const mode = helper === paths.direct ? "direct" : helper === paths.proxy ? "proxy" : null;
  if (mode === null) return false;
  const body = readTextResult(helper);
  if (body.kind === "unreadable") throw new Error(`could not read ${helper} (${body.error})`);
  if (
    body.kind === "absent" ||
    !releasedHelperBodies(mode, profile).some((re) => re.test(body.text))
  ) {
    consola.warn(
      `  ${settingsPath} points at ${helper}, whose body copilot-env did not write; left alone.`,
    );
    return false;
  }
  doc.apiKeyHelper = mode === "direct" ? directHelperCommand(profile) : proxyHelperCommand(profile);
  writeFileReported(settingsPath, `${JSON.stringify(doc, null, 2)}\n`, {
    detail: "apiKeyHelper inlined",
  });
  removeReported(helper, "retired copilot-env helper file");
  return true;
}

/** Shared with the 3.5.6 registration (see v356ShellFence). */
export function rewriteClaudeWiring(): void {
  const claudeHome = resolveClaudeHome();
  const failed: string[] = [];
  for (const profile of claudeSettingsProfiles(claudeHome)) {
    const settingsPath = settingsPathFor(claudeHome, profile);
    try {
      rewriteLegacyClaudeHelper(claudeHome, profile);
    } catch (e) {
      consola.warn(`  could not rewrite ${settingsPath}: ${errMessage(e)}`);
      failed.push(settingsPath);
    }
  }
  failIfAny(failed);
}

/** Claude's apiKeyHelper moves from the helper FILE 3.5.6 wrote to the current inline
 *  command. */
export const v400ClaudeWiring: Migration = {
  version: "4.0.0",
  description: "rewrite Claude's helper-file apiKeyHelper to the inline command",
  run: rewriteClaudeWiring,
};

// --- the autoupdate state file -----------------------------------------------------

/** The state-file key that carried the preference before the `auto-update` config key. */
const LEGACY_ENABLED_KEY = "enabled";

/** The strict read is the decision to skip: an unreadable file throws instead of reading as
 *  "nothing to drop". An absent file, or one without the field, is left untouched. */
export function dropLegacyAutoupdateFlag(file: string): boolean {
  const store = new CopilotApiConfig(file);
  if (!(LEGACY_ENABLED_KEY in store.loadStrict())) return false;
  store.update((d) => {
    delete d[LEGACY_ENABLED_KEY];
  });
  return true;
}

export const v400AutoupdateFlag: Migration = {
  version: "4.0.0",
  description: "drop the retired `enabled` field from the autoupdate state file",
  run: () => void dropLegacyAutoupdateFlag(autoupdateStateFile()),
};
