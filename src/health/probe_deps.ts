// The injectable I/O surface behind `agent health`'s fact gathering (probe.ts): the ProbeDeps
// contract, its real implementation over the store, the daemon, gh, and the agent CLIs, and the
// `--live` CLI runner. Tests hand gatherFacts a partial override of this record.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { AGENT_CLIS } from "../agents/cli_install.ts";
import {
  CODEX_CATALOG_NOISE_RE,
  jsonOutputReason,
  PROBE_TIMEOUT_MS,
} from "../agents/live_probe.ts";
import { claudeDesktopStatus } from "../agents/claude_desktop.ts";
import { AutoupdateState, effectiveUpdateCooldownDays } from "../autoupdate/state.ts";
import type { ClaudeDesktopStatus } from "../claude/desktop_status.ts";
import { resolveClaudeHome } from "../claude/paths.ts";
import { CODEX_ENV_KEY } from "../codex/inspect.ts";
import { type CodexHostFarm, codexHostFarm, effectiveCodexHome } from "../codex/host.ts";
import { CopilotApiConfig } from "../copilot_api/config.ts";
import {
  Credential,
  ghAccountsLookFromSpawn,
  ghAuthTokenLookAsync,
  type GhTokenLook,
  runGhSpecAsync,
} from "../copilot_api/credential.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import {
  allProfileNames,
  type AuthProvider,
  CopilotEnvState,
  credentialProvider,
} from "../copilot_api/env_state.ts";
import { activeGhLogin, ghAuthStatusSpawnSpec } from "../copilot_api/gh_cli.ts";
import { CopilotApiPaths, profileHomeExists, resolveRootHome } from "../copilot_api/paths.ts";
import { copilotApiFallbackPort, copilotApiResolvePort } from "../copilot_api/port.ts";
import { classifyOwnedDaemonPid, pidAlive } from "../copilot_api/process.ts";
import { type SidecarStatus, sidecarStatus } from "../copilot_api/sidecar.ts";
import type { Profile, ProfileName } from "../copilot_api/profile.ts";
import { CopilotEnvRunState } from "../copilot_api/run_state.ts";
import { installedProxyVersion } from "../copilot_api/version.ts";
import { readResolvedVersionRecord, resolveMinimumReleaseAgeSeconds } from "../proxy_float.ts";
import { idleTimeoutMs } from "../copilot_api/idle_watchdog.ts";
import { persistedInferenceMs } from "../copilot_api/inference_activity.ts";
import { shellTargetFiles } from "../shell/integration.ts";
import {
  childEnvWithPath,
  cliSpawn,
  type CommandLook,
  findCommand,
  resolveCommand,
} from "../utils/command.ts";
import { readTextOrNull } from "../utils/fs.ts";
import * as fs from "../utils/fs_facade.ts";
import { readTextResult, type TextReadResult } from "../utils/fs_facade.ts";
import { type ProjectConfig, readProjectConfig } from "../utils/project_config.ts";
import { PROJECT_ROOT } from "../utils/root.ts";
import { packageVersion } from "../utils/version.ts";
import {
  type AutoupdateStatus,
  type CodexDirectAuthFacts,
  type LiveProbeFacts,
  type ProfileAuthFacts,
  type ProfileSlotFacts,
  type ProxyResolvedFacts,
  type RuntimePathsView,
  runtimePathsView,
} from "./facts.ts";
import { claudeLiveLaunch, codexLiveLaunch, type LiveLaunch } from "./live_launch.ts";

export interface ProbeDeps {
  root: string;
  /** READ-ONLY port resolution for a target (never reserves a profile port). */
  resolvePort(profile: Profile): string;
  /** The non-reserving port fallback when a state snapshot records none; never
   *  re-reads the addressed profile's recorded port (snapshot rule). */
  fallbackPort(profile: Profile): number;
  reach(url: string, timeoutMs: number): Promise<boolean>;
  /** Whether the responder at `url` carries copilot-api's x-trace-id identity header. */
  proxyIdentity(url: string, timeoutMs: number): Promise<boolean | null>;
  readState(profile: Profile): {
    port?: number;
    pid?: number;
    codexHome?: string;
    lastEnsureAt?: number;
  };
  /** Three-state identity of the tracked pid (classifyDaemonPid): "unknown" means the scan
   *  FAILED and must render as "could not verify", never as a confident "not tracked"; the
   *  boolean flatten this replaced read a broken scan as an orphan. */
  classifyTrackedPid(pid: number): Promise<"yes" | "no" | "unknown">;
  isPidAlive(pid: number): boolean;
  paths(profile: Profile): RuntimePathsView;
  /** Idle-watchdog inputs (injected for deterministic tests). */
  now(): number;
  idleTimeoutMs(): number;
  autoStartEnabled(): boolean;
  /** Epoch ms of the most recent inference request against `profile`'s daemon (the in-process
   *  observer's persisted `.activity.json` mark), or null. NOT moved by liveness `GET /` pings. */
  lastRequestMs(profile: Profile): number | null;
  /** Every named profile the system knows about (store slots + on-disk homes). */
  profileNames(): ProfileName[];
  /** A named profile's store slot view (never tokens). */
  profileSlot(name: ProfileName): ProfileSlotFacts;
  /** True when the named profile has an isolated daemon home on disk. */
  profileHomeExists(name: ProfileName): boolean;
  /** Failure arm kept (see CommandLook): the CLI/tool census rows render "not installed"
   *  verdicts, so an unproven look must stay marked instead of flattening into "absent". */
  commandLook(command: string): CommandLook;
  agentClis(): readonly { command: string; name: string }[];
  shellTargets(): string[];
  readFileSafe(path: string): string | null;
  /** Three-way read for the Claude settings file: its classification must keep "absent" and
   *  "unreadable" apart (the read-error verdict), where readFileSafe's null collapses them. */
  readFileResult(path: string): TextReadResult;
  installedProxyVersion(): string | null;
  /** The float's resolved-version record, or null when it has never resolved here. */
  proxyResolved(): ProxyResolvedFacts | null;
  /** The deno sidecar every proxy spawn runs on. */
  sidecar(): SidecarStatus;
  projectConfig(): ProjectConfig;
  proxyCooldownSeconds(): number;
  codexHome(): string;
  codexTokenInEnviron(): boolean;
  /** One `gh auth token` probe, pinned to `ghUser`'s account (null = gh's active). */
  codexDirectAuth(ghUser: string | null): Promise<CodexDirectAuthFacts>;
  /** True when a GitHub token is provisioned in the store (Direct needs no gh then). */
  storedTokenPresent(): boolean;
  /** The slot's stored token VALUE (null for gh-cli or none), compared against a baked static
   *  credential and never reported; throws when the store cannot be read. */
  storedToken(profile: Profile): string | null;
  /** The profile daemon's minted API key, or null when none exists yet. Read-only. */
  proxyApiKey(profile: Profile): string | null;
  /** The recorded auth provider (`copilot` | `gh-cli` | `gh-token` | `gh-env`), or null. */
  authProvider(): AuthProvider | null;
  /** The default slot's gh-cli account pin, or null (= follow gh's active account). */
  defaultGhUser(): string | null;
  /** The github.com login an auto gh-cli slot follows right now, or null. */
  ghActiveLogin(): Promise<string | null>;
  /** Named profiles: name -> recorded provider + mode (never tokens). */
  authProfiles(): Record<ProfileName, ProfileAuthFacts>;
  /** The `identity` config pin, or null when unset/`auto`. */
  pinnedIntegrationId(): string | null;
  claudeHome(): string;
  /** The per-host farm on disk (path, present, wired), from its one predicate. */
  codexHostFarm(): CodexHostFarm;
  /** The `codex.host` key read (CopilotEnvConfig.codexHostEnabled). */
  codexHostEnabled(): boolean;
  /** The Claude Desktop wiring status (read-only; see claudeDesktopStatus). */
  claudeDesktop(): ClaudeDesktopStatus;
  dirExists(path: string): boolean;
  readAutoupdate(): AutoupdateStatus;
  nodeModulesPresent(): boolean;
  nodeModulesFresh(): boolean;
  denoVersion(): string | null;
  cliVersion(): string;
  /** `--live` end-to-end prompts against the configured Codex/Claude homes;
   *  `profile` selects a named profile's wiring (never probed in the default sweep). */
  codexLive(home: string, profile: Profile): Promise<LiveProbeFacts>;
  claudeLive(home: string, profile: Profile): Promise<LiveProbeFacts>;
}

/** Probe the URL: any HTTP response (even an error status) means "reachable". */
async function reachUrl(url: string, timeoutMs: number): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

/** copilot-api stamps every response with an `x-trace-id` header: a cheap, unauthenticated
 *  identity marker. true when present, false when the responder answered without it (a foreign
 *  service on the port), null when nothing answered. */
async function proxyIdentity(url: string, timeoutMs: number): Promise<boolean | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.headers.has("x-trace-id");
  } catch {
    return null;
  }
}

/** A look's `unproven` (a spawn error, the timeout kill) marks the facts instead of flattening
 *  into a confident authenticated:false. `ghUser` records which pinned account the probe asked
 *  about; `ghCommand` the call that served a found token. */
function directAuthFromLook(
  command: string,
  look: GhTokenLook,
  ghUser: string | null = null,
): CodexDirectAuthFacts {
  const pinned = ghUser === null ? {} : { ghUser };
  const why = look.detail === undefined ? {} : { ghDetail: look.detail };
  if (look.unproven) {
    return { command, authenticated: false, unproven: true, ...pinned, ...why };
  }
  const served = look.command === undefined ? {} : { ghCommand: look.command };
  return { command, authenticated: look.token !== null, ...pinned, ...served, ...why };
}

/** Null when gh is absent, has no account, or the look never completed: naming only, never a
 *  verdict, so the flatten is safe. Async like codexDirectAuth so the status spawn overlaps the
 *  other probes; runGhSpecAsync captures both streams (older gh wrote the status to stderr) and a
 *  timeout kill reads as unproven, so a truncated list can never name the wrong account. */
async function ghActiveLoginProbe(): Promise<string | null> {
  const look = findCommand("gh");
  if (look.path === null) return null;
  const listing = ghAccountsLookFromSpawn(await runGhSpecAsync(ghAuthStatusSpawnSpec(look.path)));
  return listing.unproven ? null : activeGhLogin(listing.accounts);
}

async function codexDirectAuth(ghUser: string | null): Promise<CodexDirectAuthFacts> {
  // The failure arm is kept: this fact renders auth VERDICTS ("GitHub CLI not found", "not
  // authenticated"), so a look that never ran must arrive marked, not as a proven absence.
  const look = findCommand("gh");
  if (look.path === null) {
    return {
      command: null,
      authenticated: false,
      ...(look.launchFailed ? { unproven: true as const } : {}),
      ...(ghUser === null ? {} : { ghUser }),
    };
  }
  // The SAME recipe `agent auth` and every resolve run (the pinned look and its fallback), off the
  // event loop so it overlaps the other probes under gatherFacts' Promise.all. The token is read
  // into memory with the rest of gh's output and only the verdict and the serving call are kept.
  return directAuthFromLook(look.path, await ghAuthTokenLookAsync(ghUser, look.path), ghUser);
}

/** The CLI's output, line for line, so `agent health --live` shows the complete error: a JSON
 *  event that reports an error stands in as its reason text (jsonOutputReason), every other line
 *  is verbatim, and codex's catalog lines are dropped (noise). With no output (a timeout kill:
 *  code null + signal) the bare exit/timeout status keeps the detail from being blank. */
function formatLiveFailure(
  code: number | null,
  signal: string | null,
  errorMessage: string | undefined,
  stdout: string,
  stderr: string,
): string {
  const lines = `${stderr}\n${stdout}`
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() && !CODEX_CATALOG_NOISE_RE.test(l))
    .map((l) => jsonOutputReason(l.trim()) ?? l);
  if (lines.length) return lines.join("\n");
  if (errorMessage) return errorMessage;
  if (code === null && signal) {
    return `no response within ${Math.round(PROBE_TIMEOUT_MS / 1000)}s (killed by ${signal})`;
  }
  return `exit ${code ?? "?"}`;
}

/**
 * Unlike the init probe, the environment is NOT sanitized (`--live` tests the real, fully
 * resolved setup), except `launch.omitEnv` (upper-case names): the narrow scrub a NAMED profile
 * needs so a shell export of the DEFAULT wiring cannot override the profile's own and
 * misattribute the answer. Spawns the RESOLVED path so the nvm fallback is not defeated. Exported
 * for the scrub's test.
 */
export function runLiveCli(
  launch: LiveLaunch,
  find: (command: string) => CommandLook = findCommand,
): Promise<LiveProbeFacts> {
  // `find` is a test seam; the real look keeps its failure arm (see CommandLook) because the
  // skip renders a "CLI not installed" verdict.
  const look = find(launch.cli);
  if (look.path === null) {
    return Promise.resolve(
      look.launchFailed ? { kind: "skipped", lookFailed: true } : { kind: "skipped" },
    );
  }
  const resolved = look.path;
  const ghPath = resolveCommand("gh");
  return new Promise((resolve) => {
    const s = cliSpawn(resolved, launch.args);
    // Output is captured so a failure reports the FULL reason. The 64 MB cap is effectively
    // unbounded (a smoke prompt's output is tiny) and only guards a pathologically chatty CLI.
    // nosemgrep: javascript.lang.security.audit.spawn-shell-true.spawn-shell-true -- Windows-only, for .cmd shims; the spec quotes args
    const child = spawn(s.file, s.args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
      shell: s.shell,
      // The resolved CLI's and gh's bin dirs lead the child PATH so an nvm-only toolchain (a
      // node-shim CLI, the config's bare `gh` call) is reachable even when the parent never
      // sourced nvm.
      env: childEnvWithPath([dirname(resolved), ghPath ? dirname(ghPath) : null], {
        extra: launch.env,
        omit: (upper) => launch.omitEnv.includes(upper),
      }),
    });
    const CAP = 64 * 1024 * 1024;
    let out = "";
    let err = "";
    child.stdout?.on("data", (d: Buffer) => {
      if (out.length < CAP) out += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (err.length < CAP) err += d.toString();
    });
    child.on("error", (e: Error) =>
      resolve({
        kind: "failed",
        cli: resolved,
        detail: formatLiveFailure(null, null, e.message, out, err),
      }));
    child.on("close", (code, signal) => {
      if (code === 0 && launch.answered(out)) {
        resolve({ kind: "ok", cli: resolved });
      } else {
        const reason = formatLiveFailure(code, signal, undefined, out, err);
        resolve({
          kind: "failed",
          cli: resolved,
          detail: code === 0 ? `exit 0 without a model answer\n${reason}` : reason,
        });
      }
    });
  });
}

export function defaultProbeDeps(): ProbeDeps {
  const root = PROJECT_ROOT;
  return {
    root,
    resolvePort: copilotApiResolvePort,
    fallbackPort: copilotApiFallbackPort,
    reach: reachUrl,
    proxyIdentity,
    readState: (profile) => CopilotEnvRunState.forProfile(profile).read(),
    // The owner-gated three-state, not bare classifyDaemonPid: the boolean scan this replaced
    // was owner-filtered, so an elevated Windows health run must not start claiming another
    // user's daemon as our tracked pid.
    classifyTrackedPid: classifyOwnedDaemonPid,
    isPidAlive: pidAlive,
    now: () => Date.now(),
    idleTimeoutMs: () => idleTimeoutMs(),
    autoStartEnabled: () => new CopilotEnvConfig().autoStartEnabled(),
    lastRequestMs: (profile) => {
      const m = persistedInferenceMs(profile);
      return m > 0 ? m : null;
    },
    paths: (profile) => runtimePathsView(new CopilotApiPaths(profile)),
    profileNames: allProfileNames,
    profileSlot: (name) => {
      const store = new CopilotEnvState();
      const { exists, slot } = store.profileSlotStatus(name);
      return {
        exists,
        provider: credentialProvider(slot.credential),
        mode: slot.mode,
        storedToken: slot.credential.kind === "stored",
        ghUser: slot.credential.kind === "gh-cli" ? slot.credential.ghUser : null,
      };
    },
    profileHomeExists,
    commandLook: findCommand,
    agentClis: () => AGENT_CLIS,
    shellTargets: shellTargetFiles,
    readFileSafe: readTextOrNull,
    readFileResult: readTextResult,
    installedProxyVersion: () => installedProxyVersion(root),
    proxyResolved: () => {
      const record = readResolvedVersionRecord(resolveRootHome());
      if (record === null) return null;
      return { ...record, cached: fs.exists(record.denoDir) };
    },
    sidecar: () => sidecarStatus(resolveRootHome()),
    projectConfig: () => readProjectConfig(),
    proxyCooldownSeconds: () => resolveMinimumReleaseAgeSeconds(),
    codexHome: effectiveCodexHome,
    codexTokenInEnviron: () => Boolean(process.env[CODEX_ENV_KEY]),
    codexDirectAuth,
    storedTokenPresent: () => new CopilotEnvState().read().githubToken !== null,
    storedToken: (profile) => {
      const credential = new Credential(undefined, profile).read();
      return credential.kind === "stored" ? credential.token : null;
    },
    proxyApiKey: (profile) => CopilotApiConfig.forProfile(profile).apiKey(),
    authProvider: () => new CopilotEnvState().read().authProvider,
    defaultGhUser: () => new CopilotEnvState().read().ghUser,
    ghActiveLogin: ghActiveLoginProbe,
    authProfiles: () => {
      // Sweep via profileNames() (the store's validated, sorted view), never the raw record: its
      // keys are a trust boundary, and only profileNames() mints the brand.
      const store = new CopilotEnvState();
      const profiles: Record<ProfileName, ProfileAuthFacts> = {};
      for (const name of store.profileNames()) {
        const slot = store.readProfileSlot(name);
        profiles[name] = {
          provider: credentialProvider(slot.credential),
          mode: slot.mode,
        };
      }
      return profiles;
    },
    pinnedIntegrationId: () => new CopilotEnvConfig().pinnedIntegrationId(null),
    claudeHome: () => resolveClaudeHome(),
    codexHostFarm,
    codexHostEnabled: () => new CopilotEnvConfig().codexHostEnabled(),
    claudeDesktop: claudeDesktopStatus,
    dirExists: (path: string) => fs.exists(path),
    readAutoupdate: () => ({
      ...new AutoupdateState().read(),
      enabled: new CopilotEnvConfig().autoUpdateEnabled(),
      cooldownDays: effectiveUpdateCooldownDays(),
    }),
    nodeModulesPresent: () => fs.exists(join(root, "node_modules")),
    nodeModulesFresh: () => {
      // Same predicate as bin/agent's freshness gate: node_modules at least as new as deno.lock.
      try {
        const lock = fs.stat(join(root, "deno.lock")).mtimeMs;
        const modules = fs.stat(join(root, "node_modules")).mtimeMs;
        return modules >= lock;
      } catch {
        return false;
      }
    },
    denoVersion: () => Deno.version.deno,
    cliVersion: packageVersion,
    codexLive: (home, profile) => runLiveCli(codexLiveLaunch(home, profile)),
    claudeLive: (home, profile) => runLiveCli(claudeLiveLaunch(home, profile)),
  };
}
