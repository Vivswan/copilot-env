// `agent proxy-token`: the resolver decision matrix at the deps seam, and the stdout
// contract at the spawn level. Stdout is sacred in every branch -- the key line from
// runPrintProxyToken is the only write -- so each table row asserts the full effect
// set {launched, prompted, heartbeat, key printed, exit code} and the spawn tests
// assert stdout byte-for-byte.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type LaunchOutput,
  type ProxyTokenDeps,
  resolveProxyToken,
} from "../src/commands/proxy_token.ts";
import { parseProfileName, type Profile } from "../src/copilot_api/profile.ts";
import { envSnapshot, removeDir, writeRunState } from "./helpers.ts";
import { importSpecifier, ROOT, runCli, runScript, spawnChild } from "./helpers/run.ts";
import { afterEach, expect, test } from "./helpers/testing.ts";

const skipWin = test.skipIf(process.platform === "win32");
const WORK = parseProfileName("work");

const PROMPT = "copilot proxy not running. Start it now? [Y/n] ";

const restoreEnv = envSnapshot();
let dir = "";

afterEach(() => {
  restoreEnv();
  dir = removeDir(dir);
});

// --- the deps-level decision matrix -------------------------------------------

interface Recorded {
  launches: Array<{ profile: Profile; output: LaunchOutput }>;
  prompts: string[];
  heartbeats: Profile[];
  printed: Profile[];
  notes: string[];
}

interface FakeOptions {
  up?: boolean;
  autoStart?: boolean;
  /** The interactive answer readAnswer resolves ("" = the EOF/default shape). */
  answer?: string;
  /** Whether a launch actually brings the proxy up (default true). */
  launchBringsUp?: boolean;
}

function fakeDeps(opts: FakeOptions): { deps: ProxyTokenDeps; rec: Recorded } {
  let up = opts.up ?? false;
  const rec: Recorded = { launches: [], prompts: [], heartbeats: [], printed: [], notes: [] };
  const deps: ProxyTokenDeps = {
    proxyUp: (_profile) => Promise.resolve(up),
    autoStartEnabled: () => opts.autoStart ?? false,
    launchProxy: (profile, output) => {
      rec.launches.push({ profile, output });
      if (opts.launchBringsUp ?? true) up = true;
    },
    readAnswer: (query) => {
      rec.prompts.push(query);
      return Promise.resolve(opts.answer ?? "");
    },
    recordHeartbeat: (profile) => {
      rec.heartbeats.push(profile);
    },
    printProxyToken: (profile) => {
      rec.printed.push(profile);
      return Promise.resolve();
    },
    notify: (line) => {
      rec.notes.push(line);
    },
  };
  return { deps, rec };
}

test("proxy already up: no launch, no prompt -- heartbeat then the key, exit 0", async () => {
  for (const assumeYes of [true, false]) {
    const { deps, rec } = fakeDeps({ up: true, autoStart: false });
    expect(await resolveProxyToken({ assumeYes, profile: null }, deps)).toBe(0);
    expect(rec.launches).toEqual([]);
    expect(rec.prompts).toEqual([]);
    expect(rec.heartbeats).toEqual([null]);
    expect(rec.printed).toEqual([null]);
    expect(rec.notes).toEqual([]);
  }
});

test("down + managed lifecycle: silent suppressed auto-start on BOTH paths, never a prompt", async () => {
  for (const assumeYes of [true, false]) {
    const { deps, rec } = fakeDeps({ autoStart: true });
    expect(await resolveProxyToken({ assumeYes, profile: null }, deps)).toBe(0);
    expect(rec.launches).toEqual([{ profile: null, output: "suppressed" }]);
    expect(rec.prompts).toEqual([]); // the opt-in is honored even interactively
    expect(rec.printed).toEqual([null]);
    expect(rec.notes).toEqual([]);
  }
});

test("down + managed + start fails: exit 1, no key, and the hidden failure gets a pointer", async () => {
  const { deps, rec } = fakeDeps({ autoStart: true, launchBringsUp: false });
  expect(await resolveProxyToken({ assumeYes: true, profile: null }, deps)).toBe(1);
  expect(rec.launches).toEqual([{ profile: null, output: "suppressed" }]);
  expect(rec.printed).toEqual([]);
  expect(rec.heartbeats).toEqual([null]); // the heartbeat is unconditional
  // The auto-start suppressed the daemon's own error, so the pointer must surface it.
  expect(rec.notes).toEqual([
    "copilot proxy failed to start (run 'agent start' to see the error).",
  ]);
});

test("down + unmanaged + --yes (headless): never auto-start, exit 1 with no noise", async () => {
  const { deps, rec } = fakeDeps({ autoStart: false });
  expect(await resolveProxyToken({ assumeYes: true, profile: null }, deps)).toBe(1);
  expect(rec.launches).toEqual([]);
  expect(rec.prompts).toEqual([]);
  expect(rec.printed).toEqual([]);
  expect(rec.heartbeats).toEqual([null]);
  // No suppressed start happened, so no misleading "failed to start" pointer either.
  expect(rec.notes).toEqual([]);
});

test("down + unmanaged + interactive: '', y, yes in any case (EOF reads as '') mean START", async () => {
  for (const answer of ["", "y", "Y", "yes", "YES", "Yes", " y "]) {
    const { deps, rec } = fakeDeps({ autoStart: false, answer });
    expect(await resolveProxyToken({ assumeYes: false, profile: null }, deps)).toBe(0);
    expect(rec.prompts).toEqual([PROMPT]);
    // The confirmed start stays VISIBLE (child stdout -> our stderr), unlike the managed one.
    expect(rec.launches).toEqual([{ profile: null, output: "visible" }]);
    expect(rec.printed).toEqual([null]);
    expect(rec.notes).toEqual([]);
  }
});

test("down + unmanaged + interactive: any other answer declines -- no launch, exit 1", async () => {
  for (const answer of ["n", "N", "no", "x", "nope"]) {
    const { deps, rec } = fakeDeps({ autoStart: false, answer });
    expect(await resolveProxyToken({ assumeYes: false, profile: null }, deps)).toBe(1);
    expect(rec.prompts).toEqual([PROMPT]);
    expect(rec.launches).toEqual([]);
    expect(rec.printed).toEqual([]);
    expect(rec.heartbeats).toEqual([null]);
    expect(rec.notes).toEqual([
      "Continuing without the proxy; proxy-backed agents need it (run 'agent start').",
    ]);
  }
});

test("--profile routes every daemon-scoped step and names the profile in the hints", async () => {
  // Declined interactive: the hint must point at the PROFILE's daemon.
  const declined = fakeDeps({ autoStart: false, answer: "n" });
  expect(await resolveProxyToken({ assumeYes: false, profile: WORK }, declined.deps)).toBe(1);
  expect(declined.rec.heartbeats).toEqual([WORK]);
  expect(declined.rec.notes).toEqual([
    "Continuing without the proxy; proxy-backed agents need it (run 'agent start --profile work').",
  ]);

  // Managed start failure: same profile-aware pointer, and the launch is profile-scoped.
  const failed = fakeDeps({ autoStart: true, launchBringsUp: false });
  expect(await resolveProxyToken({ assumeYes: true, profile: WORK }, failed.deps)).toBe(1);
  expect(failed.rec.launches).toEqual([{ profile: WORK, output: "suppressed" }]);
  expect(failed.rec.notes).toEqual([
    "copilot proxy failed to start (run 'agent start --profile work' to see the error).",
  ]);

  // Happy path: the key print is addressed at the profile's daemon config.
  const happy = fakeDeps({ up: true });
  expect(await resolveProxyToken({ assumeYes: true, profile: WORK }, happy.deps)).toBe(0);
  expect(happy.rec.printed).toEqual([WORK]);
});

// --- spawn level: the stdout contract ------------------------------------------

/** A hermetic child env: isolated agent homes, quiet consola. */
function isolatedEnv(home: string): Record<string, string> {
  return {
    ...process.env as Record<string, string>,
    CONSOLA_LEVEL: "5",
    COPILOT_API_HOME: home,
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CODEX_HOME: join(home, ".codex"),
  };
}

test("spawned refuse path (--yes, down, unmanaged): exit 1 and a byte-empty stdout", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-proxy-token-"));
  const res = runCli(["proxy-token", "--yes"], { env: isolatedEnv(dir) });
  expect(res.exitCode).toBe(1);
  expect(res.stdout).toBe("");
});

test("spawned decline path: prompt and refusal live on stderr, stdout stays byte-empty", () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-proxy-token-"));
  const res = runCli(["proxy-token"], { env: isolatedEnv(dir), input: "n\n" });
  expect(res.exitCode).toBe(1);
  expect(res.stdout).toBe("");
  expect(res.stderr).toContain("copilot proxy not running. Start it now? [Y/n]");
  expect(res.stderr).toContain("Continuing without the proxy");
});

skipWin("spawned happy path: stdout is EXACTLY the persisted key + newline, exit 0", async () => {
  dir = mkdtempSync(join(tmpdir(), "copilot-proxy-token-"));
  // A live pid whose command line matches the daemon signature -- since the sweep/status
  // match was narrowed, that means a real deno process running a copilot-api-named entry
  // file with the `start` subcommand (the COPILOT_API_ENTRY shape), not just any argv
  // mentioning the words -- plus a real listening loopback port recorded in run state:
  // exactly what proxyStatus verifies before the resolver prints a key.
  const decoy = join(dir, "copilot-api-decoy.mjs");
  writeFileSync(decoy, "setTimeout(() => {}, 30_000);\n");
  const daemon = spawnChild(Deno.execPath(), {
    args: ["run", decoy, "start"],
    stdout: "null",
    stderr: "null",
  });
  const { server, port } = await new Promise<{ server: Server; port: number }>(
    (resolve, reject) => {
      const srv = createServer();
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const address = srv.address();
        if (address === null || typeof address === "string") {
          reject(new Error("expected an AddressInfo"));
          return;
        }
        resolve({ server: srv, port: address.port });
      });
    },
  );
  try {
    process.env.COPILOT_API_HOME = dir; // writeRunState resolves the store from the env
    writeRunState({ pid: daemon.pid, port });
    const res = runCli(["proxy-token", "--yes"], { env: isolatedEnv(dir) });
    expect(res.exitCode).toBe(0);
    // The whole stdout is one key line -- the external contract every consumer
    // (Codex auth.command, Claude apiKeyHelper, the launchers' eval) relies on.
    const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as {
      auth?: { apiKeys?: string[] };
    };
    const key = config.auth?.apiKeys?.[0];
    expect(typeof key).toBe("string");
    expect(res.stdout).toBe(`${key}\n`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      daemon.kill("SIGKILL");
    } catch {
      // already gone
    }
    await daemon.status;
  }
});

test("readStartAnswer: the prompt goes to stderr, EOF reads as the empty (default) answer", () => {
  // The real stdin reader, driven as a child so EOF and stream placement are the
  // genuine article: closed stdin must resolve "" (= START, like the shells' `read -r`),
  // and the query must land on stderr -- stdout carries only the probe's own JSON.
  dir = mkdtempSync(join(tmpdir(), "copilot-proxy-token-"));
  const probe = join(dir, "read_answer_probe.ts");
  writeFileSync(
    probe,
    [
      `import { readStartAnswer } from ${
        importSpecifier(join(ROOT, "src", "commands", "proxy_token.ts"))
      };`,
      'console.log(JSON.stringify(await readStartAnswer("ANSWER? ")));',
    ].join("\n"),
  );
  const eof = runScript(probe, [], { env: isolatedEnv(dir) });
  expect(eof.exitCode).toBe(0);
  expect(eof.stdout).toBe('""\n');
  expect(eof.stderr).toContain("ANSWER? ");

  const answered = runScript(probe, [], { env: isolatedEnv(dir), input: "No\n" });
  expect(answered.exitCode).toBe(0);
  expect(answered.stdout).toBe('"No"\n');
});
