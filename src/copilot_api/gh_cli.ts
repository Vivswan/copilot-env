// The gh CLI / GitHub-token credential surface: the env vars a `gh-token`
// credential is read from (with their user-facing labels, so help text can never
// drift from the resolver), and the ONE recipe for probing gh's login. Lives in
// the credential layer so the token capture (credential.ts), the CLI help
// strings, and the Direct probes all name the same contract without pulling in
// the live-probe machinery.
import { dirname } from "node:path";
import { childEnvWithPath, cliSpawn } from "../utils/command.ts";

/**
 * Env var names checked (in order, most specific first) for a `gh-token` value, so
 * the secret stays out of argv / shell history. COPILOT_GITHUB_TOKEN is the
 * Copilot-specific name; GH_TOKEN / GITHUB_TOKEN are the gh CLI's conventional vars.
 */
export const GH_TOKEN_ENV_VARS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;

/**
 * GH_TOKEN_ENV_VARS as a `$VAR` fragment for help text and prompt labels, in
 * resolver order, so user-facing docs can never drift from what ghTokenFromEnv
 * actually reads (and in which precedence).
 */
export function ghTokenEnvVarsLabel(separator = "/"): string {
  return GH_TOKEN_ENV_VARS.map((name) => `$${name}`).join(separator);
}

/** GH_TOKEN_ENV_VARS as bare names for error messages ("COPILOT_GITHUB_TOKEN / GH_TOKEN / ..."),
 *  same resolver order as the label. */
export function ghTokenEnvVarsList(): string {
  return GH_TOKEN_ENV_VARS.join(" / ");
}

/** First non-empty (trimmed) token among GH_TOKEN_ENV_VARS, or null when none is set. */
export function ghTokenFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const name of GH_TOKEN_ENV_VARS) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return null;
}

/**
 * Resolve a GitHub token from `agent auth --provider gh-token`: a bare request
 * (`true`) reads the GH_TOKEN_ENV_VARS in order, so the secret stays out of argv /
 * shell history; a string value is used verbatim (trimmed); `undefined`/`false`
 * => `null` (not requested). Throws when a token was requested but none resolved.
 * The narrow overload proves that a definite request (string | true) always yields
 * a token or throws -- callers holding one never handle a null.
 */
export function tokenFromSetFlag(flag: string | true): string;
export function tokenFromSetFlag(flag: string | boolean | undefined): string | null;
export function tokenFromSetFlag(flag: string | boolean | undefined): string | null {
  // undefined/false = not requested (false should never come from a boolean flag,
  // but treat it as absence rather than the literal token "false").
  if (flag === undefined || flag === false) return null;
  if (flag === true) {
    const fromEnv = ghTokenFromEnv();
    if (fromEnv) return fromEnv;
    throw new Error(`no GitHub token found: set one of ${ghTokenEnvVarsList()}`);
  }
  const token = flag.trim();
  if (token === "") throw new Error("the provided GitHub token is empty");
  return token;
}

/** Cap on one `gh auth token` call, shared by every "is gh authenticated?" probe. */
export const GH_AUTH_TIMEOUT_MS = 5000;

/**
 * The ONE recipe for probing gh's login: spawn `gh auth token` at gh's RESOLVED
 * path (not the bare name), with gh's bin dir on PATH, so an nvm-only gh (or a
 * node-shim gh) found via the nvm fallback is runnable; cliSpawn routes through
 * cmd.exe on Windows so a .cmd/.exe shim is launchable. Success = exit 0. Shared
 * by the token capture (copilot_api/credential.ts), the Direct detect gate
 * (src/agents/live_probe.ts), and the health probe (health/probe.ts), so the
 * command and its GH_AUTH_TIMEOUT_MS budget never drift between them. Callers
 * pick their own stdio (capture the token vs. keep it out of process memory).
 */
export function ghAuthTokenSpawnSpec(ghPath: string): {
  file: string;
  args: string[];
  shell: boolean;
  timeout: number;
  env: Record<string, string>;
} {
  const s = cliSpawn(ghPath, ["auth", "token"]);
  return { ...s, timeout: GH_AUTH_TIMEOUT_MS, env: childEnvWithPath([dirname(ghPath)]) };
}

/** Verdict over a finished `gh auth token` spawn (exported for tests): exit 0
 *  proves auth, any other completed exit proves its absence, and a spawn that
 *  never completed (an error, the timeout kill -- status null) proves NOTHING.
 *  "unproven" keeps the caller from handing out the false "run `gh auth login`"
 *  advice when gh was never actually asked. */
export function ghAuthVerdict(
  result: { status: number | null; error?: unknown },
): boolean | "unproven" {
  if (result.error || result.status === null) return "unproven";
  return result.status === 0;
}
