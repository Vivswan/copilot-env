// The bodies of `agent profile [<name>] <verb>`, one function per verb on the Profile it targets
// (src/commands/profile_verbs.ts routes onto them). The store's profile slot (credential + mode,
// src/copilot_api/env_state.ts) is the source of truth; the agent files are derived from it.
import { consola } from "consola";
import { claudeDesktopStatus, reconcileClaudeDesktopWiring } from "../agents/claude_desktop.ts";
import {
  type AgentAdapter,
  configuringLine,
  decideDefaultMode,
  type ManagedAgentId,
  probedVerdict,
  type RemoveProfileOptions,
} from "../agents/configure.ts";
import { configureDefaultAgents, runClaude, runCodex } from "../agents/configure_defaults.ts";
import { bothAgents, wireBothAgents, wireProfileAgents } from "../agents/profile_wiring.ts";
import {
  type AgentProviderMode,
  MANAGED_MODE_DETAIL,
  type ManagedAgentMode,
  providerModeExitCode,
  type RequestedMode,
} from "../agents/provider_mode.ts";
import { inspectClaudeWiring } from "../claude/config.ts";
import { renderClaudeDesktopStatus } from "../claude/desktop_status.ts";
import { resolveClaudeHome, settingsPathFor } from "../claude/paths.ts";
import { directWiringFor } from "../codex/config.ts";
import { inspectCodexWiring } from "../codex/inspect.ts";
import { effectiveCodexHome } from "../codex/host.ts";
import { codexConfigPath, codexProfileConfigPath } from "../codex/paths.ts";
import { Credential, ghAuthToken } from "../copilot_api/credential.ts";
import { type ProxyStatus, proxyStatus, stopTrackedProxy } from "../copilot_api/daemon.ts";
import { configSetCommand, CopilotEnvConfig } from "../copilot_api/env_config.ts";
import {
  allProfileNames,
  assertKnownProfile,
  AUTH_PROVIDERS,
  CopilotEnvState,
  credentialProvider,
  partialSlotGap,
  type ProfileMode,
  type ProvisionedCredential,
  type StoredCredential,
} from "../copilot_api/env_state.ts";
import { profileHome, profileHomeNames } from "../copilot_api/paths.ts";
import { copilotApiResolvePort } from "../copilot_api/port.ts";
import { DAEMON_SIGKILL_GRACE_MS } from "../copilot_api/process.ts";
import {
  agentAuthCommand,
  agentStopCommand,
  DEFAULT_PROFILE_NAME,
  type Profile,
  profileLabel,
  type ProfileName,
} from "../copilot_api/profile.ts";
import { bold, colorEnabled, gray, statusPaint } from "../utils/ansi.ts";
import { assertNever } from "../utils/assert.ts";
import { errMessage } from "../utils/error.ts";
import { isEnoentOrNotdir } from "../utils/fs.ts";
import * as fs from "../utils/fs_facade.ts";
import { createStderrLogger, prompt } from "../utils/logger.ts";
import { formatTable, printKeyValue, printWrapped, terminalWidth } from "../utils/table.ts";
import { acquireCredential, ensureAuthenticated } from "./auth.ts";
import { runDryRun } from "./dry_run.ts";

// Narration to stderr, so a verb whose stdout is a payload keeps it clean.
const logger = createStderrLogger();

/** What a handler says once its writes landed, held back until the dispatcher knows they did: a
 *  dry run prints the plan and drops the narration, so no handler carries a mode flag. */
type Narration = () => void;

// --- add ---------------------------------------------------------------------------------------

/** What `add` was asked for, past the flag parse (src/commands/profile_verbs.ts): a flag's mode,
 *  `auto` (--auto: the Direct-vs-proxy probe's verdict), or `unflagged` (no mode flag). The default
 *  profile probes on `unflagged` exactly as on `auto`, every run; a named profile re-wires its
 *  recorded mode on `unflagged` and refuses a fresh one (a profile always has exactly one mode). */
export type AddMode = ManagedAgentMode | "auto" | "unflagged";

export interface AddArgs {
  mode: AddMode;
  /** Print what the landing would write, attribute by attribute, and write nothing. */
  dryRun?: boolean;
  /** Record the mode alone and print the credential step instead of running it. */
  noAuth?: boolean;
  /** Move a recorded mode without asking: to the flag's mode, or to the probe's verdict. */
  yes?: boolean;
}

/** `add`'s question before a recorded mode moves, in one wording: asked at the CLI boundary for a
 *  flag, and by the landing for a probe verdict that differs from the record (followProbe). */
export function modeSwitchQuestion(
  profile: Profile,
  recorded: ProfileMode,
  mode: ProfileMode,
): string {
  return `Switch ${whose(profile)} from ${recorded} to ${mode}? Both agents' files are rewritten.`;
}

function whose(profile: Profile): string {
  return profile === null ? "the default profile" : profileLabel(profile);
}

/** Whether this add decides its mode by the probe (which needs the credential first). */
function probes(profile: Profile, mode: AddMode): boolean {
  return mode === "auto" || (mode === "unflagged" && profile === null);
}

const NO_CREDENTIAL_TO_PROBE =
  "no credential to probe with; pass --direct or --proxy, or run without --no-auth";

const AUTH_PROVIDERS_HELP = `--provider <${
  AUTH_PROVIDERS.join("|")
}>  (or --set <token>, --gh-user <login>)`;

/** The landing's answer when the probe's verdict differs from the recorded mode: one line says so,
 *  then the question a flag-driven switch asks. `--yes` answers it; a script (no terminal), a dry
 *  run, or a "no" keeps the record and names the flag that would move it. */
async function followProbe(
  profile: Profile,
  recorded: ProfileMode,
  verdict: ProfileMode,
  args: AddArgs,
): Promise<ProfileMode> {
  logger.log(`  The probe says ${verdict}; ${whose(profile)} records ${recorded}.`);
  if (args.yes) return verdict;
  const keep = (why: string): ProfileMode => {
    logger.log(
      `  Keeping ${recorded}${why}; pass --${verdict} to switch, or --yes to follow the probe.`,
    );
    return recorded;
  };
  if (args.dryRun) return keep(" (a dry run asks nothing)");
  if (!process.stdin.isTTY) return keep(" (not a terminal)");
  const confirmed = await prompt(modeSwitchQuestion(profile, recorded, verdict), {
    type: "confirm",
    initial: false,
  });
  return confirmed === true ? verdict : keep("");
}

/** The box the default's `add` closes with: what each agent was wired to and the next steps. */
function modeLabel(mode: AgentProviderMode): string {
  if (mode === "direct") return "GitHub Copilot Direct";
  if (mode === "proxy") return "the local proxy";
  // "other" is any config that is not ours: a foreign provider, but also a
  // malformed or unreadable one (the classifiers fold read/parse failures in).
  if (mode === "other") return "a custom or unrecognized provider config (not managed)";
  if (mode === "none") return "not configured";
  return assertNever(mode);
}

function printGuidance(
  codex: AgentProviderMode,
  claude: AgentProviderMode,
  usedToken = false,
  failedAgents: readonly ManagedAgentId[] = [],
): void {
  const bothDirect = codex === "direct" && claude === "direct";
  const anyProxy = codex === "proxy" || claude === "proxy";

  // A write that failed left that agent's files as they were: "unchanged", never "not configured".
  const label = (agent: ManagedAgentId, mode: AgentProviderMode): string =>
    failedAgents.includes(agent)
      ? "unchanged (this run's write failed; see the warning above)"
      : modeLabel(mode);
  const lines: string[] = [
    `Codex   →  ${label("codex", codex)}`,
    `Claude  →  ${label("claude", claude)}`,
  ];

  // Backticked commands render as highlighted inline code inside the box, so no space-padded
  // columns.
  const section = (title: string, items: string[]): void => {
    lines.push("", bold(title));
    for (const item of items) lines.push(`  • ${item}`);
  };

  if (anyProxy) {
    lines.push("", "At least one agent uses the local proxy.");
    section("Start the proxy", [
      "`agent start` - launch the daemon",
      `\`${
        configSetCommand("shell.launchers", "true")
      }\` - \`cl\` / \`cx\` then auto-start it for you`,
      "`agent cost` - report proxy usage",
    ]);
  } else if (bothDirect) {
    const tail = usedToken ? " (using your GitHub token - no `gh` CLI needed)." : ".";
    lines.push("", `Both agents use GitHub Copilot Direct - no local proxy needed${tail}`);
    section("Run the agents", [
      "Just use `claude` and `codex` - no `agent start` / `agent stop`",
      `\`${
        configSetCommand("shell.launchers", "true")
      }\` - optional \`cl\` / \`co\` / \`cx\` shortcuts`,
    ]);
    section("Good to know", [
      "`agent cost` reports proxy usage only - Direct usage won't appear",
      "Model aliases come from the proxy; in Direct, use the provider's exact ids",
    ]);
  } else {
    lines.push("", "Mixed setup - the agents aren't configured the same way.");
    const steps = ["Anything unconfigured? Re-run `agent init` or check `agent health`"];
    if (codex === "direct" || claude === "direct") {
      steps.unshift("The Direct agent needs no proxy - run it directly");
    }
    section("Next steps", steps);
  }

  section("Profiles (optional)", [
    "Run several sessions at once - direct, proxy, or another account.",
    "A profile = one credential + one mode, wired into BOTH agents:",
    "`agent profile <name> add --direct|--proxy` → `cl --profile <name>` / `cx --profile <name>`",
    "`agent profile` lists them; `agent profile <name> del` removes one.",
  ]);

  if (bothDirect) {
    lines.push(
      "",
      "if needed, switch everything to the proxy:  `agent init --proxy`, then `agent start`",
    );
  }

  logger.log("");
  logger.box(lines.join("\n"));
}

/** The credential step `add` runs on a profile that has none: `auth`'s interactive flow, which
 *  then wires both agents. `noAuth` leaves it to `auth` and says so; a dry run names it; a script
 *  with neither is refused BEFORE the mode lands, so nothing is half done. A profile with a
 *  credential is never asked again. */
function credentialStep(profile: Profile, args: AddArgs): () => Promise<void> {
  // Resolving, not merely stored: a gh-cli slot whose gh login is gone is as good as none.
  if (new Credential(undefined, profile).isAuthenticated()) return () => Promise.resolve();
  const authCommand = agentAuthCommand(profile);
  if (args.noAuth) {
    return () => {
      logger.log(`  Next:  ${authCommand} ${AUTH_PROVIDERS_HELP}`);
      return Promise.resolve();
    };
  }
  if (args.dryRun) {
    return () => {
      logger.log(`  Would run the credential step (${authCommand}); a dry run never logs in.`);
      return Promise.resolve();
    };
  }
  if (!process.stdin.isTTY) throw notATerminal(profile, args.mode);
  return () => ensureAuthenticated(profile);
}

/** A script without a credential: a probing add has nothing to probe with, a flagged one can
 *  record its mode alone. */
function notATerminal(profile: Profile, mode: AddMode): Error {
  const record = probes(profile, mode)
    ? "pass --direct or --proxy with --no-auth to record the mode alone"
    : "pass --no-auth to record the mode alone";
  return new Error(
    `not a terminal - ${record}, then \`${agentAuthCommand(profile)} ${AUTH_PROVIDERS_HELP}\``,
  );
}

/** `agent profile [<name>] add` and `agent init`: the mode for BOTH agents, then the credential
 *  step when the profile has none (a profile without a credential records its mode alone; the
 *  credential landing wires both agents). `--auto` on a named profile runs the two in the other
 *  order, since the probe needs the credential. `adapters` is the landing's pair (the test seam). */
export async function addProfile(
  profile: Profile,
  args: AddArgs,
  adapters: readonly AgentAdapter[] = bothAgents(),
): Promise<void> {
  if (profile === null) return addDefault(args, credentialStep(null, args), adapters);
  if (args.mode === "auto") return addNamedProbed(profile, args, adapters);
  const step = credentialStep(profile, args);
  const requested = args.mode;
  const land = () => addNamed(profile, requested, adapters);
  if (args.dryRun) await runDryRun(land);
  else (await land())();
  await step();
}

/** `agent init`: the default's landing. No flag, or --auto, probes EVERY run and lands the
 *  verdict; a verdict that differs from the record asks first (followProbe). --direct / --proxy
 *  land that mode with no probe (the CLI asked before a move). The landing probes and writes with
 *  the credential, so a flagged default without one records its mode alone and the credential step
 *  follows, while a probing default has nothing to record until the step lands the credential
 *  (--no-auth is refused). */
async function addDefault(
  args: AddArgs,
  step: () => Promise<void>,
  adapters: readonly AgentAdapter[],
): Promise<void> {
  const flagged: ManagedAgentMode | null = args.mode === "auto" || args.mode === "unflagged"
    ? null
    : args.mode;
  if (!new Credential().isAuthenticated()) {
    if (flagged === null) {
      if (args.noAuth) throw new Error(NO_CREDENTIAL_TO_PROBE);
    } else {
      const record = () => {
        new CopilotEnvState().recordDefaultMode(flagged);
        return Promise.resolve();
      };
      if (args.dryRun) await runDryRun(record);
      else {
        await record();
        logger.success(
          `the default profile records ${flagged}; both agents wait for its credential.`,
        );
      }
    }
    await step();
    // Only the interactive step lands a credential; the printed or planned step leaves the wiring
    // to the login that follows.
    if (!new Credential().isAuthenticated()) return;
  }
  const land = async () => {
    // Every mode, proxy included: a failed login throws, so no agent is configured without a
    // credential. The auto probe below then judges THIS credential's Direct access.
    await ensureAuthenticated();
    const mode: RequestedMode = flagged ?? "auto";
    const outcome = await configureDefaultAgents({
      codex: mode,
      claude: mode,
      onVerdict: (recorded, verdict) => followProbe(null, recorded, verdict, args),
    }, adapters);
    // configureDefaultAgents wrote only the default's Desktop entry; this covers the named
    // profiles.
    await reconcileClaudeDesktopWiring();
    return outcome;
  };
  if (args.dryRun) {
    await runDryRun(land);
    return;
  }
  const { codex, claude, failedAgents } = await land();
  printGuidance(codex, claude, new CopilotEnvState().read().githubToken !== null, failedAgents);
}

/** A named profile's credential as the landing wires it: a stored token as it is, a gh-cli slot
 *  through gh (a login that is gone is as good as none). Null when nothing resolves. */
function resolveProvisioned(
  credential: StoredCredential,
): { credential: ProvisionedCredential; token: string } | null {
  if (credential.kind === "stored") return { credential, token: credential.token };
  if (credential.kind === "gh-cli") {
    const token = ghAuthToken(credential.ghUser);
    return token === null ? null : { credential, token };
  }
  return null;
}

/** `agent profile <name> add [--direct|--proxy]`: the flag's mode, or the recorded one with no
 *  flag (a fresh name needs a flag, or --auto). The credential is `auth`'s: with none, or one
 *  that no longer resolves, the mode lands alone and the wiring waits for the credential landing,
 *  which wires both agents itself. */
async function addNamed(
  name: ProfileName,
  requested: ManagedAgentMode | "unflagged",
  adapters: readonly AgentAdapter[],
): Promise<Narration> {
  const state = new CopilotEnvState();
  const slot = state.readProfileSlot(name);
  const mode: ProfileMode | null = requested === "unflagged" ? slot.mode : requested;
  if (mode === null) {
    throw new Error(
      `pass --direct, --proxy, or --auto: ${profileLabel(name)} does not exist yet, and a ` +
        "profile always has exactly one mode",
    );
  }
  const resolved = resolveProvisioned(slot.credential);
  await stopIfLeavingProxy(name, slot.mode, mode);
  if (resolved === null) {
    state.recordProfileMode(name, mode);
    return () => {
      logger.success(
        `${profileLabel(name)} records ${mode}${
          switchedFrom(slot.mode, mode)
        }; both agents wait for its credential.`,
      );
    };
  }
  return landNamed(name, slot.mode, mode, resolved.credential, adapters);
}

/** `agent profile <name> add --auto`: the profile's own credential first (acquired, not yet
 *  recorded: a fresh name has no slot for `auth` to land in), then the Direct-vs-proxy probe under
 *  it, then credential and verdict committed together and both agents wired. A recorded mode the
 *  verdict differs from asks first (followProbe). Without a credential there is nothing to probe
 *  with: --no-auth is refused, and a dry run names the credential step and plans nothing. */
async function addNamedProbed(
  name: ProfileName,
  args: AddArgs,
  adapters: readonly AgentAdapter[],
): Promise<void> {
  const slot = new CopilotEnvState().readProfileSlot(name);
  let resolved = resolveProvisioned(slot.credential);
  if (resolved === null) {
    if (args.noAuth) throw new Error(NO_CREDENTIAL_TO_PROBE);
    if (args.dryRun) {
      logger.log(
        `  Would run the credential step (${agentAuthCommand(name)}); a dry run never logs in.`,
      );
      return;
    }
    if (!process.stdin.isTTY) throw notATerminal(name, args.mode);
    logger.log(
      `  ${profileLabel(name)} is not authenticated yet - let's log in to GitHub Copilot.`,
    );
    resolved = resolveProvisioned(await acquireCredential({ kind: "choose" }, name));
    if (resolved === null) {
      throw new Error(`${profileLabel(name)}'s new credential does not resolve; retry the login`);
    }
  }
  const { credential, token } = resolved;
  const land = async (): Promise<Narration> => {
    // The probe runs as THIS profile: its own pair selection, and its token baked into the
    // throwaway config the agent CLI runs against (a fresh name has no slot a resolver command
    // could read).
    const chosen = await decideDefaultMode(adapters, token, {
      resolveDirect: () => directWiringFor(name, token, "probe"),
      credential: { kind: "static", token },
    });
    const verdict = probedVerdict(chosen);
    const mode = slot.mode === null || slot.mode === verdict
      ? verdict
      : await followProbe(name, slot.mode, verdict, args);
    await stopIfLeavingProxy(name, slot.mode, mode);
    return landNamed(name, slot.mode, mode, credential, adapters);
  };
  if (args.dryRun) await runDryRun(land);
  else (await land())();
}

function switchedFrom(previous: ProfileMode | null, mode: ProfileMode): string {
  return previous !== null && previous !== mode ? ` (switched from ${previous})` : "";
}

/** Switching away from proxy strands the profile's daemon: nothing will route to it anymore (a dry
 *  run takes the same path and sends no signal: stopTrackedProxy). Runs at the mode decision,
 *  whether or not a credential lets the wiring follow. */
async function stopIfLeavingProxy(
  name: ProfileName,
  previous: ProfileMode | null,
  mode: ProfileMode,
): Promise<void> {
  if (previous !== "proxy" || mode !== "direct") return;
  const { signalled } = await stopTrackedProxy(0, name);
  if (signalled) logger.log(`  Stopped ${profileLabel(name)}'s proxy daemon (now direct).`);
}

/** The wiring of a named profile whose credential resolves: one atomic commit of the whole slot
 *  BEFORE the writes, so the store never holds a half profile; a wiring failure leaves a
 *  complete-but-unwired slot that a re-add or `agent sync` re-derives. */
async function landNamed(
  name: ProfileName,
  previous: ProfileMode | null,
  mode: ProfileMode,
  credential: ProvisionedCredential,
  adapters: readonly AgentAdapter[],
): Promise<Narration> {
  logger.log(configuringLine(profileLabel(name), mode, " (both agents)"));
  new CopilotEnvState().commitProfile(name, { credential, mode });
  await wireProfileAgents(name, mode, false, "probe", adapters);
  return () => {
    logger.success(`${profileLabel(name)} is ready${switchedFrom(previous, mode)}.`);
    logger.log(`  Launch it:  cl --profile ${name}  /  cx --profile ${name}`);
    if (mode === "proxy") {
      logger.log(
        `  Its proxy daemon starts on demand; manage it with \`agent profile ${name} start\` / \`stop\`.`,
      );
    }
  };
}

// --- del ---------------------------------------------------------------------------------------

/** Dependency order: the daemon holds the credential in memory and an unstoppable one throws before
 *  anything is deleted (a dry run takes the same refusal and otherwise sends no signal); the store
 *  slot goes in one atomic write, credential and mode together. Every removal goes through the
 *  facade, so a dry run names each file and slot key it would take. Shared with `agent uninstall`. */
export async function deleteProfileEverywhere(
  name: ProfileName,
  options: RemoveProfileOptions = {},
): Promise<void> {
  const { stopped } = await stopTrackedProxy(DAEMON_SIGKILL_GRACE_MS, name);
  // Anything short of CONFIRMED stopped aborts (a kill survivor, or a stop refused because the pid
  // could not be corroborated as ours): deleting the home under a possibly-live daemon would
  // corrupt what it is writing.
  if (!stopped) {
    throw new Error(
      `${profileLabel(name)}'s proxy daemon did not stop; retry, or stop it manually ` +
        `(\`${agentStopCommand(name)}\`) before deleting`,
    );
  }
  for (const agent of bothAgents()) agent.removeProfile(name, options);
  new CopilotEnvState().deleteProfile(name);
  new CopilotEnvConfig().deleteProfile(name);
  try {
    fs.rm(profileHome(name), { recursive: true, force: true });
  } catch (e) {
    // A lookup under a regular file where `profiles/` should be is ENOTDIR: nothing of the
    // profile's is there to remove.
    if (!isEnoentOrNotdir(e)) throw e;
  }
}

/** `agent profile <name> del`: a NAMED profile everywhere; the default is not deletable (the CLI
 *  refuses it before asking). */
export async function delProfile(name: ProfileName, dryRun: boolean): Promise<void> {
  const land = async (): Promise<Narration> => {
    // A foreign same-named settings-<name>.json or a hand-made [model_providers.copilot-env-<name>]
    // is not ours to delete unless the store or home says the profile was real.
    const existed = new CopilotEnvState().profileSlotStatus(name).exists ||
      profileHomeNames().includes(name) ||
      Object.hasOwn(new CopilotEnvConfig().read().profiles, name);
    if (!existed) {
      consola.info(`${profileLabel(name)} does not exist - nothing to delete.`);
      process.exitCode = 1;
      return () => {};
    }
    await deleteProfileEverywhere(name);
    return () =>
      consola.success(`Deleted ${profileLabel(name)} (credential, wiring, daemon home).`);
  };
  if (dryRun) await runDryRun(land);
  else (await land())();
}

// --- show, list --------------------------------------------------------------------------------

/** The daemon cell of `show` and the list. A direct profile has no daemon: "-", never a blank that
 *  reads as missing data. */
function daemonCell(daemon: ProxyStatus | null): string {
  return daemon === null ? "-" : daemon.up ? `up (port ${daemon.port})` : "down";
}

/** One profile's row of the list, as key/value lines: the same words. */
export async function showProfile(profile: Profile): Promise<void> {
  if (profile !== null) assertKnownProfile(profile);
  const slot = new CopilotEnvState().readProfileSlot(profile);
  const daemon = slot.mode === "proxy" ? await proxyStatus(profile) : null;
  printWrapped(profileLabel(profile));
  printKeyValue("  mode", slot.mode ?? "incomplete");
  printKeyValue("  provider", credentialProvider(slot.credential) ?? "no credential");
  printKeyValue("  daemon", daemonCell(daemon));
}

/** `daemon` is null for a direct profile, which has none. */
interface ProfileListRow {
  name: string;
  provider: string | null;
  mode: ProfileMode | null;
  daemon: ProxyStatus | null;
}

export function renderProfileTable(
  rows: ProfileListRow[],
  width: number | null = terminalWidth(),
  color = colorEnabled(),
): string {
  const status = (word: string): string => statusPaint(word, color);
  const cells = rows.map((r) => [
    r.name,
    status(r.mode ?? "incomplete"),
    status(r.provider ?? "no credential"),
    status(daemonCell(r.daemon)),
  ]);
  return formatTable(cells, {
    header: ["NAME", "MODE", "PROVIDER", "DAEMON"],
    indent: "     ",
    width,
    color,
  }).join("\n");
}

/** `agent list` and bare `agent profile`: every profile, one row each. */
export async function listProfiles(): Promise<void> {
  const state = new CopilotEnvState();
  // The default is a profile too: a row as soon as its slot carries anything.
  const defaultSlot = state.readProfileSlot(null);
  const profiles: Profile[] = [
    ...(defaultSlot.mode !== null || defaultSlot.credential.kind !== "none" ? [null] : []),
    ...allProfileNames(),
  ];
  if (profiles.length === 0) {
    consola.info("No profiles yet. Create one: `agent profile <name> add --direct|--proxy`.");
  } else {
    // Concurrent probes: each can spend the full connect timeout on a wedged daemon, and paid
    // serially that would make the list crawl once a couple of profiles are down.
    const rows: ProfileListRow[] = await Promise.all(
      profiles.map(async (profile): Promise<ProfileListRow> => {
        const slot = state.readProfileSlot(profile);
        const daemon = slot.mode === "proxy" ? await proxyStatus(profile) : null;
        return {
          name: profile ?? DEFAULT_PROFILE_NAME,
          provider: credentialProvider(slot.credential),
          mode: slot.mode,
          daemon,
        };
      }),
    );
    // One message, so consola stamps one prefix instead of one per row.
    const hint = gray("   Launch one:  cl --profile <name>  /  cx --profile <name>");
    consola.info(
      `${rows.length} profile${rows.length === 1 ? "" : "s"}:\n\n${
        renderProfileTable(rows)
      }\n\n${hint}\n`,
    );
  }
}

// --- sync --------------------------------------------------------------------------------------

/** The adapters `--claude` | `--codex` select; no flag is both. */
function agentsNamed(agent: ManagedAgentId | null): AgentAdapter[] {
  return bothAgents().filter((adapter) => agent === null || adapter.id === agent);
}

/** The default's re-render, each agent through its own writer (configure_defaults.ts): the
 *  recorded mode, never a move. The Desktop reconcile rides on Claude's write. */
async function syncDefault(agent: ManagedAgentId | null): Promise<void> {
  const configure = { kind: "configure", mode: "auto" } as const;
  await ensureAuthenticated();
  if (agent !== "codex") await runClaude(configure);
  if (agent !== "claude") await runCodex(configure);
  // The default's Desktop entry rode on the write itself; the reconcile covers the named profiles.
  if (agent !== "codex") await reconcileClaudeDesktopWiring();
}

/** A named profile's re-render from its slot, `agents` alone. */
async function syncNamed(name: ProfileName, agents: readonly AgentAdapter[]): Promise<void> {
  const slot = new CopilotEnvState().readProfileSlot(name);
  if (slot.kind === "partial") throw new Error(partialSlotGap(name, slot));
  await wireProfileAgents(name, slot.mode, true, "stored", agents);
}

/** `agent profile [<name>] sync [--claude|--codex]`: the agent files from the recorded mode, one
 *  agent or both; a mode is set by `add` alone. */
export async function syncProfile(
  profile: Profile,
  agent: ManagedAgentId | null,
  dryRun: boolean,
): Promise<void> {
  if (profile === null) {
    const land = () => syncDefault(agent);
    if (dryRun) await runDryRun(land);
    else await land();
    return;
  }
  const agents = agentsNamed(agent);
  const land = () => syncNamed(profile, agents);
  if (dryRun) {
    await runDryRun(land);
    return;
  }
  await land();
  const only = agent === null ? "" : ` (${agents.map((adapter) => adapter.label).join(", ")} only)`;
  logger.log(`  ✓ Synced ${profileLabel(profile)}${only}.`);
}

/** Every NAMED profile from its slot, quiet and discovery-free (the launcher's hook); the
 *  default's re-render is `agent sync`'s, which counts it in. One broken profile never blocks the
 *  rest; the count of failures is the caller's exit code. */
export async function syncNamedProfiles(): Promise<{ synced: number; failed: number }> {
  let synced = 0;
  let failed = 0;
  const state = new CopilotEnvState();
  for (const name of state.profileNames()) {
    const slot = state.readProfileSlot(name);
    if (slot.kind !== "complete") continue;
    try {
      await wireBothAgents(name, slot.mode, true, "stored");
      synced++;
    } catch (e) {
      failed++;
      logger.warn(`could not sync ${profileLabel(name)}: ${errMessage(e)}`);
    }
  }
  // Cleanup only: the profile writes above landed their own entries, and the launcher hot path
  // never probes or discovers. Zero complete profiles still sweep.
  await reconcileClaudeDesktopWiring({ quiet: true });
  return { synced, failed };
}

/** `agent sync`: every profile's re-render. The default's is `profile sync`'s (each agent's own,
 *  the Desktop entry discovered); the named loop is the launcher's quiet hook and stays
 *  discovery-free, so the default is not folded into it. One landing for both phases, so a dry
 *  run plans the named files over the default's planned content and prints one plan. The
 *  default's failure is recorded, never a stop: the named sweep still runs, and the exit code says
 *  a profile did not land. */
export async function syncEveryProfile(dryRun: boolean): Promise<void> {
  const land = async (): Promise<Narration> => {
    const withDefault = new CopilotEnvState().readProfileSlot(null).kind === "complete";
    let defaultSynced = 0;
    if (withDefault) {
      try {
        await syncDefault(null);
        defaultSynced = 1;
      } catch (e) {
        logger.warn(`could not sync the default profile: ${errMessage(e)}`);
        process.exitCode = 1;
      }
    }
    const named = await syncNamedProfiles();
    if (named.failed > 0) process.exitCode = 1;
    const synced = named.synced + defaultSynced;
    return () =>
      logger.log(
        `  ✓ Synced ${synced} profile${synced === 1 ? "" : "s"}${
          defaultSynced === 1 ? " (the default included)" : ""
        }.`,
      );
  };
  if (dryRun) await runDryRun(land);
  else (await land())();
}

// --- check -------------------------------------------------------------------------------------

/** Tails the `--check` provider report (src/agents/configure.ts) on stdout; it never touches the
 *  exit code. */
export function printClaudeDesktopCheck(): void {
  const { lines, fix } = renderClaudeDesktopStatus(claudeDesktopStatus());
  const [head, ...rest] = lines;
  printKeyValue("Claude Desktop", head ?? "");
  for (const line of rest) printWrapped(`  ${line}`);
  if (fix !== null) printWrapped(`  fix: ${fix}`);
}

/** The launcher contract, driven by the store slot. A missing or partial profile exits as "other"
 *  (never start a daemon): a partial slot is never launchable. */
function checkSlot(profile: Profile): void {
  const slot = new CopilotEnvState().readProfileSlot(profile);
  switch (slot.kind) {
    case "partial":
      if (profile === null) {
        printKeyValue(profileLabel(profile), slot.mode ?? "none");
        printWrapped("  the default profile has no complete wiring yet - run `agent init`");
      } else {
        printWrapped(partialSlotGap(profile, slot));
      }
      process.exitCode = providerModeExitCode("other");
      return;
    case "complete":
      printKeyValue(profileLabel(profile), slot.mode);
      process.exitCode = providerModeExitCode(slot.mode);
      return;
    default:
      assertNever(slot);
  }
}

function modeDetail(mode: "direct" | "proxy" | "other" | "none"): string {
  switch (mode) {
    case "direct":
    case "proxy":
      return `${mode} (${MANAGED_MODE_DETAIL[mode]})`;
    case "other":
      return "other (a provider copilot-env does not manage)";
    case "none":
      return "none (not wired)";
    default:
      return assertNever(mode);
  }
}

/** One agent's file of a NAMED profile, read as the launcher reads it: `settings-<name>.json`, or
 *  `<name>.config.toml`'s selection into config.toml. The exit code is the provider-mode
 *  contract, as for the default's per-agent check. */
function checkNamedAgent(name: ProfileName, agent: ManagedAgentId): void {
  const port = Number(copilotApiResolvePort(name));
  if (agent === "claude") {
    const path = settingsPathFor(resolveClaudeHome(), name);
    const status = inspectClaudeWiring(fs.readTextResult(path), port, name);
    printKeyValue("Claude provider mode", modeDetail(status.providerMode));
    printKeyValue(`settings-${name}.json`, path);
    process.exitCode = providerModeExitCode(status.providerMode);
    return;
  }
  const home = effectiveCodexHome();
  const profileToml = codexProfileConfigPath(home, name);
  const status = inspectCodexWiring(
    fs.readTextResult(codexConfigPath(home)),
    null,
    port,
    false,
    { profile: name, profileToml: fs.readTextResult(profileToml) },
  );
  printKeyValue("Codex provider mode", modeDetail(status.providerMode));
  printKeyValue(`${name}.config.toml`, profileToml);
  process.exitCode = providerModeExitCode(status.providerMode);
}

/** `agent profile [<name>] check [--claude|--codex]`: the recorded mode on the launcher exit-code
 *  contract, or one agent's own file (the default's Claude check adds the Desktop status). */
export async function checkProfile(profile: Profile, agent: ManagedAgentId | null): Promise<void> {
  if (agent === null) {
    checkSlot(profile);
    return;
  }
  if (profile !== null) {
    checkNamedAgent(profile, agent);
    return;
  }
  switch (agent) {
    case "claude":
      // The exit code stays the provider-mode contract; the Desktop status only prints.
      await runClaude({ kind: "check" });
      printClaudeDesktopCheck();
      return;
    case "codex":
      await runCodex({ kind: "check" });
      return;
    default:
      assertNever(agent);
  }
}
