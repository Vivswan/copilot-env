// I/O fact-gathering for `agent health`. Each scope gathers ONLY the facts it needs; the
// `runtime` scope stays minimal (no shell or CLI probes), though the tracked-pid check still
// spawns `ps`/PowerShell. Store, config, and file reads are direct calls against the isolated
// home tests seed; the spawns, the network, the clock, and the agent homes are the ProbeDeps seams
// (probe_deps.ts).
import { join } from "node:path";
import { claudeDesktopStatus } from "../agents/claude_desktop.ts";
import { AGENT_CLIS } from "../agents/cli_install.ts";
import { defaultSetupNeedsProxy } from "../agents/wiring.ts";
import { AutoupdateState, effectiveUpdateCooldownDays } from "../autoupdate/state.ts";
import {
  bakedClaudeToken,
  type ClaudeWiringStatus,
  inspectClaudeWiring,
} from "../claude/config.ts";
import { settingsPathFor } from "../claude/paths.ts";
import {
  bakedCodexToken,
  CODEX_ENV_KEY,
  type CodexWiringStatus,
  inspectCodexWiring,
} from "../codex/inspect.ts";
import { codexHostFarm } from "../codex/host.ts";
import { codexConfigPath, codexProfileConfigPath } from "../codex/paths.ts";
import { CopilotApiConfig } from "../copilot_api/config.ts";
import { Credential } from "../copilot_api/credential.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import {
  type AuthProvider,
  CopilotEnvState,
  credentialProvider,
  type ProfileMode,
  storedCredentialKind,
} from "../copilot_api/env_state.ts";
import { CopilotApiPaths, profileHomeExists, resolveRootHome } from "../copilot_api/paths.ts";
import {
  copilotApiFallbackPort,
  copilotApiResolvePort,
  proxyLoopbackOrigin,
} from "../copilot_api/port.ts";
import { pidAlive } from "../copilot_api/process.ts";
import type { Profile, ProfileName } from "../copilot_api/profile.ts";
import { sidecarStatus } from "../copilot_api/sidecar.ts";
import { CopilotEnvRunState } from "../copilot_api/run_state.ts";
import { installedProxyVersion, proxyVersionBoundsStatus } from "../copilot_api/version.ts";
import {
  proxyFloatSkips,
  readResolvedVersionRecord,
  resolveMinimumReleaseAgeSeconds,
} from "../proxy_float.ts";
import { idleTimeoutMs } from "../copilot_api/idle_watchdog.ts";
import { persistedInferenceMs } from "../copilot_api/inference_activity.ts";
import { hasMarker, MARKER } from "../shell/integration.ts";
import { errMessage } from "../utils/error.ts";
import { readTextOrNull } from "../utils/fs.ts";
import * as fs from "../utils/fs_facade.ts";
import { readProjectConfig } from "../utils/project_config.ts";
import { PROJECT_ROOT } from "../utils/root.ts";
import { packageVersion } from "../utils/version.ts";
import {
  type BakedCredentialFreshness,
  classifyPortState,
  type CodexDirectAuthFacts,
  type DaemonProbed,
  type DefaultRuntimeTarget,
  type HealthFacts,
  type NamedRuntimeTarget,
  type ProfileAuthFacts,
  type ProfileSlotFacts,
  runtimePathsView,
  type RuntimeTarget,
  type RuntimeTargetCommon,
  type ShellFileFact,
} from "./facts.ts";
import { defaultProbeDeps, type ProbeDeps } from "./probe_deps.ts";
import {
  AUTH_SCOPES,
  BOOTSTRAP_SCOPES,
  CLAUDE_LIVE_SCOPES,
  CLAUDE_SCOPES,
  CODEX_LIVE_SCOPES,
  CODEX_SCOPES,
  type HealthScope,
  RUNTIME_SCOPES,
  SETUP_SCOPES,
} from "./types.ts";

/** A named profile's store slot view (never tokens): ONE profileSlotStatus() call snapshots the
 *  whole slot, so consumers pairing its fields can never see a torn combination under a
 *  concurrent credential write. */
function profileSlotFacts(name: ProfileName): ProfileSlotFacts {
  const { exists, slot } = new CopilotEnvState().profileSlotStatus(name);
  return {
    exists,
    provider: credentialProvider(slot.credential),
    mode: slot.mode,
    storedToken: slot.credential.kind === "stored",
    ghUser: slot.credential.kind === "gh-cli" ? slot.credential.ghUser : null,
  };
}

/** Named profiles: name -> recorded provider + mode (never tokens). Swept via profileNames() (the
 *  store's validated, sorted view), never the raw record: its keys are a trust boundary, and only
 *  profileNames() mints the brand. */
function authProfiles(): Record<ProfileName, ProfileAuthFacts> {
  const store = new CopilotEnvState();
  const profiles: Record<ProfileName, ProfileAuthFacts> = {};
  for (const name of store.profileNames()) {
    const slot = store.readProfileSlot(name);
    profiles[name] = { provider: credentialProvider(slot.credential), mode: slot.mode };
  }
  return profiles;
}

/** Same predicate as bin/agent's freshness gate: node_modules at least as new as deno.lock. */
function nodeModulesFresh(): boolean {
  try {
    const lock = fs.stat(join(PROJECT_ROOT, "deno.lock")).mtimeMs;
    const modules = fs.stat(join(PROJECT_ROOT, "node_modules")).mtimeMs;
    return modules >= lock;
  } catch {
    return false;
  }
}

// --- orchestration ----------------------------------------------------------

/**
 * READ-ONLY: nothing here writes a file or reserves a port. pid and port come from a single
 * run-state read (proxyStatus's rule), so a concurrent start/stop cannot pair one daemon's pid
 * with another's port; copilotApiFallbackPort covers the no-recorded-port case without a second
 * read (it never re-reads the addressed profile's recorded port). The state is returned so the
 * caller hands the SAME snapshot's pid to interrogateDaemon.
 */
function snapshotTarget(
  profile: Profile,
  deps: ProbeDeps,
  proxyExpectedFor: (port: number) => boolean,
): { state: { pid?: number }; common: RuntimeTargetCommon } {
  const state = CopilotEnvRunState.forProfile(profile).read();
  const portPersisted = state.port !== undefined;
  const port = state.port ?? copilotApiFallbackPort(profile);
  // The observer's persisted `.activity.json` mark; our own reach/identity GET probes are not inference
  // POSTs, so health observing the proxy never moves these numbers.
  const lastRequestMs = persistedInferenceMs(profile);
  return {
    state,
    common: {
      proxyExpected: proxyExpectedFor(port),
      port,
      portPersisted,
      paths: runtimePathsView(new CopilotApiPaths(profile)),
      watchdog: {
        autoStart: new CopilotEnvConfig().autoStartEnabled(),
        idleTimeoutMs: idleTimeoutMs(),
        lastEnsureAt: state.lastEnsureAt ?? null,
        lastRequestMs: lastRequestMs > 0 ? lastRequestMs : null,
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
  // fast `runtime` probe scope, and only when something is reachable AND this target's setup
  // routes through the port: with both agents direct, nothing we manage talks to whatever
  // answers, so its identity is never grounds for a misroute warning.
  const identityConfirmed = BOOTSTRAP_SCOPES.includes(scope) && reachable && proxyExpected
    ? await deps.proxyIdentity(probeUrl, 2000)
    : null;
  return {
    kind: "probed",
    reachable,
    trackedPid,
    pidTracked,
    ...(pidClass === "unknown" ? { pidScanUnproven: true as const } : {}),
    pidAlive: trackedPid !== null ? pidAlive(trackedPid) : false,
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
 * The daemon is interrogated only when a proxy is expected, the home exists, AND the port is
 * persisted: a DIRECT profile has no daemon, a homeless proxy slot has no persisted port, and an
 * unpersisted candidate port is never probed.
 */
async function gatherNamedTarget(
  name: ProfileName,
  scope: HealthScope,
  deps: ProbeDeps,
): Promise<NamedRuntimeTarget> {
  const slot = profileSlotFacts(name);
  const homeExists = profileHomeExists(name);
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
 *  into a narrowed report. With no profile the run is the default's: its own daemon alone, as a
 *  named profile's run is its daemon alone (`agent health` gathers every profile's run itself). */
export async function gatherFacts(
  scope: HealthScope,
  opts: { live?: boolean; profile?: Profile } = {},
  overrides?: Partial<ProbeDeps>,
): Promise<HealthFacts> {
  const deps: ProbeDeps = { ...defaultProbeDeps(), ...overrides };
  const profile = opts.profile ?? null;
  // The addressed target's resolved port (READ-ONLY: a named profile's reservation is peeked,
  // never made). Lazy and cached: only the scopes that inspect wiring resolve it, so a
  // runtime/auth run never computes a named profile's candidate port at all.
  let wiringPortCache: number | undefined;
  const wiringPort = (): number => (wiringPortCache ??= Number(copilotApiResolvePort(profile)));
  const facts: HealthFacts = { profile };

  // gh auth backs BOTH agents' direct mode: probed at most once per run AND per pinned account,
  // asynchronously, so each ~5s `gh auth token` call overlaps the other probes instead of
  // serializing into the health timeout. Jobs addressing the same account await the same promise.
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
  // recorded default mode (recordDefaultMode). `slotExists` false is a named profile whose store
  // WAS read and holds no slot (never an unproven empty; an unreadable store propagates,
  // profileHomeNames' strict stance). One store read, cached; several jobs consult it.
  let credentialCache:
    | {
      provider: AuthProvider | null;
      storedToken: boolean;
      ghUser: string | null;
      mode: ProfileMode | null;
      slotExists: boolean;
    }
    | undefined;
  const runCredential = (): NonNullable<typeof credentialCache> => {
    if (credentialCache === undefined) {
      if (profile === null) {
        const store = new CopilotEnvState().read();
        credentialCache = {
          provider: store.authProvider,
          storedToken: store.githubToken !== null,
          ghUser: store.ghUser,
          mode: null,
          slotExists: true,
        };
      } else {
        const slot = profileSlotFacts(profile);
        credentialCache = {
          provider: slot.provider,
          storedToken: slot.storedToken,
          ghUser: slot.ghUser,
          mode: slot.mode,
          slotExists: slot.exists,
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
  // whether the baked value is what a rewire would bake now: the slot's stored token VALUE
  // (direct) or the profile daemon's minted API key (proxy), compared and never reported. A store
  // or daemon home that cannot answer reads "unchecked", never a failure of the agent check (the
  // value in the config is what the agent uses) and never "fresh".
  const bakedFreshness = (
    mode: "direct" | "proxy",
    baked: string | null,
  ): BakedCredentialFreshness => {
    if (baked === null) return "unchecked";
    try {
      let expected: string | null;
      if (mode === "proxy") {
        expected = CopilotApiConfig.forProfile(profile).apiKey();
      } else {
        const credential = new Credential(undefined, profile).read();
        expected = credential.kind === "stored" ? credential.token : null;
      }
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

  if (RUNTIME_SCOPES.includes(scope)) {
    jobs.push(
      (async () => {
        // Exactly the addressed target: the default daemon, or the narrowed profile's.
        const target: RuntimeTarget = profile === null
          ? await gatherDefaultTarget(scope, deps)
          : await gatherNamedTarget(profile, scope, deps);
        facts.runtimes = [target];
      })(),
    );
  }

  if (profile === null && BOOTSTRAP_SCOPES.includes(scope)) {
    jobs.push(
      (async () => {
        const sidecar = sidecarStatus(resolveRootHome());
        facts.bootstrap = {
          cliVersion: packageVersion(),
          denoVersion: Deno.version.deno,
          // A compiled binary embeds its dependencies: no node_modules to judge.
          nodeModules: sidecar.standalone ? null : {
            present: fs.exists(join(PROJECT_ROOT, "node_modules")),
            fresh: nodeModulesFresh(),
          },
        };
        // The float's resolved-version record (null when it has never resolved here), with
        // whether its cache directory is still on disk.
        const record = readResolvedVersionRecord(resolveRootHome());
        const resolved = record === null ? null : { ...record, cached: fs.exists(record.denoDir) };
        // The version that would actually RUN, in the daemon entry's own precedence: the float's
        // recorded resolution, else the deno.json baseline in node_modules. Judging bounds on
        // anything else would grade a copy the daemon never loads.
        const version = resolved?.version ?? installedProxyVersion(PROJECT_ROOT);
        // A bad COPILOT_API_MIN_RELEASE_AGE / cooldown setting must not crash health.
        let cooldownSeconds: number | null = null;
        try {
          cooldownSeconds = resolveMinimumReleaseAgeSeconds();
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
            bounds: proxyVersionBoundsStatus(version, readProjectConfig()),
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

  if (CODEX_SCOPES.includes(scope)) {
    jobs.push(
      (async () => {
        const home = deps.codexHome();
        // config.toml is read three-way (readTextResult) so an unreadable file classifies
        // other/read-error instead of collapsing into the absent/none verdict a null would
        // produce; the .env read stays don't-care (absence and unreadability are alike).
        const configRead = fs.readTextResult(codexConfigPath(home));
        const envText = readTextOrNull(join(home, ".env"));
        // A named profile inspects ITS selection (`<name>.config.toml` over the suffixed provider
        // table in config.toml) against ITS resolved port; the profile file is read three-way for
        // the same reason config.toml is.
        const wiring = inspectCodexWiring(
          configRead,
          envText,
          wiringPort(),
          Boolean(process.env[CODEX_ENV_KEY]),
          profile === null ? { profile } : {
            profile,
            profileToml: fs.readTextResult(codexProfileConfigPath(home, profile)),
          },
        );
        const { directAuth, noGhNeeded } = await directAuthFor(authShapeOf(wiring));
        facts.codex = {
          home,
          directAuth,
          // The wiring's `directUsesToken` stays a pure CONFIG fact; the store-aware "Direct
          // needs no gh" verdict travels on its own field (`directNeedsNoGh`, what checkCodex
          // consumes).
          directNeedsNoGh: wiring.providerMode === "direct" && noGhNeeded,
          ...wiring,
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

  if (CLAUDE_SCOPES.includes(scope)) {
    jobs.push(
      (async () => {
        const home = deps.claudeHome();
        // A named profile answers from its own settings-<name>.json, read three-way
        // (readTextResult) so an unreadable file classifies other/read-error, not "none".
        const settingsPath = settingsPathFor(home, profile);
        const settingsRead = fs.readTextResult(settingsPath);
        // "direct" here means the credential shape truly is ours, addressed at THIS profile (never
        // a stale/foreign/mis-addressed helper); directAuthFor then decides the gh probe.
        const wiring = inspectClaudeWiring(settingsRead, wiringPort(), profile);
        const { directAuth, noGhNeeded } = await directAuthFor(authShapeOf(wiring));
        facts.claude = {
          home,
          settingsPath,
          directAuth,
          directUsesToken: wiring.providerMode === "direct" && noGhNeeded,
          ...wiring,
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
        if (profile === null) facts.claudeDesktop = claudeDesktopStatus();
      })(),
    );
  }

  if (AUTH_SCOPES.includes(scope)) {
    jobs.push(
      (async () => {
        // gh is a credential ONLY when storedCredentialKind() says gh-cli (no implicit fallback);
        // reuses the shared (cached) gh probe, so no extra spawn. A named profile's line is its
        // own slot alone (runCredential's one snapshot); it never falls back to the default
        // credential.
        const credential = runCredential();
        const gh = storedCredentialKind(credential.provider, credential.storedToken) === "gh-cli"
          ? await slotGhFacts(credential.ghUser)
          : null;
        const resolution = {
          storedToken: credential.storedToken,
          ghAuthenticated: gh?.authenticated ?? false,
          ...(gh?.ghUser != null ? { ghUser: gh.ghUser } : {}),
          ...(gh?.ghActiveLogin != null ? { ghActiveLogin: gh.ghActiveLogin } : {}),
          ...(gh?.ghCommand !== undefined ? { ghCommand: gh.ghCommand } : {}),
          ...(gh?.ghDetail !== undefined ? { ghDetail: gh.ghDetail } : {}),
          ...(gh?.unproven ? { ghAuthUnproven: true as const } : {}),
        };
        facts.auth = profile === null
          ? {
            profile,
            ...resolution,
            provider: credential.provider,
            profiles: authProfiles(),
            // The `identity` config pin, or null when unset/`auto`.
            pinnedIntegrationId: new CopilotEnvConfig().pinnedIntegrationId(null),
          }
          : {
            profile,
            ...resolution,
            slot: credential.slotExists
              ? { provider: credential.provider, mode: credential.mode }
              : null,
          };
      })(),
    );
  }

  // `--live` runs each agent's smoke prompt against its CONFIGURED home (a named profile's narrowing
  // routes it through that profile's wiring), only in the agent-focused scopes and only when
  // asked for (a slow live model call).
  if (opts.live && CODEX_LIVE_SCOPES.includes(scope)) {
    jobs.push(
      (async () => {
        facts.codexLive = await deps.codexLive(deps.codexHome(), profile);
      })(),
    );
  }
  if (opts.live && CLAUDE_LIVE_SCOPES.includes(scope)) {
    jobs.push(
      (async () => {
        facts.claudeLive = await deps.claudeLive(deps.claudeHome(), profile);
      })(),
    );
  }

  if (profile === null && SETUP_SCOPES.includes(scope)) {
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
        const files: ShellFileFact[] = targets.map((path) => {
          const content = readTextOrNull(path);
          return { path, hasIntegration: content !== null && hasMarker(content, MARKER) };
        });
        facts.shell = {
          files,
          integrationWired: files.some((f) => f.hasIntegration),
          // The `shell.launchers` config key (see ShellFacts).
          launchersWired: new CopilotEnvConfig().launchersEnabled(),
          ...(targetsUnproven ? { targetsUnproven: true as const } : {}),
        };
        facts.clis = AGENT_CLIS.map((c) => ({
          command: c.command,
          name: c.name,
          look: deps.commandLook(c.command),
        }));
        facts.tools = { node: deps.commandLook("node"), npm: deps.commandLook("npm") };
        // The per-host farm on disk (path, present, wired), from its one predicate.
        const farm = codexHostFarm();
        facts.codexHost = {
          supported: process.platform !== "win32",
          hostHome: farm.hostHome,
          exists: farm.present,
          wired: farm.wired,
          probeError: farm.probeError,
          active: farm.active,
          enabled: new CopilotEnvConfig().codexHostEnabled(),
        };
        facts.autoupdate = {
          ...new AutoupdateState().read(),
          enabled: new CopilotEnvConfig().autoUpdateEnabled(),
          cooldownDays: effectiveUpdateCooldownDays(),
        };
      })(),
    );
  }

  await Promise.all(jobs);
  return facts;
}
