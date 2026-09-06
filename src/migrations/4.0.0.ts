// Away from 4.0.0: the readers know only the current wiring shape. 4.0.0 fenced the
// shell rc block, moved the proxy resolver from the `src/scripts/proxy-token.{sh,ps1}`
// script into `agent proxy-token`, made Claude's apiKeyHelper an inline command
// instead of a helper FILE, and moved the autoupdate preference into the
// `auto-update` config key -- while its readers still tolerated the shapes 3.5.6
// wrote. Those tolerances are gone, so the fix-ups below convert what a 3.5.6-shaped
// install still carries (a 4.0.0 install that never re-ran init/codex/claude/shell
// included). Each is idempotent: a converted install reads back unchanged.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { consola } from "consola";
import { autoupdateStateFile } from "../autoupdate/paths.ts";
import { directHelperCommand, proxyHelperCommand } from "../claude/config.ts";
import { resolveClaudeHome, settingsPathFor, WIN } from "../claude/paths.ts";
import { knownCodexHomes, managedProxyProvider } from "../codex/config.ts";
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

/** A step's outcome is honest about its files: each file converts independently (one
 *  bad file never stops the others), but any file that could not be converted makes
 *  the whole step fail, so the runner warns and names the re-run instead of reporting
 *  a clean pass over wiring that is still broken. */
function failIfAny(failed: readonly string[]): void {
  if (failed.length === 0) return;
  throw new Error(`${failed.length} file(s) were not converted: ${failed.join(", ")}`);
}

// --- the shell rc block ----------------------------------------------------------

/** The ordered [assignment, guard] line pair every 3.5.6-or-older release (and the
 *  pre-TS installers) wrote under each rc marker, frozen here: how an UNFENCED block
 *  is bounded without eating user lines. Order matters: a lookalike line in the guard
 *  position must not be consumed. Only the assignment VALUE varied across releases,
 *  so the assignments match on prefix; the guards match whole, in both their
 *  historical (no -LiteralPath) and current spellings. */
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

/**
 * Pure core of v400ShellFence: every unfenced marker block in `content` whose two
 * body lines are the pair its release wrote gets its end fence inserted after the
 * guard line, so the current writer (fenced blocks only) refreshes or strips it
 * like any other. Anything else -- a fenced block, a body that is not the pair --
 * is left byte-identical. CR-tolerant, and the fence adopts the marker line's ending.
 */
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

/** Fence every unfenced block in this platform's rc/profile files. Shared by the
 *  4.0.0 step below and the 3.5.6 step (v356ShellFence), which must run BEFORE the
 *  versioned-layout adoption re-wires the shell through the current writer -- that
 *  writer owns only the marker line of an unfenced block and would strand its body. */
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

/** The rc/profile blocks 3.5.6 wrote carry no end fence; fenced in place (the body is
 *  kept, so the next `agent shell` refreshes it like any current block). */
export const v400ShellFence: Migration = {
  version: "4.0.0",
  description: "fence the shell rc blocks written without an end marker",
  run: fenceShellBlocks,
};

// --- the Codex provider tables -----------------------------------------------------

/** The `.env` key an older direct-mode release baked the Copilot bearer into (frozen
 *  here; no current writer knows it). */
const LEGACY_DIRECT_ENV_KEY = "COPILOT_ENV_GH_TOKEN";

/** Remove `key` from a Codex `.env` (any `export`-prefixed or duplicate assignment),
 *  keeping every other line (rejoined with LF and a final newline, the file's managed
 *  shape). Returns whether the file changed; an absent file or an absent key changes
 *  nothing (the file is never created or rewritten needlessly). */
export function removeEnvKey(envFile: string, key: string): boolean {
  let existing: string;
  try {
    existing = readFileSync(envFile, "utf8");
  } catch (e) {
    if (isEnoent(e)) return false;
    throw e;
  }
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

/**
 * Pure core of v400CodexWiring over one parsed config.toml: every managed
 * `copilot-env[-<name>]` table still wired the pre-4.0.0 way -- the script-shaped
 * auth.command, or the `env_key = "OPENAI_API_KEY"` proxy wiring older still -- is
 * rewritten to the current managed proxy table (the same base_url, the `agent
 * proxy-token` auth block) over its user keys; any other env_key left on a managed
 * table is dropped (Codex rejects `auth` + `env_key` on one provider). Foreign
 * tables are never touched. Returns whether anything changed.
 */
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

/** Rewrite every known Codex home: the managed provider tables move to the current
 *  `agent proxy-token` auth block, and the baked direct bearer leaves `.env`. Shared
 *  by the 4.0.0 step below and its 3.5.6 registration (see v356ShellFence's note). */
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
 * The helper-file bodies the releases wrote on THIS platform, by SHAPE (any install
 * root), frozen from tag history: the POSIX `#!/bin/sh` + `exec` frame with every
 * token single-quoted, or the Windows `@echo off` CRLF frame (a path may carry `%%`,
 * never a raw `%` or a line break). Direct ran `agent auth --get`; proxy ran the
 * `src/scripts/proxy-token` forwarder (v3.3.x spelled `--yes` bare, default profile
 * only). Released bodies only: a `.sh` only ever held the POSIX frame and a `.cmd`
 * the Windows one, so the other platform's frame at this platform's path is nobody's
 * release. Profile names are `[a-z0-9-]`, so they need no escaping in either quoting.
 */
function releasedHelperBodies(mode: "direct" | "proxy", profile: Profile): RegExp[] {
  const sh = (path: string, args: string) =>
    new RegExp(String.raw`^#!/bin/sh\nexec '(?:[^']|'\\'')*${path}' ${args}\n$`);
  const cmd = (path: string, args: string) =>
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
 * Core of v400ClaudeWiring for ONE settings file: an apiKeyHelper that is the
 * profile's helper-file path, with a body one of the releases wrote for that mode and
 * profile, becomes the current inline command and the file goes with it -- it is
 * copilot-env's own artifact (the body proves it), nothing copilot-env wrote ever
 * pointed anything else at it, and its proxy body dies with the swept forwarder
 * anyway. A file at the same name with any other body is the user's: the settings
 * are left alone (the reader classifies them "custom"). Returns whether the settings
 * were rewritten.
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

/** Rewrite the default and every named profile's settings file in the Claude home.
 *  Shared by the 4.0.0 step below and its 3.5.6 registration. */
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

/** Drop the field from `file`. Returns whether it was there: an absent file, or one
 *  without the field, is left untouched (the strict read is the decision to skip, so
 *  an unreadable file throws instead of reading as "nothing to drop"). */
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
