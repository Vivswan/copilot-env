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
  "login": "octocat",
  "quota_reset_date": "2026-10-01",
  "quota_snapshots": {
    "premium_interactions": { "entitlement": 10_000_000, "credits_used": 2_374_638 },
  },
};
const CREDITS: CopilotCredits = {
  login: "octocat",
  entitlement: 10_000_000,
  used: 2_374_638,
  resetDate: "2026-10-01",
};
const NOON_SEP_11 = Date.UTC(2026, 8, 11, 12);

describe("parseCopilotCredits", () => {
  test("reads the metered quota, used count, reset date, and login; names the missing or malformed field", () => {
    expect(parseCopilotCredits(BODY)).toEqual(CREDITS);
    expect(parseCopilotCredits({ ...BODY, "login": undefined }).login).toBeNull();

    // The endpoint is undocumented: a shape it stops matching is named, not guessed at.
    const malformed: [unknown, string][] = [
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
    for (const [body, needle] of malformed) {
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
  const PACES: {
    name: string;
    credits: CopilotCredits;
    target: number | null;
    nowMs: number;
    pace: Record<string, number | null>;
    renderedLines?: number;
  }[] = [
    {
      name: "measures the calendar month before the reset and projects the spend at today's rate",
      credits: CREDITS,
      target: 8_000_000,
      nowMs: NOON_SEP_11,
      pace: {
        periodStartMs: Date.UTC(2026, 8, 1),
        resetMs: Date.UTC(2026, 9, 1),
        day: 11,
        daysTotal: 30,
        elapsed: 10.5 / 30,
        targetMark: 2_800_000,
        totalMark: 3_500_000,
        projected: Math.round(2_374_638 / 10.5 * 30),
      },
    },
    {
      name: "a reset on the 31st starts the period on the shorter month's last day",
      credits: { ...CREDITS, resetDate: "2026-03-31" },
      target: null,
      nowMs: Date.UTC(2026, 2, 1),
      pace: { periodStartMs: Date.UTC(2026, 1, 28), daysTotal: 31 },
    },
    {
      name: "no target leaves the target and its mark null; nothing elapsed means no projection",
      credits: CREDITS,
      target: null,
      nowMs: Date.UTC(2026, 8, 1),
      pace: { target: null, targetMark: null, elapsed: 0, day: 1, projected: null },
    },
    {
      name: "a fractional spend near the reset never projects below itself",
      credits: { ...CREDITS, entitlement: 10, used: 1.4 },
      target: null,
      nowMs: Date.UTC(2026, 8, 30, 12),
      pace: { projected: 1.4 },
      renderedLines: 9,
    },
    {
      name: "a clock past the reset clamps to the full period",
      credits: CREDITS,
      target: null,
      nowMs: Date.UTC(2026, 9, 5),
      pace: { elapsed: 1, day: 30 },
    },
  ];

  for (const { name, credits, target, nowMs, pace: expected, renderedLines } of PACES) {
    test(name, () => {
      const pace = creditsPace(credits, target, nowMs);
      for (const [field, value] of Object.entries(expected)) {
        const actual = pace[field as keyof typeof pace];
        expect(actual, field).toBe(value);
      }
      if (renderedLines !== undefined) expect(renderCredits(pace)).toHaveLength(renderedLines);
    });
  }
});

describe("renderCredits", () => {
  // Checked cell for cell against ghco's jq on the same numbers; the `$` column is ours,
  // at GitHub's 100 credits to the dollar. A row pins the whole block, or the cells that
  // carry its point.
  const BLOCKS: {
    name: string;
    credits: CopilotCredits;
    target: number | null;
    nowMs: number;
    lines?: string[];
    cells?: [line: number, fragment: string][];
  }[] = [
    {
      name: "ghco's block cell for cell, plus the dollar column",
      credits: CREDITS,
      target: 8_000_000,
      nowMs: NOON_SEP_11,
      lines: [
        "Copilot credits  octocat · Sep 2026 · resets Oct 1 · day 11/30",
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
      ],
    },
    {
      name:
        "without a target there is no target bar, row, or marker, and the projection is judged against the entitlement",
      credits: CREDITS,
      target: null,
      nowMs: NOON_SEP_11,
      lines: [
        "Copilot credits  octocat · Sep 2026 · resets Oct 1 · day 11/30",
        "",
        "  time    [######################·········································]  35%",
        "  total   [##############++++++++++++++++++++++++++++·····················]  24% → 68%",
        "           # used   + projected",
        "",
        "                                     now              $           35%            delta",
        "  total      10,000,000        2,374,638     $23,746.38     3,500,000     ✓ -1,125,362",
        "  projected                    6,784,680     $67,846.80                   ✓ -3,215,320",
      ],
    },
    {
      name:
        "with nothing elapsed there is no projection: bars carry only the spend, the row a dash",
      credits: CREDITS,
      target: 8_000_000,
      nowMs: Date.UTC(2026, 8, 1),
      lines: [
        "Copilot credits  octocat · Sep 2026 · resets Oct 1 · day 1/30",
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
      ],
    },
    {
      name: "an overrun fills the bar, closes it with `>`, and flags the delta",
      credits: { ...CREDITS, used: 9_000_000 },
      target: 8_000_000,
      nowMs: NOON_SEP_11,
      cells: [[3, "#>"], [8, "✗ +"]],
    },
    {
      name: "a target above the entitlement is said so in the legend",
      credits: CREDITS,
      target: 12_000_000,
      nowMs: NOON_SEP_11,
      cells: [[5, "above the 10,000,000 entitlement"]],
    },
  ];

  for (const { name, credits, target, nowMs, lines, cells = [] } of BLOCKS) {
    test(`renders ${name}`, () => {
      const rendered = renderCredits(creditsPace(credits, target, nowMs));
      if (lines !== undefined) expect(rendered).toEqual(lines);
      for (const [line, fragment] of cells) {
        expect(rendered[line], `line ${line}`).toContain(fragment);
      }
    });
  }
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

  test("prints the block for the resolved credential, or the JSON with --json; no credential is the command's error, worded by the credential's own reason", async () => {
    const credential = () => ({ token: "tok", reason: null });
    const block = await captureChannels(() =>
      runCredits({ creditsTarget: "8000000" }, { fetchImpl, credential, nowMs })
    );
    expect(block.stdout.split("\n")[0]).toBe(
      "Copilot credits  octocat · Sep 2026 · resets Oct 1 · day 11/30",
    );
    expect(block.stdout).toContain("  target      8,000,000");
    const json = await captureChannels(() =>
      runCredits({ json: true, creditsTarget: "8000000" }, { fetchImpl, credential, nowMs })
    );
    expect(JSON.parse(json.stdout)).toMatchObject({ target: 8_000_000, resetDate: "2026-10-01" });

    const none = () => ({ token: null, reason: "run `agent auth` to log in" });
    await expect(runCredits({}, { fetchImpl, credential: none, nowMs })).rejects.toThrow(
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
