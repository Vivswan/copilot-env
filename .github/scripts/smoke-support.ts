// Shared by the two daemon smokes (lifecycle-smoke.ts, floated-smoke.ts): the
// disposable-HOME guard, the `::error::` failure exit, and the `agent` CLI spawn.
import { spawnSync } from "node:child_process";
import { writeSync } from "node:fs";
import { isFile } from "../../src/utils/fs.ts";

/** The files whose presence marks a container: docker's and podman's. */
export const CONTAINER_MARKERS: readonly string[] = ["/.dockerenv", "/run/.containerenv"];

/**
 * Whether the HOME this process sees is throwaway: a container (either marker is a
 * regular file) or a GitHub Actions runner (GITHUB_ACTIONS is exactly "true"). Pure
 * over its inputs; exported for the unit test in test/copilot_api/smoke_scripts.test.ts.
 */
export function homeIsDisposable(
  githubActions: string | undefined,
  exists: (path: string) => boolean,
): boolean {
  return githubActions === "true" || CONTAINER_MARKERS.some(exists);
}

/** Exit 1 with a `::error::` annotation unless the HOME is disposable: both smokes
 *  mutate (or float a real proxy into) whatever HOME they run in. `dockerFlag` names
 *  the test:docker mode that gives a developer machine a throwaway HOME. */
export function requireDisposableHome(script: string, what: string, dockerFlag: string): void {
  if (homeIsDisposable(process.env.GITHUB_ACTIONS, isFile)) return;
  console.error(
    `::error::${script} ${what} the HOME it runs in; use 'bun run test:docker ${dockerFlag}' on a developer machine`,
  );
  process.exit(1);
}

/** The OS name for the smoke's messages: the runner's label in CI, the platform elsewhere. */
export function runnerOs(): string {
  return process.env.RUNNER_OS ?? process.platform;
}

export function fail(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}

type Stream = "inherit" | "piped" | "null";

const STDIO: Record<Stream, "inherit" | "pipe" | "ignore"> = {
  inherit: "inherit",
  piped: "pipe",
  null: "ignore",
};

export interface CliResult {
  code: number;
  /** Decoded only for a "piped" stream; "" otherwise. */
  stdout: string;
  stderr: string;
}

/** `bun run src/cli.ts <args>`, the checkout launcher's own spawn (bin/agent), `bun` resolved
 *  by NAME through PATH. Each stream is inherited unless the caller pipes or drops it. */
export function cli(args: string[], io: { stdout?: Stream; stderr?: Stream } = {}): CliResult {
  const stdout = io.stdout ?? "inherit";
  const stderr = io.stderr ?? "inherit";
  const out = spawnSync("bun", ["run", "src/cli.ts", ...args], {
    stdio: ["inherit", STDIO[stdout], STDIO[stderr]],
    encoding: "utf8",
  });
  if (out.error !== undefined) throw out.error;
  return {
    code: out.status ?? 1,
    stdout: stdout === "piped" ? out.stdout : "",
    stderr: stderr === "piped" ? out.stderr : "",
  };
}

/** `cli` with `set -e` semantics: a nonzero exit ends the smoke with that code, after
 *  echoing whatever was piped so the failure is not silent. Returns the piped stdout. */
export function cliOrExit(args: string[], io: { stdout?: Stream } = {}): string {
  const result = cli(args, io);
  if (result.code !== 0) {
    writeSync(1, result.stdout);
    process.exit(result.code);
  }
  return result.stdout;
}
