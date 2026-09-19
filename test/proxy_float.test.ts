import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { directHelperCommand } from "../src/claude/config.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import {
  daemonConfigFile,
  daemonConfigFingerprint,
  DEFAULT_RELEASE_COOLDOWN_SECONDS,
  type DenoRunner,
  ensureProxyNpmrc,
  type FetchLike,
  floatProxy,
  nextProxyVersion,
  NPMRC_MARKER,
  parseRegistryDoc,
  proxyDenoDir,
  proxyFloatSkips,
  proxyFloatVerifyStatus,
  proxyInstallAssertStatus,
  proxyLockFile,
  readResolvedVersionRecord,
  removeProxyFloatArtifacts,
  resolvedVersionFile,
  resolveMinimumReleaseAgeSeconds,
  resolveProxyVersionOverride,
  selectProxyVersion,
  writeDaemonConfig,
  writeResolvedVersionRecord,
} from "../src/proxy_float.ts";
import {
  copilotApiArgv,
  copilotApiEnv,
  resolveCopilotApiEntry,
} from "../src/copilot_api/process.ts";
import { DAEMON_SHIM_FILES } from "../src/copilot_api/shims.ts";
import { CopilotApiPaths } from "../src/copilot_api/paths.ts";
import { installedProxyVersion } from "../src/copilot_api/version.ts";
import type { ProjectConfig } from "../src/utils/project_config.ts";
import { MILLISECONDS_PER_DAY } from "../src/utils/time.ts";
import { afterEach, beforeEach, describe, expect, removeDir, test } from "./helpers/testing.ts";
import { PROXY_CACHE_FIXTURE } from "../scripts/warm-proxy-cache.ts";
import { ROOT, runSync } from "./helpers/run.ts";
import { envSnapshot, isolateProxyHome } from "./helpers.ts";

// resolved-version.json records each float; it is the freshness oracle that
// proxyFloatVerifyStatus's offline fast path reads.

const PROXY_PKG = "@jeffreycao/copilot-api";
const NOW_MS = Date.parse("2026-06-10T00:00:00.000Z");
const WEEK_SECONDS = 604800;

const CONFIG: ProjectConfig = {
  "proxyMinVersion": "1.10.0",
  "proxyMaxVersion": null,
};

const MIN_RELEASE_AGE_ENV = "COPILOT_API_MIN_RELEASE_AGE";
const VERSION_ENV = "COPILOT_API_VERSION";
const ENTRY_ENV = "COPILOT_API_ENTRY";

let dir = "";
const restoreEnv = envSnapshot([MIN_RELEASE_AGE_ENV, VERSION_ENV, ENTRY_ENV]);

function isoDaysAgo(days: number): string {
  return new Date(NOW_MS - days * MILLISECONDS_PER_DAY).toISOString();
}

/** A registry document: each version with its publish age in days before NOW_MS. */
function registryDoc(
  daysByVersion: Record<string, number>,
  opts: {
    scripts?: Record<string, string[]>;
    hasInstallScript?: string[];
    distTags?: Record<string, string>;
  } = {},
): unknown {
  const versions: Record<string, unknown> = {};
  const time: Record<string, string> = { "created": isoDaysAgo(400), "modified": isoDaysAgo(0) };
  for (const [version, days] of Object.entries(daysByVersion)) {
    const manifest: Record<string, unknown> = {};
    const scriptNames = opts.scripts?.[version];
    if (scriptNames) {
      manifest.scripts = Object.fromEntries(scriptNames.map((name) => [name, "node evil.js"]));
    }
    if (opts.hasInstallScript?.includes(version)) manifest.hasInstallScript = true;
    versions[version] = manifest;
    time[version] = isoDaysAgo(days);
  }
  return { "dist-tags": opts.distTags ?? {}, "versions": versions, "time": time };
}

function docFetch(doc: unknown): { calls: string[]; fetchLike: FetchLike } {
  const calls: string[] = [];
  return {
    calls,
    "fetchLike": (url) => {
      calls.push(url);
      return Promise.resolve(new Response(JSON.stringify(doc)));
    },
  };
}

function offlineFetch(): { calls: string[]; fetchLike: FetchLike } {
  const calls: string[] = [];
  return {
    calls,
    "fetchLike": (url) => {
      calls.push(url);
      return Promise.reject(new Error("offline"));
    },
  };
}

interface DenoCall {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/** A fake deno sidecar. A cache seeded with any proxy version stands for a completed prior
 *  float, so its shims count as warm too.
 *    cache <spec>     -> warms the proxy version or the shim unit the argv names
 *    info <spec>      -> answers for whichever is warm
 *    infoLaunchFails  -> every info is a marked FAILED look (spawn never completed); cache still warms */
function fakeDeno(
  initialCached: string[] = [],
  opts: { cacheExit?: number; infoLaunchFails?: boolean } = {},
): { calls: DenoCall[]; cached: Set<string>; runner: DenoRunner } {
  const cached = new Set(initialCached);
  let shimsWarm = initialCached.length > 0;
  const calls: DenoCall[] = [];
  const runner: DenoRunner = (command, args, options) => {
    calls.push({ command, "args": [...args], "cwd": options.cwd, "env": options.env });
    const spec = args[args.length - 1] ?? "";
    const prefix = `npm:${PROXY_PKG}@`;
    const isProxy = spec.startsWith(prefix);
    const version = isProxy ? spec.slice(prefix.length) : "";
    if (args[0] === "cache") {
      if (opts.cacheExit) return { "status": opts.cacheExit, "stdout": "", "stderr": "boom" };
      if (isProxy) cached.add(version);
      else shimsWarm = true;
      return { "status": 0, "stdout": "", "stderr": "" };
    }
    if (args[0] === "info") {
      if (opts.infoLaunchFails) {
        return { "status": 1, "stdout": "", "stderr": "", "launchFailed": true as const };
      }
      const ok = isProxy ? cached.has(version) : shimsWarm;
      return { "status": ok ? 0 : 1, "stdout": "", "stderr": "" };
    }
    return { "status": 0, "stdout": "", "stderr": "" };
  };
  return { calls, cached, runner };
}

/** The artifact set a COMPLETED prior float leaves behind. A record alone is a half-written
 *  float: cacheResolves' unproven arm checks the cache dir exists before vouching. */
function seedFloat(version: string, atMs: number, denoDir?: string): void {
  writeDaemonConfig(dir, ROOT);
  writeResolvedVersionRecord(dir, version, atMs, denoDir);
  mkdirSync(denoDir ?? proxyDenoDir(dir), { "recursive": true });
}

/** A float that installs warms TWO graphs, the proxy package and then the preload shims, because
 *  the daemon spawn resolves both under `--cached-only`; a recorded target that still resolves
 *  warms nothing. */
function cacheCalls(calls: DenoCall[]): DenoCall[] {
  return calls.filter((c) => c.args[0] === "cache");
}

function proxyCacheCalls(calls: DenoCall[]): DenoCall[] {
  return cacheCalls(calls).filter((c) => (c.args[c.args.length - 1] ?? "").startsWith("npm:"));
}

function shimCacheCalls(calls: DenoCall[]): DenoCall[] {
  return cacheCalls(calls).filter((c) => !(c.args[c.args.length - 1] ?? "").startsWith("npm:"));
}

function deps(fetchLike: FetchLike, runner: DenoRunner, cooldownSeconds?: number) {
  return {
    "rootHome": dir,
    "config": CONFIG,
    "cooldownSeconds": cooldownSeconds,
    "denoBin": "deno-test",
    "fetchLike": fetchLike,
    "runner": runner,
    "nowMs": NOW_MS,
  };
}

beforeEach(() => {
  dir = isolateProxyHome("copilot-float-");
  delete process.env[MIN_RELEASE_AGE_ENV];
  delete process.env[VERSION_ENV];
  delete process.env[ENTRY_ENV];
});

test("nextProxyVersion: the override is unknowable, a record wins, else the checkout's copy", () => {
  // Judged without writing anything, unlike the entry resolution. The checkout's node_modules
  // copy is the control: it exists here, so a null would be a wrong "unknown", not an absent package.
  const installed = installedProxyVersion();
  expect(installed).not.toBeNull();
  expect(nextProxyVersion(dir)).toBe(installed);
  seedFloat("1.99.0", NOW_MS);
  const recordBefore = readFileSync(resolvedVersionFile(dir), "utf8");
  expect(nextProxyVersion(dir)).toBe("1.99.0");
  expect(readFileSync(resolvedVersionFile(dir), "utf8")).toBe(recordBefore);
  process.env[ENTRY_ENV] = join(dir, "fake-proxy.mjs");
  expect(nextProxyVersion(dir)).toBeNull();
});

test("nextProxyVersion: an exact pin the record does not match IS the next version; a tag pin is unknowable", () => {
  seedFloat("1.16.3", NOW_MS);
  const config = new CopilotEnvConfig();
  config.set({ "daemon.version": "1.14.21" });
  expect(nextProxyVersion(dir)).toBe("1.14.21");
  config.set({ "daemon.version": "legacy" });
  expect(nextProxyVersion(dir)).toBeNull();
  config.set({ "daemon.version": "1.16.3" });
  expect(nextProxyVersion(dir)).toBe("1.16.3");
});

afterEach(() => {
  restoreEnv();
  dir = removeDir(dir);
});

describe("selectProxyVersion", () => {
  // One registry document, one window, one cooldown -> one selection. The reason fragment
  // names the branch taken, so a clamp that answers the right version for the wrong reason
  // (or the floor reached by fallback instead of by clamp) still fails its row.
  const FLOOR_30: ProjectConfig = { "proxyMinVersion": "1.10.30", "proxyMaxVersion": null };
  const rows: {
    name: string;
    doc: unknown;
    config: ProjectConfig;
    cooldownSeconds: number;
    expected: Record<string, unknown>;
  }[] = [
    {
      "name": "the newest cooldown-aged release inside the window",
      "doc": registryDoc({ "1.10.29": 30, "1.10.30": 8, "1.10.31": 1 }),
      "config": CONFIG,
      "cooldownSeconds": WEEK_SECONDS,
      "expected": {
        "kind": "resolved",
        "version": "1.10.30",
        "publishedAtMs": NOW_MS - 8 * MILLISECONDS_PER_DAY,
        "reason": expect.stringContaining("latest >=7 days old release 1.10.30"),
      },
    },
    {
      "name": "cooldown 0 selects the newest release",
      "doc": registryDoc({ "1.10.30": 8, "1.10.31": 1 }),
      "config": CONFIG,
      "cooldownSeconds": 0,
      "expected": {
        "kind": "resolved",
        "version": "1.10.31",
        "publishedAtMs": NOW_MS - MILLISECONDS_PER_DAY,
        "reason": expect.stringContaining("release 1.10.31"),
      },
    },
    {
      "name": "an aged release below the floor clamps UP to the floor",
      "doc": registryDoc({ "1.10.29": 8, "1.10.30": 1 }),
      "config": FLOOR_30,
      "cooldownSeconds": WEEK_SECONDS,
      "expected": {
        "kind": "resolved",
        "version": "1.10.30",
        "publishedAtMs": NOW_MS - MILLISECONDS_PER_DAY,
        "reason": expect.stringContaining("1.10.29 < floor 1.10.30"),
      },
    },
    {
      "name": "an aged release AT the floor is not a clamp",
      "doc": registryDoc({ "1.10.29": 8, "1.10.30": 8 }),
      "config": FLOOR_30,
      "cooldownSeconds": WEEK_SECONDS,
      "expected": {
        "kind": "resolved",
        "version": "1.10.30",
        "publishedAtMs": NOW_MS - 8 * MILLISECONDS_PER_DAY,
        "reason": expect.stringContaining("latest >=7 days old release 1.10.30"),
      },
    },
    {
      "name": "an aged release above the ceiling clamps DOWN to the ceiling",
      "doc": registryDoc({ "1.10.29": 8, "1.10.30": 8 }),
      "config": { "proxyMinVersion": "1.10.0", "proxyMaxVersion": "1.10.29" },
      "cooldownSeconds": WEEK_SECONDS,
      "expected": {
        "kind": "resolved",
        "version": "1.10.29",
        "publishedAtMs": NOW_MS - 8 * MILLISECONDS_PER_DAY,
        "reason": expect.stringContaining("1.10.30 > ceiling 1.10.29"),
      },
    },
    {
      "name": "the only aged release is the floor itself",
      "doc": registryDoc({ "1.10.0": 200, "1.10.31": 1 }),
      "config": CONFIG,
      "cooldownSeconds": WEEK_SECONDS,
      "expected": {
        "kind": "resolved",
        "version": "1.10.0",
        "publishedAtMs": NOW_MS - 200 * MILLISECONDS_PER_DAY,
        "reason": expect.stringContaining("latest >=7 days old release 1.10.0"),
      },
    },
    {
      "name": "no aged release at all falls back to the floor",
      "doc": registryDoc({ "1.10.0": 1, "1.10.31": 1 }),
      "config": CONFIG,
      "cooldownSeconds": WEEK_SECONDS,
      "expected": {
        "kind": "resolved",
        "version": "1.10.0",
        "publishedAtMs": NOW_MS - MILLISECONDS_PER_DAY,
        "reason": expect.stringContaining("no 7 days old release -> floor 1.10.0"),
      },
    },
    {
      "name": "a floor that is not published is unavailable, never trusted blind",
      "doc": registryDoc({ "1.10.31": 1 }),
      "config": CONFIG,
      "cooldownSeconds": WEEK_SECONDS,
      "expected": { "kind": "unavailable", "reason": expect.stringContaining("1.10.0") },
    },
    {
      "name": "a target declaring lifecycle scripts is refused, naming them",
      "doc": registryDoc({ "1.10.30": 8 }, { "scripts": { "1.10.30": ["postinstall"] } }),
      "config": CONFIG,
      "cooldownSeconds": WEEK_SECONDS,
      "expected": {
        "kind": "refused",
        "version": "1.10.30",
        "lifecycleScripts": ["postinstall"],
        "reason": expect.stringContaining("1.10.30"),
      },
    },
    {
      "name": "the hasInstallScript flag alone also refuses",
      "doc": registryDoc({ "1.10.30": 8 }, { "hasInstallScript": ["1.10.30"] }),
      "config": CONFIG,
      "cooldownSeconds": WEEK_SECONDS,
      "expected": {
        "kind": "refused",
        "version": "1.10.30",
        "lifecycleScripts": ["install"],
        "reason": expect.stringContaining("1.10.30"),
      },
    },
  ];

  test("registry ages, window, and cooldown decide the target and the reason it was picked", () => {
    for (const row of rows) {
      const sel = selectProxyVersion(
        parseRegistryDoc(row.doc),
        row.config,
        row.cooldownSeconds,
        NOW_MS,
      );
      expect({ "name": row.name, ...sel }).toEqual({ "name": row.name, ...row.expected });
    }
  });
});

describe("parseRegistryDoc", () => {
  // A document malformed at the top is rejected whole; a single version with an unparseable
  // publish time is dropped, never given an age it does not have.
  test("malformed documents throw, an unparseable publish time drops that release", () => {
    for (const raw of [{ "versions": "nope" }, null]) {
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
    expect(resolveMinimumReleaseAgeSeconds()).toBe(DEFAULT_RELEASE_COOLDOWN_SECONDS);
    new CopilotEnvConfig().set({ "daemon.release-cooldown": 172800 });
    expect(resolveMinimumReleaseAgeSeconds()).toBe(172800);
    for (const [env, seconds] of [["100", 100], ["0", 0]] as const) {
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

describe("floatProxy", () => {
  test("caches the exact newest cooldown-aged target and records it", async () => {
    const { fetchLike } = docFetch(registryDoc({ "1.10.30": 8, "1.10.31": 1 }));
    const deno = fakeDeno();

    await floatProxy(deps(fetchLike, deno.runner, WEEK_SECONDS));

    const cache = proxyCacheCalls(deno.calls);
    expect(cache).toHaveLength(1);
    expect(cache[0]?.command).toBe("deno-test");
    // The DAEMON config, not the checkout's: deno.json's frozen lock would reject this
    // exact specifier outright, since only the caret range is in deno.lock.
    expect(cache[0]?.args).toEqual([
      "cache",
      "--config",
      daemonConfigFile(dir),
      // The proxy's OWN lockfile pins the transitive tree across floats and is the baseline
      // trust-policy=no-downgrade compares against; with no lockfile there is nothing to compare.
      "--lock",
      proxyLockFile(dir),
      "--node-modules-dir=none",
      "--minimum-dependency-age=PT604800S",
      `npm:${PROXY_PKG}@1.10.30`,
    ]);
    // The shims are warmed too -- a miss on them is just as fatal to the launch.
    const shimWarm = shimCacheCalls(deno.calls);
    expect(shimWarm).toHaveLength(1);
    expect(shimWarm[0]?.args).toContain("--config");
    for (const shim of DAEMON_SHIM_FILES) {
      expect(shimWarm[0]?.args.some((a) => a.endsWith(shim))).toBe(true);
    }
    expect(cache[0]?.env.DENO_DIR).toBe(proxyDenoDir(dir));
    expect(cache[0]?.env.DENO_NO_UPDATE_CHECK).toBe("1");
    // Location-independence: config/package.json discovery must never reach the
    // spawn (npm-specifier entrypoints fail under a discovered node-modules config).
    expect(cache[0]?.env.DENO_NO_PACKAGE_JSON).toBe("1");
    expect(cache[0]?.cwd).toBe(dir);

    const record = readResolvedVersionRecord(dir);
    expect(record).toEqual({
      "version": "1.10.30",
      "resolvedAtMs": NOW_MS,
      "denoDir": proxyDenoDir(dir),
      "buildFingerprint": daemonConfigFingerprint(),
    });
  });

  test("skips the cache write when the recorded target is already cached, refreshing the record", async () => {
    seedFloat("1.10.30", NOW_MS - 30 * MILLISECONDS_PER_DAY);
    const { fetchLike } = docFetch(registryDoc({ "1.10.30": 8, "1.10.31": 1 }));
    const deno = fakeDeno(["1.10.30"]);

    await floatProxy(deps(fetchLike, deno.runner, WEEK_SECONDS));

    expect(cacheCalls(deno.calls)).toEqual([]);
    // The record's timestamp refreshes so proxyFloatVerifyStatus stays on its offline fast
    // path, and the fast path stamps the running build's identity too.
    const record = readResolvedVersionRecord(dir);
    expect(record?.resolvedAtMs).toBe(NOW_MS);
    expect(record?.buildFingerprint).toBe(daemonConfigFingerprint());
  });

  test("a timestamp refresh preserves the record's own cache dir", async () => {
    const elsewhere = join(dir, "old-cache");
    seedFloat("1.10.30", NOW_MS - 30 * MILLISECONDS_PER_DAY, elsewhere);
    const { fetchLike } = docFetch(registryDoc({ "1.10.30": 8 }));
    const deno = fakeDeno(["1.10.30"]);

    await floatProxy(deps(fetchLike, deno.runner, WEEK_SECONDS));

    // The cache probe ran against the recorded dir, and the refreshed record
    // still points there -- never silently rewritten to the current dir.
    expect(deno.calls[0]?.env.DENO_DIR).toBe(elsewhere);
    expect(readResolvedVersionRecord(dir)?.denoDir).toBe(elsewhere);
  });

  test("re-caches when the record matches but the cache entry is gone", async () => {
    seedFloat("1.10.30", NOW_MS);
    const { fetchLike } = docFetch(registryDoc({ "1.10.30": 8 }));
    const deno = fakeDeno(); // nothing cached

    await floatProxy(deps(fetchLike, deno.runner, WEEK_SECONDS));

    expect(proxyCacheCalls(deno.calls)).toHaveLength(1);
  });

  test("refuses a lifecycle-scripted target outright on a fresh install", async () => {
    const { fetchLike } = docFetch(
      registryDoc({ "1.10.30": 8 }, { "scripts": { "1.10.30": ["postinstall"] } }),
    );
    const deno = fakeDeno();

    await expect(floatProxy(deps(fetchLike, deno.runner, WEEK_SECONDS))).rejects.toThrow(
      "lifecycle scripts",
    );
    expect(cacheCalls(deno.calls)).toEqual([]);
  });

  test("a refused target keeps a usable in-bounds recorded version", async () => {
    seedFloat("1.10.29", NOW_MS - 30 * MILLISECONDS_PER_DAY);
    const { fetchLike } = docFetch(
      registryDoc({ "1.10.29": 40, "1.10.30": 8 }, { "scripts": { "1.10.30": ["install"] } }),
    );
    const deno = fakeDeno(["1.10.29"]);

    await floatProxy(deps(fetchLike, deno.runner, WEEK_SECONDS));

    expect(cacheCalls(deno.calls)).toEqual([]);
    expect(readResolvedVersionRecord(dir)?.version).toBe("1.10.29");
  });

  test("a refused target re-warms a kept record whose cache the new map orphaned", async () => {
    // A build change regenerates the daemon config; when the new map no longer
    // resolves against the old warm, the kept record must be re-warmed, not thrown
    // away -- the daemon would otherwise launch `--cached-only` against a cold cache.
    seedFloat("1.10.29", NOW_MS - 30 * MILLISECONDS_PER_DAY, join(dir, "old-cache"));
    const { fetchLike } = docFetch(
      registryDoc({ "1.10.29": 40, "1.10.30": 8 }, { "scripts": { "1.10.30": ["install"] } }),
    );
    const deno = fakeDeno(); // nothing cached: the regenerated map resolves nothing

    await floatProxy(deps(fetchLike, deno.runner, WEEK_SECONDS));

    const warmed = proxyCacheCalls(deno.calls);
    // The KEPT version is the only warm, never the refused one -- under the same
    // supply-chain window as any other install.
    expect(warmed.map((c) => c.args[c.args.length - 1])).toEqual([`npm:${PROXY_PKG}@1.10.29`]);
    expect(warmed[0]?.args).toContain("--minimum-dependency-age=PT604800S");
    expect(warmed[0]?.env.DENO_DIR).toBe(proxyDenoDir(dir));
    // The record repoints at the cache dir the warm landed in, restamped and refreshed.
    const record = readResolvedVersionRecord(dir);
    expect(record).toEqual({
      "version": "1.10.29",
      "resolvedAtMs": NOW_MS,
      "denoDir": proxyDenoDir(dir),
      "buildFingerprint": daemonConfigFingerprint(),
    });
  });

  test("a cold record the registry cannot vet is never re-warmed: scripted, or unlisted", async () => {
    // An explicit pin bypasses the refusal, so a scripted version can be on record (e.g. the
    // pin was later removed); re-warming it automatically would install the refused version
    // without the pin's consent. A record the doc does not list cannot have its scripts vetted
    // at all, and fails closed the same way.
    const doc = registryDoc({ "1.10.30": 8 }, { "scripts": { "1.10.30": ["install"] } });
    for (const recorded of ["1.10.30", "1.10.5"]) {
      dir = removeDir(dir);
      dir = isolateProxyHome("copilot-float-");
      seedFloat(recorded, NOW_MS - 30 * MILLISECONDS_PER_DAY);
      const deno = fakeDeno(); // cold: the keep-without-install path is not available

      await expect(
        floatProxy(deps(docFetch(doc).fetchLike, deno.runner, WEEK_SECONDS)),
        recorded,
      ).rejects.toThrow("lifecycle scripts");
      expect(cacheCalls(deno.calls), recorded).toEqual([]);
    }
  });

  test("a refused target whose kept record cannot re-warm still fails loud", async () => {
    seedFloat("1.10.29", NOW_MS - 30 * MILLISECONDS_PER_DAY);
    const { fetchLike } = docFetch(
      registryDoc({ "1.10.29": 40, "1.10.30": 8 }, { "scripts": { "1.10.30": ["install"] } }),
    );

    await expect(
      floatProxy(deps(fetchLike, fakeDeno([], { "cacheExit": 1 }).runner, WEEK_SECONDS)),
    ).rejects.toThrow("lifecycle scripts");
  });

  test("registry failure keeps a usable recorded version, else installs the floor offline", async () => {
    seedFloat("1.10.30", NOW_MS - 30 * MILLISECONDS_PER_DAY);
    const kept = fakeDeno(["1.10.30"]);
    await floatProxy(deps(offlineFetch().fetchLike, kept.runner, WEEK_SECONDS));
    expect(cacheCalls(kept.calls)).toEqual([]);

    dir = removeDir(dir);
    dir = isolateProxyHome("copilot-float-");
    const floor = fakeDeno();
    await floatProxy({
      ...deps(offlineFetch().fetchLike, floor.runner, WEEK_SECONDS),
      "config": { "proxyMinVersion": "1.10.30", "proxyMaxVersion": null },
    });
    const cache = proxyCacheCalls(floor.calls);
    expect(cache).toHaveLength(1);
    expect(cache[0]?.args[cache[0].args.length - 1]).toBe(`npm:${PROXY_PKG}@1.10.30`);
    expect(readResolvedVersionRecord(dir)?.version).toBe("1.10.30");
  });

  test("a FAILED cache look keeps the recorded version -- never the floor reinstall", async () => {
    // The bug this pins: a failed look read as "cache missing" installed the floor, and
    // dropSupersededCache discarded the recorded, possibly working, cache on the way. Contrast
    // the proven-missing control above, where the floor install is the correct recovery.
    seedFloat("1.10.30", NOW_MS - 30 * MILLISECONDS_PER_DAY);
    const deno = fakeDeno(["1.10.30"], { "infoLaunchFails": true });

    await floatProxy(deps(offlineFetch().fetchLike, deno.runner, WEEK_SECONDS));

    expect(readResolvedVersionRecord(dir)?.version).toBe("1.10.30");
    expect(cacheCalls(deno.calls)).toEqual([]); // no floor install, no re-warm
  });

  test("verify: a FAILED cache look says could-not-verify, never 'not in the deno cache'", async () => {
    seedFloat("1.10.30", NOW_MS);
    const unproven = await proxyFloatVerifyStatus(
      deps(
        offlineFetch().fetchLike,
        fakeDeno(["1.10.30"], { "infoLaunchFails": true }).runner,
        WEEK_SECONDS,
      ),
    );
    expect(unproven.upToDate).toBe(false);
    expect(unproven.message).toContain("could not verify");
    expect(unproven.message).not.toContain("is not in the deno cache");

    // The proven-missing control: `deno info` RAN and said no -- that (and only
    // that) earns the confident "is not in the deno cache".
    const missing = await proxyFloatVerifyStatus(
      deps(offlineFetch().fetchLike, fakeDeno().runner, WEEK_SECONDS),
    );
    expect(missing.upToDate).toBe(false);
    expect(missing.message).toContain("is not in the deno cache");
  });

  test("an exact pin whose cache look failed re-warms instead of claiming up to date", async () => {
    process.env[VERSION_ENV] = "1.10.30";
    seedFloat("1.10.30", NOW_MS);
    const deno = fakeDeno(["1.10.30"], { "infoLaunchFails": true });

    await floatProxy(deps(offlineFetch().fetchLike, deno.runner));

    // Not the "pinned; no install" fast path: the unverified cache is re-warmed
    // (same version -- non-destructive) and the record stays on the pin.
    expect(proxyCacheCalls(deno.calls)).toHaveLength(1);
    expect(readResolvedVersionRecord(dir)?.version).toBe("1.10.30");
  });

  test("a superseded-then-failed install never 'keeps' the cache it just dropped", async () => {
    // The warm DROPS A's cache (dropSupersededCache) before failing, and the info look fails
    // too; the unproven keep must not vouch for A when its cache dir is observably gone.
    seedFloat("1.10.5", NOW_MS - 30 * MILLISECONDS_PER_DAY);
    const { fetchLike } = docFetch(registryDoc({ "1.10.30": 8 }));
    const deno = fakeDeno(["1.10.5"], { "cacheExit": 1, "infoLaunchFails": true });

    await expect(floatProxy(deps(fetchLike, deno.runner, WEEK_SECONDS))).rejects.toThrow(
      "could not install",
    );
  });

  test("a failed cache write below the floor throws", async () => {
    const { fetchLike } = docFetch(registryDoc({ "1.10.30": 8 }));
    const deno = fakeDeno([], { "cacheExit": 1 });

    await expect(floatProxy(deps(fetchLike, deno.runner, WEEK_SECONDS))).rejects.toThrow(
      "could not install",
    );
  });

  test("an exact env pin bypasses window, cooldown, and a bad cooldown env", async () => {
    process.env[VERSION_ENV] = "1.9.99"; // below CONFIG's floor on purpose
    process.env[MIN_RELEASE_AGE_ENV] = "not-a-number"; // would throw if resolved
    const deno = fakeDeno();

    await floatProxy(deps(offlineFetch().fetchLike, deno.runner));

    const cache = proxyCacheCalls(deno.calls);
    expect(cache).toHaveLength(1);
    expect(cache[0]?.args).toContain("--minimum-dependency-age=0");
    expect(cache[0]?.args).toContain(`npm:${PROXY_PKG}@1.9.99`);
    expect(readResolvedVersionRecord(dir)?.version).toBe("1.9.99");
  });

  test("an exact pin already recorded and cached is a no-op", async () => {
    process.env[VERSION_ENV] = "1.10.30";
    seedFloat("1.10.30", NOW_MS - 30 * MILLISECONDS_PER_DAY);
    const deno = fakeDeno(["1.10.30"]);

    await floatProxy(deps(offlineFetch().fetchLike, deno.runner));

    expect(cacheCalls(deno.calls)).toEqual([]);
  });

  test("a stored proxy-version config pin applies; the env pin wins over it", async () => {
    new CopilotEnvConfig().set({ "daemon.version": "1.10.29" });
    const deno = fakeDeno();
    await floatProxy(deps(offlineFetch().fetchLike, deno.runner));
    expect(readResolvedVersionRecord(dir)?.version).toBe("1.10.29");

    process.env[VERSION_ENV] = "1.10.30";
    const deno2 = fakeDeno();
    await floatProxy(deps(offlineFetch().fetchLike, deno2.runner));
    expect(readResolvedVersionRecord(dir)?.version).toBe("1.10.30");
  });

  test("a dist-tag pin resolves through the registry; an unknown tag throws", async () => {
    process.env[VERSION_ENV] = "latest";
    const doc = registryDoc({ "1.10.31": 1 }, { "distTags": { "latest": "1.10.31" } });
    const deno = fakeDeno();

    await floatProxy(deps(docFetch(doc).fetchLike, deno.runner));
    expect(readResolvedVersionRecord(dir)?.version).toBe("1.10.31");

    process.env[VERSION_ENV] = "nope";
    await expect(floatProxy(deps(docFetch(doc).fetchLike, fakeDeno().runner))).rejects.toThrow(
      "'nope' tag does not exist",
    );
  });
});

describe("ensureProxyNpmrc", () => {
  test("writes the marked trust-policy file and is idempotent", () => {
    expect(ensureProxyNpmrc(dir).kind).toBe("written");
    const content = readFileSync(join(dir, ".npmrc"), "utf8");
    expect(content).toContain(NPMRC_MARKER);
    expect(content).toContain("trust-policy=no-downgrade");
    expect(ensureProxyNpmrc(dir).kind).toBe("current");
  });

  // A foreign .npmrc (no marker) is kept byte for byte, whether its content could be read or
  // not: ownership unproven means never rewritten. The unreadable half needs chmod 000 to deny
  // the read, so it skips on Windows and under root.
  const FOREIGN_NPMRC = "registry=https://example.test\n";
  for (const readable of [true, false]) {
    test.skipIf(!readable && (process.platform === "win32" || process.getuid?.() === 0))(
      `never clobbers a foreign .npmrc that is ${readable ? "readable" : "UNREADABLE"}`,
      () => {
        const npmrc = join(dir, ".npmrc");
        writeFileSync(npmrc, FOREIGN_NPMRC);
        if (!readable) chmodSync(npmrc, 0o000);
        try {
          expect(ensureProxyNpmrc(dir).kind).toBe("kept-foreign");
        } finally {
          if (!readable) chmodSync(npmrc, 0o600);
        }
        expect(readFileSync(npmrc, "utf8")).toBe(FOREIGN_NPMRC);
      },
    );
  }

  test("floatProxy writes it before installing", async () => {
    // Read at cache-spawn time, inside the runner: an .npmrc written after the
    // install could not steer deno's trust policy, so an assertion made once
    // floatProxy returned would pass on exactly the ordering bug this guards.
    const seen: string[] = [];
    const inner = fakeDeno();
    const runner: DenoRunner = (command, args, options) => {
      if (args[0] === "cache") seen.push(readFileSync(join(dir, ".npmrc"), "utf8"));
      return inner.runner(command, args, options);
    };
    await floatProxy(deps(docFetch(registryDoc({ "1.10.30": 8 })).fetchLike, runner, 0));
    expect(seen.length).toBeGreaterThan(0);
    for (const content of seen) expect(content).toContain(NPMRC_MARKER);
  });
});

describe("resolved-version record", () => {
  test("absent, malformed, or ill-shaped records read as null", () => {
    expect(readResolvedVersionRecord(dir)).toBeNull();
    mkdirSync(join(dir, "proxy"), { recursive: true });
    writeFileSync(resolvedVersionFile(dir), "not json");
    expect(readResolvedVersionRecord(dir)).toBeNull();
    writeFileSync(resolvedVersionFile(dir), JSON.stringify({ "version": "not-a-version" }));
    expect(readResolvedVersionRecord(dir)).toBeNull();
  });
});

// The record remembers WHICH build's import map generated the daemon config, so an
// `agent update` behind a still-young record (no float due) cannot leave the old build's
// config steering daemon spawns until the record ages out of the cooldown window.
describe("the build-identity fingerprint", () => {
  test("a float-written record carries it; the on-disk key is the external contract", async () => {
    const deno = fakeDeno();
    await floatProxy(
      deps(docFetch(registryDoc({ "1.10.30": 8 })).fetchLike, deno.runner, WEEK_SECONDS),
    );
    expect(readResolvedVersionRecord(dir)?.buildFingerprint).toBe(daemonConfigFingerprint());
    const raw = JSON.parse(readFileSync(resolvedVersionFile(dir), "utf8"));
    expect(Object.keys(raw).sort()).toEqual([
      "build_fingerprint",
      "deno_dir",
      "resolved_at_ms",
      "version",
    ]);
    // A record written without a fingerprint omits the key rather than writing a placeholder.
    writeResolvedVersionRecord(dir, "1.10.30", NOW_MS);
    const bare = JSON.parse(readFileSync(resolvedVersionFile(dir), "utf8"));
    expect(Object.keys(bare).sort()).toEqual(["deno_dir", "resolved_at_ms", "version"]);
  });

  test("a malformed fingerprint reads as absent, never invalidating the record", async () => {
    seedFloat("1.10.30", NOW_MS);
    const raw = JSON.parse(readFileSync(resolvedVersionFile(dir), "utf8"));
    raw.build_fingerprint = 42;
    writeFileSync(resolvedVersionFile(dir), JSON.stringify(raw));
    const record = readResolvedVersionRecord(dir);
    expect(record?.version).toBe("1.10.30");
    expect(record?.buildFingerprint).toBeUndefined();

    // Any non-matching STRING behaves the same way -- the only consumer is equality
    // with the computed hash, so garbage means "regenerate once, then stamp" too.
    raw.build_fingerprint = "not-the-running-build";
    writeFileSync(resolvedVersionFile(dir), JSON.stringify(raw));
    await proxyFloatVerifyStatus(
      deps(offlineFetch().fetchLike, fakeDeno(["1.10.30"]).runner, WEEK_SECONDS),
    );
    expect(readResolvedVersionRecord(dir)?.buildFingerprint).toBe(daemonConfigFingerprint());
  });

  test("a young record from an older build regenerates the daemon config on verify", async () => {
    // An unstamped record (seedFloat writes none) stands for any build whose fingerprint
    // is not the running one.
    seedFloat("1.10.30", NOW_MS - 1000);
    writeFileSync(daemonConfigFile(dir), '{"imports":{"stale":"npm:stale@1.0.0"}}\n');
    const offline = offlineFetch();
    const status = await proxyFloatVerifyStatus(
      deps(offline.fetchLike, fakeDeno(["1.10.30"]).runner, WEEK_SECONDS),
    );
    expect(status.upToDate).toBe(true);
    expect(offline.calls).toEqual([]);
    const config = JSON.parse(readFileSync(daemonConfigFile(dir), "utf8"));
    expect(config.imports.stale).toBeUndefined();
    expect(config.imports[PROXY_PKG]).toBeDefined();
    // Build identity must never extend the cooldown window, so the resolution timestamp stays.
    const record = readResolvedVersionRecord(dir);
    expect(record?.buildFingerprint).toBe(daemonConfigFingerprint());
    expect(record?.resolvedAtMs).toBe(NOW_MS - 1000);
    expect(record?.denoDir).toBe(proxyDenoDir(dir));
  });

  test("a record stamped by THIS build leaves the config alone: regenerate once, then stop", async () => {
    seedFloat("1.10.30", NOW_MS - 1000);
    const d = deps(offlineFetch().fetchLike, fakeDeno(["1.10.30"]).runner, WEEK_SECONDS);
    await proxyFloatVerifyStatus(d); // first verify stamps
    const sentinel = '{"imports":{"sentinel":"npm:sentinel@1.0.0"}}\n';
    writeFileSync(daemonConfigFile(dir), sentinel);
    await proxyFloatVerifyStatus(d);
    expect(readFileSync(daemonConfigFile(dir), "utf8")).toBe(sentinel);
  });

  test("the fingerprint is content-sensitive: it moves exactly when the rendered config would", () => {
    const roots = (["a", "b"] as const).map((name) => {
      const root = join(dir, `fp-${name}`);
      mkdirSync(root, { recursive: true });
      return root;
    });
    const [a, b] = roots as [string, string];
    writeFileSync(join(a, "deno.json"), '{"imports":{"x":"npm:x@1.0.0"}}\n');
    writeFileSync(join(b, "deno.json"), '{"imports":{"x":"npm:x@2.0.0"}}\n');
    expect(daemonConfigFingerprint(a)).not.toBe(daemonConfigFingerprint(b));
    // Identical content hashes identically, wherever it lives: the fingerprint is the
    // rendered config's, not the source path's or the build's version string.
    writeFileSync(join(b, "deno.json"), '{"imports":{"x":"npm:x@1.0.0"}}\n');
    expect(daemonConfigFingerprint(b)).toBe(daemonConfigFingerprint(a));
  });

  test("a stamped record whose config file is gone regenerates it", async () => {
    seedFloat("1.10.30", NOW_MS - 1000);
    const d = deps(offlineFetch().fetchLike, fakeDeno(["1.10.30"]).runner, WEEK_SECONDS);
    await proxyFloatVerifyStatus(d); // stamp
    rmSync(daemonConfigFile(dir));
    const status = await proxyFloatVerifyStatus(d);
    expect(existsSync(daemonConfigFile(dir))).toBe(true);
    expect(status.upToDate).toBe(true);
  });

  test("regeneration happens BEFORE the cache probe, so a changed map can trigger the re-warm", async () => {
    // fakeDeno's cache ignores config content, so a regeneration moved AFTER cacheResolves
    // would still pass the other tests, while production would probe the OLD map and skip
    // the re-warm the new map needs. Every probe must already see the regenerated config.
    seedFloat("1.10.30", NOW_MS - 1000);
    writeFileSync(daemonConfigFile(dir), '{"imports":{"stale":"npm:stale@1.0.0"}}\n');
    const probed: string[] = [];
    const runner: DenoRunner = (_command, args, _options) => {
      if (args[0] === "info") probed.push(readFileSync(daemonConfigFile(dir), "utf8"));
      return { "status": 0, "stdout": "", "stderr": "" };
    };
    const status = await proxyFloatVerifyStatus(
      deps(offlineFetch().fetchLike, runner, WEEK_SECONDS),
    );
    expect(status.upToDate).toBe(true);
    expect(probed.length).toBeGreaterThan(0);
    for (const config of probed) {
      expect(JSON.parse(config).imports.stale).toBeUndefined();
    }
  });
});

describe("proxyFloatVerifyStatus", () => {
  // Every row runs offline: the record's state alone (present, cached, fresh, in bounds) must
  // decide the verdict, and only the stale-record rows may reach for the registry.
  const rows: {
    name: string;
    record: { version: string; ageMs: number } | null;
    cached: string[];
    upToDate: boolean;
    message?: string;
    network?: boolean;
  }[] = [
    {
      "name": "install needed when nothing is recorded",
      "record": null,
      "cached": [],
      "upToDate": false,
    },
    {
      "name": "a fresh in-bounds cached record verifies",
      "record": { "version": "1.10.30", "ageMs": 1000 },
      "cached": ["1.10.30"],
      "upToDate": true,
      "network": false,
    },
    {
      "name": "a fresh record whose cache entry is gone needs an install",
      "record": { "version": "1.10.30", "ageMs": 1000 },
      "cached": [],
      "upToDate": false,
      "message": "deno cache",
    },
    {
      "name": "a stale record is kept when the registry is unreachable",
      "record": { "version": "1.10.30", "ageMs": 30 * MILLISECONDS_PER_DAY },
      "cached": ["1.10.30"],
      "upToDate": true,
      "message": "keeping",
      "network": true,
    },
    {
      "name": "a recorded version outside the window needs an update, without network",
      "record": { "version": "1.9.99", "ageMs": 1000 },
      "cached": ["1.9.99"],
      "upToDate": false,
      "message": "1.10.0",
      "network": false,
    },
  ];

  test("the record's presence, cache, age, and bounds decide the offline verdict", async () => {
    for (const row of rows) {
      dir = removeDir(dir);
      dir = isolateProxyHome("copilot-float-");
      if (row.record) seedFloat(row.record.version, NOW_MS - row.record.ageMs);
      const offline = offlineFetch();
      const status = await proxyFloatVerifyStatus(
        deps(offline.fetchLike, fakeDeno(row.cached).runner, WEEK_SECONDS),
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
      deps(same.fetchLike, fakeDeno(["1.10.30"]).runner, WEEK_SECONDS),
    );
    expect(same.calls).toHaveLength(1);
    expect(okStatus.upToDate).toBe(true);

    const moved = docFetch(registryDoc({ "1.10.30": 40, "1.10.31": 8 }));
    const staleStatus = await proxyFloatVerifyStatus(
      deps(moved.fetchLike, fakeDeno(["1.10.30"]).runner, WEEK_SECONDS),
    );
    expect(staleStatus.upToDate).toBe(false);
    expect(staleStatus.message).toContain("1.10.30");
    expect(staleStatus.message).toContain("1.10.31");
  });

  test("COPILOT_API_VERSION: up to date only when the exact pin is recorded and cached", async () => {
    seedFloat("1.10.30", NOW_MS);
    process.env[VERSION_ENV] = "1.10.30";
    const d = deps(offlineFetch().fetchLike, fakeDeno(["1.10.30"]).runner);
    expect((await proxyFloatVerifyStatus(d)).upToDate).toBe(true);

    process.env[VERSION_ENV] = "1.10.31";
    expect((await proxyFloatVerifyStatus(d)).upToDate).toBe(false);

    // A dist-tag pin always re-resolves -> never "up to date".
    process.env[VERSION_ENV] = "latest";
    expect((await proxyFloatVerifyStatus(d)).upToDate).toBe(false);
  });

  test("a pin bypasses the cooldown: a bad COPILOT_API_MIN_RELEASE_AGE is ignored", async () => {
    seedFloat("1.10.30", NOW_MS);
    process.env[VERSION_ENV] = "1.10.30";
    process.env[MIN_RELEASE_AGE_ENV] = "not-a-number"; // would throw if resolved
    const status = await proxyFloatVerifyStatus(
      deps(offlineFetch().fetchLike, fakeDeno(["1.10.30"]).runner),
    );
    expect(status.upToDate).toBe(true);
  });
});

describe("proxyInstallAssertStatus", () => {
  // status.ok carries the verdict; the messages are human copy, so the assertions
  // pin only the identifiers each one must name (the package, the versions).
  const WINDOW_TO_30: ProjectConfig = { "proxyMinVersion": "1.10.0", "proxyMaxVersion": "1.10.30" };
  const SCRIPTED_30 = { "scripts": { "1.10.30": ["install"] } };
  const rows: {
    name: string;
    record: string | null;
    config?: ProjectConfig;
    registry: unknown | "offline";
    cached: string[];
    ok: boolean;
    names: string[];
  }[] = [
    {
      "name": "fails when nothing is recorded",
      "record": null,
      "registry": "offline",
      "cached": [],
      "ok": false,
      "names": [PROXY_PKG],
    },
    {
      "name": "fails below the configured floor",
      "record": "1.9.99",
      "registry": "offline",
      "cached": ["1.9.99"],
      "ok": false,
      "names": ["1.9.99", "1.10.0"],
    },
    {
      "name": "fails above the configured ceiling",
      "record": "1.10.31",
      "config": WINDOW_TO_30,
      "registry": "offline",
      "cached": ["1.10.31"],
      "ok": false,
      "names": ["1.10.31", "1.10.30"],
    },
    {
      "name": "fails when the recorded version is not in the deno cache",
      "record": "1.10.30",
      "registry": registryDoc({ "1.10.30": 8 }),
      "cached": [],
      "ok": false,
      "names": ["deno cache"],
    },
    {
      "name": "passes when the record matches the resolved float target",
      "record": "1.10.15",
      "config": WINDOW_TO_30,
      "registry": registryDoc({ "1.10.15": 8, "1.10.31": 1 }),
      "cached": ["1.10.15"],
      "ok": true,
      "names": [`${PROXY_PKG} 1.10.15`, "1.10.0", "1.10.30"],
    },
    {
      "name": "fails when the record clears the bounds but misses the float target",
      "record": "1.10.31",
      "registry": registryDoc({ "1.10.30": 8, "1.10.31": 1 }),
      "cached": ["1.10.31"],
      "ok": false,
      "names": ["1.10.31", "1.10.30"],
    },
    {
      "name": "falls back to the bounds-only check when the registry is unreachable",
      "record": "1.10.30",
      "registry": "offline",
      "cached": ["1.10.30"],
      "ok": true,
      "names": ["bounds only", "offline", "1.10.30"],
    },
    {
      "name": "a refused newest target passes bounds-only",
      "record": "1.10.29",
      "registry": registryDoc({ "1.10.29": 40, "1.10.30": 8 }, SCRIPTED_30),
      "cached": ["1.10.29"],
      "ok": true,
      "names": ["refused"],
    },
  ];

  test("record, window, registry, and cache decide the verdict and what it names", async () => {
    for (const row of rows) {
      dir = removeDir(dir);
      dir = isolateProxyHome("copilot-float-");
      if (row.record !== null) seedFloat(row.record, NOW_MS);
      const fetchLike = row.registry === "offline"
        ? offlineFetch().fetchLike
        : docFetch(row.registry).fetchLike;
      const status = await proxyInstallAssertStatus({
        ...deps(fetchLike, fakeDeno(row.cached).runner, WEEK_SECONDS),
        "config": row.config ?? CONFIG,
      });
      expect(status.ok, row.name).toBe(row.ok);
      for (const name of row.names) expect(status.message, row.name).toContain(name);
    }
  });

  // An exact pin, from the env or the stored config, asserts recorded == pin and bypasses the
  // bounds; a mismatch or a missing record fails naming both sides.
  // A mismatch fails even when the pinned version itself sits in the cache: the record, not the
  // cache, is what the pin is asserted against.
  const pinRows: {
    name: string;
    env?: string;
    stored?: string;
    record: string | null;
    cached: string[];
    ok: boolean;
    names: string[];
  }[] = [
    {
      "name": "an env pin below the floor passes when recorded",
      "env": "1.9.99",
      "record": "1.9.99",
      "cached": ["1.9.99"],
      "ok": true,
      "names": [`${PROXY_PKG} 1.9.99`],
    },
    {
      "name": "an env pin the record does not match fails",
      "env": "1.10.31",
      "record": "1.9.99",
      "cached": ["1.9.99", "1.10.31"],
      "ok": false,
      "names": ["1.9.99", "1.10.31"],
    },
    {
      "name": "a pin with nothing recorded fails naming the pin",
      "env": "1.10.30",
      "record": null,
      "cached": ["1.10.30"],
      "ok": false,
      "names": [`${PROXY_PKG}@1.10.30`],
    },
    {
      "name": "a stored config pin passes when recorded",
      "stored": "1.10.30",
      "record": "1.10.30",
      "cached": ["1.10.30"],
      "ok": true,
      "names": [],
    },
    {
      "name": "a stored config pin the record does not match fails",
      "stored": "1.10.30",
      "record": "1.10.29",
      "cached": ["1.10.29", "1.10.30"],
      "ok": false,
      "names": ["1.10.29", "1.10.30"],
    },
  ];

  test("an exact pin asserts recorded == pin, bypassing bounds, from the env or the store", async () => {
    for (const row of pinRows) {
      dir = removeDir(dir);
      dir = isolateProxyHome("copilot-float-");
      if (row.env) process.env[VERSION_ENV] = row.env;
      else delete process.env[VERSION_ENV];
      if (row.stored) new CopilotEnvConfig().set({ "daemon.version": row.stored });
      if (row.record !== null) seedFloat(row.record, NOW_MS);
      const status = await proxyInstallAssertStatus(
        deps(offlineFetch().fetchLike, fakeDeno(row.cached).runner),
      );
      expect(status.ok, row.name).toBe(row.ok);
      for (const name of row.names) expect(status.message, row.name).toContain(name);
    }
  });

  test("a non-semver tag pin is not equality-checked", async () => {
    seedFloat("1.10.30", NOW_MS);
    process.env[VERSION_ENV] = "latest";
    const status = await proxyInstallAssertStatus(
      deps(offlineFetch().fetchLike, fakeDeno(["1.10.30"]).runner),
    );
    expect(status.ok).toBe(true);
    expect(status.message).toContain("latest");
  });

  test("a pin bypasses the cooldown: a bad COPILOT_API_MIN_RELEASE_AGE is ignored", async () => {
    seedFloat("1.9.99", NOW_MS);
    process.env[VERSION_ENV] = "1.9.99";
    process.env[MIN_RELEASE_AGE_ENV] = "not-a-number"; // would throw if resolved
    const status = await proxyInstallAssertStatus(
      deps(offlineFetch().fetchLike, fakeDeno(["1.9.99"]).runner),
    );
    expect(status.ok).toBe(true);
  });
});

describe("writeDaemonConfig", () => {
  test("carries the import map but DROPS lock and nodeModulesDir", () => {
    // Both omissions are load-bearing, and both were live launch failures before:
    //   - a frozen `lock` rejects `npm:<proxy>@<floated version>` ("lockfile is out of
    //     date"), because only the caret range is in deno.lock;
    //   - `nodeModulesDir` routes resolution through a node_modules tree a compiled
    //     install does not have.
    writeDaemonConfig(dir, ROOT);
    const config = JSON.parse(readFileSync(daemonConfigFile(dir), "utf8"));

    expect(config.imports[PROXY_PKG]).toBeDefined();
    expect(config.lock).toBeUndefined();
    expect(config.nodeModulesDir).toBeUndefined();

    // The import map must be complete, not just the proxy: the preload shims resolve
    // their OWN imports through it, and `--cached-only` gives no second chance.
    const source = JSON.parse(readFileSync(join(ROOT, "deno.json"), "utf8"));
    expect(Object.keys(config.imports).sort()).toEqual(Object.keys(source.imports).sort());
  });

  test("the float writes it before caching", async () => {
    // Captured inside the runner's cache call: `deno cache` resolves through this config, so
    // one written after the warm would leave the cache built against nothing, and an
    // existsSync after floatProxy returned could not tell the difference.
    const seen: string[] = [];
    const inner = fakeDeno();
    const runner: DenoRunner = (command, args, options) => {
      if (args[0] === "cache") seen.push(readFileSync(daemonConfigFile(dir), "utf8"));
      return inner.runner(command, args, options);
    };
    await floatProxy(deps(docFetch(registryDoc({ "1.10.30": 8 })).fetchLike, runner, 0));
    expect(seen.length).toBeGreaterThan(0);
    for (const config of seen) {
      expect(JSON.parse(config).imports[PROXY_PKG]).toBeDefined();
    }
  });
});

// A compiled install root has no deno.json on disk (the checkout marker), so both no-float
// spawn paths (a COPILOT_API_ENTRY override, the mapped package fallback) must generate the
// daemon config from the embedded assets. The mode is injected because the suite always runs
// in checkout mode; the installer smoke covers the ambient default against a real binary.
describe("resolveCopilotApiEntry on a compiled root", () => {
  const compiledMode = () => ({ "kind": "compiled", "root": join(dir, "install-root") }) as const;

  test("both no-float entries resolve under a daemon config generated from the embedded assets", () => {
    const fallback = resolveCopilotApiEntry(compiledMode());
    expect(fallback.kind).toBe("package");
    expect(fallback.configFile).toBe(daemonConfigFile(dir));
    const config = JSON.parse(readFileSync(daemonConfigFile(dir), "utf8"));
    expect(config.imports[PROXY_PKG]).toBeDefined();
    expect(config.lock).toBeUndefined();

    rmSync(daemonConfigFile(dir));
    process.env.COPILOT_API_ENTRY = join(dir, "fake-proxy.mjs");
    try {
      expect(resolveCopilotApiEntry(compiledMode())).toEqual({
        "kind": "file",
        "path": join(dir, "fake-proxy.mjs"),
        "configFile": daemonConfigFile(dir),
      });
      expect(existsSync(daemonConfigFile(dir))).toBe(true);
    } finally {
      delete process.env.COPILOT_API_ENTRY;
    }
  });

  test("a stale or foreign daemon config is regenerated, not trusted", () => {
    // The float rewrites this file with the same content on every warm; the
    // resolver regenerates it too, so no leftover can steer a compiled spawn.
    const sentinel = '{"imports":{"sentinel":"npm:sentinel@1.0.0"}}\n';
    mkdirSync(join(dir, "proxy"), { recursive: true });
    writeFileSync(daemonConfigFile(dir), sentinel);
    const entry = resolveCopilotApiEntry(compiledMode());
    expect(entry.configFile).toBe(daemonConfigFile(dir));
    const config = JSON.parse(readFileSync(daemonConfigFile(dir), "utf8"));
    expect(config.imports.sentinel).toBeUndefined();
    expect(config.imports[PROXY_PKG]).toBeDefined();
  });

  test("a checkout root keeps the on-disk fallback, with no write side effect", () => {
    const entry = resolveCopilotApiEntry({ "kind": "checkout", "root": ROOT });
    expect(entry.kind).toBe("package");
    expect(entry.configFile).toBe(join(ROOT, "deno.json"));
    expect(existsSync(daemonConfigFile(dir))).toBe(false);
  });
});

describe("removeProxyFloatArtifacts", () => {
  test("removes the record, the cache it points at, and OUR .npmrc", async () => {
    const deno = fakeDeno();
    await floatProxy(deps(docFetch(registryDoc({ "1.10.30": 8 })).fetchLike, deno.runner, 0));
    mkdirSync(proxyDenoDir(dir), { "recursive": true });
    expect(existsSync(resolvedVersionFile(dir))).toBe(true);
    expect(existsSync(join(dir, ".npmrc"))).toBe(true);

    removeProxyFloatArtifacts(dir);
    expect(existsSync(resolvedVersionFile(dir))).toBe(false);
    expect(existsSync(proxyDenoDir(dir))).toBe(false);
    expect(existsSync(join(dir, ".npmrc"))).toBe(false);
  });

  test("a cache recorded OUTSIDE the root home is still removed", () => {
    // Deleting the root home alone would strand it, which is the whole reason
    // uninstall goes through here first.
    const elsewhere = join(dir, "..", `float-elsewhere-${Date.now()}`);
    mkdirSync(elsewhere, { "recursive": true });
    seedFloat("1.10.30", NOW_MS, elsewhere);

    removeProxyFloatArtifacts(dir);
    expect(existsSync(elsewhere)).toBe(false);
  });

  test("an unmarked user .npmrc survives, exactly as the float refused to write it", () => {
    writeFileSync(join(dir, ".npmrc"), "registry=https://example.test\n");
    removeProxyFloatArtifacts(dir);
    expect(readFileSync(join(dir, ".npmrc"), "utf8")).toBe("registry=https://example.test\n");
  });
});

// proxyFloatSkips backs the health engine's Direct-only skip report.
// The wiring-level answer (proxyUnusedEverywhere) and its edge cases live in
// test/agents_wiring.test.ts; this pins the env-pin override the float adds.
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
        "apiKeyHelper": directHelperCommand(),
        "env": { "ANTHROPIC_BASE_URL": "https://api.githubcopilot.com" },
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
  // Every other test here asserts the SHAPE of the argv, and a well-shaped argv no deno would
  // run (frozen lock, import map incomplete under --cached-only) once passed both gates. The
  // fixture is genuine float output built by scripts/warm-proxy-cache.ts while the container
  // image still has a network, which keeps this offline and deterministic. In CI and the
  // container the fixture always exists; a checkout without it (build one with
  // `deno run -A scripts/warm-proxy-cache.ts`) reports this test ignored, never passed.
  const record = readResolvedVersionRecord(PROXY_CACHE_FIXTURE);
  test.skipIf(record === null)(
    "a real floated install actually launches the proxy, with no node_modules",
    () => {
      if (record === null) throw new Error("unreachable: the fixture gate skipped this test");
      process.env.COPILOT_API_HOME = PROXY_CACHE_FIXTURE;
      const entry = resolveCopilotApiEntry();
      if (entry.kind !== "floated") throw new Error(`expected a floated entry, got ${entry.kind}`);
      expect(entry.version).toBe(record.version);

      // Merged over our own environment, as daemonEnvironment does in production: a child
      // stripped of PATH/HOME would test something the daemon never does.
      const result = runSync(Deno.execPath(), copilotApiArgv(["--help"], [], entry), {
        env: { ...process.env, ...copilotApiEnv(entry) },
        timeoutMs: 120_000,
      });
      const output = `${result.stdout}${result.stderr}`;
      // Resolution: config, lockfile and cache must let deno assemble the whole graph offline.
      // Both defects this test was written for surfaced exactly here.
      expect(output).not.toContain("not found in cache");
      expect(output).not.toContain("lockfile is out of date");
      expect(output).not.toContain("Module not found");

      // On Linux the launch completes only because every spawn preloads the node-compat shim:
      // the proxy probes /proc at module load, which deno answers with a thrown NotCapable
      // under any permission set short of all-access. The output rides in the assertion so
      // a failure says WHY deno refused; the refusals this catches are all in stderr.
      expect(`exit=${result.exitCode} ${output}`).toContain("exit=0");
      expect(output).toContain("copilot-api");
    },
  );
});
