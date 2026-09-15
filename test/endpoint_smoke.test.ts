// smokeDirectEndpoint's verdict arms. The happy paths (headers, model pick, ping body) are pinned
// end to end in claude_config.test.ts / codex_config.test.ts through detect*Direct; here every
// arm must land on the right verdict, and a failure must carry its reason, because the live probe
// prints that detail as the one explanation of a fall to the proxy.
import { smokeDirectEndpoint } from "../src/copilot_api/endpoint_smoke.ts";
import { expect, test } from "./helpers/testing.ts";

const SMOKE = {
  wire: "messages" as const,
  pickModel: (body: unknown) => {
    const data = (body as { data?: { id: string }[] }).data ?? [];
    return data.find((m) => m.id.startsWith("claude-"))?.id ?? null;
  },
};

function fetchStub(responses: (Response | Error)[]): { calls: string[]; impl: typeof fetch } {
  const calls: string[] = [];
  const impl = ((input: string | URL | Request) => {
    calls.push(String(input));
    const next = responses.shift();
    if (next === undefined) throw new Error("unexpected extra request");
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }) as typeof fetch;
  return { calls, impl };
}

const catalog = () =>
  new Response(JSON.stringify({ data: [{ "id": "claude-fable-5" }] }), { status: 200 });

test("smokeDirectEndpoint: only a 200 ping is Direct; every other arm reports its own reason", async () => {
  const cases: {
    name: string;
    responses: (Response | Error)[];
    pings: number;
    ok: boolean;
    detail: RegExp | null;
  }[] = [
    {
      name: "ping answered 200",
      responses: [catalog(), new Response("{}", { status: 200 })],
      pings: 1,
      ok: true,
      detail: null,
    },
    {
      // 200 alone: a 204 or other empty success never carried a completion, so it proves nothing
      // about inference (same bar as discovery's pingModel).
      name: "ping answered a non-200 success",
      responses: [catalog(), new Response(null, { status: 204 })],
      pings: 1,
      ok: false,
      detail: /POST \/v1\/messages with claude-fable-5 returned 204/,
    },
    {
      // The rejection body rides in the detail: a gated model and a rejected request shape both
      // 400, and the status alone cost a live curl to tell apart (the /responses min-16 incident).
      name: "ping rejected",
      responses: [catalog(), new Response("unauthorized", { status: 401 })],
      pings: 1,
      ok: false,
      detail: /POST \/v1\/messages with claude-fable-5 returned 401 \(unauthorized\)/,
    },
    {
      name: "catalog rejected",
      responses: [new Response("denied", { status: 403 })],
      pings: 0,
      ok: false,
      detail: /GET \/models returned 403/,
    },
    {
      // A body the parsers cannot read is a failed look, never a proven "no compatible model".
      name: "catalog not a model envelope",
      responses: [new Response("{}", { status: 200 })],
      pings: 0,
      ok: false,
      detail: /unrecognized \/models response shape/,
    },
    {
      name: "no model on the wire",
      responses: [new Response(JSON.stringify({ data: [{ "id": "gpt-6" }] }), { status: 200 })],
      pings: 0,
      ok: false,
      detail: /no model on the messages wire/,
    },
    {
      name: "network error",
      responses: [new TypeError("fetch failed")],
      pings: 0,
      ok: false,
      detail: /fetch failed/,
    },
  ];
  for (const c of cases) {
    const { calls, impl } = fetchStub(c.responses);
    const outcome = await smokeDirectEndpoint(SMOKE, "tok", "codex_exec/1.0.0", null, {
      fetchImpl: impl,
    });
    expect({ name: c.name, ok: outcome.ok, pings: Math.max(0, calls.length - 1) }).toEqual({
      name: c.name,
      ok: c.ok,
      pings: c.pings,
    });
    if (c.detail !== null) {
      expect(outcome.ok ? "" : outcome.detail).toMatch(c.detail);
    }
  }
});
