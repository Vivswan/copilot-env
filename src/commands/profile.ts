// `agent profile`: the single interface for NAMED profiles. A profile is an
// atomic unit -- ONE credential + ONE wiring mode (direct or proxy, never both)
// -- applied to BOTH Codex and Claude, so several agent sessions can run at once
// under different accounts/backends. The store's profile slot (credential +
// `mode`, src/copilot_api/env_state.ts) is the source of truth; the per-agent
// artifacts (settings-<name>.json, [profiles.<name>] in config.toml) are derived
// from it. The DEFAULT setup stays with `agent init`/`agent claude`/`agent
// codex`; `agent auth --profile <name>` remains the re-auth path for an existing
// profile's credential.
import { rmSync } from "node:fs";
import { consola } from "consola";
import { reconcileClaudeDesktopWiring } from "../agents/claude_desktop.ts";
import { configuringLine, type ManagedWrite } from "../agents/configure.ts";
import {
  bothAgents,
  resolveAndPersistDirectIdentity,
  wireBothAgents,
} from "../agents/profile_wiring.ts";
import { providerModeExitCode, type RequestedMode } from "../agents/provider_mode.ts";
import { claudeAdapter } from "../claude/config.ts";
import { resolveClaudeHome, settingsPathFor } from "../claude/paths.ts";
import { ghAuthToken } from "../copilot_api/credential.ts";
import { type ProxyStatus, proxyStatus, stopTrackedProxy } from "../copilot_api/daemon.ts";
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
import { cyan, gray, green, yellow } from "../utils/ansi.ts";
import { assertNever } from "../utils/assert.ts";
import { errMessage } from "../utils/error.ts";
import { createStderrLogger } from "../utils/logger.ts";
import { acquireCredential, type CredentialAcquisition, parseAcquisition } from "./auth.ts";

// Narration to stderr so `--settings-for`'s stdout stays a clean machine-readable path.
const logger = createStderrLogger();

export interface ProfileArgs {
  /** `--add <name>`: create (or re-wire) a profile: credential + mode + both agents. */
  add?: string;
  /** `--del <name>`: remove the profile everywhere (daemon, credential, artifacts, home). */
  del?: string;
  /** `--list`: every profile with its provider, mode, and daemon status. */
  list?: boolean;
  /** `--check <name>`: report the profile's mode; exit 0 direct / 2 proxy / 1 unknown. */
  check?: string;
  /** `--settings-for <name>`: re-sync the Claude settings file and print its path. */
  settingsFor?: string;
  /** `--sync`: refresh every profile's wiring against the live ports (launcher plumbing). */
  sync?: boolean;
  /** `--direct`/`--proxy` for `--add`, parsed once at the CLI boundary
   *  (auto = neither; sticky from the store on a re-add). */
  mode: RequestedMode;
  /** `--provider` / `--set`: non-interactive credential acquisition for `--add`. */
  provider?: string;
  set?: string | boolean;
}

/**
 * What ONE `agent profile` invocation does -- exactly one of the six verbs,
 * parsed ONCE by `parseProfileAction` at the CLI boundary. The `--add`-only
 * knobs (mode, credential acquisition) live on the add arm alone, so a stray
 * `--direct`/`--provider` on another verb is a rejection here, never a silently
 * ignored flag.
 */
export type ProfileAction =
  | { kind: "add"; name: ProfileName; mode: RequestedMode; acquisition: CredentialAcquisition }
  | { kind: "del"; name: ProfileName }
  | { kind: "check"; name: ProfileName }
  | { kind: "settings-for"; name: ProfileName }
  | { kind: "sync" }
  | { kind: "list" };

/** Parse the raw `agent profile` flags into a ProfileAction (the CLI boundary). */
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
  if (args.mode !== "auto" && args.add === undefined) {
    throw new Error("--direct/--proxy only apply to --add (a profile's mode is set there)");
  }
  if ((args.provider !== undefined || args.set !== undefined) && args.add === undefined) {
    throw new Error(
      "--provider/--set only apply to --add (re-auth an existing profile with `agent auth --profile <name>`)",
    );
  }
  const add = parseProfileFlag(args.add);
  if (add !== null) {
    // Same conflict contract as `agent auth`: `--set` IS the gh-token path, so an
    // explicit different provider must error, never be silently coerced. Here the
    // --set conflict wins even over a bogus provider name (setConflictWins) -- the
    // two commands intentionally report that combination differently.
    return {
      kind: "add",
      name: add,
      mode: args.mode,
      acquisition: parseAcquisition(args.provider, args.set, { setConflictWins: true }),
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

/**
 * `--add <name>`: make the profile exist end-to-end -- its own credential
 * (acquired now unless the slot already resolves; `--provider`/`--set` are the
 * non-interactive path), its single mode (from `--direct`/`--proxy`; sticky from
 * the store on a re-add), and BOTH agents wired. Re-running with the other mode
 * flag SWITCHES the profile (one mode, never both).
 */
async function runAdd(
  name: ProfileName,
  requested: RequestedMode,
  acquisition: CredentialAcquisition,
): Promise<void> {
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
  // Switching AWAY from proxy strands the profile's daemon (nothing will route to it
  // anymore); stop it as part of the switch rather than leaving an orphan serving.
  if (previous === "proxy" && mode === "direct") {
    const { signalled } = await stopTrackedProxy(0, name);
    if (signalled) logger.log(`  Stopped ${profileLabel(name)}'s proxy daemon (now direct).`);
  }
  logger.log(configuringLine(profileLabel(name), mode, " (both agents)"));
  // ONE atomic commit of the whole slot (credential + mode) BEFORE the wiring:
  // the store can never hold a half profile, whatever happens next. A wiring
  // failure below (including a rejected credential's identity probe) leaves a
  // complete-but-unwired slot that a re-add or the launchers' `--sync` re-derives.
  state.commitProfile(name, { credential, mode });
  await wireBothAgents(name, mode, false);
  const switched = previous !== null && previous !== mode ? ` (switched from ${previous})` : "";
  logger.success(`${profileLabel(name)} is ready${switched}.`);
  logger.log(`  Launch it:  cl --profile ${name}  /  cx --profile ${name}`);
  if (mode === "proxy") {
    logger.log(
      `  Its proxy daemon starts on demand; manage it with \`agent start/stop --profile ${name}\`.`,
    );
  }
}

/** The credential `--add` commits: the slot's own when it still resolves and no
 *  explicit `--provider`/`--set` re-provisions, freshly acquired otherwise --
 *  never the default's (a named profile never falls back). Reuse is judged on
 *  the ONE slot snapshot the caller read (a stored token resolves by presence;
 *  gh-cli by a live `gh` probe) -- never a second store read, so the value
 *  returned is exactly the value that was judged. */
async function profileCredential(
  name: ProfileName,
  slot: ProfileSlot,
  acquisition: CredentialAcquisition,
): Promise<ProvisionedCredential> {
  const existing = slot.credential;
  if (acquisition.kind === "choose" && existing.kind !== "none") {
    const resolves = existing.kind === "stored" || ghAuthToken() !== null;
    if (resolves) {
      logger.log(
        `  Reusing ${profileLabel(name)}'s existing credential (${credentialProvider(existing)}).`,
      );
      return existing;
    }
  }
  return acquireCredential(acquisition);
}

/**
 * The shared profile teardown, in dependency order: stop its daemon (it holds the
 * credential in memory; a signalled-but-unstoppable daemon throws BEFORE anything
 * is deleted), strip both agents' artifacts, remove the whole store slot in one
 * atomic write (credential + mode together, never a half left behind), and remove
 * its isolated daemon home (config/apiKeys/run-state/sqlite/logs + the port
 * reservation). Used by `agent profile --del` and `agent uninstall`.
 */
export async function deleteProfileEverywhere(name: ProfileName): Promise<void> {
  const { stopped } = await stopTrackedProxy(DAEMON_SIGKILL_GRACE_MS, name);
  // Anything short of CONFIRMED stopped aborts -- a survivor of the kill, or a stop
  // refused because the pid could not be corroborated as our daemon (the refusal has
  // already warned with the reason). Deleting the home under a possibly-live daemon
  // would corrupt what it is still writing.
  if (!stopped) {
    throw new Error(
      `${profileLabel(name)}'s proxy daemon did not stop; retry, or stop it manually ` +
        `(\`agent stop --profile ${name}\`) before deleting`,
    );
  }
  for (const agent of bothAgents()) agent.removeProfile(name);
  new CopilotEnvState().deleteProfile(name);
  rmSync(profileHome(name), { recursive: true, force: true });
}

/**
 * `--del <name>`: remove the profile EVERYWHERE via deleteProfileEverywhere,
 * guarded so a profile that never existed sweeps nothing.
 */
async function runDel(name: ProfileName): Promise<void> {
  // Sweep NOTHING for a profile that never existed: a foreign same-named
  // settings-<name>.json or a hand-made [model_providers.copilot-env-<name>]
  // is not ours to delete unless the store/home says the profile was real.
  const existed = new CopilotEnvState().profileSlotStatus(name).exists ||
    profileHomeNames().includes(name);
  if (!existed) {
    consola.info(`${profileLabel(name)} does not exist - nothing to delete.`);
    process.exitCode = 1;
    return;
  }
  await deleteProfileEverywhere(name);
  consola.success(`Deleted ${profileLabel(name)} (credential, wiring, daemon home).`);
}

/** One resolved `--list` row: the store slot plus (for proxy profiles) the
 *  daemon's liveness. `daemon` stays null for direct profiles (no daemon). */
export interface ProfileListRow {
  name: ProfileName;
  provider: string | null;
  mode: ProfileMode | null;
  daemon: ProxyStatus | null;
}

/**
 * Render the `--list` table (same conventions as `agent models`: columns are
 * padded BEFORE coloring so ANSI codes never skew the alignment), headed by a
 * gray NAME/MODE/PROVIDER/DAEMON row. An incomplete slot (no mode / no
 * credential) shows the gap in yellow so it stands out for repair; a direct
 * profile has no daemon, shown as "-".
 */
export function renderProfileTable(rows: ProfileListRow[]): string {
  const GAP = "    ";
  const modeText = (r: ProfileListRow): string => r.mode ?? "incomplete";
  const providerText = (r: ProfileListRow): string => r.provider ?? "no credential";
  const nameWidth = rows.reduce((m, r) => Math.max(m, r.name.length), "NAME".length);
  const modeWidth = rows.reduce((m, r) => Math.max(m, modeText(r).length), "MODE".length);
  const providerWidth = rows.reduce(
    (m, r) => Math.max(m, providerText(r).length),
    "PROVIDER".length,
  );
  // One gray span for the whole header; DAEMON is last and unpadded, so no
  // invisible spaces are baked into the colored text.
  const header = [
    `     ${"NAME".padEnd(nameWidth)}`,
    "MODE".padEnd(modeWidth),
    "PROVIDER".padEnd(providerWidth),
    "DAEMON",
  ];
  const lines: string[] = [gray(header.join(GAP))];
  for (const r of rows) {
    const modeCell = modeText(r).padEnd(modeWidth);
    const providerCell = providerText(r).padEnd(providerWidth);
    const daemonCell = r.daemon === null
      ? gray("-")
      : r.daemon.up
      ? green(`up (port ${r.daemon.port})`)
      : gray("down");
    const cells = [
      `     ${cyan(r.name.padEnd(nameWidth))}`,
      r.mode === null ? yellow(modeCell) : modeCell,
      r.provider === null ? yellow(providerCell) : providerCell,
      daemonCell,
    ];
    lines.push(cells.join(GAP).trimEnd());
  }
  return lines.join("\n");
}

/** `--list`: every profile (store + on-disk homes unioned), provider/mode/daemon. */
async function runList(): Promise<void> {
  const state = new CopilotEnvState();
  const names = allProfileNames();
  if (names.length === 0) {
    consola.info("No profiles yet. Create one: `agent profile --add <name> --direct|--proxy`.");
    return;
  }
  // Probe every proxy profile's daemon CONCURRENTLY: each probe can spend the
  // full connect timeout on a wedged daemon, and paying that serially would make
  // --list crawl once a couple of profiles are down.
  const rows: ProfileListRow[] = await Promise.all(
    names.map(async (name): Promise<ProfileListRow> => {
      const slot = state.readProfileSlot(name);
      const daemon = slot.mode === "proxy" ? await proxyStatus(name) : null;
      return { name, provider: credentialProvider(slot.credential), mode: slot.mode, daemon };
    }),
  );
  // One consola message for the whole table (a single prefix, not one per row --
  // same rationale as the models table), blank-line-separated, with the launch
  // hint as its footer.
  const hint = gray("   Launch one:  cl --profile <name>  /  cx --profile <name>");
  consola.info(
    `${rows.length} profile${rows.length === 1 ? "" : "s"}:\n\n${
      renderProfileTable(rows)
    }\n\n${hint}\n`,
  );
}

/** `--check <name>`: the launcher contract, driven by the STORE slot. The exit
 *  codes come from providerModeExitCode (the shared `--check` contract): the
 *  slot's own direct/proxy when complete, "other" (1 -- never start a daemon)
 *  for no such profile OR an incomplete one -- a partial slot is never launchable. */
function runCheck(name: ProfileName): void {
  const slot = new CopilotEnvState().readProfileSlot(name);
  switch (slot.kind) {
    case "partial":
      console.log(partialSlotGap(name, slot));
      process.exitCode = providerModeExitCode("other");
      return;
    case "complete":
      console.log(`${profileLabel(name)}: ${slot.mode}`);
      process.exitCode = providerModeExitCode(slot.mode);
      return;
    default:
      assertNever(slot);
  }
}

/** `--settings-for <name>`: re-sync the profile's Claude wiring (the COMPLETE slot drives
 *  it; a partial one errors like `--check`) through the adapter, so its Desktop entry
 *  follows the key, and print the settings path `cl --profile` evals into `--settings`. */
async function runSettingsFor(name: ProfileName): Promise<void> {
  const slot = new CopilotEnvState().readProfileSlot(name);
  if (slot.kind === "partial") {
    throw new Error(partialSlotGap(name, slot));
  }
  const write: ManagedWrite = slot.mode === "direct"
    ? { mode: "direct", directIntegrationId: await resolveAndPersistDirectIdentity(name) }
    : { mode: "proxy" };
  await claudeAdapter().configureProfile(name, write, { quiet: true });
  process.stdout.write(`${settingsPathFor(resolveClaudeHome(), name)}\n`);
}

/** `--sync`: refresh EVERY complete profile's wiring (both agents) against the
 *  live ports -- this is also what heals a committed-but-unwired `--add`.
 *  Launcher plumbing (`cx --profile` runs it pre-launch); quiet and per-profile
 *  resilient (one broken profile never blocks the rest; a partial slot is repair
 *  territory, not syncable), never touches the default wiring -- but any failure
 *  still exits non-zero so callers can warn. */
async function runSync(): Promise<void> {
  let synced = 0;
  let failed = 0;
  const state = new CopilotEnvState();
  for (const name of state.profileNames()) {
    const slot = state.readProfileSlot(name);
    if (slot.kind !== "complete") continue;
    try {
      await wireBothAgents(name, slot.mode, true);
      synced++;
    } catch (e) {
      failed++;
      logger.warn(`could not sync ${profileLabel(name)}: ${errMessage(e)}`);
    }
  }
  // Cleanup-only (quiet): the profile writes above landed their own entries, and the
  // launcher hot path never probes or discovers; zero complete profiles still sweep.
  await reconcileClaudeDesktopWiring({ quiet: true });
  logger.log(`  ✓ Synced ${synced} profile${synced === 1 ? "" : "s"}.`);
  if (failed > 0) process.exitCode = 1;
}

/** `agent profile`: create, list, check, sync, and delete named profiles. */
export async function runProfile(args: ProfileArgs): Promise<void> {
  const action = parseProfileAction(args);
  switch (action.kind) {
    case "add":
      return runAdd(action.name, action.mode, action.acquisition);
    case "del":
      return runDel(action.name);
    case "check":
      return runCheck(action.name);
    case "settings-for":
      return runSettingsFor(action.name);
    case "sync":
      return runSync();
    case "list":
      return runList();
    default:
      assertNever(action);
  }
}
