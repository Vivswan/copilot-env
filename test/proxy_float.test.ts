import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DIRECT_HELPER_NAME } from "../src/claude/paths.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import {
  daemonConfigFile,
  DEFAULT_RELEASE_COOLDOWN_SECONDS,
  type DenoRunner,
  ensureProxyNpmrc,
  type FetchLike,
  floatProxy,
  minimumDependencyAgeArg,
  NPMRC_MARKER,
  parseRegistryDoc,
  proxyDenoDir,
  proxyFloatSkips,
  proxyFloatVerifyStatus,
  proxyInstallAssertStatus,
  pruneProxyCache,
  readResolvedVersionRecord,
  removeProxyFloatArtifacts,
  resolvedVersionFile,
  resolveMinimumReleaseAgeSeconds,
  selectProxyVersion,
  writeDaemonConfig,
  writeResolvedVersionRecord,
} from "../src/proxy_float.ts";
import { DAEMON_SHIM_FILES } from "../src/copilot_api/shims.ts";
import type { ProjectConfig } from "../src/utils/project_config.ts";
import { MILLISECONDS_PER_DAY } from "../src/utils/time.ts";
import { afterEach, beforeEach, describe, expect, test } from "./helpers/testing.ts";
import { ROOT } from "./helpers/run.ts";
import { envSnapshot, isolateProxyHome, removeDir } from "./helpers.ts";

// The float resolves the proxy into a Deno npm cache under the root home and
// records the resolution in resolved-version.json -- the freshness oracle the
// bin shims' `--verify` fast path reads.

const PROXY_PKG = "@jeffreycao/copilot-api";
const NOW_MS = Date.parse("2026-06-10T00:00:00.000Z");
const WEEK_SECONDS = 604800;

const CONFIG: ProjectConfig = {
  "proxyMinVersion": "1.10.0",
  "proxyMaxVersion": null,
};

const MIN_RELEASE_AGE_ENV = "COPILOT_API_MIN_RELEASE_AGE";
const VERSION_ENV = "COPILOT_API_VERSION";

let dir = "";
const restoreEnv = envSnapshot([MIN_RELEASE_AGE_ENV]);

function isoDaysAgo(days: number): string {
  return new Date(NOW_MS - days * MILLISECONDS_PER_DAY).toISOString();
}

/** A raw registry document: versions keyed by days-ago, optional per-version
 *  lifecycle scripts / hasInstallScript flags, optional dist-tags. */
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

/** A fake deno sidecar with an in-memory cache: `cache` populates it (unless
 *  told to fail), `info` answers from it, `clean` succeeds. */
function fakeDeno(
  initialCached: string[] = [],
  opts: { cacheExit?: number } = {},
): { calls: DenoCall[]; cached: Set<string>; runner: DenoRunner } {
  const cached = new Set(initialCached);
  const calls: DenoCall[] = [];
  const runner: DenoRunner = (command, args, options) => {
    calls.push({ command, "args": [...args], "cwd": options.cwd, "env": options.env });
    const spec = args[args.length - 1] ?? "";
    const prefix = `npm:${PROXY_PKG}@`;
    const version = spec.startsWith(prefix) ? spec.slice(prefix.length) : "";
    if (args[0] === "cache") {
      if (opts.cacheExit) return { "status": opts.cacheExit, "stdout": "", "stderr": "boom" };
      cached.add(version);
      return { "status": 0, "stdout": "", "stderr": "" };
    }
    if (args[0] === "info") {
      return { "status": cached.has(version) ? 0 : 1, "stdout": "", "stderr": "" };
    }
    return { "status": 0, "stdout": "", "stderr": "" };
  };
  return { calls, cached, runner };
}

/** The `cache` spawns a float made. Each successful float warms TWO graphs into the
 *  DENO_DIR -- the proxy package, then the preload shims -- because the daemon spawn
 *  resolves both under `--cached-only`. */
function cacheCalls(calls: DenoCall[]): DenoCall[] {
  return calls.filter((c) => c.args[0] === "cache");
}

/** Just the proxy-package warm (its last arg is the npm specifier). */
function proxyCacheCalls(calls: DenoCall[]): DenoCall[] {
  return cacheCalls(calls).filter((c) => (c.args[c.args.length - 1] ?? "").startsWith("npm:"));
}

/** Just the preload-shim warm (its trailing args are shim file paths). */
function shimCacheCalls(calls: DenoCall[]): DenoCall[] {
  return cacheCalls(calls).filter((c) => !(c.args[c.args.length - 1] ?? "").startsWith("npm:"));
}

/** Deps every float/verify/assert invocation in this file shares. */
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
});

afterEach(() => {
  restoreEnv();
  dir = removeDir(dir);
});

describe("selectProxyVersion", () => {
  const doc = (raw: unknown) => parseRegistryDoc(raw);

  test("picks the newest cooldown-aged release inside the window", () => {
    const sel = selectProxyVersion(
      doc(registryDoc({ "1.10.29": 30, "1.10.30": 8, "1.10.31": 1 })),
      CONFIG,
      WEEK_SECONDS,
      NOW_MS,
    );
    expect(sel).toEqual({
      "kind": "resolved",
      "version": "1.10.30",
      "publishedAtMs": NOW_MS - 8 * MILLISECONDS_PER_DAY,
      "reason": expect.stringContaining("1.10.30"),
    });
  });

  test("cooldown 0 selects the newest release", () => {
    const sel = selectProxyVersion(
      doc(registryDoc({ "1.10.30": 8, "1.10.31": 1 })),
      CONFIG,
      0,
      NOW_MS,
    );
    expect(sel.kind).toBe("resolved");
    if (sel.kind === "resolved") expect(sel.version).toBe("1.10.31");
  });

  test("clamps up to the floor and down to the ceiling", () => {
    const up = selectProxyVersion(
      doc(registryDoc({ "1.10.29": 8, "1.10.30": 8 })),
      { "proxyMinVersion": "1.10.30", "proxyMaxVersion": null },
      WEEK_SECONDS,
      NOW_MS,
    );
    expect(up.kind).toBe("resolved");
    if (up.kind === "resolved") expect(up.version).toBe("1.10.30");

    const down = selectProxyVersion(
      doc(registryDoc({ "1.10.29": 8, "1.10.30": 8 })),
      { "proxyMinVersion": "1.10.0", "proxyMaxVersion": "1.10.29" },
      WEEK_SECONDS,
      NOW_MS,
    );
    expect(down.kind).toBe("resolved");
    if (down.kind === "resolved") expect(down.version).toBe("1.10.29");
  });

  test("no aged release falls back to the floor", () => {
    const sel = selectProxyVersion(
      doc(registryDoc({ "1.10.0": 200, "1.10.31": 1 })),
      CONFIG,
      WEEK_SECONDS,
      NOW_MS,
    );
    expect(sel.kind).toBe("resolved");
    if (sel.kind === "resolved") expect(sel.version).toBe("1.10.0");
  });

  test("a floor that is not published is unavailable, never trusted blind", () => {
    const sel = selectProxyVersion(
      doc(registryDoc({ "1.10.31": 1 })),
      CONFIG,
      WEEK_SECONDS,
      NOW_MS,
    );
    expect(sel.kind).toBe("unavailable");
    if (sel.kind === "unavailable") expect(sel.reason).toContain("1.10.0");
  });

  test("a target declaring lifecycle scripts is refused, naming them", () => {
    const sel = selectProxyVersion(
      doc(registryDoc({ "1.10.30": 8 }, { "scripts": { "1.10.30": ["postinstall"] } })),
      CONFIG,
      WEEK_SECONDS,
      NOW_MS,
    );
    expect(sel).toEqual({
      "kind": "refused",
      "version": "1.10.30",
      "lifecycleScripts": ["postinstall"],
      "reason": expect.stringContaining("1.10.30"),
    });
  });

  test("the hasInstallScript flag alone also refuses", () => {
    const sel = selectProxyVersion(
      doc(registryDoc({ "1.10.30": 8 }, { "hasInstallScript": ["1.10.30"] })),
      CONFIG,
      WEEK_SECONDS,
      NOW_MS,
    );
    expect(sel.kind).toBe("refused");
  });
});

describe("parseRegistryDoc", () => {
  test("rejects a malformed document whole", () => {
    expect(() => parseRegistryDoc({ "versions": "nope" })).toThrow("expected shape");
    expect(() => parseRegistryDoc(null)).toThrow("expected shape");
  });

  test("drops versions without a parseable publish time", () => {
    const raw = registryDoc({ "1.10.30": 8 }) as { time: Record<string, string> };
    raw.time["1.10.30"] = "not-a-date";
    const doc = parseRegistryDoc(raw);
    expect(doc.releases.has("1.10.30")).toBe(false);
  });
});

describe("resolveMinimumReleaseAgeSeconds", () => {
  test("defaults to the built-in 7-day cooldown", () => {
    expect(resolveMinimumReleaseAgeSeconds()).toBe(DEFAULT_RELEASE_COOLDOWN_SECONDS);
    expect(DEFAULT_RELEASE_COOLDOWN_SECONDS).toBe(WEEK_SECONDS);
  });

  test("config releaseCooldown overrides the default, env overrides the config", () => {
    new CopilotEnvConfig().set({ releaseCooldown: 172800 });
    expect(resolveMinimumReleaseAgeSeconds()).toBe(172800);
    process.env[MIN_RELEASE_AGE_ENV] = "100";
    expect(resolveMinimumReleaseAgeSeconds()).toBe(100);
    process.env[MIN_RELEASE_AGE_ENV] = "0";
    expect(resolveMinimumReleaseAgeSeconds()).toBe(0);
  });

  test("a non-numeric env value throws", () => {
    process.env[MIN_RELEASE_AGE_ENV] = "abc";
    expect(() => resolveMinimumReleaseAgeSeconds()).toThrow("whole number of seconds");
  });
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
    });
  });

  test("skips the cache write when the recorded target is already cached", async () => {
    writeResolvedVersionRecord(dir, "1.10.30", NOW_MS - 30 * MILLISECONDS_PER_DAY);
    const { fetchLike } = docFetch(registryDoc({ "1.10.30": 8, "1.10.31": 1 }));
    const deno = fakeDeno(["1.10.30"]);

    await floatProxy(deps(fetchLike, deno.runner, WEEK_SECONDS));

    expect(cacheCalls(deno.calls)).toEqual([]);
    // The record's timestamp refreshes so --verify stays on its offline fast path.
    expect(readResolvedVersionRecord(dir)?.resolvedAtMs).toBe(NOW_MS);
  });

  test("a timestamp refresh preserves the record's own cache dir", async () => {
    const elsewhere = join(dir, "old-cache");
    writeResolvedVersionRecord(dir, "1.10.30", NOW_MS - 30 * MILLISECONDS_PER_DAY, elsewhere);
    const { fetchLike } = docFetch(registryDoc({ "1.10.30": 8 }));
    const deno = fakeDeno(["1.10.30"]);

    await floatProxy(deps(fetchLike, deno.runner, WEEK_SECONDS));

    // The cache probe ran against the recorded dir, and the refreshed record
    // still points there -- never silently rewritten to the current dir.
    expect(deno.calls[0]?.env.DENO_DIR).toBe(elsewhere);
    expect(readResolvedVersionRecord(dir)?.denoDir).toBe(elsewhere);
  });

  test("re-caches when the record matches but the cache entry is gone", async () => {
    writeResolvedVersionRecord(dir, "1.10.30", NOW_MS);
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
    writeResolvedVersionRecord(dir, "1.10.29", NOW_MS - 30 * MILLISECONDS_PER_DAY);
    const { fetchLike } = docFetch(
      registryDoc({ "1.10.29": 40, "1.10.30": 8 }, { "scripts": { "1.10.30": ["install"] } }),
    );
    const deno = fakeDeno(["1.10.29"]);

    await floatProxy(deps(fetchLike, deno.runner, WEEK_SECONDS));

    expect(cacheCalls(deno.calls)).toEqual([]);
    expect(readResolvedVersionRecord(dir)?.version).toBe("1.10.29");
  });

  test("registry failure keeps a usable recorded version above the floor", async () => {
    writeResolvedVersionRecord(dir, "1.10.30", NOW_MS - 30 * MILLISECONDS_PER_DAY);
    const deno = fakeDeno(["1.10.30"]);

    await floatProxy(deps(offlineFetch().fetchLike, deno.runner, WEEK_SECONDS));

    expect(cacheCalls(deno.calls)).toEqual([]);
  });

  test("registry failure installs the floor when nothing usable is recorded", async () => {
    const deno = fakeDeno();

    await floatProxy({
      ...deps(offlineFetch().fetchLike, deno.runner, WEEK_SECONDS),
      "config": { "proxyMinVersion": "1.10.30", "proxyMaxVersion": null },
    });

    const cache = proxyCacheCalls(deno.calls);
    expect(cache).toHaveLength(1);
    expect(cache[0]?.args[cache[0].args.length - 1]).toBe(`npm:${PROXY_PKG}@1.10.30`);
    expect(readResolvedVersionRecord(dir)?.version).toBe("1.10.30");
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
    writeResolvedVersionRecord(dir, "1.10.30", NOW_MS - 30 * MILLISECONDS_PER_DAY);
    const deno = fakeDeno(["1.10.30"]);

    await floatProxy(deps(offlineFetch().fetchLike, deno.runner));

    expect(cacheCalls(deno.calls)).toEqual([]);
  });

  test("a stored proxy-version config pin applies; the env pin wins over it", async () => {
    new CopilotEnvConfig().set({ proxyVersion: "1.10.29" });
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

  test("never clobbers an unmarked user .npmrc", () => {
    writeFileSync(join(dir, ".npmrc"), "registry=https://example.test\n");
    expect(ensureProxyNpmrc(dir).kind).toBe("kept-foreign");
    expect(readFileSync(join(dir, ".npmrc"), "utf8")).toBe("registry=https://example.test\n");
  });

  test("floatProxy writes it before installing", async () => {
    const deno = fakeDeno();
    await floatProxy(deps(docFetch(registryDoc({ "1.10.30": 8 })).fetchLike, deno.runner, 0));
    expect(readFileSync(join(dir, ".npmrc"), "utf8")).toContain(NPMRC_MARKER);
  });
});

describe("resolved-version record", () => {
  test("round-trips through its schema", () => {
    writeResolvedVersionRecord(dir, "1.10.30", NOW_MS);
    expect(readResolvedVersionRecord(dir)).toEqual({
      "version": "1.10.30",
      "resolvedAtMs": NOW_MS,
      "denoDir": proxyDenoDir(dir),
    });
    // The on-disk keys are the external contract.
    const raw = JSON.parse(readFileSync(resolvedVersionFile(dir), "utf8"));
    expect(Object.keys(raw).sort()).toEqual(["deno_dir", "resolved_at_ms", "version"]);
  });

  test("absent, malformed, or ill-shaped records read as null", () => {
    expect(readResolvedVersionRecord(dir)).toBeNull();
    mkdirSync(join(dir, "proxy"), { recursive: true });
    writeFileSync(resolvedVersionFile(dir), "not json");
    expect(readResolvedVersionRecord(dir)).toBeNull();
    writeFileSync(resolvedVersionFile(dir), JSON.stringify({ "version": "not-a-version" }));
    expect(readResolvedVersionRecord(dir)).toBeNull();
  });
});

describe("proxyFloatVerifyStatus", () => {
  test("install needed when nothing is recorded", async () => {
    const status = await proxyFloatVerifyStatus(deps(offlineFetch().fetchLike, fakeDeno().runner));
    expect(status.upToDate).toBe(false);
  });

  test("a fresh in-bounds cached record verifies offline", async () => {
    writeResolvedVersionRecord(dir, "1.10.30", NOW_MS - 1000);
    const offline = offlineFetch();
    const status = await proxyFloatVerifyStatus(
      deps(offline.fetchLike, fakeDeno(["1.10.30"]).runner, WEEK_SECONDS),
    );
    expect(status.upToDate).toBe(true);
    expect(offline.calls).toEqual([]); // no network on the fast path
  });

  test("a fresh record whose cache entry is gone needs an install", async () => {
    writeResolvedVersionRecord(dir, "1.10.30", NOW_MS - 1000);
    const status = await proxyFloatVerifyStatus(
      deps(offlineFetch().fetchLike, fakeDeno().runner, WEEK_SECONDS),
    );
    expect(status.upToDate).toBe(false);
    expect(status.message).toContain("deno cache");
  });

  test("a stale record re-checks the registry", async () => {
    writeResolvedVersionRecord(dir, "1.10.30", NOW_MS - 30 * MILLISECONDS_PER_DAY);
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

  test("a stale record verifies as kept when the registry is unreachable", async () => {
    writeResolvedVersionRecord(dir, "1.10.30", NOW_MS - 30 * MILLISECONDS_PER_DAY);
    const status = await proxyFloatVerifyStatus(
      deps(offlineFetch().fetchLike, fakeDeno(["1.10.30"]).runner, WEEK_SECONDS),
    );
    expect(status.upToDate).toBe(true);
    expect(status.message).toContain("keeping");
  });

  test("a recorded version outside the window needs an update, without network", async () => {
    writeResolvedVersionRecord(dir, "1.9.99", NOW_MS - 1000);
    const offline = offlineFetch();
    const status = await proxyFloatVerifyStatus(
      deps(offline.fetchLike, fakeDeno(["1.9.99"]).runner, WEEK_SECONDS),
    );
    expect(status.upToDate).toBe(false);
    expect(status.message).toContain("1.10.0");
    expect(offline.calls).toEqual([]);
  });

  test("COPILOT_API_VERSION: up to date only when the exact pin is recorded and cached", async () => {
    writeResolvedVersionRecord(dir, "1.10.30", NOW_MS);
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
    writeResolvedVersionRecord(dir, "1.10.30", NOW_MS);
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
  test("fails when nothing is recorded", async () => {
    const status = await proxyInstallAssertStatus(
      deps(offlineFetch().fetchLike, fakeDeno().runner),
    );
    expect(status.ok).toBe(false);
    expect(status.message).toContain(PROXY_PKG);
  });

  test("fails outside the configured window", async () => {
    writeResolvedVersionRecord(dir, "1.9.99", NOW_MS);
    const below = await proxyInstallAssertStatus(
      deps(offlineFetch().fetchLike, fakeDeno(["1.9.99"]).runner),
    );
    expect(below.ok).toBe(false);
    expect(below.message).toContain("1.9.99");
    expect(below.message).toContain("1.10.0");

    writeResolvedVersionRecord(dir, "1.10.31", NOW_MS);
    const above = await proxyInstallAssertStatus({
      ...deps(offlineFetch().fetchLike, fakeDeno(["1.10.31"]).runner),
      "config": { "proxyMinVersion": "1.10.0", "proxyMaxVersion": "1.10.30" },
    });
    expect(above.ok).toBe(false);
    expect(above.message).toContain("1.10.31");
    expect(above.message).toContain("1.10.30");
  });

  test("fails when the recorded version is not in the deno cache", async () => {
    writeResolvedVersionRecord(dir, "1.10.30", NOW_MS);
    const status = await proxyInstallAssertStatus(
      deps(docFetch(registryDoc({ "1.10.30": 8 })).fetchLike, fakeDeno().runner, WEEK_SECONDS),
    );
    expect(status.ok).toBe(false);
    expect(status.message).toContain("deno cache");
  });

  test("passes when the record matches the resolved float target", async () => {
    writeResolvedVersionRecord(dir, "1.10.15", NOW_MS);
    const status = await proxyInstallAssertStatus({
      ...deps(
        docFetch(registryDoc({ "1.10.15": 8, "1.10.31": 1 })).fetchLike,
        fakeDeno(["1.10.15"]).runner,
        WEEK_SECONDS,
      ),
      "config": { "proxyMinVersion": "1.10.0", "proxyMaxVersion": "1.10.30" },
    });
    expect(status.ok).toBe(true);
    expect(status.message).toContain(`${PROXY_PKG} 1.10.15`);
    expect(status.message).toContain("1.10.0");
    expect(status.message).toContain("1.10.30");
  });

  test("fails when the record clears the bounds but misses the float target", async () => {
    writeResolvedVersionRecord(dir, "1.10.31", NOW_MS);
    const status = await proxyInstallAssertStatus(
      deps(
        docFetch(registryDoc({ "1.10.30": 8, "1.10.31": 1 })).fetchLike,
        fakeDeno(["1.10.31"]).runner,
        WEEK_SECONDS,
      ),
    );
    expect(status.ok).toBe(false);
    expect(status.message).toContain("1.10.31");
    expect(status.message).toContain("1.10.30");
  });

  test("falls back to the bounds-only check when the registry is unreachable", async () => {
    writeResolvedVersionRecord(dir, "1.10.30", NOW_MS);
    const status = await proxyInstallAssertStatus(
      deps(offlineFetch().fetchLike, fakeDeno(["1.10.30"]).runner, WEEK_SECONDS),
    );
    expect(status.ok).toBe(true);
    expect(status.message).toContain("bounds only");
    expect(status.message).toContain("offline");
    expect(status.message).toContain("1.10.30");
  });

  test("a refused newest target passes bounds-only", async () => {
    writeResolvedVersionRecord(dir, "1.10.29", NOW_MS);
    const status = await proxyInstallAssertStatus(
      deps(
        docFetch(
          registryDoc({ "1.10.29": 40, "1.10.30": 8 }, { "scripts": { "1.10.30": ["install"] } }),
        ).fetchLike,
        fakeDeno(["1.10.29"]).runner,
        WEEK_SECONDS,
      ),
    );
    expect(status.ok).toBe(true);
    expect(status.message).toContain("refused");
  });

  test("an exact pin asserts recorded == pin, bypassing bounds", async () => {
    writeResolvedVersionRecord(dir, "1.9.99", NOW_MS); // below the floor on purpose
    process.env[VERSION_ENV] = "1.9.99";
    const ok = await proxyInstallAssertStatus(
      deps(offlineFetch().fetchLike, fakeDeno(["1.9.99"]).runner),
    );
    expect(ok.ok).toBe(true);
    expect(ok.message).toContain(`${PROXY_PKG} 1.9.99`);

    process.env[VERSION_ENV] = "1.10.31";
    const bad = await proxyInstallAssertStatus(
      deps(offlineFetch().fetchLike, fakeDeno(["1.9.99"]).runner),
    );
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain("1.9.99");
    expect(bad.message).toContain("1.10.31");
  });

  test("a non-semver tag pin is not equality-checked", async () => {
    writeResolvedVersionRecord(dir, "1.10.30", NOW_MS);
    process.env[VERSION_ENV] = "latest";
    const status = await proxyInstallAssertStatus(
      deps(offlineFetch().fetchLike, fakeDeno(["1.10.30"]).runner),
    );
    expect(status.ok).toBe(true);
    expect(status.message).toContain("latest");
  });

  test("a pin with nothing recorded fails naming the pin", async () => {
    process.env[VERSION_ENV] = "1.10.30";
    const status = await proxyInstallAssertStatus(
      deps(offlineFetch().fetchLike, fakeDeno().runner),
    );
    expect(status.ok).toBe(false);
    expect(status.message).toContain(`${PROXY_PKG}@1.10.30`);
  });

  test("a stored proxy-version config pin is asserted like the env pin", async () => {
    new CopilotEnvConfig().set({ proxyVersion: "1.10.30" });
    writeResolvedVersionRecord(dir, "1.10.30", NOW_MS);
    const d = deps(offlineFetch().fetchLike, fakeDeno(["1.10.30", "1.10.29"]).runner);
    expect((await proxyInstallAssertStatus(d)).ok).toBe(true);

    writeResolvedVersionRecord(dir, "1.10.29", NOW_MS);
    const status = await proxyInstallAssertStatus(d);
    expect(status.ok).toBe(false);
    expect(status.message).toContain("1.10.29");
    expect(status.message).toContain("1.10.30");
  });

  test("a pin bypasses the cooldown: a bad COPILOT_API_MIN_RELEASE_AGE is ignored", async () => {
    writeResolvedVersionRecord(dir, "1.9.99", NOW_MS);
    process.env[VERSION_ENV] = "1.9.99";
    process.env[MIN_RELEASE_AGE_ENV] = "not-a-number"; // would throw if resolved
    const status = await proxyInstallAssertStatus(
      deps(offlineFetch().fetchLike, fakeDeno(["1.9.99"]).runner),
    );
    expect(status.ok).toBe(true);
  });
});

describe("pruneProxyCache", () => {
  test("constructs the deno clean --except command against the record's cache", () => {
    const deno = fakeDeno();
    pruneProxyCache(
      { "version": "1.10.30", "resolvedAtMs": NOW_MS, "denoDir": proxyDenoDir(dir) },
      { "rootHome": dir, "denoBin": "deno-test", "runner": deno.runner },
    );
    expect(deno.calls).toHaveLength(1);
    expect(deno.calls[0]?.args).toEqual(["clean", "--except", `npm:${PROXY_PKG}@1.10.30`]);
    // clean rejects --no-config, so the spawn's cwd and env are the ONLY guards
    // against config discovery (which would delete from a found project's
    // node_modules): pin the whole overlay and the cwd, not just DENO_DIR.
    expect(deno.calls[0]?.cwd).toBe(dir);
    expect(deno.calls[0]?.env).toEqual({
      "DENO_DIR": proxyDenoDir(dir),
      "DENO_NO_UPDATE_CHECK": "1",
      "DENO_NO_PACKAGE_JSON": "1",
    });
  });

  test("a successful float sweeps the superseded trees, keeping what it just resolved", async () => {
    const deno = fakeDeno();
    await floatProxy(deps(docFetch(registryDoc({ "1.10.30": 8 })).fetchLike, deno.runner, 0));
    const clean = deno.calls.filter((c) => c.args[0] === "clean");
    expect(clean).toHaveLength(1);
    expect(clean[0]?.args).toEqual(["clean", "--except", `npm:${PROXY_PKG}@1.10.30`]);
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
    const deno = fakeDeno();
    await floatProxy(deps(docFetch(registryDoc({ "1.10.30": 8 })).fetchLike, deno.runner, 0));
    expect(existsSync(daemonConfigFile(dir))).toBe(true);
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
    writeResolvedVersionRecord(dir, "1.10.30", NOW_MS, elsewhere);

    removeProxyFloatArtifacts(dir);
    expect(existsSync(elsewhere)).toBe(false);
  });

  test("an unmarked user .npmrc survives, exactly as the float refused to write it", () => {
    writeFileSync(join(dir, ".npmrc"), "registry=https://example.test\n");
    removeProxyFloatArtifacts(dir);
    expect(readFileSync(join(dir, ".npmrc"), "utf8")).toBe("registry=https://example.test\n");
  });
});

describe("minimumDependencyAgeArg", () => {
  test("0 disables; anything else is an ISO-8601 duration in seconds", () => {
    expect(minimumDependencyAgeArg(0)).toBe("0");
    expect(minimumDependencyAgeArg(WEEK_SECONDS)).toBe("PT604800S");
  });
});

// proxyFloatSkips backs the Direct-only no-op in the proxy_float entry points.
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
        "apiKeyHelper": join(claudeHome, DIRECT_HELPER_NAME),
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
