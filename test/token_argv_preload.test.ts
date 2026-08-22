import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAEMON_GH_TOKEN_ENV } from "../src/copilot_api/process.ts";
import { denoRunArgs, ROOT, runSync } from "./helpers/run.ts";
import { expect, test } from "./helpers/testing.ts";

// The shim reads the GitHub token from DAEMON_GH_TOKEN_ENV and splices it into
// process.argv as `--github-token <token>`, keeping it off the launch command line. It must
// be exercised as a real preloaded subprocess (`--preload`), which is how launchDaemon
// loads it -- and BEFORE the PAT shim, which reads the token from argv.
const SHIM = join(ROOT, "src", "scripts", "token_argv_preload.ts");
const ENV_KEY = DAEMON_GH_TOKEN_ENV;

function runPreloaded(token: string | undefined): { argv: string[]; envHadKey: boolean } {
  const dir = mkdtempSync(join(tmpdir(), "copilot-tokenargv-"));
  try {
    const target = join(dir, "target.ts");
    writeFileSync(
      target,
      [
        "const out = {",
        "  argv: process.argv.slice(2),",
        `  envHadKey: ${JSON.stringify(ENV_KEY)} in process.env,`,
        "};",
        "console.log(JSON.stringify(out));",
      ].join("\n"),
    );
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    if (token === undefined) delete env[ENV_KEY];
    else env[ENV_KEY] = token;
    const res = runSync(
      Deno.execPath(),
      [...denoRunArgs("--preload", SHIM), target, "start", "--port", "4141"],
      { env },
    );
    if (res.exitCode !== 0) throw new Error(`preloaded target failed: ${res.stderr}`);
    return JSON.parse(res.stdout.trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The shim's copied env-var literal is pinned against launchDaemon's DAEMON_GH_TOKEN_ENV
// (with formatting-tolerant extraction) by test/daemon_env_keys.test.ts.

test("splices the token from the env var into argv as --github-token, then scrubs the env", () => {
  // Fake-token fixtures stay short and low-entropy: gitleaks' generic-api-key rule only
  // matches secrets of 10+ chars AND entropy >= 3.5, so neither gate can trip on them.
  const out = runPreloaded("ghp_test");
  // The proxy's own flags survive, and the token is appended as a trailing --github-token pair.
  expect(out.argv).toEqual(["start", "--port", "4141", "--github-token", "ghp_test"]);
  // The env var is deleted so it can't leak to a child process.
  expect(out.envHadKey).toBe(false);
});

test("with no env var set, argv is unchanged and no flag is added", () => {
  const out = runPreloaded(undefined);
  expect(out.argv).toEqual(["start", "--port", "4141"]);
  expect(out.envHadKey).toBe(false);
});

test("does not double-add when --github-token is already present in argv", () => {
  // If a caller passed the flag directly (e.g. an old launch), the shim must not duplicate it.
  const dir = mkdtempSync(join(tmpdir(), "copilot-tokenargv-"));
  try {
    const target = join(dir, "target.ts");
    writeFileSync(target, "console.log(JSON.stringify(process.argv.slice(2)));");
    const res = runSync(
      Deno.execPath(),
      [...denoRunArgs("--preload", SHIM), target, "--github-token", "existing", "start"],
      { env: { ...process.env, [ENV_KEY]: "ghp_env" } },
    );
    if (res.exitCode !== 0) throw new Error(res.stderr);
    expect(JSON.parse(res.stdout.trim())).toEqual(["--github-token", "existing", "start"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
