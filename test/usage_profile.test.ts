// The profiler cuts lines the way the readers do: on LF alone. Over one transcript whose
// content carries U+2028, U+2029, NEL, a CRLF ending, a raw CR, and an unterminated final
// fragment, the profile counts three lines; node:readline read the same file as seven.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { zstdCompressSync } from "node:zlib";
import { join } from "node:path";
import { removeDir, tmpDir } from "./helpers.ts";
import { ROOT, runScript } from "./helpers/run.ts";
import { codexUsage, sessionMeta, tokenCount, turnContext } from "./helpers/session_fixtures.ts";
import { afterEach, expect, test } from "./helpers/testing.ts";
import { parseProfile } from "./helpers/usage_fixtures.ts";
import { usageTreeEnv } from "./helpers/usage_goldens.ts";

let root = "";
afterEach(() => {
  removeDir(root);
  root = "";
});

function assistant(text: string, usage: Record<string, number>): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-06-01T10:00:00.000Z",
    message: {
      id: `msg_${usage["output_tokens"]}`,
      model: "claude-opus-4-8",
      role: "assistant",
      content: [{ type: "text", text }],
      usage,
    },
  });
}

test("usage_profile reads LF-terminated lines only: separators, a raw CR, and a fragment do not split or count", () => {
  root = tmpDir("usage-profile-");
  // The Codex side is an archive: the same cutting rules after decompression, so its one
  // CRLF-ended token_count line and its unterminated fragment read as one line and none.
  const archived = join(root, ".codex", "archived_sessions");
  mkdirSync(archived, { recursive: true });
  const count = tokenCount("2026-06-01T10:00:05.000Z", codexUsage(10, 0, 1), codexUsage(10, 0, 1));
  const rollout = [
    `${sessionMeta("2026-06-01T10:00:00.000Z", "aaa", { provider: "copilot-env" })}\n`,
    `${turnContext("2026-06-01T10:00:01.000Z", "gpt-5.6")}\n`,
    `${count}\r\n`,
    tokenCount("2026-06-01T10:00:09.000Z", codexUsage(30, 0, 3), codexUsage(20, 0, 2)),
  ].join("");
  writeFileSync(
    join(archived, "rollout-2026-06-01T01-00-00-aaa.jsonl.zst"),
    zstdCompressSync(Buffer.from(rollout)),
  );
  const claudeDir = join(root, ".claude", "projects", "-Users-x-proj");
  mkdirSync(claudeDir, { recursive: true });
  const transcript = join(claudeDir, "aaa.jsonl");
  const plain = assistant("plain", { "input_tokens": 10, "output_tokens": 20 });
  const odd = assistant("odd \u2028 \u2029 \u0085 text", { "input_tokens": 1, "output_tokens": 2 });
  const body = [
    `${plain}\n`,
    // Separators inside the JSON string, CRLF-terminated: one line.
    `${odd}\r\n`,
    // A raw CR inside makes this invalid JSON: ONE torn line, not two.
    `{"type":"user","message":{"role":"user","content":"a\rb"}}\n`,
    // No LF yet: a writer mid-line, withheld until it lands.
    assistant("fragment", { "input_tokens": 5, "output_tokens": 6 }),
  ].join("");
  writeFileSync(transcript, body);
  expect(readFileSync(transcript, "utf8").split("\n").length).toBe(4);

  const out = join(root, "profile.json");
  const proc = runScript(join(ROOT, "scripts", "usage_profile.ts"), ["--out", out], {
    env: { ...process.env, ...usageTreeEnv(root), COPILOT_ENV_ROOT_HOME: undefined },
  });
  expect(proc.stderr).toContain("profiling 1 codex rollout files");
  expect(proc.stderr).toContain("profiling 1 claude transcript files");
  expect(proc.exitCode).toBe(0);
  const profile = parseProfile(JSON.parse(readFileSync(out, "utf8")));

  const codex = profile.codex;
  expect(codex.linesPerFile).toEqual({ count: 1, p5: 3, p25: 3, p50: 3, p75: 3, p95: 3, p99: 3 });
  expect(codex.lineTypeShare["event_msg/token_count"]).toBe(1 / 3);
  // Its byte count excludes both CR and LF terminator bytes.
  const countBytes = Buffer.byteLength(count);
  expect(codex.bytesPerLine["event_msg/token_count"]).toMatchObject({
    count: 1,
    p5: countBytes,
    p99: countBytes,
  });
  expect(codex.models["gpt-5.6"]?.output).toMatchObject({ count: 1, p50: 1 });

  const claude = profile.claude;
  expect(claude.linesPerFile).toEqual({ count: 1, p5: 3, p25: 3, p50: 3, p75: 3, p95: 3, p99: 3 });
  expect(claude.lineTypeShare).toEqual({ assistant: 2 / 3, torn: 1 / 3 });
  expect(claude.usageLineShare).toBe(2 / 3);
  // Line bytes exclude the terminator, the CR of a CRLF included (JSON.parse would have
  // accepted a trailing CR, so only the byte count tells).
  const [shorter, longer] = [Buffer.byteLength(odd), Buffer.byteLength(plain)].sort((a, b) =>
    a - b
  );
  expect(claude.bytesPerLine.assistant).toEqual({
    count: 2,
    p5: shorter,
    p25: shorter,
    p50: longer,
    p75: longer,
    p95: longer,
    p99: longer,
  });
  expect(Object.keys(claude.models)).toEqual(["claude-opus-4-8"]);
  expect(claude.models["claude-opus-4-8"]?.output).toMatchObject({ count: 2, p5: 2, p99: 20 });
});
