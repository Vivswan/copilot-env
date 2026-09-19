// The Copilot-side half of Direct detection: Direct capability is a property of the credential,
// identity, and endpoint, not of an installed binary, and a wiring written on a CLI-less machine
// sits dormant until the CLI arrives. So the live probe (src/agents/live_probe.ts) asks Copilot
// itself, under the exact headers the wiring will bake:
//
//   GET  /models        -> the agent's pick, fetched only when a hop needs it: the CLI smoke's
//                          first hop is the agent's own alias when it has one (catalog-free), else
//                          the catalog pick; its second hop, after a model rejection, the agent's
//                          catalog fallback; the wire ping's one model is the catalog pick. The
//                          verdict never rides on the model the CLI would have chosen on its own
//   POST <agent's wire> -> a minimal capped call when no CLI ran; 200 is the Direct verdict,
//                          anything else the proxy
//   a probe.*-model key -> that model, as-is: one hop, no catalog fetch (the user chose it)
import { errMessage } from "../utils/error.ts";
import { defaultFetch } from "../utils/fetch.ts";
import { directClientHeaders, type ProbeFetch } from "./integration_identity.ts";
import { fetchModelCatalog } from "./models_fetch.ts";

/** The two Copilot wires the managed agents speak (Claude: Anthropic messages, Codex: responses). */
export type DirectWire = "messages" | "responses";

const WIRE_PATHS: Record<DirectWire, string> = {
  "messages": "/v1/messages",
  "responses": "/responses",
};

/** One ping's budget, shared with discovery.ts. */
export const PING_TIMEOUT_MS = 20_000;

/** One agent's endpoint smoke: its wire plus its own "can I drive this model" picks. */
export interface EndpointSmoke {
  wire: DirectWire;
  /** The wire ping's model from the raw /models body. Null means the catalog holds nothing this
   *  agent could drive, which is a failed smoke (Direct cannot serve the agent), not an error. */
  pickModel: (catalogBody: unknown) => string | null;
  /** The CLI smoke's catalog-free first hop: an alias the CLI resolves itself. Absent: the first
   *  hop is pickModel's catalog pick. */
  cliAlias?: string;
  /** The CLI smoke's second hop from the catalog, run once after a model rejection of the first.
   *  Absent: no second hop. */
  cliFallback?: (catalogBody: unknown) => string | null;
}

/** A failure always carries its one-line reason, so a fall to the proxy is never silent. */
export type EndpointSmokeOutcome = { ok: true } | { ok: false; detail: string };

export type SmokeModelOutcome = { ok: true; model: string } | { ok: false; detail: string };

/** An EndpointSmoke bound to one credential and identity: the steps the live probe composes. */
export interface DirectSmoke {
  /** GET /models under the wiring's headers, then the agent's wire pick. */
  pickModel(): Promise<SmokeModelOutcome>;
  /** The CLI smoke's first hop: the pin, else the agent's alias (no fetch), else the wire pick. */
  cliModel(): Promise<SmokeModelOutcome>;
  /** The CLI smoke's second hop after a model rejection: GET /models, then the agent's fallback;
   *  null when there is none (a pin, or an agent without a fallback). */
  cliFallbackModel(): Promise<SmokeModelOutcome | null>;
  /** One minimal capped call to the wire with that model; 200 alone is Direct. */
  ping(model: string): Promise<EndpointSmokeOutcome>;
}

type CatalogLook = { ok: true; body: unknown } | { ok: false; detail: string };

/**
 * Neither step throws: any failure is a `false` outcome carrying its reason, and the caller wires
 * the proxy. `apiBase` is the host the wiring bakes (selectDirectIdentityAndHost). The ping verdict is 200
 * alone, the same bar as discovery's pingModel (src/copilot_api/discovery.ts); no retry, matching
 * every other raw fetch in this layer. `pinnedModel` is the user's probe.*-model value: every pick
 * answers with it, there is no second hop, and nothing is fetched.
 */
export function directSmoke(
  smoke: EndpointSmoke,
  token: string,
  userAgent: string,
  integrationId: string | null,
  apiBase: string,
  opts: { fetchImpl?: ProbeFetch; pinnedModel?: string | null } = {},
): DirectSmoke {
  const fetchImpl: ProbeFetch = opts.fetchImpl ?? defaultFetch;
  const pinned = opts.pinnedModel ?? null;
  const identity = directClientHeaders(userAgent, integrationId);
  const headers = { ...identity, "Authorization": `Bearer ${token}` };
  const catalog = async (): Promise<CatalogLook> => {
    const got = await fetchModelCatalog({ host: apiBase, token, headers: identity, fetchImpl });
    switch (got.kind) {
      case "http":
        return { ok: false, detail: `GET /models returned ${got.status}` };
      case "unparsable":
      case "network":
        return { ok: false, detail: errMessage(got.error) };
    }
    // A body the parsers cannot read reports as a failed look, never as a proven "no compatible
    // model" (both pickModel filters return empty for either).
    if (got.models === null) {
      return { ok: false, detail: "unrecognized /models response shape" };
    }
    return { ok: true, body: got.body };
  };
  const noModel = {
    ok: false as const,
    detail: `no model on the ${smoke.wire} wire in the catalog`,
  };
  const catalogPick = async (
    pick: (body: unknown) => string | null,
  ): Promise<SmokeModelOutcome> => {
    const got = await catalog();
    if (!got.ok) return got;
    const model = pick(got.body);
    return model === null ? noModel : { ok: true, model };
  };
  return {
    pickModel() {
      if (pinned !== null) return Promise.resolve({ ok: true, model: pinned });
      return catalogPick(smoke.pickModel);
    },
    cliModel() {
      if (pinned !== null) return Promise.resolve({ ok: true, model: pinned });
      if (smoke.cliAlias !== undefined) return Promise.resolve({ ok: true, model: smoke.cliAlias });
      return catalogPick(smoke.pickModel);
    },
    cliFallbackModel() {
      const fallback = smoke.cliFallback;
      if (pinned !== null || fallback === undefined) return Promise.resolve(null);
      return catalogPick(fallback);
    },
    async ping(model) {
      const path = WIRE_PATHS[smoke.wire];
      try {
        const ping = await fetchImpl(`${apiBase}${path}`, {
          method: "POST",
          headers: smoke.wire === "messages"
            ? { ...headers, "Content-Type": "application/json", "anthropic-version": "2023-06-01" }
            : { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(pingBody(smoke.wire, model)),
          signal: AbortSignal.timeout(PING_TIMEOUT_MS),
        });
        // Drained so a keep-alive socket is reusable; the body rides into the failure detail
        // because the status alone cannot say WHY (a gated model and a rejected request shape
        // both 400).
        const text = await ping.text().catch(() => "");
        if (ping.status === 200) return { ok: true };
        const reason = text.replace(/\s+/g, " ").trim().slice(0, 160);
        return {
          ok: false,
          detail: `POST ${path} with ${model} returned ${ping.status}${
            reason ? ` (${reason})` : ""
          }`,
        };
      } catch (e) {
        return { ok: false, detail: errMessage(e) };
      }
    },
  };
}

/** Copilot bills per REQUEST, so the caps cost nothing extra; they differ because the wires do:
 *  /v1/messages accepts max_tokens 1, while /responses rejects max_output_tokens below 16
 *  ("Expected a value >= 16", verified live 2026-09-15). */
function pingBody(wire: DirectWire, model: string): Record<string, unknown> {
  return wire === "messages"
    ? { "model": model, "max_tokens": 1, "messages": [{ "role": "user", "content": "x" }] }
    : { "model": model, "input": "x", "stream": false, "max_output_tokens": 16 };
}
