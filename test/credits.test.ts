// `agent credits`: the response fold, the month's pace
// against a target, and the rendered block, all against fixed clocks so the
// numbers are exact.
import {
  type CopilotCredits,
  CREDITS_TARGET_ENV,
  creditsJson,
  creditsPace,
  fetchCopilotCredits,
  parseCopilotCredits,
  renderCredits,
  resolveCreditsTarget,
} from "../src/usage/credits.ts";
import { runCredits } from "../src/commands/credits.ts";
import { runCli } from "./helpers/run.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { captureChannels } from "./helpers/output.ts";
import { describe, expect, tempDir, test } from "./helpers/testing.ts";

const BODY = {
  "login": "Vivswan",
  "quota_reset_date": "2026-10-01",
  "quota_snapshots": {
    "premium_interactions": { "entitlement": 10_000_000, "credits_used": 2_374_638 },
  },
};
const CREDITS: CopilotCredits = {
  login: "Vivswan",
  entitlement: 10_000_000,
  used: 2_374_638,
  resetDate: "2026-10-01",
};
const NOON_SEP_11 = Date.UTC(2026, 8, 11, 12);

describe("parseCopilotCredits", () => {
  test("reads the metered quota, the used count, the reset date, and the login", () => {
    expect(parseCopilotCredits(BODY)).toEqual(CREDITS);
    expect(parseCopilotCredits({ ...BODY, "login": undefined }).login).toBeNull();
  });

  test("names the missing or malformed field: the endpoint is undocumented", () => {
    const cases: [unknown, string][] = [
      [null, "not a JSON object"],
      [{ ...BODY, "quota_snapshots": {} }, "no metered premium_interactions quota"],
      [
        {
          ...BODY,
          "quota_snapshots": { "premium_interactions": { "entitlement": 0, "credits_used": 1 } },
        },
        "no metered",
      ],
      [
        {
          ...BODY,
          "quota_snapshots": { "premium_interactions": { "entitlement": 5, "credits_used": -1 } },
        },
        "credits_used",
      ],
      [
        {
          ...BODY,
          "quota_snapshots": {
            "premium_interactions": { "entitlement": 5, "credits_used": 1e400 },
          },
        },
        "credits_used",
      ],
      [{ ...BODY, "quota_reset_date": "2026-02-30" }, "quota_reset_date"],
      [{ ...BODY, "quota_reset_date": "next month" }, "quota_reset_date"],
    ];
    for (const [body, needle] of cases) {
      expect(() => parseCopilotCredits(body), JSON.stringify(body)).toThrow(needle);
    }
  });
});

describe("fetchCopilotCredits", () => {
  test("sends the token as a `token` authorization and rejects a non-2xx with its status", async () => {
    let seen: RequestInit | undefined;
    const ok = await fetchCopilotCredits("tok", (_url, init) => {
      seen = init;
      return Promise.resolve(new Response(JSON.stringify(BODY), { status: 200 }));
    });
    expect(ok).toEqual(CREDITS);
    expect((seen?.headers as Record<string, string>).Authorization).toBe("token tok");
    await expect(
      fetchCopilotCredits("tok", () => Promise.resolve(new Response("", { status: 401 }))),
    ).rejects.toThrow("returned 401");
  });
});

describe("creditsPace", () => {
  test("measures the calendar month before the reset and projects the spend at today's rate", () => {
    const pace = creditsPace(CREDITS, 8_000_000, NOON_SEP_11);
    expect(pace.periodStartMs).toBe(Date.UTC(2026, 8, 1));
    expect(pace.resetMs).toBe(Date.UTC(2026, 9, 1));
    expect(pace.day).toBe(11);
    expect(pace.daysTotal).toBe(30);
    expect(pace.elapsed).toBeCloseTo(10.5 / 30, 10);
    expect(pace.targetMark).toBe(2_800_000);
    expect(pace.totalMark).toBe(3_500_000);
    expect(pace.projected).toBe(Math.round(2_374_638 / 10.5 * 30));
  });

  test("a reset on the 31st starts the period on the shorter month's last day", () => {
    const pace = creditsPace({ ...CREDITS, resetDate: "2026-03-31" }, null, Date.UTC(2026, 2, 1));
    expect(pace.periodStartMs).toBe(Date.UTC(2026, 1, 28));
    expect(pace.daysTotal).toBe(31);
  });

  test("no target leaves the target and its mark null; nothing elapsed means no projection", () => {
    const pace = creditsPace(CREDITS, null, Date.UTC(2026, 8, 1));
    expect(pace.target).toBeNull();
    expect(pace.targetMark).toBeNull();
    expect(pace.elapsed).toBe(0);
    expect(pace.day).toBe(1);
    expect(pace.projected).toBeNull();
  });

  test("a fractional spend near the reset never projects below itself", () => {
    const pace = creditsPace(
      { ...CREDITS, entitlement: 10, used: 1.4 },
      null,
      Date.UTC(2026, 8, 30, 12),
    );
    expect(pace.projected).toBe(1.4);
    expect(renderCredits(pace)).toHaveLength(9);
  });

  test("a clock past the reset clamps to the full period", () => {
    const pace = creditsPace(CREDITS, null, Date.UTC(2026, 9, 5));
    expect(pace.elapsed).toBe(1);
    expect(pace.day).toBe(30);
  });
});

describe("renderCredits", () => {
  // Checked cell for cell against ghco's jq on the same numbers; the `$` column is ours,
  // at GitHub's 100 credits to the dollar.
  test("renders ghco's block cell for cell, plus the dollar column", () => {
    expect(renderCredits(creditsPace(CREDITS, 8_000_000, NOON_SEP_11))).toEqual([
      "Copilot credits  Vivswan · Sep 2026 · resets Oct 1 · day 11/30",
      "",
      "  time    [######################·········································]  35%",
      "  target  [##################+++++++++++++++++++++++++++++++++++··········]  30% → 85%",
      "  total   [##############++++++++++++++++++++++++++++········|············]  24% → 68%",
      "           # used   + projected   | target",
      "",
      "                                     now              $           35%            delta",
      "  target      8,000,000        2,374,638     $23,746.38     2,800,000       ✓ -425,362",
      "  total      10,000,000        2,374,638     $23,746.38     3,500,000     ✓ -1,125,362",
      "  projected                    6,784,680     $67,846.80                   ✓ -1,215,320",
    ]);
  });

  test("without a target there is no target bar, row, or marker, and the projection is judged against the entitlement", () => {
    expect(renderCredits(creditsPace(CREDITS, null, NOON_SEP_11))).toEqual([
      "Copilot credits  Vivswan · Sep 2026 · resets Oct 1 · day 11/30",
      "",
      "  time    [######################·········································]  35%",
      "  total   [##############++++++++++++++++++++++++++++·····················]  24% → 68%",
      "           # used   + projected",
      "",
      "                                     now              $           35%            delta",
      "  total      10,000,000        2,374,638     $23,746.38     3,500,000     ✓ -1,125,362",
      "  projected                    6,784,680     $67,846.80                   ✓ -3,215,320",
    ]);
  });

  test("with nothing elapsed there is no projection: bars carry only the spend, the row a dash", () => {
    expect(renderCredits(creditsPace(CREDITS, 8_000_000, Date.UTC(2026, 8, 1)))).toEqual([
      "Copilot credits  Vivswan · Sep 2026 · resets Oct 1 · day 1/30",
      "",
      "  time    [······························································]   0%",
      "  target  [##################············································]  30%",
      "  total   [##############···································|············]  24%",
      "           # used   | target",
      "",
      "                                     now              $     0%            delta",
      "  target      8,000,000        2,374,638     $23,746.38      0     ✗ +2,374,638",
      "  total      10,000,000        2,374,638     $23,746.38      0     ✗ +2,374,638",
      "  projected                            -              -                       -",
    ]);
  });

  test("an overrun fills the bar, closes it with `>`, and flags the delta", () => {
    const over = renderCredits(
      creditsPace({ ...CREDITS, used: 9_000_000 }, 8_000_000, NOON_SEP_11),
    );
    expect(over[3]).toContain("#>");
    expect(over[8]).toContain("✗ +");
  });

  test("a target above the entitlement is said so in the legend", () => {
    const legend = renderCredits(creditsPace(CREDITS, 12_000_000, NOON_SEP_11))[5];
    expect(legend).toContain("above the 10,000,000 entitlement");
  });
});

describe("creditsJson", () => {
  test("bounds are calendar days and the four headline figures have dollars", () => {
    const json = creditsJson(creditsPace(CREDITS, 8_000_000, NOON_SEP_11));
    expect(json).toMatchObject({
      periodStart: "2026-09-01",
      resetDate: "2026-10-01",
      entitlementUsd: 100_000,
      usedUsd: 23_746.38,
      targetUsd: 80_000,
      projectedUsd: 67_846.8,
    });
    expect(json).not.toHaveProperty("periodStartMs");
    expect(creditsJson(creditsPace(CREDITS, null, NOON_SEP_11))).toMatchObject({
      target: null,
      targetUsd: null,
    });
  });
});

describe("runCredits", () => {
  const fetchImpl = () => Promise.resolve(new Response(JSON.stringify(BODY), { status: 200 }));
  const nowMs = () => NOON_SEP_11;

  test("prints the block for the resolved credential, or the JSON with --json", async () => {
    const credential = () => ({ token: "tok", reason: null });
    const block = await captureChannels(() =>
      runCredits({ creditsTarget: "8000000" }, { fetchImpl, credential, nowMs })
    );
    expect(block.stdout.split("\n")[0]).toBe(
      "Copilot credits  Vivswan · Sep 2026 · resets Oct 1 · day 11/30",
    );
    expect(block.stdout).toContain("  target      8,000,000");
    const json = await captureChannels(() =>
      runCredits({ json: true, creditsTarget: "8000000" }, { fetchImpl, credential, nowMs })
    );
    expect(JSON.parse(json.stdout)).toMatchObject({ target: 8_000_000, resetDate: "2026-10-01" });
  });

  test("no credential is the command's error, worded by the credential's own reason", async () => {
    const credential = () => ({ token: null, reason: "run `agent auth` to log in" });
    await expect(runCredits({}, { fetchImpl, credential, nowMs })).rejects.toThrow(
      "run `agent auth` to log in",
    );
  });
});

describe("resolveCreditsTarget", () => {
  test("flag beats the env, which beats the stored key, which beats null; a bad value is refused by name", () => {
    const stored = { creditsTarget: () => 5 } as unknown as CopilotEnvConfig;
    const unset = { creditsTarget: () => null } as unknown as CopilotEnvConfig;
    const env = { [CREDITS_TARGET_ENV]: "6" };
    expect(resolveCreditsTarget("7", stored, env)).toBe(7);
    expect(resolveCreditsTarget(undefined, stored, env)).toBe(6);
    expect(resolveCreditsTarget(undefined, stored, {})).toBe(5);
    expect(resolveCreditsTarget(undefined, unset, {})).toBeNull();
    expect(() => resolveCreditsTarget("0", unset, {})).toThrow("--target: must be between");
    expect(() => resolveCreditsTarget("9".repeat(40), unset, {})).toThrow("must be between");
    expect(() => resolveCreditsTarget(undefined, unset, { [CREDITS_TARGET_ENV]: "8e6" })).toThrow(
      `${CREDITS_TARGET_ENV}: expected a whole number`,
    );
  });
});

describe("agent credits", () => {
  test("--target reaches the resolver: a bad value is refused by the flag's name before any fetch", () => {
    const home = tempDir("credits-cli-");
    const proc = runCli(["credits", "--target", "0"], {
      env: { ...process.env, COPILOT_API_HOME: home },
    });
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr).toContain("--target: must be between");
  });
});
