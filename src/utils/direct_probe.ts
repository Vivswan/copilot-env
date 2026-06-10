// Live "does GitHub Copilot Direct actually work?" probe, shared by `agent codex`
// / `agent claude` (the auto-detect path) and `agent setup-clis`. Direct mode
// mints tokens via `gh auth token`, so a machine without an authenticated GitHub
// CLI — or where Copilot Direct rejects the request — must fall back to the local
// gateway proxy. Rather than guess, we WRITE a throwaway direct config into a temp
// home and run the agent CLI's own read-only smoke prompt against it; exit 0 means
// direct works. Cheap gates (CLI present, gh authenticated) run first so the
// common "no gh auth" case — e.g. CI — returns instantly without a model call.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { childPathPrepending, resolveCommand } from "./command.ts";
import { createStderrLogger } from "./logger.ts";

// Probe progress goes to stderr (consola), never stdout: the `--check`/`env`
// machine-readable paths never probe, so this narration can't pollute them.
const logger = createStderrLogger();

/** The trivial read-only prompt both CLIs run for the smoke test. */
export const PROBE_PROMPT = "Reply with the single word OK.";

/** A live model call can be slow; cap it and treat a timeout as "direct failed". */
export const PROBE_TIMEOUT_MS = 60_000;

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
}

export const CODEX_PROBE: ProbeDescriptor = {
  cli: "codex",
  homeEnvVar: "CODEX_HOME",
  args: (prompt) => ["exec", "--json", "--sandbox", "read-only", prompt],
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
};

/** Injectable I/O so unit tests decide the probe outcome without real model calls. */
export interface DirectProbeDeps {
  /** Resolve a CLI binary on PATH / via nvm (null = not installed). */
  resolveCommand?: (cmd: string) => string | null;
  /** True when `gh auth token` succeeds — given gh's RESOLVED path (nvm-safe). */
  ghAuthOk?: (ghPath: string) => boolean;
  /** Run the agent CLI's read-only smoke prompt at its RESOLVED path; true = exit 0. */
  runProbe?: (cliPath: string, args: string[], env: Record<string, string>) => boolean;
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
  const result = spawnSync(ghPath, ["auth", "token"], {
    stdio: "ignore",
    timeout: 5000,
    windowsHide: true,
    env: { ...process.env, PATH: childPathPrepending([dirname(ghPath)]) },
  });
  return !result.error && result.status === 0;
}

function defaultRunProbe(cliPath: string, args: string[], env: Record<string, string>): boolean {
  const result = spawnSync(cliPath, args, {
    stdio: "ignore",
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
    env: { ...process.env, ...env },
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

  logger.log(`  Probing GitHub Copilot Direct for ${descriptor.cli} …`);

  const cliPath = resolve(descriptor.cli);
  if (cliPath === null) {
    logger.log(`    • ${descriptor.cli} CLI not found → using the local gateway proxy`);
    return false;
  }
  const ghPath = resolve("gh");
  if (ghPath === null) {
    logger.log("    • GitHub CLI (gh) not found → using the local gateway proxy");
    return false;
  }
  logger.log("    • checking gh authentication …");
  if (!ghAuthOk(ghPath)) {
    logger.log(
      "    • gh is not authenticated (run `gh auth login`) → using the local gateway proxy",
    );
    return false;
  }
  logger.log(
    `    • running a read-only smoke prompt through ${descriptor.cli} (live model call, a few seconds) …`,
  );

  let tmpHome: string | null = null;
  try {
    tmpHome = mkdtempSync(join(tmpdir(), `copilot-env-${descriptor.cli}-`));
    writeDirectConfig(tmpHome);
    // Put the resolved CLI's and gh's bin dirs on the child PATH: the CLI may be a
    // node-shim and its direct config shells out to `gh` by name, so an nvm-only
    // toolchain must be reachable even if the parent never sourced nvm.
    const ok = runProbe(cliPath, descriptor.args(PROBE_PROMPT), {
      [descriptor.homeEnvVar]: tmpHome,
      PATH: childPathPrepending([dirname(cliPath), dirname(ghPath)]),
    });
    if (ok) {
      logger.success("    GitHub Copilot Direct is available");
    } else {
      logger.log("    • the Direct smoke prompt did not succeed → using the local gateway proxy");
    }
    return ok;
  } catch (e) {
    logger.log(
      `    • the Direct probe errored (${e instanceof Error ? e.message : String(e)}) → using the local gateway proxy`,
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
