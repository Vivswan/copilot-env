// The REAL codex CLI, with the Direct probe's own argv (CODEX_PROBE), against the fake model
// endpoint in a scratch HOME: the shapes our probe and health checks parse are pinned against
// what the installed release prints today, and the fake's journal shows what the CLI sent.
//
// Skipped on a machine without the binary. COPILOT_ENV_LIVE_CLIS (set by checks.yml and the
// fleet nightly after installing the CLIs) opts in: the tests run and a missing codex is a
// failure, never a skip that lets the gate pass vacuously.
import { join } from "node:path";
import { CODEX_PROBE, PROBE_PROMPT, summarizeProbeFailure } from "../src/agents/live_probe.ts";
import { codexLiveLaunch } from "../src/health/live_launch.ts";
import { resolveCommand } from "../src/utils/command.ts";
import type { FakeModelEndpoint } from "./fake_model_endpoint.ts";
import {
  FAKE_CODEX_MODEL,
  FAKE_USER_AGENT,
  jsonLines,
  runFakeCli,
  type ScenarioName,
  startFakeEndpoint,
  writeCodexFakeConfig,
} from "./helpers/fake_endpoint.ts";
import { afterEach, beforeEach, expect, removeDir, tempDir, test } from "./helpers/testing.ts";

const LIVE_ENV = "COPILOT_ENV_LIVE_CLIS";
const codexPath = resolveCommand("codex");
const live = test.skipIf(codexPath === null && !process.env[LIVE_ENV]);
/** Codex reconnects five times on a rejected request before it gives up; a cold start on a CI
 *  runner adds to that. */
const TEST_TIMEOUT_MS = 180_000;

let fake: FakeModelEndpoint;
let home = "";

beforeEach(async () => {
  home = tempDir("codex-live-");
  fake = await startFakeEndpoint(home);
});

afterEach(async () => {
  await fake.close();
  home = removeDir(home);
});

/** The probe's exact argv against a scratch CODEX_HOME, under a hermetic env (fakeCliEnv). */
function runCodex(scenario: ScenarioName) {
  if (codexPath === null) throw new Error(`${LIVE_ENV} is set but no codex CLI is on PATH`);
  const codexHome = join(home, ".codex");
  writeCodexFakeConfig(codexHome, fake.baseUrl, scenario);
  return runFakeCli(
    "codex",
    CODEX_PROBE.args(PROBE_PROMPT, codexHome, FAKE_CODEX_MODEL),
    home,
    { [CODEX_PROBE.homeEnvVar]: codexHome },
    TEST_TIMEOUT_MS - 10_000,
  );
}

live(
  "a Direct-shaped provider answers: exit 0, the agent_message item, and the baked headers on the wire",
  async () => {
    const run = await runCodex("ok");
    expect(run.exitCode, run.stderr).toBe(0);
    // The health probe's own read of the same stream: the model answered.
    expect(codexLiveLaunch(home, null).answered(run.stdout)).toBe(true);
    const answer = jsonLines(run.stdout).find((e) => e.type === "item.completed");
    expect(answer).toMatchObject({ "item": { "type": "agent_message", "text": "OK" } });
    expect(jsonLines(run.stdout).some((e) => e.type === "turn.completed")).toBe(true);

    // What codex sent: `http_headers` verbatim (the bearer present; aimock redacts its value),
    // its own originator, an SSE accept, a stream to `/responses` with no `/v1` (the base URL
    // carries none, as Copilot's does).
    const request = await fake.lastRequest("responses");
    expect(request?.path).toBe("/responses");
    expect(request?.headers["authorization"]).toBeDefined();
    expect(request?.headers["user-agent"]).toBe(FAKE_USER_AGENT);
    expect(request?.headers["openai-intent"]).toBe("conversation-edits");
    expect(request?.headers["originator"]).toBe("codex_exec");
    expect(request?.headers["accept"]).toBe("text/event-stream");
    expect(request?.body).toMatchObject({ "model": FAKE_CODEX_MODEL, "stream": true });
    expect(request?.interrupted).toBe(false);
  },
  TEST_TIMEOUT_MS,
);

live(
  "a 401 ends the run as turn.failed after codex's own reconnects, with the status in the probe's reason",
  async () => {
    const run = await runCodex("unauthorized");
    expect(run.exitCode).toBe(1);
    const events = jsonLines(run.stdout);
    expect(events.some((e) => e.type === "turn.failed")).toBe(true);
    expect(events.some((e) => e.type === "item.completed")).toBe(false);
    expect(summarizeProbeFailure(1, null, undefined, run.stdout, run.stderr)).toMatch(/401/);
    // The first attempt plus codex's five reconnects, every one the same rejected request.
    const attempts = (await fake.journal()).filter((r) => r.path.startsWith("/responses"));
    expect(attempts.length).toBe(6);
    expect(attempts.every((r) => r.status === 401)).toBe(true);
  },
  TEST_TIMEOUT_MS,
);

live(
  "a connection dropped after the first delta ends the run as turn.failed within seconds, after five reconnects",
  async () => {
    const run = await runCodex("truncate-after-first-delta");
    expect(run.exitCode).toBe(1);
    expect(run.timedOut).toBe(false);
    const events = jsonLines(run.stdout);
    const failed = events.find((e) => e.type === "turn.failed");
    expect(failed).toMatchObject({
      "error": { "message": expect.stringContaining("stream disconnected before completion") },
    });
    expect(events.some((e) => e.type === "item.completed")).toBe(false);
    // The first attempt plus codex's five reconnects, each a stream the fake cut mid-way.
    const attempts = (await fake.journal()).filter((r) => r.path.startsWith("/responses"));
    expect(attempts.length).toBe(6);
    expect(attempts.every((r) => r.interrupted)).toBe(true);
  },
  TEST_TIMEOUT_MS,
);
