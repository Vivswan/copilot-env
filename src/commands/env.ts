// `agent env`: prints machine-readable shell directives, evaluated by the calling
// shell. It may set OR clear two managed vars, each only when relevant:
//   - CODEX_HOME: set to the per-host farm while a wiring pass has activated it and
//     the `codex-host` key is not off; cleared when the shell still carries OUR farm
//     path but it is no longer the managed home.
//   - ANTHROPIC_BASE_URL: set when Claude is wired to a LOCAL proxy URL;
//     cleared when the shell still carries a localhost proxy URL (one WE set)
//     but Claude is no longer in proxy mode -- otherwise a stale proxy URL would
//     override the now-direct settings.json (shell env wins) and mask it in health.
// It NEVER touches a value the user set themselves (a foreign CODEX_HOME, or a
// non-local ANTHROPIC_BASE_URL). Everything else lives in each agent's own config
// file (Codex: config.toml + .env; Claude: settings.json + apiKeyHelper).
//
// It may ALSO emit the opt-in cl/co/cx launcher functions (one-line definitions
// delegating to `agent launch`) when the `launchers` config key is on, so the
// launchers need no rc block of their own: the eager `agent env` at shell startup
// defines them, and the next `agent` command (whose wrapper evals this output)
// picks up a toggle without a restart. Defining a function is idempotent, so
// re-emitting on every command is harmless.
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
  /**
   * `--profile <name>`: resolve the profile-scoped directives against that named
   * profile's wiring (its settings-<name>.json, its reserved port) instead of the
   * default. Account-wide directives (CODEX_HOME, the launcher functions) are the
   * same either way. An unknown name is a hard error BEFORE anything is printed:
   * this stdout is evaled, so a half-wrong export set must never be emitted.
   */
  profile?: string;
}

/** A shell directive: assign a value, or clear the var entirely. */
type EnvDirective = { key: string; value: string } | { key: string; unset: true };

/** What a managed env var should become in the calling shell: a value to set, an
 *  order to clear OUR stale value, or null = leave whatever is there alone. */
export type ManagedEnvValue = { value: string } | { unset: true } | null;

/** True for an http://localhost or http://127.0.0.1 URL -- the proxy shape we write.
 *  Deliberately port- and path-agnostic (the shared grammar in port.ts, bare null-test):
 *  this gates both setting AND clearing the var, and a stale URL on an old port must
 *  still read as ours to clear. */
function isLocalProxyUrl(url: string): boolean {
  return parseLoopbackProxyUrl(url) !== null;
}

/** CODEX_HOME's managed value, the shell-side mirror of effectiveCodexHome: the
 *  activated farm unless the key is off; a clear of OUR exact farm spelling when it
 *  is no longer the managed home; a foreign CODEX_HOME is the user's (hands-off). */
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

/**
 * ANTHROPIC_BASE_URL's managed value for `profile`: the LOCAL proxy URL when the
 * profile's Claude wiring selects the proxy at one; a clear when the shell carries
 * a localhost proxy URL (one WE set) but Claude is no longer proxy; otherwise
 * hands-off (a non-local URL is the user's, and a settings file that exists but
 * could not be read is unknown wiring -- neither set nor cleared). Read-only -- a
 * named profile answers from ITS settings-<name>.json and ITS resolved port
 * (never reserves one). Shared by `agent env` and `agent launch` (see
 * managedCodexHome).
 */
export function managedClaudeBaseUrl(profile: Profile): ManagedEnvValue {
  const claudeHome = resolveClaudeHome();
  const claude = inspectClaudeWiring(
    readTextResult(settingsPathFor(claudeHome, profile)),
    claudeHome,
    Number(copilotApiResolvePort(profile)),
    profile,
  );
  // The clear below is authorized by "Claude is no longer proxy" -- a fact an
  // unreadable settings file cannot establish (an ABSENT one can: nothing is
  // wired). On a read failure the eval'd output degrades safely to hands-off.
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

/** The opt-in launcher functions, one per line: name, agent CLI, and whether the
 *  variant adds `--relaxed` (each agent's most-relaxed flag; see `agent launch`). */
const LAUNCHER_FUNCTIONS = [
  ["cl", "claude", false],
  ["co", "copilot", false],
  ["cx", "codex", false],
  ["clx", "claude", true],
  ["cox", "copilot", true],
  ["cxx", "codex", true],
] as const;

/**
 * The one-line launcher function definitions `agent env` emits when the
 * `launchers` config key is on. They call the `agent` WRAPPER function (defined by
 * shell/agents.bashrc / agents.ps1 before this output is ever evaled), so the env
 * refresh after each launch keeps working. Everything the user typed rides behind
 * `--` as verbatim pass-through args -- `agent launch` hoists a leading
 * `--profile <name>` pair itself, so `cl --profile work` keeps working. The
 * PowerShell `--` is quoted: unquoted it is PowerShell's own end-of-parameters
 * token and would be swallowed instead of passed. `global:` scope because
 * agents.ps1 evals these inside a function (Import-CopilotEnv), where an
 * unscoped definition would die with that call. Exported for tests.
 */
export function launcherFunctionLines(powershell: boolean): string[] {
  return LAUNCHER_FUNCTIONS.map(([name, cli, relaxed]) => {
    const flag = relaxed ? " --relaxed" : "";
    return powershell
      ? `function global:${name} { agent launch ${cli}${flag} '--' @args }`
      : `${name}() { agent launch ${cli}${flag} -- "$@"; }`;
  });
}

/**
 * `env`: print env directives for the calling shell. This is the only command
 * whose stdout is machine-readable (the shell `agent` wrapper evals it), so it
 * must emit ONLY shell directives the wrapper is built to eval -- assignment /
 * unset lines, plus the launcher function lines below -- never logs.
 */
export function runEnv(args: EnvArgs): void {
  const format = String(args.format ?? "posix").toLowerCase();
  const isPowershell = format === "powershell" || format === "pwsh" || format === "ps";
  if (!isPowershell && format !== "posix" && format !== "sh" && format !== "bash") {
    throw new Error(`Unknown --format '${args.format}' (expected 'posix' or 'powershell').`);
  }
  // Validate the profile BEFORE any directive is computed or printed: an unknown
  // name must exit non-zero with an EMPTY stdout (a machine consumer evals this
  // output, so it must never see a partially resolved export set). A named
  // profile never falls back to the default wiring.
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
      // Clear the var. Both wrappers eval every emitted directive
      // (agents.bashrc's unconditional eval; agents.ps1's Import-CopilotEnv).
      // SilentlyContinue: clearing an already-absent var must be a no-op (POSIX
      // `unset` parity); the wrapper reads no verdict from the eval'd line.
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

  // Launcher functions: gated on the `launchers` config key, so we never define
  // short names for an opt-out user. The functions only delegate to `agent launch`
  // (which never runs `agent env` itself), so this cannot recurse.
  if (new CopilotEnvConfig().launchersEnabled()) {
    for (const line of launcherFunctionLines(isPowershell)) console.log(line);
  }
}
