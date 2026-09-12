import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifyPayloads,
  comparable,
  deltaCell,
  renderWindowTable,
} from "../.github/scripts/cost-metrics.ts";
import { ROOT, runSync } from "./helpers/run.ts";
import { expect, tempDir, test } from "./helpers/testing.ts";

const BASE = {
  dbCount: 0,
  claudeSessions: {
    activeDays: 2,
    totalUsd: 1.5,
    usageByModel: { "claude-opus-4.8": { input: 10 } },
  },
  runtime: { indexed: false, index: { bytesRead: 9_001 } },
};
// BASE's values with the keys reversed at every level: only recursive key sorting makes the two comparable texts equal.
const HEAD_WARM = {
  runtime: { index: { bytesRead: 0 }, indexed: true },
  claudeSessions: {
    usageByModel: { "claude-opus-4.8": { input: 10 } },
    totalUsd: 1.5,
    activeDays: 2,
  },
  dbCount: 0,
};
const HEAD_CHANGED = {
  ...BASE,
  claudeSessions: { ...BASE.claudeSessions, totalUsd: 1.6 },
};

test("two payloads match once runtime is dropped; a changed cost differs with its diff", async () => {
  const base = comparable(BASE);
  expect(JSON.stringify(HEAD_WARM)).not.toBe(
    JSON.stringify({ ...BASE, runtime: HEAD_WARM.runtime }),
  );
  const noRecheck = () => Promise.reject(new Error("recheck must not run"));
  const noDiff = () => Promise.reject(new Error("diff must not run"));

  expect(
    await classifyPayloads(
      base,
      [{ label: "cold", text: comparable(BASE) }, { label: "warm", text: comparable(HEAD_WARM) }],
      noRecheck,
      noDiff,
    ),
  ).toEqual({ outcome: { kind: "match" }, rechecked: false });

  const changed = comparable(HEAD_CHANGED);
  expect(changed).not.toBe(base);
  expect(
    await classifyPayloads(
      base,
      [{ label: "cold", text: base }, { label: "warm", text: changed }],
      () => Promise.resolve(base),
      (text) => Promise.resolve(`diff:${text === changed ? "warm" : "other"}`),
    ),
  ).toEqual({
    outcome: { kind: "differs", labels: ["warm"], diff: "diff:warm" },
    rechecked: true,
  });
});

test("the window table has a row per measure with base, head, and a signed delta", () => {
  expect(renderWindowTable({
    window: "whole tree (30 days, 32-day window)",
    base: { coldMs: 3874, warmMs: 401, noIndexMs: undefined, bytesRead: undefined },
    head: { coldMs: 3997, warmMs: 353, noIndexMs: 3601, bytesRead: 0 },
    outcome: { kind: "match" },
    runtimeKeyPresent: true,
  })).toEqual([
    "**whole tree (30 days, 32-day window)**",
    "",
    "| measure | base | head | diff |",
    "| --- | --- | --- | --- |",
    "| cold | 3874 ms | 3997 ms | +123 ms (+3.2%) |",
    "| warm | 401 ms | 353 ms | -48 ms (-12.0%) |",
    "| --no-index | n/a | 3601 ms |  |",
    "| warm bytes read | n/a | 0 |  |",
    "| JSON vs base |  |  | match |",
  ]);
  // A percent that rounds to zero keeps a plus; a zero base gets the delta without a percent.
  expect(deltaCell(9999, 10000, " ms")).toBe("-1 ms (+0.0%)");
  expect(deltaCell(0, 0, "")).toBe("+0");
});

test("the verdict step exits 1 on a recorded differs and 0 on a match", () => {
  const script = join(ROOT, ".github", "scripts", "cost-metrics.ts");
  const verdict = (recorded: string) => {
    const dir = tempDir("cost-metrics-verdict-");
    writeFileSync(join(dir, "verdict"), `${recorded}\n`);
    return runSync(Deno.execPath(), ["run", "--allow-read", script, "verdict", "--in", dir]);
  };
  expect(verdict("match").exitCode).toBe(0);
  const differs = verdict("differs");
  expect(differs.exitCode).toBe(1);
  expect(differs.stderr).toContain("cost JSON differs from the base commit");
});
