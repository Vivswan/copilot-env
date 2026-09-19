// THE owner of the GET <host>/models request. Every consumer (the raw catalog fetch, model
// discovery, the endpoint smoke, the identity probe and survey, the host probe) goes through it,
// so the URL, the bearer, the timeout, the body drain, and the parse are decided once. The
// identity headers ride in from THE header builder (directClientHeaders): this module never
// chooses a client identity, so each consumer's bytes stay its own.
import { defaultFetch } from "../utils/fetch.ts";
import type { ProbeFetch } from "./integration_identity.ts";
import { type ModelListEntry, parseModelList } from "./models.ts";

const MODELS_TIMEOUT_MS = 5000;

interface FetchModelCatalogOptions {
  /** The Copilot API host origin; the request goes to `<host>/models`. */
  host: string;
  token: string;
  /** The client identity's headers; Authorization is added here. */
  headers: Record<string, string>;
  fetchImpl?: ProbeFetch;
  timeoutMs?: number;
  /** A caller deadline, combined with the request's own timeout. */
  signal?: AbortSignal;
}

/** Never throws; the four arms are what a consumer can tell apart on the wire. */
export type ModelCatalogOutcome =
  /** A 2xx with a JSON body. `models` is parseModelList's view (`agent profile models`, the survey
   *  count), null when the body is not the catalog envelope; `body` is the raw JSON for the
   *  parsers that keep more than that view. */
  | { kind: "ok"; status: number; body: unknown; models: ModelListEntry[] | null }
  /** A 2xx whose body could not be read or is not JSON: served by status, unusable as a catalog. */
  | { kind: "unparsable"; status: number; error: unknown }
  /** A non-2xx; `body` is the drained text, so a keep-alive socket stays reusable. */
  | { kind: "http"; status: number; statusText: string; body: string }
  /** The request itself failed: network, abort, or the timeout. */
  | { kind: "network"; error: unknown };

export async function fetchModelCatalog(
  opts: FetchModelCatalogOptions,
): Promise<ModelCatalogOutcome> {
  const fetchImpl: ProbeFetch = opts.fetchImpl ?? defaultFetch;
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? MODELS_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(`${opts.host}/models`, {
      headers: { Authorization: `Bearer ${opts.token}`, ...opts.headers },
      signal: opts.signal === undefined ? timeout : AbortSignal.any([opts.signal, timeout]),
    });
  } catch (error) {
    return { kind: "network", error };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { kind: "http", status: res.status, statusText: res.statusText, body };
  }
  let body: unknown;
  try {
    body = JSON.parse(await res.text());
  } catch (error) {
    return { kind: "unparsable", status: res.status, error };
  }
  return { kind: "ok", status: res.status, body, models: catalogView(body) };
}

function catalogView(body: unknown): ModelListEntry[] | null {
  try {
    return parseModelList(body);
  } catch {
    return null;
  }
}
