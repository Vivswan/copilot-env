// Fake inference backend on loopback (Anthropic Messages, OpenAI Responses, chat/completions),
// deterministic from a hash of the request body, so the real CLIs complete turns offline and
// write genuine session logs. Importable (`startInferenceFake`) or standalone (`{"port":N}`).
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";
const DEFAULT_OPENAI_MODEL = "gpt-5.4";

/** Tools whose invocation is harmless, in preference order, with the arguments to send. */
const PREFERRED_TOOLS = [
  { name: "Read", args: { "file_path": "corpus-note.txt" } },
  { name: "read_file", args: { "path": "corpus-note.txt" } },
  { name: "shell", args: { "command": ["echo", "corpus"] } },
  { name: "exec_command", args: { "cmd": "echo corpus" } },
  { name: "shell_command", args: { "command": "echo corpus" } },
];

/** Whole-word "tool", case-insensitive: the prompt-side trigger for a tool call. */
const TOOL_WORD = /\btool\b/i;
const TOOL_NAME_MARKER = /tool-name:\s*([A-Za-z0-9_.-]+)/;
const TOOL_ARGS_MARKER = /tool-args:\s*(\{[^\n]*\})/;

// ---------- deterministic derivation ----------

/** Everything a reply needs, derived from the raw body text: same body, same reply. */
function derive(body, toolCount) {
  const hex = createHash("sha256").update(body).digest("hex");
  const h32 = Number.parseInt(hex.slice(0, 8), 16);
  const inputTotal = Math.max(1, Math.floor(body.length / 4));
  // Small prompts are never cached; larger ones split into read/creation/uncached shares.
  const cacheRead = inputTotal > 1024 ? Math.floor((inputTotal * (25 + (h32 % 50))) / 100) : 0;
  const cacheCreation = inputTotal > 1024
    ? Math.floor(((inputTotal - cacheRead) * ((h32 >>> 8) % 40)) / 100)
    : 0;
  const output = 20 + (h32 % 181);
  return {
    hex,
    input: inputTotal - cacheRead - cacheCreation,
    cacheRead,
    cacheCreation,
    output,
    // OpenAI's output_tokens INCLUDES the reasoning tokens, so this stays below it.
    reasoning: Math.min(output - 1, (h32 >>> 16) % 40),
    createdAt: 1_700_000_000 + (h32 % 100_000_000),
    text: `Corpus reply ${hex.slice(0, 8)}: the fake backend answered deterministically` +
      ` (${toolCount} tools offered).`,
  };
}

/** Text streamed as three deltas, so the stream has real intermediate events. */
function splitText(text) {
  const third = Math.ceil(text.length / 3);
  return [text.slice(0, third), text.slice(third, 2 * third), text.slice(2 * third)];
}

// ---------- request inspection ----------

/** @param {unknown} value */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The prompt text of a content value: the string itself, or the LAST text block (Claude Code
 *  prepends reminder blocks that talk about tools; the typed prompt is the final block). */
function promptTextOf(content, textTypes) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts = content.filter((block) => isRecord(block) && textTypes.includes(block.type));
  const last = texts[texts.length - 1];
  return last === undefined ? "" : String(last.text ?? "");
}

/** Anthropic Messages: the last user message's text, and whether it is a tool result (those
 *  travel as user-role `tool_result` blocks). */
function anthropicLastUser(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isRecord(message) || message.role !== "user") continue;
    const content = message.content;
    const isToolResult = Array.isArray(content) &&
      content.some((block) => isRecord(block) && block.type === "tool_result");
    return { text: promptTextOf(content, ["text"]), isToolResult };
  }
  return { text: "", isToolResult: false };
}

/** OpenAI Responses: the last input item's text, and whether it is a tool output. */
function responsesLastUser(body) {
  const input = body.input;
  if (typeof input === "string") return { text: input, isToolResult: false };
  const items = Array.isArray(input) ? input : [];
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!isRecord(item)) continue;
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      return { text: "", isToolResult: true };
    }
    if (item.role === "user") {
      return { text: promptTextOf(item.content, ["input_text", "text"]), isToolResult: false };
    }
  }
  return { text: "", isToolResult: false };
}

/** Callable tools as `{name, schema}`: Anthropic `input_schema` or Responses `parameters`. */
function callableTools(body) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const out = [];
  for (const tool of tools) {
    if (!isRecord(tool) || typeof tool.name !== "string") continue;
    const schema = isRecord(tool.input_schema)
      ? tool.input_schema
      : isRecord(tool.parameters)
      ? tool.parameters
      : null;
    if (schema === null && tool.type !== undefined && tool.type !== "function") continue;
    out.push({ name: tool.name, schema: schema ?? {} });
  }
  return out;
}

/** Arguments satisfying a JSON schema's `required` list with placeholder values. */
function fillFromSchema(schema) {
  const args = {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const key of required) {
    if (typeof key !== "string") continue;
    const property = properties[key];
    const type = isRecord(property) ? property.type : undefined;
    if (type === "number" || type === "integer") args[key] = 1;
    else if (type === "boolean") args[key] = false;
    else if (type === "array") args[key] = [];
    else if (type === "object") args[key] = {};
    else args[key] = "corpus";
  }
  return args;
}

/** The tool call the request asks for (tools offered AND the whole word "tool" in the last user
 *  text), or null. `tool-name:`/`tool-args:` markers pin it; else the first preferred tool
 *  offered, else the first tool offered. */
function selectToolCall(text, tools) {
  if (tools.length === 0 || !TOOL_WORD.test(text)) return null;
  const pinnedName = TOOL_NAME_MARKER.exec(text)?.[1];
  const pinnedArgsText = TOOL_ARGS_MARKER.exec(text)?.[1];
  let pinnedArgs = null;
  if (pinnedArgsText !== undefined) {
    try {
      const parsed = JSON.parse(pinnedArgsText);
      if (isRecord(parsed)) pinnedArgs = parsed;
    } catch {
      // not JSON: fall through to the schema fill
    }
  }
  const pinned = pinnedName === undefined ? undefined : tools.find((t) => t.name === pinnedName);
  if (pinned !== undefined) {
    return { name: pinned.name, args: pinnedArgs ?? fillFromSchema(pinned.schema) };
  }
  for (const preferred of PREFERRED_TOOLS) {
    if (tools.some((t) => t.name === preferred.name)) {
      return { name: preferred.name, args: pinnedArgs ?? preferred.args };
    }
  }
  const first = tools[0];
  return { name: first.name, args: pinnedArgs ?? fillFromSchema(first.schema) };
}

// ---------- response writers ----------

/** @param {import("node:http").ServerResponse} res */
function json(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

function apiError(res, status, type, message) {
  json(res, status, { "type": "error", "error": { "type": type, "message": message } });
}

/** @param {import("node:http").ServerResponse} res */
function openSse(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "connection": "keep-alive",
  });
  return {
    /** Named event (Anthropic and Responses both name theirs). */
    event(name, data) {
      res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    /** Bare data line (chat completions). */
    data(text) {
      res.write(`data: ${text}\n\n`);
    },
    end() {
      res.end();
    },
  };
}

// ---------- Anthropic Messages ----------

/** The `usage` of a message (message_start and the non-stream reply). */
function anthropicUsage(d, outputTokens) {
  return {
    "input_tokens": d.input,
    "cache_creation_input_tokens": d.cacheCreation,
    "cache_read_input_tokens": d.cacheRead,
    "cache_creation": {
      "ephemeral_5m_input_tokens": d.cacheCreation,
      "ephemeral_1h_input_tokens": 0,
    },
    "output_tokens": outputTokens,
    "server_tool_use": null,
    "service_tier": "standard",
  };
}

/** The cumulative `usage` of message_delta: the four counters plus server tool use only. */
function anthropicDeltaUsage(d) {
  return {
    "input_tokens": d.input,
    "cache_creation_input_tokens": d.cacheCreation,
    "cache_read_input_tokens": d.cacheRead,
    "output_tokens": d.output,
    "server_tool_use": null,
  };
}

function anthropicBlocks(d, toolCall) {
  const blocks = [{ "type": "text", "text": d.text, "citations": null }];
  if (toolCall !== null) {
    blocks.push({
      "type": "tool_use",
      "id": `toolu_${d.hex.slice(24, 48)}`,
      "name": toolCall.name,
      "input": toolCall.args,
    });
  }
  return blocks;
}

function handleMessages(body, rawBody, res) {
  const tools = callableTools(body);
  const d = derive(rawBody, tools.length);
  const model = typeof body.model === "string" ? body.model : DEFAULT_ANTHROPIC_MODEL;
  const lastUser = anthropicLastUser(body);
  const toolCall = lastUser.isToolResult ? null : selectToolCall(lastUser.text, tools);
  const stopReason = toolCall === null ? "end_turn" : "tool_use";
  const id = `msg_${d.hex.slice(0, 24)}`;
  const blocks = anthropicBlocks(d, toolCall);

  if (body.stream !== true) {
    json(res, 200, {
      "id": id,
      "type": "message",
      "role": "assistant",
      "model": model,
      "content": blocks,
      "stop_reason": stopReason,
      "stop_sequence": null,
      "usage": anthropicUsage(d, d.output),
      "container": null,
    });
    return { stream: false, d, model, toolCall };
  }

  const sse = openSse(res);
  sse.event("message_start", {
    "type": "message_start",
    "message": {
      "id": id,
      "type": "message",
      "role": "assistant",
      "model": model,
      "content": [],
      "stop_reason": null,
      "stop_sequence": null,
      // The start snapshot books the input side; output_tokens is the 1-token placeholder
      // the real API sends here, and message_delta carries the final count.
      "usage": anthropicUsage(d, 1),
      "container": null,
    },
  });
  sse.event("content_block_start", {
    "type": "content_block_start",
    "index": 0,
    "content_block": { "type": "text", "text": "", "citations": null },
  });
  sse.event("ping", { "type": "ping" });
  for (const piece of splitText(d.text)) {
    sse.event("content_block_delta", {
      "type": "content_block_delta",
      "index": 0,
      "delta": { "type": "text_delta", "text": piece },
    });
  }
  sse.event("content_block_stop", { "type": "content_block_stop", "index": 0 });
  if (toolCall !== null) {
    const toolBlock = blocks[1];
    sse.event("content_block_start", {
      "type": "content_block_start",
      "index": 1,
      "content_block": { ...toolBlock, "input": {} },
    });
    sse.event("content_block_delta", {
      "type": "content_block_delta",
      "index": 1,
      "delta": { "type": "input_json_delta", "partial_json": JSON.stringify(toolCall.args) },
    });
    sse.event("content_block_stop", { "type": "content_block_stop", "index": 1 });
  }
  sse.event("message_delta", {
    "type": "message_delta",
    "delta": { "stop_reason": stopReason, "stop_sequence": null },
    "usage": anthropicDeltaUsage(d),
  });
  sse.event("message_stop", { "type": "message_stop" });
  sse.end();
  return { stream: true, d, model, toolCall };
}

// ---------- OpenAI Responses ----------

/** OpenAI has no cache-write bucket, so the creation share counts as uncached input. */
function openaiInputTokens(d) {
  return d.input + d.cacheCreation + d.cacheRead;
}

function responsesUsage(d) {
  return {
    "input_tokens": openaiInputTokens(d),
    "input_tokens_details": { "cached_tokens": d.cacheRead },
    "output_tokens": d.output,
    "output_tokens_details": { "reasoning_tokens": d.reasoning },
    "total_tokens": openaiInputTokens(d) + d.output,
  };
}

function responsesItems(d, toolCall) {
  const items = [{
    "id": `msg_${d.hex.slice(24, 48)}`,
    "type": "message",
    "status": "completed",
    "role": "assistant",
    "content": [{ "type": "output_text", "text": d.text, "annotations": [], "logprobs": [] }],
  }];
  if (toolCall !== null) {
    items.push({
      "id": `fc_${d.hex.slice(8, 32)}`,
      "type": "function_call",
      "status": "completed",
      "arguments": JSON.stringify(toolCall.args),
      "call_id": `call_${d.hex.slice(32, 56)}`,
      "name": toolCall.name,
    });
  }
  return items;
}

function responseObject(d, model, status, output, usage) {
  return {
    "id": `resp_${d.hex.slice(0, 24)}`,
    "object": "response",
    "created_at": d.createdAt,
    "status": status,
    "model": model,
    "output": output,
    "usage": usage,
  };
}

function handleResponses(body, rawBody, res) {
  const tools = callableTools(body);
  const d = derive(rawBody, tools.length);
  const model = typeof body.model === "string" ? body.model : DEFAULT_OPENAI_MODEL;
  const lastUser = responsesLastUser(body);
  const toolCall = lastUser.isToolResult ? null : selectToolCall(lastUser.text, tools);
  const items = responsesItems(d, toolCall);
  const usage = responsesUsage(d);

  if (body.stream !== true) {
    json(res, 200, responseObject(d, model, "completed", items, usage));
    return { stream: false, d, model, toolCall };
  }

  const sse = openSse(res);
  let seq = 0;
  const emit = (type, fields) =>
    sse.event(type, { "type": type, "sequence_number": seq++, ...fields });
  emit("response.created", { "response": responseObject(d, model, "in_progress", [], null) });
  emit("response.in_progress", { "response": responseObject(d, model, "in_progress", [], null) });

  const message = items[0];
  emit("response.output_item.added", {
    "output_index": 0,
    "item": { ...message, "status": "in_progress", "content": [] },
  });
  emit("response.content_part.added", {
    "item_id": message.id,
    "output_index": 0,
    "content_index": 0,
    "part": { "type": "output_text", "text": "", "annotations": [], "logprobs": [] },
  });
  for (const piece of splitText(d.text)) {
    emit("response.output_text.delta", {
      "item_id": message.id,
      "output_index": 0,
      "content_index": 0,
      "delta": piece,
      "logprobs": [],
    });
  }
  emit("response.output_text.done", {
    "item_id": message.id,
    "output_index": 0,
    "content_index": 0,
    "text": d.text,
    "logprobs": [],
  });
  emit("response.content_part.done", {
    "item_id": message.id,
    "output_index": 0,
    "content_index": 0,
    "part": message.content[0],
  });
  emit("response.output_item.done", { "output_index": 0, "item": message });

  if (toolCall !== null) {
    const call = items[1];
    emit("response.output_item.added", {
      "output_index": 1,
      "item": { ...call, "status": "in_progress", "arguments": "" },
    });
    emit("response.function_call_arguments.delta", {
      "item_id": call.id,
      "output_index": 1,
      "delta": call.arguments,
    });
    emit("response.function_call_arguments.done", {
      "item_id": call.id,
      "output_index": 1,
      "name": call.name,
      "arguments": call.arguments,
    });
    emit("response.output_item.done", { "output_index": 1, "item": call });
  }

  emit("response.completed", { "response": responseObject(d, model, "completed", items, usage) });
  sse.end();
  return { stream: true, d, model, toolCall };
}

// ---------- OpenAI chat completions (fallback only) ----------

function handleChatCompletions(body, rawBody, res) {
  const d = derive(rawBody, 0);
  const model = typeof body.model === "string" ? body.model : DEFAULT_OPENAI_MODEL;
  const id = `chatcmpl-${d.hex.slice(0, 24)}`;
  const usage = {
    "prompt_tokens": openaiInputTokens(d),
    "completion_tokens": d.output,
    "total_tokens": openaiInputTokens(d) + d.output,
    "prompt_tokens_details": { "cached_tokens": d.cacheRead },
    "completion_tokens_details": { "reasoning_tokens": d.reasoning },
  };
  if (body.stream !== true) {
    json(res, 200, {
      "id": id,
      "object": "chat.completion",
      "created": d.createdAt,
      "model": model,
      "choices": [{
        "index": 0,
        "message": { "role": "assistant", "content": d.text },
        "finish_reason": "stop",
      }],
      "usage": usage,
    });
    return { stream: false, d, model, toolCall: null };
  }
  const sse = openSse(res);
  // Usage streams only on request: `usage: null` on every chunk, then one final chunk carrying
  // it with no choices.
  const includeUsage = isRecord(body.stream_options) && body.stream_options.include_usage === true;
  const chunk = (choices, chunkUsage) =>
    sse.data(JSON.stringify({
      "id": id,
      "object": "chat.completion.chunk",
      "created": d.createdAt,
      "model": model,
      "choices": choices,
      ...includeUsage ? { "usage": chunkUsage } : {},
    }));
  const choice = (
    delta,
    finishReason,
  ) => [{ "index": 0, "delta": delta, "finish_reason": finishReason }];
  chunk(choice({ "role": "assistant", "content": "" }, null), null);
  for (const piece of splitText(d.text)) chunk(choice({ "content": piece }, null), null);
  chunk(choice({}, "stop"), null);
  if (includeUsage) chunk([], usage);
  sse.data("[DONE]");
  sse.end();
  return { stream: true, d, model, toolCall: null };
}

// ---------- catalog ----------

const ANTHROPIC_MODELS = [
  [DEFAULT_ANTHROPIC_MODEL, "Claude Sonnet 4.6"],
  ["claude-opus-4-6", "Claude Opus 4.6"],
  ["claude-haiku-4-5-20251001", "Claude Haiku 4.5"],
];
const OPENAI_MODELS = [DEFAULT_OPENAI_MODEL, "gpt-5.4-mini"];

/** An Anthropic client identifies itself by these headers; an OpenAI client sends neither. */
function isAnthropicClient(req) {
  return req.headers["anthropic-version"] !== undefined || req.headers["x-api-key"] !== undefined;
}

/** The catalog in the asking client's own list schema. */
function catalog(req) {
  if (isAnthropicClient(req)) {
    return {
      "data": ANTHROPIC_MODELS.map(([id, displayName]) => ({
        "type": "model",
        "id": id,
        "display_name": displayName,
        "created_at": "2023-11-14T22:13:20Z",
      })),
      "has_more": false,
      "first_id": ANTHROPIC_MODELS[0][0],
      "last_id": ANTHROPIC_MODELS[ANTHROPIC_MODELS.length - 1][0],
    };
  }
  return {
    "object": "list",
    "data": OPENAI_MODELS.map((id) => ({
      "id": id,
      "object": "model",
      "created": 1_700_000_000,
      "owned_by": "openai",
    })),
  };
}

// ---------- server ----------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** `/v1/<x>` and `/<x>` are the same route: clients differ on whether the base URL carries `/v1`. */
function route(url) {
  const path = url.split("?")[0].replace(/^\/v1(?=\/)/, "");
  return path;
}

/** Handle one request: catalog, the three inference routes, 404 for everything else. */
async function handle(req, res, log, hooks) {
  const method = req.method ?? "GET";
  const path = route(req.url ?? "/");
  if (method === "GET" && path === "/models") {
    json(res, 200, catalog(req));
    log(`GET ${req.url} 200 catalog`);
    return;
  }
  // Claude Code's reachability probe of a custom base URL: only the status matters.
  if ((method === "HEAD" || method === "GET") && path === "/api/hello") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(method === "HEAD" ? undefined : "{}");
    log(`${method} ${req.url} 200 hello`);
    return;
  }
  if (method !== "POST") {
    json(res, 404, {
      "type": "error",
      "error": { "type": "not_found_error", "message": "Not found" },
    });
    log(`${method} ${req.url} 404`);
    return;
  }
  const rawBody = await readBody(req);
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    apiError(res, 400, "invalid_request_error", "body is not JSON");
    log(`POST ${req.url} 400 invalid json`);
    return;
  }
  if (!isRecord(body)) {
    apiError(res, 400, "invalid_request_error", "body is not an object");
    log(`POST ${req.url} 400 not an object`);
    return;
  }
  const isInference = path === "/messages" || path === "/responses" ||
    path === "/chat/completions";
  if (isInference && hooks.beforeReply !== undefined) await hooks.beforeReply(path);
  let result;
  if (path === "/messages") result = handleMessages(body, rawBody, res);
  else if (path === "/messages/count_tokens") {
    const d = derive(rawBody, 0);
    json(res, 200, { "input_tokens": d.input + d.cacheRead + d.cacheCreation });
    log(`POST ${req.url} 200 count_tokens`);
    return;
  } else if (path === "/responses") result = handleResponses(body, rawBody, res);
  else if (path === "/chat/completions") result = handleChatCompletions(body, rawBody, res);
  else {
    json(res, 404, {
      "type": "error",
      "error": { "type": "not_found_error", "message": "Not found" },
    });
    log(`POST ${req.url} 404`);
    return;
  }
  const { d, model, stream, toolCall } = result;
  const buckets = path === "/messages"
    ? `in=${d.input} cache_read=${d.cacheRead} cache_creation=${d.cacheCreation}`
    : `in=${openaiInputTokens(d) - d.cacheRead} cache_read=${d.cacheRead}`;
  log(
    `POST ${req.url} 200 ${stream ? "stream" : "json"} model=${model} ${buckets}` +
      ` out=${d.output} tool=${toolCall === null ? "none" : toolCall.name}`,
  );
  hooks.onRequest?.({
    path,
    model,
    stream,
    tool: toolCall === null ? null : toolCall.name,
    usage: {
      input: d.input,
      cacheRead: d.cacheRead,
      cacheCreation: d.cacheCreation,
      output: d.output,
    },
  });
}

/** `beforeReply` is awaited before an inference route replies (timing only); `onRequest` is called
 *  once per answered inference request.
 *  @typedef {{beforeReply?: (path: string) => Promise<void>, onRequest?: (request: {path: string, model: string, stream: boolean, tool: string | null, usage: {input: number, cacheRead: number, cacheCreation: number, output: number}}) => void}} InferenceFakeHooks */

/** Start the fake on 127.0.0.1:`port` (0 = any free port); resolves once listening.
 *  @param {number} port @param {(line: string) => void} [log] @param {InferenceFakeHooks} [hooks]
 *  @returns {Promise<{port: number, baseUrl: string, close: () => Promise<void>}>} */
export function startInferenceFake(
  port,
  log = (line) => console.error(`[inference-fake] ${line}`),
  hooks = {},
) {
  const server = createServer((req, res) => {
    // No Date header: the reply bytes are a function of the request alone.
    res.sendDate = false;
    handle(req, res, log, hooks).catch((e) => {
      log(`${req.method} ${req.url} 500 ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) apiError(res, 500, "api_error", "internal error");
      else res.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const bound = typeof address === "object" && address !== null ? address.port : port;
      resolve({
        port: bound,
        baseUrl: `http://127.0.0.1:${bound}`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

/** Whether this module is the process entrypoint (Node and Deno both fill argv[1]). */
function isMain() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const portIdx = process.argv.indexOf("--port");
  const requested = portIdx !== -1
    ? Number(process.argv[portIdx + 1])
    : Number(process.env.INFERENCE_FAKE_PORT ?? "0");
  const { port } = await startInferenceFake(Number.isFinite(requested) ? requested : 0);
  console.log(JSON.stringify({ "port": port }));
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
}
