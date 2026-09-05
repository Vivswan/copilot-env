// The corpus recorder, end to end with the real CLIs (skipped where either is absent), and the
// one property of its scrub that matters: nothing private survives into the shareable copies.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdMap, isClaudeUsageLine, isCodexUsageLine, scrubJsonl } from "../scripts/usage_corpus.ts";
import { findCommand } from "../src/utils/command.ts";
import { ROOT, runCli, runScript } from "./helpers/run.ts";
import { describe, expect, test } from "./helpers/testing.ts";

type Json = Record<string, unknown>;

function isJson(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(obj: unknown, ...path: string[]): unknown {
  let current: unknown = obj;
  for (const key of path) {
    if (!isJson(current)) return undefined;
    current = current[key];
  }
  return current;
}

describe("usage corpus scrub", () => {
  test("nothing private survives: secrets of every shape leave as SCRUBBED or a pseudonym", () => {
    const session = "3b0d9160-c75b-415e-a217-bb97a9d60c33";
    const line = JSON.stringify({
      "type": "assistant",
      "timestamp": "2026-09-04T23:53:34.386Z",
      "uuid": session,
      "sessionId": session,
      "version": "2.1.258",
      // Content of every length and shape under known keys.
      "cwd": "/Users/viv/secret-project",
      "gitBranch": "main",
      "lastPrompt": "sk-ant-1",
      "text": "aGVsbG8gd29ybGQ=",
      // Identifier-shaped secrets under enum keys, and an unknown identifier-shaped key.
      "name": "Alice",
      "summary": "secret_project",
      "model": "acme-internal-model",
      "customer": "acme-corp",
      "settings": { "/tmp/a.txt": 1, "has space": 2, "constructor": "x" },
      "message": {
        "id": "msg_25950bad28ce4ed1d19ffb13",
        "role": "assistant",
        "model": "claude-sonnet-4-6",
        "content": [
          { "type": "text", "text": "a reply", "citations": null },
          {
            "type": "tool_use",
            "id": "toolu_01abc",
            "name": "Read",
            "input": { "file_path": "/u/me" },
          },
        ],
        "stop_reason": "tool_use",
        "usage": { "input_tokens": 12, "output_tokens": 3, "service_tier": "standard" },
      },
      "toolUseResult": {
        "customer": "Alice",
        "when": "2026-09-04T23:53:34.386Z",
        "ref": session,
        "n": 2,
      },
    });
    const result = scrubJsonl(line, isClaudeUsageLine, new IdMap("fixed-salt-for-tests"));
    for (
      const secret of [
        "viv",
        "secret",
        "sk-ant",
        "aGVsbG8",
        "Alice",
        "acme",
        "/u/me",
        "/tmp/a",
        "has space",
        "constructor",
        session,
        "25950bad",
      ]
    ) {
      expect(result.text).not.toContain(secret);
    }
    const parsed = JSON.parse(result.text) as Json;
    // Positive control: what the readers key on is still there, ids as consistent pseudonyms.
    expect(parsed.type).toBe("assistant");
    expect(parsed.timestamp).toBe("2026-09-04T23:53:34.386Z");
    expect(parsed.version).toBe("2.1.258");
    expect(parsed.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(parsed.sessionId).toBe(parsed.uuid);
    expect(field(parsed, "message", "id")).toMatch(/^msg_[0-9a-f]{24}$/);
    expect(field(parsed, "message", "model")).toBe("claude-sonnet-4-6");
    expect(field(parsed, "message", "stop_reason")).toBe("tool_use");
    expect(field(parsed, "message", "usage")).toEqual({
      "input_tokens": 12,
      "output_tokens": 3,
      "service_tier": "standard",
    });
    const blocks = field(parsed, "message", "content") as Json[];
    expect(blocks[0]).toEqual({ "type": "text", "text": "SCRUBBED", "citations": null });
    expect(blocks[1]!.name).toBe("Read");
    expect(blocks[1]!.input).toEqual({ "SCRUBBED_KEY_0": "SCRUBBED" });
    expect(field(parsed, "toolUseResult", "SCRUBBED_KEY_2")).toBe(parsed.uuid); // the ref, pseudonymized
    expect(parsed.name).toBe("SCRUBBED");
    expect(parsed.summary).toBe("SCRUBBED");
    expect(parsed.model).toBe("SCRUBBED");
    expect(Object.keys(parsed.settings as Json).sort()).toEqual([
      "SCRUBBED_KEY_0",
      "SCRUBBED_KEY_1",
      "SCRUBBED_KEY_2",
    ]);
    expect("customer" in parsed).toBe(false);
    expect(result.usageLines).toBe(1);

    // Codex records: everything the Codex reader needs survives, the rest goes.
    const thread = "01a06f2d-2c46-7cb3-b769-258714552122";
    const codexLines = [
      {
        "timestamp": "2026-09-05T00:35:24.019Z",
        "type": "session_meta",
        "payload": {
          "id": thread,
          "session_id": thread,
          "forked_from_id": "01a06f2d-1111-7cb3-b769-258714552122",
          "cwd": "/Users/viv/secret-project",
          "model_provider": "fake",
          "cli_version": "0.153.4",
          "base_instructions": { "text": "You are a secret assistant" },
        },
      },
      {
        "timestamp": "2026-09-05T00:35:24.030Z",
        "type": "turn_context",
        "payload": {
          "model": "gpt-5.4",
          "cwd": "/Users/viv/secret-project",
          "approval_policy": "never",
        },
      },
      {
        "timestamp": "2026-09-05T00:35:24.040Z",
        "type": "event_msg",
        "payload": {
          "type": "token_count",
          "info": {
            "last_token_usage": {
              "input_tokens": 7895,
              "cached_input_tokens": 3000,
              "output_tokens": 117,
            },
            "total_token_usage": { "input_tokens": 7895 },
          },
        },
      },
    ].map((record) => JSON.stringify(record)).join("\n");
    const codex = scrubJsonl(codexLines, isCodexUsageLine, new IdMap("fixed-salt-for-tests"));
    expect(codex.usageLines).toBe(1);
    for (const secret of ["viv", "secret", thread]) expect(codex.text).not.toContain(secret);
    const [meta, turn, count] = codex.text.split("\n").map((l) => JSON.parse(l) as Json);
    expect(meta!.type).toBe("session_meta");
    expect(meta!.timestamp).toBe("2026-09-05T00:35:24.019Z");
    expect(field(meta, "payload", "id")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(field(meta, "payload", "session_id")).toBe(field(meta, "payload", "id"));
    expect(field(meta, "payload", "forked_from_id")).not.toBe(field(meta, "payload", "id"));
    expect(field(meta, "payload", "model_provider")).toBe("fake");
    expect(field(meta, "payload", "cli_version")).toBe("0.153.4");
    expect(field(meta, "payload", "cwd")).toBe("SCRUBBED");
    expect(field(meta, "payload", "base_instructions", "text")).toBe("SCRUBBED");
    expect(turn!.type).toBe("turn_context");
    expect(field(turn, "payload", "model")).toBe("gpt-5.4");
    expect(count!.type).toBe("event_msg");
    expect(field(count, "payload", "type")).toBe("token_count");
    expect(field(count, "payload", "info", "last_token_usage")).toEqual({
      "input_tokens": 7895,
      "cached_input_tokens": 3000,
      "output_tokens": 117,
    });
  });
});

// The same resolver the driver uses, so the test runs exactly where the driver would.
const HAVE_BOTH_CLIS = findCommand("claude").path !== null && findCommand("codex").path !== null;
if (!HAVE_BOTH_CLIS) {
  console.error(
    "usage_corpus: skipping the end-to-end recording (claude and codex must both be on PATH)",
  );
}

describe("usage corpus recorder", () => {
  test.skipIf(!HAVE_BOTH_CLIS)(
    "records both CLIs against the fake and agent cost over the kept home matches what was served",
    () => {
      const parent = mkdtempSync(join(tmpdir(), "usage-corpus-out-"));
      const out = join(parent, "corpus");
      try {
        const result = runScript(join(ROOT, "scripts", "usage_corpus.ts"), ["--out", out], {
          timeoutMs: 9 * 60_000,
        });
        expect(result.exitCode).toBe(0);
        // The consumer contract: one stdout line, usage lines for both CLIs.
        // Exactly one line, then the trailing newline: CI's `tail -n 1` must get the summary.
        const lines = result.stdout.split(/\r?\n/);
        expect(lines).toHaveLength(2);
        expect(lines[1]).toBe("");
        const summary = JSON.parse(lines[0]!) as Json;
        expect(summary.failures).toEqual([]);
        expect(field(summary, "usageLines", "claude") as number).toBeGreaterThan(0);
        expect(field(summary, "usageLines", "codex") as number).toBeGreaterThan(0);
        const home = join(out, "home");
        expect(existsSync(join(home, ".claude", "projects"))).toBe(true);
        expect(existsSync(join(home, ".codex", "sessions"))).toBe(true);
        // Login stripping, with its positive control: the CLI wrote its account file, the
        // driver reports removing it, and it is gone.
        expect(summary.removed).toContain("home/.claude/.claude.json");
        expect(existsSync(join(home, ".claude", ".claude.json"))).toBe(false);
        // The consumer's own command over the kept home reproduces the fake's token sums.
        const cost = runCli(["cost", "--json", "--days", "7"], {
          env: {
            ...process.env,
            HOME: home,
            CODEX_HOME: join(home, ".codex"),
            CLAUDE_CONFIG_DIR: join(home, ".claude"),
            COPILOT_API_HOME: join(home, "copilot-api"),
          },
        });
        expect(cost.exitCode).toBe(0);
        const report: unknown = JSON.parse(cost.stdout);
        const served = summary.fakeUsage as Record<string, Record<string, number>>;
        const codex = field(
          report,
          "codexSessions",
          "providers",
          "fake",
          "usageByModel",
          "gpt-5.4",
        );
        const claude = field(report, "claudeSessions", "usageByModel", "claude-sonnet-4.6");
        for (const bucket of ["input", "cacheRead", "cacheCreation", "output"]) {
          expect(field(codex, bucket)).toBe(served.codex![bucket]);
          expect(field(claude, bucket)).toBe(served.claude![bucket]);
        }
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    },
    10 * 60_000,
  );
});
