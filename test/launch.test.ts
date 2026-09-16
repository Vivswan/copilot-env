import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import type { AgentProviderMode } from "../src/agents/provider_mode.ts";
import { directHelperCommand, proxyHelperCommand } from "../src/claude/config.ts";
import {
  type LaunchAction,
  type LaunchDeps,
  parseLaunchAction,
  prepareLaunch,
} from "../src/commands/launch.ts";
import type { ManagedEnvValue } from "../src/commands/env.ts";
import type { ProfileMode, ProfileSlot, TokenProvider } from "../src/copilot_api/env_state.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import type { CatalogModel } from "../src/copilot_api/models.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import { runCli, spawnChild } from "./helpers/run.ts";
import { afterEach, expect, tempDir, test } from "./helpers/testing.ts";
import { writeClaudeSettings, writeCodexConfigToml, writeRunState } from "./helpers.ts";

const WORK = parseProfileName("work");
const skipWin = test.skipIf(process.platform === "win32");

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});
function e2eRoot(): string {
  const root = tempDir("copilot-launch-");
  roots.push(root);
  return root;
}

// --- parseLaunchAction ----------------------------------------------------------

test("parseLaunchAction rejects an unknown CLI naming the choices", () => {
  expect(() => parseLaunchAction({ cli: "cursor", args: [] })).toThrow(
    "unknown agent CLI 'cursor' (expected claude | codex | copilot)",
  );
});

test("parseLaunchAction hoists a LEADING --profile pair for claude/codex only", () => {
  // The shell rc launcher (`cl --profile work --resume`) hands the whole tail through as args, so
  // the leading pair is hoisted here.
  expect(parseLaunchAction({ cli: "claude", args: ["--profile", "work", "--resume"] })).toEqual({
    kind: "claude",
    profile: WORK,
    relaxed: false,
    args: ["--resume"],
  });
  expect(parseLaunchAction({ cli: "codex", args: ["--profile", "work"] })).toEqual({
    kind: "codex",
    profile: WORK,
    relaxed: false,
    args: [],
  });
  // A NON-leading pair is the agent CLI's own business.
  expect(parseLaunchAction({ cli: "claude", args: ["--resume", "--profile", "work"] })).toEqual({
    kind: "claude",
    profile: null,
    relaxed: false,
    args: ["--resume", "--profile", "work"],
  });
  expect(parseLaunchAction({ cli: "copilot", args: ["--profile", "work"] })).toEqual({
    kind: "copilot",
    relaxed: false,
    args: ["--profile", "work"],
  });
});

test("parseLaunchAction: the explicit --profile flag wins; the pair then rides through", () => {
  expect(
    parseLaunchAction({ cli: "claude", profile: "work", args: ["--profile", "other"] }),
  ).toEqual({
    kind: "claude",
    profile: WORK,
    relaxed: false,
    args: ["--profile", "other"],
  });
});

test("parseLaunchAction rejects --profile on copilot and validates hoisted names", () => {
  expect(() => parseLaunchAction({ cli: "copilot", profile: "work", args: [] })).toThrow(
    "--profile does not apply to copilot",
  );
  expect(() => parseLaunchAction({ cli: "claude", profile: "", args: [] })).toThrow(
    "invalid profile name",
  );
  // A hoisted name goes through the same smart constructor as the flag.
  expect(() => parseLaunchAction({ cli: "codex", args: ["--profile", "NOT VALID"] })).toThrow(
    "invalid profile name",
  );
  // `--profile` with an EMPTY next arg is not a pair (the rc `-n "$2"` guard):
  // both tokens pass through.
  expect(parseLaunchAction({ cli: "claude", args: ["--profile", ""] })).toEqual({
    kind: "claude",
    profile: null,
    relaxed: false,
    args: ["--profile", ""],
  });
});

// --- prepareLaunch over scripted deps --------------------------------------------

function completeSlot(mode: ProfileMode, provider: TokenProvider = "gh-token"): ProfileSlot {
  return {
    kind: "complete",
    credential: { kind: "stored", provider, token: "tok" },
    mode,
    integrationIdentity: null,
  };
}

function partialSlot(mode: ProfileMode | null = null): ProfileSlot {
  return {
    kind: "partial",
    credential: { kind: "none", provider: null },
    mode,
    integrationIdentity: null,
  };
}

interface DepsScript {
  mode?: AgentProviderMode;
  proxyUp?: boolean;
  slot?: ProfileSlot;
  claudeUrl?: ManagedEnvValue;
  codexHome?: ManagedEnvValue;
  /** The managed CODEX_HOME exists only AFTER a wire/sync ran (a pass built the farm). */
  codexHomeOnceWired?: boolean;
  syncThrows?: boolean;
  /** What `claude --settings` gets for a profile launch. */
  settingsPath?: string;
  /** Absent = the fetch failed. */
  catalog?: CatalogModel[];
}

function scriptedDeps(script: DepsScript = {}): {
  deps: LaunchDeps;
  calls: string[];
  notes: string[];
} {
  const calls: string[] = [];
  const notes: string[] = [];
  const deps: LaunchDeps = {
    agentMode: (agent) => {
      calls.push(`mode:${agent}`);
      return script.mode ?? "direct";
    },
    ensureProxy: (profile) => {
      calls.push(`ensure:${profile ?? "(default)"}`);
      return Promise.resolve(script.proxyUp ?? true);
    },
    wireProxyDefault: (agent) => {
      calls.push(`wire:${agent}`);
      return Promise.resolve();
    },
    refreshCodexCatalog: () => {
      calls.push("catalog:refresh");
      return Promise.resolve();
    },
    profileSlot: (name) => {
      calls.push(`slot:${name}`);
      return script.slot ?? partialSlot();
    },
    writeClaudeProfileSettings: (name, mode) => {
      calls.push(`settings:${name}:${mode}`);
      return Promise.resolve(script.settingsPath ?? `/fake/settings-${name}.json`);
    },
    syncProfileWiring: (name, mode) => {
      calls.push(`sync:${name}:${mode}`);
      return script.syncThrows ? Promise.reject(new Error("boom")) : Promise.resolve();
    },
    managedClaudeBaseUrl: () => script.claudeUrl ?? null,
    managedCodexHome: () => {
      const wired = calls.some((c) => c.startsWith("wire:") || c.startsWith("sync:"));
      // Throw, not null: an early read followed by a correct one must fail too.
      if (script.codexHomeOnceWired && !wired) {
        throw new Error("managedCodexHome read before the wiring step");
      }
      return script.codexHome ?? null;
    },
    claudeCatalog: (mode, profile) => {
      calls.push(`catalog:${mode}:${profile ?? "(default)"}`);
      return Promise.resolve(script.catalog ?? null);
    },
    notify: (line) => notes.push(line),
  };
  return { deps, calls, notes };
}

const claudeDefault = (relaxed = false, args: string[] = []): LaunchAction => ({
  kind: "claude",
  profile: null,
  relaxed,
  args,
});

test("claude direct: no proxy work, managed flags + env, stale local URL scrubbed", async () => {
  const { deps, calls, notes } = scriptedDeps({ mode: "direct", claudeUrl: { unset: true } });
  const plan = await prepareLaunch(claudeDefault(false, ["--resume", "x"]), deps);
  expect(plan).toEqual({
    command: "claude",
    args: ["--permission-mode", "auto", "--enable-auto-mode", "--resume", "x"],
    env: { CLAUDE_CODE_NO_FLICKER: "1" },
    scrub: ["ANTHROPIC_BASE_URL"],
  });
  expect(calls).toEqual(["mode:claude", "catalog:direct:(default)"]);
  expect(notes).toEqual([]);
});

test("claude proxy/none: ensure THEN re-wire, fresh proxy URL exported", async () => {
  for (const mode of ["proxy", "none"] as const) {
    const { deps, calls } = scriptedDeps({
      mode,
      claudeUrl: { value: "http://127.0.0.1:4242" },
    });
    const plan = await prepareLaunch(claudeDefault(), deps);
    // Ensure precedes the re-wire: a cold start may move the port the wiring bakes.
    expect(calls).toEqual([
      "mode:claude",
      "ensure:(default)",
      "wire:claude",
      "catalog:proxy:(default)",
    ]);
    expect(plan?.env).toEqual({
      CLAUDE_CODE_NO_FLICKER: "1",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:4242",
    });
    expect(plan?.scrub).toEqual([]);
  }
});

test("claude proxy: a failed ensure aborts before any wiring or launch", async () => {
  const { deps, calls } = scriptedDeps({ mode: "proxy", proxyUp: false });
  expect(await prepareLaunch(claudeDefault(), deps)).toBeNull();
  expect(calls).toEqual(["mode:claude", "ensure:(default)"]);
});

test("claude 'other': launched as-is with a note, config never touched", async () => {
  const { deps, calls, notes } = scriptedDeps({ mode: "other" });
  const plan = await prepareLaunch(claudeDefault(), deps);
  expect(plan?.args).toEqual(["--permission-mode", "auto", "--enable-auto-mode"]);
  expect(calls).toEqual(["mode:claude"]);
  expect(notes).toEqual([
    "agent launch: Claude has a custom or unrecognized provider config " +
    "(not managed by copilot-env); launching it as-is.",
  ]);
});

test("claude --relaxed: IS_SANDBOX=1 and the skip flag behind the managed set", async () => {
  const { deps } = scriptedDeps({ mode: "direct" });
  const plan = await prepareLaunch(claudeDefault(true, ["hi"]), deps);
  expect(plan?.env).toEqual({ CLAUDE_CODE_NO_FLICKER: "1", IS_SANDBOX: "1" });
  expect(plan?.args).toEqual([
    "--permission-mode",
    "auto",
    "--enable-auto-mode",
    "--dangerously-skip-permissions",
    "hi",
  ]);
});

test("claude --profile: settings synced, base URL scrubbed unconditionally", async () => {
  const { deps, calls } = scriptedDeps({
    slot: completeSlot("proxy"),
    // Even a set-verdict must not leak into a profile launch: the profile's own
    // settings file carries its URL.
    claudeUrl: { value: "http://127.0.0.1:4141" },
  });
  const plan = await prepareLaunch(
    { kind: "claude", profile: WORK, relaxed: false, args: ["--resume"] },
    deps,
  );
  expect(calls).toEqual(["slot:work", "ensure:work", "settings:work:proxy", "catalog:proxy:work"]);
  expect(plan).toEqual({
    command: "claude",
    args: [
      "--settings",
      "/fake/settings-work.json",
      "--permission-mode",
      "auto",
      "--enable-auto-mode",
      "--resume",
    ],
    env: { CLAUDE_CODE_NO_FLICKER: "1" },
    scrub: ["ANTHROPIC_BASE_URL"],
  });
});

test("a direct profile never touches the proxy; missing/credential-less ones hard-fail", async () => {
  const direct = scriptedDeps({ slot: completeSlot("direct", "copilot") });
  await prepareLaunch({ kind: "claude", profile: WORK, relaxed: false, args: [] }, direct.deps);
  expect(direct.calls).toEqual(["slot:work", "settings:work:direct", "catalog:direct:work"]);

  const missing = scriptedDeps({ slot: partialSlot() });
  await expect(
    prepareLaunch({ kind: "codex", profile: WORK, relaxed: false, args: [] }, missing.deps),
  ).rejects.toThrow(
    "profile 'work' does not exist - create it with `agent profile --add work --direct|--proxy`",
  );

  const credless = scriptedDeps({ slot: partialSlot("proxy") });
  await expect(
    prepareLaunch({ kind: "claude", profile: WORK, relaxed: false, args: [] }, credless.deps),
  ).rejects.toThrow(
    "profile 'work' has no credential - repair it with `agent auth --profile work` " +
      "or `agent profile --add work`",
  );
});

test("codex default: managed CODEX_HOME applied; proxy mode ensures then re-wires", async () => {
  const { deps, calls } = scriptedDeps({
    mode: "proxy",
    codexHome: { value: "/fake/codex-farm" },
    codexHomeOnceWired: true, // the farm the re-wire just built must reach the child env
  });
  const plan = await prepareLaunch(
    { kind: "codex", profile: null, relaxed: true, args: ["exec", "ls"] },
    deps,
  );
  expect(calls).toEqual(["mode:codex", "ensure:(default)", "wire:codex"]);
  expect(plan).toEqual({
    command: "codex",
    args: ["--sandbox", "danger-full-access", "exec", "ls"],
    env: { CODEX_HOME: "/fake/codex-farm" },
    scrub: [],
  });
});

test("codex --profile: ensure daemon FIRST, then sync; a failed sync warns and launches", async () => {
  const ok = scriptedDeps({
    slot: completeSlot("proxy"),
    codexHome: { value: "/fake/codex-farm" },
    codexHomeOnceWired: true, // the farm the sync just made wired must reach the child env
  });
  const plan = await prepareLaunch(
    { kind: "codex", profile: WORK, relaxed: false, args: ["--resume"] },
    ok.deps,
  );
  expect(ok.calls).toEqual(["slot:work", "ensure:work", "sync:work:proxy"]);
  expect(plan?.args).toEqual(["--profile", "work", "--resume"]);
  expect(plan?.env).toEqual({ CODEX_HOME: "/fake/codex-farm" });

  const broken = scriptedDeps({ slot: completeSlot("proxy"), syncThrows: true });
  const degraded = await prepareLaunch(
    { kind: "codex", profile: WORK, relaxed: false, args: [] },
    broken.deps,
  );
  expect(degraded?.args).toEqual(["--profile", "work"]);
  expect(broken.notes).toEqual([
    "agent launch: could not refresh the profile wiring; launching with the " +
    "existing config (boom).",
  ]);
});

test("copilot: the managed flag set verbatim, --relaxed adds --allow-all", async () => {
  const { deps, calls } = scriptedDeps();
  expect(await prepareLaunch({ kind: "copilot", relaxed: false, args: ["hey"] }, deps)).toEqual({
    command: "copilot",
    args: ["--autopilot", "--enable-reasoning-summaries", "--experimental", "hey"],
    env: {},
    scrub: [],
  });
  expect(await prepareLaunch({ kind: "copilot", relaxed: true, args: [] }, deps)).toEqual({
    command: "copilot",
    args: ["--autopilot", "--enable-reasoning-summaries", "--experimental", "--allow-all"],
    env: {},
    scrub: [],
  });
  expect(calls).toEqual([]);
});

// --- the saved-model check ----------------------------------------------------------

const DIRECT_BASE = "https://api.githubcopilot.com";

const CATALOG: CatalogModel[] = [
  { id: "claude-sonnet-4.5", is1m: false },
  { id: "claude-opus-4.1", is1m: true },
  { id: "gpt-5", is1m: false },
];

test("claude launch warns once when the session's model is outside the Copilot catalog, and only then", async () => {
  const root = e2eRoot();
  const claudeHome = join(root, ".claude");
  mkdirSync(claudeHome);
  const settingsPath = join(claudeHome, "settings-work.json");
  const userSettingsPath = join(claudeHome, "settings.json");
  const previous = {
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
  };
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  delete process.env.ANTHROPIC_MODEL;
  try {
    await savedModelCases(settingsPath, userSettingsPath);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

/** The warning shows a home-relative path, and a temp root may sit under the home (Windows). */
function shown(path: string): string {
  const home = homedir();
  return path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

/** A settings document: `env` is the file's env block, a blank entry included (Claude Code merges
 *  the files per key, so a blank in the winning file masks the value below it). */
function settingsDoc(model: string | null, env?: string): string {
  return JSON.stringify({
    ...(model === null ? {} : { model }),
    ...(env === undefined ? {} : { env: { ANTHROPIC_MODEL: env } }),
  });
}

async function savedModelCases(settingsPath: string, userSettingsPath: string): Promise<void> {
  // Warn only: whatever the verdict, the argv never gains a model.
  const argvFor = (args: string[]) => [
    "--settings",
    settingsPath,
    "--permission-mode",
    "auto",
    "--enable-auto-mode",
    ...args,
  ];
  const notInCatalog = (model: string, source = shown(settingsPath)) =>
    `WARN Claude model '${model}' (from ${source}) is not in the Copilot catalog; ` +
    "try /model claude-sonnet-4.5";
  const cases: {
    saved: string | null;
    /** The profile file's own env block entry. */
    savedEnv?: string;
    /** The `model` (and env block entry) of the user settings.json the profile file merges over. */
    user?: string;
    userEnv?: string;
    env?: string;
    mode?: ProfileMode;
    catalog?: CatalogModel[];
    notes: string[];
  }[] = [
    { saved: "claude-sonnet-4.5", notes: [] },
    // Claude Code strips `[1m]` before the request; the family shorthand is its own alias.
    { saved: "claude-opus-4.1[1m]", notes: [] },
    { saved: "opus", notes: [] },
    // A fresh install's built-in default, which Copilot does not serve.
    { saved: "claude-opus-5[1m]", notes: [notInCatalog("claude-opus-5[1m]")] },
    // The proxy's alias map resolves the dash form; Direct sends it as-is.
    { saved: "claude-opus-4-1", mode: "proxy", notes: [] },
    { saved: "claude-opus-4-1", notes: [notInCatalog("claude-opus-4-1")] },
    // Claude Code resolves the rest of the chain: `--settings` merges over settings.json, and
    // $ANTHROPIC_MODEL beats every `model` key.
    {
      saved: null,
      user: "claude-opus-5[1m]",
      notes: [notInCatalog("claude-opus-5[1m]", shown(userSettingsPath))],
    },
    { saved: "claude-sonnet-4.5", user: "claude-opus-5[1m]", notes: [] },
    {
      saved: "claude-sonnet-4.5",
      env: "claude-opus-5[1m]",
      notes: [notInCatalog("claude-opus-5[1m]", "$ANTHROPIC_MODEL")],
    },
    {
      saved: "claude-sonnet-4.5",
      userEnv: "claude-opus-5[1m]",
      notes: [
        notInCatalog("claude-opus-5[1m]", `env.ANTHROPIC_MODEL in ${shown(userSettingsPath)}`),
      ],
    },
    // A blank entry in the winning file masks the user's; Claude Code then reads it as unset.
    { saved: "claude-sonnet-4.5", savedEnv: "", userEnv: "claude-opus-5[1m]", notes: [] },
    // No model saved: the built-in default is unknown to us, so only an empty Claude catalog warns.
    { saved: null, notes: [] },
    {
      saved: null,
      catalog: [{ id: "gpt-5", is1m: false }],
      notes: [
        "WARN the Copilot catalog lists no Claude model, so Claude Code's built-in default model cannot be served",
      ],
    },
  ];
  for (const c of cases) {
    writeFileSync(settingsPath, settingsDoc(c.saved, c.savedEnv));
    writeFileSync(userSettingsPath, settingsDoc(c.user ?? null, c.userEnv));
    if (c.env === undefined) delete process.env.ANTHROPIC_MODEL;
    else process.env.ANTHROPIC_MODEL = c.env;
    const mode = c.mode ?? "direct";
    const { deps, notes } = scriptedDeps({
      slot: completeSlot(mode),
      settingsPath,
      catalog: c.catalog ?? CATALOG,
    });
    const plan = await prepareLaunch(
      { kind: "claude", profile: WORK, relaxed: false, args: [] },
      deps,
    );
    expect(plan?.args).toEqual(argvFor([]));
    expect(notes).toEqual(c.notes);
  }

  // An explicit --model, or a --settings of the user's own, is their choice: no fetch, no warning,
  // whatever is saved.
  delete process.env.ANTHROPIC_MODEL;
  writeFileSync(settingsPath, JSON.stringify({ model: "claude-opus-5[1m]" }));
  for (
    const args of [
      ["--model", "claude-opus-5"],
      ["--model=opus", "--resume"],
      ["--settings", '{"model":"claude-sonnet-4.5"}'],
    ]
  ) {
    const flagged = scriptedDeps({ slot: completeSlot("direct"), settingsPath, catalog: CATALOG });
    const plan = await prepareLaunch(
      { kind: "claude", profile: WORK, relaxed: false, args },
      flagged.deps,
    );
    expect(plan?.args).toEqual(argvFor(args));
    expect(flagged.calls).not.toContain("catalog:direct:work");
    expect(flagged.notes).toEqual([]);
  }

  // A failed fetch is silent and the launch proceeds: the check is best effort.
  const unreachable = scriptedDeps({ slot: completeSlot("direct"), settingsPath });
  const plan = await prepareLaunch(
    { kind: "claude", profile: WORK, relaxed: false, args: [] },
    unreachable.deps,
  );
  expect(plan?.args).toEqual(argvFor([]));
  expect(unreachable.notes).toEqual([]);
}

test("claude direct: a foreign ANTHROPIC_BASE_URL the launch keeps is never judged against Copilot", async () => {
  // The child inherits the shell's URL when the plan neither sets nor scrubs it (the --relaxed e2e
  // below pins that it is kept), so the session talks to that gateway, not to Copilot.
  const previous = process.env.ANTHROPIC_BASE_URL;
  try {
    for (
      const [url, fetched] of [
        ["https://my-gateway.example", false],
        [DIRECT_BASE, true],
      ] as const
    ) {
      process.env.ANTHROPIC_BASE_URL = url;
      const { deps, calls } = scriptedDeps({ mode: "direct", catalog: CATALOG });
      const plan = await prepareLaunch(claudeDefault(), deps);
      expect(plan?.scrub).toEqual([]);
      expect(calls.includes("catalog:direct:(default)")).toBe(fetched);
    }
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = previous;
  }
});

// --- POSIX end-to-end against fake agent CLIs -------------------------------------

function fakeCliBin(root: string, command: string, exitCode = 0): string {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  // One indexed line per argv element, so word boundaries are pinned exactly
  // (a joined "$*" could not tell one "x y" argument from two).
  const script = [
    "#!/bin/sh",
    'echo "ARGS=$*"',
    'i=0; for a in "$@"; do i=$((i+1)); echo "ARG$i=[$a]"; done',
    'echo "BASE=${ANTHROPIC_BASE_URL-unset}"',
    'echo "FLICKER=${CLAUDE_CODE_NO_FLICKER-unset}"',
    'echo "SANDBOX=${IS_SANDBOX-unset}"',
    `exit ${exitCode}`,
    "",
  ].join("\n");
  writeFileSync(join(bin, command), script);
  chmodSync(join(bin, command), 0o755);
  return bin;
}

function launchEnv(root: string, bin: string): Record<string, string> {
  // IS_SANDBOX is what the direct launch under test decides; a harness that set it
  // for THIS process (Claude Code's sandbox does) must not leak into the assertions.
  const { IS_SANDBOX: _sandbox, ...inherited } = process.env;
  return {
    ...inherited,
    CONSOLA_LEVEL: "5",
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HOME: root,
    USERPROFILE: root,
    COPILOT_API_HOME: join(root, "api-home"),
    CLAUDE_CONFIG_DIR: join(root, ".claude"),
    CODEX_HOME: join(root, ".codex"),
  };
}

function recordedMode(root: string): string | undefined {
  const statePath = join(root, "api-home", "credentials.json");
  if (!existsSync(statePath)) return undefined;
  const state = JSON.parse(readFileSync(statePath, "utf8")) as {
    profiles?: { default?: { mode?: string } };
  };
  return state.profiles?.default?.mode;
}

skipWin("e2e: a direct Claude launch composes flags and scrubs a stale local URL", () => {
  const root = e2eRoot();
  const bin = fakeCliBin(root, "claude", 7);
  writeClaudeSettings(join(root, ".claude"), {
    apiKeyHelper: directHelperCommand(),
    baseUrl: DIRECT_BASE,
  });
  const res = runCli(["launch", "claude", "--", "--resume", "x y"], {
    env: { ...launchEnv(root, bin), ANTHROPIC_BASE_URL: "http://127.0.0.1:4141" },
  });
  expect(res.stdout).toContain("ARGS=--permission-mode auto --enable-auto-mode --resume x y");
  expect(res.stdout).toContain("ARG4=[--resume]");
  expect(res.stdout).toContain("ARG5=[x y]");
  expect(res.stdout).not.toContain("ARG6=");
  expect(res.stdout).toContain("BASE=unset");
  expect(res.stdout).toContain("FLICKER=1");
  expect(res.stdout).toContain("SANDBOX=unset");
  expect(res.exitCode).toBe(7); // the agent's own exit code passes through
});

skipWin("e2e: %VAR% / $VAR user args arrive literally (no shell between us and the CLI)", () => {
  // The vars are DEFINED so an expansion would be visible: any shell hop between `agent launch`
  // and the CLI would substitute these.
  const root = e2eRoot();
  const bin = fakeCliBin(root, "claude");
  writeClaudeSettings(join(root, ".claude"), {
    apiKeyHelper: directHelperCommand(),
    baseUrl: DIRECT_BASE,
  });
  const res = runCli(["launch", "claude", "--", "%USERPROFILE%", "$HOME", "`whoami`"], {
    env: launchEnv(root, bin),
  });
  expect(res.stdout).toContain("ARG4=[%USERPROFILE%]");
  expect(res.stdout).toContain("ARG5=[$HOME]");
  expect(res.stdout).toContain("ARG6=[`whoami`]");
  expect(res.exitCode).toBe(0);
});

// cmd.exe expands %USERPROFILE% even inside quotes, so the launcher must bypass an npm-style .cmd
// shim for its .ps1 sibling (powershell -File passes argv literally). The .cmd exits 99, so a wrong
// dispatch fails on the exit code too.
test.skipIf(process.platform !== "win32")(
  "e2e (Windows): user args reach the CLI verbatim through the .ps1 shim",
  () => {
    const root = e2eRoot();
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "claude.cmd"), "@echo off\r\nexit 99\r\n");
    writeFileSync(
      join(bin, "claude.ps1"),
      [
        "$i = 0",
        'foreach ($a in $args) { $i++; Write-Output "ARG$i=[$a]" }',
        "exit 0",
        "",
      ].join("\n"),
    );
    writeClaudeSettings(join(root, ".claude"), {
      apiKeyHelper: directHelperCommand(),
      baseUrl: DIRECT_BASE,
    });
    const winEnv = { ...launchEnv(root, bin), PATH: `${bin};${process.env.PATH ?? ""}` };
    const res = runCli(
      ["launch", "claude", "--", "%USERPROFILE%", "x y", "$env:USERPROFILE", "`whoami`", 'a"b'],
      { env: winEnv },
    );
    // USERPROFILE is defined (launchEnv sets it), so an expansion would show a path;
    // the PowerShell-flavored metacharacters must survive -File's literal argv too.
    expect(res.stdout).toContain("ARG4=[%USERPROFILE%]");
    expect(res.stdout).toContain("ARG5=[x y]");
    expect(res.stdout).toContain("ARG6=[$env:USERPROFILE]");
    expect(res.stdout).toContain("ARG7=[`whoami`]");
    expect(res.stdout).toContain('ARG8=[a"b]');
    expect(res.exitCode).toBe(0);

    writeFileSync(join(bin, "claude.ps1"), "exit 41\n");
    expect(runCli(["launch", "claude", "--"], { env: winEnv }).exitCode).toBe(41);
  },
);

skipWin("e2e: --relaxed exports IS_SANDBOX and never scrubs a foreign base URL", () => {
  const root = e2eRoot();
  const bin = fakeCliBin(root, "claude");
  writeClaudeSettings(join(root, ".claude"), {
    apiKeyHelper: directHelperCommand(),
    baseUrl: DIRECT_BASE,
  });
  const res = runCli(["launch", "claude", "--relaxed", "--"], {
    env: { ...launchEnv(root, bin), ANTHROPIC_BASE_URL: "https://my-gateway.example" },
  });
  expect(res.exitCode).toBe(0);
  expect(res.stdout).toContain("SANDBOX=1");
  expect(res.stdout).toContain("--dangerously-skip-permissions");
  expect(res.stdout).toContain("BASE=https://my-gateway.example");
});

skipWin("e2e: a proxy-wired Claude launch aborts (exit 1) when the start offer is declined", () => {
  const root = e2eRoot();
  const bin = fakeCliBin(root, "claude");
  writeClaudeSettings(join(root, ".claude"), {
    apiKeyHelper: proxyHelperCommand(),
    baseUrl: "http://127.0.0.1:4199",
  });
  const res = runCli(["launch", "claude", "--"], {
    env: launchEnv(root, bin),
    input: "n\n",
  });
  expect(res.exitCode).toBe(1);
  expect(res.stderr).toContain("copilot proxy not running. Start it now? [Y/n]");
  expect(res.stderr).toContain("Continuing without the proxy");
  expect(res.stdout).not.toContain("ARGS="); // claude was never launched
  expect(recordedMode(root)).toBeUndefined(); // aborted before the wire: no record
});

skipWin("e2e: with the proxy up, the wire re-syncs Claude and only success records", async () => {
  const root = e2eRoot();
  const bin = fakeCliBin(root, "claude");
  // With no daemon lock (this decoy holds none), proxyStatus falls back to pid classification: the
  // tracked pid must be a deno process running a copilot-api-named entry with the `start`
  // subcommand, and the recorded loopback port must really listen. proxy_token.test.ts stages
  // the same.
  const decoy = join(root, "copilot-api-decoy.mjs");
  writeFileSync(decoy, "setTimeout(() => {}, 30_000);\n");
  const daemon = spawnChild(Deno.execPath(), {
    args: ["run", decoy, "start"],
    stdout: "null",
    stderr: "null",
  });
  const { server, port } = await new Promise<{ server: Server; port: number }>(
    (resolve, reject) => {
      const srv = createServer();
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const address = srv.address();
        if (address === null || typeof address === "string") {
          reject(new Error("expected an AddressInfo"));
          return;
        }
        resolve({ server: srv, port: address.port });
      });
    },
  );
  const previousHome = process.env.COPILOT_API_HOME;
  try {
    process.env.COPILOT_API_HOME = join(root, "api-home"); // writeRunState resolves from env
    writeRunState({ pid: daemon.pid, port });
    // Codex already wired to the live proxy: once the auto-wire re-syncs Claude,
    // the pair agrees, so the launch must record the default mode as proxy.
    writeCodexConfigToml(join(root, ".codex"), {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      envKey: "OPENAI_API_KEY",
    });

    // Success-only: a FAILED wire records nothing. The "direct" sentinel exposes any premature
    // record, since a hook firing anyway would clear or overwrite it.
    //   plain file where the Claude home should be -> reads unwired ("none"): the wire IS attempted
    //   settings write (mkdir over a file)          -> fails for any uid
    new CopilotEnvState().recordDefaultMode("direct");
    writeFileSync(join(root, ".claude"), "");
    const failed = runCli(["launch", "claude", "--"], { env: launchEnv(root, bin) });
    expect(failed.exitCode).not.toBe(0);
    expect(failed.stdout).not.toContain("ARGS="); // claude was never launched
    expect(recordedMode(root)).toBe("direct"); // the sentinel survived: no record

    rmSync(join(root, ".claude"), { force: true });
    writeClaudeSettings(join(root, ".claude"), {
      apiKeyHelper: proxyHelperCommand(),
      baseUrl: "http://127.0.0.1:1", // stale port; the launch must re-sync it
    });
    const res = runCli(["launch", "claude", "--"], { env: launchEnv(root, bin) });
    expect(res.stderr).not.toContain("Start it now?"); // up: nothing to offer
    expect(res.stdout).toContain(`BASE=http://127.0.0.1:${port}`);
    const settings = readFileSync(join(root, ".claude", "settings.json"), "utf8");
    expect(settings).toContain(`http://127.0.0.1:${port}`);
    expect(res.exitCode).toBe(0);
    expect(recordedMode(root)).toBe("proxy");
  } finally {
    process.env.COPILOT_API_HOME = previousHome;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      daemon.kill("SIGKILL");
    } catch {
      // already gone
    }
    await daemon.status;
  }
}, 60_000);

skipWin("e2e: a direct Codex launch passes args through untouched", () => {
  const root = e2eRoot();
  const bin = fakeCliBin(root, "codex", 3);
  writeCodexConfigToml(join(root, ".codex"), { baseUrl: DIRECT_BASE });
  const res = runCli(["launch", "codex", "--", "exec", "--json", "ls"], {
    env: launchEnv(root, bin),
  });
  expect(res.stdout).toContain("ARGS=exec --json ls");
  expect(res.exitCode).toBe(3);
});

skipWin("e2e: copilot gets the managed flag set and no provider wiring", () => {
  const root = e2eRoot();
  const bin = fakeCliBin(root, "copilot");
  const res = runCli(["launch", "copilot", "--relaxed", "--", "hello"], {
    env: launchEnv(root, bin),
  });
  expect(res.stdout).toContain(
    "ARGS=--autopilot --enable-reasoning-summaries --experimental --allow-all hello",
  );
  expect(res.exitCode).toBe(0);
});

test("codex direct default launch refreshes the model catalog BEFORE Codex starts; proxy leaves it to the token step", async () => {
  const codexDefault: LaunchAction = { kind: "codex", profile: null, relaxed: false, args: [] };
  const direct = scriptedDeps({ mode: "direct" });
  expect(await prepareLaunch(codexDefault, direct.deps)).not.toBeNull();
  expect(direct.calls).toEqual(["mode:codex", "catalog:refresh"]);
  const proxy = scriptedDeps({ mode: "proxy" });
  expect(await prepareLaunch(codexDefault, proxy.deps)).not.toBeNull();
  expect(proxy.calls).toEqual(["mode:codex", "ensure:(default)", "wire:codex"]);
  // A named-profile launch is the profile's own wiring; the account-wide catalog
  // belongs to the default selection.
  const named = scriptedDeps({ mode: "direct", slot: completeSlot("direct") });
  const action: LaunchAction = {
    kind: "codex",
    profile: WORK,
    relaxed: false,
    args: [],
  };
  expect(await prepareLaunch(action, named.deps)).not.toBeNull();
  expect(named.calls).not.toContain("catalog:refresh");
});
