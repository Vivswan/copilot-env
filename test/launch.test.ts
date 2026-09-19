import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import type { AgentProviderMode } from "../src/agents/provider_mode.ts";
import { directHelperCommand, proxyHelperCommand } from "../src/claude/config.ts";
import { staleCodexHomeExportLine } from "../src/codex/host.ts";
import {
  type LaunchAction,
  type LaunchDeps,
  type LaunchFlags,
  type LaunchPlan,
  parseLaunchAction,
  prepareLaunch,
} from "../src/commands/launch.ts";
import type { ManagedEnvValue } from "../src/utils/shell_quote.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import type { ProfileMode, ProfileSlot, TokenProvider } from "../src/copilot_api/env_state.ts";
import { renderModelAliases } from "../src/copilot_api/launch.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import { getSanitizedHostname } from "../src/utils/hostname.ts";
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

// --- the alias table ------------------------------------------------------------

test("renderModelAliases wraps a long alias list inside its own column at width 80", () => {
  const targets = { sonnet: "claude-sonnet-4.5", gpt: "gpt-5" };
  const mappings: Record<string, string> = {
    "claude-3-5-sonnet-20241022": targets.sonnet,
    "claude-3-7-sonnet-20250219": targets.sonnet,
    "claude-sonnet-4-20250514": targets.sonnet,
    "claude-sonnet-4-5-20250929": targets.sonnet,
    "gpt-4o": targets.gpt,
    "gpt-4.1": targets.gpt,
  };
  const [title, ...rows] = renderModelAliases(mappings, 80, false).split("\n");
  expect(title).toBe("Model aliases (6 -> 2 models):");
  expect(rows.length).toBeGreaterThan(2);
  for (const row of rows) {
    expect(row.length).toBeLessThanOrEqual(80);
    // A continuation line sits under the alias column, never under the target column.
    if (!row.startsWith("   claude-sonnet-4.5  <-") && !row.startsWith("   gpt-5  ")) {
      expect(row).toMatch(/^ {26}\S/);
    }
  }
  // Wrapping drops no alias and moves none to another target's row.
  const text = rows.join(" ").replace(/\s+/g, " ");
  for (const target of Object.values(targets)) {
    const sources = Object.keys(mappings).filter((s) => mappings[s] === target).sort();
    expect(text).toContain(`${target} <- ${sources.join(", ")}`);
  }
  expect(renderModelAliases(mappings, null, false).split("\n")).toHaveLength(3);
});

// --- parseLaunchAction ----------------------------------------------------------

// One flag shape per row. The shell rc launcher (`cl --profile work --resume`) hands the whole tail
// through as args, so a LEADING pair is hoisted; a non-leading pair, or one after an explicit flag,
// is the agent CLI's own business, and copilot never hoists.
test("parseLaunchAction: each flag shape parses to its action or is rejected naming the rule", () => {
  const rows: Array<{ flags: LaunchFlags } & ({ action: LaunchAction } | { throws: string })> = [
    {
      flags: { cli: "cursor", args: [] },
      throws: "unknown agent CLI 'cursor' (expected claude | codex | copilot)",
    },
    {
      flags: { cli: "claude", args: ["--profile", "work", "--resume"] },
      action: { kind: "claude", profile: WORK, relaxed: false, args: ["--resume"] },
    },
    {
      flags: { cli: "codex", args: ["--profile", "work"] },
      action: { kind: "codex", profile: WORK, relaxed: false, args: [] },
    },
    {
      flags: { cli: "claude", args: ["--resume", "--profile", "work"] },
      action: {
        kind: "claude",
        profile: null,
        relaxed: false,
        args: ["--resume", "--profile", "work"],
      },
    },
    {
      flags: { cli: "copilot", args: ["--profile", "work"] },
      action: { kind: "copilot", relaxed: false, args: ["--profile", "work"] },
    },
    // The explicit flag wins; the pair then rides through.
    {
      flags: { cli: "claude", profile: "work", args: ["--profile", "other"] },
      action: { kind: "claude", profile: WORK, relaxed: false, args: ["--profile", "other"] },
    },
    {
      flags: { cli: "copilot", profile: "work", args: [] },
      throws: "copilot takes no profile",
    },
    { flags: { cli: "claude", profile: "", args: [] }, throws: "invalid profile name" },
    // A hoisted name goes through the same smart constructor as the flag.
    { flags: { cli: "codex", args: ["--profile", "NOT VALID"] }, throws: "invalid profile name" },
    // `--profile` with an EMPTY next arg is not a pair (the rc `-n "$2"` guard): both tokens pass.
    {
      flags: { cli: "claude", args: ["--profile", ""] },
      action: { kind: "claude", profile: null, relaxed: false, args: ["--profile", ""] },
    },
  ];
  for (const row of rows) {
    const parsed = (): { action: LaunchAction } | { throws: string } => {
      try {
        return { action: parseLaunchAction(row.flags) };
      } catch (e) {
        return { throws: (e as Error).message };
      }
    };
    const got = parsed();
    if ("throws" in row) {
      const message = "throws" in got ? got.throws : `parsed: ${JSON.stringify(got.action)}`;
      expect({ flags: row.flags, message }).toEqual({
        flags: row.flags,
        message: expect.stringContaining(row.throws),
      });
    } else {
      expect({ flags: row.flags, ...got }).toEqual({ flags: row.flags, action: row.action });
    }
  }
});

// --- prepareLaunch over scripted deps --------------------------------------------

function completeSlot(mode: ProfileMode, provider: TokenProvider = "gh-token"): ProfileSlot {
  return {
    kind: "complete",
    credential: { kind: "stored", provider, token: "tok" },
    mode,
  };
}

function partialSlot(mode: ProfileMode | null = null): ProfileSlot {
  return {
    kind: "partial",
    credential: { kind: "none", provider: null },
    mode,
  };
}

interface DepsScript {
  mode?: AgentProviderMode;
  proxyUp?: boolean;
  slot?: ProfileSlot;
  claudeUrl?: ManagedEnvValue;
  /** The home the child is pinned to (the farm with codex-host on, else the codex-home path or the
   *  unmanaged home). */
  codexHome?: string;
  /** The farm exists only AFTER a wire/sync ran (a pass built and recorded it). */
  codexHomeOnceWired?: boolean;
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
      return Promise.resolve(`/fake/settings-${name}.json`);
    },
    syncProfileWiring: (name, mode) => {
      calls.push(`sync:${name}:${mode}`);
      return script.syncThrows ? Promise.reject(new Error("boom")) : Promise.resolve();
    },
    managedClaudeBaseUrl: () => script.claudeUrl ?? null,
    codexHome: () => {
      const wired = calls.some((c) => c.startsWith("wire:") || c.startsWith("sync:"));
      // Throw, not a fallback: an early read followed by a correct one must fail too.
      if (script.codexHomeOnceWired && !wired) {
        throw new Error("codexHome read before the wiring step");
      }
      return script.codexHome ?? "/fake/.codex";
    },
    notify: (line) => notes.push(line),
  };
  return { deps, calls, notes };
}

/** The plan (null = abort) or the thrown message. */
type Outcome = { plan: LaunchPlan | null } | { throws: string };

interface ScriptedRow {
  name: string;
  script: DepsScript;
  action: LaunchAction;
  outcome: Outcome;
  calls: string[];
  notes?: string[];
}

async function runScripted(rows: ScriptedRow[]): Promise<void> {
  for (const row of rows) {
    const { deps, calls, notes } = scriptedDeps(row.script);
    const outcome: Outcome = await prepareLaunch(row.action, deps).then(
      (plan) => ({ plan }),
      (e: unknown) => ({ throws: (e as Error).message }),
    );
    expect({ name: row.name, outcome, calls, notes }).toEqual({
      name: row.name,
      outcome: row.outcome,
      calls: row.calls,
      notes: row.notes ?? [],
    });
  }
}

const CLAUDE_FLAGS = ["--permission-mode", "auto", "--enable-auto-mode"];

const defaultAction =
  (kind: "claude" | "codex") => (relaxed = false, args: string[] = []): LaunchAction => ({
    kind,
    profile: null,
    relaxed,
    args,
  });
const claudeDefault = defaultAction("claude");
const codexDefault = defaultAction("codex");

// The default Claude launch by configured mode: ensure precedes the re-wire (a cold start may move
// the port the wiring bakes), the base URL is read AFTER the wiring, and "other" is never touched.
test("claude default: each provider mode composes its plan, calls, and note", () =>
  runScripted([
    {
      name: "direct: no proxy work, managed flags + env, stale local URL scrubbed",
      script: { mode: "direct", claudeUrl: { unset: true } },
      action: claudeDefault(false, ["--resume", "x"]),
      outcome: {
        plan: {
          command: "claude",
          args: [...CLAUDE_FLAGS, "--resume", "x"],
          env: { CLAUDE_CODE_NO_FLICKER: "1" },
          scrub: ["ANTHROPIC_BASE_URL"],
        },
      },
      calls: ["mode:claude"],
    },
    ...(["proxy", "none"] as const).map((mode): ScriptedRow => ({
      name: `${mode}: ensure THEN re-wire, fresh proxy URL exported`,
      script: { mode, claudeUrl: { value: "http://127.0.0.1:4242" } },
      action: claudeDefault(),
      outcome: {
        plan: {
          command: "claude",
          args: CLAUDE_FLAGS,
          env: { CLAUDE_CODE_NO_FLICKER: "1", ANTHROPIC_BASE_URL: "http://127.0.0.1:4242" },
          scrub: [],
        },
      },
      calls: ["mode:claude", "ensure:(default)", "wire:claude"],
    })),
    {
      name: "proxy: a failed ensure aborts before any wiring or launch",
      script: { mode: "proxy", proxyUp: false },
      action: claudeDefault(),
      outcome: { plan: null },
      calls: ["mode:claude", "ensure:(default)"],
    },
    {
      name: "other: launched as-is with a note, config never touched",
      script: { mode: "other" },
      action: claudeDefault(),
      outcome: {
        plan: {
          command: "claude",
          args: CLAUDE_FLAGS,
          env: { CLAUDE_CODE_NO_FLICKER: "1" },
          scrub: [],
        },
      },
      calls: ["mode:claude"],
      notes: [
        "agent profile launch: Claude has a custom or unrecognized provider config " +
        "(not managed by copilot-env); launching it as-is.",
      ],
    },
    {
      name: "--relaxed: IS_SANDBOX=1 and the skip flag behind the managed set",
      script: { mode: "direct" },
      action: claudeDefault(true, ["hi"]),
      outcome: {
        plan: {
          command: "claude",
          args: [...CLAUDE_FLAGS, "--dangerously-skip-permissions", "hi"],
          env: { CLAUDE_CODE_NO_FLICKER: "1", IS_SANDBOX: "1" },
          scrub: [],
        },
      },
      calls: ["mode:claude"],
    },
  ]));

// A named profile by slot state: a proxy slot ensures its daemon FIRST (then syncs), a direct slot
// never touches the proxy, and a partial slot hard-fails with the repair line rather than falling
// back to the default credential. Claude's base URL is scrubbed unconditionally (the profile's own
// settings file carries its URL); CODEX_HOME is read only AFTER the sync.
test("--profile: each slot state syncs, launches, or hard-fails, for claude and codex", () =>
  runScripted([
    {
      name: "claude proxy: settings synced, base URL scrubbed unconditionally",
      script: { slot: completeSlot("proxy"), claudeUrl: { value: "http://127.0.0.1:4141" } },
      action: { kind: "claude", profile: WORK, relaxed: false, args: ["--resume"] },
      outcome: {
        plan: {
          command: "claude",
          args: ["--settings", "/fake/settings-work.json", ...CLAUDE_FLAGS, "--resume"],
          env: { CLAUDE_CODE_NO_FLICKER: "1" },
          scrub: ["ANTHROPIC_BASE_URL"],
        },
      },
      calls: ["slot:work", "ensure:work", "settings:work:proxy"],
    },
    {
      name: "claude direct: never touches the proxy",
      script: { slot: completeSlot("direct", "copilot") },
      action: { kind: "claude", profile: WORK, relaxed: false, args: [] },
      outcome: {
        plan: {
          command: "claude",
          args: ["--settings", "/fake/settings-work.json", ...CLAUDE_FLAGS],
          env: { CLAUDE_CODE_NO_FLICKER: "1" },
          scrub: ["ANTHROPIC_BASE_URL"],
        },
      },
      calls: ["slot:work", "settings:work:direct"],
    },
    {
      name: "codex, missing profile: hard-fails",
      script: { slot: partialSlot() },
      action: { kind: "codex", profile: WORK, relaxed: false, args: [] },
      outcome: {
        throws:
          "profile 'work' does not exist - create it with `agent profile work add --direct|--proxy`",
      },
      calls: ["slot:work"],
    },
    {
      name: "claude, credential-less profile: hard-fails",
      script: { slot: partialSlot("proxy") },
      action: { kind: "claude", profile: WORK, relaxed: false, args: [] },
      outcome: {
        throws: "profile 'work' has no credential - repair it with `agent profile work auth` " +
          "or `agent profile work add`",
      },
      calls: ["slot:work"],
    },
    {
      name:
        "codex proxy: ensure daemon FIRST, then sync; the farm the sync built reaches the child",
      script: {
        slot: completeSlot("proxy"),
        codexHome: "/fake/codex-farm",
        codexHomeOnceWired: true,
      },
      action: { kind: "codex", profile: WORK, relaxed: false, args: ["--resume"] },
      outcome: {
        plan: {
          command: "codex",
          args: ["--profile", "work", "--resume"],
          env: { CODEX_HOME: "/fake/codex-farm" },
          scrub: ["CODEX_HOME"],
        },
      },
      calls: ["slot:work", "ensure:work", "sync:work:proxy"],
    },
    {
      name: "codex proxy: a failed sync warns and launches with the existing config",
      script: { slot: completeSlot("proxy"), syncThrows: true },
      action: { kind: "codex", profile: WORK, relaxed: false, args: [] },
      outcome: {
        plan: {
          command: "codex",
          args: ["--profile", "work"],
          env: { CODEX_HOME: "/fake/.codex" },
          scrub: ["CODEX_HOME"],
        },
      },
      calls: ["slot:work", "ensure:work", "sync:work:proxy"],
      notes: [
        "agent profile launch: could not refresh the profile wiring; launching with the " +
        "existing config (boom).",
      ],
    },
    // The account-wide catalog belongs to the default selection: a profile's launch is the
    // profile's own wiring, so no catalog refresh appears among its calls.
    {
      name: "codex direct: synced without the proxy or the catalog",
      script: { slot: completeSlot("direct") },
      action: { kind: "codex", profile: WORK, relaxed: false, args: [] },
      outcome: {
        plan: {
          command: "codex",
          args: ["--profile", "work"],
          env: { CODEX_HOME: "/fake/.codex" },
          scrub: ["CODEX_HOME"],
        },
      },
      calls: ["slot:work", "sync:work:direct"],
    },
  ]));

// The default Codex launch by mode: proxy ensures then re-wires (the farm the re-wire just built
// must reach the child env) and leaves the catalog to the token step; direct refreshes the model
// catalog BEFORE Codex starts, since Codex parses it at startup. Every inherited CODEX_HOME casing
// is scrubbed before the pin lands.
test("codex default: proxy ensures then re-wires; direct refreshes the catalog first", () =>
  runScripted([
    {
      name: "proxy --relaxed: managed CODEX_HOME applied after the re-wire",
      script: { mode: "proxy", codexHome: "/fake/codex-farm", codexHomeOnceWired: true },
      action: codexDefault(true, ["exec", "ls"]),
      outcome: {
        plan: {
          command: "codex",
          args: ["--sandbox", "danger-full-access", "exec", "ls"],
          env: { CODEX_HOME: "/fake/codex-farm" },
          scrub: ["CODEX_HOME"],
        },
      },
      calls: ["mode:codex", "ensure:(default)", "wire:codex"],
    },
    {
      name: "proxy: a plain launch leaves the catalog to the token step",
      script: { mode: "proxy", codexHome: "/fake/codex-farm", codexHomeOnceWired: true },
      action: codexDefault(),
      outcome: {
        plan: {
          command: "codex",
          args: [],
          env: { CODEX_HOME: "/fake/codex-farm" },
          scrub: ["CODEX_HOME"],
        },
      },
      calls: ["mode:codex", "ensure:(default)", "wire:codex"],
    },
    {
      name: "direct: the catalog refresh precedes the launch",
      script: { mode: "direct" },
      action: codexDefault(),
      outcome: {
        plan: {
          command: "codex",
          args: [],
          env: { CODEX_HOME: "/fake/.codex" },
          scrub: ["CODEX_HOME"],
        },
      },
      calls: ["mode:codex", "catalog:refresh"],
    },
  ]));

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
    'echo "CODEX_HOME=${CODEX_HOME-unset}"',
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

const DIRECT_BASE = "https://api.githubcopilot.com";

function recordedMode(root: string): string | undefined {
  const statePath = join(root, "api-home", "state.json");
  if (!existsSync(statePath)) return undefined;
  const state = JSON.parse(readFileSync(statePath, "utf8")) as {
    profiles?: { default?: { mode?: string } };
  };
  return state.profiles?.default?.mode;
}

/** What the wiring command records: the launcher reads the default slot's mode, never settings.json. */
function recordDefault(root: string, mode: "direct" | "proxy"): void {
  mkdirSync(join(root, "api-home"), { recursive: true });
  writeFileSync(
    join(root, "api-home", "state.json"),
    `${JSON.stringify({ profiles: { default: { mode } } })}\n`,
  );
}

skipWin("e2e: a direct Claude launch composes flags and scrubs a stale local URL", () => {
  const root = e2eRoot();
  const bin = fakeCliBin(root, "claude", 7);
  recordDefault(root, "direct");
  writeClaudeSettings(join(root, ".claude"), {
    apiKeyHelper: directHelperCommand(),
    baseUrl: DIRECT_BASE,
  });
  const res = runCli(["profile", "launch", "claude", "--", "--resume", "x y"], {
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
  // The vars are DEFINED so an expansion would be visible: any shell hop between `agent profile launch`
  // and the CLI would substitute these.
  const root = e2eRoot();
  const bin = fakeCliBin(root, "claude");
  recordDefault(root, "direct");
  writeClaudeSettings(join(root, ".claude"), {
    apiKeyHelper: directHelperCommand(),
    baseUrl: DIRECT_BASE,
  });
  const res = runCli(["profile", "launch", "claude", "--", "%USERPROFILE%", "$HOME", "`whoami`"], {
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
    recordDefault(root, "direct");
    writeClaudeSettings(join(root, ".claude"), {
      apiKeyHelper: directHelperCommand(),
      baseUrl: DIRECT_BASE,
    });
    const winEnv = { ...launchEnv(root, bin), PATH: `${bin};${process.env.PATH ?? ""}` };
    const res = runCli(
      [
        "profile",
        "launch",
        "claude",
        "--",
        "%USERPROFILE%",
        "x y",
        "$env:USERPROFILE",
        "`whoami`",
        'a"b',
      ],
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
    expect(runCli(["profile", "launch", "claude", "--"], { env: winEnv }).exitCode).toBe(41);
  },
);

skipWin("e2e: --relaxed exports IS_SANDBOX and never scrubs a foreign base URL", () => {
  const root = e2eRoot();
  const bin = fakeCliBin(root, "claude");
  recordDefault(root, "direct");
  writeClaudeSettings(join(root, ".claude"), {
    apiKeyHelper: directHelperCommand(),
    baseUrl: DIRECT_BASE,
  });
  const res = runCli(["profile", "launch", "claude", "--relaxed", "--"], {
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
  recordDefault(root, "proxy");
  writeClaudeSettings(join(root, ".claude"), {
    apiKeyHelper: proxyHelperCommand(),
    baseUrl: "http://127.0.0.1:4199",
  });
  const res = runCli(["profile", "launch", "claude", "--"], {
    env: launchEnv(root, bin),
    input: "n\n",
  });
  expect(res.exitCode).toBe(1);
  expect(res.stderr).toContain("copilot proxy not running. Start it now? [Y/n]");
  expect(res.stderr).toContain("Continuing without the proxy");
  expect(res.stdout).not.toContain("ARGS="); // claude was never launched
  expect(recordedMode(root)).toBe("proxy"); // aborted before the wire: only the fixture's record
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

    // Success-only: a FAILED wire records nothing. The launcher reads the default slot's recorded
    // mode (none yet: the wire IS attempted), never settings.json.
    //   plain file where the Claude home should be -> the settings write (mkdir over a file) fails
    //                                                  for any uid
    writeFileSync(join(root, ".claude"), "");
    const failed = runCli(["profile", "launch", "claude", "--"], { env: launchEnv(root, bin) });
    expect(failed.exitCode).not.toBe(0);
    expect(failed.stdout).not.toContain("ARGS="); // claude was never launched
    expect(recordedMode(root)).toBeUndefined(); // nothing landed: no record

    rmSync(join(root, ".claude"), { force: true });
    writeClaudeSettings(join(root, ".claude"), {
      apiKeyHelper: proxyHelperCommand(),
      baseUrl: "http://127.0.0.1:1", // stale port; the launch must re-sync it
    });
    const res = runCli(["profile", "launch", "claude", "--"], { env: launchEnv(root, bin) });
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

/** codex-host on with the farm's config in place (a direct one, so the launch probes no proxy);
 *  the preference store lives under root/api-home, where the launched CLI reads. */
function stageFarm(root: string): string {
  const farm = join(root, ".codex", "hosts", getSanitizedHostname());
  writeCodexConfigToml(farm, { baseUrl: DIRECT_BASE });
  const previousHome = process.env.COPILOT_API_HOME;
  process.env.COPILOT_API_HOME = join(root, "api-home"); // the store resolves from env
  try {
    new CopilotEnvConfig().set({ "codex.host": true });
  } finally {
    process.env.COPILOT_API_HOME = previousHome;
  }
  return farm;
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

skipWin(
  "e2e: codex-host off, a direct Codex launch passes args through untouched and pins CODEX_HOME to the shell's export, which is the home",
  () => {
    const root = e2eRoot();
    recordDefault(root, "direct");
    const bin = fakeCliBin(root, "codex", 3);
    // Codex's own convention: the export is where the config lives, so it is what the child gets.
    const exported = join(root, "my-own-codex");
    writeCodexConfigToml(exported, { baseUrl: DIRECT_BASE });
    const res = runCli(["profile", "launch", "codex", "--", "exec", "--json", "ls"], {
      env: { ...launchEnv(root, bin), CODEX_HOME: exported },
    });
    expect(res.stdout).toContain("ARGS=exec --json ls");
    expect(res.stdout).toContain(`CODEX_HOME=${exported}`);
    expect(res.stderr).not.toContain("Ignoring the shell's CODEX_HOME");
    expect(res.exitCode).toBe(3);
  },
);

skipWin(
  "e2e: codex-host on, the child is pinned to the farm and a differing shell export is named exactly once",
  () => {
    const root = e2eRoot();
    recordDefault(root, "direct");
    const bin = fakeCliBin(root, "codex", 3);
    const farm = stageFarm(root);
    const staleExport = join(root, "old-farm");
    const line = staleCodexHomeExportLine({ home: farm, by: "farm", staleExport });
    if (line === null) throw new Error("a differing export must produce the note");
    const stale = runCli(["profile", "launch", "codex", "--", "exec", "ls"], {
      env: { ...launchEnv(root, bin), CODEX_HOME: staleExport },
    });
    expect(stale.stdout).toContain(`CODEX_HOME=${farm}`);
    expect(occurrences(stale.stderr, line)).toBe(1);
    expect(stale.exitCode).toBe(3);
    // The shell agreeing (what the wrapper's `agent profile env` refresh leaves behind): nothing to say.
    const agreed = runCli(["profile", "launch", "codex", "--", "exec", "ls"], {
      env: { ...launchEnv(root, bin), CODEX_HOME: farm },
    });
    expect(agreed.stdout).toContain(`CODEX_HOME=${farm}`);
    expect(agreed.stderr).not.toContain("Ignoring the shell's CODEX_HOME");
  },
);

skipWin("e2e: copilot gets the managed flag set and no provider wiring", () => {
  const root = e2eRoot();
  const bin = fakeCliBin(root, "copilot");
  const res = runCli(["profile", "launch", "copilot", "--relaxed", "--", "hello"], {
    env: launchEnv(root, bin),
  });
  expect(res.stdout).toContain(
    "ARGS=--autopilot --enable-reasoning-summaries --experimental --allow-all hello",
  );
  expect(res.exitCode).toBe(0);
});
