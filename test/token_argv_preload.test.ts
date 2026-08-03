import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAEMON_GH_TOKEN_ENV } from "../src/copilot_api/process.ts";

// The shim reads the GitHub token from DAEMON_GH_TOKEN_ENV and splices it into
// process.argv as `--github-token <token>`, keeping it off the launch command line. It must
// be exercised as a real preloaded subprocess (`bun --preload`), which is how launchDaemon
// loads it -- and BEFORE the PAT shim, which reads the token from argv.
const SHIM = join(import.meta.dir, "..", "src", "scripts", "token_argv_preload.ts");
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
    const res = Bun.spawnSync(["bun", "--preload", SHIM, target, "start", "--port", "4141"], {
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    if (res.exitCode !== 0) throw new Error(`preloaded target failed: ${res.stderr.toString()}`);
    return JSON.parse(res.stdout.toString().trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the preload's copied env-var literal stays in step with launchDaemon's (drift guard)", async () => {
  // The shim stays import-free (a preload must not drag CLI modules into the daemon), so
  // it re-declares the env var launchDaemon sets as a literal. This source-text check makes
  // a rename on either side fail loudly here instead of silently launching the daemon with
  // no credential.
  const shim = await Bun.file(SHIM).text();
  expect(shim).toContain(`const ENV_KEY = "${DAEMON_GH_TOKEN_ENV}"`);
});

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
    const res = Bun.spawnSync(
      ["bun", "--preload", SHIM, target, "--github-token", "existing", "start"],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, [ENV_KEY]: "ghp_env" } as Record<string, string>,
      },
    );
    if (res.exitCode !== 0) throw new Error(res.stderr.toString());
    expect(JSON.parse(res.stdout.toString().trim())).toEqual([
      "--github-token",
      "existing",
      "start",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
