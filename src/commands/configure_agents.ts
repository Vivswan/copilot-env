import { configureDefaultAgents } from "../agents/configure_defaults.ts";
import { configSetCommand } from "../copilot_api/env_config.ts";
import type { ManagedAgentId } from "../agents/configure.ts";
import type { AgentProviderMode, RequestedMode } from "../agents/provider_mode.ts";
import { bold } from "../utils/ansi.ts";
import { assertNever } from "../utils/assert.ts";
import { createStderrLogger } from "../utils/logger.ts";

// Stderr like the per-agent narration, so the guidance box never pollutes any stdout.
const logger = createStderrLogger();

/** configureDefaultAgents owns the narration and per-agent resilience; init warns and continues, so
 *  the failures it reports are dropped here. */
export async function configureBothAgents(mode: RequestedMode): Promise<{
  failedAgents: ManagedAgentId[];
  codex: AgentProviderMode;
  claude: AgentProviderMode;
}> {
  const { codex, claude, failedAgents } = await configureDefaultAgents({
    codex: mode,
    claude: mode,
  });
  return { codex, claude, failedAgents };
}

function modeLabel(mode: AgentProviderMode): string {
  if (mode === "direct") return "GitHub Copilot Direct";
  if (mode === "proxy") return "the local proxy";
  // "other" is any config that is not ours: a foreign provider, but also a
  // malformed or unreadable one (the classifiers fold read/parse failures in).
  if (mode === "other") return "a custom or unrecognized provider config (not managed)";
  if (mode === "none") return "not configured";
  return assertNever(mode);
}

export function printGuidance(
  codex: AgentProviderMode,
  claude: AgentProviderMode,
  usedToken = false,
  failedAgents: readonly ManagedAgentId[] = [],
): void {
  const bothDirect = codex === "direct" && claude === "direct";
  const anyProxy = codex === "proxy" || claude === "proxy";

  // A write that failed left that agent's files as they were: "unchanged", never "not configured".
  const label = (agent: ManagedAgentId, mode: AgentProviderMode): string =>
    failedAgents.includes(agent)
      ? "unchanged (this run's write failed; see the warning above)"
      : modeLabel(mode);
  const lines: string[] = [
    `Codex   →  ${label("codex", codex)}`,
    `Claude  →  ${label("claude", claude)}`,
  ];

  // Backticked commands render as highlighted inline code inside the box, so no space-padded
  // columns.
  const section = (title: string, items: string[]): void => {
    lines.push("", bold(title));
    for (const item of items) lines.push(`  • ${item}`);
  };

  if (anyProxy) {
    lines.push("", "At least one agent uses the local proxy.");
    section("Start the proxy", [
      "`agent start` - launch the daemon",
      `\`${
        configSetCommand("shell.launchers", "true")
      }\` - \`cl\` / \`cx\` then auto-start it for you`,
      "`agent cost` - report proxy usage",
    ]);
  } else if (bothDirect) {
    const tail = usedToken ? " (using your GitHub token - no `gh` CLI needed)." : ".";
    lines.push("", `Both agents use GitHub Copilot Direct - no local proxy needed${tail}`);
    section("Run the agents", [
      "Just use `claude` and `codex` - no `agent start` / `agent stop`",
      `\`${
        configSetCommand("shell.launchers", "true")
      }\` - optional \`cl\` / \`co\` / \`cx\` shortcuts`,
    ]);
    section("Good to know", [
      "`agent cost` reports proxy usage only - Direct usage won't appear",
      "Model aliases come from the proxy; in Direct, use the provider's exact ids",
    ]);
  } else {
    lines.push("", "Mixed setup - the agents aren't configured the same way.");
    const steps = ["Anything unconfigured? Re-run `agent init` or check `agent health`"];
    if (codex === "direct" || claude === "direct") {
      steps.unshift("The Direct agent needs no proxy - run it directly");
    }
    section("Next steps", steps);
  }

  section("Profiles (optional)", [
    "Run several sessions at once - direct, proxy, or another account.",
    "A profile = one credential + one mode, wired into BOTH agents:",
    "`agent profile --add <name> --direct|--proxy` → `cl --profile <name>` / `cx --profile <name>`",
    "`agent profile --list` / `--del <name>` manage them.",
  ]);

  if (bothDirect) {
    lines.push(
      "",
      "if needed, switch everything to the proxy:  `agent init --proxy`, then `agent start`",
    );
  }

  logger.log("");
  logger.box(lines.join("\n"));
}
