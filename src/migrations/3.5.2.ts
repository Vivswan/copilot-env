// Migration from 3.5.2: wire the web-search pair into EXISTING direct Claude installs.
//
// 3.5.3 introduces the copilot-env MCP server (`agent mcp`) with a `web_search` tool
// backed by Copilot's /responses endpoint, because Claude Code wired Direct cannot use
// its builtin WebSearch (the Copilot host rejects the Anthropic server-side tool with a
// 400). A direct write now registers the server in Claude's ~/.claude.json and denies
// the broken builtin in settings.json -- but existing installs only rewire on
// `agent init`/`agent claude`/`agent profile`, so an install that merely runs
// `agent update` would never gain the pair. Re-derive it here.
//
// syncDefaultWebSearchWiring owns ALL the rules (ours-and-direct only, the `wire-mcp`
// opt-out, deny ownership, register-then-deny ordering, byte-idempotent writes), so
// this migration is a thin trigger: proxy/other/none installs and opted-out machines
// are no-ops, and a second run rewrites nothing.
//
// NAMED profiles need no fix-up: they never carry the pair (deny rules union across
// settings layers, so the default layer's pair already reaches named direct sessions
// when the default wiring is direct).
import { consola } from "consola";

import { resolveClaudeHome, syncDefaultWebSearchWiring } from "../claude/config.ts";
import { errMessage } from "../utils/error.ts";
import type { Migration } from "./index.ts";

export const migration: Migration = {
  version: "3.5.2",
  description: "register the copilot-env MCP server + WebSearch deny for direct Claude installs",
  run: () => {
    try {
      syncDefaultWebSearchWiring(resolveClaudeHome());
    } catch (e) {
      consola.warn(`Could not sync the Claude web-search wiring (non-fatal): ${errMessage(e)}`);
    }
  },
};
