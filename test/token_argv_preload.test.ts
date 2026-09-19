import { join } from "node:path";
import { DAEMON_GH_TOKEN_ENV } from "../src/copilot_api/process.ts";
import { ROOT, runWithPreload } from "./helpers/run.ts";
import { expect, test } from "./helpers/testing.ts";

// The shim runs here as a real `--preload` subprocess, the way launchDaemon loads it. Production
// also orders it before the PAT shim, which reads the token from argv (daemonPreloadFlags in
// src/copilot_api/process.ts); these runs preload it alone.
const SHIM = join(ROOT, "src", "scripts", "token_argv_preload.ts");
const ENV_KEY = DAEMON_GH_TOKEN_ENV;

function runPreloaded(
  token: string | undefined,
  argv: string[],
): { argv: string[]; envHadKey: boolean } {
  const source = [
    "const out = {",
    "  argv: process.argv.slice(2),",
    `  envHadKey: ${JSON.stringify(ENV_KEY)} in process.env,`,
    "};",
    "console.log(JSON.stringify(out));",
  ].join("\n");
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (token === undefined) delete env[ENV_KEY];
  else env[ENV_KEY] = token;
  const res = runWithPreload(SHIM, source, { env, args: argv });
  if (res.exitCode !== 0) throw new Error(`preloaded target failed: ${res.stderr}`);
  return JSON.parse(res.stdout.trim());
}

// The shim's copied env-var literal is pinned against launchDaemon's DAEMON_GH_TOKEN_ENV
// (with formatting-tolerant extraction) by test/daemon_env_keys.test.ts.

// A token in the env is spliced onto argv as --github-token unless the flag is already there; the
// env var is scrubbed either way so a child the daemon spawns never inherits it.
// Fake-token fixtures stay short and low-entropy: gitleaks' generic-api-key rule only matches
// secrets of 10+ chars AND entropy >= 3.5, so neither gate can trip on them.
test("the env token becomes --github-token exactly once, and the env var never survives", () => {
  const rows: { token: string | undefined; argv: string[]; out: string[] }[] = [
    {
      token: "ghp_test",
      argv: ["start", "--port", "4141"],
      out: ["start", "--port", "4141", "--github-token", "ghp_test"],
    },
    { token: undefined, argv: ["start", "--port", "4141"], out: ["start", "--port", "4141"] },
    {
      token: "ghp_env",
      argv: ["--github-token", "existing", "start"],
      out: ["--github-token", "existing", "start"],
    },
  ];
  for (const { token, argv, out } of rows) {
    expect({ token, given: argv, ...runPreloaded(token, argv) }).toEqual({
      token,
      given: argv,
      argv: out,
      envHadKey: false,
    });
  }
});
