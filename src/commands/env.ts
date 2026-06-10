// `agent env`: prints machine-readable shell exports, evaluated by the calling
// shell. As of the config-file model, the ONLY thing exported is CODEX_HOME —
// each agent's gateway/direct wiring now lives in its own config file (Codex:
// config.toml + .env; Claude: settings.json + apiKeyHelper), so the gateway
// endpoint and token are no longer injected into the shell environment. The
// command still exists (and the wrapper still evals it) because CODEX_HOME has
// no per-tool config home and must be exported for Codex to find its farm.
import { CopilotApiState } from "../copilot_api/state.ts";
import { quotePosix, quotePowerShell } from "../utils/shell_quote.ts";

export interface EnvArgs {
  format?: string;
}

/**
 * `env`: print env assignments for the calling shell. This is the only command
 * whose stdout is machine-readable (the shell `agent` wrapper evals it), so it
 * must emit ONLY `export KEY=val` / `$env:KEY = '...'` lines — never logs.
 */
export function runEnv(args: EnvArgs): void {
  const format = String(args.format ?? "posix").toLowerCase();
  const isPowershell = format === "powershell" || format === "pwsh" || format === "ps";
  if (!isPowershell && format !== "posix" && format !== "sh" && format !== "bash") {
    throw new Error(`unknown --format '${args.format}' (expected 'posix' or 'powershell')`);
  }

  const vars: Array<[string, string]> = [];

  // Export CODEX_HOME only when a codex command has set it in state (opt-in).
  // A null/absent value means "use Codex's default home" — emit nothing.
  const codexHome = new CopilotApiState().read().codexHome;
  if (codexHome) {
    vars.push(["CODEX_HOME", codexHome]);
  }

  for (const [key, value] of vars) {
    if (isPowershell) {
      // Single-quoted PS literal; double any embedded quote per PS escaping.
      console.log(`$env:${key} = ${quotePowerShell(value)}`);
    } else {
      // Single-quoted POSIX literal so values with spaces/metacharacters (e.g. a
      // CODEX_HOME path) survive the shell wrapper's `eval`. Embedded `'` → `'\''`.
      console.log(`export ${key}=${quotePosix(value)}`);
    }
  }
}
