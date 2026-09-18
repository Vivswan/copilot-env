// The three facts of the fake itself that the CLI tests rest on and the source of aimock does
// not say: where its truncation lands on a codex-shaped stream, that a child which dies before
// listening fails the start at once with its own words, and that aimock dies with the process
// that started it.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHILD_VALUES,
  childValuesEnv,
  denoRunArgs,
  importSpecifier,
  ROOT,
  spawnChild,
} from "./helpers/run.ts";
import {
  awaitListening,
  type FakeModelEndpoint,
  hermeticEnv,
  SCENARIO_HEADER,
} from "./fake_model_endpoint.ts";
import { jsonLines, startFakeEndpoint } from "./helpers/fake_endpoint.ts";
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

/** How long aimock gets to notice its parent is gone: the stdin EOF is immediate; the pid poll,
 *  the fallback, runs once a second. */
const ORPHAN_GRACE_MS = 5_000;

/** Whether anything listens on aimock's port. Read at the socket, not the pid: an orphan that
 *  exited under a pid 1 that reaps nothing (the docker run's `deno task test`) stays a zombie,
 *  which a signal-0 probe reads as alive. A refusal is the one answer that means "gone"; any
 *  other failure throws, so it can never pass as one. */
async function aimockPort(url: string): Promise<"listening" | "refused"> {
  try {
    const conn = await Deno.connect({ hostname: "127.0.0.1", port: Number(new URL(url).port) });
    conn.close();
    return "listening";
  } catch (e) {
    if (e instanceof Deno.errors.ConnectionRefused) return "refused";
    throw e;
  }
}

test("aimock dies with the process that started it, even one killed outright", async () => {
  // A second process starts the fake through the helper, prints where aimock is, and holds it.
  // SIGKILL (TerminateProcess on Windows) gives that process no chance to close anything.
  const holderDir = join(dir, "holder");
  mkdirSync(holderDir);
  const program = join(holderDir, "hold_endpoint.ts");
  writeFileSync(
    program,
    [
      `import { startFakeEndpoint } from ${
        importSpecifier(join(ROOT, "test", "helpers", "fake_endpoint.ts"))
      };`,
      `const fake = await startFakeEndpoint(${CHILD_VALUES}.dir);`,
      `console.log(JSON.stringify({ pid: fake.pid, aimockUrl: fake.aimockUrl }));`,
      `await new Promise(() => {});`,
      "",
    ].join("\n"),
  );
  const holder = spawnChild(Deno.execPath(), {
    args: [...denoRunArgs(), program],
    env: childValuesEnv({ dir: holderDir }),
    stdin: "null",
    stdout: "piped",
    stderr: "null",
  });
  const reader = holder.stdout.getReader();
  const decoder = new TextDecoder();
  let printed = "";
  let aimock: { pid: number; aimockUrl: string } | undefined;
  while (aimock === undefined) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`the holder exited before printing aimock's address: ${printed}`);
    printed += decoder.decode(value, { stream: true });
    aimock = jsonLines(printed).find(
      (line): line is { pid: number; aimockUrl: string } =>
        typeof line.pid === "number" && typeof line.aimockUrl === "string",
    );
  }
  try {
    // Control: the same probe finds aimock before the kill, so "refused" below is a stop observed.
    expect(await aimockPort(aimock.aimockUrl)).toBe("listening");

    holder.kill("SIGKILL");
    await holder.status;
    while (!(await reader.read()).done) {
      // the holder's last output, to its EOF
    }
    const deadline = Date.now() + ORPHAN_GRACE_MS;
    let port = await aimockPort(aimock.aimockUrl);
    while (port === "listening" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      port = await aimockPort(aimock.aimockUrl);
    }
    expect(port).toBe("refused");
  } finally {
    // A regression here is the very leak under test; the pid is what this test can still reach.
    try {
      process.kill(aimock.pid, "SIGKILL");
    } catch {
      // already gone, the expected state
    }
  }
});

test("every hermetic child env keeps deno's release check off, whatever the parent shell says", () => {
  // The parent's own value is irrelevant either way: absent, or set to something else.
  const inherited = process.env.DENO_NO_UPDATE_CHECK;
  try {
    delete process.env.DENO_NO_UPDATE_CHECK;
    expect(hermeticEnv({}).DENO_NO_UPDATE_CHECK).toBe("1");
    process.env.DENO_NO_UPDATE_CHECK = "";
    expect(hermeticEnv({ HOME: "/home/user" }).DENO_NO_UPDATE_CHECK).toBe("1");
  } finally {
    if (inherited === undefined) delete process.env.DENO_NO_UPDATE_CHECK;
    else process.env.DENO_NO_UPDATE_CHECK = inherited;
  }
});
