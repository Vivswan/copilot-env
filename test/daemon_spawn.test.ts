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
  classifyPidFromScan,
  copilotApiArgv,
  DAEMON_GH_TOKEN_ENV,
  DAEMON_SIGKILL_GRACE_MS,
  daemonArgv,
  daemonEnvironment,
  daemonPidsFromRows,
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
import {
  DAEMON_CLIENT_HEADERS_ENV,
  DAEMON_COPILOT_HOST_ENV,
  daemonClientHeaders,
} from "../src/copilot_api/integration_identity.ts";
import { DRAIN_DEADLINE_MS } from "../src/scripts/daemon_shutdown.ts";
import { PROXY_PACKAGE_NAME } from "../src/copilot_api/version.ts";
import {
  daemonConfigFile,
  writeDaemonConfig,
  writeResolvedVersionRecord,
} from "../src/proxy_float.ts";
import {
  CHILD_VALUES,
  childValuesEnv,
  denoRunArgs,
  importSpecifier,
  ROOT,
  runSync,
  spawnChild,
} from "./helpers/run.ts";
import { afterEach, beforeEach, expect, removeDir, tempDir, test } from "./helpers/testing.ts";
import {
  envSnapshot,
  FAKE_DAEMON_CREDENTIAL,
  FAKE_DAEMON_HOST,
  isolateProxyHome,
  until,
} from "./helpers.ts";

// Every daemon spawn derives from ONE DaemonSpec, so argv and environment are pinned against the
// spec rather than a pile of optional arguments.

const restoreEnv = envSnapshot(["COPILOT_API_ENTRY", "NO_PROXY", "no_proxy", "HTTP_PROXY"]);
let dir = "";

// The entry resolver reads the float's record out of the root home; on a dev machine that HAS
// floated, a shared home would resolve a real version here while a hermetic container would not.
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
  credential: FAKE_DAEMON_CREDENTIAL,
  idleWatchdog: false,
  muteProxyLogs: false,
  copilotHost: FAKE_DAEMON_HOST,
  entry: {
    kind: "package",
    specifier: PROXY_PACKAGE_NAME,
    configFile: join(ROOT, "deno.json"),
  },
  denoBin: parseAbsolutePath("/opt/deno/deno"),
};

function preloads(spec: DaemonSpec): string[] {
  const argv = daemonArgv(spec);
  return argv
    .filter((_path, i) => argv[i - 1] === "--preload")
    .map((path) => path.split(/[\\/]/).at(-1) as string);
}

const CLI_HEADERS = daemonClientHeaders("codex_exec/1", "copilot-developer-cli");
const BUSINESS_HOST = "https://api.business.githubcopilot.com";

// Why the order and the environment matter: the daemon-lock shim leads every spawn (the per-home
// liveness lock is taken before anything else touches the home); the passthrough fake loads after
// the splice it reads the token from; a pinned host's shim precedes the PAT shim, and copilot-api's
// own host override and app selector are dropped because either would beat the rewritten state.
test("the preload set and its environment derive from the spec, in load order", () => {
  // Every daemon carries a credential and a host, so the token, host, and client-header shims are
  // always loaded, in this order; the optional shims append.
  const base = [
    "node_compat_preload.ts",
    "daemon_lock_preload.ts",
    "token_argv_preload.ts",
    "daemon_runtime_preload.ts",
    "copilot_host_preload.ts",
    "client_headers_preload.ts",
  ];
  const enterprise = {
    COPILOT_API_ENTERPRISE_URL: "ghe.example",
    COPILOT_API_OAUTH_APP: "opencode",
  };
  interface Row {
    spec: Partial<DaemonSpec>;
    preloads: string[];
    /** Inherited environment -> the keys the daemon must (not) see. */
    env?: Array<{ inherited: Record<string, string>; keys: Record<string, string | undefined> }>;
  }
  const rows: Row[] = [
    {
      spec: {},
      preloads: base,
      env: [
        // copilot-api's own host selectors answer before the rewritten state: always scrubbed.
        {
          inherited: enterprise,
          keys: { COPILOT_API_ENTERPRISE_URL: undefined, COPILOT_API_OAUTH_APP: undefined },
        },
        {
          inherited: { [DAEMON_COPILOT_HOST_ENV]: "https://stale.example" },
          keys: { [DAEMON_COPILOT_HOST_ENV]: FAKE_DAEMON_HOST },
        },
      ],
    },
    {
      spec: { credential: { kind: "pat", token: "ghp_x", clientHeaders: CLI_HEADERS } },
      preloads: [...base, "pat_passthrough_preload.ts"],
    },
    {
      spec: { idleWatchdog: true },
      preloads: [...base, "idle_watchdog_preload.ts"],
    },
    {
      spec: { muteProxyLogs: true },
      preloads: [...base, "log_mute_preload.ts"],
    },
    {
      spec: { idleWatchdog: true, muteProxyLogs: true },
      preloads: [...base, "idle_watchdog_preload.ts", "log_mute_preload.ts"],
    },
    {
      spec: { copilotHost: BUSINESS_HOST },
      preloads: base,
      env: [{ inherited: {}, keys: { [DAEMON_COPILOT_HOST_ENV]: BUSINESS_HOST } }],
    },
    {
      spec: {
        copilotHost: BUSINESS_HOST,
        credential: { kind: "pat", token: "ghp_x", clientHeaders: CLI_HEADERS },
        idleWatchdog: true,
      },
      preloads: [...base, "pat_passthrough_preload.ts", "idle_watchdog_preload.ts"],
    },
  ];
  for (const row of rows) {
    const spec = { ...BASE, ...row.spec };
    expect({ spec: row.spec, preloads: preloads(spec) }).toEqual({
      spec: row.spec,
      preloads: row.preloads,
    });
    for (const { inherited, keys } of row.env ?? []) {
      const env = daemonEnvironment(spec, inherited);
      const seen = Object.fromEntries(Object.keys(keys).map((k) => [k, env[k]]));
      expect({ spec: row.spec, inherited, seen }).toEqual({
        spec: row.spec,
        inherited,
        seen: keys,
      });
    }
  }
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
  // The grants are an exact visible list: never a blanket -A, never one grant more than the daemon needs.
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

test("a daemon config with no float record runs the mapped package under that config, like the file override does", () => {
  // One rule for every non-floated entry: the float's generated config wherever it exists, else the
  // checkout's deno.json. The file override already answered this way; the package entry now agrees.
  delete process.env.COPILOT_API_ENTRY;
  writeDaemonConfig(dir, ROOT);
  expect(resolveCopilotApiEntry()).toEqual({
    kind: "package",
    specifier: PROXY_PACKAGE_NAME,
    configFile: daemonConfigFile(dir),
  });
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
  // THE regression pin: the checkout's deno.json has `lock: {frozen: true}`, which rejects this
  // specifier, and under `--cached-only` its import map demands packages the float's DENO_DIR never
  // held. Both were live launch failures.
  expect(argv.slice(1, 3)).toEqual(["--config", daemonConfigFile(dir)]);
  expect(argv).not.toContain(join(ROOT, "deno.json"));
  // A compiled install has no node_modules; resolution stays inside the float's cache.
  expect(argv).toContain("--node-modules-dir=none");
  // The resolve still never reaches the network: the float pre-warmed the cache DENO_DIR points at.
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
  // A rewrite here could hand `--cached-only` an import map the recorded cache was never warmed for.
  // Regeneration for a changed build lives in proxyFloatVerifyStatus/floatProxy (proxy_float.ts),
  // which re-warms on a miss.
  delete process.env.COPILOT_API_ENTRY;
  const sentinel = '{"imports":{"sentinel":"npm:sentinel@1.0.0"}}\n';
  mkdirSync(join(dir, "proxy"), { recursive: true });
  writeFileSync(daemonConfigFile(dir), sentinel);
  writeResolvedVersionRecord(dir, "1.14.30", Date.now(), join(dir, "deno", "cache"));

  const entry = resolveCopilotApiEntry();
  expect(entry.kind).toBe("floated");
  expect(readFileSync(daemonConfigFile(dir), "utf8")).toBe(sentinel);
});

// A COPILOT_API_ENTRY override runs that file whether or not a float record exists, so the CI fake
// is never shadowed by a real resolve; the config it runs under is whichever the float has written
// (on an installed binary the generated one is the ONLY config on disk), else the checkout's.
test("a COPILOT_API_ENTRY override runs that file under the float's config, never a cached package", () => {
  const fake = join(ROOT, "test", "copilot-api-fake.mjs");
  process.env.COPILOT_API_ENTRY = fake;
  const rows: Array<{ floated: boolean; configFile: string }> = [
    { floated: false, configFile: join(ROOT, "deno.json") },
    { floated: true, configFile: daemonConfigFile(dir) },
  ];
  for (const row of rows) {
    if (row.floated) {
      writeDaemonConfig(dir, ROOT);
      writeResolvedVersionRecord(dir, "1.14.30", Date.now(), join(dir, "deno", "cache"));
    }
    expect({ ...row, entry: resolveCopilotApiEntry() }).toEqual({
      ...row,
      entry: { kind: "file", path: fake, configFile: row.configFile },
    });
  }

  const argv = daemonArgv({
    ...BASE,
    entry: { kind: "file", path: fake, configFile: join(ROOT, "deno.json") },
  });
  // `--cached-only` is about resolving a package; a file entry must never carry it.
  expect(argv).not.toContain("--cached-only");
  expect(argv).not.toContain(PROXY_PACKAGE_NAME);
  expect(argv.slice(-5)).toEqual([fake, "start", "--verbose", "--port", "4141"]);
});

test("copilotApiArgv runs any proxy subcommand through the same entry and permissions", () => {
  delete process.env.COPILOT_API_ENTRY;
  const argv = copilotApiArgv(["debug", "models"]);
  // Without the node-compat shim the proxy dies at module load on Linux, whatever the subcommand.
  const loaded = argv.filter((_a, i) => argv[i - 1] === "--preload");
  expect(loaded.map((p) => p.split(/[\\/]/).at(-1))).toEqual(["node_compat_preload.ts"]);
  expect(argv.slice(-2)).toEqual(["debug", "models"]);
  expect(argv).toContain(PROXY_PACKAGE_NAME);
});

// --- the launched binary ---------------------------------------------------------------

test("launchDaemon spawns exactly the spec's denoBin, never a re-derived one", async () => {
  // Under `deno test` a re-derived resolveDenoBin() is the REAL deno, so only a COPY at a different
  // path makes this discriminating.
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
    let logged = "";
    await until(() => {
      logged = readFileSync(logFile, "utf8");
      return logged.includes("EXEC:");
    });
    const reported = /EXEC:(.+)/.exec(logged)?.[1]?.trim();
    if (reported === undefined) throw new Error(`no EXEC line; log was: ${logged}`);
    // realpath both sides: Deno.execPath() canonicalizes, and the OS tmpdir may be a symlink.
    expect(realpathSync(reported)).toBe(realpathSync(sidecar));
  } finally {
    // On Windows the afterEach removeDir would race a still-running copied deno.exe, so wait until
    // the pid is genuinely gone.
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    await until(() => !pidAlive(pid));
  }
}, 30_000); // a real daemon boot on a loaded runner

// --- the daemon environment ----------------------------------------------------------

test("the credential environment is always set from the spec, so a stale value can never leak in", () => {
  // Our own environment already carries both keys (an earlier launch in this shell).
  const stale = {
    [DAEMON_GH_TOKEN_ENV]: "gho_from_an_earlier_run",
    [DAEMON_CLIENT_HEADERS_ENV]: '{"User-Agent":"stale"}',
    COPILOT_API_OAUTH_APP: "opencode",
  };

  // Every credential rides with its identity's header set, as the shim parses it back: the codex
  // identity names the id header as a deletion, so the proxy's own cannot stand in.
  const codex = daemonClientHeaders("codex_exec/1", null);
  const token = daemonEnvironment(
    { ...BASE, credential: { kind: "token", token: "gho_new", clientHeaders: codex } },
    stale,
  );
  expect(token[DAEMON_GH_TOKEN_ENV]).toBe("gho_new");
  expect(JSON.parse(token[DAEMON_CLIENT_HEADERS_ENV] ?? "")).toEqual(codex);
  // The rewrite rides copilot-api's default upstream path, so the opencode app switch is scrubbed
  // for every credential.
  expect(token.COPILOT_API_OAUTH_APP).toBeUndefined();

  const cli = daemonClientHeaders("codex_exec/1", "copilot-developer-cli");
  const pat = daemonEnvironment(
    { ...BASE, credential: { kind: "pat", token: "ghp_new", clientHeaders: cli } },
    stale,
  );
  expect(pat[DAEMON_GH_TOKEN_ENV]).toBe("ghp_new");
  expect(JSON.parse(pat[DAEMON_CLIENT_HEADERS_ENV] ?? "")).toEqual(cli);
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

  // BOTH spellings carry the result, so whichever the HTTP client consults, the exemption is there.
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

test("daemonPidsFromRows preserves a FAILED scan as unproven, never a confident empty list", () => {
  const self = { pid: 111, ucomm: "deno", command: "deno test" };
  const daemon = {
    pid: 222,
    ucomm: "deno",
    command: "/home/me/.deno/bin/deno run --allow-net npm:@jeffreycao/copilot-api start",
  };
  // The scan's control is the calling process: a readable `ps -U <uid>` always contains it, so rows
  // WITHOUT it prove the scan failed, and "failed to look" must ride to the sweep as "unproven",
  // never flatten into "no orphans anywhere".
  expect(daemonPidsFromRows([], 111)).toBe("unproven");
  expect(daemonPidsFromRows([daemon], 111)).toBe("unproven"); // self missing: failed scan
  // Controls: a scan that passes judges confidently -- empty AND populated.
  expect(daemonPidsFromRows([self], 111)).toEqual([]);
  expect(daemonPidsFromRows([self, daemon], 111)).toEqual([222]);
});

test("classifyPidFromScan: a FAILED owner scan is unknown, a proven-foreign owner stays no", () => {
  // The win32 owner-composition arm of classifyOwnedDaemonPid: after a classify-"yes", a FAILED
  // owner scan composes to "unknown", never a confident "no".
  expect(classifyPidFromScan("unproven", 222)).toBe("unknown");
  // Control: a COMPLETED scan without the pid is the genuine another-user's-pid case.
  expect(classifyPidFromScan([333], 222)).toBe("no");
  expect(classifyPidFromScan([], 222)).toBe("no");
  expect(classifyPidFromScan([222, 333], 222)).toBe("yes");
});

// The sweep SIGKILLs what this signature matches, so both directions are load-bearing: every real
// daemon shape (pinned against daemonArgv itself) matches, and impostor argv that merely MENTIONS
// copilot-api and start (the shape that once killed an innocent agent process for prompt text)
// never does. POSIX gates on ps's ucomm via isDaemonProcess; isDaemonCommandLine mirrors the
// Windows CommandLine judgment the PS scripts interpolate.

function daemonRow(spec: DaemonSpec): { pid: number; ucomm: string; command: string } {
  return { pid: 1, ucomm: "deno", command: [spec.denoBin, ...daemonArgv(spec)].join(" ") };
}

test("the sweep signature matches every real daemon shape, straight from daemonArgv", () => {
  delete process.env.COPILOT_API_ENTRY;
  const denoDir = join(dir, "deno", "cache");
  writeResolvedVersionRecord(dir, "1.14.30", Date.now(), denoDir);
  const floated = { ...BASE, entry: resolveCopilotApiEntry() };
  expect(floated.entry.kind).toBe("floated");
  expect(isDaemonProcess(daemonRow(floated))).toBe(true);

  expect(isDaemonProcess(daemonRow(BASE))).toBe(true);

  const fake = join(ROOT, "test", "copilot-api-fake.mjs");
  expect(
    isDaemonProcess(
      daemonRow({
        ...BASE,
        entry: { kind: "file", path: fake, configFile: join(ROOT, "deno.json") },
      }),
    ),
  ).toBe(true);

  // ps flattens a SPACED path, but both fragments still carry slashes; missing this daemon would
  // make proxyStatus read it as down and `agent stop` skip it.
  expect(
    isDaemonProcess({
      pid: 1,
      ucomm: "deno",
      command: "/Users/John Smith/.local/share/copilot-api/deno/2.1.4/deno run " +
        "--config /Users/John Smith/.local/share/copilot-api/proxy/deno.json --cached-only " +
        "npm:@jeffreycao/copilot-api@1.14.30 start --verbose --port 4141",
    }),
  ).toBe(true);
  // The DOCUMENTED loss: a path component of two or more words flattens into a slash-less bare
  // fragment ("Runtime"), which the signature refuses; every bare-word tolerance re-admitted impostors.
  expect(
    isDaemonProcess({
      pid: 1,
      ucomm: "deno",
      command: "/Applications/Deno Runtime Tools/deno run --cached-only " +
        "npm:@jeffreycao/copilot-api@1.14.30 start --verbose --port 4141",
    }),
  ).toBe(false);
});

test("the Windows CommandLine mirror matches the image-quoted daemon shapes", () => {
  // Quoted image path (spaces and all), .exe suffix -- the WMI CommandLine form.
  expect(
    isDaemonCommandLine(
      '"C:\\Users\\John Smith\\.copilot-env\\home\\deno\\2.1.4\\deno.exe" run --cached-only ' +
        "npm:@jeffreycao/copilot-api@1.14.30 start --verbose --port 4141",
    ),
  ).toBe(true);
  // A quoted file entry with spaces is still a real daemon; missing it would make `agent stop` skip it.
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
  // Slash-carrying tokens must not read as one "spaced path" bridging over the bare word: that
  // tolerance is exactly what re-admits prompt-text argv.
  expect(
    isDaemonProcess({
      pid: 1,
      ucomm: "deno",
      command: "deno run /tmp/tool.ts inspect /tmp/data /tmp/copilot-api-notes start",
    }),
  ).toBe(false);
  // ps already stripped shell quoting, so LITERAL quotes in POSIX argv are prompt text; quoted
  // tokens are honored only in the Windows CommandLine form.
  expect(
    isDaemonProcess({
      pid: 1,
      ucomm: "deno",
      command: 'deno run /tmp/tool.ts --prompt "inspect bare words" /tmp/copilot-api-notes start',
    }),
  ).toBe(false);
  // Every middle alternative consumes exactly one token and the classes are disjoint (`--flag=/path`
  // reads as a flag only), so a failing scan is linear. The bound catches a polynomially-slow
  // regression; an exponential one hangs the suite, still a failure.
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
  // A SIGTERM listener REPLACES deno's terminate-on-signal, and `agent stop` sends a single SIGTERM
  // with no SIGKILL escalation, so a shutdown() that never settles must not keep the daemon alive.
  dir = tempDir("copilot-shutdown-");
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
    // Windows has no deliverable SIGTERM, so the drain is a POSIX contract. The request must be
    // genuinely mid-flight when the signal lands: the handler parks until this process writes the
    // release, which happens only after the child reports the signal arrived.
    dir = tempDir("copilot-sigterm-");
    const target = join(dir, "serving.ts");
    const release = join(dir, "release");
    writeFileSync(
      target,
      `import { installTerminationHandler } from ${SHUTDOWN_MODULE};\n` +
        `import { installInferenceObserver } from ${
          importSpecifier(join(ROOT, "src", "copilot_api", "inference_activity.ts"))
        };\n` +
        `const release = ${CHILD_VALUES}.release;\n` +
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
      env: childValuesEnv({ release }),
      stdout: "piped",
      stderr: "piped",
    });
    let stdout = "";
    let stdoutOpen = true;
    const decoder = new TextDecoder();
    const reader = child.stdout.getReader();
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        stdout += decoder.decode(value);
      }
    })().finally(() => {
      stdoutOpen = false;
    });
    // No clock of its own: the test deadline is the one budget for a slow child, and the harness
    // kills this child when it fires, which closes stdout and ends the wait.
    const awaitLine = async (line: string): Promise<void> => {
      while (!stdout.includes(line) && stdoutOpen) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(stdout).toContain(line);
    };
    let inFlight: Promise<Response> | undefined;
    try {
      // Signal it only once it is genuinely listening (the handler installs before serve).
      await awaitLine("PORT ");
      const match = /PORT (\d+)/.exec(stdout);
      expect(match).not.toBeNull();
      inFlight = fetch(`http://127.0.0.1:${match?.[1]}/`);
      inFlight.catch(() => {}); // marked handled; the await below is what surfaces a failure
      await awaitLine("SERVING"); // the handler is parked, response not yet written

      child.kill("SIGTERM");
      // The listener prints in the same tick the drain starts, so a daemon that reaches its drain
      // deadline without this line exits, closes stdout, and fails the wait right here.
      await awaitLine("SIGNALLED");
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

// The escalating teardowns SIGKILL after the shared grace, so the drain deadline must finish first
// or they sever the responses the drain protects. The daemon-side module keeps its own literal
// because it loads inside the daemon, where a CLI import does not belong.
test("the drain deadline fits inside the SIGKILL grace", () => {
  expect(DRAIN_DEADLINE_MS).toBeLessThan(DAEMON_SIGKILL_GRACE_MS);
});
