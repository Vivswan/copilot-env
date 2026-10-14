// A `finally` that runs after its test's deadline is an abandoned body: the runner has already
// rejected, and each wait it reaches decides whether the next cleanup line runs. Incident: the
// start_lifecycle "previous holder" test's finally kills the launched daemon, then the previous
// holder; with the first wait rejecting although its pid was already gone, the second SIGKILL was
// never sent and the holder outlived the suite. Nothing but this file states what `until` answers
// once the deadline has fired.
import { once } from "node:events";
import { until } from "./daemon.ts";
import { expect, test, testAbortSignal, withDeadline } from "./testing.ts";

function deadlineSignal(): AbortSignal {
  const signal = testAbortSignal();
  if (signal === undefined) throw new Error("no test deadline in scope");
  return signal;
}

/** `body` starts only after its own deadline has fired, the state a `finally` behind a stalled
 *  await is in; the runner's rejection is dropped, the body's answer is returned. */
async function afterTheDeadline<T>(body: () => Promise<T>): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const abandoned = async (): Promise<void> => {
    await once(deadlineSignal(), "abort");
    body().then(resolve, reject);
  };
  await withDeadline("abandoned", abandoned, 1)().catch(() => {});
  return await promise;
}

test("after the deadline fired, a wait whose probe is already true resolves and one whose probe is false rejects with the deadline's reason", async () => {
  const rows: { probe: boolean; outcome: string }[] = [
    { probe: true, outcome: "resolved" },
    { probe: false, outcome: "rejected with the deadline's reason" },
  ];
  for (const row of rows) {
    const outcome = await afterTheDeadline(async () => {
      const reason = deadlineSignal().reason;
      try {
        await until(() => row.probe);
        return "resolved";
      } catch (error) {
        return error === reason
          ? "rejected with the deadline's reason"
          : `rejected with ${String(error)}`;
      }
    });
    expect(outcome, `probe already ${row.probe}`).toBe(row.outcome);
  }
});
