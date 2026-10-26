// The Direct User-Agent both agents send (`codex_exec/<version>`), and the version chain behind it.
// A leaf: config.ts and catalog.ts both need the header, so it lives below both of them.
import { spawnSync } from "node:child_process";
import { resolveAgentCli } from "../agents/cli_install.ts";
import { CODEX_EXEC_USER_AGENT } from "../copilot_api/integration_identity.ts";
import { createStderrLogger, narrationMuted } from "../utils/logger.ts";

// Warns on stderr, once per process, when codex resolves to an npm shim (sayShimNote).
const logger = createStderrLogger();

// Local-only runs (no network) that may still cold-start the CLI.
export const CODEX_VERSION_TIMEOUT_MS = 1000;

/** Any non-empty value turns the live lookups off (the installed codex's version, catalog.ts's probe). */
export const CI_NO_LIVE_LOOKUPS_ENV = "COPILOT_ENV_CI_NO_LIVE_LOOKUPS";

/** Off, the version reads as unavailable and the catalog probe as unverifiable. The test suite sets
 *  CI_NO_LIVE_LOOKUPS_ENV so no test depends on the machine's codex install. */
export function liveLookupsDisabled(): boolean {
  return Boolean(process.env[CI_NO_LIVE_LOOKUPS_ENV]);
}

function parseCodexVersion(output: string): string | null {
  return output.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0] ?? null;
}

let cachedCodexVersion: string | null | undefined;
/** The npm-shim note still to say: a muted call (an import's preview) must not spend it. */
let unsaidShimNote: string | null = null;

function sayShimNote(): void {
  if (unsaidShimNote === null || narrationMuted()) return;
  logger.warn(`${unsaidShimNote}; the Direct User-Agent carries the fallback version meanwhile.`);
  unsaidShimNote = null;
}

/** The installed CLI's version: the Direct User-Agent's version (codexUserAgent), and the key of
 *  the catalog acceptance record (judgeCatalog), since the probe asks THAT codex to parse the
 *  file. Memoized per process, so one run spawns once, a failure included. */
export function installedCodexVersion(): string | null {
  if (liveLookupsDisabled()) return null;
  if (cachedCodexVersion === undefined) {
    const codex = resolveAgentCli("codex");
    if (codex.kind === "found") {
      const result = spawnSync(codex.path, ["--version"], {
        encoding: "utf8",
        timeout: CODEX_VERSION_TIMEOUT_MS,
        windowsHide: true,
      });
      cachedCodexVersion =
        result.error || result.status !== 0
          ? null
          : parseCodexVersion(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    } else {
      if (codex.kind === "npm-shim") unsaidShimNote = codex.note;
      cachedCodexVersion = null;
    }
  }
  sayShimNote();
  return cachedCodexVersion;
}

/** Test seam: the next resolve spawns again (a fixture just changed PATH or the seam). */
export function resetCodexVersionMemo(): void {
  cachedCodexVersion = undefined;
  unsaidShimNote = null;
}

/** The version a machine without codex (Claude-only Direct) sends; a real release keeps it plausible. */
export const FALLBACK_CODEX_UA_VERSION = "0.152.0";

/** Both agents' Direct headers carry this: the installed codex's version, a stronger
 *  editor-client identity than the baked fallback, else the fallback. Never bare: Copilot's
 *  Anthropic surface REJECTS some models (claude-fable-5, verified live) for a version-LESS
 *  `codex_exec` UA while accepting any versioned form (the gate is the shape, not the value). */
export function codexUserAgent(): string {
  return `${CODEX_EXEC_USER_AGENT}/${installedCodexVersion() ?? FALLBACK_CODEX_UA_VERSION}`;
}
