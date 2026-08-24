# web-search

Web search for AI coding agents through GitHub Copilot's Responses API, backed by the copilot-env MCP server (`agent mcp --serve`).

Claude Code wired directly to `api.githubcopilot.com` cannot use its builtin WebSearch: the Copilot host rejects Anthropic's server-side search tool with a
400. Copilot's own `/responses` endpoint executes web search server-side, so the copilot-env MCP server exposes it as a `web_search` tool that any MCP client can call. The skill in this folder teaches an agent when and how to use it, with a fallback workflow for sessions where the tool is missing.

## Setup

The server ships with [copilot-env](https://github.com/Vivswan/copilot-env); `agent init` / `agent claude` wire it into Claude Code automatically on a Direct write. To register it anywhere else (in Claude Code specifically, pick a name other than `copilot-env` - copilot-env's own wiring writes reclaim that name when switching modes):

```jsonc
// see .mcp.json.example; in Claude Code use a name other than copilot-env
{
  "mcpServers": {
    "copilot-search": {
      "type": "stdio",
      "command": "/path/to/copilot-env/bin/agent",
      "args": ["mcp", "--serve"]
    }
  }
}
```

On Windows, run the PowerShell launcher instead: `powershell -NoProfile -ExecutionPolicy Bypass -File <checkout>/bin/agent.ps1 mcp --serve`.

In a dev checkout the launcher self-bootstraps: the FIRST spawn installs the pinned deno and the locked dependencies before the server answers, which can outlast an MCP client's startup window. If the first connection times out, run `bin/agent --help` once to warm the checkout, then reconnect. An installed copilot-env is a single binary and has no such warm-up.

## Credentials

The server resolves the copilot-env credential (`agent auth`). Without one it reads `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN` from the environment, so a bare clone works with `GH_TOKEN=... bin/agent mcp --serve`. The registered server always uses the default credential; a named profile that needs its own can register a second entry with `--profile <name>`.

## Configuration

- `agent config --set message-websearch-model <id>` picks the search model (read on every call; default `gpt-5.6-sol`).
- `agent mcp --remove` unregisters the server from Claude Code, restores the builtin WebSearch permission, and stores a durable opt-out (`wire-mcp false`).
