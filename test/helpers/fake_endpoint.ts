// The one seam the tests reach the fake model endpoint through: the scenario table, the start,
// and the two CLIs' scratch configs pointed at it. A different backend would land here alone.
//
// The configs carry the static-key Direct shape (the bearer baked, the client identity in the
// CLI's extra-headers knob) with the fake's URL as the host, so the request the fake journals is
// the request a Direct wiring makes; the scenario rides in the same knob as one more header.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "smol-toml";
import {
  AUTH_TOKEN_ENV,
  BASE_URL_ENV,
  CUSTOM_HEADERS_ENV,
  DISABLE_BETAS_ENV,
} from "../../src/claude/config.ts";
import { settingsPathFor } from "../../src/claude/paths.ts";
import { directClientHeaders } from "../../src/copilot_api/integration_identity.ts";
import { childPathPrepending, verbatimCliSpawn } from "../../src/utils/command.ts";
import {
  type FakeModelEndpoint,
  hermeticEnv,
  SCENARIO_HEADER,
  type Scenarios,
  startFakeModelEndpoint,
} from "../fake_model_endpoint.ts";
import { spawnChild } from "./run.ts";

export const FAKE_CLAUDE_TOKEN = "fake-token-claude";
export const FAKE_CODEX_TOKEN = "fake-token-codex";
/** The identity the scratch configs bake, distinct from anything a real wiring sends. */
export const FAKE_USER_AGENT = "copilot-env-test/1.0";
/** The models the scratch configs pin, both in the fake's catalog. */
export const FAKE_CLAUDE_MODEL = "claude-haiku-4-5";
export const FAKE_CODEX_MODEL = "gpt-5.4";

/** The Responses stream prelude (response.created, response.in_progress, the message's
 *  response.output_item.added, response.content_part.added) before the first text delta. */
const RESPONSES_PRELUDE_FRAMES = 4;
/** codex sends `include: ["reasoning.encrypted_content"]`, and aimock answers a reasoning model
 *  with a blob-only reasoning item BEFORE the message: one output_item.added / output_item.done
 *  pair, two frames ahead of the prelude. */
const RESPONSES_REASONING_ITEM_FRAMES = 2;
/** aimock's `truncateAfterChunks: N` delivers N - 1 frames: it aborts before writing the Nth. */
const AIMOCK_CUT_OFFSET = 1;

/** Every scenario a test can name. The error bodies are the vendors' envelopes with Copilot's
 *  words where Copilot has its own (the service_tier rejection). */
export const SCENARIOS = {
  "ok": { kind: "text", text: "OK" },
  "unauthorized": {
    kind: "error",
    status: 401,
    type: "authentication_error",
    message: "invalid x-api-key",
  },
  "model-not-found": {
    kind: "error",
    status: 404,
    type: "not_found_error",
    message: `model: ${FAKE_CLAUDE_MODEL}`,
  },
  "tier-rejected": {
    kind: "error",
    status: 400,
    type: "invalid_request_error",
    message: "service_tier is not supported",
    code: "unsupported_parameter",
  },
  // The connection drops right after the FIRST content delta of a codex-shaped Responses stream
  // (aimock destroys the socket, so this is the mid-stream disconnect, not a clean early end).
  // The frame count is codex's request shape (reasoning item, prelude, one delta) plus aimock's
  // off-by-one; fake_model_endpoint.test.ts pins that exactly one delta gets through. Exercised
  // through codex, which reconnects five times within seconds and fails the turn; claude reads
  // the same drop as a connection error it retries ten times over about six minutes, so its arm
  // is recorded, never exercised.
  "truncate-after-first-delta": {
    kind: "truncate",
    text: "OK, and this reply is long enough to be cut after its first delta",
    afterFrames: RESPONSES_REASONING_ITEM_FRAMES + RESPONSES_PRELUDE_FRAMES + 1 +
      AIMOCK_CUT_OFFSET,
  },
} satisfies Scenarios;

export type ScenarioName = keyof typeof SCENARIOS;

/** Start the fake on the whole table; `dir` (the caller's temp dir) holds the fixture file. */
export function startFakeEndpoint(dir: string): Promise<FakeModelEndpoint> {
  return startFakeModelEndpoint(dir, SCENARIOS);
}

/** The identity headers a Direct wiring bakes (directClientHeaders, no integration id), plus the
 *  scenario header when a scenario is named. */
export function fakeClientHeaders(scenario: ScenarioName | null): Record<string, string> {
  return {
    ...directClientHeaders(FAKE_USER_AGENT, null),
    ...(scenario === null ? {} : { [SCENARIO_HEADER]: scenario }),
  };
}

/** A settings.json under `claudeHome` at the fake: `--bare --settings <path>` reads its `env`. */
export function writeClaudeFakeSettings(
  claudeHome: string,
  baseUrl: string,
  scenario: ScenarioName | null,
): string {
  mkdirSync(claudeHome, { recursive: true });
  const path = settingsPathFor(claudeHome);
  const customHeaders = Object.entries(fakeClientHeaders(scenario))
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
  const settings = {
    "env": {
      [BASE_URL_ENV]: baseUrl,
      [AUTH_TOKEN_ENV]: FAKE_CLAUDE_TOKEN,
      [CUSTOM_HEADERS_ENV]: customHeaders,
      [DISABLE_BETAS_ENV]: "1",
    },
  };
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  return path;
}

/** A config.toml under `codexHome`: one provider table at the fake on the responses wire, the
 *  bearer and the identity in `http_headers`. The base URL carries no `/v1`, as Copilot's does. */
export function writeCodexFakeConfig(
  codexHome: string,
  baseUrl: string,
  scenario: ScenarioName | null,
): string {
  mkdirSync(codexHome, { recursive: true });
  const path = join(codexHome, "config.toml");
  const doc = {
    "model": FAKE_CODEX_MODEL,
    "model_provider": "fake",
    "model_providers": {
      "fake": {
        "name": "fake",
        "base_url": baseUrl,
        "wire_api": "responses",
        "requires_openai_auth": false,
        "http_headers": {
          "Authorization": `Bearer ${FAKE_CODEX_TOKEN}`,
          ...fakeClientHeaders(scenario),
        },
      },
    },
  };
  writeFileSync(path, stringify(doc));
  return path;
}

/** The COMPLETE env a CLI child gets (the spawn clears the inherited one): the hermetic
 *  allowlist (hermeticEnv), PATH led by the CLI's own bin dir (an npm shim needs node beside it),
 *  a scratch HOME so nothing on the machine is read or written, the CLIs' quiet switches, and
 *  the caller's `extra`. */
export function fakeCliEnv(
  home: string,
  binDir: string | null,
  extra: Record<string, string>,
): Record<string, string> {
  return hermeticEnv({
    PATH: childPathPrepending([binDir]),
    HOME: home,
    USERPROFILE: home,
    NO_PROXY: "127.0.0.1,localhost",
    DISABLE_TELEMETRY: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ...extra,
  });
}

export interface CliRun {
  /** -1 when the deadline killed it before it exited. */
  exitCode: number;
  stdout: string;
  stderr: string;
  /** The deadline killed it: the run never ended on its own. */
  timedOut: boolean;
}

/** After the deadline kill, how long the output pipes get to close. An npm shim is a launcher
 *  whose native child (codex) may outlive it holding the pipes; the wait is bounded so a wedged
 *  CLI ends the test instead of the test waiting on it. */
const KILL_GRACE_MS = 5_000;

/**
 * Run an installed CLI to completion under the hermetic env, cwd `home`. Async on purpose: the
 * fake's front serves from THIS process, so a blocking spawn would starve the very requests the
 * child is making. The spawn recipe is verbatimCliSpawn's (an npm `.ps1` shim on Windows runs
 * through powershell without cmd.exe; a batch-only shim takes the cmd.exe hop).
 */
export async function runFakeCli(
  cli: "claude" | "codex",
  args: string[],
  home: string,
  extra: Record<string, string>,
  timeoutMs: number,
): Promise<CliRun> {
  const spec = verbatimCliSpawn(cli, args);
  const child = spawnChild(spec.shell ? "cmd.exe" : spec.file, {
    args: spec.shell ? ["/d", "/s", "/c", [spec.file, ...spec.args].join(" ")] : spec.args,
    windowsRawArguments: spec.shell,
    cwd: home,
    env: fakeCliEnv(home, spec.binDir, extra),
    clearEnv: true,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  });
  const output = child.output();
  const decoder = new TextDecoder();
  const finished = await Promise.race([output, sleep(timeoutMs).then(() => null)]);
  if (finished !== null) {
    return {
      exitCode: finished.code,
      stdout: decoder.decode(finished.stdout),
      stderr: decoder.decode(finished.stderr),
      timedOut: false,
    };
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // already exited
  }
  // The launcher is dead; its output settles only if no descendant still holds the pipes.
  const late = await Promise.race([output, sleep(KILL_GRACE_MS).then(() => null)]);
  return {
    exitCode: -1,
    stdout: late === null ? "" : decoder.decode(late.stdout),
    stderr: late === null ? "" : decoder.decode(late.stderr),
    timedOut: true,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One JSON object per stdout line; a line that is not one is skipped. */
export function jsonLines(stdout: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null) {
        out.push(parsed as Record<string, unknown>);
      }
    } catch {
      // not a JSON line
    }
  }
  return out;
}
