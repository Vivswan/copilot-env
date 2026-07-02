import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DIRECT_HELPER_NAME, PROXY_HELPER_NAME } from "../src/claude/config.ts";
import { runEnv } from "../src/commands/env.ts";
import { LAUNCHERS_MARKER } from "../src/commands/shell_integration.ts";

const SAVED: Record<string, string | undefined> = {
  HOME: process.env.HOME,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  COPILOT_API_HOME: process.env.COPILOT_API_HOME,
};
let dir = "";

afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

/** Run runEnv(posix) capturing its stdout lines. */
function envLines(): string[] {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    runEnv({ format: "posix" });
  } finally {
    console.log = orig;
  }
  return lines;
}

function isolate(): string {
  dir = mkdtempSync(join(tmpdir(), "copilot-env-cmd-"));
  process.env.HOME = dir;
  process.env.COPILOT_API_HOME = join(dir, "gw"); // empty state => no host CODEX_HOME
  delete process.env.CODEX_HOME;
  delete process.env.ANTHROPIC_BASE_URL;
  const claudeHome = join(dir, ".claude");
  mkdirSync(claudeHome, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  return claudeHome;
}

/** Write a $HOME/.bashrc that wires the opt-in launchers block. */
function wireLaunchers(): void {
  writeFileSync(
    join(dir, ".bashrc"),
    `${LAUNCHERS_MARKER}\nAGENTS_LAUNCHERS='/x/agents.launchers.bashrc'\n[ -f "$AGENTS_LAUNCHERS" ] && source "$AGENTS_LAUNCHERS"\n`,
  );
}

const isLaunchersSource = (l: string): boolean =>
  l.includes("agents.launchers.bashrc") && l.includes("] && . ");

/**
 * Run `runEnv` in a CHILD bun process with HOME set at spawn time. `agent env` is
 * always a fresh process in production, so its rc-file scan (os.homedir(), which Bun
 * binds at startup and ignores later process.env.HOME mutation) resolves correctly
 * only when HOME is in the spawn environment -- which in-process runEnv() can't fake.
 */
function childEnvLines(env: Record<string, string | undefined>): string[] {
  const script = `import{runEnv}from${JSON.stringify(join(import.meta.dir, "..", "src/commands/env.ts"))};runEnv({format:"posix"});`;
  const spawnEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...env })) {
    if (v !== undefined) spawnEnv[k] = v;
  }
  const result = spawnSync(process.execPath, ["-e", script], { env: spawnEnv, encoding: "utf-8" });
  if (result.status !== 0) throw new Error(`child env failed: ${result.stderr}`);
  return result.stdout.split("\n").filter((l) => l.length > 0);
}

/** Base isolated env for a child `agent env`: no proxy state. */
function childBaseEnv(): Record<string, string | undefined> {
  const claudeHome = join(dir, ".claude");
  mkdirSync(claudeHome, { recursive: true });
  return {
    HOME: dir,
    COPILOT_API_HOME: join(dir, "gw"),
    CLAUDE_CONFIG_DIR: claudeHome,
    CODEX_HOME: undefined,
    ANTHROPIC_BASE_URL: undefined,
  };
}

function writeClaude(home: string, apiKeyHelper: string, baseUrl: string): void {
  writeFileSync(
    join(home, "settings.json"),
    JSON.stringify({ apiKeyHelper, env: { ANTHROPIC_BASE_URL: baseUrl } }),
  );
}

test("env exports ANTHROPIC_BASE_URL when Claude is proxy at a localhost proxy URL", () => {
  const home = isolate();
  writeClaude(home, join(home, PROXY_HELPER_NAME), "http://localhost:4141");
  const lines = envLines();
  expect(lines).toContain("export ANTHROPIC_BASE_URL='http://localhost:4141'");
});

test("env exports a 127.0.0.1 proxy URL (the production shape the writer now emits)", () => {
  // The Claude writer now emits http://127.0.0.1:<port> (not localhost) so the agent reaches
  // the IPv4 proxy on Windows. isLocalProxyUrl must accept it -- this is the production path.
  const home = isolate();
  writeClaude(home, join(home, PROXY_HELPER_NAME), "http://127.0.0.1:4141");
  const lines = envLines();
  expect(lines).toContain("export ANTHROPIC_BASE_URL='http://127.0.0.1:4141'");
});

test("env clears a stale 127.0.0.1 ANTHROPIC_BASE_URL when Claude switched to direct", () => {
  const home = isolate();
  writeClaude(home, join(home, DIRECT_HELPER_NAME), "https://api.githubcopilot.com");
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4141";
  const lines = envLines();
  expect(lines).toContain("unset ANTHROPIC_BASE_URL");
  expect(lines.some((l) => l.startsWith("export ANTHROPIC_BASE_URL"))).toBe(false);
});

test("env clears a stale localhost ANTHROPIC_BASE_URL when Claude switched to direct", () => {
  const home = isolate();
  // Claude is now DIRECT, but the shell still carries our old proxy URL.
  writeClaude(home, join(home, DIRECT_HELPER_NAME), "https://api.githubcopilot.com");
  process.env.ANTHROPIC_BASE_URL = "http://localhost:4141";
  const lines = envLines();
  expect(lines).toContain("unset ANTHROPIC_BASE_URL");
  expect(lines.some((l) => l.startsWith("export ANTHROPIC_BASE_URL"))).toBe(false);
});

test("env never touches a user's own (non-local) ANTHROPIC_BASE_URL", () => {
  const home = isolate();
  // Managed proxy helper, but the user hand-edited the URL to a remote host.
  writeClaude(home, join(home, PROXY_HELPER_NAME), "https://example.test");
  process.env.ANTHROPIC_BASE_URL = "https://example.test";
  const lines = envLines();
  // Not a localhost proxy URL => neither exported nor unset.
  expect(lines.some((l) => l.includes("ANTHROPIC_BASE_URL"))).toBe(false);
});

test("env does not unset a CODEX_HOME the user pointed elsewhere", () => {
  isolate();
  process.env.CODEX_HOME = join(dir, "my-own-codex"); // not the host farm path
  const lines = envLines();
  expect(lines.some((l) => l.includes("CODEX_HOME"))).toBe(false);
});

test("env emits a launchers source when the launchers are wired", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-env-cmd-"));
  wireLaunchers();
  const lines = childEnvLines(childBaseEnv());
  expect(lines.some(isLaunchersSource)).toBe(true);
});

test("env skips the launchers source when the launchers are not wired", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-env-cmd-")); // no .bashrc / launchers marker
  const lines = childEnvLines(childBaseEnv());
  expect(lines.some(isLaunchersSource)).toBe(false);
});
