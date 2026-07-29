import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyMcpEntry,
  claudeJsonPath,
  registerClaudeMcpServer,
  removeClaudeMcpRegistration,
} from "../src/claude/mcp_registration.ts";
import { agentLauncherCommand } from "../src/utils/root.ts";

const SAVED_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
let dir = "";

afterEach(() => {
  if (SAVED_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = SAVED_CONFIG_DIR;
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

function tmpConfigDir(): string {
  dir = mkdtempSync(join(tmpdir(), "copilot-mcpreg-"));
  process.env.CLAUDE_CONFIG_DIR = dir;
  return dir;
}

function readDoc(): Record<string, unknown> {
  return JSON.parse(readFileSync(claudeJsonPath(), "utf8")) as Record<string, unknown>;
}

function managedEntry(): Record<string, unknown> {
  const { command, args } = agentLauncherCommand(["mcp"]);
  return { "type": "stdio", "command": command, "args": args };
}

test("register creates .claude.json with the managed entry when missing", () => {
  tmpConfigDir();
  expect(registerClaudeMcpServer()).toBe(true);
  const doc = readDoc();
  expect(doc.mcpServers).toEqual({ "copilot-env": managedEntry() });
});

test("register preserves unrelated keys and other servers", () => {
  const home = tmpConfigDir();
  writeFileSync(
    join(home, ".claude.json"),
    `${JSON.stringify({
      "numStartups": 42,
      "mcpServers": { "other": { "type": "stdio", "command": "x", "args": [] } },
    })}\n`,
  );
  expect(registerClaudeMcpServer()).toBe(true);
  const doc = readDoc();
  expect(doc.numStartups).toBe(42);
  const servers = doc.mcpServers as Record<string, unknown>;
  expect(servers.other).toEqual({ "type": "stdio", "command": "x", "args": [] });
  expect(servers["copilot-env"]).toEqual(managedEntry());
});

test("register is byte-idempotent: a second run does not rewrite the file", () => {
  tmpConfigDir();
  expect(registerClaudeMcpServer()).toBe(true);
  const before = statSync(claudeJsonPath()).mtimeMs;
  const raw = readFileSync(claudeJsonPath(), "utf8");
  expect(registerClaudeMcpServer()).toBe(true);
  expect(readFileSync(claudeJsonPath(), "utf8")).toBe(raw);
  expect(statSync(claudeJsonPath()).mtimeMs).toBe(before);
});

test("a foreign copilot-env entry is left alone and register reports failure", () => {
  const home = tmpConfigDir();
  const foreign = { "type": "stdio", "command": "npx", "args": ["someone-elses-server"] };
  writeFileSync(
    join(home, ".claude.json"),
    `${JSON.stringify({ "mcpServers": { "copilot-env": foreign } })}\n`,
  );
  expect(registerClaudeMcpServer()).toBe(false);
  expect((readDoc().mcpServers as Record<string, unknown>)["copilot-env"]).toEqual(foreign);
  removeClaudeMcpRegistration();
  expect((readDoc().mcpServers as Record<string, unknown>)["copilot-env"]).toEqual(foreign);
});

test("malformed .claude.json is never touched; register reports failure", () => {
  const home = tmpConfigDir();
  writeFileSync(join(home, ".claude.json"), "{ not json");
  expect(registerClaudeMcpServer()).toBe(false);
  removeClaudeMcpRegistration();
  expect(readFileSync(join(home, ".claude.json"), "utf8")).toBe("{ not json");
});

test("an ours-stale entry (moved checkout) is reclaimed by register and by remove", () => {
  const home = tmpConfigDir();
  const managed = managedEntry();
  // A moved checkout: same argv shape, different launcher path. On POSIX the path
  // is the command; on Windows it is the -File argument inside the argv.
  const stale =
    process.platform === "win32"
      ? {
          ...managed,
          "args": (managed.args as string[]).map((a) =>
            /[\\/]bin[\\/]agent\.ps1$/i.test(a) ? "C:\\somewhere\\else\\bin\\agent.ps1" : a,
          ),
        }
      : { ...managed, "command": "/somewhere/else/bin/agent" };
  expect(classifyMcpEntry(stale)).toBe("ours-stale");
  writeFileSync(
    join(home, ".claude.json"),
    `${JSON.stringify({ "mcpServers": { "copilot-env": stale } })}\n`,
  );
  expect(registerClaudeMcpServer()).toBe(true);
  expect((readDoc().mcpServers as Record<string, unknown>)["copilot-env"]).toEqual(managedEntry());
});

test("remove deletes only ours, drops an emptied mcpServers, never the file", () => {
  tmpConfigDir();
  expect(registerClaudeMcpServer()).toBe(true);
  removeClaudeMcpRegistration();
  const doc = readDoc();
  expect(doc.mcpServers).toBeUndefined();
  expect(existsSync(claudeJsonPath())).toBe(true);
});

test("remove keeps sibling servers and unrelated keys", () => {
  const home = tmpConfigDir();
  writeFileSync(
    join(home, ".claude.json"),
    `${JSON.stringify({
      "numStartups": 1,
      "mcpServers": {
        "copilot-env": managedEntry(),
        "other": { "type": "stdio", "command": "x", "args": [] },
      },
    })}\n`,
  );
  removeClaudeMcpRegistration();
  const doc = readDoc();
  expect(doc.numStartups).toBe(1);
  expect(doc.mcpServers).toEqual({ "other": { "type": "stdio", "command": "x", "args": [] } });
});

test("remove on a missing file is a no-op", () => {
  tmpConfigDir();
  removeClaudeMcpRegistration();
  expect(existsSync(claudeJsonPath())).toBe(false);
});

test("classifyMcpEntry statuses", () => {
  expect(classifyMcpEntry(undefined)).toBe("absent");
  expect(classifyMcpEntry(managedEntry())).toBe("ours-current");
  expect(classifyMcpEntry({ ...managedEntry(), "type": "http" })).toBe("foreign");
  expect(classifyMcpEntry({ "command": 5 })).toBe("foreign");
  expect(classifyMcpEntry("nope")).toBe("foreign");
  // Missing type counts as stdio (Claude's own default).
  const { type: _drop, ...untyped } = managedEntry();
  expect(classifyMcpEntry(untyped)).toBe("ours-current");
});

test("a file Claude wrote without a trailing newline keeps its convention", () => {
  const home = tmpConfigDir();
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ "numStartups": 7 }, null, 2)); // no \n
  expect(registerClaudeMcpServer()).toBe(true);
  const raw = readFileSync(claudeJsonPath(), "utf8");
  expect(raw.endsWith("\n")).toBe(false);
  expect((JSON.parse(raw) as Record<string, unknown>).numStartups).toBe(7);
});

test("a bare `agent` from someone's PATH is foreign, not ours-stale", () => {
  if (process.platform === "win32") return;
  expect(classifyMcpEntry({ "type": "stdio", "command": "agent", "args": ["mcp"] })).toBe(
    "foreign",
  );
  expect(
    classifyMcpEntry({ "type": "stdio", "command": "/usr/local/agent", "args": ["mcp"] }),
  ).toBe("foreign");
  expect(
    classifyMcpEntry({ "type": "stdio", "command": "/elsewhere/bin/agent", "args": ["mcp"] }),
  ).toBe("ours-stale");
});
