// Record a corpus of REAL session logs: the installed `claude` and `codex` CLIs run scripted
// turns against the fake inference backend under a kept, runnable HOME at `<out>/home`, and
// scrubbed copies land at `<out>/claude` and `<out>/codex`. See usage() for the contract.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { childPathPrepending, findCommand, verbatimCliSpawn } from "../src/utils/command.ts";
import { startInferenceFake } from "../test/helpers/inference_fake.mjs";

const CLAUDE_MODEL = "claude-sonnet-4-6";
const CODEX_MODEL = "gpt-5.4";
/** The Codex provider table the fake is wired through; `model_provider` selects it. */
const CODEX_PROVIDER = "fake";
/** Below the consumer job's 15-minute timeout; the turns and the minute wait fit inside it. */
const TOTAL_DEADLINE_MS = 8 * 60_000;
const TURN_TIMEOUT_MS = 40_000;
/** How long a killed child tree may take to report its exit before that counts as a failure. */
const KILL_GRACE_MS = 5_000;
/** The second-of-minute the boundary turns start at; the fake holds their replies past :00. */
const BOUNDARY_START_SECOND = 55;
const MINUTE_POLL_MS = 200;
/** Inference requests the scripted turns make per CLI: 4 plain turns + a tool turn's 2. */
const EXPECTED_REQUESTS_PER_CLI = 6;
const SUMMARY_SOURCES = ["claude", "codex"] as const;
type Source = (typeof SUMMARY_SOURCES)[number];

// ---------- arguments and logging ----------

interface Args {
  out: string;
  real: boolean;
}

function usage(): string {
  return `Usage: deno task usage:corpus -- --out <dir> [--real]

Runs the installed claude and codex CLIs (both required) through five scripted turns each
against the fake inference backend, under a throwaway HOME kept at <dir>/home, then writes
scrubbed copies to <dir>/claude/projects and <dir>/codex/sessions. The last stdout line is
one JSON object with at least {"files":N,"lines":N,"usageLines":{"claude":N,"codex":N}};
everything else goes to stderr (deno's own task banner echoes the argv; 'deno task --quiet'
silences it). <dir> must not exist yet or must be empty. --real skips the fake and uses the
credentials the environment already has: it SPENDS REAL TOKENS.`;
}

function die(message: string): never {
  console.error(`usage_corpus: ${message}`);
  console.error(usage());
  Deno.exit(2);
}

function parseArgs(argv: string[]): Args {
  let out: string | undefined;
  let real = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue; // `deno task x -- --out d` forwards the separator itself
    if (arg === "--out") {
      out = argv[++i];
      if (out === undefined) die("--out needs a directory");
    } else if (arg === "--real") real = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      Deno.exit(0);
    } else die("unknown argument (only --out <dir>, --real and --help are accepted)");
  }
  if (out === undefined) die("--out is required");
  // Absolute: the children run with cwd inside it and would resolve a relative HOME there.
  return { out: resolve(out), real };
}

/** Labels only: no paths, prompts, ids or child output ever reach the runtime log. */
function log(label: string): void {
  console.error(`[usage-corpus] ${label}`);
}

/** Every file this driver writes or removes, `<out>`-relative, reported in the summary line. */
const ledger = { written: [] as string[], removed: [] as string[], out: "" };

function writeFile(path: string, data: string | Uint8Array): void {
  writeFileSync(path, data);
  ledger.written.push(relative(ledger.out, path).replaceAll("\\", "/"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- child environment (explicit allowlist) ----------

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

// ---------- children: one owner ----------

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

const registry = new ChildRegistry();

/** Run one CLI turn: prompt on stdin, stdout/stderr captured to files under `turnsDir` (the
 *  kept home is un-scrubbed by contract; the log gets the label only). Never throws, and the
 *  child is dead by the time this returns, whatever happened. */
async function runTurn(
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

// ---------- the minute straddle ----------

/** `arm()` waits until just before :00; while that minute is current, `hold()` (the fake's
 *  beforeReply hook) keeps every reply back until the minute changes, so a turn started before
 *  :00 logs its reply after it. Shared by both CLIs, so one wait serves both. */
class MinuteStraddle {
  private armedMinute: number | null = null;

  /** Wait until just before :00, giving up as soon as the run is stopping. */
  async arm(): Promise<void> {
    if (registry.stopping) return;
    const second = new Date().getSeconds();
    const waitSeconds = second >= BOUNDARY_START_SECOND ? 0 : BOUNDARY_START_SECOND - second;
    if (waitSeconds > 0 && this.armedMinute === null) {
      log(`waiting ${waitSeconds}s so the next turns straddle a minute boundary`);
    }
    const until = Date.now() + waitSeconds * 1000;
    while (Date.now() < until && !registry.stopping) await sleep(MINUTE_POLL_MS);
    if (!registry.stopping) this.armedMinute = new Date().getMinutes();
  }

  async hold(): Promise<void> {
    const armed = this.armedMinute;
    if (armed === null) return;
    while (new Date().getMinutes() === armed) await sleep(MINUTE_POLL_MS);
    this.armedMinute = null;
  }
}

// ---------- the fake's request trace ----------

interface TracedRequest {
  path: string;
  tool: string | null;
  usage: { input: number; cacheRead: number; cacheCreation: number; output: number };
}

/** The fake's token buckets summed per source, in the readers' own bucket shapes, so `agent cost`
 *  over the recorded home can be checked against what was actually served. */
function fakeUsageBySource(trace: TracedRequest[]): Record<Source, Record<string, number>> {
  const sum = (path: string, pick: (u: TracedRequest["usage"]) => Record<string, number>) => {
    const out: Record<string, number> = {};
    for (const request of trace.filter((r) => r.path === path)) {
      for (const [key, value] of Object.entries(pick(request.usage))) {
        out[key] = (out[key] ?? 0) + value;
      }
    }
    return out;
  };
  return {
    // Claude's input_tokens excludes both cache buckets.
    claude: sum("/messages", (u) => ({
      input: u.input,
      cacheRead: u.cacheRead,
      cacheCreation: u.cacheCreation,
      output: u.output,
    })),
    // OpenAI has no cache-write bucket: the creation share is plain input; cached is split out.
    codex: sum("/responses", (u) => ({
      input: u.input + u.cacheCreation,
      cacheRead: u.cacheRead,
      cacheCreation: 0,
      output: u.output,
    })),
  };
}

/** What the fake saw, per source, against what the scripted turns must have made. */
function requestTraceFailures(trace: TracedRequest[]): string[] {
  const failures: string[] = [];
  const byPath = (path: string) => trace.filter((r) => r.path === path);
  const checks: [Source, string][] = [["claude", "/messages"], ["codex", "/responses"]];
  for (const [source, path] of checks) {
    const requests = byPath(path);
    if (requests.length !== EXPECTED_REQUESTS_PER_CLI) {
      failures.push(
        `${source}: the fake saw ${requests.length} inference requests, expected ${EXPECTED_REQUESTS_PER_CLI}`,
      );
    }
    const toolCalls = requests.filter((r) => r.tool !== null).length;
    if (toolCalls !== 1) {
      failures.push(`${source}: the fake emitted ${toolCalls} tool calls, expected 1`);
    }
  }
  const other = trace.filter((r) => r.path !== "/messages" && r.path !== "/responses");
  if (other.length > 0) failures.push(`the fake saw ${other.length} requests on other routes`);
  return failures;
}

// ---------- Claude ----------

interface ClaudeIds {
  first: string | null;
  resumed: string | null;
  tool: string | null;
  afterTool: string | null;
  fork: string | null;
}

/** `session_id` from a `--output-format json` result, or null. */
function claudeSessionId(stdout: string): string | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (isRecord(parsed) && typeof parsed.session_id === "string") return parsed.session_id;
  } catch {
    // not JSON
  }
  return null;
}

async function recordClaude(
  home: string,
  work: string,
  baseUrl: string | null,
  straddle: MinuteStraddle,
  turnsDir: string,
  stop: (label: string) => void,
): Promise<ClaudeIds> {
  const ids: ClaudeIds = { first: null, resumed: null, tool: null, afterTool: null, fork: null };
  const claudeHome = join(home, ".claude");
  const extra: Record<string, string> = {
    CLAUDE_CONFIG_DIR: claudeHome,
    DISABLE_TELEMETRY: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  if (baseUrl !== null) {
    extra.ANTHROPIC_BASE_URL = baseUrl;
    // A bearer token: an API key needs an interactive approval that print mode reports as
    // "Not logged in", while a token is accepted as-is.
    extra.ANTHROPIC_AUTH_TOKEN = "corpus-fake-token";
  } else {
    // --real: a file-backed login lives in the (possibly overridden) config dir, so carry it
    // into the throwaway one.
    const credentials = join(
      Deno.env.get("CLAUDE_CONFIG_DIR") ?? join(homedir(), ".claude"),
      ".credentials.json",
    );
    if (existsSync(credentials)) {
      mkdirSync(claudeHome, { recursive: true });
      copyFileSync(credentials, join(claudeHome, ".credentials.json"));
      ledger.written.push("home/.claude/.credentials.json");
    }
  }
  // Print mode reads the prompt from stdin when no positional prompt is given.
  const base = ["-p", "--output-format", "json", "--model", CLAUDE_MODEL];
  const turn = async (label: string, args: string[], prompt: string) => {
    const result = await runTurn(
      label,
      "claude",
      [...base, ...args],
      prompt,
      home,
      work,
      extra,
      baseUrl === null,
      turnsDir,
    );
    const id = result.ok ? claudeSessionId(result.stdout) : null;
    if (result.stuck) {
      stop(`${label}: the CLI did not exit after the kill (${registry.lastKillError})`);
    }
    if (id === null) stop(`${label}: ${result.ok ? "no session id in the result" : "failed"}`);
    return id;
  };

  ids.first = await turn("claude turn 1", [], "Reply with one short sentence about the weather.");
  if (ids.first === null) return ids;
  await straddle.arm();
  ids.resumed = await turn(
    "claude turn 2 (resume)",
    ["--resume", ids.first],
    "Now one sentence about the sea.",
  );
  if (ids.resumed === null) return ids;
  // Read inside the cwd needs no permission grant in print mode, so no tool allowlist.
  ids.tool = await turn(
    "claude turn 3 (tool)",
    [],
    `Use the Read tool on the note. tool-name: Read tool-args: ${
      JSON.stringify({ "file_path": join(work, "corpus-note.txt") })
    }`,
  );
  if (ids.tool === null) return ids;
  ids.afterTool = await turn(
    "claude turn 4 (resume after tool)",
    ["--resume", ids.tool],
    "Summarize what you read in one sentence.",
  );
  if (ids.afterTool === null) return ids;
  ids.fork = await turn(
    "claude turn 5 (fork)",
    ["--resume", ids.first, "--fork-session"],
    "One sentence about mountains.",
  );
  return ids;
}

// ---------- Codex ----------

interface CodexIds {
  first: string | null;
  resumed: string | null;
  tool: string | null;
  afterTool: string | null;
  fork: string | null;
}

/** The rollout uuid of a `--json` exec run (`thread.started`), or null. */
function codexThreadId(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    if (!line.includes("thread.started")) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed) && typeof parsed.thread_id === "string") return parsed.thread_id;
    } catch {
      // not JSON
    }
  }
  return null;
}

function codexConfigToml(baseUrl: string): string {
  return [
    `model = "${CODEX_MODEL}"`,
    `model_provider = "${CODEX_PROVIDER}"`,
    "",
    `[model_providers.${CODEX_PROVIDER}]`,
    `name = "${CODEX_PROVIDER}"`,
    `base_url = "${baseUrl}/v1"`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
  ].join("\n");
}

async function recordCodex(
  home: string,
  work: string,
  baseUrl: string | null,
  straddle: MinuteStraddle,
  turnsDir: string,
  stop: (label: string) => void,
): Promise<CodexIds> {
  const ids: CodexIds = { first: null, resumed: null, tool: null, afterTool: null, fork: null };
  const codexHome = join(home, ".codex");
  mkdirSync(codexHome, { recursive: true });
  if (baseUrl !== null) {
    writeFile(join(codexHome, "config.toml"), codexConfigToml(baseUrl));
  } else {
    const auth = join(Deno.env.get("CODEX_HOME") ?? join(homedir(), ".codex"), "auth.json");
    if (existsSync(auth)) {
      copyFileSync(auth, join(codexHome, "auth.json"));
      ledger.written.push("home/.codex/auth.json");
    }
  }
  const extra = { CODEX_HOME: codexHome };
  // No -C (resume/fork lack it; the cwd is the spawn's); `-` reads the prompt from stdin; plugins
  // off because their marketplace sync spawns a background `git ls-remote` to github.com that
  // outlives the turn.
  const base = ["--disable", "plugins", "--skip-git-repo-check", "--json"];
  const turn = async (label: string, args: string[], prompt: string) => {
    const result = await runTurn(
      label,
      "codex",
      [...args, "-"],
      prompt,
      home,
      work,
      extra,
      baseUrl === null,
      turnsDir,
    );
    const id = result.ok ? codexThreadId(result.stdout) : null;
    if (result.stuck) {
      stop(`${label}: the CLI did not exit after the kill (${registry.lastKillError})`);
    }
    if (id === null) stop(`${label}: ${result.ok ? "no thread id in the result" : "failed"}`);
    return id;
  };

  ids.first = await turn(
    "codex turn 1",
    ["exec", ...base],
    "Reply with one short sentence about the weather.",
  );
  if (ids.first === null) return ids;
  await straddle.arm();
  ids.resumed = await turn(
    "codex turn 2 (resume)",
    ["exec", "resume", ...base, ids.first],
    "Now one sentence about the sea.",
  );
  if (ids.resumed === null) return ids;
  ids.tool = await turn(
    "codex turn 3 (tool)",
    ["exec", ...base],
    "Run one harmless shell tool call that echoes the word corpus, then stop.",
  );
  if (ids.tool === null) return ids;
  ids.afterTool = await turn(
    "codex turn 4 (resume after tool)",
    ["exec", "resume", ...base, ids.tool],
    "Summarize what the command printed in one sentence.",
  );
  if (ids.afterTool === null) return ids;
  ids.fork = await turn(
    "codex turn 5 (fork)",
    ["exec", "fork", ...base, ids.first],
    "One sentence about mountains.",
  );
  return ids;
}

// ---------- transcript evidence ----------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function walkJsonl(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkJsonl(full, out);
    else if (entry.name.endsWith(".jsonl")) out.push(full);
  }
}

/** The parsed records of a JSONL file (torn lines skipped). */
function readRecords(file: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) records.push(parsed);
    } catch {
      // torn line
    }
  }
  return records;
}

/** The session's own transcript(s) by each source's exact basename: `<id>.jsonl` (Claude) or
 *  `rollout-<stamp>-<id>.jsonl` (Codex). A nested subagent file under `<id>/` is neither. */
function filesFor(files: string[], id: string, source: Source): string[] {
  return files.filter((file) => {
    const base = file.split(/[\\/]/).at(-1) ?? "";
    if (source === "claude") return base === `${id}.jsonl`;
    const rollout = ROLLOUT_FILE_RE.exec(base);
    return rollout !== null && rollout[2]!.toLowerCase() === id.toLowerCase();
  });
}

/** What the Claude transcripts must show: both resumes continued their sessions (same ids, a
 *  second assistant message in session 1's file), the tool turn holds a tool_use AND its
 *  tool_result, and the fork is a new session carrying EVERY record of session 1 plus its own. */
function claudeEvidenceFailures(
  ids: ClaudeIds,
  recordsByFile: Map<string, Record<string, unknown>[]>,
): string[] {
  const failures: string[] = [];
  const files = [...recordsByFile.keys()];
  if (
    ids.first === null || ids.resumed === null || ids.tool === null || ids.afterTool === null ||
    ids.fork === null
  ) {
    return ["claude: not every turn produced a session id"];
  }
  if (ids.resumed !== ids.first) failures.push("claude: the resume did not continue session 1");
  if (ids.afterTool !== ids.tool) {
    failures.push("claude: the resume after the tool turn did not continue the tool session");
  }
  for (
    const [label, id] of [["session 1", ids.first], ["the tool session", ids.tool], [
      "the fork",
      ids.fork,
    ]]
  ) {
    const count = filesFor(files, id!, "claude").length;
    if (count !== 1) failures.push(`claude: ${label} has ${count} transcripts, expected 1`);
  }
  // Stable ids of a session's records: a user line's `uuid`, an assistant line's `message.id`
  // (a fork copies both verbatim).
  const recordIds = (id: string, only?: "assistant"): Set<string> => {
    const out = new Set<string>();
    for (const file of filesFor(files, id, "claude")) {
      for (const record of recordsByFile.get(file) ?? []) {
        if (record.type === "assistant" && isRecord(record.message)) {
          if (typeof record.message.id === "string") out.add(record.message.id);
        } else if (
          only === undefined && record.type === "user" && typeof record.uuid === "string"
        ) {
          out.add(record.uuid);
        }
      }
    }
    return out;
  };
  if (recordIds(ids.first, "assistant").size < 2) {
    failures.push("claude: session 1's transcript does not hold a second assistant message");
  }
  if (ids.fork === ids.first) failures.push("claude: the fork did not open a new session");
  else {
    const firstMessages = recordIds(ids.first);
    const forkMessages = recordIds(ids.fork);
    const wholeHistory = [...firstMessages].every((id) => forkMessages.has(id));
    const ownReply = [...recordIds(ids.fork, "assistant")].some((id) => !firstMessages.has(id));
    if (!wholeHistory || !ownReply) {
      failures.push(
        "claude: the fork's transcript does not carry session 1's history plus its own",
      );
    }
  }
  const toolUses = new Set<string>();
  const toolResults = new Set<string>();
  for (const file of filesFor(files, ids.tool, "claude")) {
    for (const record of recordsByFile.get(file) ?? []) {
      if (!isRecord(record.message) || !Array.isArray(record.message.content)) continue;
      for (const block of record.message.content) {
        if (!isRecord(block)) continue;
        if (block.type === "tool_use" && typeof block.id === "string") toolUses.add(block.id);
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          toolResults.add(block.tool_use_id);
        }
      }
    }
  }
  if (toolUses.size === 0) failures.push("claude: the tool turn holds no tool_use block");
  else if (![...toolUses].some((id) => toolResults.has(id))) {
    failures.push("claude: the tool turn's tool_use has no matching tool_result");
  }
  return failures;
}

/** What the Codex rollouts must show: the resume appended to session 1's rollout (same id, two
 *  token_count events), the tool turn holds a function_call AND its function_call_output, and
 *  the fork is a new rollout naming session 1 in `forked_from_id`. */
function codexEvidenceFailures(
  ids: CodexIds,
  recordsByFile: Map<string, Record<string, unknown>[]>,
): string[] {
  const failures: string[] = [];
  const files = [...recordsByFile.keys()];
  if (
    ids.first === null || ids.resumed === null || ids.tool === null || ids.afterTool === null ||
    ids.fork === null
  ) {
    return ["codex: not every turn produced a thread id"];
  }
  if (ids.resumed !== ids.first) failures.push("codex: the resume did not continue session 1");
  if (ids.afterTool !== ids.tool) {
    failures.push("codex: the resume after the tool turn did not continue the tool session");
  }
  const firstFiles = filesFor(files, ids.first, "codex");
  for (
    const [label, id] of [["session 1", ids.first], ["the tool session", ids.tool], [
      "the fork",
      ids.fork,
    ]]
  ) {
    const count = filesFor(files, id!, "codex").length;
    if (count !== 1) failures.push(`codex: ${label} has ${count} rollouts, expected 1`);
  }
  let tokenCounts = 0;
  for (const file of firstFiles) {
    for (const record of recordsByFile.get(file) ?? []) {
      if (
        record.type === "event_msg" && isRecord(record.payload) &&
        record.payload.type === "token_count"
      ) tokenCounts++;
    }
  }
  if (tokenCounts < 2) {
    failures.push("codex: session 1's rollout does not hold the resumed turn's token_count");
  }
  const forkFiles = filesFor(files, ids.fork, "codex");
  const forkMeta = forkFiles.flatMap((file) => recordsByFile.get(file) ?? []).find(
    (record) => record.type === "session_meta",
  );
  if (
    ids.fork === ids.first || forkMeta === undefined || !isRecord(forkMeta.payload) ||
    forkMeta.payload.forked_from_id !== ids.first
  ) {
    failures.push("codex: the fork's rollout does not name session 1 in forked_from_id");
  }
  const calls = new Set<string>();
  const outputs = new Set<string>();
  for (const file of filesFor(files, ids.tool, "codex")) {
    for (const record of recordsByFile.get(file) ?? []) {
      if (record.type !== "response_item" || !isRecord(record.payload)) continue;
      const payload = record.payload;
      if (payload.type === "function_call" && typeof payload.call_id === "string") {
        calls.add(payload.call_id);
      }
      if (payload.type === "function_call_output" && typeof payload.call_id === "string") {
        outputs.add(payload.call_id);
      }
    }
  }
  if (calls.size === 0) failures.push("codex: the tool turn holds no function_call");
  else if (![...calls].some((id) => outputs.has(id))) {
    failures.push("codex: the tool turn's function_call has no function_call_output");
  }
  return failures;
}

function recordsUnder(dir: string): Map<string, Record<string, unknown>[]> {
  const files: string[] = [];
  walkJsonl(dir, files);
  return new Map(files.map((file) => [file, readRecords(file)]));
}

// ---------- scrub (fail-closed) ----------

const PLACEHOLDER = "SCRUBBED";
/** Every schema key the two CLIs (and the fake) write outside tool containers; anything else is
 *  a dynamic key and is replaced. Grown from the recorded corpus, so schema drift shows up as
 *  `SCRUBBED_KEY_n` entries rather than leaking. */
const KNOWN_KEYS = new Set([
  "access",
  "active",
  "active_permission_profile",
  "addedLines",
  "addedTypes",
  "agents_md",
  "aggregated_output",
  "annotations",
  "apiBlockIndex",
  "approval_policy",
  "approvals_reviewer",
  "approved_command_prefixes",
  "apps_instructions",
  "arguments",
  "atis",
  "attachment",
  "base_instructions",
  "body",
  "cache_creation",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "cache_write_input_tokens",
  "cached_input_tokens",
  "call_id",
  "citations",
  "cli_version",
  "cmd",
  "collaboration_mode",
  "collaboration_mode_kind",
  "command",
  "comp_hash",
  "completed_at",
  "completed_at_ms",
  "container",
  "content",
  "content_item_kinds",
  "context_window",
  "context_window_guidance",
  "create_time",
  "credits",
  "current_date",
  "cwd",
  "developer_instructions",
  "duration",
  "duration_ms",
  "effort",
  "enabled",
  "end_byte_offset",
  "end_ordinal_exclusive",
  "entries",
  "entrypoint",
  "environments",
  "environments_instructions",
  "ephemeral_1h_input_tokens",
  "ephemeral_5m_input_tokens",
  "exit_code",
  "file_system",
  "filesystem",
  "finish_reason",
  "forked_from_id",
  "forked_from_ordinal_exclusive",
  "formatted_output",
  "full",
  "gitBranch",
  "git_attribution",
  "history_base",
  "history_mode",
  "hookEvent",
  "hookName",
  "host_skills",
  "id",
  "includeInstructions",
  "individual_limit",
  "inference_geo",
  "info",
  "input",
  "input_tokens",
  "input_tokens_details",
  "instructions",
  "internal_chat_message_metadata_passthrough",
  "isInitial",
  "isSidechain",
  "is_error",
  "item",
  "item_id",
  "iterations",
  "kind",
  "lastPrompt",
  "last_agent_message",
  "last_token_usage",
  "leafUuid",
  "limit_id",
  "limit_name",
  "local",
  "logprobs",
  "managed_developer_instructions",
  "message",
  "mode",
  "model",
  "model_context_window",
  "model_provider",
  "model_provider_id",
  "multi_agent_mode",
  "multi_agent_version",
  "name",
  "names",
  "nanos",
  "network",
  "object",
  "operation",
  "orchestrator_skills",
  "ordinal",
  "originator",
  "output",
  "output_tokens",
  "output_tokens_details",
  "parentUuid",
  "parsed_cmd",
  "path",
  "payload",
  "permissionMode",
  "permission_profile",
  "permissions",
  "persistent_mode",
  "personality",
  "plan_type",
  "plugins_instructions",
  "primary",
  "process_id",
  "promptId",
  "promptSource",
  "provenance",
  "rate_limit_reached_type",
  "rate_limits",
  "realtime",
  "realtime_active",
  "reasoning_effort",
  "reasoning_output_tokens",
  "reasoning_tokens",
  "removedTypes",
  "response_id",
  "role",
  "root_turn_id",
  "sandbox_policy",
  "scrubbed_unparseable_line",
  "secondary",
  "secs",
  "server_tool_use",
  "service_tier",
  "sessionId",
  "session_id",
  "settings",
  "shell",
  "showConcurrencyNote",
  "skillCount",
  "skills",
  "source",
  "sourceToolAssistantUUID",
  "speed",
  "spend_control_reached",
  "started_at",
  "started_at_ms",
  "state",
  "status",
  "stderr",
  "stdout",
  "stop_details",
  "stop_reason",
  "stop_sequence",
  "subtype",
  "summary",
  "text",
  "thinking_tokens",
  "thread_id",
  "thread_settings",
  "thread_source",
  "thread_token_usage",
  "time_to_first_token_ms",
  "timestamp",
  "timezone",
  "toolUseID",
  "toolUseResult",
  "tool_use_id",
  "total_token_usage",
  "total_tokens",
  "turn_id",
  "turn_token_usage",
  "type",
  "usage",
  "userType",
  "uuid",
  "value",
  "version",
  "web_fetch_requests",
  "web_search_requests",
  "window_id",
  "wire_api",
  "workspace_roots",
]);
/** Keys whose whole value is tool or user data (or a user-keyed map, `settings`): inside,
 *  only these structural keys survive. */
const CONTAINER_KEYS = new Set([
  "input",
  "output",
  "content",
  "arguments",
  "result",
  "toolUseResult",
  "settings",
]);
const CONTAINER_STRUCT_KEYS = new Set([
  "type",
  "id",
  "tool_use_id",
  "call_id",
  "name",
  "is_error",
  "text",
  "content",
  "input",
  "output",
  "arguments",
  "citations",
  "annotations",
  "logprobs",
]);
/** The tools either CLI ships; a `name` outside this set is a user-defined (MCP) tool or text. */
const TOOL_NAMES = [
  "Agent",
  "Bash",
  "Edit",
  "Glob",
  "Grep",
  "NotebookEdit",
  "Read",
  "Skill",
  "Task",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "Write",
  "apply_patch",
  "exec_command",
  "shell",
  "shell_command",
  "update_plan",
  "view_image",
  "web_search",
  "write_stdin",
];
/** Closed value sets for the enum-bearing keys; a value outside its set is content. */
const ENUM_VALUES: Record<string, ReadonlySet<string>> = {
  type: new Set([
    "AgentMessage",
    "CommandExecution",
    "UserMessage",
    "agent_listing_delta",
    "assistant",
    "atis-latch",
    "attachment",
    "custom_tool_call",
    "custom_tool_call_output",
    "error",
    "event_msg",
    "file-history-snapshot",
    "function_call",
    "function_call_output",
    "hook_success",
    "input_json_delta",
    "input_text",
    "item_completed",
    "last-prompt",
    "managed",
    "message",
    "mode",
    "model",
    "output_text",
    "progress",
    "queue-operation",
    "read-only",
    "reasoning",
    "response_item",
    "restricted",
    "result",
    "session_meta",
    "skill_listing",
    "special",
    "summary",
    "system",
    "task_complete",
    "task_started",
    "text",
    "text_delta",
    "thinking",
    "thread_settings_applied",
    "token_count",
    "token_usage_record",
    "tool_result",
    "tool_use",
    "total_tokens_reminder",
    "turn_context",
    "unknown",
    "user",
    "web_search_call",
    "workspace-write",
    "world_state",
  ]),
  role: new Set(["assistant", "developer", "system", "user"]),
  model: new Set([
    "claude-sonnet-4-6",
    "claude-opus-4-6",
    "claude-haiku-4-5-20251001",
    "gpt-5.4",
    "gpt-5.4-mini",
    "<synthetic>",
  ]),
  "model_provider": new Set(["fake", "openai", "default", "copilot-env"]),
  source: new Set(["cli", "exec", "unified_exec_startup", "vscode"]),
  "thread_source": new Set(["user", "subagent"]),
  originator: new Set(["codex_exec", "codex_cli_rs", "codex_vscode"]),
  "stop_reason": new Set([
    "end_turn",
    "max_tokens",
    "pause_turn",
    "refusal",
    "stop_sequence",
    "tool_use",
  ]),
  "finish_reason": new Set(["length", "stop", "tool_calls"]),
  "service_tier": new Set(["standard", "priority", "batch"]),
  speed: new Set(["standard", "fast"]),
  entrypoint: new Set(["cli", "sdk-cli", "sdk-ts", "sdk-py"]),
  userType: new Set(["external", "ant"]),
  permissionMode: new Set(["default", "plan", "acceptEdits", "bypassPermissions", "dontAsk"]),
  promptSource: new Set(["sdk", "cli"]),
  operation: new Set(["dequeue", "enqueue"]),
  hookEvent: new Set([
    "SessionStart",
    "SessionEnd",
    "PreToolUse",
    "PostToolUse",
    "Stop",
    "UserPromptSubmit",
  ]),
  mode: new Set(["default", "normal", "plan", "acceptEdits", "bypassPermissions"]),
  effort: new Set(["low", "medium", "high", "xhigh", "ultra", "max"]),
  "reasoning_effort": new Set(["none", "minimal", "low", "medium", "high", "xhigh"]),
  summary: new Set(["auto", "concise", "detailed", "none"]),
  "approval_policy": new Set(["never", "on-request", "on-failure", "untrusted"]),
  "approvals_reviewer": new Set(["user", "auto_review"]),
  "wire_api": new Set(["responses", "chat"]),
  "limit_id": new Set(["codex"]),
  "plan_type": new Set(["free", "plus", "pro", "team", "enterprise"]),
  status: new Set(["available", "completed", "failed", "in_progress", "incomplete", "installed"]),
  object: new Set(["response", "list", "model", "chat.completion", "chat.completion.chunk"]),
  subtype: new Set(["success", "error", "init", "compact_boundary"]),
  name: new Set(TOOL_NAMES),
};
/** Keys whose NUMBER survives outside a container: the token buckets the readers price, the
 *  clocks and durations, and the structural counts and offsets. Any other number (an account
 *  or phone number typed into a prompt, a figure inside tool output) is content. */
const NUMERIC_KEYS = new Set([
  "addedLines",
  "apiBlockIndex",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "cache_write_input_tokens",
  "cached_input_tokens",
  "completed_at",
  "completed_at_ms",
  "context_window",
  "create_time",
  "duration",
  "duration_ms",
  "end_byte_offset",
  "end_ordinal_exclusive",
  "ephemeral_1h_input_tokens",
  "ephemeral_5m_input_tokens",
  "exit_code",
  "forked_from_ordinal_exclusive",
  "input_tokens",
  "iterations",
  "model_context_window",
  "nanos",
  "ordinal",
  "output_tokens",
  "reasoning_output_tokens",
  "reasoning_tokens",
  "secs",
  "skillCount",
  "started_at",
  "started_at_ms",
  "thinking_tokens",
  "time_to_first_token_ms",
  "total_tokens",
  "web_fetch_requests",
  "web_search_requests",
]);
/** The number every other number becomes. */
const NUMBER_PLACEHOLDER = 0;
/** The key of a value with no owning key: the root record, an array element. */
const NO_KEY = "";
/** `version` / `cli_version` hold a release number, a shape rather than a vocabulary. */
const VERSION_KEYS = new Set(["version", "cli_version"]);
const VERSION_RE = /^\d+\.\d+\.\d+([.-][A-Za-z0-9.]+)?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIXED_ID_RE = /^(msg|toolu|call|fc|resp|rs|item|req|chatcmpl|agent)[_-]([A-Za-z0-9_-]+)$/;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

/** Prefixed ids shorter than this get a tail of this length: room for the pseudonym to be unique. */
const MIN_PSEUDONYM_TAIL = 8;

/** Deterministic per-run pseudonyms that keep an id's shape, so linkage survives the scrub. */
export class IdMap {
  private readonly seen = new Map<string, string>();
  private readonly assigned = new Set<string>();
  constructor(private readonly salt: string = randomUUID()) {}

  /** At least `length` hex characters, from as many digest blocks as that takes. */
  private digest(value: string, attempt: number, length: number): string {
    let hex = "";
    for (let block = 0; hex.length < length; block++) {
      hex += createHash("sha256").update(`${this.salt}\n${attempt}\n${block}\n${value}`).digest(
        "hex",
      );
    }
    return hex;
  }

  /** The pseudonym for an id-shaped string, or null when `value` is not one. Never the value
   *  itself and never one already handed out: a clash re-digests deterministically. */
  pseudonym(value: string): string | null {
    const known = this.seen.get(value);
    if (known !== undefined) return known;
    let shape: (hex: string) => string;
    let length: number;
    if (UUID_RE.test(value)) {
      length = 32;
      shape = (h) =>
        `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${
          h.slice(20, 32)
        }`;
    } else {
      const m = PREFIXED_ID_RE.exec(value);
      if (m === null) return null;
      const [, prefix, tail] = m as unknown as [string, string, string];
      const sep = value.charAt(prefix.length);
      length = Math.max(tail.length, MIN_PSEUDONYM_TAIL);
      shape = (h) => `${prefix}${sep}${h.slice(0, length)}`;
    }
    let out: string;
    for (let attempt = 0;; attempt++) {
      out = shape(this.digest(value, attempt, length));
      if (out !== value && !this.assigned.has(out)) break;
    }
    this.seen.set(value, out);
    this.assigned.add(out);
    return out;
  }
}

interface ScrubState {
  scrubbed: number;
}

/** Fail-closed: a string survives only as a pseudonymized id, a timestamp, a version, or one
 *  of its key's closed enum values; a number only DIRECTLY under a NUMERIC_KEYS key outside a
 *  container (an array element has no owning key); a key only when known (in a container:
 *  structural), and the value under an unknown key is content, container rules inside. */
function scrubValue(
  key: string,
  value: unknown,
  ids: IdMap,
  state: ScrubState,
  inContainer: boolean,
): unknown {
  // A scalar directly under a container key is that container's content.
  const nested = inContainer || CONTAINER_KEYS.has(key);
  if (typeof value === "string") {
    if (value === "") return value;
    const pseudonym = ids.pseudonym(value);
    if (pseudonym !== null) return pseudonym;
    if (!nested && ISO_TIMESTAMP_RE.test(value)) return value;
    if (!nested && VERSION_KEYS.has(key) && VERSION_RE.test(value)) return value;
    const enumKey = inContainer
      ? key === "type" || key === "name"
      : Object.hasOwn(ENUM_VALUES, key);
    if ((!nested || inContainer) && enumKey && ENUM_VALUES[key]!.has(value)) return value;
    state.scrubbed++;
    return PLACEHOLDER;
  }
  if (typeof value === "number") {
    if (!nested && NUMERIC_KEYS.has(key)) return value;
    state.scrubbed++;
    return NUMBER_PLACEHOLDER;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(NO_KEY, item, ids, state, nested));
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    let ordinal = 0;
    for (const [k, v] of Object.entries(value)) {
      const keep = nested ? CONTAINER_STRUCT_KEYS.has(k) : KNOWN_KEYS.has(k);
      let outKey = k;
      if (!keep) {
        state.scrubbed++;
        do outKey = `${PLACEHOLDER}_KEY_${ordinal++}`; while (outKey in value || outKey in out);
      }
      out[outKey] = scrubValue(k, v, ids, state, nested || !keep);
    }
    return out;
  }
  return value;
}

export interface ScrubbedText {
  text: string;
  lines: number;
  usageLines: number;
  scrubbedValues: number;
  /** Distinct `YYYY-MM-DDTHH:MM` minutes the records' own timestamps fall in. */
  minutes: number;
}

/** An assistant record whose message carries a usage object: what the Claude reader prices. */
export const isClaudeUsageLine = (record: unknown): boolean =>
  isRecord(record) && record.type === "assistant" && isRecord(record.message) &&
  isRecord(record.message.usage);

/** A token_count event carrying `last_token_usage`: what the Codex reader prices. */
export const isCodexUsageLine = (record: unknown): boolean =>
  isRecord(record) && record.type === "event_msg" && isRecord(record.payload) &&
  record.payload.type === "token_count" && isRecord(record.payload.info) &&
  isRecord(record.payload.info.last_token_usage);

/** Scrub one JSONL file's text; a line that is not JSON is replaced whole. */
export function scrubJsonl(
  text: string,
  isUsageLine: (record: unknown) => boolean,
  ids: IdMap,
): ScrubbedText {
  const state: ScrubState = { scrubbed: 0 };
  const minutes = new Set<string>();
  let usageLines = 0;
  let count = 0;
  const out = text.split("\n").map((line) => {
    if (line === "") return line;
    count++;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      state.scrubbed++;
      return JSON.stringify({ "scrubbed_unparseable_line": PLACEHOLDER });
    }
    if (isUsageLine(parsed)) usageLines++;
    if (
      isRecord(parsed) && typeof parsed.timestamp === "string" &&
      ISO_TIMESTAMP_RE.test(parsed.timestamp)
    ) {
      minutes.add(parsed.timestamp.slice(0, "YYYY-MM-DDTHH:MM".length));
    }
    return JSON.stringify(scrubValue(NO_KEY, parsed, ids, state, false));
  });
  return {
    text: out.join("\n"),
    lines: count,
    usageLines,
    scrubbedValues: state.scrubbed,
    minutes: minutes.size,
  };
}

const UUID_SEGMENT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLLOUT_FILE_RE =
  /^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const AGENT_FILE_RE = /^(agent-[A-Za-z0-9_-]+)\.jsonl$/;

/** The destination-relative path, judged position by position against each source's layout
 *  (Claude `<slug>/<uuid>[/subagents[/workflows/<name>]/agent-<id>.jsonl]`, Codex
 *  `YYYY/MM/DD/rollout-<stamp>-<uuid>.jsonl`): ids pseudonymized in place, other segments renamed. */
function scrubbedRelativePath(
  rel: string,
  source: Source,
  ids: IdMap,
  segmentNames: Map<string, string>,
): string {
  const segments = rel.split(/[\\/]/);
  const rename = (segment: string, index: number): string => {
    let renamed = segmentNames.get(segment);
    if (renamed === undefined) {
      const taken = new Set(segmentNames.values());
      // Never the raw segment itself (a user directory could be named like a placeholder).
      for (let n = segmentNames.size + 1;; n++) {
        renamed = index === 0 && source === "claude" ? `-scrubbed-cwd-${n}` : `scrubbed-${n}`;
        if (renamed !== segment && !taken.has(renamed)) break;
      }
      segmentNames.set(segment, renamed);
    }
    return renamed;
  };
  const last = segments.length - 1;
  return segments.map((segment, index) => {
    if (source === "codex") {
      const dateShape = index === 0 ? /^\d{4}$/ : /^\d{2}$/;
      if (index < 3 && index < last && dateShape.test(segment)) return segment;
      const rollout = index === last && index === 3 ? ROLLOUT_FILE_RE.exec(segment) : null;
      if (rollout !== null) {
        return `rollout-${rollout[1]}-${ids.pseudonym(rollout[2]!) ?? rollout[2]}.jsonl`;
      }
      return rename(segment, index);
    }
    if (index === 0) return rename(segment, index);
    if (index === 1) {
      const file = segment.endsWith(".jsonl") ? segment.slice(0, -".jsonl".length) : segment;
      if (UUID_SEGMENT_RE.test(file)) {
        return `${ids.pseudonym(file)}${segment.endsWith(".jsonl") ? ".jsonl" : ""}`;
      }
      return rename(segment, index);
    }
    if (index === 2 && segment === "subagents" && index < last) return segment;
    if (index === 3 && segment === "workflows" && index < last) return segment;
    // An agent file sits right under subagents/ (index 3) or under a workflow name (index 5).
    const agentPosition = index === last && segments[2] === "subagents" &&
      (index === 3 || (index === 5 && segments[3] === "workflows"));
    const agent = agentPosition ? AGENT_FILE_RE.exec(segment) : null;
    if (agent !== null) return `${ids.pseudonym(agent[1]!) ?? agent[1]}.jsonl`;
    return rename(segment, index);
  }).join("/");
}

interface SourceSummary {
  files: number;
  lines: number;
  usageLines: number;
  scrubbedValues: number;
  /** Files whose timestamps fall in two or more distinct minutes. */
  sessionsSpanningMinutes: number;
}

function copyScrubbed(
  source: Source,
  srcRoot: string,
  destRoot: string,
  isUsageLine: (record: unknown) => boolean,
  ids: IdMap,
): SourceSummary {
  const files: string[] = [];
  walkJsonl(srcRoot, files);
  files.sort();
  const segmentNames = new Map<string, string>();
  const summary: SourceSummary = {
    files: files.length,
    lines: 0,
    usageLines: 0,
    scrubbedValues: 0,
    sessionsSpanningMinutes: 0,
  };
  for (const file of files) {
    const dest = join(
      destRoot,
      scrubbedRelativePath(relative(srcRoot, file), source, ids, segmentNames),
    );
    mkdirSync(dirname(dest), { recursive: true });
    const result = scrubJsonl(readFileSync(file, "utf8"), isUsageLine, ids);
    writeFile(dest, result.text);
    summary.lines += result.lines;
    summary.usageLines += result.usageLines;
    summary.scrubbedValues += result.scrubbedValues;
    if (result.minutes >= 2) summary.sessionsSpanningMinutes++;
  }
  return summary;
}

// ---------- main ----------

/** `<out>` must be absent or empty: a stale file there would ship with the corpus. */
function ensureEmptyOut(out: string): void {
  if (!existsSync(out)) return;
  let entries: string[];
  try {
    entries = readdirSync(out);
  } catch {
    die("--out is not a readable directory");
  }
  if (entries.length > 0) die("--out is not empty; pick a fresh directory");
}

/** Remove every login artifact from the kept home; the failures come back for the summary. */
function stripLogins(home: string): string[] {
  const failures: string[] = [];
  for (
    const artifact of [
      join(home, ".codex", "auth.json"),
      join(home, ".claude", ".credentials.json"),
      join(home, ".claude", ".claude.json"),
      join(home, ".claude", "backups"),
    ]
  ) {
    try {
      if (!existsSync(artifact)) continue;
      rmSync(artifact, { recursive: true, force: true });
      ledger.removed.push(relative(ledger.out, artifact).replaceAll("\\", "/"));
    } catch (e) {
      failures.push(`could not remove a login artifact (${e instanceof Error ? e.name : "error"})`);
    }
  }
  return failures;
}

function terminationSignals(): Deno.Signal[] {
  return Deno.build.os === "windows" ? ["SIGINT", "SIGBREAK"] : ["SIGINT", "SIGTERM"];
}

async function main(): Promise<void> {
  const args = parseArgs(Deno.args);
  ensureEmptyOut(args.out);
  const failures: string[] = [];
  const trace: TracedRequest[] = [];
  const sources: Record<Source, SourceSummary | null> = { claude: null, codex: null };
  const home = join(args.out, "home");
  ledger.out = args.out;
  let finalized = false;

  /** The one exit path: strip logins, print the single summary line, exit. */
  const finalize = (code: number): never => {
    if (!finalized) {
      finalized = true;
      failures.push(...stripLogins(home));
      const recorded = SUMMARY_SOURCES.map((s) => sources[s]).filter((c) => c !== null);
      const summary = {
        "files": recorded.reduce((n, c) => n + c.files, 0),
        "lines": recorded.reduce((n, c) => n + c.lines, 0),
        "usageLines": {
          "claude": sources.claude?.usageLines ?? 0,
          "codex": sources.codex?.usageLines ?? 0,
        },
        "backend": args.real ? "real" : "fake",
        "requests": trace.length,
        "fakeUsage": args.real ? null : fakeUsageBySource(trace),
        "sources": sources,
        "written": ledger.written,
        "removed": ledger.removed,
        "failures": failures,
      };
      // One line, last on stdout: the consumer reads it with `tail -n 1 | jq`.
      console.log(JSON.stringify(summary));
    }
    Deno.exit(failures.length > 0 && code === 0 ? 1 : code);
  };
  const stop = (label: string): void => {
    failures.push(label);
    void registry.killAll();
  };
  const signals = terminationSignals();
  const onSignal = (): void => {
    failures.push("interrupted by a signal");
    void registry.killAll().then((clean) => {
      if (!clean) failures.push("a CLI child did not exit after the kill");
      finalize(130);
    });
  };
  for (const signal of signals) Deno.addSignalListener(signal, onSignal);
  // Terminal: the deadline kills everything, prints the one summary line and exits 1.
  const totalTimer = setTimeout(() => {
    failures.push("deadline");
    void registry.killAll().then((clean) => {
      if (!clean) failures.push("a CLI child did not exit after the kill");
      finalize(1);
    });
  }, TOTAL_DEADLINE_MS);

  try {
    for (const cli of ["claude", "codex"]) {
      const look = findCommand(cli);
      if (look.launchFailed) failures.push(`could not look for ${cli} (the resolver did not run)`);
      else if (look.path === null) failures.push(`${cli} is not on PATH`);
    }
    if (args.real) log("--real: turns run against the CLIs' real credentials and SPEND TOKENS");
    const work = join(home, "work");
    const turnsDir = join(home, "turns");
    mkdirSync(work, { recursive: true });
    mkdirSync(turnsDir, { recursive: true });
    writeFile(join(work, "corpus-note.txt"), "The corpus note: one line for the Read tool.\n");

    if (failures.length === 0) {
      const straddle = new MinuteStraddle();
      const fake = args.real ? null : await startInferenceFake(0, () => {}, {
        beforeReply: () => straddle.hold(),
        onRequest: (request: TracedRequest) => trace.push(request),
      });
      if (fake !== null) log("fake inference backend listening on loopback");
      let claudeIds: ClaudeIds | undefined;
      let codexIds: CodexIds | undefined;
      try {
        // Both CLIs run concurrently (separate homes), so the one minute wait serves both.
        [claudeIds, codexIds] = await Promise.all([
          recordClaude(home, work, fake?.baseUrl ?? null, straddle, turnsDir, stop),
          recordCodex(home, work, fake?.baseUrl ?? null, straddle, turnsDir, stop),
        ]);
      } finally {
        if (!(await registry.killAll())) failures.push("a CLI child did not exit after the kill");
        await fake?.close();
      }
      if (failures.length === 0) {
        failures.push(
          ...claudeEvidenceFailures(claudeIds, recordsUnder(join(home, ".claude", "projects"))),
          ...codexEvidenceFailures(codexIds, recordsUnder(join(home, ".codex", "sessions"))),
        );
        if (!args.real) failures.push(...requestTraceFailures(trace));
      }
    }
    const ids = new IdMap();
    sources.claude = copyScrubbed(
      "claude",
      join(home, ".claude", "projects"),
      join(args.out, "claude", "projects"),
      isClaudeUsageLine,
      ids,
    );
    sources.codex = copyScrubbed(
      "codex",
      join(home, ".codex", "sessions"),
      join(args.out, "codex", "sessions"),
      isCodexUsageLine,
      ids,
    );
    for (const source of SUMMARY_SOURCES) {
      const counts = sources[source];
      if (counts === null || failures.length > 0) continue;
      if (counts.files === 0) failures.push(`${source}: no session files were written`);
      if (counts.usageLines === 0) failures.push(`${source}: no usage lines were recorded`);
      if (!args.real && counts.sessionsSpanningMinutes === 0) {
        failures.push(`${source}: no session straddles a minute boundary`);
      }
    }
  } catch (e) {
    failures.push(`aborted: ${e instanceof Error ? e.name : "error"}`);
  } finally {
    clearTimeout(totalTimer);
    if (!(await registry.killAll())) failures.push("a CLI child did not exit after the kill");
    for (const signal of signals) Deno.removeSignalListener(signal, onSignal);
  }
  finalize(0);
}

if (import.meta.main) await main();
