// Tails the `--check` provider report (src/agents/configure.ts) on stdout; it never touches the
// exit code.
import { claudeDesktopStatus } from "../agents/claude_desktop.ts";
import { renderClaudeDesktopStatus } from "../claude/desktop_status.ts";
import { printKeyValue, printWrapped } from "../utils/table.ts";

export function printClaudeDesktopCheck(): void {
  const { lines, fix } = renderClaudeDesktopStatus(claudeDesktopStatus());
  const [head, ...rest] = lines;
  printKeyValue("Claude Desktop", head ?? "");
  for (const line of rest) printWrapped(`  ${line}`);
  if (fix !== null) printWrapped(`  fix: ${fix}`);
}
