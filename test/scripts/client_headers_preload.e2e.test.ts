import { join } from "node:path";
import { daemonClientHeaders } from "../../src/copilot_api/integration_identity.ts";
import { isCopilotApiHost } from "../../src/scripts/client_headers_preload.ts";
import { runWithPreload } from "../helpers/daemon.ts";
import { freePort } from "../helpers/net.ts";
import { CHILD_VALUES, childValuesEnv, ROOT } from "../helpers/run.ts";
import { expect, test } from "../helpers/testing.ts";

// Importing the preload without its env var set installs nothing, so the exported helpers are
// unit-tested directly; the wiring (fetch to the Copilot hosts only) runs as a real `--preload`
// subprocess against local servers, the way launchDaemon loads it. The /responses WebSocket
// handshake is not covered because bun offers no seam for it (the shim's header says why).
const SHIM = join(ROOT, "src", "scripts", "client_headers_preload.ts");
const UA = "codex_exec/1.2.3";

/** What the server saw of the identity headers on one request. */
interface Seen {
  ua: string | null;
  id: string | null;
  intent: string | null;
}

/** Two loopback servers echo the identity headers they receive: one IS the daemon's pinned
 *  Copilot host (the `host` env, so the shim treats it as *.githubcopilot.com), the other is any
 *  other host. */
async function runPreloaded(
  set: Record<string, string | null>,
): Promise<{ http: Seen; other: Seen }> {
  const [pinned, other] = [await freePort(), await freePort()];
  const source = [
    `const values = ${CHILD_VALUES};`,
    "const seen = (req) => ({",
    '  ua: req.headers.get("user-agent"),',
    '  id: req.headers.get("copilot-integration-id"),',
    '  intent: req.headers.get("openai-intent"),',
    "});",
    "const serve = (port) =>",
    '  Bun.serve({ port, hostname: "127.0.0.1", fetch: (req) => Response.json(seen(req)) });',
    "const servers = [serve(values.pinned), serve(values.other)];",
    // The proxy's own upstream identity, as copilot-api sends it.
    'const proxyOwn = { "Copilot-Integration-Id": "vscode-chat", "user-agent": "node", "openai-intent": "conversation-agent" };',
    "const http = await (await fetch(`http://127.0.0.1:${values.pinned}/models`, { headers: proxyOwn })).json();",
    "const other = await (await fetch(`http://127.0.0.1:${values.other}/models`, { headers: proxyOwn })).json();",
    "console.log(JSON.stringify({ http, other }));",
    "await Promise.all(servers.map((s) => s.stop()));",
  ].join("\n");
  const res = runWithPreload(SHIM, source, {
    env: {
      ...process.env,
      ...childValuesEnv({ pinned, other }),
      COPILOT_ENV_DAEMON_CLIENT_HEADERS: JSON.stringify(set),
      COPILOT_ENV_DAEMON_COPILOT_HOST: `http://127.0.0.1:${pinned}`,
    },
  });
  if (res.exitCode !== 0) throw new Error(`target failed: ${res.stderr}`);
  return JSON.parse(res.stdout.trim());
}

test("the daemon sends the resolved identity on fetch to its Copilot host, and nothing else changes", async () => {
  const proxyOwn: Seen = { ua: "node", id: "vscode-chat", intent: "conversation-agent" };
  // The codex identity: the codex User-Agent and NO integration id, whatever copilot-api set.
  const codex = await runPreloaded(daemonClientHeaders(UA, null));
  expect(codex).toEqual({
    http: { ua: UA, id: null, intent: "conversation-edits" },
    other: proxyOwn,
  });
  // An id identity: the same set with the id replaced.
  const cli = await runPreloaded(daemonClientHeaders(UA, "copilot-developer-cli"));
  expect(cli).toEqual({
    http: { ua: UA, id: "copilot-developer-cli", intent: "conversation-edits" },
    other: proxyOwn,
  });
});

test("isCopilotApiHost: the Copilot inference hosts match on any scheme, plus the pinned host", () => {
  expect(isCopilotApiHost("https://api.githubcopilot.com/models")).toBe(true);
  expect(isCopilotApiHost("https://api.enterprise.githubcopilot.com/responses")).toBe(true);
  expect(isCopilotApiHost("https://api.business.githubcopilot.com/v1/messages")).toBe(true);
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
