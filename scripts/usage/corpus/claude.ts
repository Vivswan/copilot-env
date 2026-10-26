// Claude: the five scripted print-mode turns, and what its transcripts must show afterwards.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRecord, parseJsonRecord } from "../../../src/utils/json.ts";
import { registry, runTurn } from "./children.ts";
import { ledger } from "./cli.ts";
import type { MinuteStraddle } from "./fake.ts";
import { filesFor, type RecordsByFile, sessionRecords } from "./transcripts.ts";

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
  const parsed = parseJsonRecord(stdout);
  return parsed !== null && typeof parsed.session_id === "string" ? parsed.session_id : null;
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
  if (baseUrl === null) {
    // --real: a file-backed login lives in the (possibly overridden) config dir, so carry it
    // into the throwaway one.
    const credentials = join(
      process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
      ".credentials.json",
    );
    if (existsSync(credentials)) {
      mkdirSync(claudeHome, { recursive: true });
      copyFileSync(credentials, join(claudeHome, ".credentials.json"));
      ledger.written.push("home/.claude/.credentials.json");
    }
  } else {
    extra.ANTHROPIC_BASE_URL = baseUrl;
    // A bearer token: an API key needs an interactive approval that print mode reports as
    // "Not logged in", while a token is accepted as-is.
    extra.ANTHROPIC_AUTH_TOKEN = "corpus-fake-token";
  }
  // The prompt is the positional argument (runTurn appends it): print mode takes it verbatim.
  const base = ["-p", "--output-format", "json", "--model", CLAUDE_MODEL];
  const turn = async (label: string, args: string[], prompt: string) => {
    const result = await runTurn({
      label,
      command: "claude",
      args: [...base, ...args],
      prompt,
      home,
      cwd: work,
      extraEnv: extra,
      real: baseUrl === null,
      turnsDir,
    });
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
  // Read inside the cwd needs no permission grant in print mode, so no tool allowlist. The pinned
  // arguments travel base64-encoded: a positional prompt through npm's PowerShell shim on Windows
  // PowerShell 5.1 loses embedded double quotes, and the JSON would arrive unparsable.
  ids.tool = await turn(
    "claude turn 3 (tool)",
    [],
    `Use the Read tool on the note. tool-name: Read tool-args64: ${Buffer.from(
      JSON.stringify({ file_path: join(work, "corpus-note.txt") }),
    ).toString("base64")}`,
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

/** The stable id of one record, or null: a user line's `uuid`, an assistant line's `message.id`
 *  (a fork copies both verbatim); under `only`, an assistant line's alone. */
function claudeRecordId(record: Record<string, unknown>, only?: "assistant"): string | null {
  if (record.type === "assistant") {
    if (!isRecord(record.message) || typeof record.message.id !== "string") return null;
    return record.message.id;
  }
  if (only !== undefined || record.type !== "user") return null;
  return typeof record.uuid === "string" ? record.uuid : null;
}

function claudeRecordIds(
  recordsByFile: RecordsByFile,
  id: string,
  only?: "assistant",
): Set<string> {
  const out = new Set<string>();
  for (const record of sessionRecords(recordsByFile, id, "claude")) {
    const recordId = claudeRecordId(record, only);
    if (recordId !== null) out.add(recordId);
  }
  return out;
}

/** The fork is a new session carrying EVERY record of session 1 plus its own reply. */
function claudeForkFailures(recordsByFile: RecordsByFile, first: string, fork: string): string[] {
  if (fork === first) return ["claude: the fork did not open a new session"];
  const firstMessages = claudeRecordIds(recordsByFile, first);
  const forkMessages = claudeRecordIds(recordsByFile, fork);
  const wholeHistory = [...firstMessages].every((id) => forkMessages.has(id));
  const forkReplies = claudeRecordIds(recordsByFile, fork, "assistant");
  const ownReply = [...forkReplies].some((id) => !firstMessages.has(id));
  if (wholeHistory && ownReply) return [];
  return ["claude: the fork's transcript does not carry session 1's history plus its own"];
}

/** The content blocks of a record's message; none when it carries no array content. */
function contentBlocks(record: Record<string, unknown>): Record<string, unknown>[] {
  if (!isRecord(record.message) || !Array.isArray(record.message.content)) return [];
  return record.message.content.filter(isRecord);
}

/** The tool turn holds a tool_use AND its tool_result. */
function claudeToolFailures(recordsByFile: RecordsByFile, tool: string): string[] {
  const toolUses = new Set<string>();
  const toolResults = new Set<string>();
  for (const block of sessionRecords(recordsByFile, tool, "claude").flatMap(contentBlocks)) {
    if (block.type === "tool_use" && typeof block.id === "string") toolUses.add(block.id);
    if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      toolResults.add(block.tool_use_id);
    }
  }
  if (toolUses.size === 0) return ["claude: the tool turn holds no tool_use block"];
  if ([...toolUses].some((id) => toolResults.has(id))) return [];
  return ["claude: the tool turn's tool_use has no matching tool_result"];
}

/** What the Claude transcripts must show: both resumes continued their sessions (same ids, a
 *  second assistant message in session 1's file), the tool turn holds a tool_use AND its
 *  tool_result, and the fork is a new session carrying EVERY record of session 1 plus its own. */
export function claudeEvidenceFailures(ids: ClaudeIds, recordsByFile: RecordsByFile): string[] {
  const failures: string[] = [];
  const files = [...recordsByFile.keys()];
  if (
    ids.first === null ||
    ids.resumed === null ||
    ids.tool === null ||
    ids.afterTool === null ||
    ids.fork === null
  ) {
    return ["claude: not every turn produced a session id"];
  }
  if (ids.resumed !== ids.first) failures.push("claude: the resume did not continue session 1");
  if (ids.afterTool !== ids.tool) {
    failures.push("claude: the resume after the tool turn did not continue the tool session");
  }
  const sessions: [label: string, id: string][] = [
    ["session 1", ids.first],
    ["the tool session", ids.tool],
    ["the fork", ids.fork],
  ];
  for (const [label, id] of sessions) {
    const count = filesFor(files, id, "claude").length;
    if (count !== 1) failures.push(`claude: ${label} has ${count} transcripts, expected 1`);
  }
  if (claudeRecordIds(recordsByFile, ids.first, "assistant").size < 2) {
    failures.push("claude: session 1's transcript does not hold a second assistant message");
  }
  failures.push(...claudeForkFailures(recordsByFile, ids.first, ids.fork));
  failures.push(...claudeToolFailures(recordsByFile, ids.tool));
  return failures;
}
