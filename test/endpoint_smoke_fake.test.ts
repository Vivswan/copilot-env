// directSmoke over a REAL HTTP round trip to the fake model endpoint: the requests the Direct
// smoke sends (paths, headers, bodies) and the verdict each endpoint answer yields. The unit test
// (endpoint_smoke.test.ts) stubs fetch and pins the verdict arms; this one pins what actually
// leaves the process, which is what Copilot judges.
//
// The smoke's request shape is fixed (no prompt, no custom headers), so the scenario rides on a
// fetch wrapper that adds the fake's scenario header; the fetch underneath is the real one.
import { CLAUDE_ENDPOINT_SMOKE } from "../src/claude/config.ts";
import { CODEX_ENDPOINT_SMOKE } from "../src/codex/config.ts";
import { directSmoke } from "../src/copilot_api/endpoint_smoke.ts";
import type { ProbeFetch } from "../src/copilot_api/integration_identity.ts";
import { type FakeModelEndpoint, SCENARIO_HEADER } from "./helpers/fake_model_endpoint.ts";
import { type ScenarioName, startFakeEndpoint } from "./helpers/fake_endpoint.ts";
import { afterEach, beforeEach, expect, tempDir, test } from "./helpers/testing.ts";

let fake: FakeModelEndpoint;
let dir = "";

beforeEach(async () => {
  dir = tempDir("smoke-fake-");
  fake = await startFakeEndpoint(dir);
});

afterEach(async () => {
  await fake.close();
});

function scenarioFetch(scenario: ScenarioName | null): ProbeFetch {
  return (input, init) =>
    fetch(input, {
      ...init,
      headers: {
        ...(init?.headers as Record<string, string> | undefined),
        ...(scenario === null ? {} : { [SCENARIO_HEADER]: scenario }),
      },
    });
}

async function smoke(
  which: "claude" | "codex",
  scenario: ScenarioName | null,
): Promise<{ ok: boolean; detail: string; model: string | null }> {
  const s = directSmoke(
    which === "claude" ? CLAUDE_ENDPOINT_SMOKE : CODEX_ENDPOINT_SMOKE,
    "tok",
    "codex_exec/1.0.0",
    "vscode-chat",
    fake.baseUrl,
    { fetchImpl: scenarioFetch(scenario) },
  );
  const picked = await s.pickModel();
  if (!picked.ok) return { ok: false, detail: picked.detail, model: null };
  const outcome = await s.ping(picked.model);
  return { ok: outcome.ok, detail: outcome.ok ? "" : outcome.detail, model: picked.model };
}

test("the claude smoke: the haiku pick, then one 1-token /v1/messages call under the baked identity", async () => {
  const got = await smoke("claude", null);
  expect(got).toEqual({ ok: true, detail: "", model: "claude-haiku-4-5" });

  // The catalog request is journaled by the front in full, credential included.
  const catalog = await fake.lastRequest("models");
  expect(catalog?.headers["user-agent"]).toBe("codex_exec/1.0.0");
  expect(catalog?.headers["copilot-integration-id"]).toBe("vscode-chat");
  expect(catalog?.headers["openai-intent"]).toBe("conversation-edits");
  expect(catalog?.headers["authorization"]).toBe("Bearer tok");

  // The ping is journaled by aimock, which redacts the credential's value; the identity headers
  // ride on the ping exactly as on the catalog look.
  const ping = await fake.lastRequest("messages");
  expect(ping?.path).toBe("/v1/messages");
  expect(ping?.headers["anthropic-version"]).toBe("2023-06-01");
  expect(ping?.headers["authorization"]).toBeDefined();
  expect(ping?.headers["user-agent"]).toBe("codex_exec/1.0.0");
  expect(ping?.headers["copilot-integration-id"]).toBe("vscode-chat");
  expect(ping?.headers["openai-intent"]).toBe("conversation-edits");
  expect(ping?.body).toMatchObject({
    "model": "claude-haiku-4-5",
    "max_tokens": 1,
    "messages": [{ "role": "user", "content": "x" }],
  });
  expect(ping?.interrupted).toBe(false);
});

test("the codex smoke: the reduced-tier pick, then one capped /responses call with no /v1 prefix", async () => {
  const got = await smoke("codex", null);
  expect(got).toEqual({ ok: true, detail: "", model: "gpt-5.4-mini" });

  const ping = await fake.lastRequest("responses");
  expect(ping?.path).toBe("/responses");
  expect(ping?.headers["anthropic-version"]).toBeUndefined();
  expect(ping?.headers["authorization"]).toBeDefined();
  expect(ping?.headers["user-agent"]).toBe("codex_exec/1.0.0");
  expect(ping?.headers["copilot-integration-id"]).toBe("vscode-chat");
  expect(ping?.headers["openai-intent"]).toBe("conversation-edits");
  // aimock journals its NORMALIZED view of a Responses body (`input` and `max_output_tokens`
  // fold into its chat shape), so only the fields it keeps are pinned here; the raw ping body
  // is pinned in endpoint_smoke.test.ts.
  expect(ping?.body).toMatchObject({ "model": "gpt-5.4-mini", "stream": false });
});

test("every rejection the endpoint can answer lands as a false verdict carrying the body's reason", async () => {
  const cases: { which: "claude" | "codex"; scenario: ScenarioName; detail: RegExp }[] = [
    {
      which: "claude",
      scenario: "unauthorized",
      detail:
        /^POST \/v1\/messages with claude-haiku-4-5 returned 401 \(.*authentication_error.*\)$/,
    },
    {
      which: "claude",
      scenario: "model-not-found",
      detail: /returned 404 \(.*"model: claude-haiku-4-5".*\)$/,
    },
    {
      which: "codex",
      scenario: "tier-rejected",
      detail:
        /^POST \/responses with gpt-5\.4-mini returned 400 \(.*service_tier is not supported.*\)$/,
    },
  ];
  for (const c of cases) {
    const got = await smoke(c.which, c.scenario);
    expect({ scenario: c.scenario, ok: got.ok }).toEqual({ scenario: c.scenario, ok: false });
    expect(got.detail).toMatch(c.detail);
  }
  // The catalog look is scenario-blind: every case still picked before it pinged.
  const journal = await fake.journal();
  const count = (prefix: string) => journal.filter((r) => r.path.startsWith(prefix)).length;
  expect([count("/models"), count("/v1/messages"), count("/responses")]).toEqual([3, 2, 1]);
});
