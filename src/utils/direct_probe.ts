// Live "does GitHub Copilot Direct actually work?" probe, shared by `agent codex`
// / `agent claude` (the auto-detect path) and `agent setup-clis`. Direct mode
// mints tokens via `gh auth token`, so a machine without an authenticated GitHub
// CLI — or where Copilot Direct rejects the request — must fall back to the local
// proxy. Rather than guess, we WRITE a throwaway direct config into a temp
// home and run the agent CLI's own read-only smoke prompt against it; exit 0 means
// direct works. Cheap gates (CLI present, gh authenticated) run first so the
// common "no gh auth" case — e.g. CI — returns instantly without a model call. Two
// guards keep the live test honest: the child env is SANITIZED (the descriptor's
// provider vars are dropped) so a leaked shell export can't hijack auth, and the
// single live call is RETRIED so a transient blip doesn't silently flip a working
// Direct setup to proxy.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { childPathPrepending, cliSpawn, resolveCommand } from "./command.ts";
import { createStderrLogger } from "./logger.ts";

// Probe progress goes to stderr (consola), never stdout: the `--check`/`env`
// machine-readable paths never probe, so this narration can't pollute them.
const logger = createStderrLogger();

/** The trivial read-only prompt both CLIs run for the smoke test. */
export const PROBE_PROMPT = "Reply with the single word OK.";

/** A live model call can be slow; cap it and treat a timeout as "direct failed". */
export const PROBE_TIMEOUT_MS = 60_000;

/** Retry the live smoke call this many times before concluding Direct fails. */
export const DEFAULT_PROBE_RETRIES = 3;

/** Base backoff before each retry (multiplied by the attempt index: 600ms, 1200ms). */
export const DEFAULT_PROBE_RETRY_DELAY_MS = 600;

/**
 * A failed attempt that ran for ~this fraction of the timeout was a hang/outage,
 * not a transient blip — retrying would just burn another PROBE_TIMEOUT_MS, so we
 * stop and fall back immediately. Fast 4xx/5xx blips (the case worth retrying)
 * return well under this.
 */
const TIMEOUT_RETRY_FRACTION = 0.9;

/** Block the current thread for `ms` (the probe path is synchronous: spawnSync). */
function sleepSyncMs(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * How to drive one agent CLI's read-only smoke test: the binary, the env var that
 * points it at a config home, and the argv for a given prompt. Shared by the
 * temp-config detect below and the live health probe (src/health/probe.ts) so the
 * exact command never drifts between them.
 */
export interface ProbeDescriptor {
  cli: string;
  homeEnvVar: string;
  args: (prompt: string) => string[];
  /**
   * Provider env vars to DELETE from the probe child's environment so the
   * throwaway temp config — not a leaked shell export — decides where and how the
   * CLI authenticates. Without this a leaked `ANTHROPIC_AUTH_TOKEN` (which the CLI
   * honors over the config's apiKeyHelper) or a proxy `*_BASE_URL` makes the
   * "direct" smoke test authenticate the wrong way and fail even though Direct
   * works. The health probe (src/health/probe.ts) deliberately does NOT clear
   * these: it tests the user's real, fully-resolved environment.
   */
  clearEnv: string[];
}

export const CODEX_PROBE: ProbeDescriptor = {
  cli: "codex",
  homeEnvVar: "CODEX_HOME",
  args: (prompt) => ["exec", "--json", "--sandbox", "read-only", prompt],
  clearEnv: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
};

export const CLAUDE_PROBE: ProbeDescriptor = {
  cli: "claude",
  homeEnvVar: "CLAUDE_CONFIG_DIR",
  args: (prompt) => [
    "-p",
    "--permission-mode",
    "plan",
    "--verbose",
    "--output-format",
    "stream-json",
    prompt,
  ],
  clearEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"],
};

/** Injectable I/O so unit tests decide the probe outcome without real model calls. */
export interface DirectProbeDeps {
  /** Resolve a CLI binary on PATH / via nvm (null = not installed). */
  resolveCommand?: (cmd: string) => string | null;
  /** True when `gh auth token` succeeds — given gh's RESOLVED path (nvm-safe). */
  ghAuthOk?: (ghPath: string) => boolean;
  /** Run the agent CLI's read-only smoke prompt at its RESOLVED path; true = exit 0. */
  runProbe?: (cliPath: string, args: string[], env: Record<string, string>) => boolean;
  /** Extra live-call retries on failure (default DEFAULT_PROBE_RETRIES). */
  retries?: number;
  /** Base backoff ms between retries (default DEFAULT_PROBE_RETRY_DELAY_MS; 0 in tests). */
  retryDelayMs?: number;
}

/** The three mutually-exclusive provider-mode flags every agent command accepts. */
export interface ModeFlags {
  direct?: boolean;
  proxy?: boolean;
  auto?: boolean;
}

/** Reject more than one of --direct / --proxy / --auto on the same invocation. */
export function assertSingleMode(flags: ModeFlags): void {
  if ([flags.direct, flags.proxy, flags.auto].filter(Boolean).length > 1) {
    throw new Error("--direct, --proxy, and --auto are mutually exclusive");
  }
}

/**
 * Decide whether to write DIRECT (true) or PROXY (false): `--direct` forces
 * direct, `--proxy` forces proxy, and `--auto` (or no mode flag) runs the live
 * `detectDirect` probe. The detect callback is only invoked on the auto path.
 */
export function resolveDirect(flags: ModeFlags, detectDirect: () => boolean): boolean {
  if (flags.direct) return true;
  if (flags.proxy) return false;
  return detectDirect();
}

function defaultGhAuthOk(ghPath: string): boolean {
  // Spawn gh's RESOLVED path (not the bare name), with gh's bin dir on PATH, so an
  // nvm-only gh (or a node-shim gh) found via the nvm fallback is runnable here.
  // cliSpawn routes through cmd.exe on Windows so a .cmd/.exe shim is launchable.
  const s = cliSpawn(ghPath, ["auth", "token"]);
  const result = spawnSync(s.file, s.args, {
    stdio: "ignore",
    timeout: 5000,
    windowsHide: true,
    shell: s.shell,
    env: { ...process.env, PATH: childPathPrepending([dirname(ghPath)]) },
  });
  return !result.error && result.status === 0;
}

function defaultRunProbe(cliPath: string, args: string[], env: Record<string, string>): boolean {
  const s = cliSpawn(cliPath, args);
  // `env` is the COMPLETE child environment (process.env minus the descriptor's
  // cleared provider vars, plus the temp home + PATH) — built by probeDirectWorks.
  // Spawn with it verbatim; do NOT re-merge process.env or the cleared vars return.
  const result = spawnSync(s.file, s.args, {
    stdio: "ignore",
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
    shell: s.shell,
    env,
  });
  return !result.error && result.status === 0;
}

/**
 * Decide whether GitHub Copilot Direct works for an agent CLI. The CLI must be
 * installed, `gh` must be installed and authenticated, and a throwaway read-only
 * prompt against a temp direct config must exit 0. Any miss => false (the caller
 * configures proxy instead). Never throws; always removes the temp home. The gh
 * and agent-CLI RESOLVED paths are threaded to the spawns so the nvm fallback in
 * resolveCommand isn't defeated by spawning a bare (PATH-only) command name.
 */
export function probeDirectWorks(
  descriptor: ProbeDescriptor,
  writeDirectConfig: (tmpHome: string) => void,
  deps: DirectProbeDeps = {},
): boolean {
  const resolve = deps.resolveCommand ?? resolveCommand;
  const ghAuthOk = deps.ghAuthOk ?? defaultGhAuthOk;
  const runProbe = deps.runProbe ?? defaultRunProbe;
  const retries = deps.retries ?? DEFAULT_PROBE_RETRIES;
  const retryDelayMs = deps.retryDelayMs ?? DEFAULT_PROBE_RETRY_DELAY_MS;

  logger.log(`  Probing GitHub Copilot Direct for ${descriptor.cli} …`);

  const cliPath = resolve(descriptor.cli);
  if (cliPath === null) {
    logger.log(`    • ${descriptor.cli} CLI not found → using the local proxy`);
    return false;
  }
  const ghPath = resolve("gh");
  if (ghPath === null) {
    logger.log("    • GitHub CLI (gh) not found → using the local proxy");
    return false;
  }
  logger.log("    • checking gh authentication …");
  if (!ghAuthOk(ghPath)) {
    logger.log("    • gh is not authenticated (run `gh auth login`) → using the local proxy");
    return false;
  }
  logger.log(
    `    • running a read-only smoke prompt through ${descriptor.cli} (live model call, a few seconds) …`,
  );

  let tmpHome: string | null = null;
  try {
    tmpHome = mkdtempSync(join(tmpdir(), `copilot-env-${descriptor.cli}-`));
    writeDirectConfig(tmpHome);
    // Build the COMPLETE child environment: every inherited var EXCEPT the
    // descriptor's provider vars (so a leaked ANTHROPIC_AUTH_TOKEN / proxy
    // *_BASE_URL can't hijack the "direct" test), then the temp home + a PATH that
    // puts the resolved CLI's and gh's bin dirs first (the CLI may be a node-shim
    // and its direct config shells out to `gh` by name, so an nvm-only toolchain
    // must be reachable even if the parent never sourced nvm).
    const cleared = new Set(descriptor.clearEnv);
    const childEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !cleared.has(key)) childEnv[key] = value;
    }
    childEnv[descriptor.homeEnvVar] = tmpHome;
    childEnv.PATH = childPathPrepending([dirname(cliPath), dirname(ghPath)]);

    // The smoke call is a single live model call, so a transient blip (a fast
    // 4xx/5xx, a momentary network hiccup) must not silently downgrade a working
    // Direct setup to proxy. Retry on failure — but a near-timeout failure is a
    // hang/outage, not a blip, so stop rather than burn another PROBE_TIMEOUT_MS.
    const args = descriptor.args(PROBE_PROMPT);
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        logger.log(
          `    • smoke prompt failed; retrying (attempt ${attempt + 1} of ${retries + 1}) …`,
        );
        sleepSyncMs(retryDelayMs * attempt);
      }
      const startedAt = Date.now();
      if (runProbe(cliPath, args, childEnv)) {
        logger.success("    GitHub Copilot Direct is available");
        return true;
      }
      if (Date.now() - startedAt >= PROBE_TIMEOUT_MS * TIMEOUT_RETRY_FRACTION) break;
    }
    logger.log("    • the Direct smoke prompt did not succeed → using the local proxy");
    return false;
  } catch (e) {
    logger.log(
      `    • the Direct probe errored (${e instanceof Error ? e.message : String(e)}) → using the local proxy`,
    );
    return false;
  } finally {
    if (tmpHome !== null) {
      try {
        rmSync(tmpHome, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
}
