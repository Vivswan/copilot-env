// The gh-token env vars and the ONE recipe for probing gh's login, kept apart from credential.ts so the
// CLI help strings and the Direct probes name the same contract without importing the live-probe machinery.
import { dirname } from "node:path";
import { childEnvWithPath, cliSpawn } from "../utils/command.ts";

/** Most specific first; reading a token from the environment keeps the secret out of argv and shell history. */
export const GH_TOKEN_ENV_VARS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;

/** Help text and prompt labels derive from the list so they can never drift from what ghTokenFromEnv reads. */
export function ghTokenEnvVarsLabel(separator = "/"): string {
  return GH_TOKEN_ENV_VARS.map((name) => `$${name}`).join(separator);
}

export function ghTokenEnvVarsList(): string {
  return GH_TOKEN_ENV_VARS.join(" / ");
}

export function ghTokenFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const name of GH_TOKEN_ENV_VARS) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return null;
}

/**
 * `true` (a bare `--provider gh-token`) reads GH_TOKEN_ENV_VARS; a string is the token itself. The narrow
 * overload proves a definite request always yields a token or throws, so those callers never handle null.
 */
export function tokenFromSetFlag(flag: string | true): string;
export function tokenFromSetFlag(flag: string | boolean | undefined): string | null;
export function tokenFromSetFlag(flag: string | boolean | undefined): string | null {
  // `false` is treated as absence rather than the literal token "false".
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

/** Shared by every "is gh authenticated?" probe. */
export const GH_AUTH_TIMEOUT_MS = 5000;

/** A pinned account is chosen from this host's logins, so the pinned resolve names it explicitly:
 *  otherwise a GH_HOST override would point `--user` at another host's accounts. */
export const GH_COPILOT_HOST = "github.com";

/** A GitHub login: 1-39 alphanumerics and dashes, plus underscore for EMU accounts ("user_shortcode").
 *  Doubles as the spawn-safety gate for the pinned `--user` argument: no cmd.exe metacharacter fits it,
 *  so the Windows cliSpawn hop can never rewrite a pin into a different account. */
export const GH_LOGIN_RE = /^[A-Za-z0-9_-]{1,39}$/;

/**
 * One recipe for the token capture, the Direct detect gate, and the health probe, so the command and
 * its timeout never drift.
 *
 *   gh's RESOLVED path, its bin dir on PATH  -> an nvm-only or node-shim gh runs
 *   a Windows .cmd/.exe shim                 -> cliSpawn routes it through cmd.exe
 *   stdio                                    -> the caller's: capture the token, or keep it out of process memory
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

export interface GhSpawnSpec {
  file: string;
  args: string[];
  shell: boolean;
  timeout: number;
  env: Record<string, string>;
}

/**
 * Scoped to GH_COPILOT_HOST because only its accounts can be pinned, and the output is machine-parsed.
 *
 *   a bare status                    -> probes EVERY known host; one unreachable enterprise host eats the timeout
 *   forced ANSI                      -> corrupts the captured logins, so color forcers are stripped and NO_COLOR set
 *   older gh wrote status to stderr  -> callers capture BOTH streams
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

export interface GhAccount {
  host: string;
  login: string;
  active: boolean;
  /** The WINNING source only (`keyring`, a config path, an env var name; blank when gh printed none).
   *  An env var SHADOWS a saved keyring credential for the same login here, so the source never proves
   *  whether `gh auth token --user` can serve the account; loginWithGhCli verifies that at selection time. */
  source: string;
  /** A FAILED login is never offered in the picker but is kept so its active marker still names the
   *  account gh's auto resolution follows. gh's per-host env-token failure wording carries no login (""). */
  broken?: true;
}

/** The ACTIVE github.com account (a broken one still names itself: it IS what auto follows), else the
 *  only account when gh marked none active (older gh). The only-login fallback needs the WHOLE list to
 *  agree, broken entries included, so a dropped-marker ambiguity never names the wrong account. */
export function activeGhLogin(accounts: GhAccount[]): string | null {
  const github = accounts.filter((a) => a.host === GH_COPILOT_HOST);
  const active = github.find((a) => a.active) ?? null;
  if (active !== null) return active.login === "" ? null : active.login;
  // Agreement BEFORE dropping unnamed entries: an unnamed broken sibling makes the followed account ambiguous.
  const logins = [...new Set(github.map((a) => a.login))];
  if (logins.length !== 1) return null;
  const only = logins[0] ?? "";
  return only === "" ? null : only;
}

/**
 * STRICTLY a choice-menu and naming input, never an auth verdict (that stays with ghAuthVerdict).
 * Broken logins are kept and marked; unrecognized output parses as no accounts.
 */
export function parseGhAuthStatusAccounts(output: string): GhAccount[] {
  const accounts: GhAccount[] = [];
  const seen = new Set<string>();
  let current: GhAccount | null = null;
  const push = (account: GhAccount): GhAccount => {
    const key = `${account.host}|${account.login}|${account.source}|${account.broken ?? false}`;
    // Dedup EXACT repeats only: gh lists an env-token login before the saved accounts, and the same login
    // under both sources must keep the pinnable saved entry.
    if (!seen.has(key)) {
      seen.add(key);
      accounts.push(account);
    }
    return account;
  };
  for (const line of output.split(/\r?\n/)) {
    const login = line.match(/Logged in to (\S+) account (\S+)(?: \(([^)]*)\))?/);
    if (login) {
      // \S+ cannot produce an empty capture; the defaults only satisfy indexed-access strictness.
      const [, host = "", name = "", source = ""] = login;
      current = push({ host, login: name, active: false, source });
      continue;
    }
    // Every gh failure wording contains "log in to", which the success line ("Logged in to") never does.
    // The block is KEPT so its "Active account: true" line attributes to it, never to the last healthy account.
    //   "Failed to log in to <host> account <login> (...)"
    //   "Failed to log in to <host> using token (ENV)"
    //   "Timeout trying to log in to <host> ..."
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

/** Exported for tests. A spawn that never completed (an error, the timeout kill) proves NOTHING, and
 *  "unproven" keeps the caller from handing out false "run `gh auth login`" advice. */
export function ghAuthVerdict(
  result: { status: number | null; error?: unknown },
): boolean | "unproven" {
  if (result.error || result.status === null) return "unproven";
  return result.status === 0;
}
