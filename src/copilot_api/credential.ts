// The Direct-mode GitHub credential as one domain object over the shared state
// store (`CopilotEnvState` -> `credentials.json`). It owns provider-driven
// resolution, status, and the state mutations (store / use-gh-cli / clear), so the
// agent config writers and health (`codex`/`claude`/`host`/`probe`) and the daemon
// (`start`) depend on THIS domain class rather than reaching into the `commands/`
// layer. The interactive + command surface (provider prompt, device-flow spawn,
// `runAuth`) stays in `src/commands/auth.ts`, the thin layer on top of this.
import { spawnSync } from "node:child_process";
import { findCommand } from "../utils/command.ts";
import { withFileLockSync } from "../utils/file_lock.ts";
import { removeReported } from "../utils/report_write.ts";
import {
  type AuthProvider,
  CopilotEnvState,
  credentialProvider,
  type ProvisionedCredential,
  type StoredCredential,
  type TokenProvider,
} from "./env_state.ts";
import {
  type GhAccount,
  ghAuthStatusSpawnSpec,
  ghAuthTokenSpawnSpec,
  ghAuthVerdict,
  parseGhAuthStatusAccounts,
} from "./gh_cli.ts";
import { CopilotApiPaths } from "./paths.ts";
import { type Profile, profileLabel } from "./profile.ts";

// The provider vocabulary is defined with the store that persists it (env_state);
// re-export it here so the auth command layer keeps importing it from `Credential`.
export type { AuthProvider, TokenProvider } from "./env_state.ts";
export { AUTH_PROVIDERS } from "./env_state.ts";

/** Provider + whether its credential resolves -- the shared status for auth/health. */
export interface CredentialStatus {
  provider: AuthProvider | null;
  resolves: boolean;
}

/** One look for the `gh auth token` credential, failure arm kept: `token` null
 *  with the `unproven` mark means the look never RAN to completion (the command
 *  probe for gh, or the `gh auth token` spawn itself, errored or was killed) --
 *  gh was never actually asked, so a consumer rendering a verdict must say
 *  "could not check", never "gh is not authenticated" (or advise `gh auth
 *  login`) off it. An unmarked null is proven: gh is absent, or it RAN and
 *  produced no token. */
export interface GhTokenLook {
  token: string | null;
  unproven?: true;
  /** Why there is no token: what the spawn or the `gh` probe reported (null token only). */
  detail?: string;
}

function firstStderrLine(stderr: string | null | undefined): string {
  return (stderr ?? "").trim().split(/\r?\n/)[0]?.trim() ?? "";
}

/** Pure fold of a finished `gh auth token` capture spawn into a GhTokenLook
 *  (exported for tests): ghAuthVerdict's three states, with exit 0 reading the
 *  trimmed token -- empty output on exit 0 is a proven miss (gh RAN). */
export function ghTokenLookFromSpawn(
  result: {
    status: number | null;
    error?: unknown;
    stdout?: string | null;
    stderr?: string | null;
  },
): GhTokenLook {
  const verdict = ghAuthVerdict(result);
  if (verdict === "unproven") {
    const cause = result.error instanceof Error ? result.error.message : "the spawn was killed";
    return { token: null, unproven: true, detail: `\`gh auth token\` did not complete (${cause})` };
  }
  const stderr = firstStderrLine(result.stderr);
  if (!verdict) {
    return {
      token: null,
      detail: `\`gh auth token\` exited ${result.status}${stderr ? `: ${stderr}` : ""}`,
    };
  }
  const token = (result.stdout ?? "").trim();
  return token ? { token } : { token: null, detail: "`gh auth token` printed no token" };
}

/** Run `gh auth token` (nvm-safe) with the failure arm kept (see GhTokenLook).
 *  `ghUser` pins the call to that gh account (`--user`); null = the active one. */
export function ghAuthTokenLook(ghUser: string | null = null): GhTokenLook {
  const gh = findCommand("gh");
  if (gh.path === null) {
    return gh.launchFailed
      ? { token: null, unproven: true, detail: "looking for `gh` on PATH failed" }
      : { token: null, detail: "`gh` is not on this process's PATH" };
  }
  const s = ghAuthTokenSpawnSpec(gh.path, ghUser);
  // nosemgrep: javascript.lang.security.audit.spawn-shell-true.spawn-shell-true -- Windows-only, for .cmd shims; the spec quotes args
  const result = spawnSync(s.file, s.args, {
    encoding: "utf8",
    timeout: s.timeout,
    windowsHide: true,
    shell: s.shell,
    env: s.env,
  });
  return ghTokenLookFromSpawn(result);
}

/**
 * Run `gh auth token` (nvm-safe), returning the trimmed token or null. Accepted
 * flatten: a FAILED look (ghAuthTokenLook's unproven) reads null here, for
 * resolver consumers whose miss action is non-destructive and provider-driven
 * (report-and-ask, a skipped import slot, a profile re-acquisition) -- null
 * never silently falls anywhere. A site that renders a gh AUTH verdict ("not
 * authenticated", `gh auth login` advice) goes through ghAuthTokenLook and
 * treats the mark honestly.
 */
export function ghAuthToken(ghUser: string | null = null): string | null {
  return ghAuthTokenLook(ghUser).token;
}

/** One look for the machine's logged-in gh accounts, failure arm kept like
 *  GhTokenLook: `unproven` means the look never RAN to completion. STRICTLY a
 *  choice-menu input (does the user have accounts to pick between?) -- never an
 *  auth verdict, so every consumer degrades an unproven/empty look to "follow
 *  gh's active account" (today's behavior) instead of rendering advice off it. */
export interface GhAccountsLook {
  accounts: GhAccount[];
  unproven?: true;
}

/** Pure fold of a finished `gh auth status` capture spawn into a GhAccountsLook
 *  (exported for tests). ANY completed exit parses the output -- `gh auth
 *  status` exits non-zero when one account's login is broken but still lists the
 *  healthy ones -- and stdout+stderr are merged (older gh wrote to stderr). */
export function ghAccountsLookFromSpawn(
  result: {
    status: number | null;
    error?: unknown;
    stdout?: string | null;
    stderr?: string | null;
  },
): GhAccountsLook {
  if (ghAuthVerdict(result) === "unproven") return { accounts: [], unproven: true };
  return { accounts: parseGhAuthStatusAccounts(`${result.stdout ?? ""}\n${result.stderr ?? ""}`) };
}

/** Run `gh auth status` (nvm-safe) and list the logged-in accounts, failure arm
 *  kept (see GhAccountsLook). */
export function ghAccountsLook(): GhAccountsLook {
  const gh = findCommand("gh");
  if (gh.path === null) {
    return gh.launchFailed ? { accounts: [], unproven: true } : { accounts: [] };
  }
  const s = ghAuthStatusSpawnSpec(gh.path);
  // nosemgrep: javascript.lang.security.audit.spawn-shell-true.spawn-shell-true -- Windows-only, for .cmd shims; the spec quotes args
  const result = spawnSync(s.file, s.args, {
    encoding: "utf8",
    timeout: s.timeout,
    windowsHide: true,
    shell: s.shell,
    env: s.env,
  });
  return ghAccountsLookFromSpawn(result);
}

/**
 * The Direct GitHub credential, keyed off the recorded provider. Construct freely
 * (it's a thin facade over `CopilotEnvState`); pass an existing state instance only
 * to share one read/write cursor. `profile` addresses that named profile's slot
 * instead of the default (reserved) slot; the store's readCredential/setCredential
 * pair is the single routing point, and a named profile NEVER falls back to the
 * default credential (ask, never silently fall back).
 */
export class Credential {
  private readonly state: CopilotEnvState;
  private readonly profile: Profile;

  constructor(state: CopilotEnvState = new CopilotEnvState(), profile: Profile = null) {
    this.state = state;
    this.profile = profile;
  }

  /** The parsed credential in the addressed slot (the StoredCredential union). */
  read(): StoredCredential {
    return this.state.readCredential(this.profile);
  }

  /** The recorded provider, or null when one was never chosen / is unrecognized. */
  provider(): AuthProvider | null {
    // CopilotEnvState parses the slot at the read boundary, so an unknown/corrupt
    // provider already reads back as none -- no extra guard needed here.
    return credentialProvider(this.read());
  }

  /**
   * The resolved Direct credential, driven STRICTLY by the parsed credential: NO
   * implicit `gh` fallback (none -> null; the caller prompts or errors) and no
   * token-without-provider (unrepresentable in the union). gh-cli -> `gh auth
   * token` (live); stored -> the stored token (copilot/gh-token). `gh` substitutes
   * the gh-cli probe: batch callers (the settings-bundle import resolves many slots
   * in one run) pass a memoized wrapper so the subprocess spawns once per pinned
   * account, not per slot. It never changes WHICH source is consulted, and the
   * slot's recorded account pin (null = gh's active account) is what it receives.
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
   * One probe, both answers: the token, or why there is none (the caller's error
   * text). The gh-cli reason comes from THE look that failed, never a second one,
   * so it names the recorded provider and quotes what gh or its lookup reported;
   * a recorded-but-broken provider must never read as "not logged in" (`agent auth`
   * would then say the opposite). `look` substitutes the probe (tests).
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
          : `run \`agent auth --profile ${this.profile}\` to log in ` +
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

  /**
   * True when auth is usable RIGHT NOW -- the configured provider's credential
   * actually resolves. A recorded-but-broken provider (e.g. `gh-cli` after `gh`
   * logout) is NOT authenticated, so init/start/auth re-ask rather than silently
   * proceeding; and a bare `gh` login the user never opted into never counts.
   */
  isAuthenticated(): boolean {
    return this.resolve() !== null;
  }

  /** Provider + whether its credential resolves -- for `--check` and health. */
  status(): CredentialStatus {
    return { provider: this.provider(), resolves: this.resolve() !== null };
  }

  /** Record the provisioned credential into the addressed slot whole (the union
   *  makes token-without-provider / token-with-gh-cli unwritable). A NAMED
   *  profile must already exist -- creation is `agent profile --add`'s atomic
   *  commit, so this can never leave a half profile behind. */
  record(credential: ProvisionedCredential): void {
    this.state.setCredential(this.profile, credential);
  }

  /** Record a token-backed provider (copilot/gh-token) together with its token. */
  store(provider: TokenProvider, token: string): void {
    this.record({ kind: "stored", provider, token });
  }

  /** Record `gh-cli`: rely on the machine's `gh` login, hold no token of our own.
   *  `ghUser` pins the slot to that logged-in gh account; null follows gh's
   *  active account at every resolve. */
  useGhCli(ghUser: string | null = null): void {
    this.record({ kind: "gh-cli", ghUser });
  }

  /**
   * De-authenticate: clear our store AND -- default profile only -- scrub
   * copilot-api's own device-login file (else a detached proxy could keep using
   * that stale upstream token; a named profile's device-flow login already
   * scrubbed it at login time). The scrub briefly takes the same login lock the
   * device flow holds (bounded wait), so a `--del` racing a mid-login cannot
   * delete the token between its creation and its read; if a live login holds
   * the lock past the bound we skip the scrub rather than hang (the login's own
   * scrub covers the file). Returns whether anything was actually cleared.
   */
  clear(): boolean {
    const had = this.state.clearCredential(this.profile);
    if (this.profile === null) {
      const { githubTokenFile: tokenFile, githubTokenLoginLock: lockPath } = new CopilotApiPaths();
      withFileLockSync(
        lockPath,
        { staleMs: Number.POSITIVE_INFINITY, waitMs: 2000, retryMs: 100 },
        (outcome) => {
          if (!outcome.held) return; // a live login holds it past the bound: skip the scrub
          try {
            removeReported(tokenFile);
          } catch {
            // best-effort
          }
        },
      );
    }
    return had;
  }
}
