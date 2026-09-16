// Every GET /models in the copilot_api layer goes through fetchModelCatalog: this pins what each
// consumer still decides for itself (its identity header pair) and what it no longer can (the
// URL, the bearer, the count). The verdict arms per consumer stay pinned in their own suites
// (endpoint_smoke, discovery, integration_identity).
import { fetchRawModels } from "../src/copilot_api/catalog.ts";
import { discoverServableClaudeModels } from "../src/copilot_api/discovery.ts";
import { directSmoke } from "../src/copilot_api/endpoint_smoke.ts";
import {
  COPILOT_CLI_INTEGRATION_ID,
  COPILOT_SANDBOX_INTEGRATION_ID,
  DEFAULT_COPILOT_API_BASE,
  directClientHeaders,
  passthroughIdentity,
  type ProbeFetch,
  probeIntegrationIdentity,
  selectDirectIdentityAndHost,
  surveyIntegrationIdentities,
  VSCODE_CHAT_INTEGRATION_ID,
} from "../src/copilot_api/integration_identity.ts";
import { parseModelList } from "../src/copilot_api/models.ts";
import { afterEach, expect, removeDir, test } from "./helpers/testing.ts";
import { envSnapshot, isolateProxyHome } from "./helpers.ts";

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
    [passthroughIdentity(VSCODE_CHAT_INTEGRATION_ID)],
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
  // The raw catalog fetch: the daemon's bytes, the id header alone (a non-PAT lands on
  // vscode-chat unprobed).
  expect(
    await pairsDuring("gho_x", () =>
      fetchRawModels("direct", {
        directToken: "gho_x",
        apiBase: DEFAULT_COPILOT_API_BASE,
        fetchImpl,
      })),
  ).toEqual([pair(passthroughIdentity(VSCODE_CHAT_INTEGRATION_ID).headers)]);
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
        probeIntegrationIdentity("ghp_x", [passthroughIdentity(COPILOT_CLI_INTEGRATION_ID)], {
          fetchImpl,
          apiBase: DEFAULT_COPILOT_API_BASE,
        }),
    ),
  ).toEqual([pair(passthroughIdentity(COPILOT_CLI_INTEGRATION_ID).headers)]);
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
