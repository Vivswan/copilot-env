// `agent uninstall`: remove everything copilot-env manages from this machine, in
// dependency-safe order -- stop every daemon, delete every named profile, strip
// the DEFAULT Codex + Claude wiring, clear the credential, unwire the shell
// integration, delete the copilot-api home, and finally the install checkout
// itself. Destructive, so it confirms interactively (`--yes` for headless use)
// and offers `--dry-run`. Idempotent: a second run finds nothing and exits 0.
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { consola } from "consola";
import { removeClaudeDefaultWiring, resolveClaudeHome, settingsPathFor } from "../claude/config.ts";
import { knownCodexHomes, removeCodexDefaultWiring, removeCodexProfile } from "../codex/config.ts";
import { Credential } from "../copilot_api/credential.ts";
import { CopilotEnvState } from "../copilot_api/env_state.ts";
import { profileHomeNames, resolveRootHome } from "../copilot_api/paths.ts";
import { type Profile, profileLabel } from "../copilot_api/profile.ts";
import { CopilotEnvRunState } from "../copilot_api/state.ts";
import { PROJECT_ROOT } from "../utils/root.ts";
import { quotePosix, quotePowerShell } from "../utils/shell_quote.ts";
import { deleteProfileEverywhere } from "./profile.ts";
import { runShellIntegration } from "./shell_integration.ts";
import { stopTrackedProxy } from "./stop.ts";

export interface UninstallArgs {
  /** `--yes`: skip the confirmation prompt (headless use). */
  yes?: boolean;
  /** `--dry-run`: print what would be removed without changing anything. */
  dryRun?: boolean;
  /** `--force`: also delete the install directory when it is a git checkout. */
  force?: boolean;
}

/**
 * Test seam (the repo's deps pattern, e.g. DirectProbeDeps): these three targets
 * resolve to REAL machine paths that test env vars cannot redirect -- homedir()
 * ignores `$HOME` on Windows, the farm path captures `HOME` at module import, and
 * the Windows shell removal edits the actual `$PROFILE` -- so tests inject
 * substitutes.
 */
export interface UninstallDeps {
  codexHomes?: string[];
  removeCodexHostFarm?: () => void;
  removeShellIntegration?: () => void;
}

/** The full shell unwire: rc / PowerShell profile blocks (integration + launchers).
 *  windowsProfilePaths targets ONE profile filename per call, so Windows removes
 *  both the per-host and the CurrentUserAllHosts profiles with two calls. */
function removeShellIntegrationEverywhere(): void {
  runShellIntegration({ remove: true });
  if (process.platform === "win32") runShellIntegration({ remove: true, allHosts: true });
}

/** Names of every named profile: the store's slots unioned with on-disk daemon
 *  homes (mirrors `agent profile --list`), so a half-created profile is swept too. */
function allProfileNames(): string[] {
  return [...new Set([...new CopilotEnvState().profileNames(), ...profileHomeNames()])].sort();
}

/** Tear down the host's CODEX_HOME symlink farm (POSIX only). Ownership AND the
 *  path come from run state -- `agent codex --host` persisted the farm dir it
 *  built there -- so an untracked ~/.codex/hosts/<hostname> someone else created
 *  is never swept, and a farm built under a different HOME is still the one
 *  removed. Absent state reads back as undefined (state.ts schema). */
function removeCodexHostFarm(): void {
  if (process.platform === "win32") return;
  const state = new CopilotEnvRunState();
  const recorded = state.read().codexHome;
  if (!recorded) return;
  rmSync(recorded, { recursive: true, force: true });
  state.set({ codexHome: null });
}

/** The exact shell command that finishes a checkout delete the process could not. */
function manualRemoveCommand(dir: string): string {
  return process.platform === "win32"
    ? `Remove-Item -Recurse -Force ${quotePowerShell(dir)}`
    : `rm -rf ${quotePosix(dir)}`;
}

/** Stop the default daemon plus every profile's. A signalled-but-unstoppable
 *  daemon throws, so the caller aborts instead of deleting under a live proxy. */
async function stopAllDaemons(profiles: string[]): Promise<void> {
  for (const profile of [null, ...profiles] as Profile[]) {
    const { signalled, stopped } = await stopTrackedProxy(2000, profile);
    if (signalled && !stopped) {
      throw new Error(
        `the ${profileLabel(profile)} proxy daemon did not stop; retry, or stop it ` +
          "manually (`agent stop --all`) before uninstalling",
      );
    }
  }
}

/**
 * `agent uninstall`: remove copilot-env entirely. Order matters -- daemons first
 * (they hold the credential in memory; a stuck one aborts BEFORE anything is
 * deleted), all wiring/store work before the copilot-api home they read from, and
 * the checkout (where this very process runs) dead last. A git checkout
 * (`.git` present) is left in place unless `--force`: developers run this from a
 * clone to test it, and a nuked repo is unrecoverable while a leftover directory
 * is a one-line `rm` -- tarball installs have no `.git`, so users are unaffected.
 */
export async function runUninstall(args: UninstallArgs, deps: UninstallDeps = {}): Promise<void> {
  // Confirm before touching (or even enumerating) anything.
  if (!args.yes && !args.dryRun) {
    if (!process.stdin.isTTY) {
      throw new Error("not a terminal - pass --yes to uninstall non-interactively");
    }
    const confirmed = await consola.prompt(
      "Remove copilot-env from this machine (daemons, profiles, agent wiring, " +
        "shell integration, credentials, data)?",
      { type: "confirm", initial: false },
    );
    if (confirmed !== true) {
      consola.info("Uninstall aborted - nothing was changed.");
      process.exitCode = 1;
      return;
    }
  }

  const profiles = allProfileNames();
  let codexHomes: string[];
  let codexSweepComplete = true;
  if (deps.codexHomes !== undefined) {
    codexHomes = deps.codexHomes;
  } else {
    ({ homes: codexHomes, complete: codexSweepComplete } = knownCodexHomes());
  }
  const claudeHome = resolveClaudeHome();
  const rootHome = resolveRootHome();
  const skipCheckout = existsSync(join(PROJECT_ROOT, ".git")) && !args.force;

  if (args.dryRun) {
    consola.info("DRY RUN: nothing will be removed.");
    consola.info(
      `   Would stop the default proxy daemon${profiles.length > 0 ? ` and ${profiles.length} profile daemon(s)` : ""}.`,
    );
    for (const name of profiles) {
      consola.info(`   Would delete ${profileLabel(name)} (credential, wiring, daemon home).`);
    }
    for (const home of codexHomes) {
      consola.info(`   Would remove the copilot-env wiring from ${join(home, "config.toml")}.`);
    }
    consola.info(`   Would remove the managed Claude wiring at ${settingsPathFor(claudeHome)}.`);
    consola.info("   Would clear the stored GitHub credential.");
    consola.info("   Would remove the shell integration (rc / PowerShell profile blocks).");
    consola.info(`   Would delete the copilot-api home: ${rootHome}`);
    consola.info(
      skipCheckout
        ? `   Would leave ${PROJECT_ROOT} in place (git checkout; re-run with --force to delete it).`
        : `   Would delete the install directory: ${PROJECT_ROOT}`,
    );
    return;
  }

  // 1. Stop every daemon. A stuck one aborts here, before anything is deleted.
  await stopAllDaemons(profiles);

  // 2. Named profiles: wiring, store slots, isolated daemon homes.
  for (const name of profiles) {
    await deleteProfileEverywhere(name);
    consola.info(`Deleted ${profileLabel(name)}.`);
  }

  // 3. Codex wiring, from EVERY known home: farm homes hold host-local config
  //    copies, each may reference the account-wide catalog file the root-home
  //    delete below removes (a dangling reference breaks Codex startup), and a
  //    profile wired while a farm home was active left its tables there too --
  //    step 2 only stripped the currently-effective home. Then the farm itself.
  for (const home of codexHomes) {
    removeCodexDefaultWiring(home);
    for (const name of profiles) removeCodexProfile(home, name);
  }
  (deps.removeCodexHostFarm ?? removeCodexHostFarm)();
  consola.info("Removed the copilot-env Codex wiring.");
  if (!codexSweepComplete) {
    consola.warn(
      "Could not enumerate every ~/.codex/hosts home; if Codex fails to start there " +
        "later, delete the stale model_catalog_json line from that config.toml.",
    );
  }

  // 4. Default Claude wiring (surgical: only managed keys; helper scripts by name).
  removeClaudeDefaultWiring(claudeHome);
  consola.info("Removed the copilot-env Claude wiring.");

  // 5. The default credential (named profiles were cleared in step 2), BEFORE
  //    the home that stores it is deleted: if any later step fails partway, the
  //    token is already gone.
  new Credential().clear();

  // 6. Shell integration + launchers.
  (deps.removeShellIntegration ?? removeShellIntegrationEverywhere)();

  // 7. Stop again, then delete the copilot-api home (proxy config/apiKeys, run
  //    state, sqlite usage DBs, logs, the stores, github_token, the catalog).
  //    The second sweep closes the auto-start race: an agent session could have
  //    relaunched a daemon between step 1 and the wiring removal above; now that
  //    the wiring is gone nothing can start another.
  await stopAllDaemons(profiles);
  rmSync(rootHome, { recursive: true, force: true });
  consola.info(`Deleted the copilot-api home: ${rootHome}`);

  // 8. The install checkout -- where this process runs, so it goes last, from a
  //    safe cwd. rmSync can fail mid-tree (Windows open handles, permissions);
  //    report the exact finishing command and a non-zero exit so scripts can
  //    tell "fully removed" from "directory left behind".
  let checkoutRemains = false;
  if (skipCheckout) {
    consola.info(
      `${PROJECT_ROOT} is a git checkout; leaving it in place - delete it yourself, ` +
        "or re-run with --force.",
    );
  } else {
    try {
      process.chdir(homedir());
    } catch {
      // pass -- deletion may still succeed from the current cwd.
    }
    try {
      rmSync(PROJECT_ROOT, { recursive: true, force: true });
      consola.info(`Deleted the install directory: ${PROJECT_ROOT}`);
    } catch {
      consola.warn(
        `Could not fully delete ${PROJECT_ROOT} (files may be in use). ` +
          `Finish with: ${manualRemoveCommand(PROJECT_ROOT)}`,
      );
      checkoutRemains = true;
      process.exitCode = 1;
    }
  }

  if (checkoutRemains) {
    consola.info("Everything else is removed; finish with the command above.");
  } else {
    consola.success("copilot-env is uninstalled. Restart your shell to finish.");
  }
  consola.info(
    "Not removed: the agent CLIs themselves (claude / copilot / codex npm globals), " +
      "bun (and its PATH entry), the PowerShell execution policy, Codex's " +
      "sandbox_workspace_write.network_access key, other hosts' ~/.codex/hosts/* dirs " +
      "on a shared home, and the agents' own session history.",
  );
}
