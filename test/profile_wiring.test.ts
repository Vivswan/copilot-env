import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import {
  DEFAULT_COPILOT_API_BASE,
  setIntegrationProbeFetch,
} from "../src/copilot_api/integration_identity.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import { landDirectWiring } from "../src/codex/config.ts";
import { directPairIncomplete, resolveDirectWiring } from "../src/agents/profile_wiring.ts";
import { afterEach, expect, removeDir, test } from "./helpers/testing.ts";
import { envSnapshot, isolateProxyHome } from "./helpers/env.ts";

const WORK = parseProfileName("work");
const PIN = "copilot-developer-cli";

const restoreEnv = envSnapshot();
let dir = "";

afterEach(() => {
  setIntegrationProbeFetch(null);
  restoreEnv();
  dir = removeDir(dir);
});

test("a pinned half is never a gap: the landing probes the other half once, and every re-render after it makes zero requests", async () => {
  dir = isolateProxyHome("copilot-profile-wiring-");
  new CopilotEnvConfig().setProfile(WORK, { identity: PIN });
  // Fresh slot under a pin: the identity half is covered, the host half is not, so this IS a landing.
  expect(directPairIncomplete(WORK)).toBe(true);
  let probes = 0;
  setIntegrationProbeFetch(() => {
    probes++;
    return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
  });
  const landed = await landDirectWiring(WORK, "ghp_work");
  expect(probes).toBeGreaterThan(0);
  expect(landed.directIntegrationId).toBe(PIN);
  // Only the probed half is stored; the pin stays an overlay.
  expect(new CopilotEnvState().readProfileDirectPair(WORK)).toEqual({
    host: DEFAULT_COPILOT_API_BASE,
  });

  // The re-render: stored host + pinned identity is a complete pair, so nothing is probed even
  // with the network gone.
  let offlineCalls = 0;
  setIntegrationProbeFetch(() => {
    offlineCalls++;
    return Promise.reject(new Error("offline"));
  });
  expect(directPairIncomplete(WORK)).toBe(false);
  const rendered = await resolveDirectWiring(WORK, "ghp_work");
  expect(rendered).toEqual(landed);
  expect(offlineCalls).toBe(0);
});
