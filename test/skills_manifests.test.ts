import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { PROJECT_ROOT } from "../src/utils/root.ts";
import { expect, test } from "./helpers/testing.ts";

// The skills + plugin folder is plain content (no code), so this guard only pins the
// invariants installs depend on: manifests parse, listed paths exist, names line up,
// and the plugin manifest's inline mcpServers entry launches `bin/agent mcp --serve`.

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

test(".claude-plugin manifests parse and list skills that exist", () => {
  const plugin = readJson(join(PROJECT_ROOT, ".claude-plugin", "plugin.json"));
  expect(plugin.name).toBe("copilot-env");
  const skills = plugin.skills as string[];
  expect(Array.isArray(skills)).toBe(true);
  expect(skills.length).toBeGreaterThan(0);
  for (const rel of skills) {
    const skillDir = join(PROJECT_ROOT, rel);
    expect(existsSync(join(skillDir, "SKILL.md"))).toBe(true);
    expect(existsSync(join(skillDir, "README.md"))).toBe(true);
  }

  const marketplace = readJson(join(PROJECT_ROOT, ".claude-plugin", "marketplace.json"));
  expect(marketplace.name).toBe("copilot-env");
  const plugins = marketplace.plugins as { name: string; source: string }[];
  expect(plugins).toHaveLength(1);
  expect(plugins[0]?.source).toBe("./");
});

test("every skill's SKILL.md frontmatter names the skill after its folder", () => {
  const plugin = readJson(join(PROJECT_ROOT, ".claude-plugin", "plugin.json"));
  for (const rel of plugin.skills as string[]) {
    const text = readFileSync(join(PROJECT_ROOT, rel, "SKILL.md"), "utf8");
    const frontmatter = text.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
    const name = frontmatter.match(/^name:\s*(\S+)\s*$/m)?.[1];
    const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1];
    expect(name).toBe(basename(rel));
    expect((description ?? "").length).toBeGreaterThan(20);
    // Per-skill Codex manifest parses and matches the name.
    const codex = readJson(join(PROJECT_ROOT, rel, ".codex-plugin", "plugin.json"));
    expect(codex.name).toBe(basename(rel));
  }
});

test("plugin.json's inline mcpServers entry registers bin/agent mcp --serve", () => {
  const plugin = readJson(join(PROJECT_ROOT, ".claude-plugin", "plugin.json"));
  const servers = plugin.mcpServers as Record<string, { command: string; args: string[] }>;
  const entry = servers["copilot-env"];
  expect(entry).toBeDefined();
  expect(entry?.command).toBe("${CLAUDE_PLUGIN_ROOT}/bin/agent");
  expect(entry?.args).toEqual(["mcp", "--serve"]);
  // The MCP config must stay INSIDE plugin.json: a root .mcp.json is read as
  // project-scope config by any `claude` session in this checkout, where
  // ${CLAUDE_PLUGIN_ROOT} is unset and the entry conflicts with the user-scope
  // registration `agent init` writes.
  expect(existsSync(join(PROJECT_ROOT, ".mcp.json"))).toBe(false);
});

test("the skill folder's .mcp.json.example parses and points at bin/agent mcp --serve", () => {
  const doc = readJson(join(PROJECT_ROOT, "skills", "web-search", ".mcp.json.example"));
  const servers = doc.mcpServers as Record<string, unknown>;
  expect(servers["copilot-env"]).toEqual({
    "type": "stdio",
    "command": "/path/to/copilot-env/bin/agent",
    "args": ["mcp", "--serve"],
  });
});
