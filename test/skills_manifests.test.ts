import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { classifyMcpEntry } from "../src/claude/mcp_registration.ts";
import { PROJECT_ROOT } from "../src/utils/root.ts";
import { expect, test } from "./helpers/testing.ts";

// The skills and plugin folder is plain content, so only the invariants an install depends on
// are pinned here.

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

  // The MCP config must stay INSIDE plugin.json: a root .mcp.json is read as
  // project-scope config by any `claude` session in this checkout, where
  // ${CLAUDE_PLUGIN_ROOT} is unset and the entry conflicts with the user-scope
  // registration `agent init` writes.
  expect(existsSync(join(PROJECT_ROOT, ".mcp.json"))).toBe(false);

  // What the plugin spawns is the server `agent init` registers: with the plugin root
  // resolved to this checkout, the entry is the launcher invocation the registration writes.
  const servers = (plugin.mcpServers ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const declared = servers["copilot-env"];
  const entry = declared === undefined ? undefined : {
    ...declared,
    command: String(declared.command).replaceAll("${CLAUDE_PLUGIN_ROOT}", PROJECT_ROOT),
  };
  expect(existsSync(entry?.command ?? ""), "the plugin's launcher").toBe(true);
  if (process.platform !== "win32") expect(classifyMcpEntry(entry, null)).toBe("ours-current");

  // The skill's example registration is what a user pastes into a project .mcp.json: it must
  // parse, and it must spawn the same `agent mcp --serve` the plugin does.
  const example = readJson(join(PROJECT_ROOT, "skills", "web-search", ".mcp.json.example"));
  const exampleEntry = ((example.mcpServers ?? {}) as Record<
    string,
    { type?: string; command?: string; args?: string[] } | undefined
  >)["copilot-env"];
  expect(String(exampleEntry?.command).endsWith("/bin/agent"), "the example's launcher").toBe(true);
  // `?? ""` so two missing argv lists never compare equal.
  expect(exampleEntry?.args, "the example's argv").toEqual(declared?.args ?? "");
  expect(exampleEntry?.type, "the example's transport").toBe(declared?.type ?? "");

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
    const codex = readJson(join(PROJECT_ROOT, rel, ".codex-plugin", "plugin.json"));
    expect(codex.name).toBe(basename(rel));
  }
});
