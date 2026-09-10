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

/** The one host Copilot authenticates against. A pinned account is chosen from
 *  this host's logins, so the pinned resolve names it explicitly -- otherwise a
 *  GH_HOST override would point `--user` at another host's accounts. */
export const GH_COPILOT_HOST = "github.com";

/** A GitHub login's shape: 1-39 alphanumerics/dashes, plus underscore for EMU
 *  accounts ("user_shortcode"). Doubles as the spawn-safety gate for the pinned
 *  `--user` argument: no cmd.exe metacharacter (%, quotes, carets) fits it, so
 *  the Windows cliSpawn hop can never rewrite a pin into a different account.
 *  Every pin write and read funnels through it. */
export const GH_LOGIN_RE = /^[A-Za-z0-9_-]{1,39}$/;

/**
 * The ONE recipe for probing gh's login, shared by the token capture, the Direct detect
 * gate, and the health probe so the command and its GH_AUTH_TIMEOUT_MS budget never drift.
 * Spawns `gh auth token` at gh's RESOLVED path with gh's bin dir on PATH, so an nvm-only or
 * node-shim gh is runnable; cliSpawn routes through cmd.exe on Windows for .cmd/.exe shims.
 * Success = exit 0. Callers pick their own stdio (capture the token vs. keep it out of
 * process memory). `ghUser` pins the call to that account (`--user` on GH_COPILOT_HOST,
 * the host it was chosen from); null follows gh's active account.
 */
export function ghAuthTokenSpawnSpec(ghPath: string, ghUser: string | null = null): GhSpawnSpec {
  const s = cliSpawn(
    ghPath,
    ghUser === null
      ? ["auth", "token"]
      : ["auth", "token", "--user", ghUser, "--hostname", GH_COPILOT_HOST],
  );
  return { ...s, timeout: GH_AUTH_TIMEOUT_MS, env: childEnvWithPath([dirname(ghPath)]) };
}

/** The shared spawn shape for the gh recipes above/below. */
export interface GhSpawnSpec {
  file: string;
  args: string[];
  shell: boolean;
  timeout: number;
  env: Record<string, string>;
}

/**
 * The recipe for listing gh's logged-in accounts: `gh auth status --hostname
 * github.com`, same resolved-path/PATH/timeout treatment as
 * ghAuthTokenSpawnSpec. Scoped to GH_COPILOT_HOST because only its accounts can
 * be pinned -- a bare status probes EVERY known host, and one unreachable
 * enterprise host could eat the whole timeout and silently cost the picker.
 * The output is machine-parsed, so the color-forcing env vars are stripped and
 * NO_COLOR is set: forced ANSI would corrupt the captured logins. Callers
 * capture BOTH stdout and stderr (older gh wrote the status to stderr).
 */
export function ghAuthStatusSpawnSpec(ghPath: string): GhSpawnSpec {
  const s = cliSpawn(ghPath, ["auth", "status", "--hostname", GH_COPILOT_HOST]);
  const colorForcers = ["CLICOLOR", "CLICOLOR_FORCE", "FORCE_COLOR", "GH_FORCE_TTY"];
  return {
    ...s,
    timeout: GH_AUTH_TIMEOUT_MS,
    env: childEnvWithPath([dirname(ghPath)], {
      extra: { "NO_COLOR": "1" },
      omit: (upper) => colorForcers.includes(upper),
    }),
  };
}

/** One logged-in gh account as `gh auth status` reports it. */
export interface GhAccount {
  host: string;
  login: string;
  active: boolean;
  /** Where gh got the credential -- the WINNING source only (`keyring`, a config
   *  path, or an env var name like `GH_TOKEN`; blank when gh printed no source
   *  parens). An env var SHADOWS a saved keyring credential for the same login
   *  in this display, so the source never proves whether `gh auth token --user`
   *  can serve the account -- membership is verified at selection time
   *  (loginWithGhCli), never guessed from here. */
  source: string;
  /** The block was a FAILED login (bad/timed-out credential): never offered in
   *  the picker, but kept so its active marker still names the account gh's
   *  auto resolution follows. gh's per-host env-token failure wording carries
   *  no login (""). */
  broken?: true;
}

/** The github.com login an AUTO gh-cli slot is following right now: the ACTIVE
 *  account (a broken active login still names itself -- it IS what auto
 *  follows), or the only account when gh marked none active (older gh; the
 *  only-login fallback needs the WHOLE list to agree, broken entries included,
 *  so a dropped-marker ambiguity never names the wrong account). Null when
 *  nothing can be named honestly. Pure over a parsed account list so every
 *  renderer names the same account. */
export function activeGhLogin(accounts: GhAccount[]): string | null {
  const github = accounts.filter((a) => a.host === GH_COPILOT_HOST);
  const active = github.find((a) => a.active) ?? null;
  if (active !== null) return active.login === "" ? null : active.login;
  // Agreement BEFORE dropping unnamed entries: an unnamed broken sibling makes
  // the followed account ambiguous, so nothing is named.
  const logins = [...new Set(github.map((a) => a.login))];
  if (logins.length !== 1) return null;
  const only = logins[0] ?? "";
  return only === "" ? null : only;
}

/**
 * Parse `gh auth status` text into the logged-in accounts. STRICTLY a
 * choice-menu/naming input (which accounts exist, which is active) -- never an
 * auth verdict; those stay with `gh auth token` via ghAuthVerdict. Broken
 * logins are kept, marked `broken` (their active marker still names gh's
 * followed account), and unrecognized output parses as no accounts.
 */
export function parseGhAuthStatusAccounts(output: string): GhAccount[] {
  const accounts: GhAccount[] = [];
  const seen = new Set<string>();
  let current: GhAccount | null = null;
  const push = (account: GhAccount): GhAccount => {
    const key = `${account.host}|${account.login}|${account.source}|${account.broken ?? false}`;
    // Dedup EXACT repeats only (host+login+source): gh lists an env-token
    // login before the saved accounts, and the same login can appear under
    // both sources -- collapsing those would drop the pinnable saved entry.
    if (!seen.has(key)) {
      seen.add(key);
      accounts.push(account);
    }
    return account;
  };
  for (const line of output.split(/\r?\n/)) {
    const login = line.match(/Logged in to (\S+) account (\S+)(?: \(([^)]*)\))?/);
    if (login) {
      // \S+ can't produce an empty capture; the defaults only satisfy the
      // indexed-access strictness (the source parens are genuinely optional).
      const [, host = "", name = "", source = ""] = login;
      current = push({ host, login: name, active: false, source });
      continue;
    }
    // A broken login starts its own block, in ANY of gh's failure wordings
    // ("Failed to log in to <host> account <login> (...)", "... using token
    // (ENV)", "Timeout trying to log in to ..."): all contain "log in to",
    // which the success line ("Logged in to") never does. The block is KEPT
    // (marked broken) so its "Active account: true" line attributes to it --
    // never to the last healthy account, and never dropped: gh's auto
    // resolution follows the active account even while its login is broken.
    const failed = line.match(/\blog in to (\S+)(?: account (\S+)| using \S+)?(?: \(([^)]*)\))?/);
    if (failed) {
      const [, host = "", name, source = ""] = failed;
      current = push({ host, "login": name ?? "", active: false, source, "broken": true });
      continue;
    }
    if (current !== null && /Active account:\s*true/.test(line)) current.active = true;
  }
  return accounts;
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
