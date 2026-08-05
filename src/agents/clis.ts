// The optional agent CLIs copilot-env can install (`agent shell --clis`) and
// probe (`agent health`): command name, display name, and npm package.
export const AGENT_CLIS = [
  {
    command: "claude",
    name: "Claude Code CLI",
    packageName: "@anthropic-ai/claude-code",
  },
  {
    command: "copilot",
    name: "GitHub Copilot CLI",
    packageName: "@github/copilot",
  },
  {
    command: "codex",
    name: "Codex CLI",
    packageName: "@openai/codex",
  },
] as const;
