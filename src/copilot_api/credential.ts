// The Direct-mode GitHub credential over the shared state store (env_state.ts). The domain lives here
// so the agent config writers, health, and the daemon never import the `commands/` layer; the
// interactive surface (provider prompt, device flow, `runAuth`) is src/commands/auth.ts on top.
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

export interface CredentialStatus {
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
}

function firstStderrLine(stderr: string | null | undefined): string {
  return (stderr ?? "").trim().split(/\r?\n/)[0]?.trim() ?? "";
}

/** Exported for tests. Empty output on exit 0 is a proven miss: gh RAN. */
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

/** `ghUser` pins the call to that gh account; null follows gh's active account. */
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
 * Accepted flatten: a FAILED look reads null here. Only for resolver consumers whose miss action is
 * non-destructive (report-and-ask, a skipped import slot, a profile re-acquisition). A site that
 * renders a gh AUTH verdict goes through ghAuthTokenLook and honors the `unproven` mark.
 */
export function ghAuthToken(ghUser: string | null = null): string | null {
  return ghAuthTokenLook(ghUser).token;
}

/** STRICTLY a choice-menu input, never an auth verdict: every consumer degrades an unproven or empty
 *  look to "follow gh's active account" instead of rendering advice off it. */
export interface GhAccountsLook {
  accounts: GhAccount[];
  unproven?: true;
}

/** Exported for tests. Two gh quirks shape it:
 *    non-zero exit  -> still parsed; `gh auth status` fails when one account is broken but lists the healthy ones
 *    stderr merged  -> older gh wrote the listing there */
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

  /** Usable RIGHT NOW: a recorded-but-broken provider (gh-cli after `gh` logout) is NOT authenticated,
   *  so init/start/auth re-ask, and a bare `gh` login the user never opted into never counts. */
  isAuthenticated(): boolean {
    return this.resolve() !== null;
  }

  status(): CredentialStatus {
    return { provider: this.provider(), resolves: this.resolve() !== null };
  }

  /** A NAMED profile must already exist: creation is `agent profile --add`'s atomic commit, so this
   *  never leaves a half profile behind. */
  record(credential: ProvisionedCredential): void {
    this.state.setCredential(this.profile, credential);
  }

  store(provider: TokenProvider, token: string): void {
    this.record({ kind: "stored", provider, token });
  }

  /** Holds no token of our own; a null `ghUser` follows gh's active account at every resolve. */
  useGhCli(ghUser: string | null = null): void {
    this.record({ kind: "gh-cli", ghUser });
  }

  /**
   * Default profile only: also scrub copilot-api's own device-login file, else a detached proxy could
   * keep using that stale upstream token (a named profile's login already scrubbed it at login time).
   * The scrub takes the login lock the device flow holds (bounded wait), so a `--del` racing a mid-login
   * cannot delete the token between its creation and its read; past the bound, the login's own scrub covers it.
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
