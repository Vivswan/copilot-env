// CLI children: the allowlisted environment they get, the one registry that owns every child
// (and its process group), and one scripted turn.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { childPathPrepending, verbatimCliSpawn } from "../../src/utils/command.ts";
import { log, sleep, writeFile } from "./cli.ts";
import { isRecord } from "./transcripts.ts";

const TURN_TIMEOUT_MS = 40_000;
/** How long a killed child tree may take to report its exit before that counts as a failure. */
const KILL_GRACE_MS = 5_000;

/** Inherited variables a CLI needs to run at all; everything else stays out. */
const BASE_ENV_KEYS = [
  "TZ",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "USERNAME",
];
/** Passed through only under --real, where the CLIs must reach their real backends. */
const REAL_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
];

/** The exact environment a CLI child gets: an allowlist over `parent` (case-insensitive keys),
 *  `home` as HOME, `binDir` prepended to PATH, loopback excluded from any proxy, then `extra`. */
function childEnvironment(
  parent: Record<string, string | undefined>,
  home: string,
  binDir: string | null,
  real: boolean,
  extra: Record<string, string>,
  pathPrepending: (dirs: (string | null)[]) => string = childPathPrepending,
): Record<string, string> {
  const wanted = new Set([...BASE_ENV_KEYS, ...(real ? REAL_ENV_KEYS : [])]);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value !== undefined && wanted.has(key.toUpperCase())) out[key] = value;
  }
  out.HOME = home;
  out.USERPROFILE = home;
  out.PATH = pathPrepending([binDir]);
  if (!real) {
    out.NO_PROXY = "127.0.0.1,localhost";
    out.no_proxy = "127.0.0.1,localhost";
  }
  return { ...out, ...extra };
}

interface TurnResult {
  ok: boolean;
  stdout: string;
  /** The child (or its tree) survived the kill: the run is no longer clean. */
  stuck: boolean;
}

/** Every CLI child, so a deadline, a failure or a signal can take them all down. A POSIX child
 *  leads its own process group, which outlives it: a turn-end group kill reaches a descendant
 *  left behind by a normal exit. Windows' `taskkill /t` reaches descendants only via a live leader. */
class ChildRegistry {
  private readonly live = new Set<ChildProcess>();
  private readonly groups = new Set<number>();
  private stopped = false;

  get stopping(): boolean {
    return this.stopped;
  }

  spawn(file: string, args: string[], opts: {
    shell: boolean;
    env: Record<string, string>;
    cwd: string;
  }): ChildProcess {
    // nosemgrep: javascript.lang.security.audit.spawn-shell-true.spawn-shell-true -- Windows-only, for .cmd shims; the spec quotes args
    const child = spawn(file, args, {
      shell: opts.shell,
      env: opts.env,
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: Deno.build.os !== "windows",
      windowsHide: true,
    });
    this.live.add(child);
    if (child.pid !== undefined) this.groups.add(child.pid);
    child.once("close", () => this.live.delete(child));
    return child;
  }

  /** Signal the whole tree rooted at `pid` (the process group on POSIX). True when the signal
   *  landed or nothing was left to signal; false when the tree may still be there. */
  signalTree(pid: number): boolean {
    if (Deno.build.os === "windows") {
      // Bounded like the close wait; exit 128 is taskkill's "no such process".
      const result = spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
        timeout: KILL_GRACE_MS,
      });
      return result.error === undefined && (result.status === 0 || result.status === 128);
    }
    try {
      process.kill(-pid, "SIGKILL");
      return true;
    } catch (e) {
      // "No such group" is gone. Any other error (EPERM: a member we may not signal) is checked
      // against the group's actual membership rather than assumed either way.
      const code = isRecord(e) && typeof e.code === "string" ? e.code : "unknown";
      if (code === "ESRCH") return true;
      const members = spawnSync("pgrep", ["-g", String(pid)], {
        stdio: "pipe",
        timeout: KILL_GRACE_MS,
      });
      if (members.status === 1 && !members.error) return true; // pgrep: nothing matched
      this.lastKillError = code;
      return false;
    }
  }

  /** The error code of the last failed signal, for the turn's failure label. */
  lastKillError = "";

  /** Kill `child` and every descendant, then wait for its exit; false when it did not go. The
   *  group is signalled even when the leader already exited, for what it may have left behind. */
  async kill(child: ChildProcess): Promise<boolean> {
    if (child.pid === undefined) return true;
    const signalled = this.signalTree(child.pid);
    if (!this.live.has(child)) return signalled;
    const exited = await Promise.race([
      new Promise<boolean>((resolve) => child.once("close", () => resolve(true))),
      sleep(KILL_GRACE_MS).then(() => !this.live.has(child)),
    ]);
    return signalled && exited;
  }

  /** Forget `child`'s group after its turn's final sweep: a pid may be reused later, and a
   *  retired group is never signalled again. */
  retire(child: ChildProcess): void {
    if (child.pid !== undefined) this.groups.delete(child.pid);
  }

  /** Stop taking new work, kill every live child and sweep every unretired group; false when a
   *  live child did not go. */
  async killAll(): Promise<boolean> {
    this.stopped = true;
    const results = await Promise.all([...this.live].map((child) => this.kill(child)));
    for (const pid of this.groups) results.push(this.signalTree(pid));
    return results.every((ok) => ok);
  }
}

export const registry = new ChildRegistry();

/** Run one CLI turn: prompt on stdin, stdout/stderr captured to files under `turnsDir` (the
 *  kept home is un-scrubbed by contract; the log gets the label only). Never throws, and the
 *  child is dead by the time this returns, whatever happened. */
export async function runTurn(
  label: string,
  command: string,
  args: string[],
  prompt: string,
  home: string,
  cwd: string,
  extraEnv: Record<string, string>,
  real: boolean,
  turnsDir: string,
): Promise<TurnResult> {
  if (registry.stopping) return { ok: false, stdout: "", stuck: false };
  log(`${label}: running`);
  const spec = verbatimCliSpawn(command, args);
  const env = childEnvironment(process.env, home, spec.binDir, real, extraEnv);
  let child: ChildProcess | undefined;
  const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
  let stuck = false;
  let result: TurnResult = { ok: false, stdout: "", stuck: false };
  try {
    // nosemgrep: javascript.lang.security.audit.spawn-shell-true.spawn-shell-true -- Windows-only, for .cmd shims; the spec quotes args
    child = registry.spawn(spec.file, spec.args, { shell: spec.shell, env, cwd });
    const spawned = child;
    spawned.stdout?.on("data", (chunk: Buffer) => chunks.stdout.push(chunk));
    spawned.stderr?.on("data", (chunk: Buffer) => chunks.stderr.push(chunk));
    // The leader's exit ends the turn: its group is swept right there, so a descendant holding
    // the stdio pipes cannot keep `close` (and the turn) open; the stream close is then bounded.
    const closed = new Promise<number | null>((resolve, reject) => {
      spawned.once("error", reject);
      spawned.once("exit", (code) => {
        if (spawned.pid !== undefined && !registry.signalTree(spawned.pid)) stuck = true;
        const streamsClosed = new Promise<void>((done) => spawned.once("close", () => done()));
        void Promise.race([streamsClosed, sleep(KILL_GRACE_MS)]).then(() => resolve(code));
      });
    });
    spawned.stdin?.on("error", () => {}); // a child that exits early closes the pipe first
    spawned.stdin?.end(prompt);
    // The deadline path is bounded by the kill's own grace: a tree that will not die ends the
    // turn as "stuck" instead of waiting on a close that never comes.
    let deadlineHit = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        deadlineHit = true;
        void registry.kill(spawned).then((gone) => {
          stuck = !gone;
          resolve("timeout");
        });
      }, TURN_TIMEOUT_MS);
    });
    const outcome = await Promise.race([closed, timeout]);
    clearTimeout(timer); // a timer that lost the race must never fire on a reused pid
    const stdout = Buffer.concat(chunks.stdout).toString("utf8");
    const slug = label.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase();
    writeFile(join(turnsDir, `${slug}.stdout`), stdout);
    writeFile(join(turnsDir, `${slug}.stderr`), Buffer.concat(chunks.stderr));
    if (deadlineHit) {
      log(
        `${label}: ${stuck ? "did not exit after the kill" : "killed"} at ${
          TURN_TIMEOUT_MS / 1000
        }s`,
      );
      result = { ok: false, stdout, stuck };
    } else if (outcome !== 0) {
      log(`${label}: exit ${outcome} (output kept under home/turns)`);
      result = { ok: false, stdout, stuck };
    } else {
      result = { ok: true, stdout, stuck };
    }
  } catch (e) {
    log(`${label}: could not run (${e instanceof Error ? e.name : "error"})`);
  } finally {
    if (child !== undefined) {
      if (!(await registry.kill(child))) stuck = true;
      registry.retire(child);
    }
  }
  // Only now is the child's fate known, so the verdict is assembled after the final kill.
  return { ...result, stuck: result.stuck || stuck };
}
