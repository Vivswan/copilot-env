// The backend an agent's config selects, shared by the Codex and Claude config
// writers so the type and the `--check` exit-code contract cannot drift apart
// (the `cl`/`cx` launchers consume that exit code, so two copies would be a real
// hazard). The per-agent `providerModeDetail` strings stay in each writer — they
// legitimately differ — only the shape and the exit code are shared here.
//   - direct: the agent talks to GitHub Copilot directly.
//   - proxy:  the agent talks to the local copilot-api proxy.
//   - other:  a foreign/custom config we do not manage.
//   - none:   unconfigured (the proxy is the default backend).

/** Which backend an agent's config selects. */
export type AgentProviderMode = "direct" | "proxy" | "other" | "none";

/** The two modes copilot-env actively manages (writes). */
export type ManagedAgentMode = Extract<AgentProviderMode, "direct" | "proxy">;

/**
 * The `agent codex --check` / `agent claude --check` exit code — a launcher
 * contract the `cl`/`cx` wrappers read: 0 = direct (launch as-is), 1 = other
 * (a custom config the launcher must NOT take over), 2 = proxy or none (the proxy
 * is the default backend, so the launcher ensures it).
 */
export function providerModeExitCode(mode: AgentProviderMode): 0 | 1 | 2 {
  if (mode === "direct") return 0;
  if (mode === "other") return 1;
  return 2;
}
