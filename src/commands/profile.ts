// The store's profile slot (credential + mode, src/copilot_api/env_state.ts) is the source of
// truth; the per-agent artifacts (settings-<name>.json, <name>.config.toml beside config.toml) are
// derived from it.
import { consola } from "consola";
import { reconcileClaudeDesktopWiring } from "../agents/claude_desktop.ts";
import { configuringLine, type RemoveProfileOptions } from "../agents/configure.ts";
import { bothAgents, wireBothAgents } from "../agents/profile_wiring.ts";
import { providerModeExitCode, type RequestedMode } from "../agents/provider_mode.ts";
import { resolveClaudeHome, settingsPathFor } from "../claude/paths.ts";
import { ghAuthToken } from "../copilot_api/credential.ts";
import { type ProxyStatus, proxyStatus, stopTrackedProxy } from "../copilot_api/daemon.ts";
import { CopilotEnvConfig } from "../copilot_api/env_config.ts";
import {
  allProfileNames,
  CopilotEnvState,
  credentialProvider,
  partialSlotGap,
  type ProfileMode,
  type ProfileSlot,
  type ProvisionedCredential,
} from "../copilot_api/env_state.ts";
import { profileHome, profileHomeNames } from "../copilot_api/paths.ts";
import { DAEMON_SIGKILL_GRACE_MS } from "../copilot_api/process.ts";
import { parseProfileFlag, profileLabel, type ProfileName } from "../copilot_api/profile.ts";
import { COLOR_ENABLED, gray, statusPaint } from "../utils/ansi.ts";
import { assertNever } from "../utils/assert.ts";
import { errMessage } from "../utils/error.ts";
import { isEnoentOrNotdir } from "../utils/fs.ts";
import * as fs from "../utils/fs_facade.ts";
import { createStderrLogger } from "../utils/logger.ts";
import { formatTable, printKeyValue, printWrapped, terminalWidth } from "../utils/table.ts";
import { landPlan } from "../utils/write_session.ts";
import { runDryRun } from "./dry_run.ts";
import {
  acquireCredential,
  type CredentialAcquisition,
  isPlannedCredential,
  liveCredentialSourceLabel,
  parseAcquisition,
} from "./auth.ts";

// Narration to stderr so `--settings-for`'s stdout stays a clean machine-readable path.
const logger = createStderrLogger();

export interface ProfileArgs {
  add?: string;
  del?: string;
  list?: boolean;
  check?: string;
  settingsFor?: string;
  sync?: boolean;
  mode: RequestedMode;
  provider?: string;
  set?: string;
  ghUser?: string;
  /** Print what the write would change, attribute by attribute, and write nothing. */
  dryRun?: boolean;
}

export type ProfileAction =
  | { kind: "add"; name: ProfileName; mode: RequestedMode; acquisition: CredentialAcquisition }
  | { kind: "del"; name: ProfileName }
  | { kind: "check"; name: ProfileName }
  | { kind: "settings-for"; name: ProfileName }
  | { kind: "sync" }
  | { kind: "list" };

export function parseProfileAction(args: ProfileArgs): ProfileAction {
  const actions = [args.add, args.del, args.check, args.settingsFor].filter(
    (v) => v !== undefined,
  ).length;
  const subActions = actions + (args.list ? 1 : 0) + (args.sync ? 1 : 0);
  if (subActions !== 1) {
    throw new Error(
      "pass exactly one of --add <name>, --del <name>, --list, --check <name>, " +
        "--settings-for <name>, --sync",
    );
  }
  if (args.dryRun && (args.list || args.check !== undefined)) {
    throw new Error(
      "--dry-run previews a write (--add, --del, --sync, --settings-for); --list and --check write nothing",
    );
  }
  if (args.mode !== "auto" && args.add === undefined) {
    throw new Error("--direct/--proxy only apply to --add (a profile's mode is set there)");
  }
  if (
    (args.provider !== undefined || args.set !== undefined || args.ghUser !== undefined) &&
    args.add === undefined
  ) {
    throw new Error(
      "--provider/--set/--gh-user only apply to --add (re-auth an existing profile with `agent auth --profile <name>`)",
    );
  }
  const add = parseProfileFlag(args.add);
  if (add !== null) {
    // setConflictWins: unlike `agent auth`, the --set conflict is reported even over a bogus
    // provider name.
    return {
      kind: "add",
      name: add,
      mode: args.mode,
      acquisition: parseAcquisition(args.provider, args.set, args.ghUser, {
        setConflictWins: true,
      }),
    };
  }
  const del = parseProfileFlag(args.del);
  if (del !== null) return { kind: "del", name: del };
  const check = parseProfileFlag(args.check);
  if (check !== null) return { kind: "check", name: check };
  const settingsFor = parseProfileFlag(args.settingsFor);
  if (settingsFor !== null) return { kind: "settings-for", name: settingsFor };
  if (args.sync) return { kind: "sync" };
  return { kind: "list" };
}

/** What a handler says once its writes landed, held back until the dispatcher knows they did: a
 *  dry run prints the plan and drops the narration, so no handler carries a mode flag. */
type Narration = () => void;

async function runAdd(
  name: ProfileName,
  requested: RequestedMode,
  acquisition: CredentialAcquisition,
): Promise<Narration> {
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
  const credential = await profileCredential(name, slot, acquisition);
  // A wiring uses the token: a Direct write selects its identity with it, and Claude Desktop's
  // model discovery fetches with it in either mode. A dry run's stand-in for a login that did not
  // run selects and fetches nothing, so no wiring is planned from it.
  if (isPlannedCredential(credential)) {
    throw new Error(
      `a dry run cannot plan ${profileLabel(name)}'s wiring before its credential lands (the ` +
        "Direct identity and Claude Desktop's model rows are selected with it); pass --set " +
        `<token>, or run \`agent profile --add ${name} --${mode}\` for real`,
    );
  }
  // Switching away from proxy strands the profile's daemon: nothing will route to it anymore (a dry
  // run takes the same path and sends no signal: stopTrackedProxy).
  if (previous === "proxy" && mode === "direct") {
    const { signalled } = await stopTrackedProxy(0, name);
    if (signalled) logger.log(`  Stopped ${profileLabel(name)}'s proxy daemon (now direct).`);
  }
  logger.log(configuringLine(profileLabel(name), mode, " (both agents)"));
  // One atomic commit of the whole slot BEFORE the wiring, so the store never holds a half profile;
  // a wiring failure leaves a complete-but-unwired slot that a re-add or the launchers' `--sync`
  // re-derives.
  state.commitProfile(name, { credential, mode });
  await wireBothAgents(name, mode, false, "probe");
  return () => {
    const switched = previous !== null && previous !== mode ? ` (switched from ${previous})` : "";
    logger.success(`${profileLabel(name)} is ready${switched}.`);
    logger.log(`  Launch it:  cl --profile ${name}  /  cx --profile ${name}`);
    if (mode === "proxy") {
      logger.log(
        `  Its proxy daemon starts on demand; manage it with \`agent start/stop --profile ${name}\`.`,
      );
    }
  };
}

/** Never the default's credential: a named profile never falls back. Reuse is judged on the one
 *  slot snapshot the caller read, never a second store read, so the value returned is exactly the
 *  value judged. */
async function profileCredential(
  name: ProfileName,
  slot: ProfileSlot,
  acquisition: CredentialAcquisition,
): Promise<ProvisionedCredential> {
  const existing = slot.credential;
  if (acquisition.kind === "choose" && existing.kind !== "none") {
    // A gh-cli slot resolves via its own recorded account pin (null = the active account).
    const resolves = existing.kind === "stored" || ghAuthToken(existing.ghUser) !== null;
    if (resolves) {
      logger.log(
        `  Reusing ${profileLabel(name)}'s existing credential (${
          liveCredentialSourceLabel(existing)
        }).`,
      );
      return existing;
    }
  }
  return acquireCredential(acquisition, name);
}

/** Dependency order: the daemon holds the credential in memory and an unstoppable one throws before
 *  anything is deleted (a dry run takes the same refusal and otherwise sends no signal); the store
 *  slot goes in one atomic write, credential and mode together. Every removal lands through the
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
        `(\`agent stop --profile ${name}\`) before deleting`,
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

async function runDel(name: ProfileName): Promise<Narration> {
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
  return () => consola.success(`Deleted ${profileLabel(name)} (credential, wiring, daemon home).`);
}

/** `daemon` is null for a direct profile, which has none. */
export interface ProfileListRow {
  name: ProfileName;
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

async function runList(): Promise<void> {
  const state = new CopilotEnvState();
  const names = allProfileNames();
  if (names.length === 0) {
    consola.info("No profiles yet. Create one: `agent profile --add <name> --direct|--proxy`.");
    return;
  }
  // Concurrent probes: each can spend the full connect timeout on a wedged daemon, and paid
  // serially that would make --list crawl once a couple of profiles are down.
  const rows: ProfileListRow[] = await Promise.all(
    names.map(async (name): Promise<ProfileListRow> => {
      const slot = state.readProfileSlot(name);
      const daemon = slot.mode === "proxy" ? await proxyStatus(name) : null;
      return { name, provider: credentialProvider(slot.credential), mode: slot.mode, daemon };
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

/** The launcher contract, driven by the store slot. A missing or partial profile exits as "other"
 *  (never start a daemon): a partial slot is never launchable. */
function runCheck(name: ProfileName): void {
  const slot = new CopilotEnvState().readProfileSlot(name);
  switch (slot.kind) {
    case "partial":
      printWrapped(partialSlotGap(name, slot));
      process.exitCode = providerModeExitCode("other");
      return;
    case "complete":
      printKeyValue(profileLabel(name), slot.mode);
      process.exitCode = providerModeExitCode(slot.mode);
      return;
    default:
      assertNever(slot);
  }
}

/** Both agents through wireBothAgents (the slot's pair is rendered into both files, so a Claude-only
 *  write can never leave the two disagreeing); the profile's Desktop entry
 *  follows the `claude.desktop` key through the adapter. The printed path is what `cl --profile`
 *  evals into `--settings`. */
async function runSettingsFor(name: ProfileName): Promise<Narration> {
  const slot = new CopilotEnvState().readProfileSlot(name);
  if (slot.kind === "partial") {
    throw new Error(partialSlotGap(name, slot));
  }
  await wireBothAgents(name, slot.mode, true, "stored");
  // The path is the `cl --profile` eval contract, said once the file is real.
  return () => process.stdout.write(`${settingsPathFor(resolveClaudeHome(), name)}\n`);
}

/** Reached only from `agent profile --sync`; what heals a committed-but-unwired `--add`. One
 *  broken profile never blocks the rest, but any failure exits non-zero so callers can warn. */
async function runSync(): Promise<Narration> {
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
  if (failed > 0) process.exitCode = 1;
  return () => logger.log(`  ✓ Synced ${synced} profile${synced === 1 ? "" : "s"}.`);
}

export async function runProfile(args: ProfileArgs): Promise<void> {
  const action = parseProfileAction(args);
  const run = (): Promise<Narration> => {
    switch (action.kind) {
      case "add":
        return runAdd(action.name, action.mode, action.acquisition);
      case "del":
        return runDel(action.name);
      case "check":
        runCheck(action.name);
        return Promise.resolve(() => {});
      case "settings-for":
        return runSettingsFor(action.name);
      case "sync":
        return runSync();
      case "list":
        return runList().then(() => () => {});
      default:
        return assertNever(action);
    }
  };
  if (args.dryRun) {
    await runDryRun(run);
    return;
  }
  (await run())();
}
