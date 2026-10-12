import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DRAIN_DEADLINE_MS,
  LATE_LISTENER_GRACE_MS,
} from "../../src/copilot_api/daemon_shutdown.ts";
import {
  DAEMON_CLIENT_HEADERS_ENV,
  DAEMON_COPILOT_HOST_ENV,
  daemonClientHeaders,
} from "../../src/copilot_api/integration_identity.ts";
import {
  classifyPidFromScan,
  DAEMON_GH_TOKEN_ENV,
  DAEMON_RUNTIMES,
  DAEMON_SIGKILL_GRACE_MS,
  type DaemonOwnership,
  type DaemonSpec,
  daemonArgv,
  daemonEnvironment,
  daemonPidsFromRows,
  daemonPreloadFile,
  isDaemonCommandLine,
  isDaemonProcess,
  launchDaemon,
  noProxyWithLoopback,
  parseProcessRows,
  type RunnableEntry,
  renderDaemonPreload,
  resolveCopilotApiEntry,
} from "../../src/copilot_api/process.ts";
import { installedProxyPackage } from "../../src/copilot_api/version.ts";
import { proxyHome, proxyInstallDir, writeResolvedVersionRecord } from "../../src/proxy_float.ts";
import { pidAlive } from "../../src/utils/pid.ts";
import { INSTALLED_BINARY_POSIX } from "../../src/utils/targets.ts";
import {
  FAKE_DAEMON_CREDENTIAL,
  FAKE_DAEMON_HOST,
  fakeProxyEntry,
  plantProxyInstall,
  until,
} from "../helpers/daemon.ts";
import { envSnapshot, isolateProxyHome } from "../helpers/env.ts";
import {
  bunRunArgs,
  CHILD_VALUES,
  childValuesEnv,
  importSpecifier,
  ROOT,
  runSync,
  spawnChild,
} from "../helpers/run.ts";
import { afterEach, beforeEach, expect, tempDir, test } from "../helpers/testing.ts";

// Every daemon spawn derives from ONE DaemonSpec, so argv and environment are pinned against the
// spec rather than a pile of optional arguments.

const restoreEnv = envSnapshot([
  "COPILOT_API_ENTRY",
  "NO_PROXY",
  "no_proxy",
  "HTTP_PROXY",
  "NODE_PATH",
]);
let dir = "";

// The entry resolver reads the float's record out of the root home; on a dev machine that HAS
// floated, a shared home would resolve a real version here while a hermetic container would not.
beforeEach(() => {
  dir = isolateProxyHome("copilot-daemon-spawn-");
});

afterEach(() => {
  restoreEnv();
});

const FAKE = join(ROOT, "test", "copilot-api-fake.mjs");

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
    kind: "file",
    path: FAKE,
    proxyHome: "/the/root/home/proxy",
    nodeModules: "/the/root/home/proxy/install/node_modules",
  },
};

/** The shims the daemon's one preload file imports, in load order, by file name. */
function preloads(spec: DaemonSpec): string[] {
  return [...renderDaemonPreload(spec).matchAll(/import "([^"]+)";/g)].map(
    (m) => (m[1] as string).split("/").at(-1) as string,
  );
}

/** A complete install of `version` in the isolated root home's proxy home; the proxy's entry path. */
function plantInstalledProxy(version: string): string {
  return plantProxyInstall(dir, version);
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
  // The file's one line, as bun reads it: file URLs, which an import accepts on every platform.
  expect(renderDaemonPreload(BASE)).toBe(
    `${base
      .map(
        (shim) =>
          `import ${JSON.stringify(pathToFileURL(join(ROOT, "src", "scripts", shim)).href)};`,
      )
      .join(" ")}\n`,
  );
  // Our own environment already carries both credential keys (an earlier launch in this shell):
  // the credential environment is always set from the spec, so a stale value can never leak in.
  const stale = {
    [DAEMON_GH_TOKEN_ENV]: "gho_from_an_earlier_run",
    [DAEMON_CLIENT_HEADERS_ENV]: '{"User-Agent":"stale"}',
    COPILOT_API_OAUTH_APP: "opencode",
  };
  // The codex identity names the id header as a deletion, so the proxy's own cannot stand in.
  const CODEX_HEADERS = daemonClientHeaders("codex_exec/1", null);
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
      // Every credential rides with its identity's header set, as the shim parses it back. The
      // rewrite rides copilot-api's default upstream path, so the opencode app switch is scrubbed
      // for every credential.
      spec: { credential: { kind: "token", token: "gho_new", clientHeaders: CODEX_HEADERS } },
      preloads: base,
      env: [
        {
          inherited: stale,
          keys: {
            [DAEMON_GH_TOKEN_ENV]: "gho_new",
            [DAEMON_CLIENT_HEADERS_ENV]: JSON.stringify(CODEX_HEADERS),
            COPILOT_API_OAUTH_APP: undefined,
          },
        },
      ],
    },
    {
      spec: { credential: { kind: "pat", token: "ghp_x", clientHeaders: CLI_HEADERS } },
      preloads: [...base, "pat_passthrough_preload.ts"],
      env: [
        {
          inherited: stale,
          keys: {
            [DAEMON_GH_TOKEN_ENV]: "ghp_x",
            [DAEMON_CLIENT_HEADERS_ENV]: JSON.stringify(CLI_HEADERS),
            COPILOT_API_OAUTH_APP: undefined,
          },
        },
      ],
    },
    {
      // The daemon inherits our TLS/proxy environment; the spec's own wiring wins over an inherited
      // copy, and an inherited NODE_PATH is replaced, never joined: the shims resolve from the
      // proxy home's install alone.
      spec: { home: "/profiles/work" },
      preloads: base,
      env: [
        {
          inherited: {
            NODE_EXTRA_CA_CERTS: "/etc/corp.pem",
            HTTPS_PROXY: "http://corp:3128",
            COPILOT_API_HOME: "/the/default/home",
            NODE_PATH: "/somewhere/else",
          },
          keys: {
            NODE_EXTRA_CA_CERTS: "/etc/corp.pem",
            HTTPS_PROXY: "http://corp:3128",
            COPILOT_API_HOME: "/profiles/work",
            NODE_PATH: "/the/root/home/proxy/install/node_modules",
            BUN_BE_BUN: "1",
          },
        },
      ],
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
    // The argv carries that one file, under the entry's proxy home: the root-home mark the scan
    // reads, whatever the entry kind.
    expect(daemonArgv(spec).filter((_flag, i, argv) => argv[i - 1] === "--preload")).toEqual([
      daemonPreloadFile(spec.entry.proxyHome),
    ]);
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

// (record, the proxy home's install, the checkout's copy) -> the entry kind and the file run. A
// record whose install is gone must never name a file that is not there; the float gate ahead of
// every start is what reinstalls it, and the checkout copy is the fallback until then.
test("resolveCopilotApiEntry: the float's record runs its installed bin; an override always wins", () => {
  delete process.env.COPILOT_API_ENTRY;
  const home = {
    proxyHome: proxyHome(dir),
    nodeModules: join(proxyInstallDir(dir), "node_modules"),
  };
  const checkout = installedProxyPackage();
  if (checkout === null) throw new Error("the checkout has no installed proxy (bun install)");

  // No record: the checkout's own copy.
  expect(resolveCopilotApiEntry()).toEqual({ kind: "package", path: checkout.entry, ...home });

  // A record with no install tree: still the checkout copy.
  writeResolvedVersionRecord(dir, "1.14.30", Date.now());
  expect(resolveCopilotApiEntry()).toEqual({ kind: "package", path: checkout.entry, ...home });
  // The install tree is the version that runs, whatever the record names: a tree complete for
  // another version is the floated entry at that version (the float makes the record follow).
  const older = plantInstalledProxy("1.14.29");
  expect(resolveCopilotApiEntry()).toEqual({
    kind: "floated",
    version: "1.14.29",
    path: older,
    ...home,
  });
  // A tree missing its entry file: the float's verifier refuses it, so the spawn never names a
  // file that is not there.
  const bin = plantInstalledProxy("1.14.30");
  rmSync(bin);
  expect(resolveCopilotApiEntry().kind).toBe("package");

  // The tree installed complete: run exactly its bin, as the package names it.
  plantInstalledProxy("1.14.30");
  expect(resolveCopilotApiEntry()).toEqual({
    kind: "floated",
    version: "1.14.30",
    path: bin,
    ...home,
  });

  // The override runs that file whether or not a float resolved, so the CI fake is never
  // shadowed by a real install; a relative spelling resolves against the CALLER's cwd here,
  // because the daemon's own cwd is the proxy home.
  process.env.COPILOT_API_ENTRY = FAKE;
  expect(resolveCopilotApiEntry()).toEqual({ kind: "file", path: FAKE, ...home });
  process.env.COPILOT_API_ENTRY = "./test/copilot-api-fake.mjs";
  expect(resolveCopilotApiEntry()).toEqual({
    kind: "file",
    path: resolve("./test/copilot-api-fake.mjs"),
    ...home,
  });
});

// --- the launched binary ---------------------------------------------------------------

// The daemon is the running executable as a bun CLI, in the proxy home, resolving the shims'
// imports from there: a compiled binary spawning itself without BUN_BE_BUN would re-run the CLI,
// and a cwd left to the caller would land bun's own discovery (bunfig, package.json) on a
// stranger's files. A `.env` in that cwd is what bun autoloads, so one with a sentinel sits there:
// the daemon must not see it.
test("launchDaemon spawns process.execPath as a bun CLI with the proxy home as cwd and NODE_PATH, loading no .env", async () => {
  const entryFile = join(dir, "report-runtime.ts");
  writeFileSync(
    entryFile,
    "console.log('RUNTIME:' + JSON.stringify({ execPath: process.execPath, cwd: process.cwd(), " +
      "nodePath: process.env.NODE_PATH, beBun: process.env.BUN_BE_BUN, " +
      "dotenv: process.env.COPILOT_ENV_TEST_DOTENV_SENTINEL ?? null }));\n",
  );
  const logFile = join(dir, "spawn.log");
  const home = proxyHome(dir);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, ".env"), "COPILOT_ENV_TEST_DOTENV_SENTINEL=leaked\n");
  const pid = launchDaemon({
    ...BASE,
    home: dir,
    logFile,
    entry: {
      kind: "file",
      path: entryFile,
      proxyHome: home,
      nodeModules: join(home, "install", "node_modules"),
    },
  });
  try {
    expect(pid).toBeGreaterThan(0);
    let logged = "";
    await until(() => {
      logged = readFileSync(logFile, "utf8");
      return logged.includes("RUNTIME:");
    });
    const raw = /RUNTIME:(.+)/.exec(logged)?.[1]?.trim();
    if (raw === undefined) throw new Error(`no RUNTIME line; log was: ${logged}`);
    const reported = JSON.parse(raw) as {
      execPath: string;
      cwd: string;
      nodePath: string;
      beBun: string;
      dotenv: string | null;
    };
    // realpath both sides: the OS tmpdir may be a symlink, and bun canonicalizes its execPath.
    expect(realpathSync(reported.execPath)).toBe(realpathSync(process.execPath));
    expect(realpathSync(reported.cwd)).toBe(realpathSync(home));
    expect(reported.nodePath).toBe(join(home, "install", "node_modules"));
    expect(reported.beBun).toBe("1");
    expect(reported.dotenv).toBeNull();
  } finally {
    // On Windows the isolate root's removal would race a still-running child, so wait until the
    // pid is genuinely gone.
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    await until(() => !pidAlive(pid));
  }
}, 30_000); // a real daemon boot on a loaded runner

// --- the daemon environment ----------------------------------------------------------

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

// The runtime gate reads the process table's executable name: `bun` in a checkout (this very
// process), the installed binary's name under a release. targets.ts owns that name and the
// copilot_api layer does not import install/, so the two spellings are pinned here.
test("DAEMON_RUNTIMES names the installed binary and the checkout's bun", () => {
  expect(DAEMON_RUNTIMES).toContain(INSTALLED_BINARY_POSIX);
  expect(DAEMON_RUNTIMES).toContain(parse(process.execPath).name);
});

test("parseProcessRows splits pid and ucomm off, keeping the command line verbatim", () => {
  const rows = parseProcessRows(
    "  900 distnoted        /usr/sbin/distnoted agent\n" +
      "12345 bun              /home/me/.bun/bin/bun run --no-env-file /x/node_modules/@jeffreycao/copilot-api/dist/main.js start --port 4141\n" +
      "\n" +
      "not a row\n",
  );
  expect(rows).toEqual([
    { pid: 900, ucomm: "distnoted", command: "/usr/sbin/distnoted agent" },
    {
      pid: 12345,
      ucomm: "bun",
      command:
        "/home/me/.bun/bin/bun run --no-env-file /x/node_modules/@jeffreycao/copilot-api/dist/main.js start --port 4141",
    },
  ]);
  // A command line with runs of spaces survives intact -- only the leading columns split.
  expect(parseProcessRows("7 sh sh -c 'a   b'")).toEqual([
    { pid: 7, ucomm: "sh", command: "sh -c 'a   b'" },
  ]);
});

test("daemonPidsFromRows preserves a FAILED scan as unproven, never a confident empty list", () => {
  const self = { pid: 111, ucomm: "bun", command: "bun test" };
  // Ours by its preload file under this root home's proxy home, the mark the scan reads with the
  // real roots.
  const daemon = {
    pid: 222,
    ucomm: "bun",
    command:
      `/home/me/.bun/bin/bun run --preload ${daemonPreloadFile(proxyHome(dir))} ` +
      "/x/node_modules/@jeffreycao/copilot-api/dist/main.js start",
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

function daemonRow(
  spec: DaemonSpec,
  ucomm: (typeof DAEMON_RUNTIMES)[number] = "bun",
): { pid: number; ucomm: string; command: string } {
  const runtime =
    ucomm === "bun" ? "/home/me/.bun/bin/bun" : `/home/me/.copilot-env/current/bin/${ucomm}`;
  return { pid: 1, ucomm, command: [runtime, ...daemonArgv(spec)].join(" ") };
}

test("the sweep signature matches every real daemon shape, straight from daemonArgv", () => {
  delete process.env.COPILOT_API_ENTRY;
  writeResolvedVersionRecord(dir, "1.14.30", Date.now());
  plantInstalledProxy("1.14.30");
  const floated = { ...BASE, entry: resolveCopilotApiEntry() as RunnableEntry };
  expect(floated.entry.kind).toBe("floated");
  // The installed binary's daemon and a checkout's alike, and every entry kind: the one preload
  // file under this root home's proxy home marks them all.
  expect(isDaemonProcess(daemonRow(floated, "copilot-env"))).toBe(true);
  expect(isDaemonProcess(daemonRow(floated))).toBe(true);
  const file = { ...BASE, entry: fakeProxyEntry() };
  expect(isDaemonProcess(daemonRow(file))).toBe(true);
  expect(isDaemonProcess(daemonRow({ ...file, idleWatchdog: true, muteProxyLogs: true }))).toBe(
    true,
  );
  const checkout = installedProxyPackage();
  if (checkout === null) throw new Error("the checkout has no installed proxy (bun install)");
  const pkg = {
    ...BASE,
    entry: { ...fakeProxyEntry(), kind: "package" as const, path: checkout.entry },
  };
  expect(isDaemonProcess(daemonRow(pkg))).toBe(true);
  // The same spawn from ANOTHER root home (a sibling test file's scratch home, a developer's real
  // one beside a suite's): daemon-shaped, marked, and not ours, so no sweep crosses root homes.
  const elsewhere = {
    ...BASE,
    entry: {
      ...fakeProxyEntry(),
      proxyHome: "/elsewhere/proxy",
      nodeModules: "/elsewhere/proxy/install/node_modules",
    },
  };
  expect(isDaemonProcess(daemonRow(elsewhere))).toBe(false);
  expect(isDaemonProcess(daemonRow(elsewhere, "copilot-env"))).toBe(false);

  // ps flattens a SPACED path, but both fragments still carry slashes; missing this daemon would
  // make proxyStatus read it as down and `agent stop` skip it.
  const spacedInstall: DaemonOwnership = {
    preloadRoots: ["/Users/John Smith/.local/share/copilot-env/proxy"],
    entryRoots: [
      "/Users/John Smith/.local/share/copilot-env/proxy/install/node_modules/@jeffreycao/copilot-api",
    ],
  };
  expect(
    isDaemonProcess(
      {
        pid: 1,
        ucomm: "copilot-env",
        command:
          "/Users/John Smith/.copilot-env/current/bin/copilot-env run --no-env-file --no-install " +
          "--preload /Users/John Smith/.local/share/copilot-env/proxy/daemon_preload.ts " +
          "/Users/John Smith/.local/share/copilot-env/proxy/install/node_modules/@jeffreycao/copilot-api/dist/main.js " +
          "start --verbose --port 4141",
      },
      spacedInstall,
    ),
  ).toBe(true);
  // The same package run by another tool from its own node_modules: daemon-shaped, and not ours.
  // Only our spawn's marks say so: the preload file under this root home's proxy home, or an entry
  // in this proxy home's install.
  expect(
    isDaemonProcess({
      pid: 1,
      ucomm: "bun",
      command:
        "/home/me/.bun/bin/bun run /opt/unrelated/node_modules/@jeffreycao/copilot-api/dist/main.js start --port 4141",
    }),
  ).toBe(false);
  // The DOCUMENTED loss: a path component of two or more words flattens into a slash-less bare
  // fragment ("Runtime"), which the signature refuses; every bare-word tolerance re-admitted impostors.
  expect(
    isDaemonProcess({
      pid: 1,
      ucomm: "bun",
      command:
        "/Applications/Bun Runtime Tools/bun run --no-install " +
        "/x/node_modules/@jeffreycao/copilot-api/dist/main.js start --verbose --port 4141",
    }),
  ).toBe(false);
});

test("the Windows CommandLine mirror matches the image-quoted daemon shapes, ownership included", () => {
  // Roots in the OS's own spelling: the quoted paths below must be read as theirs through quotes,
  // backslashes, and case.
  const windowsInstall: DaemonOwnership = {
    preloadRoots: ["C:\\Users\\John Smith\\AppData\\Local\\copilot-env\\proxy"],
    entryRoots: [
      "C:\\Users\\John Smith\\AppData\\Local\\copilot-env\\proxy\\install\\node_modules\\@jeffreycao\\copilot-api",
      "C:\\x\\node_modules\\@x\\copilot-api",
    ],
  };
  // Quoted image path (spaces and all), .exe suffix -- the WMI CommandLine form.
  expect(
    isDaemonCommandLine(
      '"C:\\Users\\John Smith\\.copilot-env\\current\\bin\\copilot-env.exe" run --no-env-file --no-install ' +
        '"C:\\Users\\John Smith\\AppData\\Local\\copilot-env\\proxy\\install\\node_modules\\@jeffreycao\\copilot-api\\dist\\main.js" ' +
        "start --verbose --port 4141",
      windowsInstall,
    ),
  ).toBe(true);
  // The same package under another tool's node_modules: the shape matches, the ownership does not.
  expect(
    isDaemonCommandLine(
      '"C:\\Users\\John Smith\\.copilot-env\\current\\bin\\copilot-env.exe" run --no-env-file --no-install ' +
        '"C:\\tools\\other\\node_modules\\@jeffreycao\\copilot-api\\dist\\main.js" start',
      windowsInstall,
    ),
  ).toBe(false);
  // A quoted file entry with spaces is still a real daemon (its --preload marks it ours); missing
  // it would make `agent stop` skip it.
  expect(
    isDaemonCommandLine(
      '"C:\\Program Files\\Bun\\bun.exe" run --preload "C:\\Users\\John Smith\\AppData\\Local\\copilot-env\\proxy\\daemon_preload.ts" "C:\\tmp\\copilot-api fake.mjs" start --port 4141',
      windowsInstall,
    ),
  ).toBe(true);
  expect(
    isDaemonCommandLine(
      "C:\\Users\\me\\.bun\\bin\\bun.exe run C:\\x\\node_modules\\@x\\copilot-api\\dist\\main.js start",
      windowsInstall,
    ),
  ).toBe(true);
  // Prompt text in a non-runtime image's argv never matches, whatever it mentions.
  expect(
    isDaemonCommandLine(
      '"C:\\Program Files\\Codex\\codex.exe" exec --prompt fix the copilot-api start sweep',
      windowsInstall,
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
      ucomm: "bun",
      command: "/home/me/.bun/bin/bun run script.ts --note copilot-api start",
    }),
  ).toBe(false);
  // A copilot-api-SHAPED path in a runtime's own arguments: the bare word before it
  // ("inspect" -- prompt text, another script's argument) breaks the invocation shape.
  expect(
    isDaemonProcess({
      pid: 1,
      ucomm: "bun",
      command: "bun run worker.ts --prompt inspect /tmp/copilot-api-notes start safely",
    }),
  ).toBe(false);
  // A copilot-api path token NOT followed by the start subcommand (a foreground run).
  expect(
    isDaemonProcess({
      pid: 1,
      ucomm: "bun",
      command: "/opt/bun/bun run /x/node_modules/@jeffreycao/copilot-api/dist/main.js auth login",
    }),
  ).toBe(false);
  // A codex process even with a perfectly daemon-shaped command line: ucomm decides.
  expect(
    isDaemonProcess({
      pid: 1,
      ucomm: "codex",
      command: "/opt/bun/bun run /x/node_modules/@jeffreycao/copilot-api/dist/main.js start",
    }),
  ).toBe(false);
  // The suite's own bun processes: a test runner, the CLI under test. Neither carries an entry.
  expect(
    isDaemonProcess({
      pid: 1,
      ucomm: "bun",
      command: "bun test test/copilot_api/daemon_spawn.test.ts",
    }),
  ).toBe(false);
  expect(
    isDaemonProcess({
      pid: 1,
      ucomm: "bun",
      command: "bun run --no-env-file /repo/src/cli.ts start --port 4141",
    }),
  ).toBe(false);
  // A copilot-api-named ROOT HOME in an unrelated flag never qualifies as the entry.
  expect(
    isDaemonProcess({
      pid: 1,
      ucomm: "bun",
      command:
        "bun run --preload /home/me/.local/share/copilot-api/proxy/x.ts /repo/src/cli.ts env",
    }),
  ).toBe(false);
  // Slash-carrying tokens must not read as one "spaced path" bridging over the bare word: that
  // tolerance is exactly what re-admits prompt-text argv.
  expect(
    isDaemonProcess({
      pid: 1,
      ucomm: "bun",
      command: "bun run /tmp/tool.ts inspect /tmp/data /tmp/copilot-api-notes start",
    }),
  ).toBe(false);
  // ps already stripped shell quoting, so LITERAL quotes in POSIX argv are prompt text; quoted
  // tokens are honored only in the Windows CommandLine form.
  expect(
    isDaemonProcess({
      pid: 1,
      ucomm: "bun",
      command: 'bun run /tmp/tool.ts --prompt "inspect bare words" /tmp/copilot-api-notes start',
    }),
  ).toBe(false);
  // Every middle alternative consumes exactly one token and the classes are disjoint (`--flag=/path`
  // reads as a flag only), so a failing scan is linear. The bound catches a polynomially-slow
  // regression; an exponential one hangs the suite, still a failure.
  const pathHeavy = `bun run ${Array.from(
    { length: 60 },
    (_v, i) => `/dir${i}/file${i}.ts --flag${i}=/opt/val${i}`,
  ).join(" ")} tail`;
  const startedMs = Date.now();
  expect(isDaemonProcess({ pid: 1, ucomm: "bun", command: pathHeavy })).toBe(false);
  expect(Date.now() - startedMs).toBeLessThan(1_000);
});

// --- the shared shutdown path --------------------------------------------------------

const SHUTDOWN_MODULE = importSpecifier(join(ROOT, "src", "copilot_api", "daemon_shutdown.ts"));

test("a wedged drain still exits: the deadline is what keeps `agent stop` able to stop us", () => {
  // A SIGTERM listener REPLACES the runtime's terminate-on-signal, and `agent stop` sends a single
  // SIGTERM with no SIGKILL escalation, so a stop() that never settles must not keep the daemon alive.
  dir = tempDir("copilot-shutdown-");
  const target = join(dir, "wedged.ts");
  writeFileSync(
    target,
    `import { recordDaemonServer, shutdownDaemon, DRAIN_DEADLINE_MS } from ${SHUTDOWN_MODULE};\n` +
      "recordDaemonServer({ stop: () => new Promise(() => {}) });\n" +
      "const started = Date.now();\n" +
      "process.on('exit', () => console.log(String(Date.now() - started)));\n" +
      "await shutdownDaemon(0);\n" +
      "console.log('UNREACHABLE');\n",
  );
  const res = runSync(process.execPath, [...bunRunArgs(), target], { timeoutMs: 30_000 });
  expect(res.exitCode).toBe(0);
  expect(res.stdout).not.toContain("UNREACHABLE"); // the path never returns
  // It waited the full drain window (small margin for timer coarseness).
  expect(Number(res.stdout.trim())).toBeGreaterThanOrEqual(DRAIN_DEADLINE_MS - 100);
});

test.skipIf(process.platform === "win32")(
  "SIGTERM drains an IN-FLIGHT request before the daemon exits, the proxy's own exit held back",
  async () => {
    // Windows has no deliverable SIGTERM, so the drain is a POSIX contract. The request must be
    // genuinely mid-flight when the signal lands: the handler parks until this process writes the
    // release, which happens only after the child reports the signal arrived. The LATE listener is
    // copilot-api's own shape, registered after the preload: an async cleanup, then its own exit.
    // Run in the same emit it would sever the response, so it runs after the drain, and its cleanup
    // must still finish before the process is gone.
    dir = tempDir("copilot-sigterm-");
    const target = join(dir, "serving.ts");
    const release = join(dir, "release");
    writeFileSync(
      target,
      `import { existsSync } from "node:fs";\n` +
        `import { installTerminationHandler } from ${SHUTDOWN_MODULE};\n` +
        `import { installInferenceObserver } from ${importSpecifier(
          join(ROOT, "src", "copilot_api", "inference_activity.ts"),
        )};\n` +
        `const release = ${CHILD_VALUES}.release;\n` +
        // Registered BEFORE the handler, so it runs in the signal's own emit and the parent learns
        // the signal was delivered while the drain is under way.
        "process.on('SIGTERM', () => console.log('SIGNALLED'));\n" +
        "installInferenceObserver();\n" +
        "installTerminationHandler();\n" +
        "process.once('SIGTERM', async () => { console.log('LATE'); await new Promise((r) => setTimeout(r, 50)); console.log('CLEANED'); process.exit(0); });\n" +
        // The other signal's late listener: a SIGTERM must not replay it.
        "process.once('SIGINT', () => console.log('WRONG-SIGNAL'));\n" +
        "const parked = async () => {\n" +
        "  console.log('SERVING');\n" +
        "  while (!existsSync(release)) await new Promise((r) => setTimeout(r, 20));\n" +
        "  return new Response('drained-ok');\n" +
        "};\n" +
        "const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: parked });\n" +
        "console.log('PORT ' + server.port);\n" +
        "process.on('exit', () => console.log('DRAINED'));\n",
    );
    // Bun.spawn reports the real wait status (exit code and signal apart), so a clean exit after
    // the SIGTERM is distinguishable from a death by that signal.
    const child = spawnChild(process.execPath, {
      args: [...bunRunArgs(), target],
      env: childValuesEnv({ release }),
      stdout: "pipe",
      stderr: "pipe",
    });
    let stdout = "";
    let stdoutOpen = true;
    const decoder = new TextDecoder();
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
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

      expect(await child.exited).toBe(0);
      expect(child.signalCode).toBeNull();
      await pump;
      // Drained through the shared path, not severed by the runtime's default terminate (which
      // runs no exit handlers); the late listener ran only once the response was out, and its
      // cleanup finished before the exit hook.
      const order = ["SERVING", "LATE", "CLEANED", "DRAINED"].map((line) => stdout.indexOf(line));
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(order.every((at) => at >= 0)).toBe(true);
      expect(stdout).not.toContain("WRONG-SIGNAL");
    } finally {
      // An assertion that threw before the request was consumed would otherwise hold the
      // connection -- and the child -- open.
      await inFlight?.then(
        (r) => r.body?.cancel(),
        () => {},
      );
      await (child.stderr as ReadableStream<Uint8Array>).cancel();
    }
  },
);

// The escalating teardowns SIGKILL after the shared grace, so the drain deadline and the late
// listeners' grace must finish first or they sever the responses the drain protects. The
// daemon-side module keeps its own literal because it loads inside the daemon, where a CLI import
// does not belong.
test("the drain deadline and the late listeners' grace fit inside the SIGKILL grace", () => {
  expect(DRAIN_DEADLINE_MS + LATE_LISTENER_GRACE_MS).toBeLessThan(DAEMON_SIGKILL_GRACE_MS);
});
