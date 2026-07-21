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
import {
  configureClaudeConfig,
  removeClaudeProfile,
  resolveClaudeHome,
  settingsPathFor,
} from "../claude/config.ts";
import { configureCodexConfig, effectiveCodexHome, removeCodexProfile } from "../codex/config.ts";
import { Credential } from "../copilot_api/credential.ts";
import { CopilotEnvState, type ProfileMode } from "../copilot_api/env_state.ts";
import { profileHome, profileHomeNames } from "../copilot_api/paths.ts";
import { openaiBaseUrl, reserveProfilePort } from "../copilot_api/port.ts";
import { assertProfileName, profileLabel } from "../copilot_api/profile.ts";
import { cyan, gray, green, yellow } from "../utils/ansi.ts";
import { createStderrLogger } from "../utils/logger.ts";
import { authenticate } from "./auth.ts";
import { proxyStatus } from "./start.ts";
import { stopTrackedProxy } from "./stop.ts";

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
  /** `--direct` / `--proxy`: the mode for `--add` (exactly one; sticky on re-add). */
  direct?: boolean;
  proxy?: boolean;
  /** `--provider` / `--set`: non-interactive credential acquisition for `--add`. */
  provider?: string;
  set?: string | boolean;
}

/** The profile's recorded mode from the store (the source of truth), or null. */
function storedMode(name: string): ProfileMode | null {
  return new CopilotEnvState().readProfileSlot(name).mode;
}

/** Wire BOTH agents for `name` at `mode`. Order and resilience mirror
 *  configureBothAgents: try each, report per-agent, fail if either failed. */
function wireBothAgents(name: string, mode: ProfileMode, quiet: boolean): void {
  const failures: string[] = [];
  try {
    configureClaudeConfig(resolveClaudeHome(), mode, { quiet, profile: name });
  } catch (e) {
    failures.push(`Claude: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const options =
      mode === "proxy"
        ? { profile: name, quiet, baseUrl: openaiBaseUrl(String(reserveProfilePort(name))) }
        : { profile: name, quiet };
    if (configureCodexConfig(effectiveCodexHome(), mode, options) !== 0) {
      failures.push("Codex: config write failed (see the logged warning above)");
    }
  } catch (e) {
    failures.push(`Codex: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (failures.length > 0) {
    throw new Error(`could not wire ${profileLabel(name)}:\n  ${failures.join("\n  ")}`);
  }
}

/**
 * `--add <name>`: make the profile exist end-to-end -- its own credential
 * (acquired now unless the slot already resolves; `--provider`/`--set` are the
 * non-interactive path), its single mode (from `--direct`/`--proxy`; sticky from
 * the store on a re-add), and BOTH agents wired. Re-running with the other mode
 * flag SWITCHES the profile (one mode, never both).
 */
async function runAdd(name: string, args: ProfileArgs): Promise<void> {
  if (args.direct && args.proxy) {
    throw new Error("--direct and --proxy are mutually exclusive (a profile has ONE mode)");
  }
  // Same conflict contract as `agent auth`: `--set` IS the gh-token path, so an
  // explicit different provider must error, never be silently coerced.
  if (args.set !== undefined && args.provider !== undefined) {
    if (args.provider.trim().toLowerCase() !== "gh-token") {
      throw new Error("--set only applies to `--provider gh-token`");
    }
  }
  const previous = storedMode(name);
  const mode: ProfileMode | null = args.direct ? "direct" : args.proxy ? "proxy" : previous;
  if (mode === null) {
    throw new Error(
      `pass --direct or --proxy: ${profileLabel(name)} does not exist yet, and a profile ` +
        "always has exactly one mode",
    );
  }
  // The profile's OWN credential (never the default's): reuse a resolving slot,
  // acquire otherwise. Explicit --provider/--set always (re)provisions.
  const cred = new Credential(undefined, name);
  if (args.provider !== undefined || args.set !== undefined || !cred.isAuthenticated()) {
    await authenticate(args.set !== undefined ? "gh-token" : args.provider, args.set, name);
  } else {
    logger.log(`  Reusing ${profileLabel(name)}'s existing credential (${cred.provider()}).`);
  }
  // Switching AWAY from proxy strands the profile's daemon (nothing will route to it
  // anymore); stop it as part of the switch rather than leaving an orphan serving.
  if (previous === "proxy" && mode === "direct") {
    const { signalled } = await stopTrackedProxy(0, name);
    if (signalled) logger.log(`  Stopped ${profileLabel(name)}'s proxy daemon (now direct).`);
  }
  logger.log(
    `  Configuring ${profileLabel(name)} for ` +
      `${mode === "direct" ? "GitHub Copilot Direct" : "the local copilot-api proxy"} (both agents) …`,
  );
  wireBothAgents(name, mode, false);
  // The store commit is LAST -- it is the success marker. If wiring threw above, the
  // store keeps the previous mode (or no profile at all), so `--check` and `--sync`
  // keep answering for the last fully-applied state and a later `--sync` re-derives
  // any partially written artifacts from it.
  new CopilotEnvState().setProfileMode(name, mode);
  const switched = previous !== null && previous !== mode ? ` (switched from ${previous})` : "";
  logger.success(`${profileLabel(name)} is ready${switched}.`);
  logger.log(`  Launch it:  cl --profile ${name}  /  cx --profile ${name}`);
  if (mode === "proxy") {
    logger.log(
      `  Its proxy daemon starts on demand; manage it with \`agent start/stop --profile ${name}\`.`,
    );
  }
}

/**
 * `--del <name>`: remove the profile EVERYWHERE, in dependency order: stop its
 * daemon (it holds the credential in memory), strip both agents' artifacts,
 * clear the store slot (credential + mode), and remove its isolated daemon home
 * (config/apiKeys/run-state/sqlite/logs + the port reservation).
 */
async function runDel(name: string): Promise<void> {
  // Sweep NOTHING for a profile that never existed: a foreign same-named
  // settings-<name>.json or a hand-made [model_providers.copilot-env-<name>]
  // is not ours to delete unless the store/home says the profile was real.
  const existed =
    storedMode(name) !== null ||
    new Credential(undefined, name).provider() !== null ||
    profileHomeNames().includes(name);
  if (!existed) {
    consola.info(`${profileLabel(name)} does not exist — nothing to delete.`);
    process.exitCode = 1;
    return;
  }
  const { signalled, stopped } = await stopTrackedProxy(2000, name);
  if (signalled && !stopped) {
    throw new Error(
      `${profileLabel(name)}'s proxy daemon did not stop; retry, or stop it manually ` +
        `(\`agent stop --profile ${name}\`) before deleting`,
    );
  }
  removeClaudeProfile(resolveClaudeHome(), name);
  removeCodexProfile(effectiveCodexHome(), name);
  const state = new CopilotEnvState();
  state.setCredential(name, { githubToken: null, authProvider: null });
  state.setProfileMode(name, null);
  rmSync(profileHome(name), { recursive: true, force: true });
  consola.success(`Deleted ${profileLabel(name)} (credential, wiring, daemon home).`);
}

/** One resolved `--list` row: the store slot plus (for proxy profiles) the
 *  daemon's liveness. `daemon` stays null for direct profiles (no daemon). */
export interface ProfileListRow {
  name: string;
  provider: string | null;
  mode: ProfileMode | null;
  daemon: { up: boolean; port?: number } | null;
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
    const daemonCell =
      r.daemon === null
        ? gray("-")
        : r.daemon.up
          ? // A tracked-but-portless daemon is not expected, but the type allows
            // it; never render a literal "port undefined".
            green(r.daemon.port === undefined ? "up" : `up (port ${r.daemon.port})`)
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
  const names = [...new Set([...state.profileNames(), ...profileHomeNames()])].sort();
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
      let daemon: ProfileListRow["daemon"] = null;
      if (slot.mode === "proxy") {
        const { up, port } = await proxyStatus(name);
        daemon = { up, port };
      }
      return { name, provider: slot.authProvider, mode: slot.mode, daemon };
    }),
  );
  // One consola message for the whole table (a single prefix, not one per row --
  // same rationale as the models table), blank-line-separated, with the launch
  // hint as its footer.
  const hint = gray("   Launch one:  cl --profile <name>  /  cx --profile <name>");
  consola.info(
    `${rows.length} profile${rows.length === 1 ? "" : "s"}:\n\n${renderProfileTable(rows)}\n\n${hint}\n`,
  );
}

/** `--check <name>`: the launcher contract, driven by the STORE slot.
 *  Exit 0 = direct, 2 = proxy (ensure the daemon), 1 = no such profile OR an
 *  incomplete one (mode without credential) -- never start a daemon for it. */
function runCheck(name: string): void {
  const slot = new CopilotEnvState().readProfileSlot(name);
  if (slot.mode === null) {
    console.log(
      `${profileLabel(name)} does not exist — create it with \`agent profile --add ${name} --direct|--proxy\``,
    );
    process.exitCode = 1;
    return;
  }
  if (slot.authProvider === null) {
    console.log(
      `${profileLabel(name)} has no credential — repair it with \`agent auth --profile ${name}\` ` +
        `or \`agent profile --add ${name}\``,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`${profileLabel(name)}: ${slot.mode}`);
  process.exitCode = slot.mode === "direct" ? 0 : 2;
}

/**
 * `--settings-for <name>`: re-sync the profile's Claude settings file against the
 * live proxy port (mode from the store) and print its ABSOLUTE PATH on stdout --
 * the machine contract `cl --profile <name>` evals into `claude --settings <path>`.
 */
function runSettingsFor(name: string): void {
  const mode = storedMode(name);
  if (mode === null) {
    throw new Error(
      `${profileLabel(name)} does not exist — create it with \`agent profile --add ${name} --direct|--proxy\``,
    );
  }
  const claudeHome = resolveClaudeHome();
  configureClaudeConfig(claudeHome, mode, { quiet: true, profile: name });
  process.stdout.write(`${settingsPathFor(claudeHome, name)}\n`);
}

/** `--sync`: refresh EVERY profile's wiring (both agents) against the live ports.
 *  Launcher plumbing (`cx --profile` runs it pre-launch); quiet and per-profile
 *  resilient (one broken profile never blocks the rest), never touches the
 *  default wiring -- but any failure still exits non-zero so callers can warn. */
function runSync(): void {
  let synced = 0;
  let failed = 0;
  for (const name of new CopilotEnvState().profileNames()) {
    const mode = storedMode(name);
    if (mode === null) continue;
    try {
      wireBothAgents(name, mode, true);
      synced++;
    } catch (e) {
      failed++;
      logger.warn(`could not sync ${profileLabel(name)}: ${e instanceof Error ? e.message : e}`);
    }
  }
  logger.log(`  ✓ Synced ${synced} profile${synced === 1 ? "" : "s"}.`);
  if (failed > 0) process.exitCode = 1;
}

/** `agent profile`: create, list, check, sync, and delete named profiles. */
export async function runProfile(args: ProfileArgs): Promise<void> {
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
  if ((args.direct || args.proxy) && args.add === undefined) {
    throw new Error("--direct/--proxy only apply to --add (a profile's mode is set there)");
  }
  if ((args.provider !== undefined || args.set !== undefined) && args.add === undefined) {
    throw new Error(
      "--provider/--set only apply to --add (re-auth an existing profile with `agent auth --profile <name>`)",
    );
  }
  const named = args.add ?? args.del ?? args.check ?? args.settingsFor;
  if (named !== undefined) assertProfileName(named);
  if (args.add !== undefined) return runAdd(args.add, args);
  if (args.del !== undefined) return runDel(args.del);
  if (args.check !== undefined) return runCheck(args.check);
  if (args.settingsFor !== undefined) return runSettingsFor(args.settingsFor);
  if (args.sync) return runSync();
  return runList();
}
