// The CLI-less half of Direct detection: Direct capability is a property of the credential,
// identity, and endpoint, not of an installed binary, and a wiring written on a CLI-less machine
// sits dormant until the CLI arrives. So when the live probe (src/agents/live_probe.ts) has no CLI
// to run, this smoke asks Copilot itself, under the exact headers the wiring will bake:
//
//   GET  /models        -> the agent's pickModel chooses a model the agent could drive
//   POST <agent's wire> -> a 1-token call; 200 is the Direct verdict, anything else the proxy
import { errMessage } from "../utils/error.ts";
import { isRecord } from "../utils/json.ts";
import {
  DEFAULT_COPILOT_API_BASE,
  directClientHeaders,
  type ProbeFetch,
} from "./integration_identity.ts";

/** The two Copilot wires the managed agents speak (Claude: Anthropic messages, Codex: responses). */
export type DirectWire = "messages" | "responses";

const WIRE_PATHS: Record<DirectWire, string> = {
  "messages": "/v1/messages",
  "responses": "/responses",
};

const CATALOG_TIMEOUT_MS = 5000;
const PING_TIMEOUT_MS = 20_000;

/** One agent's endpoint smoke: its wire plus its own "can I drive this model" filter. */
export interface EndpointSmoke {
  wire: DirectWire;
  /** The smoke model from the raw /models body. Null means the catalog holds nothing this agent
   *  could drive, which is a failed smoke (Direct cannot serve the agent), not an error. */
  pickModel: (catalogBody: unknown) => string | null;
}

/** A failure always carries its one-line reason, so a fall to the proxy is never silent. */
export type EndpointSmokeOutcome = { ok: true } | { ok: false; detail: string };

/**
 * Never throws: any failure is a `false` outcome carrying its reason, and the caller wires the
 * proxy. The verdict is 200 alone, the same bar as discovery's pingModel (src/copilot_api/
 * discovery.ts); no retry, matching every other raw fetch in this layer.
 */
export async function smokeDirectEndpoint(
  smoke: EndpointSmoke,
  token: string,
  userAgent: string,
  integrationId: string | null,
  opts: { fetchImpl?: ProbeFetch } = {},
): Promise<EndpointSmokeOutcome> {
  const fetchImpl: ProbeFetch = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const headers = {
    ...directClientHeaders(userAgent, integrationId),
    "Authorization": `Bearer ${token}`,
  };
  try {
    const catalog = await fetchImpl(`${DEFAULT_COPILOT_API_BASE}/models`, {
      headers,
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    });
    if (!catalog.ok) {
      await catalog.text().catch(() => "");
      return { ok: false, detail: `GET /models returned ${catalog.status}` };
    }
    // Envelope-checked here so a body the parsers cannot read reports as a failed look, never as
    // a proven "no compatible model" (both pickModel filters return empty for either).
    const body: unknown = await catalog.json();
    if (!isRecord(body) || !Array.isArray(body.data)) {
      return { ok: false, detail: "unrecognized /models response shape" };
    }
    const model = smoke.pickModel(body);
    if (model === null) {
      return { ok: false, detail: `no model on the ${smoke.wire} wire in the catalog` };
    }
    const path = WIRE_PATHS[smoke.wire];
    const ping = await fetchImpl(`${DEFAULT_COPILOT_API_BASE}${path}`, {
      method: "POST",
      headers: smoke.wire === "messages"
        ? { ...headers, "Content-Type": "application/json", "anthropic-version": "2023-06-01" }
        : { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(pingBody(smoke.wire, model)),
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    // Drained so a keep-alive socket is reusable; the verdict is the status alone.
    await ping.text().catch(() => "");
    return ping.status === 200
      ? { ok: true }
      : { ok: false, detail: `POST ${path} with ${model} returned ${ping.status}` };
  } catch (e) {
    return { ok: false, detail: errMessage(e) };
  }
}

/** max tokens 1: Copilot bills per request, so the smoke costs one token at most. */
function pingBody(wire: DirectWire, model: string): Record<string, unknown> {
  return wire === "messages"
    ? { "model": model, "max_tokens": 1, "messages": [{ "role": "user", "content": "x" }] }
    : { "model": model, "input": "x", "stream": false, "max_output_tokens": 1 };
}
