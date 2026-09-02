// `agent launch` units: the CLI-boundary parse (profile hoisting, the copilot
// no-profile rule) and the prepareLaunch orchestration/plan composition over
// scripted deps, plus end-to-end launches against fake agent CLIs (a throwaway
// bin dir on PATH) -- direct env composition, the proxy gate, and the proxy path
// against a staged live "daemon" (decoy pid + real listener), all under an
// isolated COPILOT_API_HOME. The parse/plan/picker units run everywhere; most
// e2e spawns are POSIX (sh fakes), and a Windows-only e2e drives the verbatim
// .ps1-shim dispatch (verbatimCliSpawn) with a %VAR% literalness control.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProviderMode } from "../src/agents/provider_mode.ts";
import { directHelperCommand, proxyHelperCommand } from "../src/claude/config.ts";
import {
  type LaunchAction,
  type LaunchDeps,
  parseLaunchAction,
  prepareLaunch,
} from "../src/commands/launch.ts";
import type { ManagedEnvValue } from "../src/commands/env.ts";
import type { ProfileMode } from "../src/copilot_api/env_state.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import { runCli, spawnChild } from "./helpers/run.ts";
import { afterEach, expect, test } from "./helpers/testing.ts";
import { writeClaudeSettings, writeCodexConfigToml, writeRunState } from "./helpers.ts";

const WORK = parseProfileName("work");
const skipWin = test.skipIf(process.platform === "win32");

// Every e2e root is registered here and swept after each test.
let roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});
function e2eRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "copilot-launch-"));
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
  // The rc-launcher contract: `cl --profile work --resume` reaches launch as
  // pass-through args, and the leading pair becomes the profile.
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
  // co never hoisted: the pair passes through to copilot itself.
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

interface DepsScript {
  mode?: AgentProviderMode;
  proxyUp?: boolean;
  slot?: { mode: ProfileMode | null; authProvider: string | null };
  claudeUrl?: ManagedEnvValue;
  codexHome?: ManagedEnvValue;
  syncThrows?: boolean;
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
    profileSlot: (name) => {
      calls.push(`slot:${name}`);
      return script.slot ?? { mode: null, authProvider: null };
    },
    writeClaudeProfileSettings: (name, mode) => {
      calls.push(`settings:${name}:${mode}`);
      return Promise.resolve(`/fake/settings-${name}.json`);
    },
    syncProfileWiring: (name, mode) => {
      calls.push(`sync:${name}:${mode}`);
      return script.syncThrows ? Promise.reject(new Error("boom")) : Promise.resolve();
    },
    managedClaudeBaseUrl: () => script.claudeUrl ?? null,
    managedCodexHome: () => script.codexHome ?? null,
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
  expect(calls).toEqual(["mode:claude"]); // never ensured, never rewired
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
    expect(calls).toEqual(["mode:claude", "ensure:(default)", "wire:claude"]);
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
    "agent launch: Claude has a custom provider config (not managed by copilot-env); " +
    "launching it as-is.",
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
    slot: { mode: "proxy", authProvider: "gh-token" },
    // Even a set-verdict must not leak into a profile launch: the profile's own
    // settings file carries its URL.
    claudeUrl: { value: "http://127.0.0.1:4141" },
  });
  const plan = await prepareLaunch(
    { kind: "claude", profile: WORK, relaxed: false, args: ["--resume"] },
    deps,
  );
  expect(calls).toEqual(["slot:work", "ensure:work", "settings:work:proxy"]);
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
  const direct = scriptedDeps({ slot: { mode: "direct", authProvider: "copilot" } });
  await prepareLaunch({ kind: "claude", profile: WORK, relaxed: false, args: [] }, direct.deps);
  expect(direct.calls).toEqual(["slot:work", "settings:work:direct"]);

  const missing = scriptedDeps({ slot: { mode: null, authProvider: null } });
  await expect(
    prepareLaunch({ kind: "codex", profile: WORK, relaxed: false, args: [] }, missing.deps),
  ).rejects.toThrow(
    "profile 'work' does not exist - create it with `agent profile --add work --direct|--proxy`",
  );

  const credless = scriptedDeps({ slot: { mode: "proxy", authProvider: null } });
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
  const ok = scriptedDeps({ slot: { mode: "proxy", authProvider: "gh-token" } });
  const plan = await prepareLaunch(
    { kind: "codex", profile: WORK, relaxed: false, args: ["--resume"] },
    ok.deps,
  );
  expect(ok.calls).toEqual(["slot:work", "ensure:work", "sync:work:proxy"]);
  expect(plan?.args).toEqual(["--profile", "work", "--resume"]);

  const broken = scriptedDeps({
    slot: { mode: "proxy", authProvider: "gh-token" },
    syncThrows: true,
  });
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
  expect(calls).toEqual([]); // no provider work, no proxy work
});

// --- POSIX end-to-end against fake agent CLIs -------------------------------------

/** A bin dir holding a fake agent CLI that prints its argv and the managed env
 *  vars, then exits with `exitCode` -- what `agent launch` actually spawns when
 *  the dir leads PATH. */
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

/** Isolated homes + a leading fake-CLI bin dir for a spawned `agent launch`. */
function launchEnv(root: string, bin: string): Record<string, string> {
  return {
    ...process.env,
    CONSOLA_LEVEL: "5",
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HOME: root,
    USERPROFILE: root,
    COPILOT_API_HOME: join(root, "api-home"),
    CLAUDE_CONFIG_DIR: join(root, ".claude"),
    CODEX_HOME: join(root, ".codex"),
  };
}

const DIRECT_BASE = "https://api.githubcopilot.com";

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
  // Exact argv boundaries: "x y" must arrive as ONE argument, in position 5.
  expect(res.stdout).toContain("ARG4=[--resume]");
  expect(res.stdout).toContain("ARG5=[x y]");
  expect(res.stdout).not.toContain("ARG6=");
  expect(res.stdout).toContain("BASE=unset"); // OUR stale proxy URL was scrubbed
  expect(res.stdout).toContain("FLICKER=1");
  expect(res.stdout).toContain("SANDBOX=unset");
  expect(res.exitCode).toBe(7); // the agent's own exit code passes through
});

skipWin("e2e: %VAR% / $VAR user args arrive literally (no shell between us and the CLI)", () => {
  // The verbatim contract, with the vars DEFINED so an expansion would be visible:
  // any shell hop between `agent launch` and the CLI would substitute these.
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

// The Windows half of the verbatim contract: an npm-style shim pair on PATH, where
// the .cmd (whose cmd.exe parsing would expand %USERPROFILE% even inside quotes)
// must be bypassed for its .ps1 sibling -- powershell -File passes argv literally.
// The .cmd exits 99, so a wrong dispatch fails loudly on the exit code too.
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

    // Nonzero exit propagation through powershell -File: the shim's own exit code
    // is what `agent launch` passes through.
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
  expect(res.stdout).toContain("BASE=https://my-gateway.example"); // the user's, untouched
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
});

skipWin("e2e: with the proxy up, Claude is re-synced and gets the live proxy URL", async () => {
  const root = e2eRoot();
  const bin = fakeCliBin(root, "claude");
  writeClaudeSettings(join(root, ".claude"), {
    apiKeyHelper: proxyHelperCommand(),
    baseUrl: "http://127.0.0.1:1", // stale port; the launch must re-sync it
  });
  // A live "daemon": since the sweep/status match was narrowed, that means a real
  // deno process running a copilot-api-named entry file with the `start` subcommand
  // (the COPILOT_API_ENTRY shape), plus a real listening loopback port, recorded in
  // run state (what proxyStatus verifies) -- the same staging as proxy_token.test.ts.
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
    const res = runCli(["launch", "claude", "--"], { env: launchEnv(root, bin) });
    expect(res.stderr).not.toContain("Start it now?"); // up: nothing to offer
    expect(res.stdout).toContain(`BASE=http://127.0.0.1:${port}`);
    const settings = readFileSync(join(root, ".claude", "settings.json"), "utf8");
    expect(settings).toContain(`http://127.0.0.1:${port}`); // re-synced off the stale port
    expect(res.exitCode).toBe(0);
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
