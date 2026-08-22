// Subprocess helpers shared by every test that spawns the CLI or a script.
// Children are deno subprocesses running under the repo's "test" permission
// set; `--config` pins the root deno.json because deno discovers config (and
// with it the permission set) from the ENTRYPOINT's directory, so a worker
// script written to a temp dir would otherwise resolve no set at all.
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * `path` as a quoted module specifier, ready to splice into generated source
 * (`import ... from ${importSpecifier(p)}`). It must be a file URL: a Windows
 * absolute path is not a valid specifier, and deno reads its drive letter as an
 * unsupported URL scheme.
 */
export function importSpecifier(path: string): string {
  return JSON.stringify(pathToFileURL(path).href);
}

/** `deno run` argv (before the entrypoint) for a child under the test permission set. */
export function denoRunArgs(...flags: string[]): string[] {
  return ["run", "--config", join(ROOT, "deno.json"), "-P=test", ...flags];
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Hard kill for a wedged child; sync spawns block the deadline race in testing.ts. */
  timeoutMs?: number;
}

/** spawnSync rejects undefined env values, which a `{ ...process.env }` spread carries. */
function definedEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Synchronous spawn with the Bun.spawnSync result shape the suite asserts on. */
export function runSync(cmd: string, args: string[], opts: RunOptions = {}): RunResult {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    env: definedEnv(opts.env ?? process.env),
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: opts.timeoutMs ?? 120_000,
  });
  if (res.error) throw res.error;
  return { exitCode: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** Run a repo TypeScript entrypoint (or a temp-dir worker script) as a deno child. */
export function runScript(entry: string, args: string[] = [], opts: RunOptions = {}): RunResult {
  return runSync(Deno.execPath(), [...denoRunArgs(), entry, ...args], opts);
}

/** Run the CLI (`src/cli.ts`) with `args`, from the repo root. */
export function runCli(args: string[], opts: RunOptions = {}): RunResult {
  return runScript(join(ROOT, "src", "cli.ts"), args, opts);
}

/**
 * The package directory `name` resolves to from `fromDir`, by node's
 * node_modules ancestor walk. `fromDir` is realpath'd first: deno's store
 * symlinks a package out of node_modules, and its own dependencies sit beside
 * the REAL location (inside the store), not beside the symlink.
 */
export function resolvePackageDir(name: string, fromDir: string): string {
  let dir = realpathSync(fromDir);
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`cannot resolve package ${name} from ${fromDir}`);
    dir = parent;
  }
}
