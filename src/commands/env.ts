// Stdout is evaled by the shell wrapper, so it carries only directives; shell env beats
// settings.json, which is why a stale ANTHROPIC_BASE_URL is cleared instead of being left to
// override a now-direct Claude and mask it in health.
//   CLEAR -> matched by shape, not by ownership: a managed farm CODEX_HOME, and any loopback base
//            URL, a user's own http://localhost:9999/custom included
//   SET   -> overrides whatever the shell already carries
//
// The launcher functions ride here rather than in an rc block, so enabling `shell.launchers` takes effect
// on the next `agent` command, whose wrapper evals this output; redefining a function is
// idempotent. Disabling emits nothing, so functions a shell already defined live until it exits.
import { BASE_URL_ENV, managedClaudeBaseUrl } from "../claude/config.ts";
import { managedCodexHome } from "../codex/host.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { assertKnownProfile } from "../copilot_api/env_state.ts";
import { type Profile, parseProfileFlag } from "../copilot_api/profile.ts";
import { type ManagedEnvValue, quotePosix, quotePowerShell } from "../utils/shell_quote.ts";

interface EnvArgs {
  format?: string;
  profile?: string;
}

type EnvDirective = { key: string; value: string } | { key: string; unset: true };

// [name, agent CLI, adds `--relaxed`]
const LAUNCHER_FUNCTIONS = [
  ["cl", "claude", false],
  ["co", "copilot", false],
  ["cx", "codex", false],
  ["clx", "claude", true],
  ["cox", "copilot", true],
  ["cxx", "codex", true],
] as const;

/**
 * These call the `agent` wrapper function (shell/agents.bashrc, agents.ps1), so the env refresh
 * after each launch keeps working. The default profile's launch verb: `agent profile launch`
 * hoists a leading `--profile <name>` pair into the named profile itself, so `cl --profile work`
 * is `agent profile work launch claude`.
 *   '--' quoted   -> unquoted it is PowerShell's own end-of-parameters token and would be swallowed
 *   global: scope -> agents.ps1 evals these inside a function; unscoped, they die with the call
 */
export function launcherFunctionLines(powershell: boolean): string[] {
  return LAUNCHER_FUNCTIONS.map(([name, cli, relaxed]) => {
    const flag = relaxed ? " --relaxed" : "";
    return powershell
      ? `function global:${name} { agent profile launch ${cli}${flag} '--' @args }`
      : `${name}() { agent profile launch ${cli}${flag} -- "$@"; }`;
  });
}

/** Whether `--format` names PowerShell (`powershell`, `pwsh`, `ps`); POSIX is `posix`, `sh`, or
 *  `bash`, and the default. */
function isPowershellFormat(raw: string | undefined): boolean {
  const format = String(raw ?? "posix").toLowerCase();
  if (format === "powershell" || format === "pwsh" || format === "ps") return true;
  if (format === "posix" || format === "sh" || format === "bash") return false;
  throw new Error(`Unknown --format '${raw}' (expected 'posix' or 'powershell').`);
}

/** The directive a managed value asks for: none while the value is not managed. */
function directivesFor(key: string, managed: ManagedEnvValue): EnvDirective[] {
  if (managed === null) return [];
  if ("unset" in managed) return [{ key, unset: true }];
  return [{ key, value: managed.value }];
}

function directiveLine(directive: EnvDirective, powershell: boolean): string {
  if ("unset" in directive) {
    // SilentlyContinue: clearing an already-absent var must be a no-op, like POSIX `unset`.
    return powershell
      ? `Remove-Item -LiteralPath Env:${directive.key} -ErrorAction SilentlyContinue`
      : `unset ${directive.key}`;
  }
  if (powershell) return `$env:${directive.key} = ${quotePowerShell(directive.value)}`;
  return `export ${directive.key}=${quotePosix(directive.value)}`;
}

export function runEnv(args: EnvArgs): void {
  const isPowershell = isPowershellFormat(args.format);
  // Before any directive is printed: an unknown profile must exit non-zero with an EMPTY stdout,
  // since the wrapper evals whatever came out.
  const profile: Profile = parseProfileFlag(args.profile);
  if (profile !== null) assertKnownProfile(profile);

  const directives = [
    ...directivesFor("CODEX_HOME", managedCodexHome()),
    ...directivesFor(BASE_URL_ENV, managedClaudeBaseUrl(profile)),
  ];
  for (const directive of directives) console.log(directiveLine(directive, isPowershell));

  // The functions only delegate to the launch verb, which never runs `agent profile env` itself,
  // so this cannot recurse.
  if (new CopilotEnvConfig().launchersEnabled()) {
    for (const line of launcherFunctionLines(isPowershell)) console.log(line);
  }
}
