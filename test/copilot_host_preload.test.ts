import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rewriteEndpointsApi } from "../src/scripts/copilot_host_preload.ts";
import { CHILD_VALUES, childValuesEnv, denoRunArgs, ROOT, runSync } from "./helpers/run.ts";
import { expect, tempDir, test } from "./helpers/testing.ts";

// The shim wraps globalThis.fetch when COPILOT_ENV_DAEMON_COPILOT_HOST is set, so it is exercised
// as a real `--preload` subprocess, the way launchDaemon loads it, against a loopback server that
// answers the two GitHub bodies copilot-api reads its host from and one unrelated path.
const SHIM = join(ROOT, "src", "scripts", "copilot_host_preload.ts");
const HOST_ENV = "COPILOT_ENV_DAEMON_COPILOT_HOST";
const PINNED = "https://api.business.githubcopilot.com";
const ACCOUNT = "https://api.enterprise.githubcopilot.com";

/** Prints one line per path: `<status> <content-type> <endpoints.api>`. */
function runPreloaded(host: string | null): string[] {
  const dir = tempDir("copilot-host-preload-");
  try {
    const target = join(dir, "target.ts");
    writeFileSync(
      target,
      [
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
      ].join("\n"),
    );
    const env: NodeJS.ProcessEnv = { ...process.env, ...childValuesEnv({ account: ACCOUNT }) };
    delete env[HOST_ENV];
    if (host !== null) env[HOST_ENV] = host;
    const res = runSync(Deno.execPath(), [...denoRunArgs("--preload", SHIM), target], { env });
    if (res.exitCode !== 0) throw new Error(`target failed: ${res.stderr}`);
    return res.stdout.trim().split("\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("pinned: every /copilot_internal/ body's endpoints.api becomes the pin; status and headers stay; other paths pass through", () => {
  expect(runPreloaded(PINNED)).toEqual([
    `200 application/json /copilot_internal/user ${PINNED}`,
    `200 application/json /copilot_internal/v2/token ${PINNED}`,
    `200 application/json /other ${ACCOUNT}`,
  ]);
});

test("with no pin in the environment, no wrap is installed (the bodies pass through)", () => {
  expect(runPreloaded(null)).toEqual([
    `200 application/json /copilot_internal/user ${ACCOUNT}`,
    `200 application/json /copilot_internal/v2/token ${ACCOUNT}`,
    `200 application/json /other ${ACCOUNT}`,
  ]);
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
