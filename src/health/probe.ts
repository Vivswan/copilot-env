// I/O fact-gathering for `agent health`. Each scope gathers ONLY the facts it needs; the
// `runtime` scope stays minimal (no shell or CLI probes), though the tracked-pid check still
// spawns `ps`/PowerShell. The pure sub-evaluators (evalShellFiles, evalCodex) take raw content
// so they unit-test without touching the world.
import { join } from "node:path";
import { defaultSetupNeedsProxy } from "../agents/wiring.ts";
import {
  bakedClaudeToken,
  type ClaudeWiringStatus,
  inspectClaudeWiring,
} from "../claude/config.ts";
import { settingsPathFor } from "../claude/paths.ts";
import { bakedCodexToken, type CodexWiringStatus, inspectCodexWiring } from "../codex/config.ts";
import { codexConfigPath, codexProfileConfigPath } from "../codex/paths.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import {
  type AuthProvider,
  type ProfileMode,
  storedCredentialKind,
} from "../copilot_api/env_state.ts";
import { proxyLoopbackOrigin } from "../copilot_api/port.ts";
import type { Profile, ProfileName } from "../copilot_api/profile.ts";
import { proxyVersionBoundsStatus } from "../copilot_api/version.ts";
import { proxyFloatSkips } from "../proxy_float.ts";
import { hasMarker, MARKER } from "../shell/integration.ts";
import { errMessage } from "../utils/error.ts";
import type { TextReadResult } from "../utils/fs_facade.ts";
import {
  type BakedCredentialFreshness,
  classifyPortState,
  type ClaudeFacts,
  type CodexDirectAuthFacts,
  type CodexFacts,
  type DaemonProbed,
  type DefaultRuntimeTarget,
  type HealthFacts,
  type NamedRuntimeTarget,
  type RuntimeTarget,
  type RuntimeTargetCommon,
  type ShellFacts,
  type ShellFileFact,
} from "./facts.ts";
import { defaultProbeDeps, type ProbeDeps } from "./probe_deps.ts";
import type { HealthScope } from "./types.ts";
import {
  AUTH_SCOPES as SCOPE_AUTH,
  BOOTSTRAP_SCOPES as SCOPE_BOOTSTRAP,
  CLAUDE_LIVE_SCOPES as SCOPE_CLAUDE_LIVE,
  CLAUDE_SCOPES as SCOPE_CLAUDE,
  CODEX_LIVE_SCOPES as SCOPE_CODEX_LIVE,
  CODEX_SCOPES as SCOPE_CODEX,
  PROFILE_SWEEP_SCOPES as SCOPE_PROFILE_SWEEP,
  RUNTIME_SCOPES as SCOPE_RUNTIME,
  SETUP_SCOPES as SCOPE_SETUP,
} from "./types.ts";

// --- pure sub-evaluators (no I/O) -------------------------------------------

/** launchersWired is the `shell.launchers` config key (see ShellFacts). */
export function evalShellFiles(
  contents: { path: string; content: string | null }[],
  launchersEnabled: boolean,
): ShellFacts {
  const files: ShellFileFact[] = contents.map(({ path, content }) => ({
    path,
    hasIntegration: content !== null && hasMarker(content, MARKER),
  }));
  return {
    files,
    integrationWired: files.some((f) => f.hasIntegration),
    launchersWired: launchersEnabled,
  };
}

/** A thin wrapper over `inspectCodexWiring` (the single source of the wiring contract) that
 *  attaches the home being inspected. */
export function evalCodex(
  home: string,
  configToml: TextReadResult | string | null,
  envText: string | null,
  expectedPort: number,
  envKeyInEnviron: boolean,
  directAuth: CodexDirectAuthFacts = { command: null, authenticated: false },
  directNeedsNoGh = false,
  // gatherFacts already inspected the wiring to gate the gh probe; accepting it avoids a second
  // parse. Tests call without it and parse internally.
  wiring: CodexWiringStatus = inspectCodexWiring(
    configToml,
    envText,
    expectedPort,
    envKeyInEnviron,
  ),
): CodexFacts {
  return {
    home,
    directAuth,
    directNeedsNoGh,
    ...wiring,
  };
}

export function evalClaude(
  home: string,
  directAuth: CodexDirectAuthFacts,
  directUsesToken: boolean,
  wiring: ClaudeWiringStatus,
  profile: Profile = null,
): ClaudeFacts {
  return {
    home,
    settingsPath: settingsPathFor(home, profile),
    directAuth,
    directUsesToken,
    ...wiring,
  };
}

// --- orchestration ----------------------------------------------------------

/**
 * READ-ONLY: nothing here writes a file or reserves a port. pid and port come from a single
 * run-state read (proxyStatus's rule), so a concurrent start/stop cannot pair one daemon's pid
 * with another's port; fallbackPort covers the no-recorded-port case without a second read. The
 * state is returned so the caller hands the SAME snapshot's pid to interrogateDaemon.
 */
function snapshotTarget(
  profile: Profile,
  deps: ProbeDeps,
  proxyExpectedFor: (port: number) => boolean,
): { state: ReturnType<ProbeDeps["readState"]>; common: RuntimeTargetCommon } {
  const state = deps.readState(profile);
  const portPersisted = state.port !== undefined;
  const port = state.port ?? deps.fallbackPort(profile);
  return {
    state,
    common: {
      proxyExpected: proxyExpectedFor(port),
      port,
      portPersisted,
      paths: deps.paths(profile),
      watchdog: {
        autoStart: deps.autoStartEnabled(),
        idleTimeoutMs: deps.idleTimeoutMs(),
        lastEnsureAt: state.lastEnsureAt ?? null,
        // The observer's persisted mark; our own reach/identity GET probes are not inference
        // POSTs, so health observing the proxy never moves these numbers.
        lastRequestMs: deps.lastRequestMs(profile),
        now: deps.now(),
      },
    },
  };
}

/** The reach/pid probes plus (in the full/proxy scopes) the identity request, reconciled into the
 *  target's PortState. */
async function interrogateDaemon(
  scope: HealthScope,
  deps: ProbeDeps,
  port: number,
  trackedPid: number | null,
  proxyExpected: boolean,
): Promise<DaemonProbed> {
  // proxyLoopbackOrigin, matching portListening: a localhost probe reads DOWN on Windows while
  // the proxy is up.
  const probeUrl = `${proxyLoopbackOrigin(port)}/`;
  // The pid identity is three-state (deps.classifyTrackedPid): "no tracked pid" is a genuine
  // "no", but a FAILED scan is "unknown", carried as pidScanUnproven beside the pidTracked
  // flatten so a broken `ps` renders as "could not verify" instead of a confident verdict.
  const [reachable, pidClass] = await Promise.all([
    deps.reach(probeUrl, 2000),
    trackedPid !== null
      ? deps.classifyTrackedPid(trackedPid)
      : Promise.resolve<"yes" | "no" | "unknown">("no"),
  ]);
  const pidTracked = pidClass === "yes";
  // The identity probe (an extra local request) runs only in the full/proxy scopes, never the
  // launchers' fast `runtime` probe, and only when something is reachable AND this target's
  // setup routes through the port: with both agents direct, nothing we manage talks to whatever
  // answers, so its identity is never grounds for a misroute warning.
  const identityConfirmed = SCOPE_BOOTSTRAP.includes(scope) && reachable && proxyExpected
    ? await deps.proxyIdentity(probeUrl, 2000)
    : null;
  return {
    kind: "probed",
    reachable,
    trackedPid,
    pidTracked,
    ...(pidClass === "unknown" ? { pidScanUnproven: true as const } : {}),
    pidAlive: trackedPid !== null ? deps.isPidAlive(trackedPid) : false,
    identityConfirmed,
    portState: classifyPortState({ proxyExpected, reachable, pidTracked, identityConfirmed }),
  };
}

/** Always interrogated, with the configured default port as the fallback: the historical
 *  fast-probe behavior. */
async function gatherDefaultTarget(
  scope: HealthScope,
  deps: ProbeDeps,
): Promise<DefaultRuntimeTarget> {
  // When nothing in the default setup routes to the local daemon (both agents direct AND
  // Claude's base URL not aimed at it), a down proxy must not read as a runtime failure.
  const { state, common } = snapshotTarget(null, deps, (targetPort) =>
    defaultSetupNeedsProxy({
      codexHome: deps.codexHome(),
      claudeHome: deps.claudeHome(),
      expectedPort: targetPort,
    }));
  return {
    profile: null,
    ...common,
    probe: await interrogateDaemon(
      scope,
      deps,
      common.port,
      state.pid ?? null,
      common.proxyExpected,
    ),
  };
}

/**
 * `proxyExpected` derives from the slot's recorded mode, or, with no slot but a home, is assumed
 * (a homed daemon may be running, and a daemon past its start records its port in run state).
 * The
 * daemon is interrogated only when a proxy is expected, the home exists, AND the port is
 * persisted: a DIRECT profile has no daemon, a homeless proxy slot has no persisted port, and an
 * unpersisted candidate port is never probed.
 */
async function gatherNamedTarget(
  name: ProfileName,
  scope: HealthScope,
  deps: ProbeDeps,
): Promise<NamedRuntimeTarget> {
  const slot = deps.profileSlot(name);
  const homeExists = deps.profileHomeExists(name);
  const proxyExpected = slot.mode === "proxy" || (homeExists && !slot.exists);
  const { state, common } = snapshotTarget(name, deps, () => proxyExpected);
  const skipWhy = !proxyExpected
    ? "no daemon expected (not a proxy-mode target)"
    : !homeExists
    ? "no daemon home on disk"
    : !common.portPersisted
    ? "no persisted port on this host"
    : null;
  return {
    profile: name,
    slot,
    homeExists,
    ...common,
    probe: skipWhy !== null
      ? { kind: "skipped", why: skipWhy }
      : await interrogateDaemon(scope, deps, common.port, state.pid ?? null, proxyExpected),
  };
}

/** `opts.profile` narrows the run to ONE named profile: its runtime target, its credential slot,
 *  and its per-agent wiring. The account-wide fact groups (bootstrap, proxy package,
 *  shell/CLI/tool setup, autoupdate, codex.host) are not gathered at all, so they cannot leak
 *  into a narrowed report. */
/** `profile` narrows the run to one named profile's target; with none, `namedSweep` (the
 *  default) adds every named profile's runtime target in the diagnostic scopes, and false is the
 *  default profile's own run: its daemon alone, as a named profile's run is its daemon alone. */
export async function gatherFacts(
  scope: HealthScope,
  opts: { live?: boolean; profile?: Profile; namedSweep?: boolean } = {},
  overrides?: Partial<ProbeDeps>,
): Promise<HealthFacts> {
  const deps: ProbeDeps = { ...defaultProbeDeps(), ...overrides };
  const profile = opts.profile ?? null;
  const namedSweep = opts.namedSweep ?? true;
  // The addressed target's resolved port (READ-ONLY: a named profile's reservation is peeked,
  // never made). Lazy and cached: only the scopes that inspect wiring resolve it, so a
  // runtime/auth run never computes a named profile's candidate port at all.
  let wiringPortCache: number | undefined;
  const wiringPort = (): number => (wiringPortCache ??= Number(deps.resolvePort(profile)));
  const facts: HealthFacts = { profile };

  // gh auth backs BOTH agents' direct mode: probed at most once per run AND per pinned account
  // (a default sweep can cross slots pinned to different gh accounts), asynchronously, so each
  // ~5s `gh auth token` call overlaps the other probes instead of serializing into the health
  // timeout. Jobs addressing the same account await the same promise.
  const directAuthCache = new Map<string | null, Promise<CodexDirectAuthFacts>>();
  const sharedDirectAuth = (ghUser: string | null): Promise<CodexDirectAuthFacts> => {
    let probe = directAuthCache.get(ghUser);
    if (probe === undefined) {
      probe = deps.codexDirectAuth(ghUser);
      directAuthCache.set(ghUser, probe);
    }
    return probe;
  };

  // The account an AUTO gh-cli slot follows right now, for the report's naming: probed once per
  // run, only when some auto gh-cli slot is actually being judged.
  let activeLoginCache: Promise<string | null> | undefined;
  const sharedActiveLogin = (): Promise<string | null> => (
    activeLoginCache ??= deps.ghActiveLogin()
  );
  // The auth verdict, plus the followed account's name on an AUTO slot (a pinned slot already
  // names itself via ghUser).
  const slotGhFacts = async (ghUser: string | null): Promise<CodexDirectAuthFacts> => {
    if (ghUser !== null) return await sharedDirectAuth(ghUser);
    // Both spawns start before either is awaited: two timing-out gh calls cost one 5s budget,
    // not two back to back.
    const [directAuth, activeLogin] = await Promise.all([
      sharedDirectAuth(null),
      sharedActiveLogin(),
    ]);
    return activeLogin === null ? directAuth : { ...directAuth, ghActiveLogin: activeLogin };
  };

  // The credential the run's Direct wiring resolves: the default store pair, or the narrowed
  // profile's own slot (named profiles never fall back). `mode` is the named slot's recorded
  // mode; the default run leaves it null and judges from the agents' own wiring instead of the
  // recorded default mode (recordDefaultMode). Cached; several jobs consult it.
  let credentialCache:
    | {
      provider: AuthProvider | null;
      storedToken: boolean;
      ghUser: string | null;
      mode: ProfileMode | null;
    }
    | undefined;
  const runCredential = (): {
    provider: AuthProvider | null;
    storedToken: boolean;
    ghUser: string | null;
    mode: ProfileMode | null;
  } => {
    if (credentialCache === undefined) {
      if (profile === null) {
        credentialCache = {
          provider: deps.authProvider(),
          storedToken: deps.storedTokenPresent(),
          ghUser: deps.defaultGhUser(),
          mode: null,
        };
      } else {
        const slot = deps.profileSlot(profile);
        credentialCache = {
          provider: slot.provider,
          storedToken: slot.storedToken,
          ghUser: slot.ghUser,
          mode: slot.mode,
        };
      }
    }
    return credentialCache;
  };

  // The (~5s) gh probe is skipped, and Direct reported as "uses token", only when the config is
  // `managed` (execs `agent auth --get`, or `agent profile <name> auth --get`) AND the credential classifies as a
  // stored token; gh-cli means a live gh probe. Classification is storedCredentialKind()
  // (env_state.ts): a leftover token with no provider is "none", so no gh probe (no implicit
  // fallback) and Direct never reads green. A static shape asks the store nothing: the value is in
  // the config, so no gh is needed whatever the store says. Shared by the Codex and Claude jobs.
  const directAuthFor = async (
    credential: "command" | "static" | "none",
  ): Promise<{ directAuth: CodexDirectAuthFacts; noGhNeeded: boolean }> => {
    const noProbe = { command: null, authenticated: false };
    if (credential === "static") return { directAuth: noProbe, noGhNeeded: true };
    const managed = credential === "command";
    const { provider, storedToken, ghUser } = runCredential();
    switch (storedCredentialKind(provider, storedToken)) {
      case "stored":
        return { directAuth: noProbe, noGhNeeded: managed };
      case "gh-cli":
        return { directAuth: await slotGhFacts(ghUser), noGhNeeded: false };
      case "none":
        return { directAuth: noProbe, noGhNeeded: false };
    }
  };

  // A static wiring holds the credential itself, so the store is consulted for ONE thing only:
  // whether the baked value is what a rewire would bake now. A store or daemon home that cannot
  // answer reads "unchecked", never a failure of the agent check (the value in the config is what
  // the agent uses) and never "fresh".
  const bakedFreshness = (
    mode: "direct" | "proxy",
    baked: string | null,
  ): BakedCredentialFreshness => {
    if (baked === null) return "unchecked";
    try {
      const expected = mode === "proxy" ? deps.proxyApiKey(profile) : deps.storedToken(profile);
      if (expected === null) return "unchecked";
      return expected === baked ? "fresh" : "stale";
    } catch {
      return "unchecked";
    }
  };

  // The store facts the checks frame a credential miss with. A static wiring omits the provider:
  // it resolves nothing at request time, so an unreadable store must not fail its agent check. A
  // named profile's recorded mode stays whatever the shape: the slot DEFINES the profile, and an
  // interrupted `profile <name> add` (slot flipped, agents not yet rewritten) must never read green.
  const storeFacts = (credential: "command" | "static" | "none" | null) => ({
    ...(credential === "static" ? {} : { provider: runCredential().provider }),
    ...(profile === null ? {} : { expectedMode: runCredential().mode }),
  });

  // The shape directAuthFor judges: a static wiring in EITHER mode carries its value, so the
  // store is never asked and no gh probe runs; a proxy command shape keeps the gh probe (the
  // daemon resolves the same credential).
  const authShapeOf = (wiring: ClaudeWiringStatus | CodexWiringStatus) =>
    wiring.credential === "static" || wiring.providerMode === "direct"
      ? wiring.credential ?? "none"
      : "none";

  const jobs: Promise<void>[] = [];

  if (SCOPE_RUNTIME.includes(scope)) {
    jobs.push(
      (async () => {
        if (profile !== null) {
          // Narrowed: exactly the addressed profile's target.
          facts.runtimes = [await gatherNamedTarget(profile, scope, deps)];
          return;
        }
        // The default target first, then every named profile in sorted order, but only in the
        // diagnostic scopes (PROFILE_SWEEP_SCOPES) of a sweeping run: the launchers' fast
        // `runtime` probe and the default profile's own run stay the default daemon alone.
        const names = namedSweep && SCOPE_PROFILE_SWEEP.includes(scope) ? deps.profileNames() : [];
        facts.runtimes = await Promise.all<RuntimeTarget>([
          gatherDefaultTarget(scope, deps),
          ...names.map((name) => gatherNamedTarget(name, scope, deps)),
        ]);
      })(),
    );
  }

  if (profile === null && SCOPE_BOOTSTRAP.includes(scope)) {
    jobs.push(
      (async () => {
        const sidecar = deps.sidecar();
        facts.bootstrap = {
          cliVersion: deps.cliVersion(),
          deno: { available: deps.denoVersion() !== null, version: deps.denoVersion() },
          // A compiled binary embeds its dependencies: no node_modules to judge.
          nodeModules: sidecar.standalone
            ? null
            : { present: deps.nodeModulesPresent(), fresh: deps.nodeModulesFresh() },
        };
        const resolved = deps.proxyResolved();
        // The version that would actually RUN, in the daemon entry's own precedence: the float's
        // recorded resolution, else the deno.json baseline in node_modules. Judging bounds on
        // anything else would grade a copy the daemon never loads.
        const version = resolved?.version ?? deps.installedProxyVersion();
        // A bad COPILOT_API_MIN_RELEASE_AGE / cooldown setting must not crash health.
        let cooldownSeconds: number | null = null;
        try {
          cooldownSeconds = deps.proxyCooldownSeconds();
        } catch {
          cooldownSeconds = null;
        }
        // Reading copilot-env.config can throw on a malformed/missing file; that becomes a
        // proxy-check failure rather than crashing the whole report. The exemption uses the
        // float's OWN skip predicate (not the runtime checks' looser both-direct read) so health
        // and the float can never disagree about whether the bounds are enforced.
        const floatSkips = proxyFloatSkips(deps.codexHome(), deps.claudeHome());
        try {
          facts.proxy = {
            version,
            bounds: proxyVersionBoundsStatus(version, deps.projectConfig()),
            configError: null,
            cooldownSeconds,
            floatSkips,
            resolved,
            sidecar,
          };
        } catch (e) {
          facts.proxy = {
            version,
            bounds: null,
            configError: errMessage(e),
            cooldownSeconds,
            floatSkips,
            resolved,
            sidecar,
          };
        }
      })(),
    );
  }

  if (SCOPE_CODEX.includes(scope)) {
    jobs.push(
      (async () => {
        const home = deps.codexHome();
        // config.toml is read three-way (deps.readFileResult) so an unreadable file classifies
        // other/read-error instead of collapsing into the absent/none verdict readFileSafe's null
        // would produce; the .env read stays don't-care (absence and unreadability are alike).
        const configRead = deps.readFileResult(codexConfigPath(home));
        const envText = deps.readFileSafe(join(home, ".env"));
        // A named profile inspects ITS selection (`<name>.config.toml` over the suffixed provider
        // table in config.toml) against ITS resolved port; the profile file is read three-way for
        // the same reason config.toml is.
        const wiring = inspectCodexWiring(
          configRead,
          envText,
          wiringPort(),
          deps.codexTokenInEnviron(),
          profile === null ? { profile } : {
            profile,
            profileToml: deps.readFileResult(codexProfileConfigPath(home, profile)),
          },
        );
        const { directAuth, noGhNeeded } = await directAuthFor(
          authShapeOf(wiring),
        );
        // The wiring's `directUsesToken` stays a pure CONFIG fact; the store-aware "Direct needs
        // no gh" verdict travels on its own field (`directNeedsNoGh`, what checkCodex consumes).
        const codexFacts = evalCodex(
          home,
          configRead,
          envText,
          wiringPort(),
          deps.codexTokenInEnviron(),
          directAuth,
          wiring.providerMode === "direct" && noGhNeeded,
          wiring,
        );
        facts.codex = {
          ...codexFacts,
          ...storeFacts(wiring.credential),
          ...(wiring.credential === "static"
            ? {
              bakedCredential: bakedFreshness(
                wiring.providerMode === "direct" ? "direct" : "proxy",
                bakedCodexToken(configRead, profile),
              ),
            }
            : {}),
        };
      })(),
    );
  }

  if (SCOPE_CLAUDE.includes(scope)) {
    jobs.push(
      (async () => {
        const home = deps.claudeHome();
        // A named profile answers from its own settings-<name>.json, read three-way
        // (deps.readFileResult) so an unreadable file classifies other/read-error, not "none".
        const settingsRead = deps.readFileResult(settingsPathFor(home, profile));
        // "direct" here means the credential shape truly is ours, addressed at THIS profile (never
        // a stale/foreign/mis-addressed helper); directAuthFor then decides the gh probe.
        const wiring = inspectClaudeWiring(settingsRead, wiringPort(), profile);
        const { directAuth, noGhNeeded } = await directAuthFor(
          authShapeOf(wiring),
        );
        facts.claude = {
          ...evalClaude(
            home,
            directAuth,
            wiring.providerMode === "direct" && noGhNeeded,
            wiring,
            profile,
          ),
          ...storeFacts(wiring.credential),
          ...(wiring.credential === "static"
            ? {
              bakedCredential: bakedFreshness(
                wiring.providerMode === "direct" ? "direct" : "proxy",
                bakedClaudeToken(settingsRead),
              ),
            }
            : {}),
        };
        // The Desktop library spans the default AND every profile, so it is judged once, on the
        // whole-environment run only.
        if (profile === null) facts.claudeDesktop = deps.claudeDesktop();
      })(),
    );
  }

  if (SCOPE_AUTH.includes(scope)) {
    if (profile !== null) {
      // The addressed profile's slot line only: a named profile never falls back to the default
      // credential. Every field comes from ONE profileSlot() snapshot, so a concurrent write
      // cannot pair its provider with another's token.
      //
      //   the store cannot be read -> the failure propagates (profileHomeNames' strict stance)
      //   slot: null               -> the store WAS read and holds no slot, never an unproven empty
      jobs.push(
        (async () => {
          const slot = deps.profileSlot(profile);
          const gh = storedCredentialKind(slot.provider, slot.storedToken) === "gh-cli"
            ? await slotGhFacts(slot.ghUser)
            : null;
          facts.profileAuth = {
            name: profile,
            slot: slot.exists
              ? {
                provider: slot.provider,
                mode: slot.mode,
              }
              : null,
            storedToken: slot.storedToken,
            ghAuthenticated: gh?.authenticated ?? false,
            ...(gh?.ghUser != null ? { ghUser: gh.ghUser } : {}),
            ...(gh?.ghActiveLogin != null ? { ghActiveLogin: gh.ghActiveLogin } : {}),
            ...(gh?.ghCommand !== undefined ? { ghCommand: gh.ghCommand } : {}),
            ...(gh?.ghDetail !== undefined ? { ghDetail: gh.ghDetail } : {}),
            ...(gh?.unproven ? { ghAuthUnproven: true as const } : {}),
          };
        })(),
      );
    } else {
      jobs.push(
        (async () => {
          // gh is a credential ONLY when storedCredentialKind() says gh-cli (no implicit
          // fallback); reuses the shared (cached) gh probe, so no extra spawn.
          const provider = deps.authProvider();
          const storedToken = deps.storedTokenPresent();
          const gh = storedCredentialKind(provider, storedToken) === "gh-cli"
            ? await slotGhFacts(deps.defaultGhUser())
            : null;
          facts.auth = {
            storedToken,
            ghAuthenticated: gh?.authenticated ?? false,
            ...(gh?.ghUser != null ? { ghUser: gh.ghUser } : {}),
            ...(gh?.ghActiveLogin != null ? { ghActiveLogin: gh.ghActiveLogin } : {}),
            ...(gh?.ghCommand !== undefined ? { ghCommand: gh.ghCommand } : {}),
            ...(gh?.ghDetail !== undefined ? { ghDetail: gh.ghDetail } : {}),
            ...(gh?.unproven ? { ghAuthUnproven: true as const } : {}),
            provider,
            profiles: deps.authProfiles(),
            pinnedIntegrationId: deps.pinnedIntegrationId(),
          };
        })(),
      );
    }
  }

  // `--live` runs each agent's smoke prompt against its CONFIGURED home (a named profile's narrowing
  // routes it through that profile's wiring), only in the agent-focused scopes and only when
  // asked for (a slow live model call). The default sweep never runs per-profile live probes.
  if (opts.live && SCOPE_CODEX_LIVE.includes(scope)) {
    jobs.push(
      (async () => {
        facts.codexLive = await deps.codexLive(deps.codexHome(), profile);
      })(),
    );
  }
  if (opts.live && SCOPE_CLAUDE_LIVE.includes(scope)) {
    jobs.push(
      (async () => {
        facts.claudeLive = await deps.claudeLive(deps.claudeHome(), profile);
      })(),
    );
  }

  if (profile === null && SCOPE_SETUP.includes(scope)) {
    jobs.push(
      (async () => {
        // Resolving shell targets shells out to PowerShell on Windows and can throw; degrade to
        // "no targets" rather than crashing the diagnostic, but MARKED (targetsUnproven), so the
        // empty census renders "could not check", never a confident "not wired".
        let targets: string[] = [];
        let targetsUnproven = false;
        try {
          targets = deps.shellTargets();
        } catch {
          targetsUnproven = true;
        }
        const contents = targets.map((path) => ({ path, content: deps.readFileSafe(path) }));
        facts.shell = {
          ...evalShellFiles(contents, new CopilotEnvConfig().launchersEnabled()),
          ...(targetsUnproven ? { targetsUnproven: true as const } : {}),
        };
        facts.clis = deps.agentClis().map((c) => ({
          command: c.command,
          name: c.name,
          look: deps.commandLook(c.command),
        }));
        facts.tools = { node: deps.commandLook("node"), npm: deps.commandLook("npm") };
        const farm = deps.codexHostFarm();
        facts.codexHost = {
          supported: process.platform !== "win32",
          hostHome: farm.hostHome,
          exists: farm.present,
          wired: farm.wired,
          probeError: farm.probeError,
          active: farm.active,
          enabled: deps.codexHostEnabled(),
        };
        facts.autoupdate = deps.readAutoupdate();
      })(),
    );
  }

  await Promise.all(jobs);
  return facts;
}
