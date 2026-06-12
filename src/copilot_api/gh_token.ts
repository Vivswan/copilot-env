// The provisioned GitHub token — copilot-env's SINGLE source of truth for the
// baked Direct credential (Codex/Claude) and the proxy's `--github-token`.
//
// Stored in a SHARED file under the copilot-api home (`.copilot-env-state.json`),
// NOT in the per-host `.run/<host>/.state.json`: the token is account/machine-wide
// and must apply regardless of which host/node runs an agent. Resolution order
// everywhere: an explicit `agent init --gh-token` (written here) > this stored
// token > the `gh` CLI. `--remove-gh-token` clears it.
import { CopilotApiConfig } from "./config.ts";
import { CopilotApiPaths } from "./paths.ts";

/** The shared JSON store (atomic write, 0600), reused from CopilotApiConfig. */
function store(): CopilotApiConfig {
  return new CopilotApiConfig(new CopilotApiPaths().sharedStateFile);
}

/** The stored GitHub token, or null when none is set / it's blank. */
export function readStoredGithubToken(): string | null {
  const value = store().load().githubToken;
  return typeof value === "string" && value.trim() ? value : null;
}

/** Persist `token` (trimmed) as the provisioned GitHub token. */
export function storeGithubToken(token: string): void {
  store().update((d) => {
    d.githubToken = token.trim();
  });
}

/** Remove the stored GitHub token (revert to the `gh` CLI / proxy device login). */
export function clearGithubToken(): void {
  store().update((d) => {
    delete d.githubToken;
  });
}
