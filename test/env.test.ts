import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { directHelperCommand, proxyHelperCommand } from "../src/claude/config.ts";
import { launcherFunctionLines, runEnv } from "../src/commands/env.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import { CI_PS_DOCUMENTS_DIR_ENV, CI_RC_DIR_ENV } from "../src/shell/integration.ts";
import { importSpecifier, ROOT, runCli, runSync } from "./helpers/run.ts";
import { afterEach, expect, test } from "./helpers/testing.ts";
import {
  claudeSettingsJson,
  envSnapshot,
  removeDir,
  tmpDir,
  writeClaudeSettings,
  writeRunState,
} from "./helpers.ts";

const restoreEnv = envSnapshot();
let dir = "";

afterEach(() => {
  restoreEnv();
  dir = removeDir(dir);
});

/** Run runEnv(posix) capturing its stdout lines. */
function envLines(profile?: string): string[] {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    runEnv({ format: "posix", profile });
  } finally {
    console.log = orig;
  }
  return lines;
}

function isolate(): string {
  dir = tmpDir("copilot-env-cmd-");
  process.env.HOME = dir;
  process.env.COPILOT_API_HOME = join(dir, "gw"); // empty state => no host CODEX_HOME
  // Unique need: `agent env` emits/clears CODEX_HOME and ANTHROPIC_BASE_URL exports based
  // on their CURRENT values, so both must start unset (not pointed at a temp home).
  delete process.env.CODEX_HOME;
  delete process.env.ANTHROPIC_BASE_URL;
  const claudeHome = join(dir, ".claude");
  mkdirSync(claudeHome, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  return claudeHome;
}

/**
 * Run `runEnv` in a CHILD process (`deno eval`) with HOME set at spawn time.
 * `agent env` is always a fresh process in production, so its rc-file scan
 * (os.homedir(), bound at process startup) resolves correctly only when HOME
 * is in the spawn environment -- which in-process runEnv() can't fake.
 */
function childEnvLines(env: Record<string, string | undefined>, profile?: string): string[] {
  const argsSrc = JSON.stringify({ "format": "posix", "profile": profile });
  const script = `import{runEnv}from${
    importSpecifier(join(ROOT, "src/commands/env.ts"))
  };runEnv(${argsSrc});`;
  const result = runSync(Deno.execPath(), ["eval", script], { env: { ...process.env, ...env } });
  if (result.exitCode !== 0) throw new Error(`child env failed: ${result.stderr}`);
  return result.stdout.split("\n").filter((l) => l.length > 0);
}

/** Base isolated env for a child `agent env`: no proxy state. */
function childBaseEnv(): Record<string, string | undefined> {
  const claudeHome = join(dir, ".claude");
  mkdirSync(claudeHome, { recursive: true });
  return {
    HOME: dir,
    USERPROFILE: dir,
    // The suite floor redirects rc lookups away from every real home; this child
    // wants them under ITS isolated home, so the seams point there explicitly -
    // BOTH of them: the POSIX rc seam and the Windows PS-Documents seam.
    [CI_RC_DIR_ENV]: dir,
    [CI_PS_DOCUMENTS_DIR_ENV]: join(dir, "Documents"),
    COPILOT_API_HOME: join(dir, "gw"),
    CLAUDE_CONFIG_DIR: claudeHome,
    CODEX_HOME: undefined,
    ANTHROPIC_BASE_URL: undefined,
  };
}

function writeClaude(home: string, apiKeyHelper: string, baseUrl: string): void {
  writeClaudeSettings(home, { apiKeyHelper, baseUrl });
}

test("env exports ANTHROPIC_BASE_URL when Claude is proxy at a localhost proxy URL", () => {
  const home = isolate();
  writeClaude(home, proxyHelperCommand(), "http://localhost:4141");
  const lines = envLines();
  expect(lines).toContain("export ANTHROPIC_BASE_URL='http://localhost:4141'");
});

test("env exports a 127.0.0.1 proxy URL (the production shape the writer now emits)", () => {
  // The Claude writer now emits http://127.0.0.1:<port> (not localhost) so the agent reaches
  // the IPv4 proxy on Windows. isLocalProxyUrl must accept it -- this is the production path.
  const home = isolate();
  writeClaude(home, proxyHelperCommand(), "http://127.0.0.1:4141");
  const lines = envLines();
  expect(lines).toContain("export ANTHROPIC_BASE_URL='http://127.0.0.1:4141'");
});

test("env clears a stale 127.0.0.1 ANTHROPIC_BASE_URL when Claude switched to direct", () => {
  const home = isolate();
  writeClaude(home, directHelperCommand(), "https://api.githubcopilot.com");
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4141";
  const lines = envLines();
  expect(lines).toContain("unset ANTHROPIC_BASE_URL");
  expect(lines.some((l) => l.startsWith("export ANTHROPIC_BASE_URL"))).toBe(false);
});

test("env clears a stale localhost ANTHROPIC_BASE_URL when Claude switched to direct", () => {
  const home = isolate();
  // Claude is now DIRECT, but the shell still carries our old proxy URL.
  writeClaude(home, directHelperCommand(), "https://api.githubcopilot.com");
  process.env.ANTHROPIC_BASE_URL = "http://localhost:4141";
  const lines = envLines();
  expect(lines).toContain("unset ANTHROPIC_BASE_URL");
  expect(lines.some((l) => l.startsWith("export ANTHROPIC_BASE_URL"))).toBe(false);
});

test("env never touches a user's own (non-local) ANTHROPIC_BASE_URL", () => {
  const home = isolate();
  // Managed proxy helper, but the user hand-edited the URL to a remote host.
  writeClaude(home, proxyHelperCommand(), "https://example.test");
  process.env.ANTHROPIC_BASE_URL = "https://example.test";
  const lines = envLines();
  // Not a localhost proxy URL => neither exported nor unset.
  expect(lines.some((l) => l.includes("ANTHROPIC_BASE_URL"))).toBe(false);
});

test("env leaves a localhost ANTHROPIC_BASE_URL alone when settings.json is unreadable", () => {
  const home = isolate();
  // A directory at the settings path EXISTS but cannot be read (the
  // cross-platform unreadable fixture).
  mkdirSync(join(home, "settings.json"));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4141";
  const lines = envLines();
  expect(lines.some((l) => l.includes("ANTHROPIC_BASE_URL"))).toBe(false);
});

test("env does not unset a CODEX_HOME the user pointed elsewhere", () => {
  isolate();
  process.env.CODEX_HOME = join(dir, "my-own-codex"); // not the host farm path
  const lines = envLines();
  expect(lines.some((l) => l.includes("CODEX_HOME"))).toBe(false);
});

// The exact launcher emissions, pinned per platform flavor: the wrappers eval these
// lines verbatim (agents.ps1 line by line, inside a function -- hence global:), so the
// spellings are external contracts. Every function delegates to `agent launch` with the
// user's args behind `--` (quoted on PowerShell, whose bare `--` token would be eaten).
const POSIX_LAUNCHER_LINES = [
  'cl() { agent launch claude -- "$@"; }',
  'co() { agent launch copilot -- "$@"; }',
  'cx() { agent launch codex -- "$@"; }',
  'clx() { agent launch claude --relaxed -- "$@"; }',
  'cox() { agent launch copilot --relaxed -- "$@"; }',
  'cxx() { agent launch codex --relaxed -- "$@"; }',
];
const PS_LAUNCHER_LINES = [
  "function global:cl { agent launch claude '--' @args }",
  "function global:co { agent launch copilot '--' @args }",
  "function global:cx { agent launch codex '--' @args }",
  "function global:clx { agent launch claude --relaxed '--' @args }",
  "function global:cox { agent launch copilot --relaxed '--' @args }",
  "function global:cxx { agent launch codex --relaxed '--' @args }",
];

test("launcherFunctionLines pins both platform flavors, feature-matched", () => {
  expect(launcherFunctionLines(false)).toEqual(POSIX_LAUNCHER_LINES);
  expect(launcherFunctionLines(true)).toEqual(PS_LAUNCHER_LINES);
});

test("env emits the launcher functions only when the launchers config key is on", () => {
  isolate();
  expect(envLines()).toEqual([]); // default: opt-in, so nothing is defined
  new CopilotEnvConfig().set({ launchers: true });
  expect(envLines()).toEqual(POSIX_LAUNCHER_LINES);
  new CopilotEnvConfig().set({ launchers: false });
  expect(envLines()).toEqual([]); // stored false stays off, same as unset
});

// --- --profile ------------------------------------------------------------------

/** Seed a named profile: its store slot (credential + mode, the atomic unit) +
 *  its run-state port reservation + its own settings-<name>.json (proxy or
 *  direct helper). */
function seedProfile(
  claudeHome: string,
  name: string,
  mode: "direct" | "proxy",
  port: number,
): void {
  const profile = parseProfileName(name);
  new CopilotEnvState().commitProfile(profile, {
    credential: { kind: "stored", provider: "gh-token", token: "ghp_seed" },
    mode,
  });
  writeRunState({ port }, profile);
  const helper = mode === "proxy" ? proxyHelperCommand(profile) : directHelperCommand(profile);
  const baseUrl = mode === "proxy" ? `http://127.0.0.1:${port}` : "https://api.githubcopilot.com";
  writeFileSync(
    join(claudeHome, `settings-${name}.json`),
    claudeSettingsJson({ apiKeyHelper: helper, baseUrl }),
  );
}

test("env (no flag) output is byte-identical to the default wiring, profiles present or not", () => {
  const home = isolate();
  writeClaude(home, proxyHelperCommand(), "http://127.0.0.1:4141");
  // The default eval contract, pinned as the EXACT full output (child process:
  // an isolated HOME keeps the machine's own launchers wiring out of the scan).
  const expected = ["export ANTHROPIC_BASE_URL='http://127.0.0.1:4141'"];
  expect(childEnvLines(childBaseEnv())).toEqual(expected);
  // Seeding a named profile (own slot, port, settings file) must not perturb the
  // no-flag output by a single byte.
  seedProfile(home, "work", "proxy", 4242);
  expect(childEnvLines(childBaseEnv())).toEqual(expected);
});

test("env --profile resolves a proxy profile's OWN settings file and port", () => {
  const home = isolate();
  // Default wiring points at a DIFFERENT port; the profile answer must come from
  // settings-work.json, never from the default settings.json.
  writeClaude(home, proxyHelperCommand(), "http://127.0.0.1:4141");
  seedProfile(home, "work", "proxy", 4242);
  expect(childEnvLines(childBaseEnv(), "work")).toEqual([
    "export ANTHROPIC_BASE_URL='http://127.0.0.1:4242'",
  ]);
});

test("env --profile for a direct profile clears a stale local proxy URL", () => {
  const home = isolate();
  // The default stays PROXY-wired: a direct profile must not inherit its export.
  writeClaude(home, proxyHelperCommand(), "http://127.0.0.1:4141");
  seedProfile(home, "work", "direct", 4242);
  expect(
    childEnvLines({ ...childBaseEnv(), ANTHROPIC_BASE_URL: "http://127.0.0.1:4242" }, "work"),
  ).toEqual(["unset ANTHROPIC_BASE_URL"]);
});

test("env --profile with an unknown name hard-fails naming the known profiles", () => {
  const home = isolate();
  expect(() => envLines("nope")).toThrow("no such profile 'nope' (no profiles exist");
  seedProfile(home, "work", "proxy", 4242);
  expect(() => envLines("nope")).toThrow("no such profile 'nope' (known profiles: work)");
});

test("cli env --profile unknown exits 1 with an EMPTY stdout (the eval contract)", () => {
  dir = tmpDir("copilot-env-cmd-");
  const proc = runCli(["env", "--profile", "nope"], {
    env: { ...process.env, ...childBaseEnv(), CONSOLA_LEVEL: "5" },
  });
  expect(proc.exitCode).toBe(1);
  // NOTHING may reach stdout: the shell wrapper evals it verbatim.
  expect(proc.stdout).toBe("");
  expect(proc.stderr).toContain("no such profile 'nope'");
});
