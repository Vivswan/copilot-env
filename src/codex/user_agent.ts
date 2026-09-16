// The Direct User-Agent both agents send (`codex_exec/<version>`), and the version chain behind it.
// A leaf: config.ts and catalog.ts both need the header, so it lives below both of them.
import { spawnSync } from "node:child_process";
import { CODEX_EXEC_USER_AGENT } from "../copilot_api/integration_identity.ts";
import { cliSpawn } from "../utils/command.ts";

// Local-only runs (no network) that may still cold-start the CLI.
export const CODEX_VERSION_TIMEOUT_MS = 1000;
// The one network lookup outside the Copilot fetch: a registry query, not on any auth deadline.
const NPM_VERSION_TIMEOUT_MS = 5000;

/** Any non-empty value disables the live lookups (the installed codex's version, the npm version
 *  query, the catalog probe in catalog.ts), which then read as unavailable or unverifiable. The
 *  test suite sets it so no test depends on the developer's network or codex install. */
export const CI_NO_LIVE_LOOKUPS_ENV = "COPILOT_ENV_CI_NO_LIVE_LOOKUPS";

export function liveLookupsDisabled(): boolean {
  return Boolean(process.env[CI_NO_LIVE_LOOKUPS_ENV]);
}

function parseCodexVersion(output: string): string | null {
  return output.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0] ?? null;
}

let cachedCodexVersion: string | null | undefined;

/** The installed CLI's version: the first road to the Direct User-Agent (codexUserAgentVersion),
 *  and the key of the catalog acceptance record (judgeCatalog), since the probe asks THAT codex to
 *  parse the file. */
export function installedCodexVersion(): string | null {
  if (liveLookupsDisabled()) return null;
  if (cachedCodexVersion !== undefined) return cachedCodexVersion;
  // cliSpawn routes through cmd.exe on Windows so a codex.cmd shim is launchable.
  const s = cliSpawn("codex", ["--version"]);
  // nosemgrep: javascript.lang.security.audit.spawn-shell-true.spawn-shell-true -- Windows-only, for .cmd shims; the spec quotes args
  const result = spawnSync(s.file, s.args, {
    encoding: "utf8",
    timeout: CODEX_VERSION_TIMEOUT_MS,
    windowsHide: true,
    shell: s.shell,
  });
  cachedCodexVersion = result.error || result.status !== 0
    ? null
    : parseCodexVersion(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  return cachedCodexVersion;
}

let cachedNpmCodexVersion: string | null | undefined;

/** A live npm query, so a machine without the codex CLI (Claude-only Direct) still learns the
 *  current release; off under the suite's seam. */
function latestNpmCodexVersion(): string | null {
  if (liveLookupsDisabled()) return null;
  if (cachedNpmCodexVersion !== undefined) return cachedNpmCodexVersion;
  const s = cliSpawn("npm", ["view", "@openai/codex", "version"]);
  // nosemgrep: javascript.lang.security.audit.spawn-shell-true.spawn-shell-true -- Windows-only, for .cmd shims; the spec quotes args
  const result = spawnSync(s.file, s.args, {
    encoding: "utf8",
    timeout: NPM_VERSION_TIMEOUT_MS,
    windowsHide: true,
    shell: s.shell,
  });
  cachedNpmCodexVersion = result.error || result.status !== 0
    ? null
    : parseCodexVersion(result.stdout ?? "");
  return cachedNpmCodexVersion;
}

/** The current codex release, for the Direct User-Agent of both agents: a real version is a
 *  stronger editor-client identity than the baked fallback, so the installed codex is asked first,
 *  then npm; null (fully offline, no codex) leaves the caller its fallback. Memoized per process, so
 *  one run resolves once. */
export function codexUserAgentVersion(): string | null {
  return installedCodexVersion() ?? latestNpmCodexVersion();
}

/** Test seam: the next resolve spawns again (a fixture just changed PATH or the seam). */
export function resetCodexVersionMemo(): void {
  cachedCodexVersion = undefined;
  cachedNpmCodexVersion = undefined;
}

/** Copilot's Anthropic surface REJECTS some models (claude-fable-5, verified live) for a
 *  version-LESS `codex_exec` UA while accepting any versioned form (the gate is the shape, not the
 *  value), so the managed identity must never go bare: the last resort when neither the installed
 *  codex nor npm answers (codexUserAgentVersion). A real release keeps it plausible. */
export const FALLBACK_CODEX_UA_VERSION = "0.152.0";

/** Both agents' Direct headers carry this; resolved once per process (the version memo above). */
export function codexUserAgent(): string {
  return `${CODEX_EXEC_USER_AGENT}/${codexUserAgentVersion() ?? FALLBACK_CODEX_UA_VERSION}`;
}
