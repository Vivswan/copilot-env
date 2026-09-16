import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import type { AgentProviderMode } from "../src/agents/provider_mode.ts";
import { directHelperCommand, proxyHelperCommand } from "../src/claude/config.ts";
import {
  type CatalogFetch,
  type CatalogTarget,
  fetchLaunchCatalog,
} from "../src/claude/launch_catalog.ts";
import {
  claudeModelChoice,
  claudeSettingsLayers,
  sessionCredential,
  sessionEnv,
} from "../src/claude/model_check.ts";
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
  /** Where the REAL layer builder reads; absent = no settings file anywhere. */
  layers?: { claudeHome: string; projectDir: string; managedPath: string };
  /** Absent = the fetch failed. */
  catalog?: CatalogModel[];
}

function scriptedDeps(script: DepsScript = {}): {
  deps: LaunchDeps;
  calls: string[];
  notes: string[];
  targets: CatalogTarget[];
} {
  const calls: string[] = [];
  const notes: string[] = [];
  const targets: CatalogTarget[] = [];
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
    claudeSettingsLayers: (args) =>
      script.layers === undefined ? [] : claudeSettingsLayers(args, script.layers),
    claudeCatalog: (target) => {
      const who = target.credential.kind === "token"
        ? "token"
        : target.credential.profile ?? "(default)";
      calls.push(`catalog:${target.mode}:${who}`);
      targets.push(target);
      return Promise.resolve(script.catalog ?? null);
    },
    notify: (line) => notes.push(line),
  };
  return { deps, calls, notes, targets };
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
  expect(calls).toEqual(["mode:claude"]);
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
  const direct = scriptedDeps({ slot: completeSlot("direct", "copilot") });
  await prepareLaunch({ kind: "claude", profile: WORK, relaxed: false, args: [] }, direct.deps);
  expect(direct.calls).toEqual(["slot:work", "settings:work:direct"]);

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

/** The warning shows a home-relative path, and a temp root may sit under the home (Windows). */
function shown(path: string): string {
  const home = homedir();
  return path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

/** A settings document as the wiring writes it: `env` carries the base URL, the baked headers, and
 *  an ANTHROPIC_MODEL entry when given, a blank one included (a blank in a winning layer masks the
 *  value below it). */
function settingsDoc(
  model: string | null,
  env: Record<string, string> = {},
  baseUrl: string = DIRECT_BASE,
): string {
  return JSON.stringify({
    ...(model === null ? {} : { model }),
    apiKeyHelper: "agent auth --get",
    env: {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_CUSTOM_HEADERS:
        "User-Agent: codex_cli_rs/0.1\nCopilot-Integration-Id: copilot-developer-cli",
      ...env,
    },
  });
}

/** A staged Claude home, project dir, and managed path, all empty; the caller writes the files. */
function stagedLayers(root: string) {
  const claudeHome = join(root, ".claude");
  const projectDir = join(root, "project");
  mkdirSync(join(projectDir, ".claude"), { recursive: true });
  mkdirSync(claudeHome);
  return { claudeHome, projectDir, managedPath: join(root, "managed-settings.json") };
}

test("the model resolver follows Claude Code's layer and env precedence (verified against 2.1.258)", () => {
  const root = e2eRoot();
  const layers = stagedLayers(root);
  const flagFile = join(root, "flag.json");
  const write = (path: string, doc: Record<string, unknown>) =>
    writeFileSync(path, JSON.stringify(doc));
  write(join(layers.claudeHome, "settings.json"), { model: "user" });
  write(join(layers.projectDir, ".claude", "settings.json"), { model: "project" });
  write(join(layers.projectDir, ".claude", "settings.local.json"), { model: "local" });
  write(flagFile, { model: "flag" });
  write(layers.managedPath, { model: "managed" });
  const choice = (args: string[], processEnv: Record<string, string> = {}) => {
    const built = claudeSettingsLayers(args, layers);
    return claudeModelChoice(args, built, sessionEnv(built, processEnv));
  };
  const known = (model: string, source: string) => ({ kind: "known", model, source });

  // user < project < local < --settings (file or inline, LAST flag wins) < managed
  expect(claudeSettingsLayers(["--settings", flagFile], layers).map((l) => l.label)).toEqual([
    shown(join(layers.claudeHome, "settings.json")),
    shown(join(layers.projectDir, ".claude", "settings.json")),
    shown(join(layers.projectDir, ".claude", "settings.local.json")),
    shown(flagFile),
    shown(layers.managedPath),
  ]);
  expect(choice(["--settings", flagFile])).toEqual(known("managed", shown(layers.managedPath)));
  rmSync(layers.managedPath);
  expect(choice(["--settings", flagFile])).toEqual(known("flag", shown(flagFile)));
  expect(choice(["--settings", flagFile, '--settings={"model":"inline"}'])).toEqual(
    known("inline", "--settings"),
  );
  // An inline `--settings` without a model overrides nothing: the layers below still apply.
  expect(choice(["--settings", "{}"])).toEqual(
    known("local", shown(join(layers.projectDir, ".claude", "settings.local.json"))),
  );
  expect(choice([])).toEqual(
    known("local", shown(join(layers.projectDir, ".claude", "settings.local.json"))),
  );
  // ANTHROPIC_MODEL beats every `model` key; a settings env block beats the process env; a blank
  // entry in a higher layer masks the lower one and reads as unset.
  expect(choice([], { ANTHROPIC_MODEL: "proc" })).toEqual(known("proc", "$ANTHROPIC_MODEL"));
  write(join(layers.claudeHome, "settings.json"), {
    model: "user",
    env: { ANTHROPIC_MODEL: "user-env" },
  });
  expect(choice([], { ANTHROPIC_MODEL: "proc" })).toEqual(
    known("user-env", `env.ANTHROPIC_MODEL in ${shown(join(layers.claudeHome, "settings.json"))}`),
  );
  expect(choice(['--settings={"env":{"ANTHROPIC_MODEL":""}}'], { ANTHROPIC_MODEL: "proc" }))
    .toEqual(
      known("local", shown(join(layers.projectDir, ".claude", "settings.local.json"))),
    );
  // --setting-sources keeps only the named file layers; the flag and policy layers always apply.
  expect(choice(["--setting-sources", "user"])).toEqual(
    known("user-env", `env.ANTHROPIC_MODEL in ${shown(join(layers.claudeHome, "settings.json"))}`),
  );
  expect(choice(["--setting-sources", "project", "--settings", flagFile])).toEqual(
    known("flag", shown(flagFile)),
  );
  // --model is the user's call, whatever else is set.
  expect(choice(["--model", "x"], { ANTHROPIC_MODEL: "proc" })).toEqual({ kind: "user-supplied" });
  // Like Claude Code's parser, nothing after `--` is a flag; the control shows the same token
  // honored when it stands alone. (A flag-shaped VALUE of an unrelated option is the accepted
  // limitation: telling it apart needs Claude's option table.)
  write(join(layers.claudeHome, "settings.json"), { apiKeyHelper: "agent auth --get" });
  const local = known("local", shown(join(layers.projectDir, ".claude", "settings.local.json")));
  expect(choice(["--", '--settings={"model":"prompt-text"}', "--model", "y"])).toEqual(local);
  expect(choice(['--settings={"model":"prompt-text"}'])).toEqual(
    known("prompt-text", "--settings"),
  );
  // The session's credential: an env token as-is (it beats the helper); otherwise the helper must
  // come from the launch's own file, whose credential is the store's; an x-api-key is not ours.
  const own = join(layers.claudeHome, "settings.json");
  const credential = (args: string[], processEnv: Record<string, string> = {}) => {
    const built = claudeSettingsLayers(args, layers);
    return sessionCredential(built, sessionEnv(built, processEnv), own, null);
  };
  expect(credential([])).toEqual({ kind: "store", profile: null });
  expect(credential(['--settings={"apiKeyHelper":"other"}'])).toBeNull();
  expect(credential([], { ANTHROPIC_AUTH_TOKEN: "baked" })).toEqual({
    kind: "token",
    token: "baked",
  });
  expect(credential(['--settings={"env":{"ANTHROPIC_API_KEY":"k"}}'])).toBeNull();
  // Nothing sets a model: the built-in default, unknown to us.
  for (
    const path of [
      flagFile,
      join(layers.projectDir, ".claude", "settings.json"),
      join(layers.projectDir, ".claude", "settings.local.json"),
    ]
  ) rmSync(path);
  write(join(layers.claudeHome, "settings.json"), {});
  expect(choice([])).toEqual({ kind: "builtin" });
});

test("claude launch warns once when the session's model is outside the Copilot catalog, and only then", async () => {
  const root = e2eRoot();
  const layers = stagedLayers(root);
  const settingsPath = join(layers.claudeHome, "settings-work.json");
  const userSettingsPath = join(layers.claudeHome, "settings.json");
  const previous = {
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
  };
  const setProcessEnv = (env: Record<string, string>) => {
    for (const key of Object.keys(previous)) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
  };
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
    /** The profile file's `model` (the `--settings` layer) and its own env block entry. */
    saved: string | null;
    savedEnv?: string;
    /** The user settings.json the profile file merges over. */
    user?: string;
    userEnv?: string;
    processEnv?: Record<string, string>;
    mode?: ProfileMode;
    catalog?: CatalogModel[];
    notes: string[];
  }[] = [
    { saved: "claude-sonnet-4.5", notes: [] },
    // Claude Code strips `[1m]` before the request.
    { saved: "claude-opus-4.1[1m]", notes: [] },
    // A fresh install's built-in default, which this catalog does not serve.
    { saved: "claude-opus-5[1m]", notes: [notInCatalog("claude-opus-5[1m]")] },
    // The proxy's alias map resolves the dash form; Direct sends it as-is.
    { saved: "claude-opus-4-1", mode: "proxy", notes: [] },
    { saved: "claude-opus-4-1", notes: [notInCatalog("claude-opus-4-1")] },
    // Aliases are trimmed and lowercased; opusplan runs as Sonnet; ANTHROPIC_DEFAULT_<FAMILY>_MODEL
    // repoints an alias at an exact id.
    { saved: " Opusplan ", notes: [] },
    {
      saved: "opusplan",
      catalog: [{ id: "claude-opus-4.1", is1m: false }],
      notes: [
        "WARN Claude model 'opusplan' (from " + shown(settingsPath) +
        ") is not in the Copilot catalog; try /model claude-opus-4.1",
      ],
    },
    {
      saved: "sonnet",
      processEnv: { ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5" },
      notes: [notInCatalog("sonnet")],
    },
    // The layers below the profile file still apply, and the env chain beats every `model` key.
    {
      saved: null,
      user: "claude-opus-5[1m]",
      notes: [notInCatalog("claude-opus-5[1m]", shown(userSettingsPath))],
    },
    { saved: "claude-sonnet-4.5", user: "claude-opus-5[1m]", notes: [] },
    {
      saved: "claude-sonnet-4.5",
      processEnv: { ANTHROPIC_MODEL: "claude-opus-5[1m]" },
      notes: [notInCatalog("claude-opus-5[1m]", "$ANTHROPIC_MODEL")],
    },
    {
      saved: "claude-sonnet-4.5",
      userEnv: "claude-opus-5[1m]",
      notes: [
        notInCatalog("claude-opus-5[1m]", `env.ANTHROPIC_MODEL in ${shown(userSettingsPath)}`),
      ],
    },
    { saved: "claude-sonnet-4.5", savedEnv: "", userEnv: "claude-opus-5[1m]", notes: [] },
    // One ASCII line whatever the file held.
    { saved: "claude-é\nx", notes: [notInCatalog("claude-? x")] },
    // No model anywhere: the built-in default is unknown to us, so only an empty Claude catalog warns.
    { saved: null, notes: [] },
    {
      saved: null,
      catalog: [{ id: "gpt-5", is1m: false }],
      notes: [
        "WARN the Copilot catalog lists no Claude model, so Claude Code's built-in default model cannot be served",
      ],
    },
  ];
  try {
    for (const c of cases) {
      const mode = c.mode ?? "direct";
      const baseUrl = mode === "proxy" ? "http://127.0.0.1:4141" : DIRECT_BASE;
      writeFileSync(
        settingsPath,
        settingsDoc(
          c.saved,
          c.savedEnv === undefined ? {} : { ANTHROPIC_MODEL: c.savedEnv },
          baseUrl,
        ),
      );
      writeFileSync(
        userSettingsPath,
        settingsDoc(c.user ?? null, c.userEnv === undefined ? {} : { ANTHROPIC_MODEL: c.userEnv }),
      );
      setProcessEnv(c.processEnv ?? {});
      const { deps, notes, targets } = scriptedDeps({
        slot: completeSlot(mode),
        settingsPath,
        layers,
        catalog: c.catalog ?? CATALOG,
      });
      const plan = await prepareLaunch(
        { kind: "claude", profile: WORK, relaxed: false, args: [] },
        deps,
      );
      expect(plan?.args).toEqual(argvFor([]));
      expect(notes).toEqual(c.notes);
      // The session's own baked headers ride on the Direct fetch: no identity probe at launch. The
      // proxy port is the one the session's base URL names; the credential is the profile's store.
      const credential = { kind: "store", profile: WORK };
      expect(targets).toEqual([
        mode === "proxy" ? { mode, credential, port: "4141" } : {
          mode,
          credential,
          headers: {
            "User-Agent": "codex_cli_rs/0.1",
            "Copilot-Integration-Id": "copilot-developer-cli",
          },
        },
      ]);
    }
    setProcessEnv({});

    // A baked token (static-key) is the session's credential even when the store moved on, so
    // the fetch carries it; an x-api-key is not one copilot-env can fetch with.
    writeFileSync(userSettingsPath, settingsDoc(null));
    for (
      const [env, expected] of [
        [{ ANTHROPIC_AUTH_TOKEN: "baked" }, [{ kind: "token", token: "baked" }]],
        [{ ANTHROPIC_API_KEY: "k" }, []],
      ] as const
    ) {
      writeFileSync(settingsPath, settingsDoc("claude-sonnet-4.5", env));
      const baked = scriptedDeps({
        slot: completeSlot("direct"),
        settingsPath,
        layers,
        catalog: CATALOG,
      });
      await prepareLaunch({ kind: "claude", profile: WORK, relaxed: false, args: [] }, baked.deps);
      expect(baked.targets.map((t) => t.credential)).toEqual(expected);
      expect(baked.notes).toEqual([]);
    }

    // An explicit --model is the user's choice: no fetch, no warning. A user `--settings` on a
    // profile launch is the LAST flag, so Claude Code drops the profile file and its credential:
    // the profile's catalog would judge a session running under another credential, so no fetch.
    writeFileSync(settingsPath, settingsDoc("claude-opus-5[1m]"));
    writeFileSync(userSettingsPath, settingsDoc("claude-opus-5[1m]"));
    for (
      const args of [
        ["--model", "claude-opus-5"],
        ["--model=opus", "--resume"],
        ["--settings", '{"model":"claude-sonnet-4.5"}'],
        ["--settings", "{}"],
      ]
    ) {
      const flagged = scriptedDeps({
        slot: completeSlot("direct"),
        settingsPath,
        layers,
        catalog: CATALOG,
      });
      const plan = await prepareLaunch(
        { kind: "claude", profile: WORK, relaxed: false, args },
        flagged.deps,
      );
      expect(plan?.args).toEqual(argvFor(args));
      expect(flagged.calls).not.toContain("catalog:direct:work");
      expect(flagged.notes).toEqual([]);
    }
    // On a DEFAULT launch a user `--settings` layers over settings.json, whose credential stays
    // the session's: its model, or the layers below, are judged; one naming a credential is not.
    // The default launch's own file is the one under CLAUDE_CONFIG_DIR.
    const previousHome = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = layers.claudeHome;
    try {
      for (
        const [args, fetched, notes] of [
          [["--settings", '{"model":"claude-sonnet-4.5"}'], true, []],
          [["--settings", "{}"], true, [
            notInCatalog("claude-opus-5[1m]", shown(userSettingsPath)),
          ]],
          [["--settings", '{"apiKeyHelper":"my-helper"}'], false, []],
        ] as const
      ) {
        const own = scriptedDeps({ mode: "direct", layers, catalog: CATALOG });
        const plan = await prepareLaunch(claudeDefault(false, [...args]), own.deps);
        expect(plan?.args).toEqual(["--permission-mode", "auto", "--enable-auto-mode", ...args]);
        expect(own.calls.includes("catalog:direct:(default)")).toBe(fetched);
        expect(own.notes).toEqual(notes);
      }
    } finally {
      process.env.CLAUDE_CONFIG_DIR = previousHome;
    }

    // A failed, rejecting, or hanging look is silent and the launch proceeds within the budget:
    // the check is best effort.
    const looks: [string, LaunchDeps["claudeCatalog"] | undefined][] = [
      ["null", undefined],
      ["rejects", () => Promise.reject(new Error("EACCES"))],
      ["hangs", () => new Promise(() => {})],
    ];
    for (const [name, look] of looks) {
      const failing = scriptedDeps({ slot: completeSlot("direct"), settingsPath, layers });
      if (look !== undefined) failing.deps.claudeCatalog = look;
      const start = Date.now();
      const plan = await prepareLaunch(
        { kind: "claude", profile: WORK, relaxed: false, args: [] },
        failing.deps,
      );
      expect([name, plan?.args]).toEqual([name, argvFor([])]);
      expect([name, failing.notes]).toEqual([name, []]);
      expect(Date.now() - start).toBeLessThan(2000);
    }
  } finally {
    setProcessEnv(Object.fromEntries(
      Object.entries(previous).filter((e): e is [string, string] => e[1] !== undefined),
    ));
  }
});

test("the session's effective ANTHROPIC_BASE_URL decides whether the Copilot catalog is consulted", async () => {
  // Settings env blocks override the process env inside Claude Code, so a foreign URL in the shell
  // still sends a Direct-wired session to Copilot, while a foreign URL in a settings file sends it
  // to that gateway, which the Copilot catalog says nothing about.
  const root = e2eRoot();
  const layers = stagedLayers(root);
  const settingsPath = join(layers.claudeHome, "settings-work.json");
  const previous = process.env.ANTHROPIC_BASE_URL;
  try {
    for (
      const [fileUrl, shellUrl, fetched] of [
        [DIRECT_BASE, "https://my-gateway.example", true],
        ["https://my-gateway.example", DIRECT_BASE, false],
        ["http://127.0.0.1:4141", DIRECT_BASE, false],
      ] as const
    ) {
      writeFileSync(settingsPath, settingsDoc("claude-opus-5[1m]", {}, fileUrl));
      process.env.ANTHROPIC_BASE_URL = shellUrl;
      const { deps, calls } = scriptedDeps({
        slot: completeSlot("direct"),
        settingsPath,
        layers,
        catalog: CATALOG,
      });
      await prepareLaunch({ kind: "claude", profile: WORK, relaxed: false, args: [] }, deps);
      expect(calls.includes("catalog:direct:work")).toBe(fetched);
    }
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = previous;
  }
});

test("the launch catalog fetch is silent and null on every failure, and honors its budget", async () => {
  const request = { url: "https://api.githubcopilot.com/models", headers: {} };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const hanging: CatalogFetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  const attempts: [string, CatalogFetch, CatalogModel[] | null][] = [
    ["network error", () => Promise.reject(new Error("ECONNREFUSED")), null],
    ["budget spent", hanging, null],
    ["rejected", () => Promise.resolve(json({ error: "bad token" }, 401)), null],
    // No `data` array is unknown, never an empty catalog.
    ["unrecognized body", () => Promise.resolve(json({ error: "upstream unavailable" })), null],
    ["catalog", () => Promise.resolve(json({ data: [{ id: "claude-sonnet-4.5" }] })), [
      { id: "claude-sonnet-4.5", is1m: false },
    ]],
  ];
  const write = process.stderr.write;
  let stderrWrites = 0;
  process.stderr.write = ((...args: Parameters<typeof write>) => {
    stderrWrites++;
    return write.apply(process.stderr, args);
  }) as typeof write;
  try {
    for (const [name, fetchImpl, expected] of attempts) {
      const start = Date.now();
      const got = await fetchLaunchCatalog(request, AbortSignal.timeout(50), fetchImpl);
      expect([name, got]).toEqual([name, expected]);
      expect(Date.now() - start).toBeLessThan(1000);
    }
  } finally {
    process.stderr.write = write;
  }
  expect(stderrWrites).toBe(0);
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
