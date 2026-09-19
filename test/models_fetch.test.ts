// Every GET /models in the copilot_api layer goes through fetchModelCatalog: this pins what each
// consumer still decides for itself (its identity header pair) and what it no longer can (the
// URL, the bearer, the count). The verdict arms per consumer stay pinned in their own suites
// (endpoint_smoke, discovery, integration_identity).
import { fetchRawModels } from "../src/copilot_api/catalog.ts";
import { discoverServableClaudeModels } from "../src/copilot_api/discovery.ts";
import { directSmoke } from "../src/copilot_api/endpoint_smoke.ts";
import {
  CODEX_EXEC_USER_AGENT,
  COPILOT_CLI_INTEGRATION_ID,
  COPILOT_SANDBOX_INTEGRATION_ID,
  DEFAULT_COPILOT_API_BASE,
  directClientHeaders,
  directIdentity,
  type ProbeFetch,
  probeIntegrationIdentity,
  selectDirectIdentityAndHost,
  surveyIntegrationIdentities,
  VSCODE_CHAT_INTEGRATION_ID,
} from "../src/copilot_api/integration_identity.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { parseModelList } from "../src/copilot_api/models.ts";
import { afterEach, expect, removeDir, test } from "./helpers/testing.ts";
import { envSnapshot, isolateProxyHome } from "./helpers/env.ts";

const restoreEnv = envSnapshot();
let dir = "";

afterEach(() => {
  restoreEnv();
  dir = removeDir(dir);
});

/** A duplicate id and an id-less entry: three raw entries, one model. */
const SEAM_BODY = { data: [{ id: "a" }, { id: "a" }, {}] };

interface SeenRequest {
  url: string;
  /** Lowercased keys, as the server reads them. */
  headers: Record<string, string>;
}

/** Answers every /models with SEAM_BODY and the account lookup with no designated host. */
function recordingFetch(seen: SeenRequest[]): ProbeFetch {
  return (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/copilot_internal/user")) {
      return Promise.resolve(new Response("{}", { status: 200 }));
    }
    seen.push({ url, headers: Object.fromEntries(new Headers(init?.headers)) });
    return Promise.resolve(Response.json(SEAM_BODY));
  };
}

test("the survey's model count is the listing's parse: one owner, one number", async () => {
  const survey = await surveyIntegrationIdentities(
    "ghp_x",
    [directIdentity("codex_exec/1", COPILOT_CLI_INTEGRATION_ID)],
    { fetchImpl: recordingFetch([]) },
  );
  const listed = parseModelList(SEAM_BODY).length;
  expect(listed).toBe(1);
  expect(survey.hosts[0]?.verdicts[0]?.verdict).toEqual({ kind: "accepted", models: listed });
});

test("every consumer's GET /models carries its own identity pair and the bearer, on one URL", async () => {
  dir = isolateProxyHome("copilot-models-fetch-");
  const ua = "codex_exec/1";
  const seen: SeenRequest[] = [];
  const fetchImpl = recordingFetch(seen);
  const pair = (headers: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  /** The identity pair of EVERY /models request `run` made, each carrying the full bearer. */
  const pairsDuring = async (
    token: string,
    run: () => Promise<unknown>,
  ): Promise<Record<string, string>[]> => {
    const start = seen.length;
    await run();
    return seen.slice(start).map(({ headers: { authorization, ...identity } }) => {
      expect(authorization).toBe(`Bearer ${token}`);
      return identity;
    });
  };
  // The raw catalog fetch with no consumer named: the one header set under the version-free codex
  // UA, probed (the codex identity accepted first, on the `host` literal so the host rule has
  // nothing to ask) and then fetched with.
  new CopilotEnvConfig().setProfile(null, { host: DEFAULT_COPILOT_API_BASE });
  const passthroughUA = directClientHeaders(CODEX_EXEC_USER_AGENT, null);
  expect(
    await pairsDuring("gho_x", () => fetchRawModels("direct", { directToken: "gho_x", fetchImpl })),
  ).toEqual([pair(passthroughUA), pair(passthroughUA)]);
  new CopilotEnvConfig().delProfile(null, "host");
  // Discovery: the agents' exact Direct bytes for the wiring's own identity (the default sends no
  // id header), then the same bytes under each sibling identity it consults.
  expect(
    await pairsDuring(
      "gho_x",
      () =>
        discoverServableClaudeModels("gho_x", ua, null, DEFAULT_COPILOT_API_BASE, { fetchImpl }),
    ),
  ).toEqual(
    [null, VSCODE_CHAT_INTEGRATION_ID, COPILOT_CLI_INTEGRATION_ID, COPILOT_SANDBOX_INTEGRATION_ID]
      .map((id) => pair(directClientHeaders(ua, id))),
  );
  // The endpoint smoke: the Direct bytes under the baked id.
  expect(
    await pairsDuring("gho_x", () =>
      directSmoke(
        { wire: "messages", pickModel: () => "a" },
        "gho_x",
        ua,
        COPILOT_CLI_INTEGRATION_ID,
        DEFAULT_COPILOT_API_BASE,
        { fetchImpl },
      ).pickModel()),
  ).toEqual([pair(directClientHeaders(ua, COPILOT_CLI_INTEGRATION_ID))]);
  // The identity probe sends the candidate as built; the host probe the headers it is handed.
  expect(
    await pairsDuring(
      "ghp_x",
      () =>
        probeIntegrationIdentity("ghp_x", [directIdentity(ua, COPILOT_CLI_INTEGRATION_ID)], {
          fetchImpl,
          apiBase: DEFAULT_COPILOT_API_BASE,
        }),
    ),
  ).toEqual([pair(directClientHeaders(ua, COPILOT_CLI_INTEGRATION_ID))]);
  expect(
    await pairsDuring(
      "ghp_x",
      // Pinned: the identity step sends nothing, so the one round is the host rule's.
      () =>
        selectDirectIdentityAndHost("ghp_x", ua, {
          pinned: COPILOT_CLI_INTEGRATION_ID,
          fetchImpl,
          narrator: { info: () => {} },
        }),
    ),
  ).toEqual([pair(directClientHeaders(ua, COPILOT_CLI_INTEGRATION_ID))]);
  expect(seen.every((s) => s.url === `${DEFAULT_COPILOT_API_BASE}/models`)).toBe(true);
});

test("fetchRawModels(direct) reads the slot's stored pair: no probe, the GET on the stored host under the stored id", async () => {
  dir = isolateProxyHome("copilot-models-fetch-stored-");
  // The slot holds the sandbox id on the account's host; a fresh selection would land on the codex
  // identity on the generic host (accepted there too), an identity the agents and the daemon never
  // send for this profile.
  const enterprise = "https://api.enterprise.githubcopilot.com";
  new CopilotEnvState().setProfileDirectPair(null, {
    integrationId: COPILOT_SANDBOX_INTEGRATION_ID,
    host: enterprise,
  });
  const seen: SeenRequest[] = [];
  await fetchRawModels("direct", { directToken: "ghp_x", fetchImpl: recordingFetch(seen) });
  expect(seen.map((r) => [r.url, r.headers["copilot-integration-id"]])).toEqual([
    [`${enterprise}/models`, COPILOT_SANDBOX_INTEGRATION_ID],
  ]);
  // The `host` literal overlays the stored host the way a Direct re-render bakes it: the stored
  // identity, on the literal, still with no probe.
  const literal = "https://copilot.example";
  new CopilotEnvConfig().setProfile(null, { host: literal });
  seen.length = 0;
  await fetchRawModels("direct", { directToken: "ghp_x", fetchImpl: recordingFetch(seen) });
  expect(seen.map((r) => [r.url, r.headers["copilot-integration-id"]])).toEqual([
    [`${literal}/models`, COPILOT_SANDBOX_INTEGRATION_ID],
  ]);
});
