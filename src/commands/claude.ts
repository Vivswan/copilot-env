// Tails the `--check` provider report (src/agents/configure.ts) on stdout; it never touches the
// exit code.
import { claudeDesktopStatus } from "../agents/claude_desktop.ts";
import { renderClaudeDesktopStatus } from "../claude/desktop_status.ts";

export function printClaudeDesktopCheck(): void {
  const { lines, fix } = renderClaudeDesktopStatus(claudeDesktopStatus());
  const [head, ...rest] = lines;
  console.log(`Claude Desktop: ${head}`);
  for (const line of rest) console.log(`  ${line}`);
  if (fix !== null) console.log(`  fix: ${fix}`);
}
