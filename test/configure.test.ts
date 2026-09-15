// The proxy arm's `directIntegrationId?: never` makes a proxy write with a baked integration id
// unrepresentable; excess-property checking covers object literals only, so the never field is
// what catches a widened object. Drop the field and the widened case's ts-expect-error below
// becomes an unused directive (TS2578): the guard fails closed at typecheck time.

import {
  type AgentAdapter,
  type ManagedWrite,
  resolvedDirectToken,
  runAgentConfig,
} from "../src/agents/configure.ts";
import type { RequestedMode } from "../src/agents/provider_mode.ts";
import { expect, test } from "./helpers/testing.ts";

test("resolvedDirectToken hands on a static GitHub token and never the proxy's API key", () => {
  // A proxy static write bakes the daemon key; sent upstream as a GitHub credential it 401s.
  const token = { kind: "static", token: "value" } as const;
  expect(resolvedDirectToken("direct", token)).toBe("value");
  expect(resolvedDirectToken("proxy", token)).toBeUndefined();
  expect(resolvedDirectToken("direct", { kind: "command" })).toBeUndefined();
});

// Every literal carries the required credential, so the id is the ONE thing each directive rejects.
const COMMAND = { kind: "command" } as const;

test("a proxy ManagedWrite cannot carry a direct integration id", () => {
  // Literal path: the discriminant selects the proxy arm and the id is rejected there.
  // @ts-expect-error -- a proxy write never carries directIntegrationId
  const literal: ManagedWrite = { mode: "proxy", directIntegrationId: "x", credential: COMMAND };
  void literal;

  // Widened path: excess-property checking does not apply to a non-literal assignment, so
  // ONLY the never field rejects this one.
  const widened: { mode: "proxy"; directIntegrationId: string; credential: typeof COMMAND } = {
    mode: "proxy",
    directIntegrationId: "x",
    credential: COMMAND,
  };
  // @ts-expect-error -- string is not assignable to the proxy arm's never field
  const fromWidened: ManagedWrite = widened;
  void fromWidened;

  // Control: the direct arm carries the id fine, so the directives above pin the proxy arm
  // specifically, not a wider breakage of the union.
  const direct: ManagedWrite = { mode: "direct", directIntegrationId: "x", credential: COMMAND };
  expect(direct.mode).toBe("direct");
});

// --- runAgentConfig: the identity is resolved once, BEFORE the probe --------------------------
//
// What drifts silently otherwise: a PAT accepted only under `copilot-developer-cli` used to select
// Direct on the strength of being stored; now the probe decides, so its scratch config must carry
// the same identity the real write bakes, or that PAT fails the smoke call and lands on the proxy.

type Recorded = {
  identityCalls: number;
  probeIds: (string | null)[];
  writes: ManagedWrite[];
};

function fakeAdapter(
  identity: () => Promise<string | null>,
  probeVerdict: boolean,
): { adapter: AgentAdapter; recorded: Recorded } {
  const recorded: Recorded = { identityCalls: 0, probeIds: [], writes: [] };
  const adapter: AgentAdapter = {
    id: "claude",
    label: "Claude",
    check: () => {},
    detectDirect(directIntegrationId) {
      recorded.probeIds.push(directIntegrationId);
      return probeVerdict;
    },
    resolveDirectIdentity() {
      recorded.identityCalls++;
      return identity();
    },
    configureDefault(write) {
      recorded.writes.push(write);
      return Promise.resolve();
    },
    configureProfile: () => {},
    removeProfile: () => {},
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
    expected: { identityCalls: 0, probeIds: [], writes: [{ mode: "proxy", credential: COMMAND }] },
  },
  {
    name: "--direct bakes the identity without probing",
    mode: "direct",
    identity: accepted,
    probe: false,
    expected: {
      identityCalls: 1,
      probeIds: [],
      writes: [{ mode: "direct", directIntegrationId: PAT_ID, credential: COMMAND }],
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
      writes: [{ mode: "direct", directIntegrationId: PAT_ID, credential: COMMAND }],
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
      writes: [{ mode: "proxy", credential: COMMAND }],
    },
  },
  {
    name: "auto treats a credential rejected under every identity as the proxy verdict",
    mode: "auto",
    identity: rejected,
    probe: true,
    expected: { identityCalls: 1, probeIds: [], writes: [{ mode: "proxy", credential: COMMAND }] },
  },
];

test("runAgentConfig resolves the identity once, before the probe, per mode", async () => {
  for (const c of CASES) {
    const { adapter, recorded } = fakeAdapter(c.identity, c.probe);
    await runAgentConfig(adapter, { kind: "configure", mode: c.mode }, { ghToken: "ghp_x" });
    expect({ name: c.name, ...recorded }).toEqual({ name: c.name, ...c.expected });
  }
});

test("--direct surfaces an identity rejection instead of silently writing proxy", async () => {
  const { adapter, recorded } = fakeAdapter(rejected, true);
  await expect(
    runAgentConfig(adapter, { kind: "configure", mode: "direct" }, { ghToken: "ghp_x" }),
  ).rejects.toThrow("rejected under every known client identity");
  expect(recorded.writes).toEqual([]);
});
