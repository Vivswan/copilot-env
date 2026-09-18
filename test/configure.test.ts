// `direct` is the one Direct half of a write: the branded DirectWiring (directWiring() is its only
// constructor) or null. A hand-built pair cannot carry the brand, and the proxy arm's
// `direct?: never` keeps a pair off a proxy write; excess-property checking covers object literals
// only, so the never field is what catches a widened object. Drop either guard and its
// ts-expect-error below becomes an unused directive (TS2578): both fail closed at typecheck time.

import {
  type AgentAdapter,
  type DirectWiring,
  directWiring,
  type ManagedAgentId,
  type ManagedWrite,
  resolveDefaultMode,
  writeDefaultAgent,
} from "../src/agents/configure.ts";
import { runAgentConfig } from "../src/agents/configure_defaults.ts";
import { NO_WRITE } from "../src/utils/write_session.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import type { RequestedMode } from "../src/agents/provider_mode.ts";
import { expect, test } from "./helpers/testing.ts";

// Every literal carries the required credential, so the pair is the ONE thing each directive rejects.
const COMMAND = { kind: "command" } as const;
const HOST = "https://api.githubcopilot.com";

test("a ManagedWrite carries a Direct pair only as the branded DirectWiring, never on the proxy arm", () => {
  // Literal path: the discriminant selects the proxy arm and the pair is rejected there.
  // @ts-expect-error -- a proxy write never carries a Direct pair
  const literal: ManagedWrite = {
    mode: "proxy",
    direct: directWiring("x", HOST),
    credential: COMMAND,
  };
  void literal;

  // Widened path: excess-property checking does not apply to a non-literal assignment, so
  // ONLY the never field rejects this one.
  const widened: { mode: "proxy"; direct: DirectWiring; credential: typeof COMMAND } = {
    mode: "proxy",
    direct: directWiring("x", HOST),
    credential: COMMAND,
  };
  // @ts-expect-error -- DirectWiring is not assignable to the proxy arm's never field
  const fromWidened: ManagedWrite = widened;
  void fromWidened;

  // A hand-built pair lacks the brand, so no writer can bake one of its own making.
  const unbranded: ManagedWrite = {
    mode: "direct",
    // @ts-expect-error -- the DirectWiring brand is missing
    direct: { directIntegrationId: "x", directBaseUrl: HOST },
    credential: COMMAND,
  };
  void unbranded;

  // Controls: the direct arm carries the branded pair, or null for today's bytes, so the
  // directives above pin the guards specifically, not a wider breakage of the union.
  const direct: ManagedWrite = {
    mode: "direct",
    direct: directWiring("x", HOST),
    credential: COMMAND,
  };
  const scratch: ManagedWrite = { mode: "direct", direct: null, credential: COMMAND };
  expect([direct.mode, scratch.direct]).toEqual(["direct", null]);
});

// --- the landing: the identity is resolved once, BEFORE the probe -----------------------------
//
// What drifts silently otherwise: a PAT accepted only under `copilot-developer-cli` used to select
// Direct on the strength of being stored; now the probe decides, so its scratch config must carry
// the same identity the real write bakes, or that PAT fails the smoke call and lands on the proxy.

type Recorded = {
  identityCalls: number;
  probeIds: (string | null)[];
  /** The credential detectDirect received: the CLI-less endpoint smoke dies silently without it. */
  probeTokens: (string | null)[];
  writes: ManagedWrite[];
};

function fakeAdapter(
  identity: () => Promise<string | null>,
  probeVerdict: boolean,
  id: ManagedAgentId = "claude",
): { adapter: AgentAdapter; recorded: Recorded } {
  const recorded: Recorded = { identityCalls: 0, probeIds: [], probeTokens: [], writes: [] };
  const adapter: AgentAdapter = {
    id,
    label: id === "claude" ? "Claude" : "Codex",
    check: () => {},
    detectDirect(direct, ghToken) {
      recorded.probeIds.push(direct.directIntegrationId);
      recorded.probeTokens.push(ghToken);
      return Promise.resolve(probeVerdict);
    },
    resolveDirectWiring() {
      recorded.identityCalls++;
      return identity().then((id) => directWiring(id, HOST));
    },
    configureDefault(write) {
      recorded.writes.push(write);
      return Promise.resolve();
    },
    configureProfile: () => {},
    planRemoveProfile: () => NO_WRITE,
  };
  return { adapter, recorded };
}

const PAT_ID = "copilot-developer-cli";
const accepted = () => Promise.resolve(PAT_ID);
const rejected = () => Promise.reject(new Error("rejected under every known client identity"));

const CASES: {
  name: string;
  mode: RequestedMode;
  identity: () => Promise<string | null>;
  probe: boolean;
  expected: Recorded;
}[] = [
  {
    name: "--proxy never resolves an identity nor probes",
    mode: "proxy",
    identity: accepted,
    probe: true,
    expected: {
      identityCalls: 0,
      probeIds: [],
      probeTokens: [],
      writes: [{ mode: "proxy", credential: COMMAND }],
    },
  },
  {
    name: "--direct bakes the identity without probing",
    mode: "direct",
    identity: accepted,
    probe: false,
    expected: {
      identityCalls: 1,
      probeIds: [],
      probeTokens: [],
      writes: [
        { mode: "direct", direct: directWiring(PAT_ID, HOST), credential: COMMAND },
      ],
    },
  },
  {
    name: "auto hands the resolved identity to the probe and bakes it on success",
    mode: "auto",
    identity: accepted,
    probe: true,
    expected: {
      identityCalls: 1,
      probeIds: [PAT_ID],
      probeTokens: ["ghp_x"],
      writes: [
        { mode: "direct", direct: directWiring(PAT_ID, HOST), credential: COMMAND },
      ],
    },
  },
  {
    name: "auto with a stored credential still lands on the proxy when the probe fails",
    mode: "auto",
    identity: accepted,
    probe: false,
    expected: {
      identityCalls: 1,
      probeIds: [PAT_ID],
      probeTokens: ["ghp_x"],
      writes: [{ mode: "proxy", credential: COMMAND }],
    },
  },
  {
    name: "auto treats a credential rejected under every identity as the proxy verdict",
    mode: "auto",
    identity: rejected,
    probe: true,
    expected: {
      identityCalls: 1,
      probeIds: [],
      probeTokens: [],
      writes: [{ mode: "proxy", credential: COMMAND }],
    },
  },
];

test("a landing resolves the identity once, before the probe, per mode", async () => {
  for (const c of CASES) {
    const { adapter, recorded } = fakeAdapter(c.identity, c.probe);
    const chosen = await resolveDefaultMode(adapter, c.mode, "ghp_x");
    await writeDefaultAgent(adapter, chosen, "ghp_x");
    expect({ name: c.name, ...recorded }).toEqual({ name: c.name, ...c.expected });
  }
});

test("--direct surfaces an identity rejection instead of silently writing proxy", async () => {
  const { adapter, recorded } = fakeAdapter(rejected, true);
  await expect(resolveDefaultMode(adapter, "direct", "ghp_x")).rejects.toThrow(
    "rejected under every known client identity",
  );
  expect(recorded.writes).toEqual([]);
});

// --- runAgentConfig: one agent's re-render of the recorded default --------------------------------

test("a single-agent write re-renders the recorded mode, never moves it, and refuses a flag naming another mode before any write", async () => {
  const state = new CopilotEnvState();
  state.recordDefaultMode("proxy");
  const { adapter, recorded } = fakeAdapter(() => Promise.resolve(null), true);
  await expect(
    runAgentConfig(adapter, { kind: "configure", mode: "direct" }, { ghToken: "ghp_x" }),
  ).rejects.toThrow(
    "the default profile records proxy as the one mode for both agents; a direct write of claude alone would leave the two " +
      "apart. Move both with `agent init --direct`.",
  );
  expect(recorded.writes).toEqual([]);
  expect(state.readProfileSlot(null).mode).toBe("proxy");
  // No flag renders the recorded mode without a probe (this adapter would pick Direct as a
  // landing: probe true), and a flag naming the recorded mode is the same plain re-render.
  await runAgentConfig(adapter, { kind: "configure", mode: "auto" }, { ghToken: "ghp_x" });
  await runAgentConfig(adapter, { kind: "configure", mode: "proxy" }, { ghToken: "ghp_x" });
  expect(recorded).toEqual({
    identityCalls: 0,
    probeIds: [],
    probeTokens: [],
    writes: [{ mode: "proxy", credential: COMMAND }, { mode: "proxy", credential: COMMAND }],
  });
  expect(state.readProfileSlot(null).mode).toBe("proxy");
});

// The defect this pins: a flag-less `agent profile sync --claude` on a recorded Direct default used to run the
// adapter's LANDING probe and overwrite the slot's pair with a fresh selection, so a PAT accepted
// only under `copilot-developer-cli` was rebaked as `codex` whenever /models happened to fail.
test("a Direct re-render bakes the slot's stored pair into the file: zero probes, slot unchanged", async () => {
  const state = new CopilotEnvState();
  state.recordDefaultMode("direct");
  const stored = { integrationId: PAT_ID, host: "https://api.enterprise.githubcopilot.com" };
  state.setProfileDirectPair(null, stored);
  // The probe stub answers the fallback identity: a re-render that probed would bake it.
  const { adapter, recorded } = fakeAdapter(() => Promise.resolve(null), true);
  await runAgentConfig(adapter, { kind: "configure", mode: "auto" }, { ghToken: "ghp_x" });
  expect(recorded).toEqual({
    identityCalls: 0,
    probeIds: [],
    probeTokens: [],
    writes: [{
      mode: "direct",
      direct: directWiring(stored.integrationId, stored.host),
      credential: COMMAND,
    }],
  });
  expect(state.readProfileDirectPair(null)).toEqual(stored);
});

// Profiles are atomic units, the default included: the FIRST landing wires both agents whatever
// command spelled it, and the record is committed once both writes succeeded.
test("a single-agent flag on a null record lands BOTH agents like `agent init --<mode>`; the next re-render renders the stored pair", async () => {
  const state = new CopilotEnvState();
  state.recordDefaultMode(null);
  const claude = fakeAdapter(accepted, true, "claude");
  const codex = fakeAdapter(accepted, true, "codex");
  const landed = await runAgentConfig(
    codex.adapter,
    { kind: "configure", mode: "direct" },
    { ghToken: "ghp_x" },
    [claude.adapter, codex.adapter],
  );
  const directWrite = { mode: "direct", direct: directWiring(PAT_ID, HOST), credential: COMMAND };
  expect({
    landed,
    claude: claude.recorded,
    codex: codex.recorded,
    recorded: state.readProfileSlot(null).mode,
    pair: state.readProfileDirectPair(null),
  }).toEqual({
    landed: "direct",
    claude: { identityCalls: 1, probeIds: [], probeTokens: [], writes: [directWrite] },
    codex: { identityCalls: 1, probeIds: [], probeTokens: [], writes: [directWrite] },
    recorded: "direct",
    pair: { integrationId: PAT_ID, host: HOST },
  });
  // What `cl` and `agent profile sync --claude` then render: the slot's pair, no landing probe.
  const rerender = fakeAdapter(() => Promise.resolve(null), true, "claude");
  await runAgentConfig(rerender.adapter, { kind: "configure", mode: "auto" }, { ghToken: "ghp_x" });
  expect(rerender.recorded).toEqual({
    identityCalls: 0,
    probeIds: [],
    probeTokens: [],
    writes: [directWrite],
  });
});

// The pair is committed with both agents' files (commitDefaultWiring), never by one agent's
// re-render: a Direct record whose slot holds no pair (a credential landed since) lands both.
test("a Direct re-render on a slot holding no pair lands BOTH agents and commits the pair with them", async () => {
  const state = new CopilotEnvState();
  state.recordDefaultMode("direct");
  state.setCredential(null, { kind: "stored", provider: "gh-token", token: "ghp_new" }); // pair gone
  const claude = fakeAdapter(accepted, true, "claude");
  const codex = fakeAdapter(accepted, true, "codex");
  await runAgentConfig(
    claude.adapter,
    { kind: "configure", mode: "auto" },
    { ghToken: "ghp_new" },
    [claude.adapter, codex.adapter],
  );
  const directWrite = { mode: "direct", direct: directWiring(PAT_ID, HOST), credential: COMMAND };
  expect({
    claude: claude.recorded.writes,
    codex: codex.recorded.writes,
    pair: state.readProfileDirectPair(null),
    recorded: state.readProfileSlot(null).mode,
  }).toEqual({
    claude: [directWrite],
    codex: [directWrite],
    pair: { integrationId: PAT_ID, host: HOST },
    recorded: "direct",
  });
});
