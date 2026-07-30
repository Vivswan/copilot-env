// REST client for the local copilot-api daemon.
//
// The daemon proxies GitHub Copilot's live model catalog at `GET /models` and
// exposes live model-alias updates at `GET`/`POST /admin/config/model-mappings`
// (the latter gated by the admin key). This class owns all of that HTTP; the
// alias-derivation logic stays pure in `models.ts`.

import { isRecord } from "../utils/json.ts";
import { type CatalogModel, parseCatalogModels } from "./models.ts";
import { proxyLoopbackOrigin } from "./port.ts";

const FETCH_TIMEOUT_MS = 5000;

interface RequestOptions {
  /** Use the admin key instead of the regular api key (for `/admin/*`). */
  admin?: boolean;
  method?: "GET" | "POST";
  body?: unknown;
}

export class CopilotAdminClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly adminKey: string;

  constructor(opts: { port: number; apiKey: string; adminKey: string }) {
    this.baseUrl = proxyLoopbackOrigin(opts.port);
    this.apiKey = opts.apiKey;
    this.adminKey = opts.adminKey;
  }

  /** Fetch the live catalog, normalizing the display-only `[1m]` suffix. */
  async getModels(): Promise<CatalogModel[]> {
    return parseCatalogModels(await this.request("/models"));
  }

  /** The raw `/models` body (untyped), for callers that need `capabilities.limits`. */
  async getRawModels(): Promise<unknown> {
    return this.request("/models");
  }

  /** Read the daemon's current live model mappings (requires the admin key). */
  async getModelMappings(): Promise<Record<string, string>> {
    const body = await this.request("/admin/config/model-mappings", { admin: true });
    const mappings = isRecord(body) ? body.modelMappings : undefined;
    if (!isRecord(mappings)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [source, target] of Object.entries(mappings)) {
      if (typeof target === "string") {
        out[source] = target;
      }
    }
    return out;
  }

  /** Replace the daemon's live model mappings (requires the admin key). */
  async setModelMappings(mappings: Record<string, string>): Promise<void> {
    await this.request("/admin/config/model-mappings", {
      admin: true,
      method: "POST",
      body: { modelMappings: mappings },
    });
  }

  /** Shared `fetch` wrapper: bearer selection, timeout, non-2xx -> throw, JSON parse. */
  private async request(path: string, opts: RequestOptions = {}): Promise<unknown> {
    const method = opts.method ?? "GET";
    const headers: Record<string, string> = {
      Authorization: `Bearer ${opts.admin ? this.adminKey : this.apiKey}`,
    };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `${method} ${path} returned ${res.status} ${res.statusText} ${detail}`.trim(),
      );
    }
    return res.json();
  }
}
