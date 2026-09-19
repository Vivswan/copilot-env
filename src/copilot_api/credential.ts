// The Direct-mode GitHub credential over the shared state store (env_state.ts). The domain lives here
// so the agent config writers, health, and the daemon never import the `commands/` layer; the
// interactive surface (provider prompt, device flow, `runAuth`) is src/commands/auth.ts on top.
import { spawn, spawnSync } from "node:child_process";
import { findCommand } from "../utils/command.ts";
import {
  type AuthProvider,
  CopilotEnvState,
  credentialProvider,
  type ProvisionedCredential,
  type StoredCredential,
  type TokenProvider,
} from "./env_state.ts";
import {
  activeGhLogin,
  GH_COPILOT_HOST,
  type GhAccount,
  ghAuthStatusSpawnSpec,
  ghAuthTokenSpawnSpec,
  ghAuthVerdict,
  type GhSpawnResult,
  type GhSpawnSpec,
  parseGhAuthStatusAccounts,
} from "./gh_cli.ts";
import { type Profile, profileLabel } from "./profile.ts";

// The provider vocabulary is defined with the store that persists it (env_state);
// re-export it here so the auth command layer keeps importing it from `Credential`.
export type { AuthProvider } from "./env_state.ts";
export { AUTH_PROVIDERS } from "./env_state.ts";

interface CredentialStatus {
  provider: AuthProvider | null;
  resolves: boolean;
}

/** `unproven` means the look never RAN to completion (the gh probe or the spawn errored or was killed),
 *  so a consumer must say "could not check", never "gh is not authenticated". An unmarked null is
 *  proven: gh is absent, or it RAN and produced no token. */
export interface GhTokenLook {
  token: string | null;
  unproven?: true;
  /** Why there is no token: what the spawn or the `gh` probe reported (null token only). */
  detail?: string;
  /** The gh call that produced the token (token only), as a report names it. */
  command?: string;
}

function firstStderrLine(stderr: string | null | undefined): string {
  return (stderr ?? "").trim().split(/\r?\n/)[0]?.trim() ?? "";
}

/** The call as the user could retype it, so a miss names the gh call it reports. */
function ghCommandLabel(spec: Pick<GhSpawnSpec, "args">): string {
  return `gh ${spec.args.join(" ")}`;
}

/** Exported for tests. Empty output on exit 0 is a proven miss: gh RAN. The detail quotes the
 *  command and gh's first stderr line. */
export function ghTokenLookFromSpawn(
  result: GhSpawnResult,
  command = "gh auth token",
): GhTokenLook {
  const verdict = ghAuthVerdict(result);
  if (verdict === "unproven") {
    const cause = result.error instanceof Error ? result.error.message : "the spawn was killed";
    return { token: null, unproven: true, detail: `\`${command}\` did not complete (${cause})` };
  }
  const stderr = firstStderrLine(result.stderr);
  const said = stderr ? `: ${stderr}` : "";
  if (!verdict) return { token: null, detail: `\`${command}\` exited ${result.status}${said}` };
  const token = (result.stdout ?? "").trim();
  return token
    ? { token, command }
    : { token: null, detail: `\`${command}\` printed no token${said}` };
}

function runGhSpec(s: GhSpawnSpec): GhSpawnResult {
  // nosemgrep: javascript.lang.security.audit.spawn-shell-true.spawn-shell-true -- Windows-only, for .cmd shims; the spec quotes args
  return spawnSync(s.file, s.args, {
    encoding: "utf8",
    timeout: s.timeout,
    windowsHide: true,
    shell: s.shell,
    env: s.env,
  });
}

/** How long a settled child's pipes get to hand over their last bytes when something else still
 *  holds them open. */
const PIPE_HANDOVER_GRACE_MS = 100;

/**
 * Exported for tests. Settles on `exit`, never on `close`: a descendant gh left behind holding the
 * pipes (a credential helper, a browser opener) keeps `close` from firing for seconds while gh's
 * answer is already here. The streams then end on their own right after the exit; when they do
 * not, a short grace hands over what was read and the rest is the descendant's, not gh's.
 */
export function runGhSpecAsync(s: GhSpawnSpec): Promise<GhSpawnResult> {
  return new Promise((resolve) => {
    // nosemgrep: javascript.lang.security.audit.spawn-shell-true.spawn-shell-true -- Windows-only, for .cmd shims; the spec quotes args
    const child = spawn(s.file, s.args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: s.timeout,
      windowsHide: true,
      shell: s.shell,
      env: s.env,
    });
    let stdout = "";
    let stderr = "";
    let exited: Pick<GhSpawnResult, "status" | "error"> | null = null;
    let openStreams = 2;
    let settled = false;
    const finish = (): void => {
      if (settled || exited === null) return;
      settled = true;
      // Our ends of the pipes close with the answer; a descendant's writes are not gh's.
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ ...exited, stdout, stderr });
    };
    const streamEnded = (): void => {
      openStreams--;
      if (openStreams === 0) finish();
    };
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.stdout?.on("end", streamEnded);
    child.stderr?.on("end", streamEnded);
    const onExit = (result: Pick<GhSpawnResult, "status" | "error">): void => {
      exited = result;
      if (openStreams === 0) finish();
      else setTimeout(finish, PIPE_HANDOVER_GRACE_MS).unref();
    };
    child.on("error", (error) => onExit({ status: null, error }));
    child.on("exit", (code, signal) => onExit({ status: signal === null ? code : null }));
  });
}

/**
 * ONE gh call per look, on the shared recipe (ghAuthTokenSpawnSpec): the pinned `--user` form for a
 * pin, the plain `gh auth token` for gh's active account. The pin follows no `gh auth switch`; it
 * fails only when gh cannot serve that account (logged out, a hosts.yml login without an oauth
 * token, or gh older than 2.40), as a proven miss quoting gh's own refusal; the caller renders the
 * `gh auth login` advice. Exported for tests (`run` is the spawn seam).
 */
export function ghAuthTokenLookVia(
  ghUser: string | null,
  ghPath: string,
  run: (spec: GhSpawnSpec) => GhSpawnResult = runGhSpec,
): GhTokenLook {
  const spec = ghAuthTokenSpawnSpec(ghPath, ghUser);
  return ghTokenLookFromSpawn(run(spec), ghCommandLabel(spec));
}

/** The same call off the event loop, for probes that overlap other work (`agent health`). */
export async function ghAuthTokenLookAsync(
  ghUser: string | null,
  ghPath: string,
): Promise<GhTokenLook> {
  const spec = ghAuthTokenSpawnSpec(ghPath, ghUser);
  return ghTokenLookFromSpawn(await runGhSpecAsync(spec), ghCommandLabel(spec));
}

/** `ghUser` pins the call to that gh account; null follows gh's active account. */
export function ghAuthTokenLook(ghUser: string | null = null): GhTokenLook {
  const gh = findCommand("gh");
  if (gh.path === null) {
    return gh.launchFailed
      ? { token: null, unproven: true, detail: "looking for `gh` on PATH failed" }
      : { token: null, detail: "`gh` is not on this process's PATH" };
  }
  return ghAuthTokenLookVia(ghUser, gh.path);
}

/**
 * Accepted flatten: a FAILED look reads null here. Only for resolver consumers whose miss action is
 * non-destructive (report-and-ask, a skipped import slot, a profile re-acquisition). A site that
 * renders a gh AUTH verdict goes through ghAuthTokenLook and honors the `unproven` mark.
 */
export function ghAuthToken(ghUser: string | null = null): string | null {
  return ghAuthTokenLook(ghUser).token;
}

/** The account listing: a choice-menu and naming input. chooseGhAccount refuses both marked shapes:
 *  an unproven listing asks for a retry, an empty one for `gh auth login`. */
export interface GhAccountsLook {
  accounts: GhAccount[];
  unproven?: true;
}

/** Exported for tests. Two gh quirks shape it:
 *    non-zero exit  -> still parsed; `gh auth status` fails when one account is broken but lists the healthy ones
 *    stderr merged  -> older gh wrote the listing there */
export function ghAccountsLookFromSpawn(result: GhSpawnResult): GhAccountsLook {
  if (ghAuthVerdict(result) === "unproven") return { accounts: [], unproven: true };
  return { accounts: parseGhAuthStatusAccounts(`${result.stdout ?? ""}\n${result.stderr ?? ""}`) };
}

export function ghAccountsLook(): GhAccountsLook {
  const gh = findCommand("gh");
  if (gh.path === null) {
    return gh.launchFailed ? { accounts: [], unproven: true } : { accounts: [] };
  }
  return ghAccountsLookFromSpawn(runGhSpec(ghAuthStatusSpawnSpec(gh.path)));
}

/**
 * A thin facade over CopilotEnvState; pass an existing state only to share one read/write cursor.
 * `profile` addresses that named profile's slot, and a named profile NEVER falls back to the default
 * credential: ask, never silently fall back.
 */
export class Credential {
  private readonly state: CopilotEnvState;
  private readonly profile: Profile;

  constructor(state: CopilotEnvState = new CopilotEnvState(), profile: Profile = null) {
    this.state = state;
    this.profile = profile;
  }

  read(): StoredCredential {
    return this.state.readCredential(this.profile);
  }

  provider(): AuthProvider | null {
    // env_state.ts parses the slot at the read boundary, so a corrupt provider already reads as none.
    return credentialProvider(this.read());
  }

  /**
   * NO implicit `gh` fallback: none -> null, and the caller prompts or errors. `gh` substitutes the
   * gh-cli probe so batch callers (the settings-bundle import) memoize one spawn per pinned account;
   * it never changes WHICH source is consulted.
   */
  resolve(gh: (ghUser: string | null) => string | null = ghAuthToken): string | null {
    const credential = this.read();
    switch (credential.kind) {
      case "stored":
        return credential.token;
      case "gh-cli":
        return gh(credential.ghUser);
      case "none":
        return null;
    }
  }

  /**
   * The gh-cli reason comes from THE look that failed, never a second one, so a recorded-but-broken
   * provider never reads as "not logged in" (`agent auth` would then say the opposite). `look` is the test seam.
   */
  resolveWithReason(
    look: (ghUser: string | null) => GhTokenLook = ghAuthTokenLook,
  ): { token: string; reason: null } | { token: null; reason: string } {
    const credential = this.read();
    const slot = this.profile === null ? "" : ` for ${profileLabel(this.profile)}`;
    switch (credential.kind) {
      case "stored":
        return { token: credential.token, reason: null };
      case "none": {
        const login = this.profile === null
          ? "run `agent auth` to log in"
          : `run \`agent profile ${this.profile} auth\` to log in ` +
            "(a named profile never falls back to the default credential)";
        return { token: null, reason: `no GitHub credential configured${slot} - ${login}` };
      }
      case "gh-cli": {
        const probe = look(credential.ghUser);
        if (probe.token !== null) return { token: probe.token, reason: null };
        const who = credential.ghUser === null ? "gh-cli" : `gh-cli as ${credential.ghUser}`;
        const detail = probe.detail ?? "gh gave no token";
        const path = detail.includes("PATH")
          ? " (an MCP client or IDE may start this process with a minimal PATH)"
          : "";
        return {
          token: null,
          reason:
            `provider '${who}' is selected${slot} but no credential resolves: ${detail}${path}`,
        };
      }
    }
  }

  /** Usable RIGHT NOW: a recorded-but-broken provider (gh-cli after `gh` logout) is NOT authenticated,
   *  so init/auth re-ask and start refuses, and a bare `gh` login the user never opted into never counts. */
  isAuthenticated(): boolean {
    return this.resolve() !== null;
  }

  status(): CredentialStatus {
    return { provider: this.provider(), resolves: this.resolve() !== null };
  }

  /** A NAMED profile must already exist: creation is `agent profile <name> add`'s atomic commit, so this
   *  never leaves a half profile behind. */
  record(credential: ProvisionedCredential): void {
    this.state.setCredential(this.profile, credential);
  }

  store(provider: TokenProvider, token: string): void {
    this.record({ kind: "stored", provider, token });
  }

  clear(): boolean {
    return this.state.clearCredential(this.profile);
  }
}

/** BRACKET-FREE by contract: a surface that wants parens adds its own. */
export function credentialSourceLabel(credential: StoredCredential): string | null {
  switch (credential.kind) {
    case "none":
    case "stored":
      return credential.provider;
    case "gh-cli":
      return credential.ghUser === null ? "gh-cli" : `gh-cli as ${credential.ghUser}`;
  }
}

/** An AUTO gh-cli slot names the account it follows right now and every account it may use, so a
 *  read-back through here says whose credit the credential can spend; an unproven or empty look
 *  never guesses. A batch caller passes one memoized `look`. */
export function liveCredentialSourceLabel(
  credential: StoredCredential,
  look: () => GhAccountsLook = ghAccountsLook,
): string | null {
  if (credential.kind === "gh-cli" && credential.ghUser === null) {
    const accounts = look().accounts;
    const active = activeGhLogin(accounts);
    const logins = [
      ...new Set(
        accounts
          .filter((a) => a.host === GH_COPILOT_HOST && a.login !== "")
          .map((a) => a.login),
      ),
    ];
    const parts = [
      active === null ? null : `currently ${active}`,
      logins.length === 0 ? null : `may use ${logins.join(", ")}`,
    ].filter((part) => part !== null);
    // Bracket-free like credentialSourceLabel: the callers add the one paren level.
    return `gh-cli on auto${parts.length === 0 ? "" : `: ${parts.join("; ")}`}`;
  }
  return credentialSourceLabel(credential);
}
