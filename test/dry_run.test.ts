// `--dry-run` on the writing commands: the command runs its own landing under the dry-run session,
// so the printed plan IS the plan the apply would land (same objects), nothing on disk changes,
// and a secret never prints. One test per command family; the disk is proven untouched by a
// fingerprint of the whole scratch HOME before and after. The `--add` preview also proves the
// session's shadow: the wiring reads the slot the (recorded) commit landed a moment before.
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { claudeDesktopStatus } from "../src/agents/claude_desktop.ts";
import { type ProbeDescriptor, probeDirectWorks } from "../src/agents/live_probe.ts";
import { SETTINGS_BACKUP_KEEP, settingsBackupDir } from "../src/agents/transfer.ts";
import { syncCodexCatalogReference } from "../src/codex/catalog_reference.ts";
import { acquireCredential, runAuth } from "../src/commands/auth.ts";
import { runConfig } from "../src/commands/config.ts";
import { runDryRun } from "../src/commands/dry_run.ts";
import { runInit } from "../src/commands/init.ts";
import { runMcp } from "../src/commands/mcp.ts";
import { runProfile } from "../src/commands/profile.ts";
import { runSettings } from "../src/commands/settings.ts";
import { CLAUDE_DESKTOP_DIR_ENV, desktopHelperPath, META_FILENAME } from "../src/claude/desktop.ts";
import { claudeJsonPath } from "../src/claude/mcp_registration.ts";
import { runCodex } from "../src/agents/configure_defaults.ts";
import { NOOP_CATALOG_DEPS } from "../src/codex/catalog.ts";
import { getHostLocalCodexHome, withCodexHostFarm } from "../src/codex/host.ts";
import { codexConfigPath } from "../src/codex/paths.ts";
import { CodexAppController } from "../src/codex/mobile.ts";
import { settingsPathFor } from "../src/claude/paths.ts";
import type { DirectSmoke } from "../src/copilot_api/endpoint_smoke.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { setGithubLoginFetch } from "../src/copilot_api/github_login.ts";
import {
  resetIntegrationIdentityCache,
  setIntegrationProbeFetch,
} from "../src/copilot_api/integration_identity.ts";
import { CopilotApiPaths, profileHome, resolveRootHome } from "../src/copilot_api/paths.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import { appRunning, type ScanExec } from "../src/utils/app_scan.ts";
import { errMessage } from "../src/utils/error.ts";
import { missingDirectories } from "../src/utils/fs.ts";
import { wrapLine } from "../src/utils/table.ts";
import {
  deferWriteReports,
  DRY_RUN_ENV,
  flushWriteReports,
  removeReported,
  spawnedByDryRun,
  writeFileReported,
} from "../src/utils/report_write.ts";
import { collectDryRun, filePlan, landPlan } from "../src/utils/write_session.ts";
import { captureChannels } from "./helpers/output.ts";
import { runCli } from "./helpers/run.ts";
import { afterEach, beforeEach, expect, removeDir, test } from "./helpers/testing.ts";
import {
  type AgentHomes,
  envSnapshot,
  fingerprintTree,
  isolateAgentHomes,
  resetExitCode,
  stageRefusedStop,
  stubGithubLogins,
  writeCodexConfigToml,
} from "./helpers.ts";

const WORK = parseProfileName("work");
const WORK_TOKEN = "ghp_worktoken";
const DIRECT_HOST = "https://api.githubcopilot.com";

const restoreEnv = envSnapshot();
/** The process's real fetch: a case that stubs the global for model discovery is reset here. */
const REAL_FETCH = globalThis.fetch;
let homes: AgentHomes | null = null;

beforeEach(() => {
  // Every Direct landing selects its identity and host over the network; the stub accepts the first
  // candidate on the default host, offline.
  setIntegrationProbeFetch(() =>
    Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }))
  );
  stubGithubLogins({ [WORK_TOKEN]: "work-bot" });
  homes = isolateAgentHomes("copilot-dry-run-", { mkdirs: true });
});

afterEach(() => {
  setIntegrationProbeFetch(null);
  setGithubLoginFetch(null);
  resetIntegrationIdentityCache();
  restoreEnv();
  resetExitCode();
  globalThis.fetch = REAL_FETCH;
  if (homes !== null) removeDir(homes.dir);
  homes = null;
});

function scratch(): AgentHomes {
  if (homes === null) throw new Error("no scratch homes");
  return homes;
}

const fingerprint = fingerprintTree;

function storeCredential(): void {
  new CopilotEnvState().setCredential(null, {
    kind: "stored",
    provider: "gh-token",
    token: "ghu_x",
  });
}

/** Runs `body` as the command would, proving the scratch HOME is byte-for-byte as it was. */
async function dryRun(body: () => Promise<unknown>): Promise<string> {
  const before = fingerprint(scratch().dir);
  const { stdout } = await captureChannels(async () => {
    await body();
  });
  expect(fingerprint(scratch().dir)).toEqual(before);
  expect(stdout).toContain("DRY RUN: nothing was written.");
  return stdout;
}

test("a dry run that fails partway prints the plan landed before the failure, then fails", async () => {
  const { dir } = scratch();
  const path = join(dir, "slot.json");
  // The shape of `profile --add` when the Direct probe fails after the slot commit.
  const body = () => {
    landPlan({ files: [filePlan(path, "create")], apply: () => writeFileSync(path, "{}") });
    return Promise.reject(new Error("the Direct probe failed"));
  };
  const { stdout } = await captureChannels(async () => {
    await expect(runDryRun(body)).rejects.toThrow("the Direct probe failed");
  });
  expect(stdout).toContain("Before it failed, the command would have:");
  expect(stdout).toContain(`create ${path}`);
  expect(existsSync(path)).toBe(false);
});

test("`agent init --direct --dry-run` prints each changed key old -> new for both agents and the store, and writes nothing", async () => {
  const { codexHome, claudeHome } = scratch();
  storeCredential();
  const configPath = writeCodexConfigToml(codexHome, {
    baseUrl: "https://stale.example",
    envKey: "OPENAI_API_KEY",
  });
  const out = await dryRun(() => runInit({ mode: "direct", dryRun: true }));
  // Codex: the stale proxy table is corrected key by key, the plan naming the value it replaces.
  expect(out).toContain(`rewrite ${configPath}`);
  expect(out).toContain(
    `model_providers.copilot-env.base_url  "https://stale.example" -> "${DIRECT_HOST}"`,
  );
  expect(out).toContain('model_providers.copilot-env.env_key  "OPENAI_API_KEY" -> (absent)');
  // Claude: a first write, every managed key from absent.
  expect(out).toContain(`create ${settingsPathFor(claudeHome)}`);
  expect(out).toContain(`env.ANTHROPIC_BASE_URL  (absent) -> "${DIRECT_HOST}"`);
  // The store: the default slot's record and probed pair, as the commit would land them.
  expect(out).toContain(`rewrite ${new CopilotApiPaths().stateStoreFile}`);
  expect(out).toContain('profiles.default.mode  (absent) -> "direct"');
  expect(out).toContain(`profiles.default.copilotHost  (absent) -> "${DIRECT_HOST}"`);
  // The store still holds no record: the dry run's landing was recorded, not applied.
  expect(new CopilotEnvState().readProfileSlot(null).mode).toBeNull();
});

test("`agent profile --add --dry-run` redacts the token it would store; `--del --dry-run` names every file and slot key it would take", async () => {
  const { claudeHome } = scratch();
  const store = new CopilotApiPaths().stateStoreFile;
  const add = await dryRun(() =>
    runProfile({ add: "work", mode: "direct", set: WORK_TOKEN, dryRun: true })
  );
  expect(add).toContain("profiles.work.githubToken  (absent) -> <redacted>");
  expect(add).toContain('profiles.work.mode  (absent) -> "direct"');
  expect(add).toContain(`create ${settingsPathFor(claudeHome, WORK)}`);
  expect(add).not.toContain(WORK_TOKEN);
  expect(new CopilotEnvState().profileNames()).toEqual([]);

  // Landed for real, the same command's deletion previews as the inverse. The real landing is also
  // the fingerprint's negative control: the assertion above can tell a written HOME from an
  // untouched one.
  const untouched = fingerprint(scratch().dir);
  await captureChannels(() => runProfile({ add: "work", mode: "direct", set: WORK_TOKEN }));
  expect(fingerprint(scratch().dir)).not.toEqual(untouched);
  expect(new CopilotEnvState().profileNames()).toEqual([WORK]);
  // The daemon's activity mark is cleared by the stop the deletion runs first, outside any plan's
  // apply: the seam previews it and leaves it (the fingerprint inside dryRun proves the file stays).
  const activity = new CopilotApiPaths(WORK).activityFile;
  mkdirSync(dirname(activity), { recursive: true });
  writeFileSync(activity, '{"lastInferenceMs":1}\n');
  const del = await dryRun(() => runProfile({ del: "work", mode: "auto", dryRun: true }));
  expect(del).toContain(`delete ${activity}`);
  expect(del).toContain(`delete ${settingsPathFor(claudeHome, WORK)}`);
  expect(del).toContain(`rewrite ${store}`);
  expect(del).toContain('profiles.work.mode  "direct" -> (absent)');
  expect(del).toContain("profiles.work.githubToken  <redacted> -> (absent)");
  expect(new CopilotEnvState().profileNames()).toEqual([WORK]);
});

test("`agent auth --dry-run` runs no login and makes no network call: it plans the slot write and names the flow it would run", async () => {
  // Every network seam counts its calls and rejects: the GitHub account look swallows a failed
  // fetch into a label, so the count, not the rejection, is what proves no login or lookup ran.
  let calls = 0;
  const offline = (): Promise<Response> => {
    calls++;
    return Promise.reject(new Error("no network in a dry run"));
  };
  setGithubLoginFetch(offline);
  setIntegrationProbeFetch(offline);
  const { stdout, stderr } = await captureChannels(async () => {
    const before = fingerprint(scratch().dir);
    await runAuth({ provider: "copilot", dryRun: true });
    expect(fingerprint(scratch().dir)).toEqual(before);
  });
  expect(calls).toBe(0);
  expect(stderr).toContain(
    "Would run GitHub's device flow and land the token in the default profile's credential slot.",
  );
  expect(stdout).toContain(`create ${new CopilotApiPaths().stateStoreFile}`);
  expect(stdout).toContain("profiles.default.githubToken  (absent) -> <redacted>");
  expect(stdout).toContain('profiles.default.authProvider  (absent) -> "copilot"');
  expect(stderr).not.toContain("Authenticated (");
  expect(new CopilotEnvState().readCredential(null).kind).toBe("none");
});

test("`profile --add --dry-run` refuses to plan a wiring from a credential the login has not landed (the Direct identity and Claude Desktop's rows need it)", async () => {
  // The device flow lands a token the dry run never has: its stand-in selects nothing.
  await expect(
    captureChannels(() =>
      runProfile({ add: "work", mode: "proxy", provider: "copilot", dryRun: true })
    ),
  ).rejects.toThrow(/Claude Desktop's model rows.*pass --set <token>/);
  expect(new CopilotEnvState().profileNames()).toEqual([]);
});

test("`auth --provider gh-cli --dry-run` plans the pin the real command resolves: the one saved account, never a bare auto", async () => {
  const seams = {
    look: () => ({ token: "gho_saved" }),
    chooseAccount: () => Promise.resolve({ kind: "pinned" as const, login: "octocat" }),
  };
  const choose = { kind: "gh-cli" as const, account: { kind: "choose" as const } };
  const real = await captureChannels(async () => {
    expect(await acquireCredential(choose, null, seams)).toEqual({
      kind: "gh-cli",
      ghUser: "octocat",
    });
  });
  void real;
  const { result } = await collectDryRun(() => acquireCredential(choose, null, seams));
  expect(result).toEqual({ kind: "gh-cli", ghUser: "octocat" });
});

test("`auth --provider gh-cli --dry-run` runs the real `gh auth token` look: an account gh cannot serve is refused the same way", async () => {
  // An account listed only through an env token has no saved credential to pin; the real command
  // refuses at the look, and so does the plan.
  const seams = {
    look: (ghUser: string | null) => ({ token: null, detail: `no saved login for ${ghUser}` }),
    chooseAccount: () => Promise.resolve({ kind: "pinned" as const, login: "octocat" }),
  };
  const choose = { kind: "gh-cli" as const, account: { kind: "choose" as const } };
  const refusal = /gh has no saved credential for account 'octocat'/;
  await expect(captureChannels(async () => void await acquireCredential(choose, null, seams)))
    .rejects.toThrow(
      refusal,
    );
  await expect(collectDryRun(() => acquireCredential(choose, null, seams))).rejects.toThrow(
    refusal,
  );
});

test("`auth --provider gh-env --dry-run` reads the environment as the real command does: nothing set is refused, one set is planned", async () => {
  const env = { kind: "gh-env" as const };
  for (const name of ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) delete process.env[name];
  const refusal = /no GitHub token in the environment/;
  await expect(captureChannels(async () => void await acquireCredential(env, null))).rejects
    .toThrow(refusal);
  await expect(collectDryRun(() => acquireCredential(env, null))).rejects.toThrow(refusal);
  process.env.GH_TOKEN = "ghp_from_env";
  const { result } = await collectDryRun(() => acquireCredential(env, null));
  expect(result).toEqual({ kind: "stored", provider: "gh-env", token: "ghp_from_env" });
});

test("wrapLine splits an over-wide path at the width with every character kept: no space is invented between the pieces", () => {
  const path = "/very/long/path/" + "segment/".repeat(12) + "state.json";
  const lines = wrapLine(`rewrite ${path}`, 40, "  ", "    ");
  expect(lines.every((line) => line.length <= 40)).toBe(true);
  // The word break after "rewrite" is the one character the wrap consumes; the path's pieces
  // reassemble byte for byte.
  expect(lines[0]?.trim()).toBe("rewrite");
  expect(lines.slice(1).map((line) => line.trimStart()).join("")).toBe(path);
});

test("a dry run's auto-mode decision is the real one: the CLI smoke runs and its failure is final, whatever the endpoint says", async () => {
  // The real run wires the proxy when the installed CLI fails its smoke prompt even though the
  // endpoint answers; a dry run that skipped the CLI would preview Direct instead.
  const descriptor: ProbeDescriptor = {
    cli: "claude",
    homeEnvVar: "CLAUDE_CONFIG_DIR",
    args: (prompt) => ["-p", prompt],
  };
  const smoke: DirectSmoke = {
    pickModel: () => Promise.resolve({ ok: true, model: "claude-fable-5" }),
    cliModel: () => Promise.resolve({ ok: true, model: "claude-fable-5" }),
    cliFallbackModel: () => Promise.resolve(null),
    ping: () => Promise.resolve({ ok: true }),
  };
  const probe = (calls: { n: number }) =>
    probeDirectWorks(descriptor, () => {}, smoke, {
      findCommand: (c) => ({ path: `/bin/${c}` }),
      runProbe: () => {
        calls.n++;
        return { ok: false, detail: "auth failed" };
      },
    });
  const real = { n: 0 };
  const dry = { n: 0 };
  await captureChannels(async () => {
    expect(await probe(real)).toBe(false);
  });
  // The real run reached the CLI smoke (the equality below is about a count that is not zero).
  expect(real.n).toBeGreaterThan(0);
  const { result } = await collectDryRun(() => probe(dry));
  expect({ dryVerdict: result, dryCalls: dry.n }).toEqual({ dryVerdict: false, dryCalls: real.n });
});

test("`profile --del --dry-run` takes the real refusal: a daemon that cannot be proven stopped aborts the preview too", async () => {
  // The real command refuses to delete under a daemon.lock holder it cannot identify; the dry run
  // reaches the same refusal (no signal is sent) instead of previewing a deletion that would not run.
  await captureChannels(() => runProfile({ add: "work", mode: "proxy", set: WORK_TOKEN }));
  const fx = stageRefusedStop(profileHome(WORK), WORK);
  try {
    const before = fingerprint(scratch().dir);
    await expect(
      captureChannels(() => runProfile({ del: "work", mode: "auto", dryRun: true })),
    ).rejects.toThrow("did not stop");
    expect(fingerprint(scratch().dir)).toEqual(before);
    expect(new CopilotEnvState().profileNames()).toEqual([WORK]);
  } finally {
    await fx.teardown();
  }
});

const skipWin = test.skipIf(process.platform === "win32");

skipWin(
  "a verify of the Codex host farm plans the member it would recreate, and the real verify recreates it",
  async () => {
    const { dir } = scratch();
    const savedPath = process.env.PATH;
    // The farm derives from HOME; an empty PATH keeps the shared root's codex prime from spawning.
    delete process.env.CODEX_HOME;
    process.env.PATH = join(dir, "empty-bin");
    mkdirSync(process.env.PATH, { recursive: true });
    try {
      new CopilotEnvConfig().set({ "codex.host": true });
      const verify = () => withCodexHostFarm(() => Promise.resolve());
      await captureChannels(verify);
      const member = join(getHostLocalCodexHome(), "log");
      rmSync(member, { recursive: true });
      const before = fingerprint(dir);
      let planned: [string, string][] = [];
      const { all: previewed } = await captureChannels(async () => {
        const { files } = await collectDryRun(verify);
        planned = files.map((f) => [f.path, f.verdict]);
      });
      expect(planned).toContainEqual([member, "create"]);
      expect(fingerprint(dir)).toEqual(before);
      // The recreation only recorded: the success line is the real verify's.
      expect(previewed).not.toContain("farm verified");
      const { all: real } = await captureChannels(verify);
      expect(real).toContain("farm verified");
      expect(existsSync(member)).toBe(true);
    } finally {
      process.env.PATH = savedPath;
    }
  },
);

skipWin(
  "a shared slot held by a regular file fails the dry run with the real build's own error",
  async () => {
    const { dir } = scratch();
    const savedPath = process.env.PATH;
    delete process.env.CODEX_HOME;
    process.env.PATH = join(dir, "empty-bin");
    mkdirSync(process.env.PATH, { recursive: true });
    try {
      new CopilotEnvConfig().set({ "codex.host": true });
      const sharedRoot = join(dir, ".codex");
      mkdirSync(sharedRoot, { recursive: true });
      writeFileSync(join(sharedRoot, "sessions"), "not a directory\n");
      const build = () => captureChannels(() => withCodexHostFarm(() => Promise.resolve()));
      const failure = /Failed to build the CODEX_HOME symlink farm at .*EEXIST/;
      await expect(collectDryRun(build)).rejects.toThrow(failure);
      await expect(build()).rejects.toThrow(failure);
    } finally {
      process.env.PATH = savedPath;
    }
  },
);

skipWin(
  "the farm plan is the builder's own decision in every promotion state: refused leaves, merge copies, an equal file links",
  async () => {
    const { dir } = scratch();
    const savedPath = process.env.PATH;
    delete process.env.CODEX_HOME;
    process.env.PATH = join(dir, "empty-bin");
    mkdirSync(process.env.PATH, { recursive: true });
    try {
      new CopilotEnvConfig().set({ "codex.host": true });
      const hostHome = getHostLocalCodexHome();
      const sharedRoot = join(dir, ".codex");
      // sessions: a local file that differs from the shared copy -> the builder refuses, leaves the
      // directory, links nothing.
      mkdirSync(join(hostHome, "sessions"), { recursive: true });
      writeFileSync(join(hostHome, "sessions", "a.jsonl"), "local\n");
      mkdirSync(join(sharedRoot, "sessions"), { recursive: true });
      writeFileSync(join(sharedRoot, "sessions", "a.jsonl"), "shared\n");
      // memories: nothing shared yet -> the builder creates the shared directory first and merges
      // the local one into it (the copied file is listed), then a link takes its place.
      mkdirSync(join(hostHome, "memories"), { recursive: true });
      writeFileSync(join(hostHome, "memories", "a.txt"), "memo\n");
      // rules: a nested directory present on both sides is no write (the merge's mkdir is a no-op).
      mkdirSync(join(hostHome, "rules", "nested"), { recursive: true });
      mkdirSync(join(sharedRoot, "rules", "nested"), { recursive: true });
      // skills: a local file absent from the shared directory -> merged in, the local tree removed,
      // a link takes its place.
      mkdirSync(join(hostHome, "skills"), { recursive: true });
      writeFileSync(join(hostHome, "skills", "new.md"), "skill\n");
      mkdirSync(join(sharedRoot, "skills"), { recursive: true });
      // AGENTS.md: a non-empty local file over an empty shared one -> the shared copy is refilled,
      // the local file gives way to a link.
      writeFileSync(join(hostHome, "AGENTS.md"), "rules\n");
      writeFileSync(join(sharedRoot, "AGENTS.md"), "");
      const build = () => captureChannels(() => withCodexHostFarm(() => Promise.resolve()));
      const { files } = await collectDryRun(build);
      const planned = files.map((f) => [f.path, f.verdict]);
      expect(planned).not.toContainEqual([join(hostHome, "sessions"), "delete"]);
      expect(planned).toContainEqual([join(sharedRoot, "memories"), "create"]);
      expect(planned).toContainEqual([join(sharedRoot, "memories", "a.txt"), "create"]);
      expect(planned).toContainEqual([join(hostHome, "memories"), "delete"]);
      expect(planned).not.toContainEqual([join(sharedRoot, "rules", "nested"), "rewrite"]);
      expect(planned).toContainEqual([join(hostHome, "rules"), "delete"]);
      expect(planned).toContainEqual([join(sharedRoot, "skills", "new.md"), "create"]);
      expect(planned).toContainEqual([join(hostHome, "skills"), "delete"]);
      expect(planned).toContainEqual([join(sharedRoot, "AGENTS.md"), "rewrite"]);
      expect(planned).toContainEqual([join(hostHome, "AGENTS.md"), "delete"]);
      // The real build lands exactly those decisions.
      await build();
      expect(lstatSync(join(hostHome, "sessions")).isDirectory()).toBe(true);
      expect(readFileSync(join(hostHome, "sessions", "a.jsonl"), "utf8")).toBe("local\n");
      expect(lstatSync(join(hostHome, "memories")).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(sharedRoot, "memories", "a.txt"), "utf8")).toBe("memo\n");
      expect(lstatSync(join(hostHome, "rules")).isSymbolicLink()).toBe(true);
      expect(lstatSync(join(hostHome, "skills")).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(sharedRoot, "skills", "new.md"), "utf8")).toBe("skill\n");
      expect(lstatSync(join(hostHome, "AGENTS.md")).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(sharedRoot, "AGENTS.md"), "utf8")).toBe("rules\n");
    } finally {
      process.env.PATH = savedPath;
    }
  },
);

skipWin(
  "`codex --dry-run` removing a disabled farm plans nothing under it: the catalog sweep reads the farm's config as gone, as the real run's rm leaves it",
  async () => {
    const { dir } = scratch();
    const savedPath = process.env.PATH;
    delete process.env.CODEX_HOME;
    process.env.PATH = join(dir, "empty-bin");
    mkdirSync(process.env.PATH, { recursive: true });
    try {
      storeCredential();
      new CopilotEnvState().recordDefaultMode("proxy");
      new CopilotEnvConfig().set({ "codex.host": true });
      const configure = () => runCodex({ kind: "configure", mode: "proxy" }, NOOP_CATALOG_DEPS);
      await captureChannels(configure);
      const farm = getHostLocalCodexHome();
      const farmConfig = codexConfigPath(farm);
      // The farm's own seeded config references the generated catalog, as a wired farm's does.
      const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
      writeFileSync(
        farmConfig,
        `model_catalog_json = ${JSON.stringify(catalogFile)}\n${readFileSync(farmConfig, "utf8")}`,
      );
      new CopilotEnvConfig().set({ "codex.host": false, "codex.model-catalog": false });
      let planned: [string, string][] = [];
      await captureChannels(async () => {
        const { files } = await collectDryRun(configure);
        planned = files.map((f) => [f.path, f.verdict]);
      });
      expect(planned).toContainEqual([farm, "delete"]);
      // The strip of the catalog reference never touches a config under the tree the run removes.
      expect(planned.filter(([path]) => path.startsWith(`${farm}${sep}`))).toEqual([]);
      expect(existsSync(farmConfig)).toBe(true);
      await captureChannels(configure);
      expect(existsSync(farm)).toBe(false);
    } finally {
      process.env.PATH = savedPath;
    }
  },
);

test("the plan wraps to COLUMNS: no line exceeds 80 columns, a long path or value splitting at the edge", async () => {
  const { codexHome } = scratch();
  storeCredential();
  writeCodexConfigToml(codexHome, { baseUrl: "https://stale.example", envKey: "OPENAI_API_KEY" });
  const saved = process.env.COLUMNS;
  process.env.COLUMNS = "80";
  try {
    const out = await dryRun(() => runInit({ mode: "direct", dryRun: true }));
    const long = out.split("\n").filter((line) => line.length > 80);
    expect(long).toEqual([]);
    // Control: the unwrapped plan has lines past 80, so the assertion above is doing work.
    expect(out.split("\n").length).toBeGreaterThan(20);
  } finally {
    if (saved === undefined) delete process.env.COLUMNS;
    else process.env.COLUMNS = saved;
  }
});

test("`agent config --set --dry-run` shows the preference's stored value moving, and leaves it", async () => {
  runConfig({ set: ["daemon.idle-timeout", "30"] });
  const out = await dryRun(() =>
    Promise.resolve(runConfig({ set: ["daemon.idle-timeout", "45"], dryRun: true }))
  );
  expect(out).toContain(`rewrite ${new CopilotApiPaths().stateStoreFile}`);
  expect(out).toContain('global."daemon.idle-timeout"  30 -> 45');
  expect(new CopilotEnvConfig().read().global["daemon.idle-timeout"]).toBe(30);
});

test("`agent settings --import --dry-run` previews the bundle's changes, the pre-import backup, and the prune it triggers, with no confirmation or write", async () => {
  const { dir } = scratch();
  runConfig({ set: ["daemon.idle-timeout", "45"] });
  const bundle = join(dir, "bundle.json");
  await captureChannels(() => runSettings({ exportTo: bundle }));
  runConfig({ set: ["daemon.idle-timeout", "60"] });
  // A full pile: the backup the import writes pushes the oldest out.
  const backups = settingsBackupDir();
  mkdirSync(backups, { recursive: true });
  for (let i = 0; i < SETTINGS_BACKUP_KEEP; i++) {
    writeFileSync(join(backups, `settings-2026-01-0${i + 1}T00-00-00-000Z-001.json`), "{}\n");
  }
  const pile = (): string[] => readdirSync(backups).sort();
  const before = pile();
  // The backup's name carries the moment it is written, so the two runs' names are compared by
  // shape.
  const shape = (name: string): string =>
    name.replace(/^settings-.*\.json$/, "settings-<stamp>.json");

  const out = await dryRun(() => runSettings({ importFrom: bundle, dryRun: true }));
  expect(out).toContain('global."daemon.idle-timeout"  60 -> 45');
  expect(new CopilotEnvConfig().read().global["daemon.idle-timeout"]).toBe(60);
  const rows = out.split("\n").map((line) => line.trim());
  const planned = (verdict: string): string[] =>
    rows
      .filter((row) => row.startsWith(`${verdict} ${backups}${sep}`))
      .map((row) => row.slice(`${verdict} ${backups}${sep}`.length));
  expect(planned("create").map(shape)).toEqual(["settings-<stamp>.json"]);
  expect(planned("delete")).toEqual([before[0]]);

  // The real import lands exactly that change set on the pile.
  await captureChannels(() => runSettings({ importFrom: bundle, force: true }));
  const after = pile();
  expect(before.filter((name) => !after.includes(name))).toEqual([before[0]]);
  expect(after.filter((name) => !before.includes(name)).map(shape)).toEqual([
    "settings-<stamp>.json",
  ]);
  expect(new CopilotEnvConfig().read().global["daemon.idle-timeout"]).toBe(45);
});

test("`settings --import --dry-run` over a pile of future-dated backups plans no row for the pile: the backup it writes is the one its prune removes, as the real run leaves it", async () => {
  const { dir } = scratch();
  runConfig({ set: ["daemon.idle-timeout", "45"] });
  const bundle = join(dir, "bundle.json");
  await captureChannels(() => runSettings({ exportTo: bundle }));
  runConfig({ set: ["daemon.idle-timeout", "60"] });
  const backups = settingsBackupDir();
  mkdirSync(backups, { recursive: true });
  for (let i = 0; i < SETTINGS_BACKUP_KEEP; i++) {
    writeFileSync(join(backups, `settings-2999-01-0${i + 1}T00-00-00-000Z-001.json`), "{}\n");
  }
  const pile = (): string[] => readdirSync(backups).sort();
  const before = pile();
  const out = await dryRun(() => runSettings({ importFrom: bundle, dryRun: true }));
  expect(out).toContain('global."daemon.idle-timeout"  60 -> 45');
  // Created then deleted inside the run: neither a `create` nor a `delete` row names the pile.
  expect(out.split("\n").filter((line) => line.includes(`${backups}${sep}`))).toEqual([]);
  await captureChannels(() => runSettings({ importFrom: bundle, force: true }));
  expect(pile()).toEqual(before);
  expect(new CopilotEnvConfig().read().global["daemon.idle-timeout"]).toBe(45);
});

test("`agent config --set --dry-run` fails as the real run does when a home's ancestor is a regular file: the same ENOTDIR, no empty preamble", async () => {
  const { dir } = scratch();
  writeFileSync(join(dir, "not-a-dir"), "");
  process.env.COPILOT_API_HOME = join(dir, "not-a-dir", "share", "copilot-env");
  const set = (dryRun: boolean) => runConfig({ set: ["daemon.idle-timeout", "45"], dryRun });
  let real = "";
  try {
    await set(false);
  } catch (e) {
    real = errMessage(e);
  }
  expect(real).toMatch(/^ENOTDIR: not a directory, mkdir '/);
  const { stdout } = await captureChannels(async () => {
    await expect(set(true)).rejects.toThrow(real);
  });
  // Nothing was planned before the failure, so no plan (and no "Before it failed" header) prints.
  expect(stdout).toBe("");
});

test("the dry-run marker a child honours is one a live run holds: an ambient `1`, a pid, a bare nonce, or a hand-made marker leaves `agent config --set` writing for real", async () => {
  const { dir, codexHome, claudeHome } = scratch();
  const env = (marker: string): Record<string, string | undefined> => ({
    ...process.env,
    COPILOT_API_HOME: dir,
    HOME: dir,
    USERPROFILE: dir,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeHome,
    [DRY_RUN_ENV]: marker,
  });
  const store = join(dir, "state.json");
  const set = (marker: string) =>
    runCli(["config", "--set", "daemon.idle-timeout", "45"], { env: env(marker) });
  // A marker-shaped directory nobody holds: made by hand, or left behind by a run that crashed.
  const forged = join(dir, `copilot-env-dry-run-${"0".repeat(32)}`);
  mkdirSync(forged);
  writeFileSync(join(forged, "held"), "");
  // No dry run of ours spawned these: a shell's export, a pid (init's `1` is a live process of the
  // container's root), a nonce with no run behind it, or the unheld marker.
  for (const marker of ["1", String(process.pid), randomBytes(16).toString("hex"), forged]) {
    rmSync(store, { force: true });
    expect(spawnedByDryRun({ [DRY_RUN_ENV]: marker })).toBe(false);
    expect(set(marker).exitCode).toBe(0);
    expect(JSON.parse(readFileSync(store, "utf8")).global["daemon.idle-timeout"]).toBe(45);
  }
  // Spawned by a dry run of this process, which holds its marker: the child is a silent dry run.
  rmSync(store);
  let minted = "";
  await captureChannels(() =>
    runDryRun(() => {
      minted = process.env[DRY_RUN_ENV] ?? "";
      expect(spawnedByDryRun()).toBe(true);
      expect(set(minted).exitCode).toBe(0);
      return Promise.resolve();
    })
  );
  expect(existsSync(store)).toBe(false);
  // The marker dies with the run: the same value afterwards names nothing.
  expect(minted).not.toBe("");
  expect(existsSync(minted)).toBe(false);
  expect(spawnedByDryRun({ [DRY_RUN_ENV]: minted })).toBe(false);
  expect(process.env[DRY_RUN_ENV]).toBeUndefined();
});

test("every PowerShell scan gets a scratch profile (the Desktop and Codex app looks hand powershell a USERPROFILE of their own, removed after); the app launch keeps the user's", async () => {
  const spawns: { file: string; env: Record<string, string | undefined> | undefined }[] = [];
  const exec: ScanExec = (file, _args, opts) => {
    spawns.push({ file, env: opts?.env });
    // The profile exists while the scan runs.
    if (opts?.env !== undefined) expect(existsSync(opts.env.USERPROFILE ?? "")).toBe(true);
    return Promise.resolve({ exitCode: 0, stdout: "absent" });
  };
  expect(await appRunning("Claude", exec, "win32")).toBe("absent");
  const codex = new CodexAppController(exec, "win32");
  expect(await codex.runningState()).toBe("absent");
  expect(await codex.installedState()).toBe("absent");
  expect(spawns.map((s) => s.file)).toEqual(["powershell", "powershell", "powershell"]);
  for (const { env } of spawns) {
    const profile = env?.USERPROFILE ?? "";
    expect(basename(profile).startsWith("copilot-env-ps-")).toBe(true);
    expect(profile).not.toBe(scratch().dir);
    expect(env?.APPDATA).toBe(join(profile, "AppData", "Roaming"));
    expect(env?.LOCALAPPDATA).toBe(join(profile, "AppData", "Local"));
    expect(existsSync(profile)).toBe(false);
  }
  // What Start-Process launches inherits the spawn's environment: the launch is the one PowerShell
  // spawn that keeps the inherited profile.
  await codex.open();
  expect(spawns.length).toBe(4);
  expect(spawns[3]?.env).toBeUndefined();
});

skipWin(
  "a dangling symlink at a home's ancestor fails `config --set --dry-run` as the real mkdir fails: the same EEXIST, no plan",
  async () => {
    const { dir } = scratch();
    const dangling = join(dir, "dangling");
    symlinkSync(join(dir, "nowhere"), dangling);
    const home = join(dangling, "share", "copilot-env");
    process.env.COPILOT_API_HOME = home;
    // The reference is the OS's own: what a raw recursive mkdir of the home raises. Both runs walk
    // the ancestors before any mkdir (the seam's planner), so each is pinned to this, not to the
    // other.
    const raw = mkdirFailure(home);
    expect(raw).toMatch(/^EEXIST: file already exists, mkdir '/);
    const set = (dryRun: boolean) => runConfig({ set: ["daemon.idle-timeout", "45"], dryRun });
    let real = "";
    try {
      await set(false);
    } catch (e) {
      real = errMessage(e);
    }
    expect(real).toBe(raw);
    const { stdout } = await captureChannels(async () => {
      await expect(set(true)).rejects.toThrow(raw);
    });
    expect(stdout).toBe("");
    // The walk is mkdir's own on every link: one to a directory is that directory (its children are
    // the creates), one to a file above the path is mkdir's ENOTDIR, as the raw call raises them.
    const target = join(dir, "target");
    mkdirSync(target);
    symlinkSync(target, join(dir, "to-dir"));
    const under = join(dir, "to-dir", "a", "b");
    expect(missingDirectories(under)).toEqual([join(dir, "to-dir", "a"), under]);
    writeFileSync(join(dir, "file"), "");
    symlinkSync(join(dir, "file"), join(dir, "to-file"));
    const blocked = join(dir, "to-file", "a");
    const notdir = mkdirFailure(blocked);
    expect(notdir).toMatch(/^ENOTDIR/);
    expect(() => missingDirectories(blocked)).toThrow(notdir);
  },
);

/** The message a raw `mkdirSync(path, { recursive: true })` fails with; "" when it succeeds. */
function mkdirFailure(path: string): string {
  try {
    mkdirSync(path, { recursive: true });
    return "";
  } catch (e) {
    return errMessage(e);
  }
}

test("`codex --dry-run` with the catalog disabled and a directory at the catalog path takes the real decision: the warning, no delete", async () => {
  const catalogFile = new CopilotApiPaths().codexModelCatalogFile;
  mkdirSync(catalogFile, { recursive: true });
  const warning = `codex model catalog cleanup failed: ${catalogFile} is a directory`;
  const real = await captureChannels(() => Promise.resolve(syncCodexCatalogReference()));
  expect(real.stderr).toContain(warning);
  expect(lstatSync(catalogFile).isDirectory()).toBe(true);
  let planned: [string, string][] = [];
  const dry = await captureChannels(async () => {
    const { files } = await collectDryRun(() => Promise.resolve(syncCodexCatalogReference()));
    planned = files.map((f) => [f.path, f.verdict]);
  });
  expect(dry.stderr).toContain(warning);
  expect(planned).not.toContainEqual([catalogFile, "delete"]);
});

test("removeReported decides alike in both runs: a directory is refused, and a file this run planned is planned gone", async () => {
  const { dir } = scratch();
  const tree = join(dir, "tree");
  mkdirSync(tree);
  const refusal = /is a directory/;
  expect(() => removeReported(tree)).toThrow(refusal);
  await expect(collectDryRun(() => Promise.resolve(removeReported(tree)))).rejects.toThrow(refusal);
  expect(existsSync(tree)).toBe(true);
  // The prune of a backup pile removes the file the same run just wrote when it sorts oldest: the
  // seam sees the planned write, not the disk, so the plan carries the removal too.
  const file = join(dir, "planned.txt");
  const { files } = await collectDryRun(() => {
    writeFileReported(file, "x");
    return Promise.resolve(removeReported(file));
  });
  expect(files.map((f) => [f.path, f.verdict])).toEqual([[file, "create"], [file, "delete"]]);
  expect(existsSync(file)).toBe(false);
});

test("`agent mcp --remove --dry-run` names the registration, the deny, and the opt-out key it would take back", async () => {
  const { claudeHome } = scratch();
  storeCredential();
  // A Direct default wiring registers the MCP server and denies the builtin WebSearch.
  await captureChannels(() => runInit({ mode: "direct" }));
  const registration = JSON.parse(readFileSync(claudeJsonPath(), "utf8")) as Record<
    string,
    unknown
  >;
  expect(Object.keys(registration.mcpServers as Record<string, unknown>)).toEqual(["copilot-env"]);

  const out = await dryRun(() => runMcp({ remove: true, dryRun: true }));
  expect(out).toContain(`rewrite ${claudeJsonPath()}`);
  expect(out).toMatch(/mcpServers\.copilot-env\.command {2}"[^"]+" -> \(absent\)/);
  expect(out).toContain(`rewrite ${settingsPathFor(claudeHome)}`);
  expect(out).toContain('permissions.deny  ["WebSearch"] -> (absent)');
  expect(out).toContain('global."claude.wire-mcp"  (absent) -> false');
  expect(JSON.parse(readFileSync(claudeJsonPath(), "utf8"))).toEqual(registration);
});

test("a fresh HOME's plan names the homes the real run creates, outermost first, as directory rows", async () => {
  // The apply's mkdir never runs in a dry run; the session derives the missing ancestors of every
  // planned create instead, so the plan equals the real run's named set by construction.
  if (homes !== null) removeDir(homes.dir);
  homes = isolateAgentHomes("copilot-dry-run-fresh-");
  const { claudeHome, codexHome, dir } = homes;
  storeCredential();
  const out = await dryRun(() => runInit({ mode: "direct", dryRun: true }));
  const rows = out.split("\n").map((line) => line.trim());
  expect(rows).toContain(`create ${claudeHome}${sep}`);
  expect(rows).toContain(`create ${codexHome}${sep}`);
  expect(rows.indexOf(`create ${claudeHome}${sep}`)).toBeLessThan(
    rows.indexOf(`create ${settingsPathFor(claudeHome)}`),
  );
  expect(existsSync(claudeHome)).toBe(false);
  // The real run creates exactly those directories, and names them (the seam writes its lines on
  // raw stderr, so they are read through its own deferral).
  deferWriteReports();
  await captureChannels(() => runInit({ mode: "direct" }));
  const named = flushWriteReports();
  expect(named).toContain(`created -> ${claudeHome}`);
  expect(named).toContain(`created -> ${codexHome}`);
  expect(existsSync(join(dir, ".claude"))).toBe(true);
});

test("`profile --add --direct --set ' '` over a proxy profile refuses the blank token first in both runs: no stop, no plan row, nothing touched", async () => {
  await captureChannels(() => runProfile({ add: "work", mode: "proxy", set: WORK_TOKEN }));
  const activity = new CopilotApiPaths(WORK).activityFile;
  mkdirSync(dirname(activity), { recursive: true });
  writeFileSync(activity, '{"lastInferenceMs":1}\n');
  const refusal = "the provided GitHub token is empty";
  const add = (dryRun: boolean) => runProfile({ add: "work", mode: "direct", set: " ", dryRun });
  const before = fingerprint(scratch().dir);
  await expect(captureChannels(() => add(false))).rejects.toThrow(refusal);
  expect(fingerprint(scratch().dir)).toEqual(before);
  const { stdout } = await captureChannels(async () => {
    await expect(add(true)).rejects.toThrow(refusal);
  });
  // Refused before the daemon stop's activity clear could be planned: no plan prints at all.
  expect(stdout).toBe("");
  expect(fingerprint(scratch().dir)).toEqual(before);
  expect(new CopilotEnvState().readProfileSlot(WORK).mode).toBe("proxy");
});

test("`profile --del --dry-run` with a directory at the profile's Desktop helper path takes the real decision: the warning, no delete, the directory kept", async () => {
  await captureChannels(() => runProfile({ add: "work", mode: "proxy", set: WORK_TOKEN }));
  const helper = desktopHelperPath(resolveRootHome(), "proxy", WORK);
  mkdirSync(helper, { recursive: true });
  const warning = `${helper} is a directory; only a file can be removed here`;
  const dry = await captureChannels(() => runProfile({ del: "work", mode: "auto", dryRun: true }));
  expect(dry.stderr).toContain(warning);
  expect(dry.stdout).not.toContain(`delete ${helper}`);
  expect(dry.stdout).toContain(`rewrite ${new CopilotApiPaths().stateStoreFile}`);
  const real = await captureChannels(() => runProfile({ del: "work", mode: "auto" }));
  expect(real.stderr).toContain(warning);
  expect(lstatSync(helper).isDirectory()).toBe(true);
  expect(new CopilotEnvState().profileNames()).toEqual([]);
});

/** Claude Desktop present in the scratch HOME, its config library under `library`, and the
 *  default slot holding a token. The proxy wire's model discovery falls back to the Copilot
 *  catalog when the daemon is down: the stub answers every https look and counts it in
 *  `discoveries`, anything else (the daemon) is offline. */
function isolateWithDesktop(): { library: string; discoveries: { n: number } } {
  const desktop = join(scratch().dir, "claude-desktop");
  mkdirSync(desktop);
  process.env[CLAUDE_DESKTOP_DIR_ENV] = desktop;
  storeCredential();
  const catalog = { data: [{ id: "claude-fable-5", capabilities: { limits: {} } }] };
  const discoveries = { n: 0 };
  globalThis.fetch = ((input: string | URL | Request) => {
    if (!String(input).startsWith("https://")) return Promise.reject(new Error("offline"));
    discoveries.n++;
    return Promise.resolve(new Response(JSON.stringify(catalog), { status: 200 }));
  }) as typeof fetch;
  return { library: join(desktop, "configLibrary"), discoveries };
}

test("`init --proxy --dry-run` with the default's helper chmod'd 0644 runs Claude Desktop's model discovery as often as the real run: the planned helper reads executable", async () => {
  const { discoveries } = isolateWithDesktop();
  await captureChannels(() => runInit({ mode: "proxy" }));
  const helper = desktopHelperPath(resolveRootHome(), "proxy", null);
  expect(existsSync(helper)).toBe(true);
  const probes = async (body: () => Promise<void>): Promise<number> => {
    chmodSync(helper, 0o644);
    discoveries.n = 0;
    await captureChannels(body);
    return discoveries.n;
  };
  // The plan heals the mode (the real run's chmod); the later status read sees it healed too.
  const dry = await probes(() => runInit({ mode: "proxy", dryRun: true }));
  const real = await probes(() => runInit({ mode: "proxy" }));
  expect(real).toBeGreaterThan(0);
  expect(dry).toBe(real);
});

test("`init --proxy --dry-run` after `config --set static-key claude` over a proxy Desktop wiring probes once, as the real run does: the helper the plan deletes is invisible to the status read", async () => {
  const { discoveries } = isolateWithDesktop();
  await captureChannels(() => runInit({ mode: "proxy" }));
  const helper = desktopHelperPath(resolveRootHome(), "proxy", null);
  expect(existsSync(helper)).toBe(true);
  // The static shape names no helper: the wire plans the script's deletion, and the status read
  // that follows must not find it on disk and call the entry stale (a second discovery).
  new CopilotEnvConfig().setProfile(null, { "static-key": "claude" });
  const probes = async (body: () => Promise<void>): Promise<number> => {
    discoveries.n = 0;
    await captureChannels(body);
    return discoveries.n;
  };
  const dry = await probes(() => runInit({ mode: "proxy", dryRun: true }));
  expect(existsSync(helper)).toBe(true);
  const real = await probes(() => runInit({ mode: "proxy" }));
  expect(existsSync(helper)).toBe(false);
  expect({ dry, real }).toEqual({ dry: 1, real: 1 });
});

test("a directory at the retired helper's path fails only the retirement: both runs warn and still land the Desktop entry", async () => {
  const { library } = isolateWithDesktop();
  await captureChannels(() => runInit({ mode: "proxy" }));
  const entry = readdirSync(library).filter((name) => name !== META_FILENAME).map((name) =>
    join(library, name)
  );
  expect(entry.length).toBe(1);
  // The proxy wire retires the Direct helper; a directory sits where that script would be.
  const retired = desktopHelperPath(resolveRootHome(), "direct", null);
  mkdirSync(retired, { recursive: true });
  const warning = `${retired} is a directory; only a file can be removed here; left alone.`;
  const dry = await captureChannels(() => runInit({ mode: "proxy", dryRun: true }));
  expect(dry.stderr).toContain(warning);
  expect(dry.stdout).not.toContain(`delete ${retired}`);
  // The entry itself is preserved (its re-plan is byte-identical), not discarded with the retirement.
  expect(dry.stdout).toContain(`unchanged ${entry[0]}`);
  const real = await captureChannels(() => runInit({ mode: "proxy" }));
  expect(real.stderr).toContain(warning);
  // The entry landed regardless: the status inspector judges it wired (a fact consola's repeat
  // throttle cannot hide, unlike a success line printed twice in a row).
  const status = claudeDesktopStatus();
  expect(status.kind).toBe("inspected");
  if (status.kind === "inspected") {
    expect(status.entries.map((e) => [e.profile, e.verdict.kind])).toEqual([[null, "wired"]]);
  }
  expect(lstatSync(retired).isDirectory()).toBe(true);
});
