import { afterEach, beforeEach, describe } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { PROXY_CACHE_FIXTURE } from "../../scripts/warm-proxy-cache.ts";
import { directHelperCommand } from "../../src/claude/config.ts";
import { registryEntry } from "../../src/copilot_api/config_registry.ts";
import { acquireDaemonLockForLife, daemonLockPath } from "../../src/copilot_api/daemon_lock.ts";
import { CopilotEnvConfig } from "../../src/copilot_api/env_config.ts";
import { allDaemonHomes, CopilotApiPaths } from "../../src/copilot_api/paths.ts";
import {
  BUN_CLI_ENV,
  copilotApiArgv,
  resolveCopilotApiEntry,
} from "../../src/copilot_api/process.ts";
import { DAEMON_SHIM_DEPENDENCIES } from "../../src/copilot_api/shims.ts";
import { installedProxyPackage, PROXY_PACKAGE_NAME } from "../../src/copilot_api/version.ts";
import {
  daemonBunfigFile,
  ensureShimDependencies,
  type FetchLike,
  floatedProxyEntry,
  floatProxy,
  type InstallRunner,
  parseRegistryDoc,
  proxyBunCacheDir,
  proxyFloatSkips,
  proxyFloatVerifyStatus,
  proxyHome,
  proxyInstallDir,
  proxyLockFile,
  proxyManifestFile,
  readResolvedVersionRecord,
  removeProxyFloatArtifacts,
  renderProxyManifest,
  resolvedVersionFile,
  resolveMinimumReleaseAgeSeconds,
  resolveProxyVersionOverride,
  selectProxyVersion,
  writeResolvedVersionRecord,
} from "../../src/proxy_float.ts";
import { releaseFileLock } from "../../src/utils/file_lock.ts";
import type { ProjectConfig } from "../../src/utils/project_config.ts";
import { MILLISECONDS_PER_DAY } from "../../src/utils/time.ts";
import { plantProxyInstall } from "../helpers/daemon.ts";
import { envSnapshot, isolateProxyHome } from "../helpers/env.ts";
import { captureAllWrites } from "../helpers/output.ts";
import {
  docFetch,
  fakeInstall,
  installCalls,
  NOW_MS,
  registryDoc,
} from "../helpers/proxy_float.ts";
import { ROOT, runSync } from "../helpers/run.ts";
import { expect, removeDir, test } from "../helpers/testing.ts";

// resolved-version.json records each float; it is the freshness oracle that
// proxyFloatVerifyStatus's offline fast path reads.

const PROXY_PKG = PROXY_PACKAGE_NAME;
const WEEK_SECONDS = 604800;

const CONFIG: ProjectConfig = { proxyMinVersion: "1.10.0", proxyMaxVersion: null };

const MIN_RELEASE_AGE_ENV = "COPILOT_API_MIN_RELEASE_AGE";
const VERSION_ENV = "COPILOT_API_VERSION";
const ENTRY_ENV = "COPILOT_API_ENTRY";

let dir = "";
const restoreEnv = envSnapshot([MIN_RELEASE_AGE_ENV, VERSION_ENV, ENTRY_ENV]);

function offlineFetch(): { calls: string[]; fetchLike: FetchLike } {
  const calls: string[] = [];
  return {
    calls,
    fetchLike: (url) => {
      calls.push(url);
      return Promise.reject(new Error("offline"));
    },
  };
}

/** The artifact set a COMPLETED prior float of `version` leaves behind: the record and the
 *  install tree under this build's manifest. */
function seedFloat(version: string, atMs: number): void {
  writeResolvedVersionRecord(dir, version, atMs);
  plantProxyInstall(dir, version);
}

/** The install tree as the daemon would read it: the proxy's manifest version, or null. */
function installedVersion(): string | null {
  return installedProxyPackage(proxyInstallDir(dir))?.version ?? null;
}

/** No stage or retired tree left in the proxy home: an attempt that did not complete leaves
 *  nothing but what was there. */
function expectNoDebris(): void {
  expect(
    readdirSync(proxyHome(dir))
      .filter((name) => name.startsWith("install."))
      .sort(),
  ).toEqual([]);
}

/** The proxy version the manifest on disk names after a float. */
function manifestProxyVersion(): string | undefined {
  const manifest = JSON.parse(readFileSync(proxyManifestFile(dir), "utf8")) as {
    dependencies: Record<string, string>;
  };
  return manifest.dependencies[PROXY_PKG];
}

function deps(fetchLike: FetchLike, runner: InstallRunner, cooldownSeconds?: number) {
  return {
    rootHome: dir,
    config: CONFIG,
    cooldownSeconds: cooldownSeconds,
    fetchLike: fetchLike,
    runner: runner,
    nowMs: NOW_MS,
  };
}

beforeEach(() => {
  dir = isolateProxyHome("copilot-float-");
  delete process.env[MIN_RELEASE_AGE_ENV];
  delete process.env[VERSION_ENV];
  delete process.env[ENTRY_ENV];
});

afterEach(() => {
  restoreEnv();
});

// One registry document, one window, one cooldown -> one selection. The reason fragment
// names the branch taken, so a clamp that answers the right version for the wrong reason
// (or the floor reached by fallback instead of by clamp) still fails its row.

/** A floor above CONFIG's, so the clamp rows have an aged release below it to clamp up from. */
const FLOOR_30: ProjectConfig = { proxyMinVersion: "1.10.30", proxyMaxVersion: null };

/** (registry document, window, cooldown) -> the selection and the reason fragment naming its branch. */
const SELECTION_ROWS: {
  name: string;
  doc: unknown;
  config: ProjectConfig;
  cooldownSeconds: number;
  expected: Record<string, unknown>;
}[] = [
  {
    name: "the newest cooldown-aged release inside the window",
    doc: registryDoc({ "1.10.29": 30, "1.10.30": 8, "1.10.31": 1 }),
    config: CONFIG,
    cooldownSeconds: WEEK_SECONDS,
    expected: {
      kind: "resolved",
      version: "1.10.30",
      publishedAtMs: NOW_MS - 8 * MILLISECONDS_PER_DAY,
      reason: expect.stringContaining("latest >=7 days old release 1.10.30"),
    },
  },
  {
    name: "cooldown 0 selects the newest release",
    doc: registryDoc({ "1.10.30": 8, "1.10.31": 1 }),
    config: CONFIG,
    cooldownSeconds: 0,
    expected: {
      kind: "resolved",
      version: "1.10.31",
      publishedAtMs: NOW_MS - MILLISECONDS_PER_DAY,
      reason: expect.stringContaining("release 1.10.31"),
    },
  },
  {
    name: "an aged release below the floor clamps UP to the floor",
    doc: registryDoc({ "1.10.29": 8, "1.10.30": 1 }),
    config: FLOOR_30,
    cooldownSeconds: WEEK_SECONDS,
    expected: {
      kind: "resolved",
      version: "1.10.30",
      publishedAtMs: NOW_MS - MILLISECONDS_PER_DAY,
      reason: expect.stringContaining("1.10.29 < floor 1.10.30"),
    },
  },
  {
    name: "an aged release AT the floor is not a clamp",
    doc: registryDoc({ "1.10.29": 8, "1.10.30": 8 }),
    config: FLOOR_30,
    cooldownSeconds: WEEK_SECONDS,
    expected: {
      kind: "resolved",
      version: "1.10.30",
      publishedAtMs: NOW_MS - 8 * MILLISECONDS_PER_DAY,
      reason: expect.stringContaining("latest >=7 days old release 1.10.30"),
    },
  },
  {
    name: "an aged release above the ceiling clamps DOWN to the ceiling",
    doc: registryDoc({ "1.10.29": 8, "1.10.30": 8 }),
    config: { proxyMinVersion: "1.10.0", proxyMaxVersion: "1.10.29" },
    cooldownSeconds: WEEK_SECONDS,
    expected: {
      kind: "resolved",
      version: "1.10.29",
      publishedAtMs: NOW_MS - 8 * MILLISECONDS_PER_DAY,
      reason: expect.stringContaining("1.10.30 > ceiling 1.10.29"),
    },
  },
  {
    name: "the only aged release is the floor itself",
    doc: registryDoc({ "1.10.0": 200, "1.10.31": 1 }),
    config: CONFIG,
    cooldownSeconds: WEEK_SECONDS,
    expected: {
      kind: "resolved",
      version: "1.10.0",
      publishedAtMs: NOW_MS - 200 * MILLISECONDS_PER_DAY,
      reason: expect.stringContaining("latest >=7 days old release 1.10.0"),
    },
  },
  {
    name: "no aged release at all falls back to the floor",
    doc: registryDoc({ "1.10.0": 1, "1.10.31": 1 }),
    config: CONFIG,
    cooldownSeconds: WEEK_SECONDS,
    expected: {
      kind: "resolved",
      version: "1.10.0",
      publishedAtMs: NOW_MS - MILLISECONDS_PER_DAY,
      reason: expect.stringContaining("no 7 days old release -> floor 1.10.0"),
    },
  },
  {
    name: "a floor that is not published is unavailable, never trusted blind",
    doc: registryDoc({ "1.10.31": 1 }),
    config: CONFIG,
    cooldownSeconds: WEEK_SECONDS,
    expected: { kind: "unavailable", reason: expect.stringContaining("1.10.0") },
  },
  {
    name: "a target declaring lifecycle scripts is refused, naming them",
    doc: registryDoc({ "1.10.30": 8 }, { scripts: { "1.10.30": ["postinstall"] } }),
    config: CONFIG,
    cooldownSeconds: WEEK_SECONDS,
    expected: {
      kind: "refused",
      version: "1.10.30",
      lifecycleScripts: ["postinstall"],
      reason: expect.stringContaining("1.10.30"),
    },
  },
  {
    name: "the hasInstallScript flag alone also refuses",
    doc: registryDoc({ "1.10.30": 8 }, { hasInstallScript: ["1.10.30"] }),
    config: CONFIG,
    cooldownSeconds: WEEK_SECONDS,
    expected: {
      kind: "refused",
      version: "1.10.30",
      lifecycleScripts: ["install"],
      reason: expect.stringContaining("1.10.30"),
    },
  },
];

describe("selectProxyVersion", () => {
  test("registry ages, window, and cooldown decide the target and the reason it was picked", () => {
    for (const row of SELECTION_ROWS) {
      const sel = selectProxyVersion(
        parseRegistryDoc(row.doc),
        row.config,
        row.cooldownSeconds,
        NOW_MS,
      );
      expect({ name: row.name, ...sel }).toEqual({ name: row.name, ...row.expected });
    }
  });
});

describe("parseRegistryDoc", () => {
  // A document malformed at the top is rejected whole; a single version with an unparseable
  // publish time is dropped, never given an age it does not have.
  test("malformed documents throw, an unparseable publish time drops that release", () => {
    for (const raw of [{ versions: "nope" }, null]) {
      expect(() => parseRegistryDoc(raw), JSON.stringify(raw)).toThrow("expected shape");
    }
    const raw = registryDoc({ "1.10.30": 8 }) as { time: Record<string, string> };
    raw.time["1.10.30"] = "not-a-date";
    expect(parseRegistryDoc(raw).releases.has("1.10.30")).toBe(false);
  });
});

describe("resolveMinimumReleaseAgeSeconds", () => {
  // env override > stored config > built-in default; a non-numeric override is refused, never
  // read as zero.
  test("the env override wins over the stored cooldown, which wins over the default", () => {
    // The default is spelled twice, in the preference registry and in bunfig.toml's [install]
    // minimumReleaseAge (the floor `bun install` itself applies): both must read as the same
    // number, else `agent config` would describe one cooldown and the float apply another.
    const bunfig = parseToml(readFileSync(join(ROOT, "bunfig.toml"), "utf8")) as {
      install: { minimumReleaseAge: number };
    };
    expect(resolveMinimumReleaseAgeSeconds()).toBe(bunfig.install.minimumReleaseAge);
    expect(registryEntry("daemon.release-cooldown").defaultValue).toBe(
      bunfig.install.minimumReleaseAge,
    );
    new CopilotEnvConfig().set({ "daemon.release-cooldown": 172800 });
    expect(resolveMinimumReleaseAgeSeconds()).toBe(172800);
    for (const [env, seconds] of [
      ["100", 100],
      ["0", 0],
    ] as const) {
      process.env[MIN_RELEASE_AGE_ENV] = env;
      expect(resolveMinimumReleaseAgeSeconds()).toBe(seconds);
    }
    process.env[MIN_RELEASE_AGE_ENV] = "abc";
    expect(() => resolveMinimumReleaseAgeSeconds()).toThrow("whole number of seconds");
  });

  // An unreadable store must FAIL the pin and cooldown reads: silently reading "no pin" would
  // float past a supply-chain pin.
  //   env override set  -> wins first; the store is never consulted
  //   Windows, root     -> skipped: chmod 000 does not deny the read there
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "an unreadable prefs store fails the version-pin and cooldown reads; the env override still wins first",
    () => {
      new CopilotEnvConfig().set({ "daemon.release-cooldown": 60, "daemon.version": "1.2.3" });
      const file = new CopilotApiPaths().stateStoreFile;
      chmodSync(file, 0o000);
      try {
        expect(() => resolveProxyVersionOverride()).toThrow(file);
        expect(() => resolveMinimumReleaseAgeSeconds()).toThrow(file);
        process.env[MIN_RELEASE_AGE_ENV] = "0";
        expect(resolveMinimumReleaseAgeSeconds()).toBe(0);
      } finally {
        delete process.env[MIN_RELEASE_AGE_ENV];
        chmodSync(file, 0o600);
      }
      // Control: readable again, the stored pin and cooldown answer.
      expect(resolveProxyVersionOverride()).toBe("1.2.3");
      expect(resolveMinimumReleaseAgeSeconds()).toBe(60);
    },
  );
});

// --- floatProxy ---------------------------------------------------------------------------------
//
// The install is bun's own, so what the float controls is what it writes and how it runs it:
// the manifest naming the exact target plus the shims' dependencies, the bunfig carrying the
// cooldown, the cache pinned under the root home, the bun CLI environment.
test("installs the exact newest cooldown-aged target from a manifest and bunfig it writes, and records it", async () => {
  const { fetchLike } = docFetch(registryDoc({ "1.10.30": 8, "1.10.31": 1 }));
  const install = fakeInstall();

  await floatProxy(deps(fetchLike, install.runner, WEEK_SECONDS));

  expect(install.calls).toEqual([
    {
      // A first install has no lockfile to freeze: bun resolves and writes it, in the stage.
      args: ["install"],
      cwd: join(proxyHome(dir), "install.next"),
      env: { ...BUN_CLI_ENV, BUN_INSTALL_CACHE_DIR: join(proxyBunCacheDir(dir), "1.10.30") },
    },
  ]);
  // The manifest: the proxy at the EXACT version, and every shim dependency at this build's
  // range (the checkout's package.json), nothing else.
  const checkout = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  const manifest = JSON.parse(readFileSync(proxyManifestFile(dir), "utf8"));
  expect(manifest).toEqual({
    name: "copilot-env-proxy",
    private: true,
    dependencies: {
      [PROXY_PKG]: "1.10.30",
      ...Object.fromEntries(
        DAEMON_SHIM_DEPENDENCIES.map((name) => [name, checkout.dependencies[name]]),
      ),
    },
  });
  // The bunfig: the cooldown as bun's own floor, so the transitive tree gets the window too,
  // and no auto-install for a daemon started from this cwd.
  expect(parseToml(readFileSync(daemonBunfigFile(dir), "utf8"))).toEqual({
    install: { auto: "disable", minimumReleaseAge: WEEK_SECONDS },
  });

  expect(readResolvedVersionRecord(dir)).toEqual({ version: "1.10.30", resolvedAtMs: NOW_MS });
  // The on-disk keys are the external contract.
  const raw = JSON.parse(readFileSync(resolvedVersionFile(dir), "utf8"));
  expect(Object.keys(raw).sort()).toEqual(["resolved_at_ms", "version"]);
});

test("skips the install when the recorded target is already installed, refreshing the record", async () => {
  seedFloat("1.10.30", NOW_MS - 30 * MILLISECONDS_PER_DAY);
  const { fetchLike } = docFetch(registryDoc({ "1.10.30": 8, "1.10.31": 1 }));
  const install = fakeInstall();

  await floatProxy(deps(fetchLike, install.runner, WEEK_SECONDS));

  expect(install.calls).toEqual([]);
  // The record's timestamp refreshes so proxyFloatVerifyStatus stays on its offline fast path.
  expect(readResolvedVersionRecord(dir)?.resolvedAtMs).toBe(NOW_MS);
});

// Three re-installs of the recorded version, told apart by what the lockfile may do:
//   node_modules gone, manifest and lock intact  -> frozen: restored from the lock, no pin moves
//   a shim dependency gone                       -> frozen too: the manifest is still this build's
//   the manifest from another build              -> a fresh resolve; the lock follows
test("a reinstall of the recorded version is frozen while the manifest is this build's", async () => {
  const { fetchLike } = docFetch(registryDoc({ "1.10.30": 8 }));
  const rows: { name: string; damage: () => void; args: string[] }[] = [
    {
      name: "node_modules gone",
      damage: () => rmSync(join(proxyInstallDir(dir), "node_modules"), { recursive: true }),
      args: ["install", "--frozen-lockfile"],
    },
    {
      name: "a shim dependency gone",
      damage: () =>
        rmSync(join(proxyInstallDir(dir), "node_modules", "valibot"), { recursive: true }),
      args: ["install", "--frozen-lockfile"],
    },
    {
      name: "another build's manifest",
      damage: () =>
        writeFileSync(
          proxyManifestFile(dir),
          renderProxyManifest("1.10.30", {
            ...JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).dependencies,
            valibot: "^0.1.0",
          }),
        ),
      args: ["install"],
    },
  ];
  for (const row of rows) {
    dir = removeDir(dir);
    dir = isolateProxyHome("copilot-float-");
    seedFloat("1.10.30", NOW_MS);
    row.damage();
    const install = fakeInstall();
    await floatProxy(deps(fetchLike, install.runner, WEEK_SECONDS));
    expect({ name: row.name, calls: installCalls(install.calls).map((c) => c.args) }).toEqual({
      name: row.name,
      calls: [row.args],
    });
    expect(manifestProxyVersion(), row.name).toBe("1.10.30");
    expect(readResolvedVersionRecord(dir)?.resolvedAtMs, row.name).toBe(NOW_MS);
  }
});

// The bug this pins: the manifest for B was written before bun ran and stayed when bun failed,
// so the next attempt read B as current and froze the lockfile resolved from A (which bun
// rejects for good), and the still-installed A no longer read as usable.
test("a failed version change leaves the installed version usable and the retry unfrozen", async () => {
  seedFloat("1.10.29", NOW_MS - 30 * MILLISECONDS_PER_DAY);
  const lockBefore = readFileSync(proxyLockFile(dir), "utf8");
  const { fetchLike } = docFetch(registryDoc({ "1.10.29": 40, "1.10.30": 8 }));
  const install = fakeInstall({ failFirst: true });

  // The failed update keeps A: the record, and the home still describing A's install.
  await floatProxy(deps(fetchLike, install.runner, WEEK_SECONDS));
  expect(readResolvedVersionRecord(dir)?.version).toBe("1.10.29");
  expect(manifestProxyVersion()).toBe("1.10.29");
  expect(readFileSync(proxyLockFile(dir), "utf8")).toBe(lockBefore);

  // The retry resolves afresh (never frozen against A's lock) and lands B.
  await floatProxy(deps(fetchLike, install.runner, WEEK_SECONDS));
  expect(installCalls(install.calls).map((c) => c.args)).toEqual([["install"], ["install"]]);
  expect(readResolvedVersionRecord(dir)?.version).toBe("1.10.30");
  expect(manifestProxyVersion()).toBe("1.10.30");
});

test("a version change resolves afresh and drops the superseded version's cache", async () => {
  seedFloat("1.10.29", NOW_MS - 30 * MILLISECONDS_PER_DAY);
  // One cache per installed version: the superseded one goes once the new install completed.
  const staleTarball = join(proxyBunCacheDir(dir), "1.10.29", "old.tgz");
  mkdirSync(join(proxyBunCacheDir(dir), "1.10.29"), { recursive: true });
  writeFileSync(staleTarball, "");
  const { fetchLike } = docFetch(registryDoc({ "1.10.29": 40, "1.10.30": 8 }));
  const install = fakeInstall();

  await floatProxy(deps(fetchLike, install.runner, WEEK_SECONDS));

  // Never frozen: the manifest changed, so the lock must follow it; the install ran in the
  // stage, against its own version's cache.
  expect(installCalls(install.calls).map((c) => c.args)).toEqual([["install"]]);
  expect(install.calls[0]?.cwd).toBe(join(proxyHome(dir), "install.next"));
  expect(install.calls[0]?.env.BUN_INSTALL_CACHE_DIR).toBe(join(proxyBunCacheDir(dir), "1.10.30"));
  expect(manifestProxyVersion()).toBe("1.10.30");
  expect(installedVersion()).toBe("1.10.30");
  expect(existsSync(staleTarball)).toBe(false);
  expect(readResolvedVersionRecord(dir)?.version).toBe("1.10.30");
  expectNoDebris();
});

// The transaction's other two failure arms. The install is built beside the tree in place and
// swapped in only once it passed the readers' own verification, so a bun that reports success
// over an incomplete tree, or a write that fails before bun ran, leaves the previous version
// exactly as it was, runnable, with no stage behind and nothing for the next attempt to freeze
// against but the manifest the tree in place was resolved from.
test("an install bun calls done but incomplete, or a stage that cannot be written, is never swapped in", async () => {
  const { fetchLike } = docFetch(registryDoc({ "1.10.29": 40, "1.10.30": 8 }));
  seedFloat("1.10.29", NOW_MS - 30 * MILLISECONDS_PER_DAY);
  const incomplete = fakeInstall({ incomplete: true });
  await floatProxy(deps(fetchLike, incomplete.runner, WEEK_SECONDS));
  expect(installCalls(incomplete.calls)).toHaveLength(1);
  expect(installedVersion()).toBe("1.10.29");
  expect(readResolvedVersionRecord(dir)?.version).toBe("1.10.29");
  expectNoDebris();
  // The retry is a fresh resolve, never frozen against the tree in place.
  const complete = fakeInstall();
  await floatProxy(deps(fetchLike, complete.runner, WEEK_SECONDS));
  expect(installCalls(complete.calls).map((c) => c.args)).toEqual([["install"]]);
  expect(installedVersion()).toBe("1.10.30");

  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    // A superseded cache the OS will not remove: the install already completed, so the record
    // moves with it and the cache is left, named.
    dir = removeDir(dir);
    dir = isolateProxyHome("copilot-float-");
    seedFloat("1.10.29", NOW_MS - 30 * MILLISECONDS_PER_DAY);
    const heldCache = join(proxyBunCacheDir(dir), "1.10.29");
    mkdirSync(heldCache, { recursive: true });
    writeFileSync(join(heldCache, "old.tgz"), "");
    chmodSync(heldCache, 0o500);
    try {
      await floatProxy(deps(fetchLike, fakeInstall().runner, WEEK_SECONDS));
    } finally {
      chmodSync(heldCache, 0o700);
    }
    expect(installedVersion()).toBe("1.10.30");
    expect(readResolvedVersionRecord(dir)?.version).toBe("1.10.30");
    expect(existsSync(join(heldCache, "old.tgz"))).toBe(true);

    // A proxy home that refuses the stage: the write fails before bun ever runs.
    dir = removeDir(dir);
    dir = isolateProxyHome("copilot-float-");
    seedFloat("1.10.29", NOW_MS - 30 * MILLISECONDS_PER_DAY);
    chmodSync(proxyHome(dir), 0o500);
    try {
      const refused = fakeInstall();
      await floatProxy(deps(fetchLike, refused.runner, WEEK_SECONDS));
      expect(refused.calls).toEqual([]);
    } finally {
      chmodSync(proxyHome(dir), 0o700);
    }
    expect(installedVersion()).toBe("1.10.29");
    expect(readResolvedVersionRecord(dir)?.version).toBe("1.10.29");
    expectNoDebris();
  }
});

// A float that died between the swap's two renames left the complete previous tree aside as
// install.prev and nothing at install: the next float puts it back before judging anything, so
// an up-to-date tree installs nothing again, and a refusal that never installs still finds it.
test("a swap interrupted between its renames is put back before the float judges the tree", async () => {
  seedFloat("1.10.29", NOW_MS - 30 * MILLISECONDS_PER_DAY);
  renameSync(proxyInstallDir(dir), join(proxyHome(dir), "install.prev"));
  mkdirSync(join(proxyHome(dir), "install.next"));
  const { fetchLike } = docFetch(registryDoc({ "1.10.29": 40 }));
  const install = fakeInstall();

  await floatProxy(deps(fetchLike, install.runner, WEEK_SECONDS));

  expect(install.calls).toEqual([]);
  expect(installedVersion()).toBe("1.10.29");
  expect(readResolvedVersionRecord(dir)?.version).toBe("1.10.29");
  expectNoDebris();
});

// The install tree is the one truth for the version that runs; the record follows it. A record
// that cannot be written (here, a directory in its place) after the swap leaves the new tree
// as the entry, the retired tree beside it, and a warning naming the record; the next float
// entry, offline here so the registry plays no part, writes the record from the tree (its
// resolution time unknown, so the next verify look re-checks), keeps that version through the
// offline arm instead of installing the floor, and sweeps the retired tree.
test("a record the swap could not write never hides the installed tree, and the next float writes it", async () => {
  seedFloat("1.10.29", NOW_MS - 30 * MILLISECONDS_PER_DAY);
  const { fetchLike } = docFetch(registryDoc({ "1.10.29": 40, "1.10.30": 8 }));
  rmSync(resolvedVersionFile(dir));
  mkdirSync(resolvedVersionFile(dir));
  const install = fakeInstall();
  const said = await captureAllWrites(() =>
    floatProxy(deps(fetchLike, install.runner, WEEK_SECONDS)),
  );
  expect(said).toContain(`could not write ${resolvedVersionFile(dir)}`);
  expect(installCalls(install.calls)).toHaveLength(1);
  expect(installedVersion()).toBe("1.10.30");
  expect(floatedProxyEntry(dir)?.version).toBe("1.10.30");
  expect(existsSync(join(proxyHome(dir), "install.prev"))).toBe(true);

  rmSync(resolvedVersionFile(dir), { recursive: true });
  const again = fakeInstall();
  await floatProxy(deps(offlineFetch().fetchLike, again.runner, WEEK_SECONDS));
  expect(again.calls).toEqual([]);
  expect(readResolvedVersionRecord(dir)).toEqual({ version: "1.10.30", resolvedAtMs: 0 });
  expectNoDebris();
});

// A float that died after the swap's second rename and before the record: the new tree is in
// place, the retired one beside it, the record still naming the old version. The tree is the
// entry at once, and the next float entry (here offline, so the registry plays no part) sweeps
// the retired tree and rewrites the record from the tree, keeping its resolution time.
test("a crash after the swap leaves the installed tree as the entry, and the next entry rewrites the record from it", async () => {
  seedFloat("1.10.29", NOW_MS - 30 * MILLISECONDS_PER_DAY);
  renameSync(proxyInstallDir(dir), join(proxyHome(dir), "install.prev"));
  plantProxyInstall(dir, "1.10.30");
  expect(floatedProxyEntry(dir)?.version).toBe("1.10.30");
  expect(readResolvedVersionRecord(dir)?.version).toBe("1.10.29");

  // A retired tree the OS will not remove (POSIX, non-root: a directory without write permission)
  // never stands between the tree and its record: the record is rewritten, the debris named.
  const posix = process.platform !== "win32" && process.getuid?.() !== 0;
  if (posix) chmodSync(join(proxyHome(dir), "install.prev"), 0o500);
  const install = fakeInstall();
  try {
    await floatProxy(deps(offlineFetch().fetchLike, install.runner, WEEK_SECONDS));
  } finally {
    if (posix) chmodSync(join(proxyHome(dir), "install.prev"), 0o700);
  }
  expect(install.calls).toEqual([]);
  expect(readResolvedVersionRecord(dir)).toEqual({
    version: "1.10.30",
    resolvedAtMs: NOW_MS - 30 * MILLISECONDS_PER_DAY,
  });
  expect(installedVersion()).toBe("1.10.30");
  if (posix) {
    expect(existsSync(join(proxyHome(dir), "install.prev"))).toBe(true);
    await floatProxy(deps(offlineFetch().fetchLike, install.runner, WEEK_SECONDS));
    expect(install.calls).toEqual([]);
  }
  expectNoDebris();
});

// A daemon still running from the tree in place (its home's daemon.lock held, here by the test
// process) would import from the new tree on POSIX, and on Windows the rename under its open
// handles fails: the new tree is built and verified, and not swapped in until the daemon is
// gone. The float's own rule, not the start order's: `agent start` runs the gate before it
// stops daemons and once more after, so a replacing start lands the update in that start.
test("a running daemon of this root home keeps the swap off until it is stopped", async () => {
  seedFloat("1.10.29", NOW_MS - 30 * MILLISECONDS_PER_DAY);
  const { fetchLike } = docFetch(registryDoc({ "1.10.29": 40, "1.10.30": 8 }));
  const home = allDaemonHomes()[0] as string;
  mkdirSync(home, { recursive: true });
  expect(acquireDaemonLockForLife(home, { waitMs: 0 })).toBe(true);
  try {
    const install = fakeInstall();
    // The refusal in the scannable shape, unwrapped (a tmp path as evidence has no fixed
    // width): the holder is evidence, the two steps are the commands.
    const said = await captureAllWrites(() =>
      floatProxy(deps(fetchLike, install.runner, WEEK_SECONDS)),
    );
    expect(installCalls(install.calls)).toHaveLength(1);
    expect(said).toContain(
      [
        "not swapping in the new install: a daemon runs from the one in place.",
        `  pid ${process.pid}, ${home}`,
        "Then:",
        "  agent stop   stop that daemon",
        "  agent start  start it again; the float swaps the new install in first",
        "",
      ].join("\n"),
    );
    expect(installedVersion()).toBe("1.10.29");
    expect(readResolvedVersionRecord(dir)?.version).toBe("1.10.29");
    expectNoDebris();
  } finally {
    releaseFileLock(daemonLockPath(home));
  }
  // Stopped: the next float swaps.
  await floatProxy(deps(fetchLike, fakeInstall().runner, WEEK_SECONDS));
  expect(installedVersion()).toBe("1.10.30");
  expect(readResolvedVersionRecord(dir)?.version).toBe("1.10.30");
});

test("a refused target keeps a usable in-bounds recorded version", async () => {
  seedFloat("1.10.29", NOW_MS - 30 * MILLISECONDS_PER_DAY);
  const { fetchLike } = docFetch(
    registryDoc({ "1.10.29": 40, "1.10.30": 8 }, { scripts: { "1.10.30": ["install"] } }),
  );
  const install = fakeInstall();

  await floatProxy(deps(fetchLike, install.runner, WEEK_SECONDS));

  expect(install.calls).toEqual([]);
  expect(readResolvedVersionRecord(dir)?.version).toBe("1.10.29");
});

test("a refused target reinstalls a kept record whose install is gone", async () => {
  // A build change renders a new manifest; when the install on disk is not this build's, the
  // kept record must be reinstalled, not thrown away: the daemon would otherwise launch
  // against a tree missing what the new shims import.
  writeResolvedVersionRecord(dir, "1.10.29", NOW_MS - 30 * MILLISECONDS_PER_DAY);
  const { fetchLike } = docFetch(
    registryDoc({ "1.10.29": 40, "1.10.30": 8 }, { scripts: { "1.10.30": ["install"] } }),
  );
  const install = fakeInstall();

  await floatProxy(deps(fetchLike, install.runner, WEEK_SECONDS));

  // The KEPT version is the only install, never the refused one, under the same supply-chain
  // window as any other install.
  expect(installCalls(install.calls)).toHaveLength(1);
  expect(manifestProxyVersion()).toBe("1.10.29");
  expect(parseToml(readFileSync(daemonBunfigFile(dir), "utf8"))).toMatchObject({
    install: { minimumReleaseAge: WEEK_SECONDS },
  });
  expect(readResolvedVersionRecord(dir)).toEqual({ version: "1.10.29", resolvedAtMs: NOW_MS });
});

// The tree in place is the resolution the refusal judges, never a record that lagged it: a
// complete tree above the ceiling with a stale record naming an in-bounds version is refused
// outright (the record follows the tree at entry), not "kept" by reinstalling the record's
// version.
test("a refused target never reinstalls a stale record under a tree in place that is out of bounds", async () => {
  writeResolvedVersionRecord(dir, "1.10.29", NOW_MS - 30 * MILLISECONDS_PER_DAY);
  plantProxyInstall(dir, "1.10.31");
  const { fetchLike } = docFetch(
    registryDoc(
      { "1.10.29": 40, "1.10.30": 8, "1.10.31": 8 },
      { scripts: { "1.10.30": ["install"] } },
    ),
  );
  const install = fakeInstall();
  const ceiling: ProjectConfig = { ...CONFIG, proxyMaxVersion: "1.10.30" };

  await expect(
    floatProxy({ ...deps(fetchLike, install.runner, WEEK_SECONDS), config: ceiling }),
  ).rejects.toThrow("lifecycle scripts");

  expect(install.calls).toEqual([]);
  expect(readResolvedVersionRecord(dir)).toEqual({
    version: "1.10.31",
    resolvedAtMs: NOW_MS - 30 * MILLISECONDS_PER_DAY,
  });
});

test("a lifecycle-scripted target is refused outright with nothing usable on record: fresh, cold scripted, or cold unlisted", async () => {
  // A fresh install has nothing to keep. An explicit pin bypasses the refusal, so a scripted
  // version can be on record (e.g. the pin was later removed); reinstalling it automatically
  // would install the refused version without the pin's consent. A record the doc does not
  // list cannot have its scripts vetted at all, and fails closed the same way.
  const rows: { recorded: string | null; script: string }[] = [
    { recorded: null, script: "postinstall" },
    { recorded: "1.10.30", script: "install" },
    { recorded: "1.10.5", script: "install" },
  ];
  for (const row of rows) {
    const label = JSON.stringify(row);
    const doc = registryDoc({ "1.10.30": 8 }, { scripts: { "1.10.30": [row.script] } });
    dir = removeDir(dir);
    dir = isolateProxyHome("copilot-float-");
    if (row.recorded !== null) {
      writeResolvedVersionRecord(dir, row.recorded, NOW_MS - 30 * MILLISECONDS_PER_DAY);
    }
    const install = fakeInstall(); // cold: the keep-without-install path is not available

    await expect(
      floatProxy(deps(docFetch(doc).fetchLike, install.runner, WEEK_SECONDS)),
      label,
    ).rejects.toThrow("lifecycle scripts");
    expect(install.calls, label).toEqual([]);
  }
});

test("a refused target whose kept record cannot reinstall still fails loud", async () => {
  writeResolvedVersionRecord(dir, "1.10.29", NOW_MS - 30 * MILLISECONDS_PER_DAY);
  const { fetchLike } = docFetch(
    registryDoc({ "1.10.29": 40, "1.10.30": 8 }, { scripts: { "1.10.30": ["install"] } }),
  );

  await expect(
    floatProxy(deps(fetchLike, fakeInstall({ exit: 1 }).runner, WEEK_SECONDS)),
  ).rejects.toThrow("lifecycle scripts");
});

test("registry failure keeps a usable recorded version, else installs the floor offline", async () => {
  seedFloat("1.10.30", NOW_MS - 30 * MILLISECONDS_PER_DAY);
  const kept = fakeInstall();
  await floatProxy(deps(offlineFetch().fetchLike, kept.runner, WEEK_SECONDS));
  expect(kept.calls).toEqual([]);

  dir = removeDir(dir);
  dir = isolateProxyHome("copilot-float-");
  const floor = fakeInstall();
  await floatProxy({
    ...deps(offlineFetch().fetchLike, floor.runner, WEEK_SECONDS),
    config: { proxyMinVersion: "1.10.30", proxyMaxVersion: null },
  });
  expect(installCalls(floor.calls)).toHaveLength(1);
  expect(manifestProxyVersion()).toBe("1.10.30");
  expect(readResolvedVersionRecord(dir)?.version).toBe("1.10.30");
});

// The bug this pins: a failed look read as "install missing" installed the floor, and the
// superseded-cache drop discarded the recorded, possibly working, install on the way. The
// proven-missing control is the floor install above. chmod 000 denies nothing to root or on
// Windows, so the row skips there.
test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "a FAILED install look keeps the recorded version, never the floor reinstall; verify says could-not-verify",
  async () => {
    seedFloat("1.10.30", NOW_MS - 30 * MILLISECONDS_PER_DAY);
    chmodSync(proxyManifestFile(dir), 0o000);
    try {
      const install = fakeInstall();
      await floatProxy(deps(offlineFetch().fetchLike, install.runner, WEEK_SECONDS));
      expect(readResolvedVersionRecord(dir)?.version).toBe("1.10.30");
      expect(install.calls).toEqual([]); // no floor install, no reinstall

      const unproven = await proxyFloatVerifyStatus(
        deps(offlineFetch().fetchLike, install.runner, WEEK_SECONDS),
      );
      expect(unproven.upToDate).toBe(false);
      expect(unproven.message).toContain("could not verify");
      expect(unproven.message).not.toContain("is not installed");

      // An exact pin whose look failed reinstalls (same version, non-destructive) instead of
      // claiming "pinned; no install".
      process.env[VERSION_ENV] = "1.10.30";
      chmodSync(proxyManifestFile(dir), 0o600);
      chmodSync(proxyManifestFile(dir), 0o000);
      const pinned = fakeInstall();
      await floatProxy(deps(offlineFetch().fetchLike, pinned.runner));
      expect(installCalls(pinned.calls)).toHaveLength(1);
      expect(readResolvedVersionRecord(dir)?.version).toBe("1.10.30");
    } finally {
      chmodSync(proxyManifestFile(dir), 0o600);
    }
  },
);

test("verify: a proven-missing install earns the confident 'not installed'", async () => {
  writeResolvedVersionRecord(dir, "1.10.30", NOW_MS);
  const missing = await proxyFloatVerifyStatus(
    deps(offlineFetch().fetchLike, fakeInstall().runner, WEEK_SECONDS),
  );
  expect(missing.upToDate).toBe(false);
  expect(missing.message).toContain(`is not installed in ${proxyInstallDir(dir)}`);
});

test("a failed install below the floor throws", async () => {
  const { fetchLike } = docFetch(registryDoc({ "1.10.30": 8 }));
  await expect(
    floatProxy(deps(fetchLike, fakeInstall({ exit: 1 }).runner, WEEK_SECONDS)),
  ).rejects.toThrow("could not install");
});

test("an exact env pin bypasses window, cooldown, and a bad cooldown env, at the float and at verify", async () => {
  process.env[VERSION_ENV] = "1.9.99"; // below CONFIG's floor on purpose
  process.env[MIN_RELEASE_AGE_ENV] = "not-a-number"; // would throw if resolved
  const install = fakeInstall();

  await floatProxy(deps(offlineFetch().fetchLike, install.runner));

  expect(installCalls(install.calls)).toHaveLength(1);
  expect(manifestProxyVersion()).toBe("1.9.99");
  // A pin's install runs with no floor at all, the transitive tree included.
  expect(parseToml(readFileSync(daemonBunfigFile(dir), "utf8"))).toMatchObject({
    install: { minimumReleaseAge: 0 },
  });
  expect(readResolvedVersionRecord(dir)?.version).toBe("1.9.99");

  // The same pin, now recorded and installed, verifies up to date under the same bad cooldown env.
  const status = await proxyFloatVerifyStatus(deps(offlineFetch().fetchLike, install.runner));
  expect(status.upToDate).toBe(true);
});

test("an exact pin already recorded and installed is a no-op", async () => {
  process.env[VERSION_ENV] = "1.10.30";
  seedFloat("1.10.30", NOW_MS - 30 * MILLISECONDS_PER_DAY);
  const install = fakeInstall();

  await floatProxy(deps(offlineFetch().fetchLike, install.runner));

  expect(install.calls).toEqual([]);
});

test("a stored proxy-version config pin applies; the env pin wins over it", async () => {
  new CopilotEnvConfig().set({ "daemon.version": "1.10.29" });
  await floatProxy(deps(offlineFetch().fetchLike, fakeInstall().runner));
  expect(readResolvedVersionRecord(dir)?.version).toBe("1.10.29");

  process.env[VERSION_ENV] = "1.10.30";
  await floatProxy(deps(offlineFetch().fetchLike, fakeInstall().runner));
  expect(readResolvedVersionRecord(dir)?.version).toBe("1.10.30");
});

test("a dist-tag pin resolves through the registry; an unknown tag throws", async () => {
  process.env[VERSION_ENV] = "latest";
  const doc = registryDoc({ "1.10.31": 1 }, { distTags: { latest: "1.10.31" } });

  await floatProxy(deps(docFetch(doc).fetchLike, fakeInstall().runner));
  expect(readResolvedVersionRecord(dir)?.version).toBe("1.10.31");

  process.env[VERSION_ENV] = "nope";
  await expect(floatProxy(deps(docFetch(doc).fetchLike, fakeInstall().runner))).rejects.toThrow(
    "'nope' tag does not exist",
  );
});

// A COPILOT_API_ENTRY daemon on a compiled install: the float never runs for it, yet its preload
// shims import packages only an install puts beside the binary's proxy home.
describe("ensureShimDependencies", () => {
  test("installs the shims' packages alone when the proxy home lacks them, and is a no-op once there", async () => {
    const install = fakeInstall();
    await ensureShimDependencies(deps(offlineFetch().fetchLike, install.runner, WEEK_SECONDS));
    expect(install.calls.map((c) => c.args)).toEqual([["install"]]);
    const manifest = JSON.parse(readFileSync(proxyManifestFile(dir), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies).sort()).toEqual([...DAEMON_SHIM_DEPENDENCIES].sort());
    expect(readResolvedVersionRecord(dir)).toBeNull(); // no proxy was resolved

    await ensureShimDependencies(deps(offlineFetch().fetchLike, install.runner, WEEK_SECONDS));
    expect(install.calls).toHaveLength(1);

    // A real float afterwards supersedes the shims-only manifest with the proxy's.
    await floatProxy(
      deps(docFetch(registryDoc({ "1.10.30": 8 })).fetchLike, install.runner, WEEK_SECONDS),
    );
    expect(manifestProxyVersion()).toBe("1.10.30");
    expect(install.calls.map((c) => c.args)).toEqual([["install"], ["install"]]);
  });

  test("a failed install throws rather than leaving a daemon to die at module load", async () => {
    await expect(
      ensureShimDependencies(deps(offlineFetch().fetchLike, fakeInstall({ exit: 1 }).runner, 0)),
    ).rejects.toThrow("shims' dependencies");
  });
});

describe("resolved-version record", () => {
  test("absent, malformed, or ill-shaped records read as null", () => {
    expect(readResolvedVersionRecord(dir)).toBeNull();
    mkdirSync(join(dir, "proxy"), { recursive: true });
    writeFileSync(resolvedVersionFile(dir), "not json");
    expect(readResolvedVersionRecord(dir)).toBeNull();
    writeFileSync(resolvedVersionFile(dir), JSON.stringify({ version: "not-a-version" }));
    expect(readResolvedVersionRecord(dir)).toBeNull();
  });
});

// Every row runs offline: the record's state alone (present, installed, fresh, in bounds) must
// decide the verdict, and only the stale-record rows may reach for the registry.

const VERIFY_ROWS: {
  name: string;
  record: { version: string; ageMs: number } | null;
  installed: boolean;
  upToDate: boolean;
  message?: string;
  network?: boolean;
}[] = [
  {
    name: "install needed when nothing is recorded",
    record: null,
    installed: false,
    upToDate: false,
  },
  {
    name: "a fresh in-bounds installed record verifies",
    record: { version: "1.10.30", ageMs: 1000 },
    installed: true,
    upToDate: true,
    network: false,
  },
  {
    name: "a fresh record whose install is gone needs an install",
    record: { version: "1.10.30", ageMs: 1000 },
    installed: false,
    upToDate: false,
    message: "is not installed",
  },
  {
    name: "a stale record is kept when the registry is unreachable",
    record: { version: "1.10.30", ageMs: 30 * MILLISECONDS_PER_DAY },
    installed: true,
    upToDate: true,
    message: "keeping",
    network: true,
  },
  {
    name: "a recorded version outside the window needs an update, without network",
    record: { version: "1.9.99", ageMs: 1000 },
    installed: true,
    upToDate: false,
    message: "1.10.0",
    network: false,
  },
];

describe("proxyFloatVerifyStatus", () => {
  test("the record's presence, install, age, and bounds decide the offline verdict", async () => {
    for (const row of VERIFY_ROWS) {
      dir = removeDir(dir);
      dir = isolateProxyHome("copilot-float-");
      if (row.record) {
        if (row.installed) seedFloat(row.record.version, NOW_MS - row.record.ageMs);
        else writeResolvedVersionRecord(dir, row.record.version, NOW_MS - row.record.ageMs);
      }
      const offline = offlineFetch();
      const status = await proxyFloatVerifyStatus(
        deps(offline.fetchLike, fakeInstall().runner, WEEK_SECONDS),
      );
      expect(status.upToDate, row.name).toBe(row.upToDate);
      if (row.message) expect(status.message, row.name).toContain(row.message);
      if (row.network !== undefined) {
        expect(offline.calls.length > 0, row.name).toBe(row.network);
      }
    }
  });

  test("a stale record re-checks the registry", async () => {
    seedFloat("1.10.30", NOW_MS - 30 * MILLISECONDS_PER_DAY);
    const same = docFetch(registryDoc({ "1.10.30": 8, "1.10.31": 1 }));
    const okStatus = await proxyFloatVerifyStatus(
      deps(same.fetchLike, fakeInstall().runner, WEEK_SECONDS),
    );
    expect(same.calls).toHaveLength(1);
    expect(okStatus.upToDate).toBe(true);

    const moved = docFetch(registryDoc({ "1.10.30": 40, "1.10.31": 8 }));
    const staleStatus = await proxyFloatVerifyStatus(
      deps(moved.fetchLike, fakeInstall().runner, WEEK_SECONDS),
    );
    expect(staleStatus.upToDate).toBe(false);
    expect(staleStatus.message).toContain("1.10.30");
    expect(staleStatus.message).toContain("1.10.31");
  });

  test("COPILOT_API_VERSION: up to date only when the exact pin is recorded and installed", async () => {
    seedFloat("1.10.30", NOW_MS);
    process.env[VERSION_ENV] = "1.10.30";
    const d = deps(offlineFetch().fetchLike, fakeInstall().runner);
    expect((await proxyFloatVerifyStatus(d)).upToDate).toBe(true);

    process.env[VERSION_ENV] = "1.10.31";
    expect((await proxyFloatVerifyStatus(d)).upToDate).toBe(false);

    // A dist-tag pin always re-resolves -> never "up to date".
    process.env[VERSION_ENV] = "latest";
    expect((await proxyFloatVerifyStatus(d)).upToDate).toBe(false);
  });
});

describe("removeProxyFloatArtifacts", () => {
  test("removes the proxy home (record, install, lock) and bun's cache; a neighbour survives", async () => {
    await floatProxy(
      deps(docFetch(registryDoc({ "1.10.30": 8 })).fetchLike, fakeInstall().runner, 0),
    );
    mkdirSync(proxyBunCacheDir(dir), { recursive: true });
    const neighbour = join(dir, "state.json");
    writeFileSync(neighbour, "{}");
    expect(existsSync(resolvedVersionFile(dir))).toBe(true);
    expect(existsSync(proxyLockFile(dir))).toBe(true);

    removeProxyFloatArtifacts(dir);
    expect(existsSync(proxyHome(dir))).toBe(false);
    expect(existsSync(proxyBunCacheDir(dir))).toBe(false);
    expect(existsSync(neighbour)).toBe(true);
  });
});

// proxyFloatSkips backs the health engine's Direct-only skip report.
// The wiring-level answer (proxyUnusedEverywhere) and its edge cases live in
// test/agents/agents_wiring.test.ts; this pins the env-pin override the float adds.
describe("proxyFloatSkips", () => {
  const CODEX_DIRECT_TOML = [
    'model_provider = "copilot-env"',
    "",
    "[model_providers.copilot-env]",
    'base_url = "https://api.githubcopilot.com"',
    "",
  ].join("\n");

  test("direct-only skips, but a COPILOT_API_VERSION pin forces the float", () => {
    const codexHome = join(dir, "codex-home");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "config.toml"), CODEX_DIRECT_TOML);
    const claudeHome = join(dir, "claude-home");
    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(
      join(claudeHome, "settings.json"),
      JSON.stringify({
        apiKeyHelper: directHelperCommand(),
        env: { ANTHROPIC_BASE_URL: "https://api.githubcopilot.com" },
      }),
    );
    expect(proxyFloatSkips(codexHome, claudeHome)).toBe(true);
    // An env pin is per-invocation intent: the float must run (and health's
    // bounds exemption must not fire) even on a direct-only machine.
    process.env.COPILOT_API_VERSION = "1.2.3";
    expect(proxyFloatSkips(codexHome, claudeHome)).toBe(false);
  });
});

// --- the floated spawn, actually executed -------------------------------------
describe("the floated spawn executes", () => {
  // Every other test here asserts the SHAPE of the install, and a well-shaped proxy home no bun
  // would run (a bin the package does not ship, a shim dependency outside the manifest) passes
  // them. The fixture is genuine float output built by scripts/warm-proxy-cache.ts while the
  // container image still has a network, which keeps this offline and deterministic. In CI and
  // the container the fixture always exists; a checkout without it (build one with
  // `bun scripts/warm-proxy-cache.ts`) reports this test ignored, never passed.
  const record = readResolvedVersionRecord(PROXY_CACHE_FIXTURE);
  test.skipIf(record === null)(
    "a real floated install actually launches the proxy, with no node_modules of its own",
    () => {
      if (record === null) throw new Error("unreachable: the fixture gate skipped this test");
      process.env.COPILOT_API_HOME = PROXY_CACHE_FIXTURE;
      const entry = resolveCopilotApiEntry();
      if (entry.kind !== "floated") throw new Error(`expected a floated entry, got ${entry.kind}`);
      expect(entry.version).toBe(record.version);

      // Merged over our own environment, as daemonEnvironment does in production: a child
      // stripped of PATH/HOME would test something the daemon never does. The proxy's own graph
      // resolves from the install; that the shims resolve from the proxy home alone is the
      // installer smoke's proof (a compiled install has no checkout node_modules to fall back on).
      const result = runSync(process.execPath, copilotApiArgv(["--help"], [], entry), {
        cwd: entry.proxyHome,
        env: { ...process.env, ...BUN_CLI_ENV },
        timeoutMs: 120_000,
      });
      const output = `${result.stdout}${result.stderr}`;
      // Resolution: the install must let bun assemble the whole graph offline.
      expect(output).not.toContain("Cannot find");
      expect(output).not.toContain("Could not resolve");
      expect(`exit=${result.exitCode} ${output}`).toContain("exit=0");
      expect(output).toContain("copilot-api");
    },
  );
});
