// Shared by the two daemon smokes (lifecycle-smoke.ts, floated-smoke.ts): the
// disposable-HOME guard, the `::error::` failure exit, and the `agent` CLI spawn
// under the production permission set.

/** The files whose presence marks a container: docker's and podman's. */
export const CONTAINER_MARKERS: readonly string[] = ["/.dockerenv", "/run/.containerenv"];

/**
 * Whether the HOME this process sees is throwaway: a container (either marker is a
 * regular file) or a GitHub Actions runner (GITHUB_ACTIONS is exactly "true"). Pure
 * over its inputs; exported for the unit test in test/smoke_scripts.test.ts.
 */
export function homeIsDisposable(
  githubActions: string | undefined,
  exists: (path: string) => boolean,
): boolean {
  return githubActions === "true" || CONTAINER_MARKERS.some(exists);
}

function isRegularFile(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

/** Exit 1 with a `::error::` annotation unless the HOME is disposable: both smokes
 *  mutate (or float a real proxy into) whatever HOME they run in. `dockerFlag` names
 *  the test:docker mode that gives a developer machine a throwaway HOME. */
export function requireDisposableHome(script: string, what: string, dockerFlag: string): void {
  if (homeIsDisposable(Deno.env.get("GITHUB_ACTIONS"), isRegularFile)) return;
  console.error(
    `::error::${script} ${what} the HOME it runs in; use 'deno task test:docker ${dockerFlag}' on a developer machine`,
  );
  Deno.exit(1);
}

/** The OS name for the smoke's messages: the runner's label in CI, deno's elsewhere. */
export function runnerOs(): string {
  return Deno.env.get("RUNNER_OS") ?? Deno.build.os;
}

export function fail(message: string): never {
  console.error(`::error::${message}`);
  Deno.exit(1);
}

type Stream = "inherit" | "piped" | "null";

export interface CliResult {
  code: number;
  /** Decoded only for a "piped" stream; "" otherwise. */
  stdout: string;
  stderr: string;
}

/** `deno run -P=cli src/cli.ts <args>`: the set production runs under (bin/agent uses
 *  it), NOT the broader test set, so a permission the CLI needs and the set forgets
 *  fails in the smoke. Each stream is inherited unless the caller pipes or drops it. */
export function cli(args: string[], io: { stdout?: Stream; stderr?: Stream } = {}): CliResult {
  const stdout = io.stdout ?? "inherit";
  const stderr = io.stderr ?? "inherit";
  const out = new Deno.Command("deno", {
    args: ["run", "-P=cli", "src/cli.ts", ...args],
    stdout,
    stderr,
  }).outputSync();
  const decoder = new TextDecoder();
  return {
    code: out.code,
    stdout: stdout === "piped" ? decoder.decode(out.stdout) : "",
    stderr: stderr === "piped" ? decoder.decode(out.stderr) : "",
  };
}

/** `cli` with `set -e` semantics: a nonzero exit ends the smoke with that code, after
 *  echoing whatever was piped so the failure is not silent. Returns the piped stdout. */
export function cliOrExit(args: string[], io: { stdout?: Stream } = {}): string {
  const result = cli(args, io);
  if (result.code !== 0) {
    Deno.stdout.writeSync(new TextEncoder().encode(result.stdout));
    Deno.exit(result.code);
  }
  return result.stdout;
}
