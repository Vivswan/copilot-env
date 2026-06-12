// Shared agent-configuration + result-guidance helpers for `agent init`: configure
// both agents and print the next-step guidance box. Kept in their own module so
// init.ts stays focused on orchestration (ensure-auth -> configure -> guide).
import { effectiveClaudeProviderMode, runClaude } from "../claude/config.ts";
import { effectiveCodexProviderMode, runCodex } from "../codex/config.ts";
import { bold } from "../utils/ansi.ts";
import { errMessage } from "../utils/error.ts";
import { createStderrLogger } from "../utils/logger.ts";
import type { AgentProviderMode } from "../utils/provider_mode.ts";

// All output goes to stderr (one logger) so it interleaves deterministically with
// the per-agent probe/config narration (also stderr) and never pollutes any stdout.
const logger = createStderrLogger();

/** Force flags shared by both agents (no flag => each auto-detects). */
export interface BothFlags {
  direct?: boolean;
  proxy?: boolean;
}

/** Read a provider mode, treating any read error as "other" (never throws). */
function safeMode<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/**
 * Configure both agents, resiliently (a failure on one only warns, the other
 * still runs), and report the resulting modes. `runCodex`/`runClaude` read the
 * provisioned GitHub token from the shared store themselves (the single source of
 * truth), so callers persist the token separately. Each agent's narration is
 * grouped under a header with blank-line spacing.
 */
export async function configureBothAgents(flags: BothFlags): Promise<{
  codex: AgentProviderMode;
  claude: AgentProviderMode;
}> {
  logger.log("");
  logger.log(bold("▸ Codex"));
  try {
    await runCodex(flags);
  } catch (e) {
    logger.warn(`  Could not configure Codex: ${errMessage(e)}`);
  }

  logger.log("");
  logger.log(bold("▸ Claude"));
  try {
    runClaude(flags);
  } catch (e) {
    logger.warn(`  Could not configure Claude: ${errMessage(e)}`);
  }

  // Read-back is also best-effort: a config-read error must not abort the caller.
  return {
    codex: safeMode<AgentProviderMode>(() => effectiveCodexProviderMode(), "other"),
    claude: safeMode<AgentProviderMode>(() => effectiveClaudeProviderMode(), "other"),
  };
}

function modeLabel(mode: AgentProviderMode): string {
  if (mode === "direct") return "GitHub Copilot Direct";
  if (mode === "proxy") return "the local proxy";
  if (mode === "other") return "a custom provider (not managed)";
  return "not configured";
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
      "`agent start` — launch the daemon",
      "`agent shell --launchers` — `cl` / `cx` then auto-start it for you",
      "`agent cost` — report proxy usage",
    ]);
  } else if (bothDirect) {
    const tail = usedToken ? " (using your GitHub token — no `gh` CLI needed)." : ".";
    lines.push("", `Both agents use GitHub Copilot Direct — no local proxy needed${tail}`);
    section("Run the agents", [
      "Just use `claude` and `codex` — no `agent start` / `agent stop`",
      "`agent shell --launchers` — optional `cl` / `co` / `cx` shortcuts",
    ]);
    section("Good to know", [
      "`agent cost` reports proxy usage only — Direct usage won't appear",
      "Model aliases come from the proxy; in Direct, use the provider's exact ids",
    ]);
  } else {
    lines.push("", "Mixed setup — the agents aren't configured the same way.");
    const steps = ["Anything unconfigured? Re-run `agent init` or check `agent health`"];
    if (codex === "direct" || claude === "direct") {
      steps.unshift("The Direct agent needs no proxy — run it directly");
    }
    section("Next steps", steps);
  }

  // Codex-in-Direct caveat: Copilot Direct doesn't serve image generation, so the
  // wrapper disables it (src/codex/config.ts). Point at the proxy escape hatch.
  // Fold it into the bothDirect "Good to know"; otherwise give it its own section.
  if (codex === "direct") {
    const caveat =
      "If you see a Codex image generation error, switch it to the proxy — `agent codex --proxy`, then `agent start`";
    if (bothDirect) lines.push(`  • ${caveat}`);
    else section("Good to know", [caveat]);
  }

  if (bothDirect) {
    lines.push(
      "",
      "if needed, switch everything to the proxy:  `agent init --proxy`, then `agent start`",
    );
  }

  logger.log("");
  logger.box(lines.join("\n"));
}
