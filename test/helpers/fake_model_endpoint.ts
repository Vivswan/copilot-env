// The fake model endpoint the REAL claude and codex CLIs (and our own Direct smoke,
// src/copilot_api/endpoint_smoke.ts) run against with no network and no credential: aimock
// (npm:@copilotkit/aimock, pinned in deno.json; zero runtime deps, MIT) behind a thin front.
//
// Hand-rolling the SSE emitter was weighed and dropped: aimock's Anthropic and OpenAI shapes are
// validated daily against the real vendors by its own drift job (.github/workflows/test-drift.yml
// in CopilotKit/aimock), which is a better fidelity anchor than SDK types alone. The front exists
// for the ONE route aimock lacks in Copilot's shape: Copilot serves its catalog at the ROOT
// `/models` with picker fields (capabilities.limits, model_picker_enabled, supported_endpoints)
// that both smoke pickers read, while aimock serves `/v1/models` as a plain OpenAI list.
// Everything else is proxied to aimock byte for byte, streams included.
//
// WIRES, as the CLIs and the smoke send them
//   GET  /models                    -> the front: Copilot's catalog (CATALOG below)
//   GET  /v1/models                 -> aimock: its own plain OpenAI list
//   POST /v1/messages               -> aimock: Anthropic Messages, SSE when the body says stream
//   POST /responses, /v1/responses  -> aimock: OpenAI Responses (Codex's wire, no /v1 on Copilot)
//   POST /v1/chat/completions       -> aimock: OpenAI chat completions
//   HEAD /api/hello                 -> aimock 404; Claude Code probes it and proceeds regardless
//   POST /v1/messages/count_tokens  -> aimock 404; claude never calls it in --print mode
//
// SCENARIOS select one request's reply through the header aimock matches EXACTLY,
// `X-AIMock-Context: <name>` (SCENARIO_HEADER): claude forwards it from ANTHROPIC_CUSTOM_HEADERS,
// codex from model_providers.<id>.http_headers. Each name is one fixture in the file this module
// writes per start; context fixtures come FIRST because aimock serves the first match and a
// fixture without a context matches every request (the default reply, last).
//   text      the reply text, optional usage override
//   error     a status with the wire's own error envelope (Anthropic's drops `code`)
//   truncate  aimock cuts the socket once `afterFrames` SSE frames are due, counted from the FIRST
//             frame (the prelude included): `truncateAfterChunks: N` delivers N - 1 frames, so a
//             cut after the first delta counts the request's whole prelude (a codex request with
//             `include: ["reasoning.encrypted_content"]` gets a 2-frame reasoning item first)
// Every streaming fixture carries `latency >= 1`: at 0 aimock's truncation delivers zero bytes.
//
// JOURNAL: `journal()` merges aimock's `GET /__aimock/journal` (method, path, headers, parsed
// body, status) with the front's own entries for the catalog route. aimock REDACTS credential
// header values (`authorization`, `x-api-key` read "[REDACTED]"), so a test asserts their
// presence there and their value only on a catalog entry, which the front journals in full.
import { writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, request as httpRequest } from "node:http";
import { join } from "node:path";
import { isRecord } from "../../src/utils/json.ts";
import { denoRunArgs, ROOT, spawnChild } from "./run.ts";

/** The header aimock matches a fixture's `context` against, exact string match. */
export const SCENARIO_HEADER = "X-AIMock-Context";
/** What a request with no matching scenario gets. */
const DEFAULT_REPLY = "The fake model endpoint answered.";
/** A hang or a pace can never exceed this, so a leaked scenario cannot wedge the run. */
const MAX_LATENCY_MS = 10_000;
const START_TIMEOUT_MS = 60_000;
const JOURNAL_TIMEOUT_MS = 10_000;

/** Inherited variables a child needs to run at all; everything else stays out (the allowlist
 *  scripts/usage_corpus applies), so a developer shell's own agent variables, wrapper hooks,
 *  NODE_OPTIONS or an AIMOCK_* override cannot steer aimock or a CLI under test. */
const BASE_ENV_KEYS = [
  "PATH",
  "HOME",
  "TZ",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "USERNAME",
];

/** A complete child env: the allowlist above from this process, then `extra` over it. Every
 *  child (aimock, the CLIs) is a deno or node process that would otherwise ask dl.deno.land for
 *  its latest release on start; DENO_NO_UPDATE_CHECK is forced so the fake stays offline. */
export function hermeticEnv(extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && BASE_ENV_KEYS.includes(key.toUpperCase())) out[key] = value;
  }
  return { ...out, DENO_NO_UPDATE_CHECK: "1", ...extra };
}

type ScenarioSpec =
  | { kind: "text"; text: string; usage?: { input: number; output: number } }
  | { kind: "error"; status: number; type: string; message: string; code?: string }
  | { kind: "truncate"; text: string; afterFrames: number };

/** Scenario name (the header value) to what it produces. */
export type Scenarios = Record<string, ScenarioSpec>;

/** The aimock fixture file for a scenario table: context fixtures first, the default last. */
function fixtureFile(scenarios: Scenarios): { fixtures: Record<string, unknown>[] } {
  const fixtures: Record<string, unknown>[] = [];
  for (const [context, spec] of Object.entries(scenarios)) {
    const match = { "context": context };
    switch (spec.kind) {
      case "text":
        fixtures.push({
          match,
          "response": {
            "content": spec.text,
            ...(spec.usage === undefined ? {} : {
              "usage": { "input_tokens": spec.usage.input, "output_tokens": spec.usage.output },
            }),
          },
          "latency": 1,
        });
        break;
      case "error":
        fixtures.push({
          match,
          "response": {
            "status": spec.status,
            "error": {
              "type": spec.type,
              "message": spec.message,
              ...(spec.code === undefined ? {} : { "code": spec.code }),
            },
          },
        });
        break;
      case "truncate":
        fixtures.push({
          match,
          "response": { "content": spec.text },
          "latency": Math.min(20, MAX_LATENCY_MS),
          "chunkSize": 5,
          "truncateAfterChunks": spec.afterFrames,
        });
        break;
    }
  }
  fixtures.push({ "match": {}, "response": { "content": DEFAULT_REPLY }, "latency": 1 });
  return { fixtures };
}

/** Copilot's `/models` entries: one id per family both smokes can pick (cheapestClaudeModel
 *  takes the haiku, CODEX_ENDPOINT_SMOKE the reduced gpt), with the picker fields the catalog
 *  parsers read (src/codex/catalog.ts, src/copilot_api/models.ts). */
const CATALOG: readonly {
  id: string;
  name: string;
  vendor: string;
  endpoints: string[];
  window: number;
  prompt: number;
  output: number;
}[] = [
  {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    vendor: "Anthropic",
    endpoints: ["/v1/messages"],
    window: 200_000,
    prompt: 128_000,
    output: 64_000,
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    vendor: "Anthropic",
    endpoints: ["/v1/messages"],
    window: 200_000,
    prompt: 128_000,
    output: 64_000,
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    vendor: "OpenAI",
    endpoints: ["/responses", "/chat/completions"],
    window: 400_000,
    prompt: 272_000,
    output: 128_000,
  },
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 mini",
    vendor: "OpenAI",
    endpoints: ["/responses", "/chat/completions"],
    window: 400_000,
    prompt: 272_000,
    output: 128_000,
  },
];

function catalogBody(): unknown {
  return {
    "object": "list",
    "data": CATALOG.map((m) => ({
      "id": m.id,
      "object": "model",
      "created": 1_700_000_000,
      "owned_by": m.vendor.toLowerCase(),
      "name": m.name,
      "vendor": m.vendor,
      "version": m.id,
      "preview": false,
      "model_picker_enabled": true,
      "supported_endpoints": m.endpoints,
      "capabilities": {
        "type": "chat",
        "family": m.id,
        "limits": {
          "max_context_window_tokens": m.window,
          "max_prompt_tokens": m.prompt,
          "max_output_tokens": m.output,
        },
        "supports": { "streaming": true, "tool_calls": true, "parallel_tool_calls": true },
      },
    })),
  };
}

type Route = "models" | "messages" | "responses" | "chat";

/** One request the fake answered, in one shape whichever side journaled it. */
interface FakeRequest {
  method: string;
  /** As received, query included. */
  path: string;
  headers: Record<string, string>;
  /** The parsed body (aimock adds `_endpointType` and `_context`), or null. */
  body: unknown;
  status: number;
  /** aimock cut the stream (a truncate scenario). */
  interrupted: boolean;
}

export interface FakeModelEndpoint {
  baseUrl: string;
  /** aimock's own listener behind the front (the front is this process's), so a test can see
   *  aimock serve, or stop serving, from outside the process that started it. */
  aimockUrl: string;
  /** aimock's process, for that test's cleanup. */
  pid: number;
  journal(): Promise<FakeRequest[]>;
  lastRequest(route: Route): Promise<FakeRequest | null>;
  close(): Promise<void>;
}

function isRoute(route: Route, path: string): boolean {
  const bare = path.split("?")[0] ?? "";
  switch (route) {
    case "models":
      return bare === "/models" || bare === "/v1/models";
    case "messages":
      return bare === "/v1/messages" || bare === "/messages";
    case "responses":
      return bare === "/responses" || bare === "/v1/responses";
    case "chat":
      return bare === "/chat/completions" || bare === "/v1/chat/completions";
  }
}

function flatHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") out[name] = value;
    else if (Array.isArray(value)) out[name] = value.join(", ");
  }
  return out;
}

/** The pinned aimock specifier from deno.json, so the pin lives in one place. */
function aimockSpecifier(): string {
  const config = JSON.parse(Deno.readTextFileSync(join(ROOT, "deno.json"))) as {
    imports: Record<string, string>;
  };
  const pinned = config.imports["@copilotkit/aimock"];
  if (pinned === undefined) throw new Error("deno.json does not pin @copilotkit/aimock");
  return `${pinned}/llmock`;
}

/** Resolves with the port once aimock prints its listening line on either stream. A child that
 *  exits first (a bad fixture path, a refused flag) rejects at once with what it printed, never
 *  after the start timeout. Exported for its own test. */
export async function awaitListening(child: Deno.ChildProcess): Promise<number> {
  const marker = /listening on http:\/\/127\.0\.0\.1:(\d+)/;
  let settled = false;
  const printed = { stdout: "", stderr: "" };
  return await new Promise<number>((resolve, reject) => {
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outcome();
    };
    const timer = setTimeout(
      () =>
        settle(() =>
          reject(new Error(`aimock did not report a listening port within ${START_TIMEOUT_MS}ms`))
        ),
      START_TIMEOUT_MS,
    );
    const scan = async (stream: ReadableStream<Uint8Array>, name: "stdout" | "stderr") => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) {
        printed[name] += decoder.decode(chunk, { stream: true });
        const match = marker.exec(printed[name]);
        if (match !== null) settle(() => resolve(Number(match[1])));
        // Keep draining so the child never blocks on a full pipe.
        if (printed[name].length > 65_536) printed[name] = printed[name].slice(-4_096);
      }
    };
    const drained = Promise.all([scan(child.stdout, "stdout"), scan(child.stderr, "stderr")])
      .catch(() => {});
    // An exit closes both pipes; the drain settles first so the message carries what they held.
    child.status.then((status) =>
      drained.then(() =>
        settle(() =>
          reject(
            new Error(
              `aimock exited with code ${status.code} before listening: ${
                (printed.stderr || printed.stdout).trim().slice(0, 400)
              }`,
            ),
          )
        )
      )
    );
  });
}

/**
 * Start aimock on the scenario table (its fixture file lands in `dir`, a directory the caller
 * owns and removes) and the front in front of it; resolves once both listen.
 *
 * aimock runs under the exit-with-parent preload (test/helpers/exit_with_parent_preload.ts) and
 * holds this process's stdin pipe: however this process ends, the pipe's EOF ends aimock too, so
 * a run interrupted mid-suite leaves nothing serving. `close` is the orderly path.
 */
export async function startFakeModelEndpoint(
  dir: string,
  scenarios: Scenarios,
): Promise<FakeModelEndpoint> {
  const fixturesPath = join(dir, "fixtures.json");
  writeFileSync(fixturesPath, `${JSON.stringify(fixtureFile(scenarios), null, 2)}\n`);
  const child = spawnChild(Deno.execPath(), {
    args: [
      ...denoRunArgs("--preload", join(ROOT, "test", "helpers", "exit_with_parent_preload.ts")),
      aimockSpecifier(),
      "--port",
      "0",
      "--fixtures",
      fixturesPath,
      "--log-level",
      "info",
    ],
    // Hermetic: an AIMOCK_API_KEYS in the developer's shell would turn aimock's inbound auth on
    // and reject the fake tokens.
    env: hermeticEnv({}),
    clearEnv: true,
    // Never written; the preload reads it for the EOF alone.
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  let aimockPort: number;
  try {
    aimockPort = await awaitListening(child);
  } catch (e) {
    // The start's own error (the early-exit rejection, say) is the one the caller must see.
    await stopChild(child);
    throw e;
  }

  const own: FakeRequest[] = [];
  const front = createServer((req, res) => {
    const path = req.url ?? "/";
    // Copilot's catalog lives at the ROOT /models; /v1/models stays aimock's own list.
    if (req.method === "GET" && (path.split("?")[0] ?? "") === "/models") {
      own.push({
        method: "GET",
        path,
        headers: flatHeaders(req),
        body: null,
        status: 200,
        interrupted: false,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(catalogBody()));
      return;
    }
    const upstream = httpRequest(
      { host: "127.0.0.1", port: aimockPort, method: req.method, path, headers: req.headers },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
        // aimock cuts a truncated stream by destroying its socket; `pipe` alone would leave the
        // client's side open forever, so the cut is passed on as a cut.
        answer.on("close", () => {
          if (!answer.complete) res.destroy();
        });
        answer.on("error", () => res.destroy());
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ "error": { "message": "aimock unreachable", "type": "front" } }));
    });
    // A client that goes away mid-stream takes its upstream with it.
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  });
  await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", () => resolve()));
  const address = front.address();
  const frontPort = typeof address === "object" && address !== null ? address.port : 0;

  const aimockUrl = `http://127.0.0.1:${aimockPort}`;
  const journal = async (): Promise<FakeRequest[]> => {
    const res = await fetch(`${aimockUrl}/__aimock/journal`, {
      signal: AbortSignal.timeout(JOURNAL_TIMEOUT_MS),
    });
    const entries = (await res.json()) as unknown;
    const theirs: FakeRequest[] = [];
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (!isRecord(entry) || typeof entry.path !== "string") continue;
        const response = isRecord(entry.response) ? entry.response : {};
        theirs.push({
          method: typeof entry.method === "string" ? entry.method : "",
          path: entry.path,
          headers: isRecord(entry.headers)
            ? Object.fromEntries(
              Object.entries(entry.headers).map(([k, v]) => [k, String(v)]),
            )
            : {},
          body: entry.body ?? null,
          status: typeof response.status === "number" ? response.status : 0,
          interrupted: response.interrupted === true,
        });
      }
    }
    return [...own, ...theirs];
  };

  return {
    baseUrl: `http://127.0.0.1:${frontPort}`,
    aimockUrl,
    pid: child.pid,
    journal,
    lastRequest: async (route) => {
      const all = (await journal()).filter((r) => isRoute(route, r.path));
      return all[all.length - 1] ?? null;
    },
    close: async () => {
      await new Promise<void>((done) => {
        front.closeAllConnections();
        front.close(() => done());
      });
      await stopChild(child);
    },
  };
}

/** Kill aimock and release its stdin pipe. A child that already exited throws on kill. */
async function stopChild(child: Deno.ChildProcess): Promise<void> {
  try {
    child.kill();
  } catch {
    // already gone
  }
  await child.status;
  await child.stdin.close();
}
