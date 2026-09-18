// `--dry-run` on the remaining writers: each command takes the same path as its real run, records
// every write through the seam, spawns and prompts nothing, and the plan's PATH set equals the
// real run's change set (the tree fingerprinted before and after; the real run is the control
// that proves the assertion can fail). Content equality is test/dry_run.test.ts's business (the
// attribute-level plans); a refusal the real command gives is pinned as the same refusal here.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { errMessage } from "../src/utils/error.ts";
import { applyUpdate, previewUpdate } from "../src/autoupdate/apply.ts";
import { withUpdateLockForTests } from "../src/autoupdate/lock.ts";
import { runAuth, runPrintProxyToken } from "../src/commands/auth.ts";
import { runLaunch } from "../src/commands/launch.ts";
import { launchProxy, resolveProxyToken } from "../src/commands/proxy_token.ts";
import { runSettings } from "../src/commands/settings.ts";
import { runShell } from "../src/commands/setup.ts";
import { runStop } from "../src/commands/stop.ts";
import { CopilotApiConfig } from "../src/copilot_api/config.ts";
import { recordHeartbeat, stopTrackedProxy } from "../src/copilot_api/daemon.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import {
  resetIntegrationIdentityCache,
  setIntegrationProbeFetch,
} from "../src/copilot_api/integration_identity.ts";
import { CopilotApiPaths } from "../src/copilot_api/paths.ts";
import { CopilotEnvRunState } from "../src/copilot_api/state.ts";
import { ATTESTATION_NAME } from "../src/install/attestation.ts";
import {
  applyInstallPlan,
  buildInstallPlan,
  BUNDLED_ONLY_ASSETS,
  currentLinkPath,
  MATERIALIZED_ASSET_DIRS,
  MATERIALIZED_ASSET_FILES,
  pointCurrentAt,
  readCurrentVersionName,
  versionDirName,
} from "../src/install/installer.ts";
import {
  currentReleaseTarget,
  installedBinaryName,
  releaseAssetName,
} from "../src/install/targets.ts";
import { removeEnvKey } from "../src/migrations/4.0.0.ts";
import {
  foldRootStores,
  moveRootDaemonHome,
  renameAutoupdateThrottle,
} from "../src/migrations/4.0.9.ts";
import { runMigrations } from "../src/migrations/index.ts";
import { CI_PS_DOCUMENTS_DIR_ENV, CI_RC_DIR_ENV } from "../src/shell/integration.ts";
import { renderDryRun, textDiffLines } from "../src/utils/dry_run_report.ts";
import * as fs from "../src/utils/fs_facade.ts";
import { pidAlive } from "../src/utils/pid.ts";
import { VERSIONS_DIR } from "../src/utils/root.ts";
import { captureChannels } from "./helpers/output.ts";
import { denoRunArgs, spawnChild } from "./helpers/run.ts";
import { afterEach, expect, removeDir, tempDir, test } from "./helpers/testing.ts";
import {
  changedPaths,
  dryRunChanges,
  envSnapshot,
  fingerprintTree,
  isolateProxyHome,
  resetExitCode,
  until,
  writeRunState,
} from "./helpers.ts";

const skipWin = test.skipIf(process.platform === "win32");
const restoreEnv = envSnapshot([
  CI_RC_DIR_ENV,
  CI_PS_DOCUMENTS_DIR_ENV,
  "COPILOT_ENV_DOWNLOAD_BASE",
  "NVM_DIR",
  "PATH",
  "SHELL",
]);
let dir = "";

afterEach(() => {
  setIntegrationProbeFetch(null);
  resetIntegrationIdentityCache();
  restoreEnv();
  resetExitCode();
  dir = removeDir(dir);
});

/** The plan a body would land, with the tree proven untouched by it. */
async function planOf<T>(root: string, body: () => Promise<T>): Promise<Set<string>> {
  const before = fingerprintTree(root);
  const { changes } = await dryRunChanges(body);
  expect(fingerprintTree(root)).toEqual(before);
  return new Set(changes.map((c) => c.path));
}

/** The paths a real run of `body` changes under `root`. */
async function realChanges(root: string, body: () => Promise<unknown>): Promise<Set<string>> {
  const before = fingerprintTree(root);
  await body();
  return changedPaths(before, fingerprintTree(root));
}

test("shell --dry-run names the rc file with the block it would add, and the real wire changes exactly that file", async () => {
  dir = isolateProxyHome("copilot-dry2-shell-");
  const rcDir = join(dir, "rc");
  mkdirSync(rcDir, { recursive: true });
  process.env[CI_RC_DIR_ENV] = rcDir;
  process.env[CI_PS_DOCUMENTS_DIR_ENV] = rcDir;
  process.env.SHELL = "/bin/bash";
  const { stdout } = await captureChannels(() => Promise.resolve(runShell({ dryRun: true })));
  expect(stdout).toContain("DRY RUN: nothing was written.");
  expect(stdout).toMatch(/^\s+(create|rewrite) .*\n(\s+\+ .*\n)+/m);
  const planned = await planOf(rcDir, () => Promise.resolve(runShell({})));
  const changed = await realChanges(rcDir, () => captureChannels(() => runShell({})));
  expect(changed).toEqual(planned);
});

test("migrate --dry-run: a step's move records and moves nothing; the runner says what it would migrate", async () => {
  dir = isolateProxyHome("copilot-dry2-migrate-");
  const autoupdate = join(dir, "autoupdate");
  mkdirSync(autoupdate, { recursive: true });
  const old = join(autoupdate, "state.json");
  writeFileSync(old, '{"lastCheckMs":1}\n');
  const planned = await planOf(dir, () => Promise.resolve(renameAutoupdateThrottle(autoupdate)));
  expect(planned).toEqual(new Set([old, join(autoupdate, "autoupdate.json")]));
  expect(existsSync(old)).toBe(true);
  // A moved file's text is never the plan's diff: a moved store would print its tokens.
  writeFileSync(old, '{"lastCheckMs":1,"githubToken":"ghu_moved_secret"}\n');
  const { changes } = await dryRunChanges(() =>
    Promise.resolve(renameAutoupdateThrottle(autoupdate))
  );
  const rendered = renderDryRun(changes).join("\n");
  expect(rendered).toContain(`create ${join(autoupdate, "autoupdate.json")}`);
  expect(rendered).not.toContain("ghu_moved_secret");
  writeFileSync(old, '{"lastCheckMs":1}\n');
  const changed = await realChanges(
    dir,
    () => Promise.resolve(renameAutoupdateThrottle(autoupdate)),
  );
  expect(changed).toEqual(planned);

  // A migration's rewrite of a credential-bearing file (an env file, a settings.json with a baked
  // token) renders path-only: neither side of the text may print.
  const envFile = join(dir, "agents.env");
  writeFileSync(envFile, "COPILOT_GITHUB_TOKEN=ghu_env_secret\nOTHER=1\n");
  const { changes: envChanges } = await dryRunChanges(() =>
    Promise.resolve(removeEnvKey(envFile, "COPILOT_GITHUB_TOKEN"))
  );
  const envRendered = renderDryRun(envChanges).join("\n");
  expect(envRendered).toContain(`rewrite ${envFile}`);
  expect(envRendered).not.toContain("ghu_env_secret");
  expect(readFileSync(envFile, "utf8")).toContain("ghu_env_secret");

  const debris = join(dir, "debris");
  writeFileSync(debris, "");
  const { all } = await captureChannels(async () => {
    await dryRunChanges(() =>
      runMigrations("1.0.0", "2.0.0", [{
        version: "1.5.0",
        description: "drops the debris",
        run: () => void fs.rm(debris, { force: true }),
      }])
    );
  });
  expect(all).toContain("Would migrate from 1.5.0: drops the debris");
  expect(all).not.toContain("complete");
  expect(existsSync(debris)).toBe(true);
});

test("a text diff prints the changed lines alone: a line kept between two changed blocks never prints", () => {
  // An rc file fenced in place around an export that neither block owns.
  const before =
    "# copilot-env >>>\nsource a\nexport GH_TOKEN=ghu_between_secret\n# copilot-env launchers >>>\nsource b\n";
  const after =
    "# copilot-env >>>\nsource a\n# <<< copilot-env\nexport GH_TOKEN=ghu_between_secret\n# copilot-env launchers >>>\nsource b\n# <<< copilot-env launchers\n";
  expect(textDiffLines(before, after)).toEqual([
    "+ # <<< copilot-env",
    "+ # <<< copilot-env launchers",
  ]);
  // Removing both blocks leaves that line as the file: the diff is the two removals.
  expect(textDiffLines(after, "export GH_TOKEN=ghu_between_secret\n").join("\n")).not.toContain(
    "ghu_between_secret",
  );
});

test("proxy-token --dry-run takes the start's own preview, prints no key, and plans the API key the resolve would mint", async () => {
  dir = isolateProxyHome("copilot-dry2-token-");
  const launches: string[] = [];
  let printed = 0;
  const deps = {
    proxyUp: () => Promise.resolve(false),
    autoStartEnabled: () => true,
    // In production this is `agent start --dry-run` in process under a dry run (launchProxy).
    launchProxy: () => void launches.push("launched"),
    readAnswer: () => Promise.resolve(""),
    recordHeartbeat: () => {},
    printProxyToken: () => {
      printed++;
      return Promise.resolve();
    },
    notify: () => {},
  };
  // The dry run reaches the start dep like the real run and then proceeds as if the daemon came
  // up: the writes past the start are the plan.
  const { result } = await dryRunChanges(() =>
    resolveProxyToken({ assumeYes: false, profile: null }, deps)
  );
  expect({ result, launches, printed }).toEqual({ result: 0, launches: ["launched"], printed: 1 });
  // The real resolve launches too, and with the daemon still down it reports the failed start.
  const real = await resolveProxyToken({ assumeYes: false, profile: null }, deps);
  expect({ real, launches, printed }).toEqual({
    real: 1,
    launches: ["launched", "launched"],
    printed: 1,
  });
  // Down, unmanaged, interactive: the real command asks; the dry run refuses.
  await expect(
    dryRunChanges(() =>
      resolveProxyToken({ assumeYes: false, profile: null }, {
        ...deps,
        autoStartEnabled: () => false,
      })
    ),
  ).rejects.toThrow("a dry run never prompts");

  // The production start dep under a dry run is `agent start --dry-run` itself. With no
  // credential its gate refuses, as the real child start does on its own stderr: the resolve
  // says so, records the heartbeat the real one records, and takes the same failed-start exit.
  const stateFile = new CopilotApiPaths().stateFile;
  const notes: string[] = [];
  const production = {
    ...deps,
    launchProxy,
    recordHeartbeat,
    notify: (line: string) => void notes.push(line),
  };
  const refusedPlan = await captureChannels(async () => {
    const { changes, result } = await dryRunChanges(() =>
      resolveProxyToken({ assumeYes: false, profile: null }, production)
    );
    expect(result).toBe(1);
    expect(changes.map((c) => c.path)).toContain(stateFile);
  });
  void refusedPlan;
  expect(notes.some((n) => n.includes("cannot start the proxy without a credential"))).toBe(true);
  expect(notes.some((n) => n.startsWith("copilot proxy failed to start"))).toBe(true);
  expect(existsSync(stateFile)).toBe(false);

  // With a credential the start is planned, its port recorded in the plan the way the real start
  // records it (a launcher's wiring reads that port), and nothing spawns.
  new CopilotEnvState().setCredential(null, {
    kind: "stored",
    provider: "gh-token",
    token: "ghu_x",
  });
  // The start resolves the daemon's identity over the network; the stub accepts offline.
  setIntegrationProbeFetch(() =>
    Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }))
  );
  const before = fingerprintTree(dir);
  let plannedPort: unknown;
  const { all } = await captureChannels(async () => {
    const { changes } = await dryRunChanges(() => Promise.resolve(launchProxy(null, "suppressed")));
    const state = changes.find((c) => c.path === stateFile);
    plannedPort = state?.attributes.find((row) => row.key === "port")?.next;
  });
  const narrated = /Would launch the proxy on port (\d+) with the gh-token credential\./.exec(all);
  expect(narrated).not.toBeNull();
  expect(plannedPort).toBe(Number(narrated?.[1]));
  expect(fingerprintTree(dir)).toEqual(before);

  const configFile = new CopilotApiPaths().configFile;
  const { stdout } = await captureChannels(async () => {
    const { changes } = await dryRunChanges(() => Promise.resolve(runPrintProxyToken(null)));
    const rendered = renderDryRun(changes).join("\n");
    expect(rendered).toContain(`create ${configFile}`);
    expect(rendered).toContain("auth.apiKeys  (absent) -> <redacted>");
  });
  expect(stdout).toBe("");
  expect(existsSync(configFile)).toBe(false);
  expect(new CopilotApiConfig().apiKey()).toBeNull();
});

test("a dry run refuses a write handle outside scratch and opens nothing; inside scratch it is the real open", async () => {
  dir = isolateProxyHome("copilot-dry2-handle-");
  const path = join(dir, "stream.bin");
  await expect(dryRunChanges(() => fs.openWritable(path))).rejects.toThrow(
    "a dry run opens no file for writing",
  );
  expect(existsSync(path)).toBe(false);
  const scratch = fs.scratchDir(join(dir, "scratch-"));
  try {
    const inScratch = join(scratch, "download.bin");
    const { result } = await dryRunChanges(() => fs.openWritable(inScratch));
    result.close();
    expect(existsSync(inScratch)).toBe(true);
  } finally {
    fs.removeScratchDir(scratch);
  }
});

test("auth --del --dry-run plans the slot's clearing and keeps the credential", async () => {
  dir = isolateProxyHome("copilot-dry2-del-");
  new CopilotEnvState().setCredential(null, {
    kind: "stored",
    provider: "gh-token",
    token: "ghu_x",
  });
  const before = fingerprintTree(dir);
  const { stdout, stderr } = await captureChannels(() => runAuth({ del: true, dryRun: true }));
  expect(fingerprintTree(dir)).toEqual(before);
  expect(stdout).toContain("profiles.default.githubToken  <redacted> -> (absent)");
  expect(stderr).not.toContain("De-authenticated");
  expect(new CopilotEnvState().readCredential(null).kind).toBe("stored");
  await captureChannels(() => runAuth({ del: true }));
  expect(new CopilotEnvState().readCredential(null).kind).toBe("none");
});

test("settings --export <file> --dry-run names the file it would write, prints no key or token, and writes nothing", async () => {
  dir = isolateProxyHome("copilot-dry2-export-");
  new CopilotEnvState().setCredential(null, {
    kind: "stored",
    provider: "gh-token",
    token: "ghu_x",
  });
  const target = join(dir, "bundle.json");
  const before = fingerprintTree(dir);
  const { stdout } = await captureChannels(() => runSettings({ exportTo: target, dryRun: true }));
  expect(fingerprintTree(dir)).toEqual(before);
  expect(stdout).toContain(`create ${target}`);
  // Neither side of the bundle prints: the file it replaces may hold real tokens.
  expect(stdout).not.toContain("githubToken");
  expect(stdout).not.toContain("ghu_x");
  await captureChannels(() => runSettings({ exportTo: target }));
  expect(existsSync(target)).toBe(true);
  // The control: an earlier export with real tokens on disk, previewed again, prints none of it.
  await captureChannels(() => runSettings({ exportTo: target, withCredentials: true }));
  const { stdout: again } = await captureChannels(() =>
    runSettings({ exportTo: target, dryRun: true })
  );
  expect(again).toContain(`rewrite ${target}`);
  expect(again).not.toContain("ghu_x");
});

test("settings --export into a missing directory fails the dry run with the real export's ENOENT: no parent is invented", async () => {
  dir = isolateProxyHome("copilot-dry2-export-enoent-");
  const target = join(dir, "missing", "bundle.json");
  const enoent = /ENOENT: no such file or directory, open '/;
  await expect(captureChannels(() => runSettings({ exportTo: target }))).rejects.toThrow(enoent);
  await expect(captureChannels(() => runSettings({ exportTo: target, dryRun: true }))).rejects
    .toThrow(enoent);
  expect(existsSync(dirname(target))).toBe(false);
});

/** The message the real run refuses with, so the dry run is held to the OS's own code. */
async function realRefusal(body: () => Promise<unknown>): Promise<string> {
  try {
    await captureChannels(async () => void await body());
  } catch (e) {
    return errMessage(e);
  }
  throw new Error("the real run did not refuse");
}

test("settings --export onto a directory takes the real write's refusal in the dry run, never a planned rewrite", async () => {
  dir = isolateProxyHome("copilot-dry2-export-dir-");
  // The plain export's open: EISDIR on POSIX, EINVAL on Windows; the dry run says what the OS says.
  const openRefusal = await realRefusal(() => runSettings({ exportTo: dir }));
  expect(openRefusal).toMatch(/^E(ISDIR|INVAL): /);
  await expect(captureChannels(() => runSettings({ exportTo: dir, dryRun: true }))).rejects
    .toThrow(openRefusal);
  // The credential export lands by rename: EISDIR on POSIX. Windows reshapes its refusal through
  // the rename retry (RenameRefusedError), a code this test does not pin.
  if (process.platform !== "win32") {
    const args = { exportTo: dir, withCredentials: true };
    const renameRefusal = await realRefusal(() => runSettings(args));
    expect(renameRefusal).toMatch(/^EISDIR: illegal operation on a directory, rename /);
    await expect(captureChannels(() => runSettings({ ...args, dryRun: true }))).rejects.toThrow(
      renameRefusal,
    );
  }
});

// Symlink fixtures: POSIX semantics (a dangling link, a link cycle, a link to a directory), which
// Windows junctions and file links do not reproduce.
skipWin(
  "settings --export through symlinks refuses in the dry run where the real open refuses: dangling, chained, cyclic, and a link to a directory",
  async () => {
    dir = isolateProxyHome("copilot-dry2-export-links-");
    const enoent = /ENOENT: no such file or directory, open '/;
    // A dangling link whose target's parent is missing, and a link to that link: the open follows
    // the chain into the same ENOENT. A dangling DIRECTORY link as the parent is ENOENT too.
    const dangling = join(dir, "dangling.json");
    symlinkSync(join(dir, "missing", "target.json"), dangling);
    const chained = join(dir, "chained.json");
    symlinkSync(dangling, chained);
    const alias = join(dir, "alias");
    symlinkSync(join(dir, "gone"), alias);
    for (const exportTo of [dangling, chained, join(alias, "export.json")]) {
      await expect(captureChannels(() => runSettings({ exportTo }))).rejects.toThrow(enoent);
      await expect(captureChannels(() => runSettings({ exportTo, dryRun: true }))).rejects
        .toThrow(enoent);
    }
    // A link to itself is the open's ELOOP.
    const loop = join(dir, "loop.json");
    symlinkSync(loop, loop);
    const eloop = /ELOOP: too many symbolic links encountered, open '/;
    await expect(captureChannels(() => runSettings({ exportTo: loop }))).rejects.toThrow(eloop);
    await expect(captureChannels(() => runSettings({ exportTo: loop, dryRun: true }))).rejects
      .toThrow(eloop);
    // The credential export mkdirs the parent: over a dangling link that is mkdir's EEXIST.
    const eexist = /EEXIST: file already exists, mkdir '/;
    const under = { exportTo: join(alias, "bundle.json"), withCredentials: true };
    await expect(captureChannels(() => runSettings(under))).rejects.toThrow(eexist);
    await expect(captureChannels(() => runSettings({ ...under, dryRun: true }))).rejects.toThrow(
      eexist,
    );
    expect(existsSync(alias)).toBe(false);
    // A link to a directory: the plain export's open follows it (EISDIR both ways); the credential
    // export's rename replaces the link (a rewrite both ways).
    const linkToDir = join(dir, "link-to-dir");
    symlinkSync(dir, linkToDir);
    const eisdir = /EISDIR: illegal operation on a directory, open '/;
    await expect(captureChannels(() => runSettings({ exportTo: linkToDir }))).rejects.toThrow(
      eisdir,
    );
    await expect(captureChannels(() => runSettings({ exportTo: linkToDir, dryRun: true }))).rejects
      .toThrow(eisdir);
    const credentials = { exportTo: linkToDir, withCredentials: true };
    const { stdout } = await captureChannels(() => runSettings({ ...credentials, dryRun: true }));
    expect(stdout).toContain(`rewrite ${linkToDir}`);
    expect(lstatSync(linkToDir).isSymbolicLink()).toBe(true);
    await captureChannels(() => runSettings(credentials));
    expect(lstatSync(linkToDir).isFile()).toBe(true);
  },
);

test("the seam decides an empty-directory removal alike in both runs: entries refuse it, and the run's own planned removals count", async () => {
  dir = isolateProxyHome("copilot-dry2-rmdir-");
  const full = join(dir, "full");
  mkdirSync(full);
  writeFileSync(join(full, "keep"), "");
  const notEmpty = /ENOTEMPTY: directory not empty, rmdir '/;
  expect(() => fs.rmdir(full)).toThrow(notEmpty);
  await expect(dryRunChanges(() => Promise.resolve(fs.rmdir(full)))).rejects.toThrow(
    notEmpty,
  );
  expect(existsSync(join(full, "keep"))).toBe(true);
  // A link to a populated directory is the entry itself, never what it points at (a Windows
  // junction at `current`): no ENOTEMPTY; rmdir on a POSIX symlink is its own ENOTDIR.
  if (process.platform !== "win32") {
    const link = join(dir, "link");
    symlinkSync(full, link);
    expect(() => fs.rmdir(link)).toThrow(/ENOTDIR/);
  }
  // The 4.0.9 fold removes opencode/github_token and then the emptied directory: the second
  // removal follows from the first, and the tree diff names the directory alone.
  const opencode = join(dir, "opencode");
  mkdirSync(opencode);
  writeFileSync(join(opencode, "github_token"), "ghu_old");
  const { changes } = await dryRunChanges(() => Promise.resolve(foldRootStores(dir)));
  expect(changes.map((c) => [c.path, c.verdict])).toContainEqual([opencode, "delete"]);
  expect(changes.map((c) => c.path)).not.toContain(join(opencode, "github_token"));
  expect(existsSync(join(opencode, "github_token"))).toBe(true);
  // A regular FILE named opencode is user data: readdir's ENOTDIR in both runs, never an "empty
  // directory" swept away.
  const other = isolateProxyHome("copilot-dry2-rmdir-file-");
  writeFileSync(join(other, "opencode"), "user data");
  const notDirRead = /ENOTDIR/;
  await expect(dryRunChanges(() => Promise.resolve(foldRootStores(other)))).rejects.toThrow(
    notDirRead,
  );
  expect(() => foldRootStores(other)).toThrow(notDirRead);
  expect(readFileSync(join(other, "opencode"), "utf8")).toBe("user data");
  removeDir(other);
});

test("the update preview takes the stage's and the flip's own refusals at `current`", async () => {
  dir = isolateProxyHome("copilot-dry2-update-current-");
  const top = join(dir, "install");
  const versionName = versionDirName("v9.9.9");
  mkdirSync(join(top, "versions", versionName), { recursive: true });
  pointCurrentAt(top, versionName);
  const preview = (root: string) =>
    dryRunChanges(() => Promise.resolve(previewUpdate({ tag: "v9.9.9", dateSeconds: 0 }, root)));
  await expect(preview(top)).rejects.toThrow(/refusing to update: .* already points at/);
  // At `current`, the flip's own refusals in the plan and for real: a directory with entries is
  // ENOTEMPTY, a regular file ENOTDIR; an EMPTY stray directory is repaired (removed, then linked),
  // and the plan follows its own removal instead of refusing the link.
  const stray = join(dir, "stray");
  mkdirSync(join(stray, "current"), { recursive: true });
  writeFileSync(join(stray, "current", "unknown"), "");
  const notEmpty = /ENOTEMPTY: directory not empty, rmdir '/;
  await expect(preview(stray)).rejects.toThrow(notEmpty);
  expect(() => pointCurrentAt(stray, versionName)).toThrow(notEmpty);
  const file = join(dir, "file");
  mkdirSync(file, { recursive: true });
  writeFileSync(join(file, "current"), "");
  // rmdir at a regular file is ENOTDIR on every platform (a lookup UNDER a file is where Windows
  // says ENOENT).
  const notDir = /ENOTDIR: not a directory, rmdir '/;
  await expect(preview(file)).rejects.toThrow(notDir);
  expect(() => pointCurrentAt(file, versionName)).toThrow(notDir);
  const repair = join(dir, "repair");
  mkdirSync(join(repair, "current"), { recursive: true });
  const { changes } = await dryRunChanges(() =>
    Promise.resolve(pointCurrentAt(repair, versionName))
  );
  expect(changes.map((c) => [c.path, c.verdict])).toEqual([[join(repair, "current"), "rewrite"]]);
  pointCurrentAt(repair, versionName);
  expect(lstatSync(join(repair, "current")).isSymbolicLink()).toBe(true);
});

test("the 4.0.9 root-daemon move plans the `.run` its own stop lands: a login-only root moves the run state the stop created", async () => {
  dir = isolateProxyHome("copilot-dry2-root-move-");
  const root = join(dir, "root");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "config.json"), "{}\n");
  // The stop's one write under the root (stopTrackedProxy's run-state touch), through the seam.
  const stop = (): Promise<void> => {
    const hostRun = join(root, ".run", "host");
    fs.mkdir(hostRun);
    fs.writeText(join(hostRun, ".state.json"), "{}\n", { atomic: false });
    return Promise.resolve();
  };
  const { changes } = await dryRunChanges(() => moveRootDaemonHome(root, stop, "host"));
  const planned = changes.map((c) => [c.path, c.verdict]);
  // The `.run` the stop makes and the move takes away never touches the disk: no row of its own.
  expect(planned).toContainEqual([join(root, "profiles", "default", ".run"), "create"]);
  expect(planned.map(([path]) => path)).not.toContain(join(root, ".run"));
  expect(existsSync(join(root, ".run"))).toBe(false);
  await moveRootDaemonHome(root, stop, "host");
  expect(existsSync(join(root, "profiles", "default", ".run", "host", ".state.json"))).toBe(true);
  expect(existsSync(join(root, ".run"))).toBe(false);
});

test("stop --dry-run names the daemon it would signal and clears nothing: the tracked process lives on", async () => {
  dir = isolateProxyHome("copilot-dry2-stop-");
  const script = join(dir, "sleeper.ts");
  writeFileSync(script, "setInterval(() => {}, 60_000);\n");
  const child = spawnChild(Deno.execPath(), {
    args: [...denoRunArgs(), script],
    stdout: "null",
    stderr: "null",
  });
  try {
    writeRunState({ pid: child.pid, port: 4141 });
    // The lock is unproven (no daemon.lock), so the classifier decides; "yes" is the real daemon.
    const classify = () => Promise.resolve("yes" as const);
    const before = fingerprintTree(dir);
    const { result, changes } = await dryRunChanges(() => stopTrackedProxy(0, null, classify));
    expect(result).toMatchObject({ trackedPid: child.pid, signalled: true, stopped: true });
    expect(fingerprintTree(dir)).toEqual(before);
    expect(changes.map((c) => c.path)).toContain(new CopilotApiPaths().stateFile);
    expect(new CopilotEnvRunState().read().pid).toBe(child.pid);
    // The command's own dry run, with nothing tracked elsewhere: the plan stands in for the lines.
    const { stdout } = await captureChannels(() => runStop({ dryRun: true }));
    expect(stdout).toContain(`rewrite ${new CopilotApiPaths().stateFile}`);
    expect(stdout).toContain(`pid  ${child.pid} -> (absent)`);
    expect(new CopilotEnvRunState().read().pid).toBe(child.pid);
    expect(pidAlive(child.pid)).toBe(true);
    // The real stop is the control: it signals, and the tracking goes with the process.
    await stopTrackedProxy(0, null, classify);
    await until(() => !pidAlive(child.pid));
    await until(() => new CopilotEnvRunState().read().pid === undefined);
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
    await child.status;
  }
});

skipWin(
  "launch --dry-run lands the wiring's plan and spawns no agent; the real launch spawns it",
  async () => {
    dir = isolateProxyHome("copilot-dry2-launch-");
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    const marker = join(dir, "spawned");
    writeFileSync(join(bin, "codex"), `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
    // The command lookup falls back to nvm's bin dirs; pointed at an empty one, only the PATH's
    // fake codex resolves.
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    process.env.HOME = dir;
    process.env.NVM_DIR = join(dir, "no-nvm");
    const wired = join(dir, "wired.toml");
    const deps = {
      agentMode: () => "proxy" as const,
      ensureProxy: () => Promise.resolve(true),
      wireProxyDefault: () => {
        // Through the seam: the dry run records it, the real launch writes it.
        fs.writeText(wired, "x", { atomic: false });
        return Promise.resolve();
      },
      refreshCodexCatalog: () => Promise.resolve(),
      profileSlot: () => {
        throw new Error("no profile in this launch");
      },
      writeClaudeProfileSettings: () => Promise.reject(new Error("unused")),
      syncProfileWiring: () => Promise.reject(new Error("unused")),
      managedClaudeBaseUrl: () => null,
      codexHome: () => join(dir, ".codex"),
      notify: (line: string) => void notes.push(line),
    };
    const notes: string[] = [];
    const action = { kind: "codex" as const, profile: null, relaxed: false, args: [] as string[] };
    const { stdout } = await captureChannels(() => runLaunch(action, deps, true));
    expect(notes.some((n) => n.startsWith("Would launch codex"))).toBe(true);
    expect(stdout).toContain(`create ${wired}`);
    expect(existsSync(wired)).toBe(false);
    expect(existsSync(marker)).toBe(false);
    // A CLI the machine lacks is refused before anything is prepared, dry or real.
    await expect(
      captureChannels(() => runLaunch({ kind: "copilot", relaxed: false, args: [] }, deps, true)),
    ).rejects.toThrow("'copilot' is not installed");
    await captureChannels(() => runLaunch(action, deps));
    expect(existsSync(wired)).toBe(true);
    expect(existsSync(marker)).toBe(true);
  },
);

skipWin(
  "update --dry-run plans the version root, the current link, and the shims the real update lands",
  async () => {
    dir = tempDir("copilot-dry2-update-");
    const releaseDir = join(dir, "release");
    const installDir = join(dir, "install");
    mkdirSync(releaseDir, { recursive: true });
    mkdirSync(join(installDir, "bin"), { recursive: true });
    process.env.COPILOT_ENV_DOWNLOAD_BASE = releaseDir;
    const target = currentReleaseTarget();
    if (target === null) throw new Error("no release target for this platform");
    const asset = releaseAssetName(target);
    // A release whose binary records its calls and writes the manifest the provision step checks.
    const binary = `#!/bin/sh
HERE="$(dirname "$0")"
echo "$@" >> "$HERE/../../../invocations.log"
if [ "$1" = "install" ]; then
  printf '{"version":"9.9.9","kind":"installed","assets":[]}' > "$HERE/../.copilot-env-install.json"
fi
`;
    writeFileSync(join(releaseDir, asset), binary);
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(binary))),
    ).map((b) => b.toString(16).padStart(2, "0")).join("");
    writeFileSync(join(releaseDir, "checksums.txt"), `${digest}  ${asset}\n`);
    writeFileSync(join(releaseDir, ATTESTATION_NAME), '{"fake":"attestation"}');
    const previous = join(installDir, VERSIONS_DIR, "v9.9.8", "bin");
    mkdirSync(previous, { recursive: true });
    writeFileSync(join(previous, installedBinaryName()), "OLD");
    pointCurrentAt(installDir, "v9.9.8");
    // Two versions back: the GC keeps the new one and its rollback candidate, this one goes.
    const stale = join(installDir, VERSIONS_DIR, "v9.9.7");
    mkdirSync(join(stale, "bin"), { recursive: true });
    // The bootstrap binary a flat install left behind goes too.
    const residue = join(installDir, "bin", installedBinaryName());
    const release = { tag: "v9.9.9", dateSeconds: 0 };
    const quiet = { info: () => {}, warn: (line: string) => void warnings.push(line) };
    const warnings: string[] = [];
    // A directory at the bootstrap binary's name: the sweeper both runs share refuses it, so the
    // preview plans no delete there (a file there is swept below).
    mkdirSync(residue);
    const { changes: withDirectory } = await dryRunChanges(() =>
      Promise.resolve(previewUpdate(release, installDir, quiet))
    );
    expect(withDirectory.map((c) => c.path)).not.toContain(residue);
    rmSync(residue, { recursive: true });
    writeFileSync(residue, "BOOTSTRAP");

    // A directory where a shim goes: the writer both runs share warns and leaves it, so the
    // preview plans no shim there.
    const blocked = join(installDir, "bin", "agent.ps1");
    mkdirSync(blocked, { recursive: true });
    const { changes: withBlocked } = await dryRunChanges(() =>
      Promise.resolve(previewUpdate(release, installDir, quiet))
    );
    expect(withBlocked.map((c) => c.path)).not.toContain(blocked);
    expect(warnings.some((w) => w.startsWith(`Could not refresh the launcher shim ${blocked}`)))
      .toBe(true);
    rmSync(blocked, { recursive: true });
    const { changes: planned } = await dryRunChanges(() =>
      Promise.resolve(previewUpdate(release, installDir, quiet))
    );
    const versionRoot = join(installDir, VERSIONS_DIR, versionDirName("v9.9.9"));
    expect(planned.map((c) => [c.path, c.verdict])).toEqual([
      [versionRoot, "create"],
      [currentLinkPath(installDir), "rewrite"],
      [join(installDir, "bin", "agent"), "create"],
      [join(installDir, "bin", "agent.ps1"), "create"],
      [stale, "delete"],
      [residue, "delete"],
    ]);
    const before = fingerprintTree(installDir);
    await withUpdateLockForTests(join(dir, "update.lock"), Date.now(), (outcome) => {
      if (!outcome.held) throw new Error("test could not take its own update lock");
      return applyUpdate("v9.9.8", release, outcome, {
        root: installDir,
        logger: { info: () => {}, warn: () => {}, success: () => {} },
        childStdoutToStderr: true,
        provenance: { kind: "verify", verifier: () => Promise.resolve({ signerIdentity: "test" }) },
      });
    });
    expect(readCurrentVersionName(installDir)).toBe("v9.9.9");
    // Every planned path changed, and every change sits at or under a planned path; the fake
    // binary's own log is the one write the plan could not know.
    const changed = [...changedPaths(before, fingerprintTree(installDir))]
      .filter((p) => p !== join(installDir, "invocations.log"));
    const plannedPaths = planned.map((c) => c.path);
    for (const p of plannedPaths) expect(changed).toContain(p);
    for (const p of changed) {
      expect(plannedPaths.some((q) => p === q || p.startsWith(`${q}/`)), p).toBe(true);
    }
  },
);

test("install --dry-run plans every runtime file, shim, and the current link the real install writes", async () => {
  dir = tempDir("copilot-dry2-install-");
  const source = join(dir, "vfs");
  const dest = join(dir, "install");
  const rc = join(dir, "rc");
  for (const d of [source, dest, rc]) mkdirSync(d, { recursive: true });
  process.env[CI_RC_DIR_ENV] = rc;
  process.env[CI_PS_DOCUMENTS_DIR_ENV] = rc;
  for (const assetDir of MATERIALIZED_ASSET_DIRS) {
    mkdirSync(join(source, assetDir), { recursive: true });
    writeFileSync(join(source, assetDir, "payload.txt"), `content of ${assetDir}`);
  }
  mkdirSync(join(source, "src", "scripts"), { recursive: true });
  writeFileSync(join(source, "src", "scripts", "example.sh"), "#!/bin/sh\n");
  for (const file of [...MATERIALIZED_ASSET_FILES, ...BUNDLED_ONLY_ASSETS]) {
    mkdirSync(dirname(join(source, file)), { recursive: true });
    writeFileSync(join(source, file), `content of ${file}`);
  }
  const bootstrap = join(dir, "bootstrap", installedBinaryName());
  mkdirSync(dirname(bootstrap), { recursive: true });
  writeFileSync(bootstrap, "#!/bin/sh\nexit 0\n");
  const options = { noShellIntegration: true, allHosts: false, assetsOnly: false };
  const plan = buildInstallPlan(options, dest, source, bootstrap);
  const planned = await planOf(dest, () => Promise.resolve(applyInstallPlan(plan)));
  const changed = await realChanges(dest, () => Promise.resolve(applyInstallPlan(plan)));
  expect(changed).toEqual(planned);
  expect(readFileSync(join(dest, "current", MATERIALIZED_ASSET_FILES[0]), "utf8")).toBe(
    `content of ${MATERIALIZED_ASSET_FILES[0]}`,
  );
});
