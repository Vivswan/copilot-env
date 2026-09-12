// Stdout is evaled by the shell wrapper, so it carries only directives; shell env beats
// settings.json, which is why a stale ANTHROPIC_BASE_URL is cleared instead of being left to
// override a now-direct Claude and mask it in health.
//   CLEAR -> matched by shape, not by ownership: a managed farm CODEX_HOME, and any loopback base
//            URL, a user's own http://localhost:9999/custom included
//   SET   -> overrides whatever the shell already carries
//
// The launcher functions ride here rather than in an rc block, so enabling `launchers` takes effect
// on the next `agent` command, whose wrapper evals this output; redefining a function is
// idempotent. Disabling emits nothing, so functions a shell already defined live until it exits.
import { BASE_URL_ENV, DIRECT_BASE_URL, inspectClaudeWiring } from "../claude/config.ts";
import { resolveClaudeHome, settingsPathFor } from "../claude/paths.ts";
import {
  codexHostDriftFrom,
  codexHostDriftLine,
  codexHostFarm,
  isManagedFarmExport,
} from "../codex/host.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import { assertKnownProfile } from "../copilot_api/env_state.ts";
import { copilotApiResolvePort, parseLoopbackProxyUrl } from "../copilot_api/port.ts";
import { parseProfileFlag, type Profile } from "../copilot_api/profile.ts";
import { readTextResult } from "../utils/fs.ts";
import { createStderrLogger } from "../utils/logger.ts";
import { quotePosix, quotePowerShell } from "../utils/shell_quote.ts";

// Stderr only: this command's stdout is evaled by the shell wrapper.
const logger = createStderrLogger();

export interface EnvArgs {
  format?: string;
  profile?: string;
}

type EnvDirective = { key: string; value: string } | { key: string; unset: true };

/** null = leave whatever the shell has alone. */
export type ManagedEnvValue = { value: string } | { unset: true } | null;

/** Port- and path-agnostic on purpose: this gates clearing as well as setting, and a stale URL on
 *  an old port must still read as ours to clear. */
function isLocalProxyUrl(url: string): boolean {
  return parseLoopbackProxyUrl(url) !== null;
}

/** The shell-side mirror of effectiveCodexHome (src/codex/host.ts). They part on drift: with
 *  codex-host on and a recorded farm home that still exists, effectiveCodexHomeFor keeps it, while
 *  this wants farm.wired and otherwise clears the export. */
export function managedCodexHome(): ManagedEnvValue {
  if (process.platform === "win32") return null;
  const farm = codexHostFarm();
  if (new CopilotEnvConfig().codexHostEnabled()) {
    if (farm.wired && farm.active) return { value: farm.hostHome };
    const drift = codexHostDriftFrom(true, farm);
    if (drift !== null) logger.warn(codexHostDriftLine(drift));
  }
  if (isManagedFarmExport(process.env.CODEX_HOME)) return { unset: true };
  return null;
}

/** Read-only: a named profile answers from its own settings-<name>.json and resolved port, never
 *  reserving one. Shared by `agent env` and `agent launch`. */
export function managedClaudeBaseUrl(profile: Profile): ManagedEnvValue {
  const claudeHome = resolveClaudeHome();
  const claude = inspectClaudeWiring(
    readTextResult(settingsPathFor(claudeHome, profile)),
    Number(copilotApiResolvePort(profile)),
    profile,
  );
  // The clear below rests on "Claude is no longer proxy", which an unreadable settings file cannot
  // establish (an absent one can: nothing is wired), so a read failure degrades to hands-off.
  if (claude.otherReason === "read-error") return null;
  const proxyUrl = claude.providerMode === "proxy" &&
      claude.baseUrl &&
      claude.baseUrl !== DIRECT_BASE_URL &&
      isLocalProxyUrl(claude.baseUrl)
    ? claude.baseUrl
    : null;
  if (proxyUrl) return { value: proxyUrl };
  const current = process.env[BASE_URL_ENV];
  if (current && isLocalProxyUrl(current)) return { unset: true };
  return null;
}

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
 * after each launch keeps working. `agent launch` hoists a leading `--profile <name>` pair itself.
 *   '--' quoted   -> unquoted it is PowerShell's own end-of-parameters token and would be swallowed
 *   global: scope -> agents.ps1 evals these inside a function; unscoped, they die with the call
 */
export function launcherFunctionLines(powershell: boolean): string[] {
  return LAUNCHER_FUNCTIONS.map(([name, cli, relaxed]) => {
    const flag = relaxed ? " --relaxed" : "";
    return powershell
      ? `function global:${name} { agent launch ${cli}${flag} '--' @args }`
      : `${name}() { agent launch ${cli}${flag} -- "$@"; }`;
  });
}

export function runEnv(args: EnvArgs): void {
  const format = String(args.format ?? "posix").toLowerCase();
  const isPowershell = format === "powershell" || format === "pwsh" || format === "ps";
  if (!isPowershell && format !== "posix" && format !== "sh" && format !== "bash") {
    throw new Error(`Unknown --format '${args.format}' (expected 'posix' or 'powershell').`);
  }
  // Before any directive is printed: an unknown profile must exit non-zero with an EMPTY stdout,
  // since the wrapper evals whatever came out.
  const profile: Profile = parseProfileFlag(args.profile);
  if (profile !== null) assertKnownProfile(profile);

  const directives: EnvDirective[] = [];
  const codexHome = managedCodexHome();
  if (codexHome !== null) {
    directives.push(
      "unset" in codexHome ? { key: "CODEX_HOME", unset: true } : {
        key: "CODEX_HOME",
        value: codexHome.value,
      },
    );
  }
  const baseUrl = managedClaudeBaseUrl(profile);
  if (baseUrl !== null) {
    directives.push(
      "unset" in baseUrl ? { key: BASE_URL_ENV, unset: true } : {
        key: BASE_URL_ENV,
        value: baseUrl.value,
      },
    );
  }

  for (const directive of directives) {
    if ("unset" in directive) {
      // SilentlyContinue: clearing an already-absent var must be a no-op, like POSIX `unset`.
      console.log(
        isPowershell
          ? `Remove-Item -LiteralPath Env:${directive.key} -ErrorAction SilentlyContinue`
          : `unset ${directive.key}`,
      );
    } else if (isPowershell) {
      console.log(`$env:${directive.key} = ${quotePowerShell(directive.value)}`);
    } else {
      console.log(`export ${directive.key}=${quotePosix(directive.value)}`);
    }
  }

  // The functions only delegate to `agent launch`, which never runs `agent env` itself, so this
  // cannot recurse.
  if (new CopilotEnvConfig().launchersEnabled()) {
    for (const line of launcherFunctionLines(isPowershell)) console.log(line);
  }
}
