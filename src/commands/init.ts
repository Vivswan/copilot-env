// `agent init`: the headline one-shot — configure BOTH Codex and Claude (each
// auto-detects GitHub Copilot Direct vs the local gateway proxy, or --direct /
// --proxy forces both), then print next-step guidance. This is also the shared
// "configure both agents" routine reused by `agent setup-clis` after it installs.
import {
  type ClaudeProviderMode,
  effectiveClaudeProviderMode,
  runClaude,
} from "../claude/config.ts";
import { type CodexProviderMode, effectiveCodexProviderMode, runCodex } from "../codex/config.ts";
import { bold } from "../utils/ansi.ts";
import { createStderrLogger } from "../utils/logger.ts";

// All init output goes to stderr (one logger) so it interleaves deterministically
// with the probe/config narration (also stderr) and never pollutes any stdout.
const logger = createStderrLogger();

export interface InitArgs {
  direct?: boolean;
  proxy?: boolean;
}

/** Force flags shared by both agents (no flag => each auto-detects). */
interface BothFlags {
  direct?: boolean;
  proxy?: boolean;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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
 * still runs), and report the resulting modes. Each agent's narration is grouped
 * under a header with blank-line spacing. Shared by `agent init` and `setup-clis`.
 */
export function configureBothAgents(flags: BothFlags): {
  codex: CodexProviderMode;
  claude: ClaudeProviderMode;
} {
  logger.log("");
  logger.log(bold("▸ Codex"));
  try {
    runCodex(flags);
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

  // Read-back is also best-effort: a config-read error must not abort init.
  return {
    codex: safeMode<CodexProviderMode>(() => effectiveCodexProviderMode(), "other"),
    claude: safeMode<ClaudeProviderMode>(() => effectiveClaudeProviderMode(), "other"),
  };
}

function modeLabel(mode: CodexProviderMode | ClaudeProviderMode): string {
  if (mode === "direct") return "GitHub Copilot Direct";
  if (mode === "proxy") return "the local gateway proxy";
  if (mode === "other") return "a custom provider (not managed)";
  return "not configured";
}

/** Print the result + what to do next, in a single box so it's easy to scan. */
function printGuidance(codex: CodexProviderMode, claude: ClaudeProviderMode): void {
  const bothDirect = codex === "direct" && claude === "direct";
  const anyProxy = codex === "proxy" || claude === "proxy";

  const lines: string[] = [`Codex   →  ${modeLabel(codex)}`, `Claude  →  ${modeLabel(claude)}`, ""];

  if (anyProxy) {
    lines.push("At least one agent uses the local gateway proxy.");
    lines.push("");
    lines.push("  • Start the gateway:                 agent start");
    lines.push("  • Launchers cl / cx offer to start it: agent setup-launchers");
    lines.push("  • `agent cost` reports gateway usage.");
    lines.push("  • Prefer GitHub Copilot Direct?      agent init --direct");
  } else if (bothDirect) {
    lines.push("Both agents use GitHub Copilot Direct — the local gateway is NOT needed.");
    lines.push("");
    lines.push("  • Just run `claude` and `codex` directly (no `agent start` / `agent stop`).");
    lines.push("  • Optional launchers cl / co / cx:   agent setup-launchers");
    lines.push("  • Direct usage is NOT tracked by `agent cost` (only gateway usage is).");
    lines.push("  • Prefer the local gateway instead?  agent init --proxy");
  } else {
    // No proxy and not both-direct: a mixed/partial result (e.g. one direct, the
    // other custom/unconfigured). Be specific rather than claim "neither".
    lines.push("Mixed setup — the two agents aren't configured the same way:");
    lines.push("");
    if (codex === "direct" || claude === "direct") {
      lines.push("  • The Direct agent needs no gateway — run it directly.");
    }
    lines.push("  • For anything not configured, re-run `agent init` or see `agent health`.");
  }

  logger.log("");
  logger.box(lines.join("\n"));
}

/**
 * `init`: configure both agents and explain the result. `--direct`/`--proxy`
 * force both; with no flag each auto-detects (live Copilot Direct probe, else
 * the gateway). `--direct` and `--proxy` are mutually exclusive.
 */
export function runInit(args: InitArgs): void {
  if (args.direct && args.proxy) {
    throw new Error("--direct and --proxy are mutually exclusive");
  }
  const { codex, claude } = configureBothAgents({ direct: args.direct, proxy: args.proxy });
  printGuidance(codex, claude);
}
