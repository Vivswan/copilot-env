---
name: web-search
description: Search the web through GitHub Copilot when the builtin WebSearch is unavailable (Claude Code wired to Copilot Direct denies it). Use the mcp__copilot-env__web_search tool for any query that needs current information from the internet, and fall back to the documented wiring steps when the tool is not registered.
license: MIT
metadata:
  author: Vivswan
---

# Web Search via Copilot

Answer questions that need current information from the internet by searching
through GitHub Copilot's Responses API instead of the builtin WebSearch.

## When to Use

Whenever web search is needed.

## Workflow

1. Call `mcp__copilot-env__web_search` with a `query` string. Keep the query
   short and specific, as you would type into a search engine. Installed as a
   Claude Code plugin instead of via the wiring writes, the same tool appears
   under the plugin-namespaced name
   `mcp__plugin_copilot-env_copilot-env__web_search`; call whichever is
   present.
2. The tool returns a concise answer followed by a `Sources:` list of cited
   URLs. Relay the answer and keep the source URLs when the user needs to
   verify or read further.
3. If a call fails, read the error text: a missing credential says how to fix
   itself (`agent auth` or a `GH_TOKEN` environment variable), and an HTTP
   error names the status. Report the problem instead of retrying blindly.
4. For a different search model, the user can run
   `agent config --set message-websearch-model <id>`; the tool reads it on the
   next call, no restart needed.

## Fallback Without MCP

When the `mcp__copilot-env__web_search` tool is not registered:

- From a copilot-env checkout, register the server in Claude Code:
  `claude mcp add --scope user copilot-search -- <checkout>/bin/agent mcp --serve`
  (see `.mcp.json.example` in this folder for the JSON shape other MCP
  clients accept). Register a hand-made entry under a name OTHER than
  `copilot-env`: copilot-env's own wiring writes reclaim and remove the
  `copilot-env` entry when switching modes or opting out.
- On a machine wired through the local copilot-api proxy
  (`agent claude --proxy`), the builtin WebSearch works as-is; no MCP server
  is needed.
- With neither available, say plainly that you cannot search the web in this
  session and answer from your own knowledge, dated as such.
