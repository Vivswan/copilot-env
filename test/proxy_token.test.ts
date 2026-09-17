// Stdout is the external contract: the key line is the only write in every branch, so each matrix
// row asserts the full effect set and the spawn rows assert stdout byte for byte.
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import {
  type LaunchOutput,
  type ProxyTokenDeps,
  resolveProxyToken,
} from "../src/commands/proxy_token.ts";
import { CopilotApiPaths } from "../src/copilot_api/paths.ts";
import { parseProfileName, type Profile } from "../src/copilot_api/profile.ts";
import { envSnapshot, writeRunState } from "./helpers.ts";
import { importSpecifier, ROOT, runCli, runScript, spawnChild } from "./helpers/run.ts";
import { afterEach, expect, removeDir, tempDir, test } from "./helpers/testing.ts";

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

interface MatrixRow {
  name: string;
  opts: FakeOptions;
  assumeYes: boolean;
  profile: Profile;
  exit: number;
  rec: Recorded;
}

const DECLINED = (profile: string) =>
  `Continuing without the proxy; proxy-backed agents need it (run 'agent start${profile}').`;
const START_FAILED = (profile: string) =>
  `copilot proxy failed to start (run 'agent start${profile}' to see the error; ` +
  `no credential stored? run 'agent auth${profile}').`;

// The heartbeat is unconditional; a managed (auto-start) start is silent and SUPPRESSED, so its
// failure needs the pointer that surfaces the hidden error; an interactive start is VISIBLE (child
// stdout -> our stderr); every daemon-scoped step of a named profile is routed to the profile.
test("resolveProxyToken: each (up, auto-start, --yes, answer, profile) row yields its exact effect set", async () => {
  const none: Recorded = { launches: [], prompts: [], heartbeats: [null], printed: [], notes: [] };
  const rows: MatrixRow[] = [
    ...[true, false].map((assumeYes): MatrixRow => ({
      name: `already up, assumeYes=${assumeYes}: no launch, no prompt, heartbeat then the key`,
      opts: { up: true, autoStart: false },
      assumeYes,
      profile: null,
      exit: 0,
      rec: { ...none, printed: [null] },
    })),
    ...[true, false].map((assumeYes): MatrixRow => ({
      name: `down + managed, assumeYes=${assumeYes}: silent suppressed auto-start, never a prompt`,
      opts: { autoStart: true },
      assumeYes,
      profile: null,
      exit: 0,
      rec: { ...none, launches: [{ profile: null, output: "suppressed" }], printed: [null] },
    })),
    {
      name: "down + managed + start fails: exit 1, no key, the hidden failure gets a pointer",
      opts: { autoStart: true, launchBringsUp: false },
      assumeYes: true,
      profile: null,
      exit: 1,
      rec: {
        ...none,
        launches: [{ profile: null, output: "suppressed" }],
        notes: [START_FAILED("")],
      },
    },
    {
      name: "down + unmanaged + --yes (headless): never auto-start, exit 1 with no noise",
      opts: { autoStart: false },
      assumeYes: true,
      profile: null,
      exit: 1,
      rec: none,
    },
    ...["", "y", "Y", "yes", "YES", "Yes", " y "].map((answer): MatrixRow => ({
      name: `down + unmanaged + interactive ${JSON.stringify(answer)}: START, visibly`,
      opts: { autoStart: false, answer },
      assumeYes: false,
      profile: null,
      exit: 0,
      rec: {
        ...none,
        prompts: [PROMPT],
        launches: [{ profile: null, output: "visible" }],
        printed: [null],
      },
    })),
    ...["n", "N", "no", "x", "nope"].map((answer): MatrixRow => ({
      name: `down + unmanaged + interactive ${JSON.stringify(answer)}: declines, no launch`,
      opts: { autoStart: false, answer },
      assumeYes: false,
      profile: null,
      exit: 1,
      rec: { ...none, prompts: [PROMPT], notes: [DECLINED("")] },
    })),
    {
      name: "--profile, declined: the hint points at the PROFILE's daemon",
      opts: { autoStart: false, answer: "n" },
      assumeYes: false,
      profile: WORK,
      exit: 1,
      rec: { ...none, prompts: [PROMPT], heartbeats: [WORK], notes: [DECLINED(" --profile work")] },
    },
    {
      name: "--profile, managed start fails: profile-scoped launch and pointer",
      opts: { autoStart: true, launchBringsUp: false },
      assumeYes: true,
      profile: WORK,
      exit: 1,
      rec: {
        ...none,
        launches: [{ profile: WORK, output: "suppressed" }],
        heartbeats: [WORK],
        notes: [START_FAILED(" --profile work")],
      },
    },
    {
      name: "--profile, up: the key print is addressed at the profile's daemon config",
      opts: { up: true },
      assumeYes: true,
      profile: WORK,
      exit: 0,
      rec: { ...none, heartbeats: [WORK], printed: [WORK] },
    },
  ];
  for (const row of rows) {
    const { deps, rec } = fakeDeps(row.opts);
    const exit = await resolveProxyToken({ assumeYes: row.assumeYes, profile: row.profile }, deps);
    expect({ name: row.name, exit, ...rec }).toEqual({
      name: row.name,
      exit: row.exit,
      ...row.rec,
    });
  }
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

/** A daemon proxyStatus corroborates: a real deno process running a copilot-api-named entry with the
 *  `start` subcommand, plus a listening loopback port recorded in run state. */
async function stageDecoyDaemon(
  home: string,
): Promise<{ teardown: () => Promise<void> }> {
  const decoy = join(home, "copilot-api-decoy.mjs");
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
  process.env.COPILOT_API_HOME = home; // writeRunState resolves the store from the env
  writeRunState({ pid: daemon.pid, port });
  return {
    teardown: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        daemon.kill("SIGKILL");
      } catch {
        // already gone
      }
      await daemon.status;
    },
  };
}

// Stdout is ONE key line on success and byte-empty on every refusal: it is what Codex auth.command,
// Claude apiKeyHelper, and the launchers' eval consume, so the prompt and the refusal live on
// stderr. The key lives in the default daemon home's config.json. The happy row needs a POSIX decoy
// daemon, so it skips on Windows.
test(
  "spawned proxy-token: stdout is exactly the key line or nothing; prompts and refusals are stderr",
  async () => {
    const rows: Array<{
      name: string;
      args: string[];
      input?: string;
      up: boolean;
      exit: number;
      stderr: string[];
    }> = [
      { name: "refuse (--yes, down, unmanaged)", args: ["--yes"], up: false, exit: 1, stderr: [] },
      {
        name: "decline (interactive, down, unmanaged)",
        args: [],
        input: "n\n",
        up: false,
        exit: 1,
        stderr: ["copilot proxy not running. Start it now? [Y/n]", "Continuing without the proxy"],
      },
      { name: "happy (--yes, up)", args: ["--yes"], up: true, exit: 0, stderr: [] },
    ];
    for (const row of rows) {
      if (row.up && process.platform === "win32") continue;
      dir = removeDir(dir);
      dir = tempDir("copilot-proxy-token-");
      const staged = row.up ? await stageDecoyDaemon(dir) : null;
      try {
        const res = runCli(["proxy-token", ...row.args], {
          env: isolatedEnv(dir),
          input: row.input,
        });
        let stdout = "";
        if (row.up) {
          const config = JSON.parse(readFileSync(new CopilotApiPaths().configFile, "utf8")) as {
            auth?: { apiKeys?: string[] };
          };
          const key = config.auth?.apiKeys?.[0];
          expect(typeof key).toBe("string");
          stdout = `${key}\n`;
        }
        expect({ name: row.name, exitCode: res.exitCode, stdout: res.stdout }).toEqual({
          name: row.name,
          exitCode: row.exit,
          stdout,
        });
        for (const line of row.stderr) expect(res.stderr).toContain(line);
      } finally {
        await staged?.teardown();
      }
    }
  },
  60_000,
);

test("readStartAnswer: the prompt goes to stderr, EOF reads as the empty (default) answer", () => {
  // The real stdin reader, driven as a child so EOF and stream placement are the
  // genuine article: closed stdin must resolve "" (= START, like the shells' `read -r`),
  // and the query must land on stderr -- stdout carries only the probe's own JSON.
  dir = tempDir("copilot-proxy-token-");
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
