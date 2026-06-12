// `agent env`: prints machine-readable shell directives, evaluated by the calling
// shell. It may set OR clear two managed vars, each only when relevant:
//   - CODEX_HOME: set to the active `codex --host` farm when its dir exists;
//     cleared when the shell still carries OUR (now-deleted) farm path.
//   - ANTHROPIC_BASE_URL: set when Claude is wired to a LOCAL proxy URL;
//     cleared when the shell still carries a localhost proxy URL (one WE set)
//     but Claude is no longer in proxy mode — otherwise a stale proxy URL would
//     override the now-direct settings.json (shell env wins) and mask it in health.
// It NEVER touches a value the user set themselves (a foreign CODEX_HOME, or a
// non-local ANTHROPIC_BASE_URL). Everything else lives in each agent's own config
// file (Codex: config.toml + .env; Claude: settings.json + apiKeyHelper).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BASE_URL_ENV,
  DIRECT_BASE_URL,
  inspectClaudeWiring,
  resolveClaudeHome,
} from "../claude/config.ts";
import { getHostLocalCodexHome } from "../codex/host.ts";
import { CopilotEnvRunState } from "../copilot_api/state.ts";
import { quotePosix, quotePowerShell } from "../utils/shell_quote.ts";

export interface EnvArgs {
  format?: string;
}

/** A shell directive: assign a value, or clear the var entirely. */
type EnvDirective = { key: string; value: string } | { key: string; unset: true };

function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/** True for an http://localhost or http://127.0.0.1 URL — the proxy shape we write. */
function isLocalProxyUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

/**
 * `env`: print env directives for the calling shell. This is the only command
 * whose stdout is machine-readable (the shell `agent` wrapper evals it), so it
 * must emit ONLY assignment / unset directives — never logs.
 */
export function runEnv(args: EnvArgs): void {
  const format = String(args.format ?? "posix").toLowerCase();
  const isPowershell = format === "powershell" || format === "pwsh" || format === "ps";
  if (!isPowershell && format !== "posix" && format !== "sh" && format !== "bash") {
    throw new Error(`Unknown --format '${args.format}' (expected 'posix' or 'powershell').`);
  }

  const directives: EnvDirective[] = [];

  // CODEX_HOME: export the active host farm when its dir exists. If the shell
  // currently carries OUR farm path but it's gone (e.g. after `codex --delete-host`),
  // clear it; never touch a CODEX_HOME the user pointed somewhere else.
  const codexHome = new CopilotEnvRunState().read().codexHome;
  if (codexHome && existsSync(codexHome)) {
    directives.push({ key: "CODEX_HOME", value: codexHome });
  } else {
    const current = process.env.CODEX_HOME;
    if (current && current === getHostLocalCodexHome() && !existsSync(current)) {
      directives.push({ key: "CODEX_HOME", unset: true });
    }
  }

  // ANTHROPIC_BASE_URL: export only when Claude is proxy-wired at a LOCAL proxy
  // URL. If the shell carries a localhost proxy URL (one WE set) but Claude is no
  // longer proxy, clear it so it can't override the now-direct settings.json; never
  // touch a non-local URL the user set.
  const claudeHome = resolveClaudeHome();
  const claude = inspectClaudeWiring(readTextOrNull(join(claudeHome, "settings.json")), claudeHome);
  const proxyUrl =
    claude.providerMode === "proxy" &&
    claude.baseUrl &&
    claude.baseUrl !== DIRECT_BASE_URL &&
    isLocalProxyUrl(claude.baseUrl)
      ? claude.baseUrl
      : null;
  if (proxyUrl) {
    directives.push({ key: BASE_URL_ENV, value: proxyUrl });
  } else {
    const current = process.env[BASE_URL_ENV];
    if (current && isLocalProxyUrl(current)) {
      directives.push({ key: BASE_URL_ENV, unset: true });
    }
  }

  for (const directive of directives) {
    if ("unset" in directive) {
      // Clear the var. The POSIX wrapper evals everything; the PowerShell wrapper
      // also honors Remove-Item lines (see shell/agents.ps1).
      console.log(
        isPowershell
          ? `Remove-Item -LiteralPath Env:${directive.key} -ErrorAction SilentlyContinue`
          : `unset ${directive.key}`,
      );
    } else if (isPowershell) {
      // Single-quoted PS literal; double any embedded quote per PS escaping.
      console.log(`$env:${directive.key} = ${quotePowerShell(directive.value)}`);
    } else {
      // Single-quoted POSIX literal so values with spaces/metacharacters survive
      // the shell wrapper's `eval`. Embedded `'` → `'\''`.
      console.log(`export ${directive.key}=${quotePosix(directive.value)}`);
    }
  }
}
