// The backend an agent's config selects, shared by the Codex and Claude config
// writers so the type and the `--check` exit-code contract cannot drift apart
// (the `cl`/`cx` launchers consume that exit code, so two copies would be a real
// hazard). The per-agent `providerModeDetail` strings stay in each writer -- they
// legitimately differ -- only the shape and the exit code are shared here.
//   - direct: the agent talks to GitHub Copilot directly.
//   - proxy:  the agent talks to the local copilot-api proxy.
//   - other:  a foreign/custom config we do not manage.
//   - none:   unconfigured (the proxy is the default backend).

/** The provider-mode vocabulary as a runtime list, for boundary validation
 *  (e.g. the settings-bundle schema) -- the type below derives from it, so the
 *  two can never drift. */
export const AGENT_PROVIDER_MODES = ["direct", "proxy", "other", "none"] as const;

/** Which backend an agent's config selects. */
export type AgentProviderMode = (typeof AGENT_PROVIDER_MODES)[number];

/** The two modes copilot-env actively manages (writes). */
export type ManagedAgentMode = Extract<AgentProviderMode, "direct" | "proxy">;

/**
 * What a command invocation asked for: one forced managed mode, or auto-detect.
 * This is the ONLY shape the `--direct`/`--proxy` pair takes past the CLI
 * boundary, so the contradictory "both flags" state is unrepresentable
 * downstream and consumers are total over three cases instead of re-checking
 * two booleans. What "auto" means stays per-command (init/codex/claude live-
 * probe, models prefers a running proxy, profile --add is sticky).
 */
export type RequestedMode = ManagedAgentMode | "auto";

/**
 * Parse the Commander `--direct`/`--proxy` booleans ONCE, at the CLI boundary,
 * into RequestedMode -- the single place the mutual exclusion is rejected.
 * `message` lets a command keep its own wording (profile's "ONE mode" suffix).
 */
export function parseModeFlags(
  opts: { direct?: unknown; proxy?: unknown },
  message = "--direct and --proxy are mutually exclusive",
): RequestedMode {
  if (opts.direct && opts.proxy) throw new Error(message);
  if (opts.direct) return "direct";
  if (opts.proxy) return "proxy";
  return "auto";
}

/**
 * The `agent codex --check` / `agent claude --check` exit code -- a launcher
 * contract the `cl`/`cx` wrappers read: 0 = direct (launch as-is), 1 = other
 * (a custom config the launcher must NOT take over), 2 = proxy or none (the proxy
 * is the default backend, so the launcher ensures it).
 */
export function providerModeExitCode(mode: AgentProviderMode): 0 | 1 | 2 {
  if (mode === "direct") return 0;
  if (mode === "other") return 1;
  return 2;
}
