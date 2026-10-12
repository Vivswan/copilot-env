// The deadline error is the only trace a stalled body leaves in a CI log: a run that stalled on
// the macOS runner named the test and nothing else. The error must name the step the body was in
// and how long each earlier step took, from that body's own marks alone.
import { delay } from "@std/async";
import { expect, step, test, withDeadline } from "./testing.ts";

const GAP_MS = 20;
// Far above the marks' total, so an event-loop pause on a loaded runner cannot fire the deadline
// before the last mark lands.
const DEADLINE_MS = 1500;

function stalling(marks: string[]): () => Promise<void> {
  return async () => {
    for (const mark of marks) {
      step(mark);
      await delay(GAP_MS);
    }
    await new Promise<never>(() => {});
  };
}

async function deadlineError(marks: string[]): Promise<string> {
  try {
    await withDeadline("stalls", stalling(marks), DEADLINE_MS)();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("the deadline did not fire");
}

test("the deadline error names the last step and the time each earlier step took, from this body's marks alone", async () => {
  // Both rows run in one body on purpose: a log that did not reset between deadline runs would
  // carry the first row's marks into the second row's message, whose pattern allows none.
  const rows: { marks: string[]; message: RegExp }[] = [
    {
      marks: ["write", "spawn", "read"],
      message:
        /^test "stalls" timed out after 1500 ms at step "read" \(entered (\d+) ms in; steps: write (\d+) ms, spawn (\d+) ms, read (\d+) ms\)$/,
    },
    { marks: [], message: /^test "stalls" timed out after 1500 ms with no step recorded$/ },
  ];
  for (const row of rows) {
    const message = await deadlineError(row.marks);
    const match = row.message.exec(message);
    expect(message, message).toMatch(row.message);
    if (match === null || row.marks.length === 0) continue;
    const [entered = 0, ...durations] = match.slice(1).map(Number);
    const earlier = durations.slice(0, -1);
    const last = durations.at(-1) as number;
    expect(
      {
        enteredAtLeast: entered >= (row.marks.length - 1) * (GAP_MS - 5),
        earlierAtLeastGap: earlier.every((ms) => ms >= GAP_MS - 5),
        earlierEndedByTheLastMark: earlier.every((ms) => ms <= entered + 1),
        lastFillsTheRest: last >= DEADLINE_MS - entered - 5,
      },
      message,
    ).toEqual({
      enteredAtLeast: true,
      earlierAtLeastGap: true,
      earlierEndedByTheLastMark: true,
      lastFillsTheRest: true,
    });
  }
});
