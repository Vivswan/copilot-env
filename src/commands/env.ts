// `agent env`: prints machine-readable shell directives, evaluated by the calling
// shell. It may set OR clear two managed vars, each only when relevant:
//   - CODEX_HOME: set to the active `codex --host` farm when its dir exists;
//     cleared when the shell still carries OUR (now-deleted) farm path.
//   - ANTHROPIC_BASE_URL: set when Claude is wired to a LOCAL proxy URL;
//     cleared when the shell still carries a localhost proxy URL (one WE set)
//     but Claude is no longer in proxy mode -- otherwise a stale proxy URL would
//     override the now-direct settings.json (shell env wins) and mask it in health.
// It NEVER touches a value the user set themselves (a foreign CODEX_HOME, or a
// non-local ANTHROPIC_BASE_URL). Everything else lives in each agent's own config
// file (Codex: config.toml + .env; Claude: settings.json + apiKeyHelper).
//
// It may ALSO emit one non-assignment directive: a `source` of the opt-in launchers
// file when they are wired, so `cl`/`co`/`cx` become available in the CURRENT shell
// right after `agent shell --launchers` (which runs through the `agent` wrapper that
// evals this output) -- no restart. Sourcing just (re)defines those functions, so
// re-emitting it on later commands is harmless.
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
import { PROJECT_ROOT } from "../utils/root.ts";
import { quotePosix, quotePowerShell } from "../utils/shell_quote.ts";
import { launchersWired } from "./shell_integration.ts";

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

/** True for an http://localhost or http://127.0.0.1 URL -- the proxy shape we write. */
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
 * must emit ONLY shell directives the wrapper is built to eval -- assignment /
 * unset lines, plus the launchers `source` line below -- never logs.
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
      // the shell wrapper's `eval`. Embedded `'` -> `'\''`.
      console.log(`export ${directive.key}=${quotePosix(directive.value)}`);
    }
  }

  // Launchers source: after `agent shell --launchers` (run through the `agent`
  // wrapper, which evals this output) pull the cl/co/cx launchers into the CURRENT
  // shell so they work without a restart. Gated on the launchers being wired in the
  // user's rc/profile, so we never auto-enable an opt-out user. Sourcing only
  // (re)defines the launcher functions -- idempotent, and the file never calls
  // `agent env`, so it cannot recurse.
  if (launchersWired()) {
    const launchers = join(
      PROJECT_ROOT,
      "shell",
      isPowershell ? "agents.launchers.ps1" : "agents.launchers.bashrc",
    );
    console.log(
      isPowershell
        ? `if (Test-Path -LiteralPath ${quotePowerShell(launchers)}) { . ${quotePowerShell(launchers)} }`
        : `[ -f ${quotePosix(launchers)} ] && . ${quotePosix(launchers)}`,
    );
  }
}
