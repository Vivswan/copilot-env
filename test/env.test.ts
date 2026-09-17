import { mkdirSync, writeFileSync } from "node:fs";
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
  dir = removeDir(dir);
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
  // The default slot's recorded mode is what `agent env` renders from; the file is an output.
  new CopilotEnvState().recordDefaultMode(
    apiKeyHelper === proxyHelperCommand() ? "proxy" : "direct",
  );
}

// --- ANTHROPIC_BASE_URL: the default Claude wiring against the shell's current export ---------

test("env exports the proxy URL for a proxy-wired Claude and clears a stale local one for a direct-wired Claude", () => {
  const cases: { name: string; mode: "proxy" | "direct"; current?: string; lines: string[] }[] = [
    {
      // The Claude writer emits http://127.0.0.1:<port>, not localhost, so the agent reaches the
      // IPv4 proxy on Windows; isLocalProxyUrl must accept the production shape.
      name: "proxy exports 127.0.0.1",
      mode: "proxy",
      lines: ["export ANTHROPIC_BASE_URL='http://127.0.0.1:4141'"],
    },
    {
      name: "direct clears a stale 127.0.0.1",
      mode: "direct",
      current: "http://127.0.0.1:4141",
      lines: ["unset ANTHROPIC_BASE_URL"],
    },
    {
      name: "direct clears a stale localhost",
      mode: "direct",
      current: "http://localhost:4141",
      lines: ["unset ANTHROPIC_BASE_URL"],
    },
  ];
  for (const c of cases) {
    const home = isolate();
    if (c.mode === "proxy") writeClaude(home, proxyHelperCommand(), "http://127.0.0.1:4141");
    else writeClaude(home, directHelperCommand(), "https://api.githubcopilot.com");
    if (c.current !== undefined) process.env.ANTHROPIC_BASE_URL = c.current;
    expect(envLines(), c.name).toEqual(c.lines);
  }
});

// --- CODEX_HOME: the `codex-home` path and the `codex-host` farm ---------------------------

test("env exports a `codex-home` path on every platform, quietly, and never unsets a CODEX_HOME the user pointed elsewhere", () => {
  isolate();
  process.env.CODEX_HOME = join(dir, "my-own-codex"); // not the host farm path
  expect(envLines().some((l) => l.includes("CODEX_HOME"))).toBe(false);
  delete process.env.CODEX_HOME;
  const root = join(dir, "explicit-root");
  new CopilotEnvConfig().set({ "codex.home": root });
  expect(stderrDuring(() => expect(envLines()).toEqual([`export CODEX_HOME='${root}'`]))).toBe("");
});

/** The farm on disk: none, the directory alone, a blank config.toml, or a wired one. */
type Farm = "none" | "dir" | "empty" | "built";

function layFarm(hostHome: string, farm: Farm): void {
  if (farm === "none") return;
  mkdirSync(hostHome, { recursive: true });
  if (farm === "empty") writeFileSync(join(hostHome, "config.toml"), "");
  if (farm === "built") {
    writeFileSync(join(hostHome, "config.toml"), 'model_provider = "copilot-env"\n');
  }
}

skipWin(
  "env and the per-host farm: the codex-host key is the switch, the farm is the export's subject, and any drift is named beside the export, never swallowed",
  () => {
    const missing = (hostHome: string): string =>
      codexHostDriftLine({ kind: "missing", hostHome }).replaceAll("`", "");
    const unrecorded = (hostHome: string): string =>
      `no completed wiring pass is recorded for the per-host CODEX_HOME farm at ${hostHome}`;
    const cases: {
      name: string;
      config: { "codex.host"?: boolean; root?: boolean };
      farm: Farm;
      // The run-state record is what a successful wiring pass leaves; without it the farm is
      // not active.
      recorded: boolean;
      exported: boolean; // the shell already carries OUR export
      stdout: (hostHome: string) => string[];
      stderr: ((hostHome: string) => string) | null; // null: silent
    }[] = [
      // The key is the switch: unset exports nothing even for an activated farm and clears OUR
      // spelling at once.
      {
        name: "key unset, farm active",
        config: {},
        farm: "built",
        recorded: true,
        exported: false,
        stdout: () => [],
        stderr: null,
      },
      {
        name: "key unset, farm active, shell exports it",
        config: {},
        farm: "built",
        recorded: true,
        exported: true,
        stdout: () => ["unset CODEX_HOME"],
        stderr: null,
      },
      {
        name: "key false, no farm, shell exports it",
        config: { "codex.host": false },
        farm: "none",
        recorded: false,
        exported: true,
        stdout: () => ["unset CODEX_HOME"],
        stderr: null,
      },
      {
        name: "key on, farm wired",
        config: { "codex.host": true },
        farm: "built",
        recorded: true,
        exported: false,
        stdout: (h) => [`export CODEX_HOME='${h}'`],
        stderr: null,
      },
      // Wired but not recorded (no managed write succeeded there yet), half-built, or gone: still
      // the home the key names, so the export stays and the drift is warned about.
      {
        name: "key on, farm wired, no wiring pass recorded",
        config: { "codex.host": true },
        farm: "built",
        recorded: false,
        exported: false,
        stdout: (h) => [`export CODEX_HOME='${h}'`],
        stderr: unrecorded,
      },
      {
        name: "key on, blank config.toml",
        config: { "codex.host": true },
        farm: "empty",
        recorded: true,
        exported: false,
        stdout: (h) => [`export CODEX_HOME='${h}'`],
        stderr: missing,
      },
      {
        name: "key on, directory without config.toml",
        config: { "codex.host": true },
        farm: "dir",
        recorded: true,
        exported: false,
        stdout: (h) => [`export CODEX_HOME='${h}'`],
        stderr: missing,
      },
      {
        name: "key on, no farm",
        config: { "codex.host": true },
        farm: "none",
        recorded: false,
        exported: false,
        stdout: (h) => [`export CODEX_HOME='${h}'`],
        stderr: missing,
      },
      {
        name: "key on, no farm, shell exports it",
        config: { "codex.host": true },
        farm: "none",
        recorded: false,
        exported: true,
        stdout: (h) => [`export CODEX_HOME='${h}'`],
        stderr: missing,
      },
      // With a codex-home path the farm under the path is the subject: exported all the same
      // before it is built (the next `agent codex` builds it), quiet once it is.
      {
        name: "key on under a codex-home root, not built",
        config: { "codex.host": true, root: true },
        farm: "none",
        recorded: false,
        exported: false,
        stdout: (h) => [`export CODEX_HOME='${h}'`],
        stderr: missing,
      },
      {
        name: "key on under a codex-home root, wired",
        config: { "codex.host": true, root: true },
        farm: "built",
        recorded: true,
        exported: false,
        stdout: (h) => [`export CODEX_HOME='${h}'`],
        stderr: null,
      },
    ];
    for (const c of cases) {
      isolate();
      const root = join(dir, "explicit-root");
      const { root: underRoot, ...keys } = c.config;
      new CopilotEnvConfig().set(underRoot === true ? { ...keys, "codex.home": root } : keys);
      const hostHome = getHostLocalCodexHome();
      if (underRoot === true) expect(hostHome.startsWith(`${root}/`), c.name).toBe(true);
      layFarm(hostHome, c.farm);
      writeRunState({ codexHome: c.recorded ? hostHome : null });
      if (c.exported) process.env.CODEX_HOME = hostHome;
      const stderr = stderrDuring(() => expect(envLines(), c.name).toEqual(c.stdout(hostHome)));
      // consola drops the backticks when it renders inline code, so both sides are compared
      // without them.
      if (c.stderr === null) expect(stderr, c.name).toBe("");
      else expect(stderr.replaceAll("`", ""), c.name).toContain(c.stderr(hostHome));
    }
  },
);

skipWin(
  "cli env with codex-host on but no farm exits 0 with ONLY the export on stdout (the eval contract); the warning rides on stderr",
  () => {
    isolate();
    new CopilotEnvConfig().set({ "codex.host": true });
    const proc = runCli(["env"], {
      env: { ...process.env, ...childBaseEnv(), CONSOLA_LEVEL: "5" },
    });
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout).toBe(`export CODEX_HOME='${getHostLocalCodexHome()}'\n`);
    expect(proc.stderr).toContain("codex.host is on but the per-host CODEX_HOME farm is missing");
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
  new CopilotEnvConfig().set({ "shell.launchers": true });
  expect(envLines()).toEqual(POSIX_LAUNCHER_LINES);
  new CopilotEnvConfig().set({ "shell.launchers": false });
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

test("env --profile renders the profile's OWN settings file and port; without the flag the default wiring, profiles present or not", () => {
  const cases: {
    name: string;
    seed: "proxy" | "direct" | null;
    profile?: string;
    current?: string;
    lines: string[];
  }[] = [
    // A child with an isolated HOME keeps the machine's own launcher wiring out of the scan.
    {
      name: "no flag, no profiles",
      seed: null,
      lines: ["export ANTHROPIC_BASE_URL='http://127.0.0.1:4141'"],
    },
    {
      name: "no flag, a profile present",
      seed: "proxy",
      lines: ["export ANTHROPIC_BASE_URL='http://127.0.0.1:4141'"],
    },
    // The default wiring sits on a DIFFERENT port, so the answer can only come from settings-work.json.
    {
      name: "--profile, proxy profile",
      seed: "proxy",
      profile: "work",
      lines: ["export ANTHROPIC_BASE_URL='http://127.0.0.1:4242'"],
    },
    // The default stays PROXY-wired: a direct profile must not inherit its export.
    {
      name: "--profile, direct profile clears its stale local URL",
      seed: "direct",
      profile: "work",
      current: "http://127.0.0.1:4242",
      lines: ["unset ANTHROPIC_BASE_URL"],
    },
  ];
  for (const c of cases) {
    const home = isolate();
    writeClaude(home, proxyHelperCommand(), "http://127.0.0.1:4141");
    if (c.seed !== null) seedProfile(home, "work", c.seed, 4242);
    const env = c.current === undefined
      ? childBaseEnv()
      : { ...childBaseEnv(), ANTHROPIC_BASE_URL: c.current };
    expect(childEnvLines(env, c.profile), c.name).toEqual(c.lines);
  }
});

test("env --profile with an unknown name hard-fails naming the known profiles, and the CLI exits 1 with an EMPTY stdout (the eval contract)", () => {
  const home = isolate();
  expect(() => envLines("nope")).toThrow("no such profile 'nope' (no profiles exist");
  const proc = runCli(["env", "--profile", "nope"], {
    env: { ...process.env, ...childBaseEnv(), CONSOLA_LEVEL: "5" },
  });
  expect(proc.exitCode).toBe(1);
  // NOTHING may reach stdout: the shell wrapper evals it verbatim.
  expect(proc.stdout).toBe("");
  expect(proc.stderr).toContain("no such profile 'nope'");
  seedProfile(home, "work", "proxy", 4242);
  expect(() => envLines("nope")).toThrow("no such profile 'nope' (known profiles: work)");
});
