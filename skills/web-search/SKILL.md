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

Use this skill when:

- the user asks about current events, releases, prices, versions, or anything
  newer than your knowledge cutoff
- the builtin WebSearch tool is denied or returns
  `The use of the web search tool is not supported` (Claude Code wired to
  GitHub Copilot Direct)
- a `mcp__copilot-env__web_search` tool is available

## Workflow

1. Call `mcp__copilot-env__web_search` with a `query` string. Keep the query
   short and specific, as you would type into a search engine.
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
  `claude mcp add --scope user copilot-search -- <checkout>/bin/agent mcp`
  (see `.mcp.json.example` in this folder for the JSON shape other MCP
  clients accept). Register a hand-made entry under a name OTHER than
  `copilot-env`: copilot-env's own wiring writes reclaim and remove the
  `copilot-env` entry when switching modes or opting out.
- On a machine wired through the local copilot-api proxy
  (`agent claude --proxy`), the builtin WebSearch works as-is; no MCP server
  is needed.
- With neither available, say plainly that you cannot search the web in this
  session and answer from your own knowledge, dated as such.
