// Claude: the five scripted print-mode turns, and what its transcripts must show afterwards.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ledger } from "./cli.ts";
import { registry, runTurn } from "./children.ts";
import type { MinuteStraddle } from "./fake.ts";
import { filesFor, isRecord } from "./transcripts.ts";

const CLAUDE_MODEL = "claude-sonnet-4-6";

export interface ClaudeIds {
  first: string | null;
  resumed: string | null;
  tool: string | null;
  afterTool: string | null;
  fork: string | null;
}

/** `session_id` from a `--output-format json` result, or null. */
function claudeSessionId(stdout: string): string | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (isRecord(parsed) && typeof parsed.session_id === "string") return parsed.session_id;
  } catch {
    // not JSON
  }
  return null;
}

export async function recordClaude(
  home: string,
  work: string,
  baseUrl: string | null,
  straddle: MinuteStraddle,
  turnsDir: string,
  stop: (label: string) => void,
): Promise<ClaudeIds> {
  const ids: ClaudeIds = { first: null, resumed: null, tool: null, afterTool: null, fork: null };
  const claudeHome = join(home, ".claude");
  const extra: Record<string, string> = {
    CLAUDE_CONFIG_DIR: claudeHome,
    DISABLE_TELEMETRY: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  if (baseUrl !== null) {
    extra.ANTHROPIC_BASE_URL = baseUrl;
    // A bearer token: an API key needs an interactive approval that print mode reports as
    // "Not logged in", while a token is accepted as-is.
    extra.ANTHROPIC_AUTH_TOKEN = "corpus-fake-token";
  } else {
    // --real: a file-backed login lives in the (possibly overridden) config dir, so carry it
    // into the throwaway one.
    const credentials = join(
      Deno.env.get("CLAUDE_CONFIG_DIR") ?? join(homedir(), ".claude"),
      ".credentials.json",
    );
    if (existsSync(credentials)) {
      mkdirSync(claudeHome, { recursive: true });
      copyFileSync(credentials, join(claudeHome, ".credentials.json"));
      ledger.written.push("home/.claude/.credentials.json");
    }
  }
  // Print mode reads the prompt from stdin when no positional prompt is given.
  const base = ["-p", "--output-format", "json", "--model", CLAUDE_MODEL];
  const turn = async (label: string, args: string[], prompt: string) => {
    const result = await runTurn(
      label,
      "claude",
      [...base, ...args],
      prompt,
      home,
      work,
      extra,
      baseUrl === null,
      turnsDir,
    );
    const id = result.ok ? claudeSessionId(result.stdout) : null;
    if (result.stuck) {
      stop(`${label}: the CLI did not exit after the kill (${registry.lastKillError})`);
    }
    if (id === null) stop(`${label}: ${result.ok ? "no session id in the result" : "failed"}`);
    return id;
  };

  ids.first = await turn("claude turn 1", [], "Reply with one short sentence about the weather.");
  if (ids.first === null) return ids;
  await straddle.arm();
  ids.resumed = await turn(
    "claude turn 2 (resume)",
    ["--resume", ids.first],
    "Now one sentence about the sea.",
  );
  if (ids.resumed === null) return ids;
  // Read inside the cwd needs no permission grant in print mode, so no tool allowlist.
  ids.tool = await turn(
    "claude turn 3 (tool)",
    [],
    `Use the Read tool on the note. tool-name: Read tool-args: ${
      JSON.stringify({ "file_path": join(work, "corpus-note.txt") })
    }`,
  );
  if (ids.tool === null) return ids;
  ids.afterTool = await turn(
    "claude turn 4 (resume after tool)",
    ["--resume", ids.tool],
    "Summarize what you read in one sentence.",
  );
  if (ids.afterTool === null) return ids;
  ids.fork = await turn(
    "claude turn 5 (fork)",
    ["--resume", ids.first, "--fork-session"],
    "One sentence about mountains.",
  );
  return ids;
}

/** What the Claude transcripts must show: both resumes continued their sessions (same ids, a
 *  second assistant message in session 1's file), the tool turn holds a tool_use AND its
 *  tool_result, and the fork is a new session carrying EVERY record of session 1 plus its own. */
export function claudeEvidenceFailures(
  ids: ClaudeIds,
  recordsByFile: Map<string, Record<string, unknown>[]>,
): string[] {
  const failures: string[] = [];
  const files = [...recordsByFile.keys()];
  if (
    ids.first === null || ids.resumed === null || ids.tool === null || ids.afterTool === null ||
    ids.fork === null
  ) {
    return ["claude: not every turn produced a session id"];
  }
  if (ids.resumed !== ids.first) failures.push("claude: the resume did not continue session 1");
  if (ids.afterTool !== ids.tool) {
    failures.push("claude: the resume after the tool turn did not continue the tool session");
  }
  for (
    const [label, id] of [["session 1", ids.first], ["the tool session", ids.tool], [
      "the fork",
      ids.fork,
    ]]
  ) {
    const count = filesFor(files, id!, "claude").length;
    if (count !== 1) failures.push(`claude: ${label} has ${count} transcripts, expected 1`);
  }
  // Stable ids of a session's records: a user line's `uuid`, an assistant line's `message.id`
  // (a fork copies both verbatim).
  const recordIds = (id: string, only?: "assistant"): Set<string> => {
    const out = new Set<string>();
    for (const file of filesFor(files, id, "claude")) {
      for (const record of recordsByFile.get(file) ?? []) {
        if (record.type === "assistant" && isRecord(record.message)) {
          if (typeof record.message.id === "string") out.add(record.message.id);
        } else if (
          only === undefined && record.type === "user" && typeof record.uuid === "string"
        ) {
          out.add(record.uuid);
        }
      }
    }
    return out;
  };
  if (recordIds(ids.first, "assistant").size < 2) {
    failures.push("claude: session 1's transcript does not hold a second assistant message");
  }
  if (ids.fork === ids.first) failures.push("claude: the fork did not open a new session");
  else {
    const firstMessages = recordIds(ids.first);
    const forkMessages = recordIds(ids.fork);
    const wholeHistory = [...firstMessages].every((id) => forkMessages.has(id));
    const ownReply = [...recordIds(ids.fork, "assistant")].some((id) => !firstMessages.has(id));
    if (!wholeHistory || !ownReply) {
      failures.push(
        "claude: the fork's transcript does not carry session 1's history plus its own",
      );
    }
  }
  const toolUses = new Set<string>();
  const toolResults = new Set<string>();
  for (const file of filesFor(files, ids.tool, "claude")) {
    for (const record of recordsByFile.get(file) ?? []) {
      if (!isRecord(record.message) || !Array.isArray(record.message.content)) continue;
      for (const block of record.message.content) {
        if (!isRecord(block)) continue;
        if (block.type === "tool_use" && typeof block.id === "string") toolUses.add(block.id);
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          toolResults.add(block.tool_use_id);
        }
      }
    }
  }
  if (toolUses.size === 0) failures.push("claude: the tool turn holds no tool_use block");
  else if (![...toolUses].some((id) => toolResults.has(id))) {
    failures.push("claude: the tool turn's tool_use has no matching tool_result");
  }
  return failures;
}
