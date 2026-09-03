import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  classifyPidFromRows,
  copilotApiArgv,
  DAEMON_GH_TOKEN_ENV,
  DAEMON_SIGKILL_GRACE_MS,
  daemonArgv,
  daemonEnvironment,
  type DaemonSpec,
  isDaemonCommandLine,
  isDaemonProcess,
  launchDaemon,
  noProxyWithLoopback,
  parseProcessRows,
  pidAlive,
  resolveCopilotApiEntry,
} from "../src/copilot_api/process.ts";
import { parseAbsolutePath } from "../src/copilot_api/sidecar.ts";
import { DAEMON_INTEGRATION_ID_ENV } from "../src/copilot_api/integration_identity.ts";
import { DRAIN_DEADLINE_MS } from "../src/scripts/daemon_shutdown.ts";
import { PROXY_PACKAGE_NAME } from "../src/copilot_api/version.ts";
import {
  daemonConfigFile,
  writeDaemonConfig,
  writeResolvedVersionRecord,
} from "../src/proxy_float.ts";
import { denoRunArgs, importSpecifier, ROOT, runSync, spawnChild } from "./helpers/run.ts";
import { afterEach, beforeEach, expect, test } from "./helpers/testing.ts";
import { envSnapshot, isolateProxyHome, removeDir, tmpDir } from "./helpers.ts";

// The daemon spawn is assembled from ONE DaemonSpec: the preload set, the credential
// environment, and the entry all derive from it, so the argv and the environment are
// pinned here against the spec rather than against a pile of optional arguments.

const restoreEnv = envSnapshot(["COPILOT_API_ENTRY", "NO_PROXY", "no_proxy", "HTTP_PROXY"]);
let dir = "";

// The entry resolver reads the float's record out of the root home, so every entry
// test runs against an isolated one -- otherwise a dev machine that HAS floated
// would resolve a real version here and a hermetic container would not.
beforeEach(() => {
  dir = isolateProxyHome("copilot-daemon-spawn-");
});

afterEach(() => {
  restoreEnv();
  dir = removeDir(dir);
});

const BASE: DaemonSpec = {
  port: 4141,
  logFile: "/tmp/proxy.log",
  home: "/tmp/proxy-home",
  env: {},
  credential: { kind: "none" },
  idleWatchdog: false,
  muteProxyLogs: false,
  entry: {
    kind: "package",
    specifier: PROXY_PACKAGE_NAME,
    configFile: join(ROOT, "deno.json"),
  },
  denoBin: parseAbsolutePath("/opt/deno/deno"),
};

/** The shim filenames the argv preloads, in order. */
function preloads(spec: DaemonSpec): string[] {
  const argv = daemonArgv(spec);
  return argv
    .filter((_path, i) => argv[i - 1] === "--preload")
    .map((path) => path.split(/[\\/]/).at(-1) as string);
}

test("the preload set derives from the credential kind, in load order", () => {
  // No credential: nothing to splice onto argv, nothing for the PAT shim to read. The
  // daemon-lock shim is first among the daemon shims on EVERY spawn: the per-home
  // liveness lock is taken before anything else touches the home.
  expect(preloads(BASE)).toEqual([
    "node_compat_preload.ts",
    "daemon_lock_preload.ts",
    "daemon_runtime_preload.ts",
  ]);

  // A plain token: the argv splice precedes the runtime shim, but no passthrough shim.
  expect(preloads({ ...BASE, credential: { kind: "token", token: "gho_x" } })).toEqual([
    "node_compat_preload.ts",
    "daemon_lock_preload.ts",
    "token_argv_preload.ts",
    "daemon_runtime_preload.ts",
  ]);

  // Passthrough: the splice still precedes the PAT shim, which reads the token from argv.
  expect(
    preloads({
      ...BASE,
      credential: { kind: "pat", token: "ghp_x", integrationId: "copilot-developer-cli" },
    }),
  ).toEqual([
    "node_compat_preload.ts",
    "daemon_lock_preload.ts",
    "token_argv_preload.ts",
    "daemon_runtime_preload.ts",
    "pat_passthrough_preload.ts",
  ]);
});

test("the watchdog and log-mute shims load only when their config knob is on", () => {
  expect(preloads({ ...BASE, idleWatchdog: true })).toEqual([
    "node_compat_preload.ts",
    "daemon_lock_preload.ts",
    "daemon_runtime_preload.ts",
    "idle_watchdog_preload.ts",
  ]);
  expect(preloads({ ...BASE, muteProxyLogs: true })).toEqual([
    "node_compat_preload.ts",
    "daemon_lock_preload.ts",
    "daemon_runtime_preload.ts",
    "log_mute_preload.ts",
  ]);
  expect(preloads({ ...BASE, idleWatchdog: true, muteProxyLogs: true })).toEqual([
    "node_compat_preload.ts",
    "daemon_lock_preload.ts",
    "daemon_runtime_preload.ts",
    "idle_watchdog_preload.ts",
    "log_mute_preload.ts",
  ]);
});

test("with no float record the argv runs the mapped package, offline-only, ending in start", () => {
  delete process.env.COPILOT_API_ENTRY;
  expect(resolveCopilotApiEntry()).toEqual({
    kind: "package",
    specifier: PROXY_PACKAGE_NAME,
    configFile: join(ROOT, "deno.json"),
  });

  const argv = daemonArgv({ ...BASE, port: 4242 });
  expect(argv[0]).toBe("run");
  // The config is PINNED, never discovered: a package specifier has no directory to
  // discover from, and the preloads resolve their imports through this file's import map.
  expect(argv.slice(1, 3)).toEqual(["--config", join(ROOT, "deno.json")]);
  expect(argv).toContain("--cached-only");
  // The permission grants are an exact, visible list: never a blanket -A, and never one
  // grant more than the daemon needs (it reads/writes its home, binds the loopback port,
  // and reads env plus platform info).
  expect(argv.filter((a) => a === "-A" || a.startsWith("--allow"))).toEqual([
    "--allow-env",
    "--allow-read",
    "--allow-write",
    "--allow-net",
    "--allow-sys",
  ]);
  // deno.json's import map is the single source of the proxy version, so no version
  // string is restated on the command line.
  expect(argv.slice(-5)).toEqual([
    PROXY_PACKAGE_NAME,
    "start",
    "--verbose",
    "--port",
    "4242",
  ]);
  // Nothing to point a resolve at: the mapped entry resolves through node_modules.
  expect(daemonEnvironment(BASE, {}).DENO_DIR).toBeUndefined();
});

test("COPILOT_API_HOME is pinned from the spec for every daemon", () => {
  // An unpinned default daemon (no COPILOT_API_HOME in the parent env) must still
  // get the spec's home: since the data-home rename, the npm package's own default
  // differs from ours, so falling back would split daemon and wrapper state.
  expect(daemonEnvironment(BASE, {}).COPILOT_API_HOME).toBe("/tmp/proxy-home");
  // The spec wins over an inherited value too (a profile daemon must never run
  // against whatever home the parent shell happened to export).
  expect(daemonEnvironment(BASE, { COPILOT_API_HOME: "/elsewhere" }).COPILOT_API_HOME).toBe(
    "/tmp/proxy-home",
  );
});

test("a float record moves the entry to that exact version, run out of the cache it warmed", () => {
  delete process.env.COPILOT_API_ENTRY;
  const denoDir = join(dir, "deno", "cache");
  writeResolvedVersionRecord(dir, "1.14.30", Date.now(), denoDir);

  const entry = resolveCopilotApiEntry();
  expect(entry).toEqual({
    kind: "floated",
    specifier: `npm:${PROXY_PACKAGE_NAME}@1.14.30`,
    version: "1.14.30",
    denoDir,
    configFile: daemonConfigFile(dir),
  });

  const spec = { ...BASE, entry };
  const argv = daemonArgv(spec);
  // THE regression pin: the floated spawn must NOT use the checkout's deno.json.
  // Its `lock: {frozen: true}` rejects this exact specifier ("lockfile is out of
  // date"), and `--config` + `--cached-only` would demand the whole import map in a
  // DENO_DIR that only holds the proxy. Both were live launch failures.
  expect(argv.slice(1, 3)).toEqual(["--config", daemonConfigFile(dir)]);
  expect(argv).not.toContain(join(ROOT, "deno.json"));
  // A compiled install has no node_modules; resolution stays inside the float's cache.
  expect(argv).toContain("--node-modules-dir=none");
  // The version IS the specifier here, and the resolve still never reaches the
  // network -- the float pre-warmed the cache the environment points at.
  expect(argv).toContain("--cached-only");
  expect(argv.slice(-5)).toEqual([
    `npm:${PROXY_PACKAGE_NAME}@1.14.30`,
    "start",
    "--verbose",
    "--port",
    "4141",
  ]);
  // Without this the `--cached-only` resolve would look in the default cache and fail.
  expect(daemonEnvironment(spec, {}).DENO_DIR).toBe(denoDir);
  // The spec's own home wiring still wins over the entry's overlay.
  expect(daemonEnvironment({ ...spec, env: { DENO_DIR: "/pinned" } }, {}).DENO_DIR).toBe("/pinned");
});

test("a floated resolve never rewrites the daemon config: the verify/float gate owns it", () => {
  // A rewrite here could hand `--cached-only` an import map the recorded cache was
  // never warmed for, with nothing left in the launch to re-warm it. Regeneration
  // for a changed build lives in proxyFloatVerifyStatus/floatProxy (proxy_float.ts),
  // where a cache miss under the new map still triggers the float's re-warm.
  delete process.env.COPILOT_API_ENTRY;
  const sentinel = '{"imports":{"sentinel":"npm:sentinel@1.0.0"}}\n';
  mkdirSync(join(dir, "proxy"), { recursive: true });
  writeFileSync(daemonConfigFile(dir), sentinel);
  writeResolvedVersionRecord(dir, "1.14.30", Date.now(), join(dir, "deno", "cache"));

  const entry = resolveCopilotApiEntry();
  expect(entry.kind).toBe("floated");
  expect(readFileSync(daemonConfigFile(dir), "utf8")).toBe(sentinel);
});

test("a COPILOT_API_ENTRY override runs that file and never asks for a cached package", () => {
  const fake = join(ROOT, "test", "copilot-api-fake.mjs");
  process.env.COPILOT_API_ENTRY = fake;
  // No float has run, so the file entry falls back to the checkout's config.
  expect(resolveCopilotApiEntry()).toEqual({
    kind: "file",
    path: fake,
    configFile: join(ROOT, "deno.json"),
  });

  const argv = daemonArgv({
    ...BASE,
    entry: { kind: "file", path: fake, configFile: join(ROOT, "deno.json") },
  });
  // `--cached-only` is about resolving a package; a file entry must never carry it.
  expect(argv).not.toContain("--cached-only");
  expect(argv).not.toContain(PROXY_PACKAGE_NAME);
  expect(argv.slice(-5)).toEqual([fake, "start", "--verbose", "--port", "4141"]);
});

test("the override beats a float record, so the CI fake is never shadowed by a real resolve", () => {
  writeDaemonConfig(dir, ROOT);
  writeResolvedVersionRecord(dir, "1.14.30", Date.now(), join(dir, "deno", "cache"));
  const fake = join(ROOT, "test", "copilot-api-fake.mjs");
  process.env.COPILOT_API_ENTRY = fake;
  const entry = resolveCopilotApiEntry();
  expect(entry.kind).toBe("file");
  // ...but it still resolves under the float's generated config, which on an installed
  // binary is the ONLY config on disk -- the checkout's deno.json is not shipped.
  expect(entry.configFile).toBe(daemonConfigFile(dir));
});

test("copilotApiArgv runs any proxy subcommand through the same entry and permissions", () => {
  delete process.env.COPILOT_API_ENTRY;
  const argv = copilotApiArgv(["auth", "login", "--provider", "copilot"]);
  // A foreground run loads no DAEMON shims, but still the node-compat one -- without it
  // the proxy dies at module load on Linux, device-flow login included.
  const loaded = argv.filter((_a, i) => argv[i - 1] === "--preload");
  expect(loaded.map((p) => p.split(/[\\/]/).at(-1))).toEqual(["node_compat_preload.ts"]);
  expect(argv.slice(-4)).toEqual(["auth", "login", "--provider", "copilot"]);
  expect(argv).toContain(PROXY_PACKAGE_NAME);
});

// --- the launched binary ---------------------------------------------------------------

test("launchDaemon spawns exactly the spec's denoBin, never a re-derived one", async () => {
  // Under `deno test` a re-derived resolveDenoBin() is the REAL deno (the dev fast
  // path), so spawning a COPY at a different path is what makes this discriminating:
  // the child reports its own executable, which must be the copy the spec carried.
  const sidecar = join(dir, process.platform === "win32" ? "sidecar-deno.exe" : "sidecar-deno");
  copyFileSync(Deno.execPath(), sidecar);
  if (process.platform !== "win32") chmodSync(sidecar, 0o755);
  const entryFile = join(dir, "report-exec-path.ts");
  writeFileSync(entryFile, "console.log('EXEC:' + Deno.execPath());\n");
  const logFile = join(dir, "spawn.log");
  const pid = launchDaemon({
    ...BASE,
    denoBin: parseAbsolutePath(sidecar),
    home: dir,
    logFile,
    entry: { kind: "file", path: entryFile, configFile: join(ROOT, "deno.json") },
  });
  try {
    expect(pid).toBeGreaterThan(0);
    const deadline = Date.now() + 20_000;
    let logged = "";
    while (Date.now() < deadline && !logged.includes("EXEC:")) {
      logged = readFileSync(logFile, "utf8");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const reported = /EXEC:(.+)/.exec(logged)?.[1]?.trim();
    if (reported === undefined) throw new Error(`no EXEC line; log was: ${logged}`);
    // realpath both sides: Deno.execPath() canonicalizes, and the OS tmpdir may be a symlink.
    expect(realpathSync(reported)).toBe(realpathSync(sidecar));
  } finally {
    // The child normally exits by itself, but a failure path must not leak it -- and on
    // Windows the afterEach removeDir would race a still-running copied deno.exe, so wait
    // until the pid is genuinely gone before the dir is torn down.
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    const gone = Date.now() + 5_000;
    while (pidAlive(pid) && Date.now() < gone) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // The postcondition, not just the wait: a leaked child must fail loud, never pass.
    expect(pidAlive(pid)).toBe(false);
  }
  // Explicit deadline ABOVE the inner bounds (20s log wait + 5s kill wait): under the
  // 15s default the harness would abandon the body mid-cleanup, afterEach's removeDir
  // would race the possibly-live copied deno, and the dead-pid assertion would fire
  // invisibly inside the abandoned continuation.
}, 30_000);

// --- the daemon environment ----------------------------------------------------------

test("the credential environment is set-or-DELETE, so a stale value can never leak in", () => {
  // Our own environment already carries both keys (an earlier launch in this shell).
  const stale = {
    [DAEMON_GH_TOKEN_ENV]: "gho_from_an_earlier_run",
    [DAEMON_INTEGRATION_ID_ENV]: "copilot-developer-cli",
    COPILOT_API_OAUTH_APP: "opencode",
  };

  const none = daemonEnvironment(BASE, stale);
  expect(none[DAEMON_GH_TOKEN_ENV]).toBeUndefined();
  expect(none[DAEMON_INTEGRATION_ID_ENV]).toBeUndefined();

  const token = daemonEnvironment(
    { ...BASE, credential: { kind: "token", token: "gho_new" } },
    stale,
  );
  expect(token[DAEMON_GH_TOKEN_ENV]).toBe("gho_new");
  expect(token[DAEMON_INTEGRATION_ID_ENV]).toBeUndefined(); // no passthrough -> no identity
  // Only passthrough depends on copilot-api's default editor headers, so only it scrubs
  // the oauth-app switch.
  expect(token.COPILOT_API_OAUTH_APP).toBe("opencode");

  const pat = daemonEnvironment(
    { ...BASE, credential: { kind: "pat", token: "ghp_new", integrationId: "vscode-chat" } },
    stale,
  );
  expect(pat[DAEMON_GH_TOKEN_ENV]).toBe("ghp_new");
  expect(pat[DAEMON_INTEGRATION_ID_ENV]).toBe("vscode-chat");
  expect(pat.COPILOT_API_OAUTH_APP).toBeUndefined();
});

test("the daemon inherits our TLS/proxy environment, and the spec's own wiring wins", () => {
  const env = daemonEnvironment(
    { ...BASE, home: "/profiles/work" },
    {
      NODE_EXTRA_CA_CERTS: "/etc/corp.pem",
      DENO_TLS_CA_STORE: "system",
      HTTPS_PROXY: "http://corp:3128",
      COPILOT_API_HOME: "/the/default/home",
    },
  );
  expect(env.NODE_EXTRA_CA_CERTS).toBe("/etc/corp.pem");
  expect(env.DENO_TLS_CA_STORE).toBe("system");
  expect(env.HTTPS_PROXY).toBe("http://corp:3128");
  expect(env.COPILOT_API_HOME).toBe("/profiles/work");
  expect(env.DENO_NO_UPDATE_CHECK).toBe("1");
});

test("NO_PROXY gains the loopback hosts without losing the user's own", () => {
  expect(noProxyWithLoopback(undefined)).toBe("127.0.0.1,::1,localhost");
  expect(noProxyWithLoopback("")).toBe("127.0.0.1,::1,localhost");
  expect(noProxyWithLoopback("corp.internal")).toBe("corp.internal,127.0.0.1,::1,localhost");
  // Already-listed hosts are not duplicated, whatever their case or spacing.
  expect(noProxyWithLoopback("LOCALHOST, 127.0.0.1")).toBe("LOCALHOST,127.0.0.1,::1");
  expect(noProxyWithLoopback(noProxyWithLoopback("corp.internal"))).toBe(
    "corp.internal,127.0.0.1,::1,localhost",
  );

  // The lowercase spelling is read when it is the only one set, and BOTH names carry
  // the result -- so whichever the HTTP client consults, the exemption is there.
  const env = daemonEnvironment(BASE, { no_proxy: "corp.internal" });
  expect(env.NO_PROXY).toBe("corp.internal,127.0.0.1,::1,localhost");
  expect(env.no_proxy).toBe("corp.internal,127.0.0.1,::1,localhost");
});

// --- the POSIX process scan ----------------------------------------------------------

test("parseProcessRows splits pid and ucomm off, keeping the command line verbatim", () => {
  const rows = parseProcessRows(
    "  900 distnoted        /usr/sbin/distnoted agent\n" +
      "12345 deno             /home/me/.deno/bin/deno run --allow-net @jeffreycao/copilot-api start --port 4141\n" +
      "\n" +
      "not a row\n",
  );
  expect(rows).toEqual([
    { pid: 900, ucomm: "distnoted", command: "/usr/sbin/distnoted agent" },
    {
      pid: 12345,
      ucomm: "deno",
      command: "/home/me/.deno/bin/deno run --allow-net @jeffreycao/copilot-api start --port 4141",
    },
  ]);
  // A command line with runs of spaces survives intact -- only the leading columns split.
  expect(parseProcessRows("7 sh sh -c 'a   b'")).toEqual([
    { pid: 7, ucomm: "sh", command: "sh -c 'a   b'" },
  ]);
});

test("classifyPidFromRows preserves a FAILED scan as unknown, never a confident no", () => {
  const self = { pid: 111, ucomm: "deno", command: "deno test" };
  const daemon = {
    pid: 222,
    ucomm: "deno",
    command: "/home/me/.deno/bin/deno run --allow-net npm:@jeffreycao/copilot-api start",
  };
  // The scan's control is the calling process itself: a readable `ps -U <uid>` always
  // contains it, so rows WITHOUT it prove the scan failed -- "failed to look" must not
  // become "definitely not a daemon" (the 3.5.6 default-home move refuses on unknown;
  // a flattened "no" there would move the home out from under an unjudged pid).
  expect(classifyPidFromRows([], 222, 111)).toBe("unknown");
  expect(classifyPidFromRows([daemon], 222, 111)).toBe("unknown"); // self missing: failed scan
  // A scan that passes its control judges confidently, both ways.
  expect(classifyPidFromRows([self, daemon], 222, 111)).toBe("yes");
  expect(classifyPidFromRows([self], 222, 111)).toBe("no");
  expect(classifyPidFromRows([self, daemon], 333, 111)).toBe("no");
});

// --- the orphan-sweep signature ---------------------------------------------------------
// The sweep SIGKILLs what this signature matches, so both directions are load-bearing:
// every REAL daemon shape (pinned against daemonArgv itself, so a spawn change cannot
// drift away from the sweep) still matches, and impostor argv that merely MENTIONS
// copilot-api and start -- the shape that once got an innocent agent process killed for
// prompt text in its argv -- never does. POSIX rows gate on ps's ucomm (the kernel's
// executable name) via isDaemonProcess; the Windows CommandLine judgment the PS scripts
// interpolate is mirrored by isDaemonCommandLine.

/** The ps-visible row for a spec: ucomm "deno" plus argv0 (the deno binary) + daemonArgv. */
function daemonRow(spec: DaemonSpec): { pid: number; ucomm: string; command: string } {
  return { pid: 1, ucomm: "deno", command: [spec.denoBin, ...daemonArgv(spec)].join(" ") };
}

test("the sweep signature matches every real daemon shape, straight from daemonArgv", () => {
  // The floated entry (the runtime answer on any install the float has run on).
  delete process.env.COPILOT_API_ENTRY;
  const denoDir = join(dir, "deno", "cache");
  writeResolvedVersionRecord(dir, "1.14.30", Date.now(), denoDir);
  const floated = { ...BASE, entry: resolveCopilotApiEntry() };
  expect(floated.entry.kind).toBe("floated");
  expect(isDaemonProcess(daemonRow(floated))).toBe(true);

  // The mapped package fallback (a checkout where the float never ran).
  expect(isDaemonProcess(daemonRow(BASE))).toBe(true);

  // The COPILOT_API_ENTRY file form (the CI fake's shape).
  const fake = join(ROOT, "test", "copilot-api-fake.mjs");
  expect(
    isDaemonProcess(
      daemonRow({
        ...BASE,
        entry: { kind: "file", path: fake, configFile: join(ROOT, "deno.json") },
      }),
    ),
  ).toBe(true);

  // A deno binary (and home) at a SPACED path: ps flattens argv, but both fragments
  // still carry slashes and read as invocation-shaped -- missing this daemon would make
  // proxyStatus read it as down and `agent stop` skip it.
  expect(
    isDaemonProcess({
      pid: 1,
      ucomm: "deno",
      command: "/Users/John Smith/.local/share/copilot-api/deno/2.1.4/deno run " +
        "--config /Users/John Smith/.local/share/copilot-api/proxy/deno.json --cached-only " +
        "npm:@jeffreycao/copilot-api@1.14.30 start --verbose --port 4141",
    }),
  ).toBe(true);
  // The DOCUMENTED loss: a path component of two or more words flattens into a
  // slash-less bare fragment ("Runtime"), which the signature refuses -- every
  // bare-word tolerance re-admitted crafted impostor argv, and the sweep SIGKILLs
  // what it matches, so the bias is against false positives.
  expect(
    isDaemonProcess({
      pid: 1,
      ucomm: "deno",
      command: "/Applications/Deno Runtime Tools/deno run --cached-only " +
        "npm:@jeffreycao/copilot-api@1.14.30 start --verbose --port 4141",
    }),
  ).toBe(false);

  // A pre-rewrite install's daemon: node/bun hosting a node_modules entry path.
  expect(
    isDaemonProcess({
      pid: 1,
      ucomm: "node",
      command: "node /usr/lib/node_modules/@jeffreycao/copilot-api/dist/main.js start --port 4141",
    }),
  ).toBe(true);
});

test("the Windows CommandLine mirror matches the image-quoted daemon shapes", () => {
  // Quoted image path (spaces and all), .exe suffix -- the WMI CommandLine form.
  expect(
    isDaemonCommandLine(
      '"C:\\Users\\John Smith\\.copilot-env\\home\\deno\\2.1.4\\deno.exe" run --cached-only ' +
        "npm:@jeffreycao/copilot-api@1.14.30 start --verbose --port 4141",
    ),
  ).toBe(true);
  // A quoted file entry whose path contains spaces is still a real daemon: missing it
  // would make proxyStatus read the daemon as down and `agent stop` skip it.
  expect(
    isDaemonCommandLine(
      '"C:\\Program Files\\Deno\\deno.exe" run "C:\\tmp\\copilot-api fake.mjs" start --port 4141',
    ),
  ).toBe(true);
  expect(
    isDaemonCommandLine("C:\\Users\\me\\.deno\\bin\\deno.exe run npm:@x/copilot-api@1.2.3 start"),
  ).toBe(true);
  // Prompt text in a non-runtime image's argv never matches, whatever it mentions.
  expect(
    isDaemonCommandLine(
      '"C:\\Program Files\\Codex\\codex.exe" exec --prompt fix the copilot-api start sweep',
    ),
  ).toBe(false);
});

test("impostor argv that merely mentions copilot-api and start survives the sweep", () => {
  // The incident shape: an agent CLI carrying prompt text about this very code. The
  // ucomm gate rejects it outright, however daemon-like the text reads.
  expect(
    isDaemonProcess({
      pid: 1,
      ucomm: "codex",
      command: "/usr/local/bin/codex exec --prompt narrow the copilot-api start sweep in launch.ts",
    }),
  ).toBe(false);
  // A shell whose $0/argv spell the old substring exactly.
  expect(
    isDaemonProcess({ pid: 1, ucomm: "sh", command: "sh -c sleep 30 copilot-api start" }),
  ).toBe(false);
  // Even a real runtime process: the words as BARE tokens are not an entry.
  expect(
    isDaemonProcess({
      pid: 1,
      ucomm: "deno",
      command: "/home/me/.deno/bin/deno run script.ts --note copilot-api start",
    }),
  ).toBe(false);
  // A copilot-api-SHAPED path in a runtime's own arguments: the bare word before it
  // ("inspect" -- prompt text, another script's argument) breaks the invocation shape.
  expect(
    isDaemonProcess({
      pid: 1,
      ucomm: "deno",
      command: "deno run worker.ts --prompt inspect /tmp/copilot-api-notes start safely",
    }),
  ).toBe(false);
  // A copilot-api path token NOT followed by the start subcommand (a foreground run).
  expect(
    isDaemonProcess({
      pid: 1,
      ucomm: "deno",
      command: "/opt/deno/deno run @jeffreycao/copilot-api auth login",
    }),
  ).toBe(false);
  // A codex process even with a perfectly daemon-shaped command line: ucomm decides.
  expect(
    isDaemonProcess({
      pid: 1,
      ucomm: "codex",
      command: "/opt/deno/deno run npm:@jeffreycao/copilot-api@1.14.30 start",
    }),
  ).toBe(false);
  // A copilot-api-named ROOT HOME in an unrelated flag never qualifies as the entry.
  expect(
    isDaemonProcess({
      pid: 1,
      ucomm: "deno",
      command:
        "deno run --config /home/me/.local/share/copilot-api/proxy/deno.json /repo/src/cli.ts env",
    }),
  ).toBe(false);
  // Slash-carrying tokens between a bare word and the copilot-api path must not be
  // readable as one "spaced path" that bridges over the bare word (the tolerance that
  // would make this match is exactly what re-admits prompt-text argv).
  expect(
    isDaemonProcess({
      pid: 1,
      ucomm: "deno",
      command: "deno run /tmp/tool.ts inspect /tmp/data /tmp/copilot-api-notes start",
    }),
  ).toBe(false);
  // LITERAL quote characters in POSIX argv are prompt text (ps already stripped shell
  // quoting), so a quoted run of bare words must not bridge the match either -- quoted
  // tokens are honored only in the Windows CommandLine form.
  expect(
    isDaemonProcess({
      pid: 1,
      ucomm: "deno",
      command: 'deno run /tmp/tool.ts --prompt "inspect bare words" /tmp/copilot-api-notes start',
    }),
  ).toBe(false);
  // A long, slash-heavy non-matching line stays cheap to reject: every middle
  // alternative consumes exactly one token and the classes are disjoint -- including
  // `--flag=/path` tokens, which read as flags, never also as path fragments -- so a
  // failing scan is linear. The elapsed bound catches a polynomially-slow regression;
  // a truly exponential one hangs the suite here, which is still a failure.
  const pathHeavy = `deno run ${
    Array.from({ length: 60 }, (_v, i) => `/dir${i}/file${i}.ts --flag${i}=/opt/val${i}`).join(" ")
  } tail`;
  const startedMs = Date.now();
  expect(isDaemonProcess({ pid: 1, ucomm: "deno", command: pathHeavy })).toBe(false);
  expect(Date.now() - startedMs).toBeLessThan(1_000);
});

// --- the shared shutdown path --------------------------------------------------------

const SHUTDOWN_MODULE = importSpecifier(join(ROOT, "src", "scripts", "daemon_shutdown.ts"));

test("a wedged drain still exits: the deadline is what keeps `agent stop` able to stop us", () => {
  // A SIGTERM listener REPLACES deno's terminate-on-signal, and `agent stop` sends a
  // single SIGTERM with no SIGKILL escalation -- so a server whose shutdown() never
  // settles must not be able to keep the daemon alive.
  dir = tmpDir("copilot-shutdown-");
  const target = join(dir, "wedged.ts");
  writeFileSync(
    target,
    `import { recordDaemonServer, shutdownDaemon, DRAIN_DEADLINE_MS } from ${SHUTDOWN_MODULE};\n` +
      "recordDaemonServer({ shutdown: () => new Promise(() => {}) });\n" +
      "const started = Date.now();\n" +
      "globalThis.addEventListener('unload', () => console.log(String(Date.now() - started)));\n" +
      "await shutdownDaemon(0);\n" +
      "console.log('UNREACHABLE');\n",
  );
  const res = runSync(Deno.execPath(), [...denoRunArgs(), target], { timeoutMs: 30_000 });
  expect(res.exitCode).toBe(0);
  expect(res.stdout).not.toContain("UNREACHABLE"); // the path never returns
  // It waited the full drain window (small margin for timer coarseness).
  expect(Number(res.stdout.trim())).toBeGreaterThanOrEqual(DRAIN_DEADLINE_MS - 100);
});

test.skipIf(Deno.build.os === "windows")(
  "SIGTERM drains an IN-FLIGHT request before the daemon exits",
  async () => {
    // Windows has no deliverable SIGTERM (node's process.kill is TerminateProcess there),
    // so the drain is a POSIX contract; the Windows daemon keeps its hard-kill teardown.
    //
    // The request must be genuinely mid-flight when the signal lands, or the test proves
    // only that a finished server can exit. So the handler parks until this process
    // releases it, and the release is written only AFTER the child reports the signal
    // arrived -- by which point shutdownDaemon has already called server.shutdown().
    dir = tmpDir("copilot-sigterm-");
    const target = join(dir, "serving.ts");
    const release = join(dir, "release");
    writeFileSync(
      target,
      `import { installTerminationHandler } from ${SHUTDOWN_MODULE};\n` +
        `import { installInferenceObserver } from ${
          importSpecifier(join(ROOT, "src", "scripts", "inference_activity.ts"))
        };\n` +
        `const release = ${JSON.stringify(release)};\n` +
        "installInferenceObserver();\n" +
        "installTerminationHandler();\n" +
        // A second listener, so the parent learns the signal was delivered. It runs AFTER
        // the handler installed above, which starts the drain synchronously.
        "Deno.addSignalListener('SIGTERM', () => console.log('SIGNALLED'));\n" +
        "const parked = async () => {\n" +
        "  console.log('SERVING');\n" +
        "  for (;;) {\n" +
        "    try { await Deno.stat(release); break; } catch { /* not yet */ }\n" +
        "    await new Promise((r) => setTimeout(r, 20));\n" +
        "  }\n" +
        "  return new Response('drained-ok');\n" +
        "};\n" +
        "const server = Deno.serve(\n" +
        "  { hostname: '127.0.0.1', port: 0, onListen: (a) => console.log('PORT ' + a.port) },\n" +
        "  parked,\n" +
        ");\n" +
        "server.finished.then(() => console.log('DRAINED'));\n",
    );
    // Deno.Command, not node's child_process: only this reports the real wait status
    // (node's compat layer echoes the signal it SENT, so a clean exit reads as killed).
    const child = spawnChild(Deno.execPath(), {
      args: [...denoRunArgs(), target],
      stdout: "piped",
      stderr: "piped",
    });
    let stdout = "";
    const decoder = new TextDecoder();
    const reader = child.stdout.getReader();
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        stdout += decoder.decode(value);
      }
    })();
    const awaitLine = async (line: string, budgetMs: number): Promise<void> => {
      const deadline = Date.now() + budgetMs;
      while (!stdout.includes(line) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(stdout).toContain(line);
    };
    let inFlight: Promise<Response> | undefined;
    try {
      // Signal it only once it is genuinely listening (the handler installs before serve).
      await awaitLine("PORT ", 10_000);
      const match = /PORT (\d+)/.exec(stdout);
      expect(match).not.toBeNull();
      inFlight = fetch(`http://127.0.0.1:${match?.[1]}/`);
      inFlight.catch(() => {}); // marked handled; the await below is what surfaces a failure
      await awaitLine("SERVING", 5_000); // the handler is parked, response not yet written

      child.kill("SIGTERM");
      // The signal must show up INSIDE the drain window: past it the daemon has already
      // exited on the deadline and there is no in-flight request left to prove anything about.
      await awaitLine("SIGNALLED", DRAIN_DEADLINE_MS);
      writeFileSync(release, "");

      // The parked request completes: drained, not severed.
      const response = await inFlight;
      inFlight = undefined;
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toBe("drained-ok");

      expect(await child.status).toEqual({ success: true, code: 0, signal: null });
      await pump;
      // Drained through the shared path, not severed by deno's default terminate.
      expect(stdout).toContain("DRAINED");
    } finally {
      // An assertion that threw before the request was consumed would otherwise hold the
      // connection -- and the child -- open.
      await inFlight?.then((r) => r.body?.cancel(), () => {});
      await child.stderr.cancel();
    }
  },
);

// The escalating teardowns (start --force, uninstall, de-auth, profile --del) SIGKILL
// after the shared grace; the drain deadline must finish first or those paths sever the
// in-flight responses the drain exists to protect. Both sides are imported so the
// relation is pinned rather than restated: the daemon-side module keeps its own literal
// (it loads inside the daemon, where a CLI import does not belong).
test("the drain deadline fits inside the SIGKILL grace", () => {
  expect(DRAIN_DEADLINE_MS).toBeLessThan(DAEMON_SIGKILL_GRACE_MS);
});
