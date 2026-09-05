// `agent claude`'s rendering beyond the shared skeleton (src/agents/configure.ts runs the
// check/configure body): the Claude Desktop status that tails `--check`. Stdout, like the
// provider report it follows; the exit code stays the provider-mode contract alone.
import { claudeDesktopStatus } from "../agents/claude_desktop.ts";
import { renderClaudeDesktopStatus } from "../claude/desktop.ts";

/** Print the Desktop status after the `--check` provider report, drift named with its fix. */
export function printClaudeDesktopCheck(): void {
  const { lines, fix } = renderClaudeDesktopStatus(claudeDesktopStatus());
  const [head, ...rest] = lines;
  console.log(`Claude Desktop: ${head}`);
  for (const line of rest) console.log(`  ${line}`);
  if (fix !== null) console.log(`  fix: ${fix}`);
}
