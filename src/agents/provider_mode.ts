// The backend an agent's config selects, shared by the Codex and Claude writers so the type and
// the `--check` exit code (a `cl`/`cx` launcher contract) cannot drift apart. The per-agent
// detail strings stay in each writer; they legitimately differ.
//   direct -> GitHub Copilot directly           proxy -> the local copilot-api proxy
//   other  -> a foreign config we do not manage  none  -> unconfigured (the proxy is the default)

/** A runtime list for boundary validation (the settings-bundle schema); the type derives from
 *  it, so the two cannot drift. */
export const AGENT_PROVIDER_MODES = ["direct", "proxy", "other", "none"] as const;

export type AgentProviderMode = (typeof AGENT_PROVIDER_MODES)[number];

/** The two modes copilot-env actively manages (writes). */
export type ManagedAgentMode = Extract<AgentProviderMode, "direct" | "proxy">;

/** The ONLY shape the `--direct`/`--proxy` pair takes past the CLI boundary, so "both flags"
 *  is unrepresentable downstream. What "auto" means stays per-command (init/codex/claude probe
 *  live, models prefers a running proxy, profile --add is sticky). */
export type RequestedMode = ManagedAgentMode | "auto";

/** The single place the `--direct --proxy` conflict is rejected. `message` lets a command keep
 *  its own wording. */
export function parseModeFlags(
  opts: { direct?: unknown; proxy?: unknown },
  message = "--direct and --proxy are mutually exclusive",
): RequestedMode {
  if (opts.direct && opts.proxy) throw new Error(message);
  if (opts.direct) return "direct";
  if (opts.proxy) return "proxy";
  return "auto";
}

/** A launcher contract the `cl`/`cx` wrappers read:
 *    0 -> direct: launch as-is
 *    1 -> other: a custom config the launcher must NOT take over
 *    2 -> proxy or none: the proxy is the default backend, so the launcher ensures it */
export function providerModeExitCode(mode: AgentProviderMode): 0 | 1 | 2 {
  if (mode === "direct") return 0;
  if (mode === "other") return 1;
  return 2;
}
