import { join } from "node:path";
import { CHILD_VALUES, childValuesEnv, ROOT, runWithPreload } from "./helpers/run.ts";
import { expect, test } from "./helpers/testing.ts";

// The shim wraps globalThis.fetch when COPILOT_ENV_DAEMON_COPILOT_HOST is set, so it is exercised
// as a real `--preload` subprocess, the way launchDaemon loads it, against a loopback server that
// answers the two GitHub bodies copilot-api reads its host from, the PAT shim's synthetic exchange
// body (no endpoints at all), and one unrelated path.
const SHIM = join(ROOT, "src", "scripts", "copilot_host_preload.ts");
const HOST_ENV = "COPILOT_ENV_DAEMON_COPILOT_HOST";
const PINNED = "https://api.business.githubcopilot.com";
const ACCOUNT = "https://api.enterprise.githubcopilot.com";

/** The bodies the loopback server answers, by path, with `api` where the account's host goes. */
function bodies(api: string): Record<string, unknown> {
  return {
    "/copilot_internal/user": { login: "x", endpoints: { api, proxy: "p" } },
    "/copilot_internal/v2/token": { token: "t", refresh_in: 1, endpoints: { api } },
    "/copilot_internal/v2/token?synthetic": { token: "t", refresh_in: 21_600 },
    "/copilot_internal/v2/token?api-not-a-string": { token: "t", endpoints: { api: 7 } },
    "/copilot_internal/v2/token?scalar-body": "not an object",
    "/other": { login: "x", endpoints: { api } },
  };
}

/** Prints one line per path: `<status> <content-type> <path> <body json>`. */
function runPreloaded(host: string | null): string[] {
  const source = [
    `const bodies = ${CHILD_VALUES}.bodies;`,
    "const server = Deno.serve({ port: 0, hostname: '127.0.0.1', onListen() {} }, (req) => {",
    "  const url = new URL(req.url);",
    "  const path = url.pathname + url.search;",
    "  return Response.json(bodies[path], { headers: { 'x-probe': path } });",
    "});",
    "const base = `http://127.0.0.1:${server.addr.port}`;",
    "for (const path of Object.keys(bodies)) {",
    "  const res = await fetch(base + path);",
    "  const body = await res.json();",
    "  console.log(`${res.status} ${res.headers.get('content-type')} ${res.headers.get('x-probe')} ${JSON.stringify(body)}`);",
    "}",
    "await server.shutdown();",
  ].join("\n");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...childValuesEnv({ bodies: bodies(ACCOUNT) }),
  };
  delete env[HOST_ENV];
  if (host !== null) env[HOST_ENV] = host;
  const res = runWithPreload(SHIM, source, { env });
  if (res.exitCode !== 0) throw new Error(`target failed: ${res.stderr}`);
  return res.stdout.trim().split("\n");
}

// With the pin set, every /copilot_internal/ body's endpoints.api becomes the pin and nothing else
// in the body moves (a sibling key stays; a body without endpoints, with a non-string api, or that
// is no object at all passes through) while status and headers stay and other paths pass through;
// with no pin, no wrap is installed at all.
test("the pin in the environment decides whether the /copilot_internal/ bodies are rewritten", () => {
  const rows: { pin: string | null; api: string }[] = [
    { pin: PINNED, api: PINNED },
    { pin: null, api: ACCOUNT },
  ];
  for (const { pin, api } of rows) {
    const expected = { ...bodies(api), "/other": bodies(ACCOUNT)["/other"] };
    expect({ pin, lines: runPreloaded(pin) }).toEqual({
      pin,
      lines: Object.entries(expected).map(([path, body]) =>
        `200 application/json ${path} ${JSON.stringify(body)}`
      ),
    });
  }
});
