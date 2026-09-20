// `--dry-run` on the writing commands: the command runs its own landing under the dry-run session,
// so the printed plan IS the plan the apply would land (same objects), nothing on disk changes,
// and a secret never prints. One test per command family; the disk is proven untouched by a
// fingerprint of the whole scratch HOME before and after. The named `add` preview also proves the
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
import { runMcp } from "../src/commands/mcp.ts";
import { addProfile, delProfile } from "../src/commands/profile.ts";
import { runSettings } from "../src/commands/settings.ts";
import { desktopHelperPath } from "../src/claude/desktop_helper_scripts.ts";
import { CLAUDE_DESKTOP_DIR_ENV } from "../src/claude/desktop_library.ts";
import { claudeJsonPath } from "../src/claude/mcp_registration.ts";
import { runCodex } from "../src/agents/configure_defaults.ts";
import { getHostLocalCodexHome, withCodexHostFarm } from "../src/codex/host.ts";
import { codexConfigPath } from "../src/codex/paths.ts";
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
import { missingDirectories } from "../src/utils/fs_disk.ts";
import * as fs from "../src/utils/fs_facade.ts";
import { wrapLine } from "../src/utils/table.ts";
import { DRY_RUN_ENV, spawnedByDryRun } from "../src/utils/dry_run.ts";
import { deferWriteReports, flushWriteReports } from "../src/utils/report_write.ts";
import { captureChannels } from "./helpers/output.ts";
import { runCli } from "./helpers/run.ts";
import { afterEach, beforeEach, expect, removeDir, test } from "./helpers/testing.ts";
import {
  agentHomeEnv,
  type AgentHomes,
  envSnapshot,
  isolateAgentHomes,
  resetExitCode,
} from "./helpers/env.ts";
import { stubGithubLogins, writeCodexConfigToml } from "./helpers/fixtures.ts";
import { dryRunChanges, fingerprintTree } from "./helpers/dry_run.ts";
import { stageRefusedStop } from "./helpers/daemon.ts";

const WORK = parseProfileName("work");
const WORK_TOKEN = "ghp_worktoken";

/** A named profile lands in two commands now: `add` records the mode, `auth` lands the credential
 *  and wires both agents. */
async function addWork(mode: "direct" | "proxy", token: string): Promise<void> {
  await addProfile(WORK, { mode, noAuth: true });
  await runAuth({ set: token, profile: "work" });
}
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
  // The shape of a named `add` then `auth` when the Direct probe fails after the slot commit.
  const body = () => {
    fs.writeText(path, "{}");
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
  const out = await dryRun(() => addProfile(null, { mode: "direct", dryRun: true }));
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

test("`agent profile <name> add --dry-run` plans the mode alone; the credential landing redacts the token and plans both files; `del --dry-run` names every file and slot key it would take", async () => {
  const { claudeHome } = scratch();
  const store = new CopilotApiPaths().stateStoreFile;
  const add = await dryRun(() => addProfile(WORK, { mode: "direct", dryRun: true }));
  expect(add).toContain('profiles.work.mode  (absent) -> "direct"');
  expect(add).not.toContain("githubToken");
  expect(new CopilotEnvState().profileNames()).toEqual([]);
  await captureChannels(() => addProfile(WORK, { mode: "direct", noAuth: true }));
  const auth = await dryRun(() => runAuth({ set: WORK_TOKEN, profile: "work", dryRun: true }));
  expect(auth).toContain("profiles.work.githubToken  (absent) -> <redacted>");
  expect(auth).not.toContain(WORK_TOKEN);
  expect(new CopilotEnvState().readCredential(WORK).kind).toBe("none");

  // Landed for real, the deletion previews as the inverse. The real landing is also the
  // fingerprint's negative control: the assertion above can tell a written HOME from an untouched
  // one.
  const untouched = fingerprint(scratch().dir);
  await captureChannels(() => runAuth({ set: WORK_TOKEN, profile: "work" }));
  expect(fingerprint(scratch().dir)).not.toEqual(untouched);
  expect(new CopilotEnvState().profileNames()).toEqual([WORK]);
  // The daemon's activity mark is cleared by the stop the deletion runs first; the seam previews
  // it (the fingerprint inside dryRun proves the file stays), and the tree diff folds it into the
  // one row of the profile home it goes with.
  const activity = new CopilotApiPaths(WORK).activityFile;
  mkdirSync(dirname(activity), { recursive: true });
  writeFileSync(activity, '{"lastInferenceMs":1}\n');
  const del = await dryRun(() => delProfile(WORK, true));
  expect(del).toContain(`delete ${profileHome(WORK)}${sep}`);
  expect(del).not.toContain(activity);
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

test("a named `auth --provider copilot --dry-run` names the wiring it cannot plan (the login has not landed, so the identity and Claude Desktop's rows are unselected)", async () => {
  await captureChannels(() => addProfile(WORK, { mode: "proxy", noAuth: true }));
  const { stdout, stderr } = await captureChannels(() =>
    runAuth({ provider: "copilot", profile: "work", dryRun: true })
  );
  expect(stdout).toContain('profiles.work.authProvider  (absent) -> "copilot"');
  expect(stderr).toContain("Would wire profile 'work''s proxy mode into both agents");
  expect(new CopilotEnvState().readCredential(WORK).kind).toBe("none");
});

// The plan acquires the credential the way the real command does: through the same seams (gh's
// saved login, the account choice) and the same environment, refused the same way.
test("`auth --provider <gh-cli|gh-env> --dry-run` resolves what the real command resolves: the one saved account (never a bare auto) or the env token, and refuses where it refuses", async () => {
  const choose = { kind: "gh-cli" as const, account: { kind: "choose" as const } };
  const pinned = () => Promise.resolve({ kind: "pinned" as const, login: "octocat" });
  const fromEnv = { kind: "gh-env" as const };
  for (const name of ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) delete process.env[name];
  const rows: {
    name: string;
    acquisition: Parameters<typeof acquireCredential>[0];
    seams?: Parameters<typeof acquireCredential>[2];
    env?: Record<string, string>;
    outcome: { value: unknown } | { refusal: RegExp };
  }[] = [
    {
      name: "gh-cli with a saved login",
      acquisition: choose,
      seams: { look: () => ({ token: "gho_saved" }), chooseAccount: pinned },
      outcome: { value: { kind: "gh-cli", ghUser: "octocat" } },
    },
    // An account listed only through an env token has no saved credential to pin; the real command
    // refuses at the look, and so does the plan.
    {
      name: "gh-cli without a saved login",
      acquisition: choose,
      seams: {
        look: (ghUser) => ({ token: null, detail: `no saved login for ${ghUser}` }),
        chooseAccount: pinned,
      },
      outcome: { refusal: /gh has no saved credential for account 'octocat'/ },
    },
    {
      name: "gh-env with nothing set",
      acquisition: fromEnv,
      outcome: { refusal: /no GitHub token in the environment/ },
    },
    {
      name: "gh-env with GH_TOKEN set",
      acquisition: fromEnv,
      env: { GH_TOKEN: "ghp_from_env" },
      outcome: { value: { kind: "stored", provider: "gh-env", token: "ghp_from_env" } },
    },
  ];
  for (const { name, acquisition, seams, env, outcome } of rows) {
    Object.assign(process.env, env);
    const acquire = () => acquireCredential(acquisition, null, seams);
    if ("refusal" in outcome) {
      await expect(captureChannels(async () => void await acquire()), name).rejects.toThrow(
        outcome.refusal,
      );
      await expect(dryRunChanges(acquire), name).rejects.toThrow(outcome.refusal);
    } else {
      let real: unknown;
      await captureChannels(async () => {
        real = await acquire();
      });
      expect(real, name).toEqual(outcome.value);
      expect((await dryRunChanges(acquire)).result, name).toEqual(outcome.value);
    }
  }
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
  const { result } = await dryRunChanges(() => probe(dry));
  expect({ dryVerdict: result, dryCalls: dry.n }).toEqual({ dryVerdict: false, dryCalls: real.n });
});

test("`profile <name> del --dry-run` takes the real refusal: a daemon that cannot be proven stopped aborts the preview too", async () => {
  // The real command refuses to delete under a daemon.lock holder it cannot identify; the dry run
  // reaches the same refusal (no signal is sent) instead of previewing a deletion that would not run.
  await captureChannels(() => addWork("proxy", WORK_TOKEN));
  const fx = stageRefusedStop(profileHome(WORK), WORK);
  try {
    const before = fingerprint(scratch().dir);
    await expect(
      captureChannels(() => delProfile(WORK, true)),
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
        const { changes } = await dryRunChanges(verify);
        planned = changes.map((c) => [c.path, c.verdict]);
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
      await expect(dryRunChanges(build)).rejects.toThrow(failure);
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
      // AGENTS.md: a local file equal to the shared one -> no shared write, the local file gives
      // way to a link.
      writeFileSync(join(hostHome, "AGENTS.md"), "rules\n");
      writeFileSync(join(sharedRoot, "AGENTS.md"), "rules\n");
      const build = () => captureChannels(() => withCodexHostFarm(() => Promise.resolve()));
      const { changes } = await dryRunChanges(build);
      const planned = changes.map((c) => [c.path, c.verdict]);
      expect(planned).not.toContainEqual([join(hostHome, "sessions"), "delete"]);
      expect(planned).toContainEqual([join(sharedRoot, "memories"), "create"]);
      expect(planned).toContainEqual([join(sharedRoot, "memories", "a.txt"), "create"]);
      expect(planned).toContainEqual([join(hostHome, "memories"), "rewrite"]);
      expect(planned).not.toContainEqual([join(sharedRoot, "rules", "nested"), "rewrite"]);
      expect(planned).toContainEqual([join(hostHome, "rules"), "rewrite"]);
      expect(planned).toContainEqual([join(sharedRoot, "skills", "new.md"), "create"]);
      expect(planned).toContainEqual([join(hostHome, "skills"), "rewrite"]);
      expect(planned).not.toContainEqual([join(sharedRoot, "AGENTS.md"), "rewrite"]);
      expect(planned).toContainEqual([join(hostHome, "AGENTS.md"), "rewrite"]);
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
      const configure = () => runCodex({ kind: "configure", mode: "proxy" });
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
        const { changes } = await dryRunChanges(configure);
        planned = changes.map((c) => [c.path, c.verdict]);
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
    const out = await dryRun(() => addProfile(null, { mode: "direct", dryRun: true }));
    const long = out.split("\n").filter((line) => line.length > 80);
    expect(long).toEqual([]);
    // Control: the unwrapped plan has lines past 80, so the assertion above is doing work.
    expect(out.split("\n").length).toBeGreaterThan(20);
  } finally {
    if (saved === undefined) delete process.env.COLUMNS;
    else process.env.COLUMNS = saved;
  }
});

test("`agent config set --dry-run` shows the preference's stored value moving, and leaves it", async () => {
  runConfig({
    kind: "set",
    key: "daemon.idle-timeout",
    value: "30",
    view: { kind: "config" },
    dryRun: false,
  });
  const out = await dryRun(() =>
    Promise.resolve(
      runConfig({
        kind: "set",
        key: "daemon.idle-timeout",
        value: "45",
        view: { kind: "config" },
        dryRun: true,
      }),
    )
  );
  expect(out).toContain(`rewrite ${new CopilotApiPaths().stateStoreFile}`);
  expect(out).toContain('global."daemon.idle-timeout"  30 -> 45');
  expect(new CopilotEnvConfig().read().global["daemon.idle-timeout"]).toBe(30);
});

// Both price-source URLs may carry a token in their query, so the store's plan redacts their leaf
// while every other preference prints in the clear.
for (const key of ["cost.pricing-url", "cost.github-pricing-url"] as const) {
  test(`\`agent config set ${key} --dry-run\` redacts the URL's row`, async () => {
    const out = await dryRun(() =>
      Promise.resolve(
        runConfig({
          kind: "set",
          key,
          value: "https://prices.example/list?token=SECRET-URL-TOKEN",
          view: { kind: "config" },
          dryRun: true,
        }),
      )
    );
    expect(out).toContain(`global."${key}"  (absent) -> <redacted>`);
    expect(out).not.toContain("SECRET-URL-TOKEN");
    expect(out).not.toContain("prices.example");
  });
}

// The import previews the bundle's changes, the pre-import backup, and the prune that backup
// triggers, with no confirmation or write; the plan's rows on the pile equal the real run's change
// set there.
test("`agent settings --import --dry-run` plans the pre-import backup and its prune as the real run lands them: a full pile loses its oldest, a future-dated pile loses the new backup itself", async () => {
  const { dir } = scratch();
  const set = (value: string) =>
    runConfig({
      kind: "set",
      key: "daemon.idle-timeout",
      value,
      view: { kind: "config" },
      dryRun: false,
    });
  set("45");
  const bundle = join(dir, "bundle.json");
  await captureChannels(() => runSettings({ exportTo: bundle }));
  const backups = settingsBackupDir();
  const pile = (): string[] => readdirSync(backups).sort();
  // The backup's name carries the moment it is written, so the two runs' names are compared by
  // shape.
  const shape = (name: string): string =>
    name.replace(/^settings-.*\.json$/, "settings-<stamp>.json");
  /** The plan's rows naming a file on the pile, `<verdict> <name>`, the created one by shape. */
  const planned = (out: string): string[] =>
    out
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes(`${backups}${sep}settings-`))
      .map((line) => {
        const verdict = line.slice(0, line.indexOf(" "));
        const name = basename(line.slice(verdict.length + 1));
        return `${verdict} ${verdict === "create" ? shape(name) : name}`;
      })
      .sort();
  const rows: { name: string; year: string; changes: (before: string[]) => string[] }[] = [
    // A full pile: the backup the import writes pushes the oldest out.
    {
      name: "full pile",
      year: "2026",
      changes: (before) => [`create settings-<stamp>.json`, `delete ${before[0]}`],
    },
    // Created then deleted inside the run: no row of any verdict names a backup (the directory's
    // own row is its mode), and the real pile is as it was.
    { name: "future-dated pile", year: "2999", changes: () => [] },
  ];
  for (const { name, year, changes } of rows) {
    set("60");
    rmSync(backups, { recursive: true, force: true });
    mkdirSync(backups, { recursive: true });
    for (let i = 0; i < SETTINGS_BACKUP_KEEP; i++) {
      writeFileSync(join(backups, `settings-${year}-01-0${i + 1}T00-00-00-000Z-001.json`), "{}\n");
    }
    const before = pile();
    const out = await dryRun(() => runSettings({ importFrom: bundle, dryRun: true }));
    expect(out, name).toContain('global."daemon.idle-timeout"  60 -> 45');
    expect(new CopilotEnvConfig().read().global["daemon.idle-timeout"], name).toBe(60);
    expect(planned(out), name).toEqual(changes(before).sort());
    // The real import lands exactly that change set on the pile.
    await captureChannels(() => runSettings({ importFrom: bundle, force: true }));
    const after = pile();
    const landed = [
      ...after.filter((entry) => !before.includes(entry)).map((entry) => `create ${shape(entry)}`),
      ...before.filter((entry) => !after.includes(entry)).map((entry) => `delete ${entry}`),
    ];
    expect(landed.sort(), name).toEqual(changes(before).sort());
    expect(new CopilotEnvConfig().read().global["daemon.idle-timeout"], name).toBe(45);
  }
});

// The reference is the OS's own: what a raw recursive mkdir raises. Both runs walk the ancestors
// before any mkdir (the seam's planner), so each is pinned to this, not to the other: the real run
// fails first at the store lock's directory, the dry run (no lock) at the home. Nothing was planned
// before the failure, so no plan (and no "Before it failed" header) prints.
test("`agent config set --dry-run` fails as the real mkdir fails when a home's ancestor is a regular file or a dangling symlink: the same ENOTDIR or EEXIST, no plan", async () => {
  const { dir } = scratch();
  const rows: {
    name: string;
    posixOnly?: boolean;
    ancestor: (path: string) => void;
    refusal: RegExp;
  }[] = [
    {
      name: "not-a-dir",
      ancestor: (path) => writeFileSync(path, ""),
      refusal: /^ENOTDIR: not a directory, mkdir '/,
    },
    // A dangling link is POSIX semantics: the row skips on Windows.
    {
      name: "dangling",
      posixOnly: true,
      ancestor: (path) => symlinkSync(join(dir, "nowhere"), path),
      refusal: /^EEXIST: file already exists, mkdir '/,
    },
  ];
  for (const { name, posixOnly, ancestor, refusal } of rows) {
    if (posixOnly && process.platform === "win32") continue;
    ancestor(join(dir, name));
    const home = join(dir, name, "share", "copilot-env");
    process.env.COPILOT_API_HOME = home;
    const raw = mkdirFailure(home);
    expect(raw, name).toMatch(refusal);
    const set = (dryRun: boolean) =>
      runConfig({
        kind: "set",
        key: "daemon.idle-timeout",
        value: "45",
        view: { kind: "config" },
        dryRun: dryRun,
      });
    let real = "";
    try {
      await set(false);
    } catch (e) {
      real = errMessage(e);
    }
    expect(real, name).toMatch(refusal);
    expect(real, name).toBe(mkdirFailure(new CopilotApiPaths().locksDir));
    const { stdout } = await captureChannels(async () => {
      await expect(set(true), name).rejects.toThrow(raw);
    });
    expect(stdout, name).toBe("");
  }
});

test("the dry-run marker a child honours is one a live run holds: an ambient `1`, a pid, a bare nonce, or a hand-made marker leaves `agent config set` writing for real", async () => {
  const { dir, codexHome, claudeHome } = scratch();
  const env = (marker: string): Record<string, string | undefined> => ({
    ...process.env,
    ...agentHomeEnv(dir, { codexHome, claudeHome }),
    [DRY_RUN_ENV]: marker,
  });
  const store = join(dir, "state.json");
  const set = (marker: string) =>
    runCli(["config", "set", "daemon.idle-timeout", "45"], { env: env(marker) });
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

test("every PowerShell scan gets a scratch profile (the app looks hand powershell a USERPROFILE of their own, removed after)", async () => {
  const spawns: { file: string; env: Record<string, string | undefined> | undefined }[] = [];
  const exec: ScanExec = (file, _args, opts) => {
    spawns.push({ file, env: opts?.env });
    // The profile exists while the scan runs.
    if (opts?.env !== undefined) expect(existsSync(opts.env.USERPROFILE ?? "")).toBe(true);
    return Promise.resolve({ exitCode: 0, stdout: "absent" });
  };
  expect(await appRunning("Claude", exec, "win32")).toBe("absent");
  expect(spawns.map((s) => s.file)).toEqual(["powershell"]);
  for (const { env } of spawns) {
    const profile = env?.USERPROFILE ?? "";
    expect(basename(profile).startsWith("copilot-env-ps-")).toBe(true);
    expect(profile).not.toBe(scratch().dir);
    expect(env?.APPDATA).toBe(join(profile, "AppData", "Roaming"));
    expect(env?.LOCALAPPDATA).toBe(join(profile, "AppData", "Local"));
    expect(existsSync(profile)).toBe(false);
  }
});

// The walk is mkdir's own on every link: one to a directory is that directory (its children are
// the creates), one to a file above the path is mkdir's ENOTDIR, as the raw call raises them.
skipWin(
  "missingDirectories walks a symlink as mkdir does: a link to a directory is that directory, a link to a file above the path is mkdir's ENOTDIR",
  () => {
    const { dir } = scratch();
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

// A directory where a writer would remove a file is the real run's decision in the dry run too: the
// warning, no delete row, the directory kept, and the rest of the command still planned and landed.
test("a directory where a writer would remove a file takes the real decision in the dry run: the codex catalog file, a profile's Desktop helper, the retired Desktop helper", async () => {
  const rows: {
    name: string;
    /** Lays the fixture and answers the path the writer would remove. */
    setup: () => Promise<string>;
    warning: (path: string) => string;
    dry: () => Promise<void>;
    real: () => Promise<void>;
    /** A line the plan still prints past the warning. */
    stillPlans: string;
    /** What the real run landed around the kept directory. */
    landed: () => void;
  }[] = [
    {
      name: "codex catalog file, catalog disabled",
      setup: () => Promise.resolve(new CopilotApiPaths().codexModelCatalogFile),
      warning: (path) => `codex model catalog cleanup failed: ${path} is a directory`,
      dry: () => runDryRun(() => Promise.resolve(syncCodexCatalogReference())),
      real: () => Promise.resolve(syncCodexCatalogReference()),
      stillPlans: "DRY RUN: nothing was written.",
      landed: () => {},
    },
    {
      name: "profile del over the profile's Desktop helper",
      setup: async () => {
        await addWork("proxy", WORK_TOKEN);
        return desktopHelperPath(resolveRootHome(), "proxy", WORK);
      },
      warning: (path) => `${path} is a directory; only a file can be removed here`,
      dry: () => delProfile(WORK, true),
      real: () => delProfile(WORK, false),
      stillPlans: `rewrite ${new CopilotApiPaths().stateStoreFile}`,
      landed: () => expect(new CopilotEnvState().profileNames()).toEqual([]),
    },
    {
      name: "init --proxy over the retired Direct helper",
      setup: async () => {
        isolateWithDesktop();
        await addProfile(null, { mode: "proxy" });
        // The proxy wire retires the Direct helper; a directory sits where that script would be.
        return desktopHelperPath(resolveRootHome(), "direct", null);
      },
      warning: (path) => `${path} is a directory; only a file can be removed here; left alone.`,
      dry: () => addProfile(null, { mode: "proxy", dryRun: true }),
      real: () => addProfile(null, { mode: "proxy" }),
      stillPlans: "DRY RUN: nothing was written.",
      // The entry landed regardless: the status inspector judges it wired (a fact consola's repeat
      // throttle cannot hide, unlike a success line printed twice in a row).
      landed: () => {
        const status = claudeDesktopStatus();
        expect(status.kind).toBe("inspected");
        if (status.kind === "inspected") {
          expect(status.entries.map((e) => [e.profile, e.verdict.kind])).toEqual([[null, "wired"]]);
        }
      },
    },
  ];
  for (const row of rows) {
    let path = "";
    await captureChannels(async () => {
      path = await row.setup();
    });
    mkdirSync(path, { recursive: true });
    const warning = row.warning(path);
    const dry = await captureChannels(row.dry);
    expect(dry.stderr, row.name).toContain(warning);
    expect(dry.stdout, row.name).not.toContain(`delete ${path}`);
    expect(dry.stdout, row.name).toContain(row.stillPlans);
    const real = await captureChannels(row.real);
    expect(real.stderr, row.name).toContain(warning);
    expect(lstatSync(path).isDirectory(), row.name).toBe(true);
    row.landed();
  }
});

test("`agent profile mcp --remove --dry-run` names the registration, the deny, and the opt-out key it would take back", async () => {
  const { claudeHome } = scratch();
  storeCredential();
  // A Direct default wiring registers the MCP server and denies the builtin WebSearch.
  await captureChannels(() => addProfile(null, { mode: "direct" }));
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
  // The writer's own mkdir runs in the dry run too, on the overlay, and the tree diff names each
  // directory it made: the plan equals the real run's named set because it is the same code path.
  if (homes !== null) removeDir(homes.dir);
  homes = isolateAgentHomes("copilot-dry-run-fresh-");
  const { claudeHome, codexHome, dir } = homes;
  storeCredential();
  const out = await dryRun(() => addProfile(null, { mode: "direct", dryRun: true }));
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
  await captureChannels(() => addProfile(null, { mode: "direct" }));
  const named = flushWriteReports();
  expect(named).toContain(`created -> ${claudeHome}`);
  expect(named).toContain(`created -> ${codexHome}`);
  expect(existsSync(join(dir, ".claude"))).toBe(true);
});

test("a named `auth --set ' '` over a wired profile refuses the blank token first in both runs: no plan row, nothing touched", async () => {
  await addWork("proxy", WORK_TOKEN);
  const refusal = "the provided GitHub token is empty";
  const auth = (dryRun: boolean) => runAuth({ set: " ", profile: "work", dryRun });
  const before = fingerprint(scratch().dir);
  await expect(captureChannels(() => auth(false))).rejects.toThrow(refusal);
  expect(fingerprint(scratch().dir)).toEqual(before);
  const { stdout } = await captureChannels(async () => {
    await expect(auth(true)).rejects.toThrow(refusal);
  });
  // Refused before anything could be planned: no plan prints at all.
  expect(stdout).toBe("");
  expect(fingerprint(scratch().dir)).toEqual(before);
  expect(new CopilotEnvState().readProfileSlot(WORK).mode).toBe("proxy");
});

/** Claude Desktop present in the scratch HOME and the default slot holding a token. The proxy
 *  wire's model discovery falls back to the Copilot catalog when the daemon is down: the stub
 *  answers every https look and counts it in `discoveries`, anything else (the daemon) is
 *  offline. */
function isolateWithDesktop(): { discoveries: { n: number } } {
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
  return { discoveries };
}

// The status read that follows the wire sees the Desktop state the plan left, as the real run's
// does, so a pre-state the wire corrects costs the dry run no extra discovery.
test("`init --proxy --dry-run` runs Claude Desktop's model discovery once, as the real run does, over a helper chmod'd 0644 and over a helper the static-key shape retires", async () => {
  const { discoveries } = isolateWithDesktop();
  await captureChannels(() => addProfile(null, { mode: "proxy" }));
  const helper = desktopHelperPath(resolveRootHome(), "proxy", null);
  expect(existsSync(helper)).toBe(true);
  const probes = async (body: () => Promise<void>): Promise<number> => {
    discoveries.n = 0;
    await captureChannels(body);
    return discoveries.n;
  };
  const rows: { name: string; prestate: () => void; helperAfterReal: boolean }[] = [
    // The plan heals the mode (the real run's chmod); the later status read sees it healed too.
    {
      name: "helper chmod'd 0644",
      prestate: () => chmodSync(helper, 0o644),
      helperAfterReal: true,
    },
    // The static shape names no helper: the wire plans the script's deletion, and the status read
    // that follows must not find it on disk and call the entry stale (a second discovery).
    {
      name: "static-key claude over the proxy wiring",
      prestate: () => new CopilotEnvConfig().setProfile(null, { "static-key": "claude" }),
      helperAfterReal: false,
    },
  ];
  for (const { name, prestate, helperAfterReal } of rows) {
    prestate();
    const dry = await probes(() => addProfile(null, { mode: "proxy", dryRun: true }));
    expect(existsSync(helper), name).toBe(true);
    prestate();
    const real = await probes(() => addProfile(null, { mode: "proxy" }));
    expect({ name, dry, real, helper: existsSync(helper) }).toEqual({
      name,
      dry: 1,
      real: 1,
      helper: helperAfterReal,
    });
  }
});
