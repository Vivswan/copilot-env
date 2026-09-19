import { join } from "node:path";
import { rewriteEndpointsApi } from "../src/scripts/copilot_host_preload.ts";
import { CHILD_VALUES, childValuesEnv, ROOT, runWithPreload } from "./helpers/run.ts";
import { expect, test } from "./helpers/testing.ts";

// The shim wraps globalThis.fetch when COPILOT_ENV_DAEMON_COPILOT_HOST is set, so it is exercised
// as a real `--preload` subprocess, the way launchDaemon loads it, against a loopback server that
// answers the two GitHub bodies copilot-api reads its host from and one unrelated path.
const SHIM = join(ROOT, "src", "scripts", "copilot_host_preload.ts");
const HOST_ENV = "COPILOT_ENV_DAEMON_COPILOT_HOST";
const PINNED = "https://api.business.githubcopilot.com";
const ACCOUNT = "https://api.enterprise.githubcopilot.com";

/** Prints one line per path: `<status> <content-type> <endpoints.api>`. */
function runPreloaded(host: string | null): string[] {
  const source = [
    `const account = ${CHILD_VALUES}.account;`,
    "const server = Deno.serve({ port: 0, hostname: '127.0.0.1', onListen() {} }, (req) => {",
    "  const path = new URL(req.url).pathname;",
    "  const body = path === '/copilot_internal/v2/token'",
    "    ? { token: 't', refresh_in: 1, endpoints: { api: account } }",
    "    : { login: 'x', endpoints: { api: account } };",
    "  return Response.json(body, { headers: { 'x-probe': path } });",
    "});",
    "const base = `http://127.0.0.1:${server.addr.port}`;",
    "for (const path of ['/copilot_internal/user', '/copilot_internal/v2/token', '/other']) {",
    "  const res = await fetch(base + path);",
    "  const body = await res.json();",
    "  console.log(`${res.status} ${res.headers.get('content-type')} ${res.headers.get('x-probe')} ${body.endpoints.api}`);",
    "}",
    "await server.shutdown();",
  ].join("\n");
  const env: NodeJS.ProcessEnv = { ...process.env, ...childValuesEnv({ account: ACCOUNT }) };
  delete env[HOST_ENV];
  if (host !== null) env[HOST_ENV] = host;
  const res = runWithPreload(SHIM, source, { env });
  if (res.exitCode !== 0) throw new Error(`target failed: ${res.stderr}`);
  return res.stdout.trim().split("\n");
}

// With the pin set, every /copilot_internal/ body's endpoints.api becomes the pin while status and
// headers stay and other paths pass through; with no pin, no wrap is installed at all.
test("the pin in the environment decides whether the /copilot_internal/ bodies are rewritten", () => {
  const rows: { pin: string | null; api: string }[] = [
    { pin: PINNED, api: PINNED },
    { pin: null, api: ACCOUNT },
  ];
  for (const { pin, api } of rows) {
    expect({ pin, lines: runPreloaded(pin) }).toEqual({
      pin,
      lines: [
        `200 application/json /copilot_internal/user ${api}`,
        `200 application/json /copilot_internal/v2/token ${api}`,
        `200 application/json /other ${ACCOUNT}`,
      ],
    });
  }
});

// Importing the preload without the env var installs nothing, so the pure helper is unit-testable.
test("rewriteEndpointsApi touches exactly the endpoints.api string and reports whether it did", () => {
  const user = { login: "x", endpoints: { api: ACCOUNT, proxy: "p" } };
  expect(rewriteEndpointsApi(user, PINNED)).toBe(true);
  expect(user).toEqual({ login: "x", endpoints: { api: PINNED, proxy: "p" } });
  // The PAT shim's synthetic exchange body carries no endpoints: left alone, reported as such.
  const exchange = { token: "t", refresh_in: 21_600 };
  expect(rewriteEndpointsApi(exchange, PINNED)).toBe(false);
  expect(exchange).toEqual({ token: "t", refresh_in: 21_600 });
  expect(rewriteEndpointsApi({ endpoints: { api: 7 } }, PINNED)).toBe(false);
  expect(rewriteEndpointsApi("not an object", PINNED)).toBe(false);
});
