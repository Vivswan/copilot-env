// The bodies of `agent profile [<name>] <verb>`, one function per verb on the Profile it targets
// (src/commands/profile_verbs.ts routes onto them). The store's profile slot (credential + mode,
// src/copilot_api/env_state.ts) is the source of truth; the agent files are derived from it.
import { consola } from "consola";
import { claudeDesktopStatus, reconcileClaudeDesktopWiring } from "../agents/claude_desktop.ts";
import {
  type AgentAdapter,
  configuringLine,
  type ManagedAgentId,
  type RemoveProfileOptions,
} from "../agents/configure.ts";
import { configureDefaultAgents, runClaude, runCodex } from "../agents/configure_defaults.ts";
import { bothAgents, wireBothAgents, wireProfileAgents } from "../agents/profile_wiring.ts";
import {
  MANAGED_MODE_DETAIL,
  providerModeExitCode,
  type RequestedMode,
} from "../agents/provider_mode.ts";
import { inspectClaudeWiring } from "../claude/config.ts";
import { renderClaudeDesktopStatus } from "../claude/desktop_status.ts";
import { resolveClaudeHome, settingsPathFor } from "../claude/paths.ts";
import { inspectCodexWiring } from "../codex/config.ts";
import { effectiveCodexHome } from "../codex/host.ts";
import { codexConfigPath, codexProfileConfigPath } from "../codex/paths.ts";
import { Credential, ghAuthToken } from "../copilot_api/credential.ts";
import { type ProxyStatus, proxyStatus, stopTrackedProxy } from "../copilot_api/daemon.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import {
  allProfileNames,
  assertKnownProfile,
  AUTH_PROVIDERS,
  CopilotEnvState,
  credentialProvider,
  partialSlotGap,
  type ProfileMode,
} from "../copilot_api/env_state.ts";
import { profileHome, profileHomeNames } from "../copilot_api/paths.ts";
import { copilotApiResolvePort } from "../copilot_api/port.ts";
import { DAEMON_SIGKILL_GRACE_MS } from "../copilot_api/process.ts";
import {
  isReservedProfileWord,
  type Profile,
  profileLabel,
  type ProfileName,
} from "../copilot_api/profile.ts";
import { COLOR_ENABLED, gray, statusPaint } from "../utils/ansi.ts";
import { assertNever } from "../utils/assert.ts";
import { errMessage } from "../utils/error.ts";
import { entryAbsent, readTextResult } from "../utils/fs.ts";
import { createStderrLogger } from "../utils/logger.ts";
import { removeTreeReported } from "../utils/report_write.ts";
import { formatTable, printKeyValue, printWrapped, terminalWidth } from "../utils/table.ts";
import { filePlan, landPlan } from "../utils/write_session.ts";
import { ensureAuthenticated } from "./auth.ts";
import { runDryRun } from "./dry_run.ts";
import { printGuidance } from "./init_guidance.ts";

// Narration to stderr, so a verb whose stdout is a payload keeps it clean.
const logger = createStderrLogger();

/** What a handler says once its writes landed, held back until the dispatcher knows they did: a
 *  dry run prints the plan and drops the narration, so no handler carries a mode flag. */
type Narration = () => void;

// --- add ---------------------------------------------------------------------------------------

export interface AddArgs {
  /** `auto` re-wires the recorded mode; on a fresh default it is the Direct-vs-proxy probe, and a
   *  fresh named profile refuses it (a profile always has exactly one mode). */
  mode: RequestedMode;
  /** Print what the landing would write, attribute by attribute, and write nothing. */
  dryRun?: boolean;
  /** Record the mode alone and print the credential step instead of running it. */
  noAuth?: boolean;
}

/** The credential step `add` runs on a profile that has none: `auth`'s interactive flow, which
 *  then wires both agents. `noAuth` leaves it to `auth` and says so; a dry run names it; a script
 *  with neither is refused BEFORE the mode lands, so nothing is half done. A profile with a
 *  credential is never asked again. */
function credentialStep(profile: Profile, args: AddArgs): () => Promise<void> {
  // Resolving, not merely stored: a gh-cli slot whose gh login is gone is as good as none.
  if (new Credential(undefined, profile).isAuthenticated()) return () => Promise.resolve();
  const authCommand = profile === null ? "agent auth" : `agent profile ${profile} auth`;
  const providers = `--provider <${
    AUTH_PROVIDERS.join("|")
  }>  (or --set <token>, --gh-user <login>)`;
  if (args.noAuth) {
    return () => {
      logger.log(`  Next:  ${authCommand} ${providers}`);
      return Promise.resolve();
    };
  }
  if (args.dryRun) {
    return () => {
      logger.log(`  Would run the credential step (${authCommand}); a dry run never logs in.`);
      return Promise.resolve();
    };
  }
  if (!process.stdin.isTTY) {
    throw new Error(
      `not a terminal - pass --no-auth to record the mode alone, then \`${authCommand} ${providers}\``,
    );
  }
  return () => ensureAuthenticated(profile);
}

/** `agent profile [<name>] add` and `agent init`: the mode for BOTH agents, then the credential
 *  step when the profile has none (a profile without a credential records its mode alone; the
 *  credential landing wires both agents). */
export async function addProfile(profile: Profile, args: AddArgs): Promise<void> {
  const step = credentialStep(profile, args);
  if (profile === null) return addDefault(args, step);
  const land = () => addNamed(profile, args.mode);
  if (args.dryRun) await runDryRun(land);
  else (await land())();
  await step();
}

/** The probe sets a mode on a fresh default; a recorded one is re-wired as it is (a flag moves it,
 *  and the CLI asks first), so no unflagged add can move a mode by a probe's answer. The landing
 *  needs the credential (it probes and writes with the token), so without one the default records
 *  its mode alone, as a named profile does, and the credential step follows; the landing runs
 *  after a login, and waits for `agent init` after --no-auth. */
async function addDefault(args: AddArgs, step: () => Promise<void>): Promise<void> {
  const mode: RequestedMode = args.mode === "auto"
    ? new CopilotEnvState().readProfileSlot(null).mode ?? "auto"
    : args.mode;
  if (!new Credential().isAuthenticated()) {
    if (mode === "auto") {
      if (args.noAuth) {
        throw new Error(
          "pass --direct or --proxy: the default profile has no recorded mode yet, and a " +
            "profile always has exactly one mode",
        );
      }
    } else {
      const record = () => {
        new CopilotEnvState().recordDefaultMode(mode);
        return Promise.resolve();
      };
      if (args.dryRun) await runDryRun(record);
      else {
        await record();
        logger.success(`the default profile records ${mode}; both agents wait for its credential.`);
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
    const outcome = await configureDefaultAgents({ codex: mode, claude: mode });
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

async function addNamed(name: ProfileName, requested: RequestedMode): Promise<Narration> {
  const state = new CopilotEnvState();
  const slot = state.readProfileSlot(name);
  const previous = slot.mode;
  const mode: ProfileMode | null = requested === "auto" ? previous : requested;
  if (mode === null) {
    throw new Error(
      `pass --direct or --proxy: ${profileLabel(name)} does not exist yet, and a profile ` +
        "always has exactly one mode",
    );
  }
  // Switching away from proxy strands the profile's daemon: nothing will route to it anymore (a dry
  // run takes the same path and sends no signal: stopTrackedProxy).
  if (previous === "proxy" && mode === "direct") {
    const { signalled } = await stopTrackedProxy(0, name);
    if (signalled) logger.log(`  Stopped ${profileLabel(name)}'s proxy daemon (now direct).`);
  }
  const switched = previous !== null && previous !== mode ? ` (switched from ${previous})` : "";
  // The credential is `auth`'s: with none, or one that no longer resolves, the mode lands alone
  // and the wiring waits for the credential landing, which wires both agents itself.
  const credential = slot.credential;
  const resolves = credential.kind === "stored" ||
    (credential.kind === "gh-cli" && ghAuthToken(credential.ghUser) !== null);
  if (!resolves) {
    state.recordProfileMode(name, mode);
    return () => {
      logger.success(
        `${profileLabel(name)} records ${mode}${switched}; both agents wait for its credential.`,
      );
    };
  }
  logger.log(configuringLine(profileLabel(name), mode, " (both agents)"));
  // One atomic commit of the whole slot BEFORE the wiring, so the store never holds a half profile;
  // a wiring failure leaves a complete-but-unwired slot that a re-add or `agent sync` re-derives.
  state.commitProfile(name, { credential, mode });
  await wireBothAgents(name, mode, false, "probe");
  return () => {
    logger.success(`${profileLabel(name)} is ready${switched}.`);
    logger.log(`  Launch it:  cl --profile ${name}  /  cx --profile ${name}`);
    if (mode === "proxy") {
      logger.log(
        `  Its proxy daemon starts on demand; manage it with \`agent start/stop --profile ${name}\`.`,
      );
    }
  };
}

// --- del ---------------------------------------------------------------------------------------

/** Dependency order: the daemon holds the credential in memory and an unstoppable one throws before
 *  anything is deleted (a dry run takes the same refusal and otherwise sends no signal); the store
 *  slot goes in one atomic write, credential and mode together. Every removal lands through
 *  landPlan, so a dry run names each file and slot key it would take. Shared with `agent uninstall`. */
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
        `(\`agent stop --profile ${name}\`) before deleting`,
    );
  }
  for (const agent of bothAgents()) landPlan(agent.planRemoveProfile(name, options));
  new CopilotEnvState().deleteProfile(name);
  new CopilotEnvConfig().deleteProfile(name);
  const home = profileHome(name);
  landPlan({
    files: entryAbsent(home) ? [] : [filePlan(home, "delete")],
    apply: () => void removeTreeReported(home),
  });
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

/** One profile's row of the list, as key/value lines: the same words. */
export async function showProfile(profile: Profile): Promise<void> {
  if (profile !== null) assertKnownProfile(profile);
  const slot = new CopilotEnvState().readProfileSlot(profile);
  const daemon = slot.mode === "proxy" ? await proxyStatus(profile) : null;
  printWrapped(profileLabel(profile));
  printKeyValue("  mode", slot.mode ?? "incomplete");
  printKeyValue("  provider", credentialProvider(slot.credential) ?? "no credential");
  // A direct profile has no daemon: "-", never a blank that reads as missing data.
  printKeyValue(
    "  daemon",
    daemon === null ? "-" : daemon.up ? `up (port ${daemon.port})` : "down",
  );
}

/** `daemon` is null for a direct profile, which has none. */
export interface ProfileListRow {
  name: string;
  provider: string | null;
  mode: ProfileMode | null;
  daemon: ProxyStatus | null;
}

export function renderProfileTable(
  rows: ProfileListRow[],
  width: number | null = terminalWidth(),
  color = COLOR_ENABLED,
): string {
  const status = (word: string): string => statusPaint(word, color);
  const cells = rows.map((r) => {
    // A direct profile has no daemon: "-", never a blank that reads as missing data.
    const daemon = r.daemon === null ? "-" : r.daemon.up ? `up (port ${r.daemon.port})` : "down";
    return [
      r.name,
      status(r.mode ?? "incomplete"),
      status(r.provider ?? "no credential"),
      status(daemon),
    ];
  });
  return formatTable(cells, {
    header: ["NAME", "MODE", "PROVIDER", "DAEMON"],
    indent: "     ",
    width,
    color,
  }).join("\n");
}

/** `agent list` and bare `agent profile`: every profile, one row each, then the one hint the list
 *  cannot carry: a profile named before its word became a verb routes as the verb, and the
 *  update's migration renames it. */
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
          name: profile ?? "default",
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
  for (const name of allProfileNames().filter(isReservedProfileWord)) {
    logger.warn(
      `profile '${name}' is named like a verb of \`agent profile\`; \`agent update\` renames it ` +
        `to '${name}-<n>'. Until then address it with \`--profile ${name}\` on the runtime commands.`,
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
        printKeyValue("default", slot.mode ?? "none");
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
    const status = inspectClaudeWiring(readTextResult(path), port, name);
    printKeyValue("Claude provider mode", modeDetail(status.providerMode));
    printKeyValue(`settings-${name}.json`, path);
    process.exitCode = providerModeExitCode(status.providerMode);
    return;
  }
  const home = effectiveCodexHome();
  const profileToml = codexProfileConfigPath(home, name);
  const status = inspectCodexWiring(
    readTextResult(codexConfigPath(home)),
    null,
    port,
    false,
    { profile: name, profileToml: readTextResult(profileToml) },
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
