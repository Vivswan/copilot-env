// Codex: the provider config, the five scripted exec turns, and what its rollouts must show.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ledger, writeFile } from "./cli.ts";
import { registry, runTurn } from "./children.ts";
import type { MinuteStraddle } from "./fake.ts";
import { filesFor, isRecord } from "./transcripts.ts";

const CODEX_MODEL = "gpt-5.4";
/** The Codex provider table the fake is wired through; `model_provider` selects it. */
const CODEX_PROVIDER = "fake";

export interface CodexIds {
  first: string | null;
  resumed: string | null;
  tool: string | null;
  afterTool: string | null;
  fork: string | null;
}

/** The rollout uuid of a `--json` exec run (`thread.started`), or null. */
function codexThreadId(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    if (!line.includes("thread.started")) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed) && typeof parsed.thread_id === "string") return parsed.thread_id;
    } catch {
      // not JSON
    }
  }
  return null;
}

function codexConfigToml(baseUrl: string): string {
  return [
    `model = "${CODEX_MODEL}"`,
    `model_provider = "${CODEX_PROVIDER}"`,
    "",
    `[model_providers.${CODEX_PROVIDER}]`,
    `name = "${CODEX_PROVIDER}"`,
    `base_url = "${baseUrl}/v1"`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
  ].join("\n");
}

export async function recordCodex(
  home: string,
  work: string,
  baseUrl: string | null,
  straddle: MinuteStraddle,
  turnsDir: string,
  stop: (label: string) => void,
): Promise<CodexIds> {
  const ids: CodexIds = { first: null, resumed: null, tool: null, afterTool: null, fork: null };
  const codexHome = join(home, ".codex");
  mkdirSync(codexHome, { recursive: true });
  if (baseUrl !== null) {
    writeFile(join(codexHome, "config.toml"), codexConfigToml(baseUrl));
  } else {
    const auth = join(Deno.env.get("CODEX_HOME") ?? join(homedir(), ".codex"), "auth.json");
    if (existsSync(auth)) {
      copyFileSync(auth, join(codexHome, "auth.json"));
      ledger.written.push("home/.codex/auth.json");
    }
  }
  const extra = { CODEX_HOME: codexHome };
  // No -C (resume/fork lack it; the cwd is the spawn's); `-` reads the prompt from stdin; plugins
  // off because their marketplace sync spawns a background `git ls-remote` to github.com that
  // outlives the turn.
  const base = ["--disable", "plugins", "--skip-git-repo-check", "--json"];
  const turn = async (label: string, args: string[], prompt: string) => {
    const result = await runTurn(
      label,
      "codex",
      [...args, "-"],
      prompt,
      home,
      work,
      extra,
      baseUrl === null,
      turnsDir,
    );
    const id = result.ok ? codexThreadId(result.stdout) : null;
    if (result.stuck) {
      stop(`${label}: the CLI did not exit after the kill (${registry.lastKillError})`);
    }
    if (id === null) stop(`${label}: ${result.ok ? "no thread id in the result" : "failed"}`);
    return id;
  };

  ids.first = await turn(
    "codex turn 1",
    ["exec", ...base],
    "Reply with one short sentence about the weather.",
  );
  if (ids.first === null) return ids;
  await straddle.arm();
  ids.resumed = await turn(
    "codex turn 2 (resume)",
    ["exec", "resume", ...base, ids.first],
    "Now one sentence about the sea.",
  );
  if (ids.resumed === null) return ids;
  ids.tool = await turn(
    "codex turn 3 (tool)",
    ["exec", ...base],
    "Run one harmless shell tool call that echoes the word corpus, then stop.",
  );
  if (ids.tool === null) return ids;
  ids.afterTool = await turn(
    "codex turn 4 (resume after tool)",
    ["exec", "resume", ...base, ids.tool],
    "Summarize what the command printed in one sentence.",
  );
  if (ids.afterTool === null) return ids;
  ids.fork = await turn(
    "codex turn 5 (fork)",
    ["exec", "fork", ...base, ids.first],
    "One sentence about mountains.",
  );
  return ids;
}

/** What the Codex rollouts must show: the resume appended to session 1's rollout (same id, two
 *  token_count events), the tool turn holds a function_call AND its function_call_output, and
 *  the fork is a new rollout naming session 1 in `forked_from_id`. */
export function codexEvidenceFailures(
  ids: CodexIds,
  recordsByFile: Map<string, Record<string, unknown>[]>,
): string[] {
  const failures: string[] = [];
  const files = [...recordsByFile.keys()];
  if (
    ids.first === null || ids.resumed === null || ids.tool === null || ids.afterTool === null ||
    ids.fork === null
  ) {
    return ["codex: not every turn produced a thread id"];
  }
  if (ids.resumed !== ids.first) failures.push("codex: the resume did not continue session 1");
  if (ids.afterTool !== ids.tool) {
    failures.push("codex: the resume after the tool turn did not continue the tool session");
  }
  const firstFiles = filesFor(files, ids.first, "codex");
  for (
    const [label, id] of [["session 1", ids.first], ["the tool session", ids.tool], [
      "the fork",
      ids.fork,
    ]]
  ) {
    const count = filesFor(files, id!, "codex").length;
    if (count !== 1) failures.push(`codex: ${label} has ${count} rollouts, expected 1`);
  }
  let tokenCounts = 0;
  for (const file of firstFiles) {
    for (const record of recordsByFile.get(file) ?? []) {
      if (
        record.type === "event_msg" && isRecord(record.payload) &&
        record.payload.type === "token_count"
      ) tokenCounts++;
    }
  }
  if (tokenCounts < 2) {
    failures.push("codex: session 1's rollout does not hold the resumed turn's token_count");
  }
  const forkFiles = filesFor(files, ids.fork, "codex");
  const forkMeta = forkFiles.flatMap((file) => recordsByFile.get(file) ?? []).find(
    (record) => record.type === "session_meta",
  );
  if (
    ids.fork === ids.first || forkMeta === undefined || !isRecord(forkMeta.payload) ||
    forkMeta.payload.forked_from_id !== ids.first
  ) {
    failures.push("codex: the fork's rollout does not name session 1 in forked_from_id");
  }
  const calls = new Set<string>();
  const outputs = new Set<string>();
  for (const file of filesFor(files, ids.tool, "codex")) {
    for (const record of recordsByFile.get(file) ?? []) {
      if (record.type !== "response_item" || !isRecord(record.payload)) continue;
      const payload = record.payload;
      if (payload.type === "function_call" && typeof payload.call_id === "string") {
        calls.add(payload.call_id);
      }
      if (payload.type === "function_call_output" && typeof payload.call_id === "string") {
        outputs.add(payload.call_id);
      }
    }
  }
  if (calls.size === 0) failures.push("codex: the tool turn holds no function_call");
  else if (![...calls].some((id) => outputs.has(id))) {
    failures.push("codex: the tool turn's function_call has no function_call_output");
  }
  return failures;
}
