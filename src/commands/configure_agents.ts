// Shared agent-configuration + result-guidance helpers for `agent init`: configure
// both agents and print the next-step guidance box. Kept in their own module so
// init.ts stays focused on orchestration (ensure-auth -> configure -> guide).

import { configureDefaultAgents } from "../agents/configure_defaults.ts";
import type { AgentProviderMode, RequestedMode } from "../agents/provider_mode.ts";
import { bold } from "../utils/ansi.ts";
import { assertNever } from "../utils/assert.ts";
import { createStderrLogger } from "../utils/logger.ts";

// Stderr like the per-agent narration, so the guidance box never pollutes any stdout.
const logger = createStderrLogger();

/**
 * Configure both agents with one shared requested mode ("auto" = each
 * auto-detects) and report the resulting modes -- `agent init`'s view of
 * configureDefaultAgents (which owns the narration and per-agent resilience;
 * init keeps the warn-and-continue contract, so the failures are dropped here).
 */
export async function configureBothAgents(mode: RequestedMode): Promise<{
  codex: AgentProviderMode;
  claude: AgentProviderMode;
}> {
  const { codex, claude } = await configureDefaultAgents({ codex: mode, claude: mode });
  return { codex, claude };
}

function modeLabel(mode: AgentProviderMode): string {
  if (mode === "direct") return "GitHub Copilot Direct";
  if (mode === "proxy") return "the local proxy";
  if (mode === "other") return "a custom provider (not managed)";
  if (mode === "none") return "not configured";
  return assertNever(mode);
}

/** Print the result + what to do next, in a single box so it's easy to scan. */
export function printGuidance(
  codex: AgentProviderMode,
  claude: AgentProviderMode,
  usedToken = false,
): void {
  const bothDirect = codex === "direct" && claude === "direct";
  const anyProxy = codex === "proxy" || claude === "proxy";

  const lines: string[] = [`Codex   →  ${modeLabel(codex)}`, `Claude  →  ${modeLabel(claude)}`];

  // Append a blank line, a bold section header, then `- `-prefixed rows. Commands
  // wrapped in `backticks` render as highlighted inline code inside the box, so
  // they stand out without fragile space-padded columns.
  const section = (title: string, items: string[]): void => {
    lines.push("", bold(title));
    for (const item of items) lines.push(`  • ${item}`);
  };

  if (anyProxy) {
    lines.push("", "At least one agent uses the local proxy.");
    section("Start the proxy", [
      "`agent start` - launch the daemon",
      "`agent shell --launchers` - `cl` / `cx` then auto-start it for you",
      "`agent cost` - report proxy usage",
    ]);
  } else if (bothDirect) {
    const tail = usedToken ? " (using your GitHub token - no `gh` CLI needed)." : ".";
    lines.push("", `Both agents use GitHub Copilot Direct - no local proxy needed${tail}`);
    section("Run the agents", [
      "Just use `claude` and `codex` - no `agent start` / `agent stop`",
      "`agent shell --launchers` - optional `cl` / `co` / `cx` shortcuts",
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
