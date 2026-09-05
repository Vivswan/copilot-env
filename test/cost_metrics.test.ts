// The metrics job's one smoke, the base-vs-head decision: payloads equal once the run-only
// `runtime` key is dropped and keys are sorted at every level report a match; a changed
// cost reports DIFFERS with its diff, once a base re-run confirmed the base did not move.
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
// The same values as BASE with every object's keys in the opposite insertion order at
// every level, and another runtime: only recursive key sorting makes the two texts equal.
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
