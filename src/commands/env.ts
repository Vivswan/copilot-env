// `agent env`: prints machine-readable shell exports for the local gateway.
import { CopilotApiConfig } from "../copilot_api/config.ts";
import { copilotApiResolvePort } from "../copilot_api/port.ts";
import { CopilotApiState } from "../copilot_api/state.ts";

export interface EnvArgs {
  format?: string;
}

/**
 * `env`: print env assignments for the local gateway, evaluated by the calling
 * shell. This is the only command whose stdout is machine-readable (the shell
 * `agent` wrapper evals it), so it must emit ONLY `export KEY=val` /
 * `$env:KEY = '...'` lines — never logs.
 */
export function runEnv(args: EnvArgs): void {
  const format = String(args.format ?? "posix").toLowerCase();
  const isPowershell = format === "powershell" || format === "pwsh" || format === "ps";
  if (!isPowershell && format !== "posix" && format !== "sh" && format !== "bash") {
    throw new Error(`unknown --format '${args.format}' (expected 'posix' or 'powershell')`);
  }

  const port = copilotApiResolvePort();
  let token: string;
  try {
    token = new CopilotApiConfig().ensureApiKey();
  } catch (e) {
    throw new Error(`failed to persist auth token: ${e instanceof Error ? e.message : String(e)}`);
  }

  const vars: Array<[string, string]> = [
    ["ANTHROPIC_BASE_URL", `http://localhost:${port}`],
    ["ANTHROPIC_AUTH_TOKEN", token],
    ["OPENAI_BASE_URL", `http://localhost:${port}/v1`],
    ["OPENAI_API_KEY", token],
  ];

  // Export CODEX_HOME only when a codex command has set it in state (opt-in).
  // A null/absent value means "use Codex's default home" — emit nothing.
  const codexHome = new CopilotApiState().read().codexHome;
  if (codexHome) {
    vars.push(["CODEX_HOME", codexHome]);
  }

  for (const [key, value] of vars) {
    if (isPowershell) {
      // Single-quoted PS literal; double any embedded quote per PS escaping.
      console.log(`$env:${key} = '${value.replace(/'/g, "''")}'`);
    } else {
      // Single-quoted POSIX literal so values with spaces/metacharacters (e.g. a
      // CODEX_HOME path) survive the shell wrapper's `eval`. Embedded `'` → `'\''`.
      console.log(`export ${key}='${value.replace(/'/g, "'\\''")}'`);
    }
  }
}
