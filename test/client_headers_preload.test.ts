import { rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { daemonClientHeaders } from "../src/copilot_api/integration_identity.ts";
import { isCopilotApiHost } from "../src/scripts/client_headers_preload.ts";
import { CHILD_VALUES, childValuesEnv, denoRunArgs, ROOT, runSync } from "./helpers/run.ts";
import { expect, tempDir, test } from "./helpers/testing.ts";

// Importing the preload without its env var set installs nothing, so the exported helpers are
// unit-tested directly; the wiring (fetch AND undici's WebSocket, Copilot hosts only) runs as a
// real `--preload` subprocess against local servers, the way launchDaemon loads it.
const SHIM = join(ROOT, "src", "scripts", "client_headers_preload.ts");
const UA = "codex_exec/1.2.3";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("expected an AddressInfo from a TCP server"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

/** What the server saw of the identity headers on one request. */
interface Seen {
  ua: string | null;
  id: string | null;
  intent: string | null;
}

/** Two loopback servers echo the identity headers they receive: one IS the daemon's pinned
 *  Copilot host (the `host` env, so the shim treats it as *.githubcopilot.com), the other
 *  is any other host. The target hits the pinned one over fetch and over undici's WebSocket (the
 *  transport copilot-api imports for /responses, which never touches the global fetch), and the
 *  other over fetch. */
async function runPreloaded(
  set: Record<string, string | null>,
): Promise<{ http: Seen; ws: Seen; other: Seen }> {
  const [pinned, other] = [await freePort(), await freePort()];
  const dir = tempDir("copilot-client-headers-");
  try {
    const target = join(dir, "target.ts");
    writeFileSync(
      target,
      [
        'import { WebSocket as UndiciWebSocket } from "undici";',
        `const values = ${CHILD_VALUES};`,
        "const seen = (req) => ({",
        '  ua: req.headers.get("user-agent"),',
        '  id: req.headers.get("copilot-integration-id"),',
        '  intent: req.headers.get("openai-intent"),',
        "});",
        "const serve = (port) =>",
        '  Deno.serve({ port, hostname: "127.0.0.1", onListen() {} }, (req) => {',
        // Read before the upgrade: an upgraded request's headers are gone.
        "    const record = seen(req);",
        '    if (req.headers.get("upgrade") === "websocket") {',
        "      const { socket, response } = Deno.upgradeWebSocket(req);",
        "      socket.onopen = () => { socket.send(JSON.stringify(record)); socket.close(); };",
        "      return response;",
        "    }",
        "    return Response.json(record);",
        "  });",
        "const servers = [serve(values.pinned), serve(values.other)];",
        // The proxy's own upstream identity, as copilot-api sends it on both transports.
        'const proxyOwn = { "Copilot-Integration-Id": "vscode-chat", "user-agent": "node", "openai-intent": "conversation-agent" };',
        "const http = await (await fetch(`http://127.0.0.1:${values.pinned}/models`, { headers: proxyOwn })).json();",
        "const other = await (await fetch(`http://127.0.0.1:${values.other}/models`, { headers: proxyOwn })).json();",
        "const ws = await new Promise((resolve, reject) => {",
        "  const socket = new UndiciWebSocket(`ws://127.0.0.1:${values.pinned}/responses`, { headers: proxyOwn });",
        "  socket.onmessage = (e) => resolve(JSON.parse(String(e.data)));",
        "  socket.onerror = () => reject(new Error('websocket failed'));",
        "});",
        "console.log(JSON.stringify({ http, ws, other }));",
        "await Promise.all(servers.map((s) => s.shutdown()));",
      ].join("\n"),
    );
    const res = runSync(Deno.execPath(), [...denoRunArgs("--preload", SHIM), target], {
      env: {
        ...process.env,
        ...childValuesEnv({ pinned, other }),
        COPILOT_ENV_DAEMON_CLIENT_HEADERS: JSON.stringify(set),
        COPILOT_ENV_DAEMON_COPILOT_HOST: `http://127.0.0.1:${pinned}`,
      },
    });
    if (res.exitCode !== 0) throw new Error(`target failed: ${res.stderr}`);
    return JSON.parse(res.stdout.trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the daemon sends the resolved identity on fetch AND undici's WebSocket to its Copilot host, and nothing else changes", async () => {
  const proxyOwn: Seen = { ua: "node", id: "vscode-chat", intent: "conversation-agent" };
  // The codex identity: the codex User-Agent and NO integration id, whatever copilot-api set.
  const codex = await runPreloaded(daemonClientHeaders(UA, null));
  const codexSeen: Seen = { ua: UA, id: null, intent: "conversation-edits" };
  expect(codex).toEqual({ http: codexSeen, ws: codexSeen, other: proxyOwn });
  // An id identity: the same set with the id replaced.
  const cli = await runPreloaded(daemonClientHeaders(UA, "copilot-developer-cli"));
  const cliSeen: Seen = { ua: UA, id: "copilot-developer-cli", intent: "conversation-edits" };
  expect(cli).toEqual({ http: cliSeen, ws: cliSeen, other: proxyOwn });
});

test("isCopilotApiHost: the Copilot inference hosts match on any scheme, plus the pinned host", () => {
  expect(isCopilotApiHost("https://api.githubcopilot.com/models")).toBe(true);
  expect(isCopilotApiHost("wss://api.enterprise.githubcopilot.com/responses")).toBe(true);
  expect(isCopilotApiHost("https://api.business.githubcopilot.com/v1/messages")).toBe(true);
  expect(isCopilotApiHost("https://api.github.com/copilot_internal/user")).toBe(false);
  expect(isCopilotApiHost("http://127.0.0.1:4141/models")).toBe(false);
  expect(isCopilotApiHost("not a url")).toBe(false);
  // A `host` literal off githubcopilot.com (a GHE Copilot host) gates on the identity too,
  // over its WebSocket scheme as well, but only the exact pinned host does.
  const ghe = "https://copilot-api.ghe.example";
  expect(isCopilotApiHost(`${ghe}/models`, ghe)).toBe(true);
  expect(isCopilotApiHost("wss://copilot-api.ghe.example/responses", ghe)).toBe(true);
  expect(isCopilotApiHost(`${ghe}/models`)).toBe(false);
  expect(isCopilotApiHost("https://other.ghe.example/models", ghe)).toBe(false);
});
