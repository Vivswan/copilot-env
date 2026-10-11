// The proxy daemon, its preload shims, and the daemon-side modules they load still run under the
// Deno sidecar, so a test of daemon-side behaviour spawns a deno, never the running bun. The deno
// comes from PATH (the gate puts the sidecar's there) and is never a pinned path; a machine with
// none skips those tests by name, so a missing sidecar is visible in the run, never a silent green.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type RunOptions, runSync, spawnChild, type SpawnChildOptions } from "./run.ts";
import { tempDir, test } from "./testing.ts";

type RegisterTest = ReturnType<typeof test.skipIf>;

const SIDECAR_DENO: string | null = Bun.which("deno");

const SKIP_REASON = "skipped: no deno on PATH, and the daemon side still runs under the sidecar";

/** `test` when a deno is on PATH; otherwise a skip whose name says why. */
export const sidecarTest: RegisterTest =
  SIDECAR_DENO === null
    ? (name, fn, timeoutMs) => test.skipIf(true)(`${name} [${SKIP_REASON}]`, fn, timeoutMs)
    : test;

export function sidecarDeno(): string {
  if (SIDECAR_DENO === null) throw new Error(SKIP_REASON);
  return SIDECAR_DENO;
}

/**
 * The argv prefix for a daemon-side fixture. All access: what the daemon is granted is the
 * launcher's contract (src/copilot_api/process.ts), pinned by its own tests, not a fixture's.
 * `--node-modules-dir=manual` resolves a fixture's bare imports (through the src modules it loads)
 * from the checkout's node_modules, which a script written under the temp root could not discover.
 */
export function denoRunArgs(...flags: string[]): string[] {
  return ["run", "-A", "--node-modules-dir=manual", ...flags];
}

type StdioMode = "pipe" | "ignore" | "inherit";

export function spawnDenoChild<
  const In extends StdioMode = "ignore",
  const Out extends StdioMode = "pipe",
  const Err extends StdioMode = "inherit",
>(options: SpawnChildOptions<In, Out, Err> & { args: string[] }): Bun.Subprocess<In, Out, Err> {
  return spawnChild(sidecarDeno(), { ...options, args: [...denoRunArgs(), ...options.args] });
}

export function runDenoScript(entry: string, args: string[] = [], opts: RunOptions = {}) {
  return runSync(sidecarDeno(), [...denoRunArgs(), entry, ...args], opts);
}

/** `source` written under a fresh temp dir and run with `--preload shim` ahead of it, the way the
 *  daemon launcher loads the shims; `args` follow the target on its argv. */
export function runWithDenoPreload(
  shim: string,
  source: string,
  opts: RunOptions & { args?: string[] } = {},
) {
  const target = join(tempDir("preload-target-"), "target.ts");
  writeFileSync(target, source);
  const { args = [], ...run } = opts;
  return runSync(sidecarDeno(), [...denoRunArgs("--preload", shim), target, ...args], run);
}
