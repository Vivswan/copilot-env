// The Direct-mode GitHub credential as one domain object over the shared state
// store (`CopilotEnvState` → `.copilot-env-state.json`). It owns provider-driven
// resolution, status, and the state mutations (store / use-gh-cli / clear), so the
// agent config writers and health (`codex`/`claude`/`host`/`probe`) and the daemon
// (`start`) depend on THIS domain class rather than reaching into the `commands/`
// layer. The interactive + command surface (provider prompt, device-flow spawn,
// `runAuth`) stays in `src/commands/auth.ts`, the thin layer on top of this.
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { childPathPrepending, cliSpawn, resolveCommand } from "../utils/command.ts";
import { type AuthProvider, CopilotEnvState, type TokenProvider } from "./env_state.ts";
import { CopilotApiPaths } from "./paths.ts";

// The provider vocabulary is defined with the store that persists it (env_state);
// re-export it here so the auth command layer keeps importing it from `Credential`.
export type { AuthProvider, TokenProvider } from "./env_state.ts";
export { AUTH_PROVIDERS } from "./env_state.ts";

/** Provider + whether its credential resolves — the shared status for auth/health. */
export interface CredentialStatus {
  provider: AuthProvider | null;
  resolves: boolean;
}

/** Run `gh auth token` (nvm-safe), returning the trimmed token or null. */
export function ghAuthToken(): string | null {
  const ghPath = resolveCommand("gh");
  if (ghPath === null) return null;
  const s = cliSpawn(ghPath, ["auth", "token"]);
  const result = spawnSync(s.file, s.args, {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
    shell: s.shell,
    env: { ...process.env, PATH: childPathPrepending([dirname(ghPath)]) },
  });
  if (result.error || result.status !== 0) return null;
  return (result.stdout ?? "").trim() || null;
}

/**
 * The Direct GitHub credential, keyed off the recorded provider. Construct freely
 * (it's a thin façade over `CopilotEnvState`); pass an existing state instance only
 * to share one read/write cursor.
 */
export class Credential {
  private readonly state: CopilotEnvState;

  constructor(state: CopilotEnvState = new CopilotEnvState()) {
    this.state = state;
  }

  /** The recorded provider, or null when one was never chosen / is unrecognized. */
  provider(): AuthProvider | null {
    // CopilotEnvState validates `authProvider` against the picklist on read, so an
    // unknown/corrupt value already reads back as null — no extra guard needed here.
    return this.state.read().authProvider;
  }

  /**
   * The resolved Direct credential, driven STRICTLY by the recorded provider — NO
   * implicit `gh` fallback and no token-without-provider:
   *   - gh-cli           → `gh auth token` (live)
   *   - copilot/gh-token → the stored token
   *   - none / unknown   → null (the caller prompts / errors; never silently gh)
   */
  resolve(): string | null {
    const { githubToken, authProvider } = this.state.read();
    switch (authProvider) {
      case "gh-cli":
        return ghAuthToken();
      case "copilot":
      case "gh-token":
        return githubToken;
      default:
        return null;
    }
  }

  /**
   * True when auth is usable RIGHT NOW — the configured provider's credential
   * actually resolves. A recorded-but-broken provider (e.g. `gh-cli` after `gh`
   * logout) is NOT authenticated, so init/start/auth re-ask rather than silently
   * proceeding; and a bare `gh` login the user never opted into never counts.
   */
  isAuthenticated(): boolean {
    return this.resolve() !== null;
  }

  /** Provider + whether its credential resolves — for `--check` and health. */
  status(): CredentialStatus {
    return { provider: this.provider(), resolves: this.resolve() !== null };
  }

  /** Record a token-backed provider (copilot/gh-token) together with its token. */
  store(provider: TokenProvider, token: string): void {
    this.state.set({ githubToken: token, authProvider: provider });
  }

  /** Record `gh-cli`: rely on the machine's `gh` login, hold no token of our own. */
  useGhCli(): void {
    this.state.set({ githubToken: null, authProvider: "gh-cli" });
  }

  /**
   * De-authenticate: clear our store AND scrub copilot-api's own device-login file
   * (else a detached proxy could keep using that stale upstream token). Returns
   * whether anything was actually cleared.
   */
  clear(): boolean {
    const { githubToken, authProvider } = this.state.read();
    const had = githubToken !== null || authProvider !== null;
    this.state.set({ githubToken: null, authProvider: null });
    try {
      rmSync(new CopilotApiPaths().githubTokenFile, { force: true });
    } catch {
      // best-effort
    }
    return had;
  }
}
