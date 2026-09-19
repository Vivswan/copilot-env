// Fixture lines spelled exactly the way the Codex and Claude CLIs write them, and the proxy's DB
// the way the daemon writes it.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RUN_DIR_NAME, SQLITE_DB_FILENAME } from "../../src/copilot_api/paths.ts";

// ---------- Codex ----------

/** A Codex TokenUsage object: input INCLUDES cached; output includes reasoning. */
export function codexUsage(input: number, cached: number, output: number): Record<string, number> {
  return {
    "input_tokens": input,
    "cached_input_tokens": cached,
    "output_tokens": output,
    "reasoning_output_tokens": 0,
    "total_tokens": input + output,
  };
}

export function rolloutLine(timestamp: string, type: string, payload: unknown): string {
  return JSON.stringify({ timestamp, type, payload });
}

export function sessionMeta(
  timestamp: string,
  id: string,
  opts: { provider?: string; forkedFrom?: string } = {},
): string {
  return rolloutLine(timestamp, "session_meta", {
    id,
    "session_id": id,
    timestamp,
    cwd: "/tmp",
    ...(opts.provider !== undefined ? { "model_provider": opts.provider } : {}),
    ...(opts.forkedFrom !== undefined ? { "forked_from_id": opts.forkedFrom } : {}),
  });
}

export function turnContext(timestamp: string, model: string): string {
  return rolloutLine(timestamp, "turn_context", { "turn_id": "t", model, cwd: "/tmp" });
}

export function tokenCount(
  timestamp: string,
  total: Record<string, number>,
  last: Record<string, number>,
): string {
  return rolloutLine(timestamp, "event_msg", {
    type: "token_count",
    info: { "total_token_usage": total, "last_token_usage": last, "model_context_window": 1000 },
    "rate_limits": null,
  });
}

export function writeRollout(dir: string, localDate: string, id: string, lines: string[]): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-${localDate}T01-00-00-${id}.jsonl`);
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

// ---------- Claude ----------

/** One assistant transcript line; Claude's input_tokens EXCLUDES the cache buckets. */
export function assistantLine(
  timestamp: string,
  model: string,
  id: string | undefined,
  usage: Record<string, unknown>,
): string {
  return JSON.stringify({
    type: "assistant",
    timestamp,
    uuid: "u",
    sessionId: "s",
    message: { ...(id === undefined ? {} : { id }), model, role: "assistant", usage },
  });
}

export function claudeUsage(
  input: number,
  output: number,
  cacheRead = 0,
  cacheCreation = 0,
): Record<string, unknown> {
  return {
    "input_tokens": input,
    "output_tokens": output,
    "cache_read_input_tokens": cacheRead,
    "cache_creation_input_tokens": cacheCreation,
  };
}

export function writeTranscript(dir: string, name: string, lines: string[]): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

// ---------- Proxy ----------

/** One `token_usage_events` row as the daemon writes it: `at` is the moment it recorded the
 *  response's usage, and the counts are already split into the four buckets. */
export interface ProxyRow {
  at: string;
  model: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreation?: number;
}

/** The daemon's DB at `<home>/.run/<host>/copilot-api.sqlite`, the columns `agent cost` reads. */
export function writeProxyDb(home: string, host: string, rows: ProxyRow[]): string {
  const dir = join(home, RUN_DIR_NAME, host);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, SQLITE_DB_FILENAME);
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE token_usage_events (
      model TEXT NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_input_tokens INTEGER,
      cache_creation_input_tokens INTEGER,
      created_at_ms INTEGER,
      created_at_utc TEXT
    )`);
    const insert = db.prepare("INSERT INTO token_usage_events VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const row of rows) {
      insert.run(
        row.model,
        row.input,
        row.output,
        row.cacheRead ?? 0,
        row.cacheCreation ?? 0,
        Date.parse(row.at),
        row.at,
      );
    }
  } finally {
    db.close();
  }
  return path;
}
