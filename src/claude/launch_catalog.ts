// The catalog the launch judges the session's model against, under the launch's budget and SILENT:
// no identity probe (the session's own baked headers ride instead) and no narration, so a failed
// look costs nothing but the budget and prints nothing. fetchRawModels (catalog.ts) is not used
// here: its Direct path probes the identity, up to three 5 s rounds for a PAT, and narrates.
import { execFile } from "node:child_process";
import { delimiter, join } from "node:path";
import { DIRECT_MODELS_URL } from "../copilot_api/catalog.ts";
import { CopilotApiConfig } from "../copilot_api/config.ts";
import { Credential, ghTokenLookFromSpawn } from "../copilot_api/credential.ts";
import { ghAuthTokenSpawnSpec } from "../copilot_api/gh_cli.ts";
import { type CatalogModel, parseCatalogModels } from "../copilot_api/models.ts";
import { proxyLoopbackOrigin } from "../copilot_api/port.ts";
import type { Profile } from "../copilot_api/profile.ts";
import { isFile } from "../utils/fs.ts";
import { isRecord } from "../utils/json.ts";
import type { SessionCredential } from "./model_check.ts";
import { WIN } from "./paths.ts";

/** `credential` is the session's own (model_check.ts sessionCredential), never re-derived here. */
export type CatalogTarget =
  /** `port` is the one the session's own base URL names, which may not be the profile's daemon. */
  | { mode: "proxy"; credential: SessionCredential; port: string }
  /** `headers` are the session's own ANTHROPIC_CUSTOM_HEADERS (integration id included). */
  | { mode: "direct"; credential: SessionCredential; headers: Record<string, string> };

export interface CatalogRequest {
  url: string;
  headers: Record<string, string>;
}

export type CatalogFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Null = nothing to ask with (the check is skipped). A store credential is the proxy's api key or
 *  the Direct token; the gh-cli look runs asynchronously under `signal`, since the sync look's own
 *  5 s timeout would outlive the budget. */
export async function launchCatalogRequest(
  target: CatalogTarget,
  signal: AbortSignal,
): Promise<CatalogRequest | null> {
  const token = target.credential.kind === "token"
    ? target.credential.token
    : target.mode === "proxy"
    ? CopilotApiConfig.forProfile(target.credential.profile).apiKey()
    : await launchToken(target.credential.profile, signal);
  if (token === null) return null;
  if (target.mode === "proxy") {
    return {
      url: `${proxyLoopbackOrigin(target.port)}/models`,
      headers: { Authorization: `Bearer ${token}` },
    };
  }
  return {
    url: DIRECT_MODELS_URL,
    headers: { ...target.headers, Authorization: `Bearer ${token}` },
  };
}

async function launchToken(profile: Profile, signal: AbortSignal): Promise<string | null> {
  const credential = new Credential(undefined, profile).read();
  if (credential.kind === "stored") return credential.token;
  if (credential.kind === "none") return null;
  const gh = ghOnPath();
  if (gh === null) return null;
  const spec = ghAuthTokenSpawnSpec(gh, credential.ghUser);
  return new Promise((resolve) => {
    // nosemgrep: javascript.lang.security.audit.spawn-shell-true.spawn-shell-true -- Windows-only, for .cmd shims; the spec quotes args
    execFile(
      spec.file,
      spec.args,
      { env: spec.env, shell: spec.shell, windowsHide: true, signal, encoding: "utf8" },
      (error, stdout, stderr) => {
        const status = error === null ? 0 : typeof error.code === "number" ? error.code : null;
        resolve(ghTokenLookFromSpawn({ status, error: error ?? undefined, stdout, stderr }).token);
      },
    );
  });
}

/** A PATH scan with no spawn: findCommand's `sh -c 'command -v'` has no timeout and sources nvm on
 *  a miss, so it can outlive the budget. A gh only that fallback finds skips the check. */
function ghOnPath(): string | null {
  const names = WIN ? ["gh.exe", "gh.cmd", "gh.bat"] : ["gh"];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/** Null on anything but a catalog body: a rejected or aborted fetch, a non-2xx, or a body with no
 *  `data` array (parseCatalogModels would read that as an EMPTY catalog, which the check would
 *  report as "no Claude model"; an unrecognized shape is unknown, not proven empty). */
export async function fetchLaunchCatalog(
  request: CatalogRequest,
  signal: AbortSignal,
  fetchImpl: CatalogFetch = (url, init) => globalThis.fetch(url, init),
): Promise<CatalogModel[] | null> {
  try {
    const res = await fetchImpl(request.url, { headers: request.headers, signal });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (!isRecord(body) || !Array.isArray(body.data)) return null;
    return parseCatalogModels(body);
  } catch {
    return null;
  }
}
