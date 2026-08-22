import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  copilotApiArgv,
  DAEMON_GH_TOKEN_ENV,
  DAEMON_SIGKILL_GRACE_MS,
  daemonArgv,
  daemonEnvironment,
  type DaemonSpec,
  noProxyWithLoopback,
  parseProcessRows,
  resolveCopilotApiEntry,
} from "../src/copilot_api/process.ts";
import { DAEMON_INTEGRATION_ID_ENV } from "../src/copilot_api/integration_identity.ts";
import { DRAIN_DEADLINE_MS } from "../src/scripts/daemon_shutdown.ts";
import { PROXY_PACKAGE_NAME } from "../src/copilot_api/version.ts";
import { denoRunArgs, importSpecifier, ROOT, runSync, spawnChild } from "./helpers/run.ts";
import { afterEach, expect, test } from "./helpers/testing.ts";
import { envSnapshot, removeDir, tmpDir } from "./helpers.ts";

// The daemon spawn is assembled from ONE DaemonSpec: the preload set, the credential
// environment, and the entry all derive from it, so the argv and the environment are
// pinned here against the spec rather than against a pile of optional arguments.

const restoreEnv = envSnapshot(["COPILOT_API_ENTRY", "NO_PROXY", "no_proxy", "HTTP_PROXY"]);
let dir = "";

afterEach(() => {
  restoreEnv();
  dir = removeDir(dir);
});

const BASE: DaemonSpec = {
  port: 4141,
  logFile: "/tmp/proxy.log",
  env: {},
  credential: { kind: "none" },
  idleWatchdog: false,
  muteProxyLogs: false,
};

/** The shim filenames the argv preloads, in order. */
function preloads(spec: DaemonSpec): string[] {
  const argv = daemonArgv(spec);
  return argv
    .filter((_path, i) => argv[i - 1] === "--preload")
    .map((path) => path.split(/[\\/]/).at(-1) as string);
}

test("the preload set derives from the credential kind, in load order", () => {
  // No credential: nothing to splice onto argv, nothing for the PAT shim to read.
  expect(preloads(BASE)).toEqual(["daemon_runtime_preload.ts"]);

  // A plain token: the argv splice loads FIRST, but no passthrough shim.
  expect(preloads({ ...BASE, credential: { kind: "token", token: "gho_x" } })).toEqual([
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
    "token_argv_preload.ts",
    "daemon_runtime_preload.ts",
    "pat_passthrough_preload.ts",
  ]);
});

test("the watchdog and log-mute shims load only when their config knob is on", () => {
  expect(preloads({ ...BASE, idleWatchdog: true })).toEqual([
    "daemon_runtime_preload.ts",
    "idle_watchdog_preload.ts",
  ]);
  expect(preloads({ ...BASE, muteProxyLogs: true })).toEqual([
    "daemon_runtime_preload.ts",
    "log_mute_preload.ts",
  ]);
  expect(preloads({ ...BASE, idleWatchdog: true, muteProxyLogs: true })).toEqual([
    "daemon_runtime_preload.ts",
    "idle_watchdog_preload.ts",
    "log_mute_preload.ts",
  ]);
});

test("the argv runs the mapped package with an offline-only resolve, and ends in the start command", () => {
  delete process.env.COPILOT_API_ENTRY;
  expect(resolveCopilotApiEntry()).toEqual({ kind: "package", specifier: PROXY_PACKAGE_NAME });

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
});

test("a COPILOT_API_ENTRY override runs that file and never asks for a cached package", () => {
  const fake = join(ROOT, "test", "copilot-api-fake.mjs");
  process.env.COPILOT_API_ENTRY = fake;
  expect(resolveCopilotApiEntry()).toEqual({ kind: "file", path: fake });

  const argv = daemonArgv(BASE);
  // `--cached-only` is about resolving a package; a file entry must never carry it.
  expect(argv).not.toContain("--cached-only");
  expect(argv).not.toContain(PROXY_PACKAGE_NAME);
  expect(argv.slice(-5)).toEqual([fake, "start", "--verbose", "--port", "4141"]);
});

test("copilotApiArgv runs any proxy subcommand through the same entry and permissions", () => {
  delete process.env.COPILOT_API_ENTRY;
  const argv = copilotApiArgv(["auth", "login", "--provider", "copilot"]);
  expect(argv).not.toContain("--preload"); // a foreground run loads no daemon shims
  expect(argv.slice(-4)).toEqual(["auth", "login", "--provider", "copilot"]);
  expect(argv).toContain(PROXY_PACKAGE_NAME);
});

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
    { ...BASE, env: { COPILOT_API_HOME: "/profiles/work" } },
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

test("parseProcessRows splits only the pid off, keeping the command line verbatim", () => {
  const rows = parseProcessRows(
    "  900 /usr/sbin/distnoted agent\n" +
      "12345 /home/me/.deno/bin/deno run --allow-net @jeffreycao/copilot-api start --port 4141\n" +
      "\n" +
      "not a row\n",
  );
  expect(rows).toEqual([
    { pid: 900, command: "/usr/sbin/distnoted agent" },
    {
      pid: 12345,
      command: "/home/me/.deno/bin/deno run --allow-net @jeffreycao/copilot-api start --port 4141",
    },
  ]);
  // A command line with runs of spaces survives intact -- only the first gap is a split.
  expect(parseProcessRows("7 sh -c 'a   b'")).toEqual([{ pid: 7, command: "sh -c 'a   b'" }]);
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
