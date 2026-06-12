// `agent init`: the headline one-shot — configure BOTH Codex and Claude (each
// auto-detects GitHub Copilot Direct vs the local proxy, or --direct / --proxy
// forces both), then print next-step guidance. Shell wiring and CLI install live
// in `agent shell`.
import {
  type ClaudeProviderMode,
  effectiveClaudeProviderMode,
  runClaude,
} from "../claude/config.ts";
import { type CodexProviderMode, effectiveCodexProviderMode, runCodex } from "../codex/config.ts";
import {
  clearGithubToken,
  readStoredGithubToken,
  storeGithubToken,
} from "../copilot_api/gh_token.ts";
import { bold } from "../utils/ansi.ts";
import { resolveGhToken } from "../utils/direct_probe.ts";
import { errMessage } from "../utils/error.ts";
import { createStderrLogger } from "../utils/logger.ts";

// All init output goes to stderr (one logger) so it interleaves deterministically
// with the probe/config narration (also stderr) and never pollutes any stdout.
const logger = createStderrLogger();

export interface InitArgs {
  direct?: boolean;
  proxy?: boolean;
  /** `--gh-token`: provision this GitHub token for Direct (baked) + the proxy (stored for start). */
  "gh-token"?: string | boolean;
  /** `--remove-gh-token`: revert to `gh` — reconfigure both agents to gh-direct + clear the stored token. */
  "remove-gh-token"?: boolean;
}

/** Force flags shared by both agents (no flag => each auto-detects). */
interface BothFlags {
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
 * provisioned GitHub token from the shared token store themselves (the single
 * source of truth), so callers persist the token separately. Each agent's
 * narration is grouped under a header with blank-line spacing. Used by both
 * `agent init` paths (the normal configure and the `--remove-gh-token` revert).
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
  if (mode === "proxy") return "the local proxy";
  if (mode === "other") return "a custom provider (not managed)";
  return "not configured";
}

/** Print the result + what to do next, in a single box so it's easy to scan. */
function printGuidance(
  codex: CodexProviderMode,
  claude: ClaudeProviderMode,
  usedToken = false,
): void {
  const bothDirect = codex === "direct" && claude === "direct";
  const anyProxy = codex === "proxy" || claude === "proxy";

  const lines: string[] = [`Codex   →  ${modeLabel(codex)}`, `Claude  →  ${modeLabel(claude)}`];

  // Append a blank line, a bold section header, then `• `-prefixed rows. Commands
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

/**
 * `init`: configure both agents and explain the result. `--direct`/`--proxy`
 * force both; with no flag each auto-detects (live Copilot Direct probe, else
 * the proxy). `--gh-token` provisions a supplied GitHub token everywhere — baked
 * into both Direct configs (no `gh` needed) AND stored for the proxy (so
 * `agent start` passes it as `--github-token`). `--remove-gh-token` reverts:
 * reconfigures both agents to gh-direct (scrubbing the baked Codex token) and
 * clears the stored token. `--direct`/`--proxy` are mutually exclusive, and
 * `--gh-token` / `--remove-gh-token` cannot combine with `--proxy` or each other.
 * (Shell wiring + CLI install live in `agent shell`.)
 */
export function runInit(args: InitArgs): void {
  if (args.direct && args.proxy) {
    throw new Error("--direct and --proxy are mutually exclusive");
  }

  const removeGhToken = Boolean(args["remove-gh-token"]);
  if (removeGhToken) {
    if (args["gh-token"] !== undefined) {
      throw new Error("--remove-gh-token and --gh-token are mutually exclusive");
    }
    if (args.proxy) {
      throw new Error("--remove-gh-token reverts to gh Direct and cannot be combined with --proxy");
    }
    // Clear the stored token FIRST so the reconfigure below reads null and writes
    // gh-direct — scrubbing the baked Codex `.env` token and resetting the Claude
    // helper to `gh auth token` (if we reconfigured first, runCodex/runClaude would
    // re-read the still-stored token and bake it right back in).
    try {
      clearGithubToken();
      logger.log("  ✓ Cleared the stored GitHub token (Direct + the proxy use the gh login again)");
    } catch (e) {
      logger.warn(`  Could not clear the stored GitHub token: ${errMessage(e)}`);
    }
    const { codex, claude } = configureBothAgents({ direct: true });
    printGuidance(codex, claude, false);
    return;
  }

  // Resolve a `--gh-token` (if any) and persist it to the shared store up front —
  // it's the single source of truth that configureBothAgents / runClaude /
  // runCodex and `agent start` all read. A bad/absent value (or a --proxy
  // conflict) fails before we touch any config.
  const explicitToken = resolveGhToken(args["gh-token"]);
  if (explicitToken !== null) {
    if (args.proxy) {
      throw new Error("--gh-token configures Direct mode and cannot be combined with --proxy");
    }
    try {
      storeGithubToken(explicitToken);
      logger.log(
        "  ✓ Stored the GitHub token (used for Direct + the proxy until --remove-gh-token)",
      );
    } catch (e) {
      logger.warn(`  Could not store the GitHub token: ${errMessage(e)}`);
    }
  }

  const { codex, claude } = configureBothAgents({ direct: args.direct, proxy: args.proxy });

  // A token is "in use" for guidance if one is now stored (explicit or pre-existing).
  printGuidance(codex, claude, readStoredGithubToken() !== null);
}
