// `agent uninstall`: remove everything copilot-env manages from this machine, in
// dependency-safe order -- stop every daemon, delete every named profile, strip
// the DEFAULT Codex + Claude wiring, clear the credential, unwire the shell
// integration, delete the copilot-api home, and finally the install checkout
// itself. Destructive, so it confirms interactively (`--yes` for headless use)
// and offers `--dry-run`. Idempotent: a second run finds nothing and exits 0.
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { consola } from "consola";
import { removeClaudeDefaultWiring } from "../claude/config.ts";
import { removeClaudeMcpRegistration } from "../claude/mcp_registration.ts";
import { resolveClaudeHome, settingsPathFor } from "../claude/paths.ts";
import { knownCodexHomes, removeCodexDefaultWiring, removeCodexProfile } from "../codex/config.ts";
import { codexConfigPath } from "../codex/paths.ts";
import { Credential } from "../copilot_api/credential.ts";
import { stopTrackedProxy } from "../copilot_api/daemon.ts";
import { allProfileNames } from "../copilot_api/env_state.ts";
import { resolveRootHome } from "../copilot_api/paths.ts";
import { DAEMON_SIGKILL_GRACE_MS } from "../copilot_api/process.ts";
import { profileLabel, type ProfileName } from "../copilot_api/profile.ts";
import { CopilotEnvRunState } from "../copilot_api/state.ts";
import { runShellIntegration } from "../shell/integration.ts";
import { errMessage } from "../utils/error.ts";
import { isGitCheckout, PROJECT_ROOT } from "../utils/root.ts";
import { quotePosix, quotePowerShell } from "../utils/shell_quote.ts";
import { deleteProfileEverywhere } from "./profile.ts";

export interface UninstallArgs {
  /** `--yes`: skip the confirmation prompt (headless use). */
  yes?: boolean;
  /** `--dry-run`: print what would be removed without changing anything. */
  dryRun?: boolean;
  /** `--force`: also delete the install directory when it is a git checkout. */
  force?: boolean;
}

/**
 * Test seam (the repo's deps pattern, e.g. DirectProbeDeps): these targets can
 * resolve to REAL machine paths that test env vars cannot (or cannot portably)
 * redirect -- homedir() ignores `$HOME` on Windows, the codex farm follows `$HOME`
 * only on POSIX, and the Windows shell removal edits the actual `$PROFILE` -- so
 * tests inject substitutes.
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

/** The run-state-recorded CODEX_HOME farm dir an uninstall would remove, or null
 *  (Windows, or none recorded). The narration and the removal share this ONE
 *  resolver so the dry-run can never drift from what actually gets deleted. */
function recordedCodexHostFarm(): string | null {
  if (process.platform === "win32") return null;
  const recorded = new CopilotEnvRunState().read().codexHome;
  return recorded ? recorded : null;
}

/** Tear down the host's CODEX_HOME symlink farm (POSIX only). Ownership AND the
 *  path come from run state -- `agent codex --host` persisted the farm dir it
 *  built there -- so an untracked ~/.codex/hosts/<hostname> someone else created
 *  is never swept, and a farm built under a different HOME is still the one
 *  removed. Absent state reads back as undefined (state.ts schema). */
function removeCodexHostFarm(): void {
  const recorded = recordedCodexHostFarm();
  if (recorded === null) return;
  rmSync(recorded, { recursive: true, force: true });
  new CopilotEnvRunState().set({ codexHome: null });
}

/** The exact shell command that finishes a checkout delete the process could not. */
function manualRemoveCommand(dir: string): string {
  return process.platform === "win32"
    ? `Remove-Item -Recurse -Force ${quotePowerShell(dir)}`
    : `rm -rf ${quotePosix(dir)}`;
}

/** Stop the default daemon plus every profile's. A signalled-but-unstoppable
 *  daemon throws, so the caller aborts instead of deleting under a live proxy. */
async function stopAllDaemons(profiles: ProfileName[]): Promise<void> {
  for (const profile of [null, ...profiles]) {
    const { signalled, stopped } = await stopTrackedProxy(DAEMON_SIGKILL_GRACE_MS, profile);
    if (signalled && !stopped) {
      throw new Error(
        `the ${profileLabel(profile)} proxy daemon did not stop; retry, or stop it ` +
          "manually (`agent stop --all`) before uninstalling",
      );
    }
  }
}

/** Everything a step needs, resolved once after the confirmation gate. */
interface UninstallContext {
  profiles: ProfileName[];
  codexHomes: string[];
  codexSweepComplete: boolean;
  claudeHome: string;
  rootHome: string;
  skipCheckout: boolean;
  deps: UninstallDeps;
  /** Set by the checkout step when its rmSync could not finish. */
  checkoutRemains: boolean;
}

/** One uninstall step: the dry-run narration and the real work come from the
 *  SAME entry, so neither can drift from the other. */
interface UninstallStep {
  /** "Would ..." line(s) for `--dry-run`, one per consola.info call. */
  describe: (ctx: UninstallContext) => string[];
  run: (ctx: UninstallContext) => void | Promise<void>;
}

/** The ordered uninstall plan. Order matters -- daemons first (they hold the
 *  credential in memory; a stuck one throws and aborts BEFORE anything is
 *  deleted), all wiring/store work before the copilot-api home they read from,
 *  and the checkout (where this very process runs) dead last. */
const UNINSTALL_STEPS: UninstallStep[] = [
  {
    // 1. Stop every daemon. A stuck one aborts here, before anything is deleted.
    describe: (ctx) => [
      `Would stop the default proxy daemon${
        ctx.profiles.length > 0 ? ` and ${ctx.profiles.length} profile daemon(s)` : ""
      }.`,
    ],
    run: (ctx) => stopAllDaemons(ctx.profiles),
  },
  {
    // 2. Named profiles: wiring, store slots, isolated daemon homes.
    describe: (ctx) =>
      ctx.profiles.map(
        (name) => `Would delete ${profileLabel(name)} (credential, wiring, daemon home).`,
      ),
    run: async (ctx) => {
      for (const name of ctx.profiles) {
        await deleteProfileEverywhere(name);
        consola.info(`Deleted ${profileLabel(name)}.`);
      }
    },
  },
  {
    // 3. Codex wiring, from EVERY known home: farm homes hold host-local config
    //    copies, each may reference the account-wide catalog file the root-home
    //    delete below removes (a dangling reference breaks Codex startup), and a
    //    profile wired while a farm home was active left its tables there too --
    //    step 2 only stripped the currently-effective home. Then the farm itself.
    describe: (ctx) => {
      const lines = ctx.codexHomes.map(
        (home) => `Would remove the copilot-env wiring from ${codexConfigPath(home)}.`,
      );
      // Narrate the farm delete only when the injected seam is absent: a test
      // substitute does its own (redirected) work, not this state-recorded rm.
      const farm = ctx.deps.removeCodexHostFarm === undefined ? recordedCodexHostFarm() : null;
      if (farm !== null) lines.push(`Would delete the CODEX_HOME host farm: ${farm}`);
      return lines;
    },
    run: (ctx) => {
      for (const home of ctx.codexHomes) {
        removeCodexDefaultWiring(home);
        for (const name of ctx.profiles) removeCodexProfile(home, name);
      }
      (ctx.deps.removeCodexHostFarm ?? removeCodexHostFarm)();
      consola.info("Removed the copilot-env Codex wiring.");
      if (!ctx.codexSweepComplete) {
        consola.warn(
          "Could not enumerate every ~/.codex/hosts home; if Codex fails to start there " +
            "later, delete the stale model_catalog_json line from that config.toml.",
        );
      }
    },
  },
  {
    // 4. Default Claude wiring (surgical: only managed keys; helper scripts by
    //    name), plus the copilot-env MCP registration in Claude's global
    //    ~/.claude.json (best-effort: a warn, never an abort).
    describe: (ctx) => [
      `Would remove the managed Claude wiring at ${settingsPathFor(ctx.claudeHome)}.`,
      "Would remove the copilot-env MCP registration from Claude's global ~/.claude.json.",
    ],
    run: (ctx) => {
      removeClaudeDefaultWiring(ctx.claudeHome);
      try {
        removeClaudeMcpRegistration();
      } catch (e) {
        consola.warn(`could not remove the copilot-env MCP registration: ${errMessage(e)}`);
      }
      consola.info("Removed the copilot-env Claude wiring.");
    },
  },
  {
    // 5. The default credential (named profiles were cleared in step 2), BEFORE
    //    the home that stores it is deleted: if any later step fails partway,
    //    the token is already gone.
    describe: () => ["Would clear the stored GitHub credential."],
    run: () => new Credential().clear(),
  },
  {
    // 6. Shell integration + launchers.
    describe: () => ["Would remove the shell integration (rc / PowerShell profile blocks)."],
    run: (ctx) => (ctx.deps.removeShellIntegration ?? removeShellIntegrationEverywhere)(),
  },
  {
    // 7. Stop again, then delete the copilot-api home (proxy config/apiKeys, run
    //    state, sqlite usage DBs, logs, the stores, github_token, the catalog).
    //    The second sweep closes the auto-start race: an agent session could have
    //    relaunched a daemon between step 1 and the wiring removal above; now
    //    that the wiring is gone nothing can start another.
    describe: (ctx) => [
      "Would stop any proxy daemon relaunched in the meantime (second sweep).",
      `Would delete the copilot-api home: ${ctx.rootHome}`,
    ],
    run: async (ctx) => {
      await stopAllDaemons(ctx.profiles);
      rmSync(ctx.rootHome, { recursive: true, force: true });
      consola.info(`Deleted the copilot-api home: ${ctx.rootHome}`);
    },
  },
  {
    // 8. The install checkout -- where this process runs, so it goes last, from
    //    a safe cwd. rmSync can fail mid-tree (Windows open handles,
    //    permissions); report the exact finishing command and a non-zero exit so
    //    scripts can tell "fully removed" from "directory left behind". A git
    //    checkout (`.git` present) is left in place unless `--force`: developers
    //    run this from a clone to test it, and a nuked repo is unrecoverable
    //    while a leftover directory is a one-line `rm` -- tarball installs have
    //    no `.git`, so users are unaffected.
    describe: (ctx) => [
      ctx.skipCheckout
        ? `Would leave ${PROJECT_ROOT} in place (git checkout; re-run with --force to delete it).`
        : `Would delete the install directory: ${PROJECT_ROOT}`,
    ],
    run: (ctx) => {
      if (ctx.skipCheckout) {
        consola.info(
          `${PROJECT_ROOT} is a git checkout; leaving it in place - delete it yourself, ` +
            "or re-run with --force.",
        );
        return;
      }
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
        ctx.checkoutRemains = true;
        process.exitCode = 1;
      }
    },
  },
];

/**
 * `agent uninstall`: remove copilot-env entirely, driving BOTH `--dry-run` and
 * the real teardown from UNINSTALL_STEPS so the narration cannot drift from
 * what actually runs.
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

  let codexHomes: string[];
  let codexSweepComplete = true;
  if (deps.codexHomes !== undefined) {
    codexHomes = deps.codexHomes;
  } else {
    ({ homes: codexHomes, complete: codexSweepComplete } = knownCodexHomes());
  }
  const ctx: UninstallContext = {
    profiles: allProfileNames(),
    codexHomes,
    codexSweepComplete,
    claudeHome: resolveClaudeHome(),
    rootHome: resolveRootHome(),
    skipCheckout: isGitCheckout() && !args.force,
    deps,
    checkoutRemains: false,
  };

  if (args.dryRun) {
    consola.info("DRY RUN: nothing will be removed.");
    for (const step of UNINSTALL_STEPS) {
      for (const line of step.describe(ctx)) consola.info(`   ${line}`);
    }
    return;
  }

  for (const step of UNINSTALL_STEPS) await step.run(ctx);

  if (ctx.checkoutRemains) {
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
