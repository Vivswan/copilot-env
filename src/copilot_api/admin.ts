// HTTP client for the local copilot-api daemon; alias derivation stays pure in models.ts.

import { isRecord } from "../utils/json.ts";
import { type CatalogModel, parseCatalogModels } from "./models.ts";
import { proxyLoopbackOrigin } from "./port.ts";

const FETCH_TIMEOUT_MS = 5000;

interface RequestOptions {
  /** The daemon's `/admin/*` routes accept only the admin key. */
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

  async getModels(): Promise<CatalogModel[]> {
    return parseCatalogModels(await this.request("/models"));
  }

  /** Untyped for readers of `capabilities.limits`, which parseCatalogModels does not keep. */
  async getRawModels(): Promise<unknown> {
    return this.request("/models");
  }

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

  async setModelMappings(mappings: Record<string, string>): Promise<void> {
    await this.request("/admin/config/model-mappings", {
      admin: true,
      method: "POST",
      body: { modelMappings: mappings },
    });
  }

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
