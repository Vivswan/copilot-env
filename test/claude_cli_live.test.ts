// The REAL claude CLI, with the Direct probe's own argv (CLAUDE_PROBE), against the fake model
// endpoint in a scratch HOME: the shapes our probe and health checks parse are pinned against
// what the installed release prints today, and the fake's journal shows what the CLI sent.
//
// Skipped on a machine without the binary. COPILOT_ENV_LIVE_CLIS (set by checks.yml and the
// fleet nightly after installing the CLIs) opts in: the tests run and a missing claude is a
// failure, never a skip that lets the gate pass vacuously.
import { join } from "node:path";
import { CLAUDE_PROBE, PROBE_PROMPT } from "../src/agents/live_probe.ts";
import { claudeLiveLaunch } from "../src/health/live_launch.ts";
import { resolveCommand } from "../src/utils/command.ts";
import type { FakeModelEndpoint } from "./helpers/fake_model_endpoint.ts";
import {
  FAKE_CLAUDE_MODEL,
  FAKE_USER_AGENT,
  jsonLines,
  runFakeCli,
  type ScenarioName,
  startFakeEndpoint,
  writeClaudeFakeSettings,
} from "./helpers/fake_endpoint.ts";
import { afterEach, beforeEach, expect, removeDir, tempDir, test } from "./helpers/testing.ts";

const LIVE_ENV = "COPILOT_ENV_LIVE_CLIS";
const claudePath = resolveCommand("claude");
const live = test.skipIf(claudePath === null && !process.env[LIVE_ENV]);
/** A cold CLI start on a CI runner takes a while; the fake itself answers in milliseconds. */
const TEST_TIMEOUT_MS = 120_000;

let fake: FakeModelEndpoint;
let home = "";

beforeEach(async () => {
  home = tempDir("claude-live-");
  fake = await startFakeEndpoint(home);
});

afterEach(async () => {
  await fake.close();
  home = removeDir(home);
});

/** The probe's exact argv against a scratch config dir, under a hermetic env (fakeCliEnv). */
function runClaude(scenario: ScenarioName) {
  if (claudePath === null) throw new Error(`${LIVE_ENV} is set but no claude CLI is on PATH`);
  const claudeHome = join(home, ".claude");
  writeClaudeFakeSettings(claudeHome, fake.baseUrl, scenario);
  return runFakeCli(
    "claude",
    CLAUDE_PROBE.args(PROBE_PROMPT, claudeHome, FAKE_CLAUDE_MODEL),
    home,
    { [CLAUDE_PROBE.homeEnvVar]: claudeHome },
    TEST_TIMEOUT_MS - 10_000,
  );
}

function resultLine(stdout: string): Record<string, unknown> | undefined {
  return jsonLines(stdout).find((e) => e.type === "result");
}

live(
  "a Direct-shaped wiring answers: exit 0, a success result line, and the baked identity on the wire",
  async () => {
    const run = await runClaude("ok");
    expect(run.exitCode, run.stderr).toBe(0);
    // The health probe's own read of the same stream: the model answered.
    expect(claudeLiveLaunch(home, null).answered(run.stdout)).toBe(true);
    expect(resultLine(run.stdout)).toMatchObject({
      "type": "result",
      "subtype": "success",
      "is_error": false,
      "result": "OK",
      "num_turns": 1,
    });

    // What claude sent: the settings' bearer (present; aimock redacts its value) and custom
    // headers, the pinned model, a stream.
    const request = await fake.lastRequest("messages");
    expect(request?.headers["authorization"]).toBeDefined();
    expect(request?.headers["user-agent"]).toBe(FAKE_USER_AGENT);
    expect(request?.headers["openai-intent"]).toBe("conversation-edits");
    expect(request?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(request?.body).toMatchObject({ "model": FAKE_CLAUDE_MODEL, "stream": true });
    expect(request?.interrupted).toBe(false);
  },
  TEST_TIMEOUT_MS,
);

live(
  "a model the endpoint rejects ends the run at once: exit 1 and an error result naming the status",
  async () => {
    const run = await runClaude("model-not-found");
    expect(run.exitCode).toBe(1);
    expect(resultLine(run.stdout)).toMatchObject({
      "type": "result",
      "is_error": true,
      "api_error_status": 404,
    });
    // A 4xx the SDK does not retry: the prompt, plus at most claude's session-title request,
    // every one rejected.
    const messages = (await fake.journal()).filter((r) => r.path.startsWith("/v1/messages"));
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages.length).toBeLessThanOrEqual(2);
    expect(messages.every((r) => r.status === 404)).toBe(true);
  },
  TEST_TIMEOUT_MS,
);

// Not exercised: a stream whose connection drops mid-way. claude reads it as a connection error
// and retries ten times over about six minutes before it re-asks without streaming, which no
// test may take; codex_cli_live.test.ts exercises the same drop through codex, which fails fast.
