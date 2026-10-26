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
import { codexHostFarm } from "../codex/host.ts";
import {
  bakedCodexToken,
  CODEX_ENV_KEY,
  type CodexWiringStatus,
  inspectCodexWiring,
} from "../codex/inspect.ts";
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
import { idleTimeoutMs } from "../copilot_api/idle_watchdog.ts";
import { persistedInferenceMs } from "../copilot_api/inference_activity.ts";
import { CopilotApiPaths, profileHomeExists, resolveRootHome } from "../copilot_api/paths.ts";
import {
  copilotApiFallbackPort,
  copilotApiResolvePort,
  proxyLoopbackOrigin,
} from "../copilot_api/port.ts";
import type { Profile, ProfileName } from "../copilot_api/profile.ts";
import { CopilotEnvRunState } from "../copilot_api/run_state.ts";
import { installedProxyVersion, proxyVersionBoundsStatus } from "../copilot_api/version.ts";
import {
  floatedProxyEntry,
  proxyFloatSkips,
  readResolvedVersionRecord,
  resolveMinimumReleaseAgeSeconds,
} from "../proxy_float.ts";
import { hasMarker, MARKER } from "../shell/integration.ts";
import { assertNever } from "../utils/assert.ts";
import { errMessage } from "../utils/error.ts";
import { readTextOrNull } from "../utils/fs.ts";
import * as fs from "../utils/fs_facade.ts";
import { pidAlive } from "../utils/pid.ts";
import { readProjectConfig } from "../utils/project_config.ts";
import { isStandaloneBinary, PROJECT_ROOT } from "../utils/root.ts";
import { packageVersion } from "../utils/version.ts";
import {
  type AuthFacts,
  type BakedCredentialFreshness,
  type BootstrapFacts,
  type CodexDirectAuthFacts,
  classifyPortState,
  type DaemonProbed,
  type DefaultRuntimeTarget,
  type HealthFacts,
  type NamedRuntimeTarget,
  type ProfileAuthFacts,
  type ProfileSlotFacts,
  type ProxyFacts,
  type RuntimeTarget,
  type RuntimeTargetCommon,
  runtimePathsView,
  type ShellFacts,
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

/** The credential shape a wiring carries, as the agent inspectors classify it. */
type WiringCredential = "command" | "static" | "none";

/** The credential the run's Direct wiring resolves; readRunCredential explains its fields. */
interface RunCredential {
  provider: AuthProvider | null;
  storedToken: boolean;
  ghUser: string | null;
  mode: ProfileMode | null;
  slotExists: boolean;
}

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

/** AuthFacts carries a slot's gh verdict flattened (its keys are the health JSON's); null is a
 *  credential gh never backs. */
function ghResolutionFacts(
  gh: CodexDirectAuthFacts | null,
): Pick<
  AuthFacts,
  "ghAuthenticated" | "ghUser" | "ghActiveLogin" | "ghCommand" | "ghDetail" | "ghAuthUnproven"
> {
  if (gh === null) return { ghAuthenticated: false };
  const account = {
    ...(gh.ghUser == null ? {} : { ghUser: gh.ghUser }),
    ...(gh.ghActiveLogin == null ? {} : { ghActiveLogin: gh.ghActiveLogin }),
  };
  switch (gh.kind) {
    case "found":
      return { ghAuthenticated: true, ...account, ghCommand: gh.ghCommand };
    case "absent":
      return {
        ghAuthenticated: false,
        ...account,
        ...(gh.command === null ? {} : { ghDetail: gh.ghDetail }),
      };
    case "unproven":
      return {
        ghAuthenticated: false,
        ...account,
        ...(gh.command === null ? {} : { ghDetail: gh.ghDetail }),
        ghAuthUnproven: true,
      };
    default:
      return assertNever(gh);
  }
}

/** Same predicate as bin/agent's freshness gate: node_modules at least as new as bun.lock. */
function nodeModulesFresh(): boolean {
  try {
    const lock = fs.stat(join(PROJECT_ROOT, "bun.lock")).mtimeMs;
    const modules = fs.stat(join(PROJECT_ROOT, "node_modules")).mtimeMs;
    return modules >= lock;
  } catch {
    return false;
  }
}

/** The default store pair, or the narrowed profile's own slot (named profiles never fall back).
 *  `mode` is the named slot's recorded mode; the default run leaves it null and judges from the
 *  agents' own wiring instead of the recorded default mode (recordDefaultMode). `slotExists` false
 *  is a named profile whose store WAS read and holds no slot (never an unproven empty; an
 *  unreadable store propagates, profileHomeNames' strict stance). */
function readRunCredential(profile: Profile): RunCredential {
  if (profile === null) {
    const store = new CopilotEnvState().read();
    return {
      provider: store.authProvider,
      storedToken: store.githubToken !== null,
      ghUser: store.ghUser,
      mode: null,
      slotExists: true,
    };
  }
  const slot = profileSlotFacts(profile);
  return {
    provider: slot.provider,
    storedToken: slot.storedToken,
    ghUser: slot.ghUser,
    mode: slot.mode,
    slotExists: slot.exists,
  };
}

/** The shape directAuthFor judges: a static wiring in EITHER mode carries its value, so the
 *  store is never asked and no gh probe runs; a proxy command shape keeps the gh probe (the
 *  daemon resolves the same credential). */
function authShapeOf(wiring: ClaudeWiringStatus | CodexWiringStatus): WiringCredential {
  if (wiring.credential === "static" || wiring.providerMode === "direct") {
    return wiring.credential ?? "none";
  }
  return "none";
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
    trackedPid === null
      ? Promise.resolve<"yes" | "no" | "unknown">("no")
      : deps.classifyTrackedPid(trackedPid),
  ]);
  const pidTracked = pidClass === "yes";
  // The identity probe (an extra local request) runs only in the full/proxy scopes, never the
  // fast `runtime` probe scope, and only when something is reachable AND this target's setup
  // routes through the port: with both agents direct, nothing we manage talks to whatever
  // answers, so its identity is never grounds for a misroute warning.
  const identityConfirmed =
    BOOTSTRAP_SCOPES.includes(scope) && reachable && proxyExpected
      ? await deps.proxyIdentity(probeUrl, 2000)
      : null;
  return {
    kind: "probed",
    reachable,
    trackedPid,
    pidTracked,
    ...(pidClass === "unknown" ? { pidScanUnproven: true as const } : {}),
    pidAlive: trackedPid !== null && pidAlive(trackedPid),
    identityConfirmed,
    portState: classifyPortState({ proxyExpected, reachable, pidTracked, identityConfirmed }),
  };
}

/** Always interrogated, with the configured default port as the fallback. */
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
    }),
  );
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

function namedProbeSkipReason(
  proxyExpected: boolean,
  homeExists: boolean,
  portPersisted: boolean,
): string | null {
  if (!proxyExpected) return "no daemon expected (not a proxy-mode target)";
  if (!homeExists) return "no daemon home on disk";
  if (!portPersisted) return "no persisted port on this host";
  return null;
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
  const skipWhy = namedProbeSkipReason(proxyExpected, homeExists, common.portPersisted);
  return {
    profile: name,
    slot,
    homeExists,
    ...common,
    probe:
      skipWhy === null
        ? await interrogateDaemon(scope, deps, common.port, state.pid ?? null, proxyExpected)
        : { kind: "skipped", why: skipWhy },
  };
}

/**
 * One health run's shared state: the addressed profile, the seams, and the reads several jobs
 * consult, each made at most once per run. The gh probes run asynchronously, so each ~5s
 * `gh auth token` call overlaps the other probes instead of serializing into the health timeout.
 */
class ProbeRun {
  readonly profile: Profile;

  readonly deps: ProbeDeps;

  private wiringPortCache: number | undefined;

  private readonly directAuthCache = new Map<string | null, Promise<CodexDirectAuthFacts>>();

  private activeLoginCache: Promise<string | null> | undefined;

  private credentialCache: RunCredential | undefined;

  constructor(profile: Profile, deps: ProbeDeps) {
    this.profile = profile;
    this.deps = deps;
  }

  /** The addressed target's resolved port (READ-ONLY: a named profile's reservation is peeked,
   *  never made). Lazy and cached: only the scopes that inspect wiring resolve it, so a
   *  runtime/auth run never computes a named profile's candidate port at all. */
  wiringPort(): number {
    this.wiringPortCache ??= Number(copilotApiResolvePort(this.profile));
    return this.wiringPortCache;
  }

  /** gh auth backs BOTH agents' direct mode: probed at most once per run AND per pinned account.
   *  Jobs addressing the same account await the same promise. */
  sharedDirectAuth(ghUser: string | null): Promise<CodexDirectAuthFacts> {
    let probe = this.directAuthCache.get(ghUser);
    if (probe === undefined) {
      probe = this.deps.codexDirectAuth(ghUser);
      this.directAuthCache.set(ghUser, probe);
    }
    return probe;
  }

  /** The account an AUTO gh-cli slot follows right now, for the report's naming: probed once per
   *  run, only when some auto gh-cli slot is actually being judged. */
  sharedActiveLogin(): Promise<string | null> {
    this.activeLoginCache ??= this.deps.ghActiveLogin();
    return this.activeLoginCache;
  }

  /** The auth verdict, plus the followed account's name on an AUTO slot (a pinned slot already
   *  names itself via ghUser). */
  async slotGhFacts(ghUser: string | null): Promise<CodexDirectAuthFacts> {
    if (ghUser !== null) return await this.sharedDirectAuth(ghUser);
    // Both spawns start before either is awaited: two timing-out gh calls cost one 5s budget,
    // not two back to back.
    const [directAuth, activeLogin] = await Promise.all([
      this.sharedDirectAuth(null),
      this.sharedActiveLogin(),
    ]);
    return activeLogin === null ? directAuth : { ...directAuth, ghActiveLogin: activeLogin };
  }

  /** The credential the run's Direct wiring resolves (readRunCredential): one store read, cached;
   *  several jobs consult it. */
  runCredential(): RunCredential {
    this.credentialCache ??= readRunCredential(this.profile);
    return this.credentialCache;
  }

  /** The (~5s) gh probe is skipped, and Direct reported as "uses token", only when the config is
   *  `managed` (execs `agent auth --get`, or `agent profile <name> auth --get`) AND the credential
   *  classifies as a stored token; gh-cli means a live gh probe. Classification is
   *  storedCredentialKind() (env_state.ts): a leftover token with no provider is "none", so no gh
   *  probe (no implicit fallback) and Direct never reads green. A static shape asks the store
   *  nothing: the value is in the config, so no gh is needed whatever the store says. Shared by
   *  the Codex and Claude jobs. */
  async directAuthFor(
    credential: WiringCredential,
  ): Promise<{ directAuth: CodexDirectAuthFacts; noGhNeeded: boolean }> {
    // Reported as the unprobed `{"command":null,"authenticated":false}` row. The auth VERDICT never
    // reads it: directAuthVerdict (checks_agents.ts) judges a gh-cli provider only, which probes.
    const noProbe: CodexDirectAuthFacts = { kind: "absent", command: null };
    if (credential === "static") return { directAuth: noProbe, noGhNeeded: true };
    const managed = credential === "command";
    const { provider, storedToken, ghUser } = this.runCredential();
    switch (storedCredentialKind(provider, storedToken)) {
      case "stored":
        return { directAuth: noProbe, noGhNeeded: managed };
      case "gh-cli":
        return { directAuth: await this.slotGhFacts(ghUser), noGhNeeded: false };
      case "none":
        return { directAuth: noProbe, noGhNeeded: false };
    }
  }

  /** A static wiring holds the credential itself, so the store is consulted for ONE thing only:
   *  whether the baked value is what a rewire would bake now: the slot's stored token VALUE
   *  (direct) or the profile daemon's minted API key (proxy), compared and never reported. A store
   *  or daemon home that cannot answer reads "unchecked", never a failure of the agent check (the
   *  value in the config is what the agent uses) and never "fresh". */
  bakedFreshness(mode: "direct" | "proxy", baked: string | null): BakedCredentialFreshness {
    if (baked === null) return "unchecked";
    try {
      let expected: string | null;
      if (mode === "proxy") {
        expected = CopilotApiConfig.forProfile(this.profile).apiKey();
      } else {
        const credential = new Credential(undefined, this.profile).read();
        expected = credential.kind === "stored" ? credential.token : null;
      }
      if (expected === null) return "unchecked";
      return expected === baked ? "fresh" : "stale";
    } catch {
      return "unchecked";
    }
  }

  /** The freshness fact of a static wiring, in the mode it bakes for; nothing for the other shapes
   *  (the command shape resolves at runtime, so there is no baked value to compare). `baked` is
   *  read for the static shape alone, so no other shape pays for the parse. */
  bakedCredentialFacts(
    wiring: ClaudeWiringStatus | CodexWiringStatus,
    baked: () => string | null,
  ): { bakedCredential?: BakedCredentialFreshness } {
    if (wiring.credential !== "static") return {};
    const mode = wiring.providerMode === "direct" ? "direct" : "proxy";
    return { bakedCredential: this.bakedFreshness(mode, baked()) };
  }

  /** The store facts the checks frame a credential miss with. A static wiring omits the provider:
   *  it resolves nothing at request time, so an unreadable store must not fail its agent check. A
   *  named profile's recorded mode stays whatever the shape: the slot DEFINES the profile, and an
   *  interrupted `profile <name> add` (slot flipped, agents not yet rewritten) must never read
   *  green. */
  storeFacts(credential: WiringCredential | null): {
    provider?: AuthProvider | null;
    expectedMode?: ProfileMode | null;
  } {
    return {
      ...(credential === "static" ? {} : { provider: this.runCredential().provider }),
      ...(this.profile === null ? {} : { expectedMode: this.runCredential().mode }),
    };
  }
}

async function gatherRuntime(run: ProbeRun, scope: HealthScope, facts: HealthFacts): Promise<void> {
  const target: RuntimeTarget =
    run.profile === null
      ? await gatherDefaultTarget(scope, run.deps)
      : await gatherNamedTarget(run.profile, scope, run.deps);
  facts.runtimes = [target];
}

function bootstrapFacts(standalone: boolean): BootstrapFacts {
  return {
    cliVersion: packageVersion(),
    runtimeVersion: process.versions.bun,
    runtimePath: process.execPath,
    // A compiled binary embeds its dependencies: no node_modules to judge.
    nodeModules: standalone
      ? null
      : {
          present: fs.exists(join(PROJECT_ROOT, "node_modules")),
          fresh: nodeModulesFresh(),
        },
  };
}

/** What the float resolved, and the version that would actually RUN, in the daemon entry's own
 *  precedence: the float's install tree, else the range package.json pins, read off the installed
 *  copy in node_modules. Judging bounds on anything else (a record whose tree is gone) would grade
 *  a copy the daemon never loads. */
function floatedProxyFacts(rootHome: string): Pick<ProxyFacts, "resolved" | "version"> {
  const record = readResolvedVersionRecord(rootHome);
  // The float's own verifier: the install tree is the version that runs, so health never calls
  // installed a tree the daemon could not run from, and never hides one the record outran (a
  // record alone, its tree gone, is recorded and not installed).
  const floated = floatedProxyEntry(rootHome);
  if (floated !== null) {
    const resolvedAtMs = record?.resolvedAtMs ?? 0;
    return {
      resolved: { version: floated.version, resolvedAtMs, installed: true },
      version: floated.version,
    };
  }
  const version = installedProxyVersion(PROJECT_ROOT);
  if (record === null) return { resolved: null, version };
  return { resolved: { ...record, installed: false }, version };
}

function proxyFacts(run: ProbeRun, standalone: boolean): ProxyFacts {
  const { resolved, version } = floatedProxyFacts(resolveRootHome());
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
  const floatSkips = proxyFloatSkips(run.deps.codexHome(), run.deps.claudeHome());
  const common = { version, cooldownSeconds, floatSkips, resolved, standalone };
  try {
    const bounds = proxyVersionBoundsStatus(version, readProjectConfig());
    return { ...common, bounds, configError: null };
  } catch (e) {
    return { ...common, bounds: null, configError: errMessage(e) };
  }
}

async function gatherBootstrap(run: ProbeRun, facts: HealthFacts): Promise<void> {
  const standalone = isStandaloneBinary();
  facts.bootstrap = bootstrapFacts(standalone);
  facts.proxy = proxyFacts(run, standalone);
}

async function gatherCodex(run: ProbeRun, facts: HealthFacts): Promise<void> {
  const profile = run.profile;
  const home = run.deps.codexHome();
  // config.toml is read three-way (readTextResult) so an unreadable file classifies
  // other/read-error instead of collapsing into the absent/none verdict a null would
  // produce; the .env read stays don't-care (absence and unreadability are alike).
  const configRead = fs.readTextResult(codexConfigPath(home));
  const envText = readTextOrNull(join(home, ".env"));
  // A named profile inspects ITS selection (`<name>.config.toml` over the suffixed provider
  // table in config.toml) against ITS resolved port; the profile file is read three-way for
  // the same reason config.toml is.
  const selection =
    profile === null
      ? { profile }
      : { profile, profileToml: fs.readTextResult(codexProfileConfigPath(home, profile)) };
  const wiring = inspectCodexWiring(
    configRead,
    envText,
    run.wiringPort(),
    Boolean(process.env[CODEX_ENV_KEY]),
    selection,
  );
  const { directAuth, noGhNeeded } = await run.directAuthFor(authShapeOf(wiring));
  facts.codex = {
    home,
    directAuth,
    // The wiring's `directUsesToken` stays a pure CONFIG fact; the store-aware "Direct
    // needs no gh" verdict travels on its own field (`directNeedsNoGh`, what checkCodex
    // consumes).
    directNeedsNoGh: wiring.providerMode === "direct" && noGhNeeded,
    ...wiring,
    ...run.storeFacts(wiring.credential),
    ...run.bakedCredentialFacts(wiring, () => bakedCodexToken(configRead, profile)),
  };
}

async function gatherClaude(run: ProbeRun, facts: HealthFacts): Promise<void> {
  const profile = run.profile;
  const home = run.deps.claudeHome();
  // A named profile answers from its own settings-<name>.json, read three-way
  // (readTextResult) so an unreadable file classifies other/read-error, not "none".
  const settingsPath = settingsPathFor(home, profile);
  const settingsRead = fs.readTextResult(settingsPath);
  // "direct" here means the credential shape truly is ours, addressed at THIS profile (never
  // a stale/foreign/mis-addressed helper); directAuthFor then decides the gh probe.
  const wiring = inspectClaudeWiring(settingsRead, run.wiringPort(), profile);
  const { directAuth, noGhNeeded } = await run.directAuthFor(authShapeOf(wiring));
  facts.claude = {
    home,
    settingsPath,
    directAuth,
    directUsesToken: wiring.providerMode === "direct" && noGhNeeded,
    ...wiring,
    ...run.storeFacts(wiring.credential),
    ...run.bakedCredentialFacts(wiring, () => bakedClaudeToken(settingsRead)),
  };
  // The Desktop library spans the default AND every profile, so it is judged once, on the
  // whole-environment run only.
  if (profile === null) facts.claudeDesktop = claudeDesktopStatus();
}

async function gatherAuth(run: ProbeRun, facts: HealthFacts): Promise<void> {
  const profile = run.profile;
  // gh is a credential ONLY when storedCredentialKind() says gh-cli (no implicit fallback);
  // reuses the shared (cached) gh probe, so no extra spawn. A named profile's line is its
  // own slot alone (runCredential's one snapshot); it never falls back to the default
  // credential.
  const credential = run.runCredential();
  const gh =
    storedCredentialKind(credential.provider, credential.storedToken) === "gh-cli"
      ? await run.slotGhFacts(credential.ghUser)
      : null;
  const resolution = {
    storedToken: credential.storedToken,
    ...ghResolutionFacts(gh),
  };
  if (profile === null) {
    facts.auth = {
      profile,
      ...resolution,
      provider: credential.provider,
      profiles: authProfiles(),
      // The `identity` config key; null when unset or `auto` (src/copilot_api/env_config.ts).
      pinnedIntegrationId: new CopilotEnvConfig().pinnedIntegrationId(null),
    };
    return;
  }
  facts.auth = {
    profile,
    ...resolution,
    slot: credential.slotExists ? { provider: credential.provider, mode: credential.mode } : null,
  };
}

/** Resolving shell targets shells out to PowerShell on Windows and can throw; degrade to "no
 *  targets" rather than crashing the diagnostic, but MARKED (targetsUnproven), so the empty
 *  census renders "could not check", never a confident "not wired". */
function shellFacts(deps: ProbeDeps): ShellFacts {
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
  return {
    files,
    integrationWired: files.some((f) => f.hasIntegration),
    // The `shell.launchers` config key (see ShellFacts).
    launchersWired: new CopilotEnvConfig().launchersEnabled(),
    ...(targetsUnproven ? { targetsUnproven: true as const } : {}),
  };
}

async function gatherSetup(run: ProbeRun, facts: HealthFacts): Promise<void> {
  facts.shell = shellFacts(run.deps);
  facts.clis = AGENT_CLIS.map((c) => ({
    command: c.command,
    name: c.name,
    look: run.deps.commandLook(c.command),
  }));
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
  const run = new ProbeRun(opts.profile ?? null, { ...defaultProbeDeps(), ...overrides });
  const profile = run.profile;
  const deps = run.deps;
  const facts: HealthFacts = { profile };
  const jobs: Promise<void>[] = [];
  if (RUNTIME_SCOPES.includes(scope)) jobs.push(gatherRuntime(run, scope, facts));
  if (profile === null && BOOTSTRAP_SCOPES.includes(scope)) jobs.push(gatherBootstrap(run, facts));
  if (CODEX_SCOPES.includes(scope)) jobs.push(gatherCodex(run, facts));
  if (CLAUDE_SCOPES.includes(scope)) jobs.push(gatherClaude(run, facts));
  if (AUTH_SCOPES.includes(scope)) jobs.push(gatherAuth(run, facts));
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
  if (profile === null && SETUP_SCOPES.includes(scope)) jobs.push(gatherSetup(run, facts));
  await Promise.all(jobs);
  return facts;
}
