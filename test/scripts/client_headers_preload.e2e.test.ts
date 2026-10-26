import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { daemonClientHeaders } from "../../src/copilot_api/integration_identity.ts";
import { isCopilotApiHost } from "../../src/scripts/client_headers_preload.ts";
import { runWithPreload } from "../helpers/daemon.ts";
import { freePort } from "../helpers/net.ts";
import { CHILD_VALUES, childValuesEnv, ROOT } from "../helpers/run.ts";
import { expect, tempDir, test } from "../helpers/testing.ts";

// Importing the preload without its env var set installs nothing, so the exported helpers are
// unit-tested directly; the wiring runs as a real `--preload` subprocess, the way launchDaemon
// loads it. What would drift silently: bun's undici binds its WebSocket export natively, so only
// a handshake opened through `import { WebSocket } from "undici"` proves the identity reaches it.

const SHIM = join(ROOT, "src", "scripts", "client_headers_preload.ts");

const IDENTITY_MODULE = join(ROOT, "src", "scripts", "undici_identity.ts");
const UA = "codex_exec/1.2.3";

/** What the server saw of the identity headers, and the subprotocol asked for, on one request
 *  or handshake. */
interface Seen {
  ua: string | null;
  id: string | null;
  intent: string | null;
  protocol: string | null;
}

/** Per transport, what the pinned Copilot host saw and what any other host saw; the handshake
 *  also opened with a bare protocol string, the other spelling of `new WebSocket`'s second
 *  argument. */
interface SeenByHost {
  pinned: Seen;
  other: Seen;
  protocol?: Seen;
}

/** Where the entry runs: from the checkout's shims, or beside COPIES of the two shim files, the
 *  layout a COPILOT_API_ENTRY under the install root produces, where the load hook's own module
 *  sits inside the directory it covers. */
type Layout = "checkout" | "beside-copies";

/** A CommonJS package under the entry's own node_modules: a dependency the load hook must leave
 *  alone, since a CommonJS module fed back through onLoad loses its named exports. */
function writeCjsDependency(targetDir: string): void {
  const dir = join(targetDir, "node_modules", "cjs-dep");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), '{ "name": "cjs-dep", "main": "index.js" }\n');
  writeFileSync(join(dir, "index.js"), 'exports.probe = "cjs";\n');
}

/** Two loopback servers echo the identity headers they receive, over HTTP in the body and over
 *  WebSocket in the first message: one IS the daemon's pinned Copilot host (the `host` env, so
 *  the shim treats it as *.githubcopilot.com), the other is any other host. The entry also imports
 *  a CommonJS dependency from its own node_modules and reports what it exported. */
async function runPreloaded(
  set: Record<string, string | null>,
  layout: Layout,
): Promise<{ fetch: SeenByHost; websocket: SeenByHost; cjs: string }> {
  const [pinned, other] = [await freePort(), await freePort()];
  const source = [
    'import { WebSocket } from "undici";',
    'import { probe } from "cjs-dep";',
    `const values = ${CHILD_VALUES};`,
    "const seen = (req) => ({",
    '  ua: req.headers.get("user-agent"),',
    '  id: req.headers.get("copilot-integration-id"),',
    '  intent: req.headers.get("openai-intent"),',
    '  protocol: req.headers.get("sec-websocket-protocol"),',
    "});",
    // A requested subprotocol is accepted as asked, or the client would refuse the open.
    "const accept = (req) => {",
    "  const protocol = seen(req).protocol;",
    '  return new Headers(protocol === null ? {} : { "Sec-WebSocket-Protocol": protocol.split(",")[0].trim() });',
    "};",
    "const serve = (port) =>",
    "  Bun.serve({",
    '    port, hostname: "127.0.0.1",',
    "    fetch: (req, server) => (server.upgrade(req, { data: seen(req), headers: accept(req) }) ? undefined : Response.json(seen(req))),",
    "    websocket: { open: (ws) => { ws.send(JSON.stringify(ws.data)); ws.close(); }, message: () => {} },",
    "  });",
    "const servers = [serve(values.pinned), serve(values.other)];",
    // The proxy's own upstream identity, as copilot-api sends it on both transports.
    'const proxyOwn = { "Copilot-Integration-Id": "vscode-chat", "user-agent": "node", "openai-intent": "conversation-agent" };',
    // biome-ignore-start lint/suspicious/noTemplateCurlyInString: JavaScript source for the child process; its templates run there
    "const fetched = async (port) => await (await fetch(`http://127.0.0.1:${port}/models`, { headers: proxyOwn })).json();",
    "const handshake = (port, init) => new Promise((resolve, reject) => {",
    "  const ws = new WebSocket(`ws://127.0.0.1:${port}/responses`, init);",
    '  ws.addEventListener("message", (event) => resolve(JSON.parse(event.data)));',
    '  ws.addEventListener("error", (event) => reject(new Error(`handshake to ${port} failed: ${event.message}`)));',
    "});",
    // biome-ignore-end lint/suspicious/noTemplateCurlyInString: JavaScript source for the child process; its templates run there
    "const result = {",
    "  fetch: { pinned: await fetched(values.pinned), other: await fetched(values.other) },",
    "  websocket: {",
    "    pinned: await handshake(values.pinned, { headers: proxyOwn }),",
    "    other: await handshake(values.other, { headers: proxyOwn }),",
    '    protocol: await handshake(values.pinned, "chat"),',
    "  },",
    "  cjs: probe,",
    "};",
    "console.log(JSON.stringify(result));",
    "await Promise.all(servers.map((s) => s.stop()));",
  ].join("\n");
  const targetDir = tempDir("preload-target-");
  writeCjsDependency(targetDir);
  let shim = SHIM;
  if (layout === "beside-copies") {
    shim = join(targetDir, "client_headers_preload.ts");
    copyFileSync(SHIM, shim);
    copyFileSync(IDENTITY_MODULE, join(targetDir, "undici_identity.ts"));
  }
  const res = runWithPreload(shim, source, {
    targetDir,
    env: {
      ...process.env,
      ...childValuesEnv({ pinned, other }),
      COPILOT_ENV_DAEMON_CLIENT_HEADERS: JSON.stringify(set),
      COPILOT_ENV_DAEMON_COPILOT_HOST: `http://127.0.0.1:${pinned}`,
    },
  });
  if (res.exitCode !== 0) throw new Error(`target failed (${layout}): ${res.stderr}`);
  return JSON.parse(res.stdout.trim());
}

test("the daemon sends the resolved identity on fetch and on the WebSocket handshake to its Copilot host, whatever the handshake's init and the shims' layout, and nothing else changes (a CommonJS dependency beside the entry included)", async () => {
  const proxyOwn: Seen = {
    ua: "node",
    id: "vscode-chat",
    intent: "conversation-agent",
    protocol: null,
  };
  // The codex identity: the codex User-Agent and NO integration id, whatever copilot-api set.
  const codexSeen: Seen = { ua: UA, id: null, intent: "conversation-edits", protocol: null };
  for (const layout of ["checkout", "beside-copies"] as const) {
    const codex = await runPreloaded(daemonClientHeaders(UA, null), layout);
    expect(codex, layout).toEqual({
      fetch: { pinned: codexSeen, other: proxyOwn },
      websocket: {
        pinned: codexSeen,
        other: proxyOwn,
        protocol: { ...codexSeen, protocol: "chat" },
      },
      cjs: "cjs",
    });
  }
  // An id identity: the same set with the id replaced.
  const cliSeen: Seen = { ...codexSeen, id: "copilot-developer-cli" };
  const cli = await runPreloaded(daemonClientHeaders(UA, "copilot-developer-cli"), "checkout");
  expect(cli).toEqual({
    fetch: { pinned: cliSeen, other: proxyOwn },
    websocket: { pinned: cliSeen, other: proxyOwn, protocol: { ...cliSeen, protocol: "chat" } },
    cjs: "cjs",
  });
});

test("isCopilotApiHost: the Copilot inference hosts match on any scheme, plus the pinned host", () => {
  expect(isCopilotApiHost("https://api.githubcopilot.com/models")).toBe(true);
  expect(isCopilotApiHost("https://api.enterprise.githubcopilot.com/responses")).toBe(true);
  expect(isCopilotApiHost("https://api.business.githubcopilot.com/v1/messages")).toBe(true);
  expect(isCopilotApiHost("wss://api.githubcopilot.com/responses")).toBe(true);
  expect(isCopilotApiHost("https://api.github.com/copilot_internal/user")).toBe(false);
  expect(isCopilotApiHost("http://127.0.0.1:4141/models")).toBe(false);
  expect(isCopilotApiHost("not a url")).toBe(false);
  // A `host` literal off githubcopilot.com (a GHE Copilot host) gates on the identity too,
  // whatever the scheme, but only the exact pinned host does.
  const ghe = "https://copilot-api.ghe.example";
  expect(isCopilotApiHost(`${ghe}/models`, ghe)).toBe(true);
  expect(isCopilotApiHost("http://copilot-api.ghe.example/responses", ghe)).toBe(true);
  expect(isCopilotApiHost(`${ghe}/models`)).toBe(false);
  expect(isCopilotApiHost("https://other.ghe.example/models", ghe)).toBe(false);
});
