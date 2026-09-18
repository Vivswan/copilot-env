// The two facts of the fake itself that the CLI tests rest on and the source of aimock does not
// say: where its truncation lands on a codex-shaped stream, and that a child which dies before
// listening fails the start at once with its own words.
import { spawnChild } from "./helpers/run.ts";
import { awaitListening, type FakeModelEndpoint, SCENARIO_HEADER } from "./fake_model_endpoint.ts";
import { startFakeEndpoint } from "./helpers/fake_endpoint.ts";
import { afterEach, beforeEach, expect, removeDir, tempDir, test } from "./helpers/testing.ts";

let fake: FakeModelEndpoint;
let dir = "";

beforeEach(async () => {
  dir = tempDir("fake-endpoint-");
  fake = await startFakeEndpoint(dir);
});

afterEach(async () => {
  await fake.close();
  dir = removeDir(dir);
});

/** The SSE event types of a stream read to its end or to the cut (a destroyed socket rejects the
 *  body read; what arrived before it counts). */
async function eventTypes(body: Record<string, unknown>): Promise<string[]> {
  const res = await fetch(`${fake.baseUrl}/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [SCENARIO_HEADER]: "truncate-after-first-delta",
    },
    body: JSON.stringify(body),
  });
  let text = "";
  const decoder = new TextDecoder();
  try {
    for await (const chunk of res.body ?? []) text += decoder.decode(chunk, { stream: true });
  } catch {
    // the cut
  }
  return text.split("\n").filter((line) => line.startsWith("data: ")).map((line) =>
    String((JSON.parse(line.slice("data: ".length)) as { type: string }).type)
  );
}

test("the truncate scenario cuts a codex-shaped stream right after its FIRST content delta", async () => {
  // codex's shape: the encrypted-reasoning include, which puts a 2-frame reasoning item first.
  const codexShaped = await eventTypes({
    "model": "gpt-5.4",
    "stream": true,
    "include": ["reasoning.encrypted_content"],
    "reasoning": { "effort": "medium" },
    "input": [{
      "type": "message",
      "role": "user",
      "content": [{ "type": "input_text", "text": "hi" }],
    }],
  });
  expect(codexShaped).toEqual([
    "response.created",
    "response.in_progress",
    "response.output_item.added",
    "response.output_item.done",
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.delta",
  ]);
  // Control: without the include there is no reasoning item, so the same cut lands three deltas
  // in; the constant is codex's request shape, not a universal "first delta".
  const plain = await eventTypes({ "model": "gpt-5.4", "stream": true, "input": "hi" });
  expect(plain.filter((t) => t === "response.output_text.delta")).toHaveLength(3);
  expect(plain).not.toContain("response.output_item.done");
});

test("a child that exits before listening fails the start at once, naming its exit and output", async () => {
  const child = spawnChild(Deno.execPath(), {
    args: ["eval", "console.error('no such fixture file'); Deno.exit(3);"],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  });
  const started = Date.now();
  await expect(awaitListening(child)).rejects.toThrow(
    /exited with code 3 before listening: no such fixture file/,
  );
  // Well inside the 60 s start timeout: the exit, not the deadline, settled it.
  expect(Date.now() - started).toBeLessThan(15_000);
});
