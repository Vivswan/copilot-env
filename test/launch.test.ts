import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { directHelperCommand, proxyHelperCommand } from "../src/claude/config.ts";
import { settingsPathFor } from "../src/claude/paths.ts";
import { staleCodexHomeExportLine } from "../src/codex/host.ts";
import { codexConfigPath } from "../src/codex/paths.ts";
import {
  type LaunchAction,
  type LaunchFlags,
  type LaunchPlan,
  parseLaunchAction,
  prepareLaunch,
} from "../src/commands/launch.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { CopilotApiPaths } from "../src/copilot_api/paths.ts";
import {
  resetIntegrationIdentityCache,
  setIntegrationProbeFetch,
} from "../src/copilot_api/integration_identity.ts";
import { renderModelAliases } from "../src/copilot_api/launch.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import type { FileChange } from "../src/utils/dry_run.ts";
import { getSanitizedHostname } from "../src/utils/hostname.ts";
import { captureChannels } from "./helpers/output.ts";
import { runCli, spawnChild } from "./helpers/run.ts";
import { afterEach, expect, tempDir, test } from "./helpers/testing.ts";
import { writeClaudeSettings, writeCodexConfigToml, writeRunState } from "./helpers/fixtures.ts";
import { agentHomeEnv, type AgentHomes, envSnapshot, isolateAgentHomes } from "./helpers/env.ts";
import { dryRunChanges } from "./helpers/dry_run.ts";

const WORK = parseProfileName("work");
const skipWin = test.skipIf(process.platform === "win32");

const restoreEnv = envSnapshot();
let roots: string[] = [];
afterEach(() => {
  setIntegrationProbeFetch(null);
  resetIntegrationIdentityCache();
  restoreEnv();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});
function e2eRoot(): string {
  const root = tempDir("copilot-launch-");
  roots.push(root);
  return root;
}

/** Isolated agent and proxy homes the in-process plans read and (on the overlay) write. */
function scratchState(): AgentHomes {
  const homes = isolateAgentHomes("copilot-launch-state-");
  roots.push(homes.dir);
  return homes;
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

// --- prepareLaunch over a scratch state ------------------------------------------------

const CLAUDE_FLAGS = ["--permission-mode", "auto", "--enable-auto-mode"];

/** A Direct profile whose wiring hook re-renders from a probed pair: the probe it runs for a slot
 *  without a stored pair is stubbed to accept. */
function seedDirectProfile(): void {
  new CopilotEnvState().commitProfile(WORK, {
    credential: { kind: "stored", provider: "gh-token", token: "tok" },
    mode: "direct",
  });
  setIntegrationProbeFetch(() =>
    Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }))
  );
}

// A named profile by slot state: a partial slot hard-fails with the repair line rather than
// falling back to the default credential; a complete Direct slot never touches the proxy, its
// hook re-renders both agents from the slot (the writes are the plan), Claude gets the profile's
// settings file with the shell's base URL scrubbed unconditionally, and Codex is pinned to the
// home the sync resolved.
test("--profile: a partial slot hard-fails naming its gap; a Direct slot syncs both agents and launches without the proxy", async () => {
  const homes = scratchState();
  await expect(prepareLaunch({ kind: "codex", profile: WORK, relaxed: false, args: [] })).rejects
    .toThrow(
      "profile 'work' does not exist - create it with `agent profile work add --direct|--proxy`",
    );
  const state = new CopilotEnvState();
  state.commitProfile(WORK, {
    credential: { kind: "stored", provider: "gh-token", token: "tok" },
    mode: "proxy",
  });
  state.clearCredential(WORK);
  await expect(prepareLaunch({ kind: "claude", profile: WORK, relaxed: false, args: [] })).rejects
    .toThrow(
      "profile 'work' has no credential - repair it with `agent profile work auth` or `agent profile work add`",
    );
  seedDirectProfile();
  const settings = settingsPathFor(homes.claudeHome, WORK);
  const codexConfig = codexConfigPath(homes.codexHome);
  const rows: Array<{ action: LaunchAction; plan: LaunchPlan }> = [
    {
      action: { kind: "claude", profile: WORK, relaxed: false, args: ["--resume"] },
      plan: {
        command: "claude",
        args: ["--settings", settings, ...CLAUDE_FLAGS, "--resume"],
        env: { CLAUDE_CODE_NO_FLICKER: "1" },
        scrub: ["ANTHROPIC_BASE_URL"],
      },
    },
    {
      action: { kind: "codex", profile: WORK, relaxed: false, args: ["--resume"] },
      plan: {
        command: "codex",
        args: ["--profile", "work", "--resume"],
        env: { CODEX_HOME: homes.codexHome },
        scrub: ["CODEX_HOME"],
      },
    },
  ];
  for (const row of rows) {
    // Each launch on its own overlay: its hook alone must re-render BOTH agents from the slot, in
    // the slot's mode (a Direct base URL in each file, never the proxy's).
    const { changes, result } = await dryRunChanges(() => prepareLaunch(row.action));
    expect(result).toEqual(row.plan);
    const baseUrlOf = (path: string, key: string): unknown =>
      changes.find((c) => c.path === path)?.attributes.find((attr) => attr.key === key)?.next;
    expect(baseUrlOf(settings, "env.ANTHROPIC_BASE_URL"), row.action.kind).toBe(DIRECT_BASE);
    expect(baseUrlOf(codexConfig, "model_providers.copilot-env-work.base_url"), row.action.kind)
      .toBe(DIRECT_BASE);
  }
});

// The Codex profile launch is where a stale wiring is felt, so a failed refresh must not block it:
// the failure is said and the existing config is launched.
test("codex --profile: a failed wiring refresh warns and launches with the existing config", async () => {
  const homes = scratchState();
  seedDirectProfile();
  // A plain file where the Claude home should be: the settings write (mkdir over a file) fails for
  // any uid, and the hook's wiring fails with it.
  writeFileSync(homes.claudeHome, "");
  let plan: LaunchPlan | null = null;
  const { stderr } = await captureChannels(async () => {
    ({ result: plan } = await dryRunChanges(() =>
      prepareLaunch({ kind: "codex", profile: WORK, relaxed: false, args: [] })
    ));
  });
  expect(stderr).toContain(
    "agent profile launch: could not refresh the profile wiring; launching with the existing config (",
  );
  expect(plan).toEqual({
    command: "codex",
    args: ["--profile", "work"],
    env: { CODEX_HOME: homes.codexHome },
    scrub: ["CODEX_HOME"],
  });
});

/** The default slot with a credential, its identity probe stubbed to accept. */
function seedDefault(mode: "direct" | "proxy"): void {
  const state = new CopilotEnvState();
  state.setCredential(null, { kind: "stored", provider: "gh-token", token: "tok" });
  state.recordDefaultMode(mode);
  setIntegrationProbeFetch(() =>
    Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }))
  );
}

/** The `next` value of one attribute row of one planned file, or undefined. */
function plannedValue(changes: FileChange[], path: string, key: string): unknown {
  return changes.find((c) => c.path === path)?.attributes.find((row) => row.key === key)?.next;
}

// A cold start may move the port, so the default proxy launch ensures the daemon FIRST and wires
// after it: the config the wire bakes carries the port the start took, never the stale record.
test("codex default proxy: the daemon is ensured before the wiring, which bakes the port the start took", async () => {
  const homes = scratchState();
  seedDefault("proxy");
  new CopilotEnvConfig().set({ "daemon.auto-start": true });
  // A port left by a daemon that is gone: the start does not honor it for the default profile.
  writeRunState({ port: 9999 });
  const { changes, result } = await dryRunChanges(() =>
    prepareLaunch({ kind: "codex", profile: null, relaxed: false, args: [] })
  );
  expect(result).toEqual({
    command: "codex",
    args: [],
    env: { CODEX_HOME: homes.codexHome },
    scrub: ["CODEX_HOME"],
  });
  const started = plannedValue(changes, new CopilotApiPaths().stateFile, "port");
  expect(typeof started).toBe("number");
  expect(started).not.toBe(9999);
  expect(
    plannedValue(changes, codexConfigPath(homes.codexHome), "model_providers.copilot-env.base_url"),
  ).toBe(`http://127.0.0.1:${started}/v1`);
});

// Codex parses `model_catalog_json` at startup, so a direct default launch refreshes the catalog
// while preparing and the plan is returned only once the refresh is through: the attempt is
// recorded as it starts, and the reference sync that follows the generation (here: stripping the
// reference to an unusable file) is in the plan too. The catalog is Codex's, so Claude's launch
// touches neither.
test("codex default direct: the catalog refresh runs to completion inside the preparation; claude's launch never runs it", async () => {
  const homes = scratchState();
  seedDefault("direct");
  new CopilotEnvConfig().set({ "codex.model-catalog": true });
  const paths = new CopilotApiPaths();
  mkdirSync(homes.proxyHome, { recursive: true });
  writeFileSync(paths.codexModelCatalogFile, "not a catalog\n");
  writeCodexConfigToml(homes.codexHome, { baseUrl: DIRECT_BASE });
  const config = codexConfigPath(homes.codexHome);
  // Top level, ahead of the provider table the fixture ends with.
  writeFileSync(
    config,
    `model_catalog_json = ${JSON.stringify(paths.codexModelCatalogFile)}\n${
      readFileSync(config, "utf8")
    }`,
  );
  const rowsOf = async (kind: "codex" | "claude"): Promise<[unknown, unknown]> => {
    const { changes } = await dryRunChanges(() =>
      prepareLaunch({ kind, profile: null, relaxed: false, args: [] })
    );
    return [
      plannedValue(changes, paths.stateStoreFile, "global.codexCatalogLastAttemptMs"),
      changes.find((c) => c.path === config)?.attributes.find((row) =>
        row.key === "model_catalog_json"
      )?.status,
    ];
  };
  const [attempt, reference] = await rowsOf("codex");
  expect(typeof attempt).toBe("number");
  expect(reference).toBe("remove");
  expect(await rowsOf("claude")).toEqual([undefined, undefined]);
});

test("copilot: the managed flag set verbatim, --relaxed adds --allow-all", async () => {
  expect(await prepareLaunch({ kind: "copilot", relaxed: false, args: ["hey"] })).toEqual({
    command: "copilot",
    args: ["--autopilot", "--enable-reasoning-summaries", "--experimental", "hey"],
    env: {},
    scrub: [],
  });
  expect(await prepareLaunch({ kind: "copilot", relaxed: true, args: [] })).toEqual({
    command: "copilot",
    args: ["--autopilot", "--enable-reasoning-summaries", "--experimental", "--allow-all"],
    env: {},
    scrub: [],
  });
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
    ...agentHomeEnv(root, { proxyHome: join(root, "api-home") }),
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
