// The metrics job's one smoke: the base-vs-head decision over two payloads. Payloads that
// agree once the run-only `runtime` key is dropped report a match; a payload whose cost
// differs reports DIFFERS with the differing run's diff, once a base re-run has confirmed
// the base itself did not move.
import { classifyPayloads, comparable } from "../.github/scripts/cost-metrics.ts";
import { expect, test } from "./helpers/testing.ts";

const BASE = {
  dbCount: 0,
  claudeSessions: {
    activeDays: 2,
    totalUsd: 1.5,
    usageByModel: { "claude-opus-4.8": { input: 10 } },
  },
  runtime: { indexed: false, index: { bytesRead: 9_001 } },
};
const HEAD_WARM = { ...BASE, runtime: { indexed: true, index: { bytesRead: 0 } } };
const HEAD_CHANGED = {
  ...BASE,
  claudeSessions: { ...BASE.claudeSessions, totalUsd: 1.6 },
};

test("two payloads match once runtime is dropped; a changed cost differs with its diff", async () => {
  const base = comparable(BASE);
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
