import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { directHelperCommand, proxyHelperCommand } from "../src/claude/config.ts";
import { codexHostDriftLine, getHostLocalCodexHome } from "../src/codex/host.ts";
import { launcherFunctionLines, runEnv } from "../src/commands/env.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import { CI_PS_DOCUMENTS_DIR_ENV, CI_RC_DIR_ENV } from "../src/shell/integration.ts";
import {
  CHILD_VALUES,
  childValuesEnv,
  importSpecifier,
  ROOT,
  runCli,
  runSync,
} from "./helpers/run.ts";
import { afterEach, expect, removeDir, tempDir, test } from "./helpers/testing.ts";
import { claudeSettingsJson, envSnapshot, writeClaudeSettings, writeRunState } from "./helpers.ts";

const restoreEnv = envSnapshot();
let dir = "";

// The per-host farm needs POSIX symlinks; on Windows the `codex-host` key always
// reads off, so the CODEX_HOME export tests run on Linux/macOS only.
const skipWin = test.skipIf(process.platform === "win32");

afterEach(() => {
  restoreEnv();
  dir = removeDir(dir);
});

/** Everything `run` writes to stderr (the one place `agent env` may talk). */
function stderrDuring(run: () => void): string {
  const original = process.stderr.write;
  let captured = "";
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  return captured;
}

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
  dir = tempDir("copilot-env-cmd-");
  process.env.HOME = dir;
  process.env.COPILOT_API_HOME = join(dir, "gw"); // empty state -> no host CODEX_HOME
  // `agent env` emits or clears these exports based on their CURRENT values, so both must start unset.
  delete process.env.CODEX_HOME;
  delete process.env.ANTHROPIC_BASE_URL;
  const claudeHome = join(dir, ".claude");
  mkdirSync(claudeHome, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  return claudeHome;
}

// In production `agent env` is always a fresh process spawned by the shell wrapper, so these cases
// run runEnv the same way: a child whose spawn environment carries the isolated homes.
function childEnvLines(env: Record<string, string | undefined>, profile?: string): string[] {
  const script = `import{runEnv}from${
    importSpecifier(join(ROOT, "src/commands/env.ts"))
  };runEnv(${CHILD_VALUES});`;
  const result = runSync(Deno.execPath(), ["eval", script], {
    env: { ...process.env, ...env, ...childValuesEnv({ "format": "posix", "profile": profile }) },
  });
  if (result.exitCode !== 0) throw new Error(`child env failed: ${result.stderr}`);
  return result.stdout.split("\n").filter((l) => l.length > 0);
}

function childBaseEnv(): Record<string, string | undefined> {
  const claudeHome = join(dir, ".claude");
  mkdirSync(claudeHome, { recursive: true });
  return {
    HOME: dir,
    USERPROFILE: dir,
    // The suite floor redirects rc lookups away from every real home; this child wants them under
    // ITS home, so both seams (POSIX rc and Windows PS-Documents) point there explicitly.
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
  // The Claude writer emits http://127.0.0.1:<port>, not localhost, so the agent reaches the IPv4
  // proxy on Windows; isLocalProxyUrl must accept the production shape.
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
  writeClaude(home, directHelperCommand(), "https://api.githubcopilot.com");
  process.env.ANTHROPIC_BASE_URL = "http://localhost:4141";
  const lines = envLines();
  expect(lines).toContain("unset ANTHROPIC_BASE_URL");
  expect(lines.some((l) => l.startsWith("export ANTHROPIC_BASE_URL"))).toBe(false);
});

test("env never touches a user's own (non-local) ANTHROPIC_BASE_URL", () => {
  const home = isolate();
  writeClaude(home, proxyHelperCommand(), "https://example.test");
  process.env.ANTHROPIC_BASE_URL = "https://example.test";
  const lines = envLines();
  expect(lines.some((l) => l.includes("ANTHROPIC_BASE_URL"))).toBe(false);
});

test("env leaves a localhost ANTHROPIC_BASE_URL alone when settings.json is unreadable", () => {
  const home = isolate();
  // A directory at the settings path exists but cannot be read, on every platform.
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

// --- CODEX_HOME: the `codex-host` key against the farm on disk -------------------

// The run-state record is what a successful wiring pass leaves; without it the farm is not active.
function wireFarm(): string {
  const hostHome = getHostLocalCodexHome();
  mkdirSync(hostHome, { recursive: true });
  writeFileSync(join(hostHome, "config.toml"), 'model_provider = "copilot-env"\n');
  writeRunState({ codexHome: hostHome });
  return hostHome;
}

skipWin(
  "env exports CODEX_HOME only while codex-host is on AND a wiring pass activated the farm",
  () => {
    isolate();
    const hostHome = wireFarm();
    // The key is the switch: unset exports nothing even for an activated farm and clears OUR spelling at once.
    expect(envLines()).toEqual([]);
    process.env.CODEX_HOME = hostHome;
    expect(envLines()).toEqual(["unset CODEX_HOME"]);
    delete process.env.CODEX_HOME;
    new CopilotEnvConfig().set({ codexHost: true });
    expect(envLines()).toEqual([`export CODEX_HOME='${hostHome}'`]);
    // Wired but not recorded: no managed write succeeded there yet.
    writeRunState({ codexHome: null });
    expect(stderrDuring(() => expect(envLines()).toEqual([]))).toContain(
      `${hostHome} is not the active CODEX_HOME`,
    );
    writeRunState({ codexHome: hostHome });
    // A half-built farm (an EMPTY seeded config.toml, or none) is not a home Codex can use.
    writeFileSync(join(hostHome, "config.toml"), "");
    expect(stderrDuring(() => expect(envLines()).toEqual([]))).toContain("farm is missing");
    rmSync(join(hostHome, "config.toml"));
    expect(stderrDuring(() => expect(envLines()).toEqual([]))).toContain("farm is missing");
  },
);

skipWin(
  "env with codex-host on but no farm: clean stdout, one stderr warning naming `agent codex`",
  () => {
    isolate();
    const hostHome = getHostLocalCodexHome();
    new CopilotEnvConfig().set({ codexHost: true });
    let stdout: string[] = ["unset"];
    const stderr = stderrDuring(() => {
      stdout = envLines();
    });
    // consola drops the backticks when it renders inline code, so both sides are compared without them.
    expect(stdout).toEqual([]);
    expect(stderr.replaceAll("`", "")).toContain(
      codexHostDriftLine({ kind: "missing", hostHome }).replaceAll("`", ""),
    );
    // A shell still carrying OUR dead export gets it cleared, whatever the key says.
    process.env.CODEX_HOME = hostHome;
    expect(stderrDuring(() => expect(envLines()).toEqual(["unset CODEX_HOME"]))).toContain(
      "farm is missing",
    );
    new CopilotEnvConfig().set({ codexHost: false });
    expect(stderrDuring(() => expect(envLines()).toEqual(["unset CODEX_HOME"]))).toBe("");
  },
);

skipWin(
  "cli env with codex-host on but no farm exits 0 with an EMPTY stdout (the eval contract)",
  () => {
    isolate();
    new CopilotEnvConfig().set({ codexHost: true });
    const proc = runCli(["env"], {
      env: { ...process.env, ...childBaseEnv(), CONSOLA_LEVEL: "5" },
    });
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout).toBe("");
    expect(proc.stderr).toContain("codex-host is on but the per-host CODEX_HOME farm is missing");
  },
);

// The wrappers eval these lines verbatim (agents.ps1 line by line inside a function, hence global:),
// so the spellings are external contracts. PowerShell quotes the `--` because a bare `--` token would be eaten.
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
  // A child with an isolated HOME keeps the machine's own launcher wiring out of the scan.
  const expected = ["export ANTHROPIC_BASE_URL='http://127.0.0.1:4141'"];
  expect(childEnvLines(childBaseEnv())).toEqual(expected);
  seedProfile(home, "work", "proxy", 4242);
  expect(childEnvLines(childBaseEnv())).toEqual(expected);
});

test("env --profile resolves a proxy profile's OWN settings file and port", () => {
  const home = isolate();
  // The default wiring sits on a DIFFERENT port, so the answer can only come from settings-work.json.
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
  dir = tempDir("copilot-env-cmd-");
  const proc = runCli(["env", "--profile", "nope"], {
    env: { ...process.env, ...childBaseEnv(), CONSOLA_LEVEL: "5" },
  });
  expect(proc.exitCode).toBe(1);
  // NOTHING may reach stdout: the shell wrapper evals it verbatim.
  expect(proc.stdout).toBe("");
  expect(proc.stderr).toContain("no such profile 'nope'");
});
