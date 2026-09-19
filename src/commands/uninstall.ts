// Idempotent: a second run finds nothing and exits 0.
import { homedir } from "node:os";
import { consola } from "consola";
import { prompt } from "../utils/logger.ts";
import { claudeProfileArtifacts, removeClaudeDefaultWiring } from "../claude/config.ts";
import {
  type ClaudeDesktopOwnedArtifacts,
  listClaudeDesktopOwnedArtifacts,
  removeAllClaudeDesktopWiring,
} from "../claude/desktop.ts";
import {
  claudeJsonPath,
  plannedClaudeMcpRemoval,
  removeClaudeMcpRegistration,
} from "../claude/mcp_registration.ts";
import { resolveClaudeHome, settingsPathFor } from "../claude/paths.ts";
import { removeCodexDefaultWiring, removeCodexProfile } from "../codex/config.ts";
import { knownCodexHomes, probeCodexFarm } from "../codex/host.ts";
import { Credential } from "../copilot_api/credential.ts";
import { stopTrackedProxy } from "../copilot_api/daemon.ts";
import { allProfileNames } from "../copilot_api/env_state.ts";
import { resolveRootHome } from "../copilot_api/paths.ts";
import { DAEMON_SIGKILL_GRACE_MS } from "../copilot_api/process.ts";
import { profileLabel, type ProfileName } from "../copilot_api/profile.ts";
import { CopilotEnvRunState } from "../copilot_api/run_state.ts";
import { proxyFloatArtifactPaths, removeProxyFloatArtifacts } from "../proxy_float.ts";
import { ownedShellTargets, removeShellIntegrationFrom } from "../shell/integration.ts";
import { errMessage } from "../utils/error.ts";
import {
  installStateRoot,
  isProtectedRoot,
  looksLikeInstallRoot,
  type RootMode,
  rootMode,
} from "../utils/root.ts";
import { quotePosix, quotePowerShell } from "../utils/shell_quote.ts";
import * as fs from "../utils/fs_facade.ts";
import { runDryRun } from "./dry_run.ts";
import { deleteProfileEverywhere } from "./profile.ts";

export interface UninstallArgs {
  yes?: boolean;
  dryRun?: boolean;
  force?: boolean;
}

/** Resolved once, before any step runs. The record proves only that we built a farm there once:
 *  the user may have replaced it since (a `codex.home` change leaves the old farm recorded until
 *  the next wiring pass). Only a path still carrying our managed config.toml is deleted. */
function recordedCodexHostFarm(): string | null {
  if (process.platform === "win32") return null;
  const recorded = new CopilotEnvRunState().read().codexHome;
  if (!recorded) return null;
  return probeCodexFarm(recorded).wired ? recorded : null;
}

/** Ownership AND the path come from run state, so an untracked ~/.codex/hosts/<hostname> someone
 *  else created is never swept, and a farm built under a different HOME is still the one removed.
 */
function removeCodexHostFarm(recorded: string | null): void {
  if (recorded === null) return;
  fs.rm(recorded, { recursive: true, force: true });
  new CopilotEnvRunState().set({ codexHome: null });
}

function manualRemoveCommand(dir: string): string {
  return process.platform === "win32"
    ? `Remove-Item -Recurse -Force ${quotePowerShell(dir)}`
    : `rm -rf ${quotePosix(dir)}`;
}

/** Any daemon NOT confirmed stopped (a kill survivor, or a stop refused because the pid could not
 *  be corroborated as ours) throws, so the caller aborts instead of deleting under a possibly-live
 *  proxy. A dry run takes the same refusal and otherwise sends no signal (stopTrackedProxy). */
async function stopAllDaemons(profiles: ProfileName[]): Promise<void> {
  for (const profile of [null, ...profiles]) {
    const { stopped } = await stopTrackedProxy(DAEMON_SIGKILL_GRACE_MS, profile);
    if (!stopped) {
      throw new Error(
        `the ${profileLabel(profile)} proxy daemon did not stop; retry, or stop it ` +
          "manually (`agent stop --all`) before uninstalling",
      );
    }
  }
}

/** Resolved once before any step runs: the dry run plans exactly these and the live run removes
 *  exactly these, so neither can name (or take) a path the other did not. */
export interface UninstallTargets {
  desktop: ClaudeDesktopOwnedArtifacts;
  /** Named on its own because the float's cache may sit OUTSIDE the root home. */
  floatArtifacts: string[];
  /** Null on Windows, or when none is recorded. */
  codexHostFarm: string | null;
  shellFiles: string[];
  profiles: { name: ProfileName; claudeArtifacts: string[] }[];
  claudeMcpRegistration: string | null;
}

export interface UninstallContext {
  profiles: ProfileName[];
  codexHomes: string[];
  codexSweepComplete: boolean;
  claudeHome: string;
  rootHome: string;
  targets: UninstallTargets;
  installRoot: RootMode;
  /** A protected root (a source checkout) without `--force`. */
  skipRootDelete: boolean;
  /** Set by the install-root step when its removal could not finish. */
  rootRemains: boolean;
}

/** What a step says once its removals landed, held until they did: a dry run prints the plan in
 *  its place. A warning is said as it arises, in either mode. */
type Narration = () => void;

type UninstallStep = () => void | Narration | Promise<void | Narration>;

/** Order matters: daemons first (they hold the credential in memory, and a stuck one aborts before
 *  anything is deleted), all wiring and store work before the copilot-api home they read from, and
 *  the checkout (where this very process runs) dead last. Every removal goes through the facade, so
 *  a dry run names each file and store slot it would take. */
function uninstallSteps(ctx: UninstallContext): UninstallStep[] {
  return [
    // 1. Daemons.
    () => stopAllDaemons(ctx.profiles),
    // 2. Named profiles, one step each, so a deletion that landed is said before the next one can
    // fail. The Desktop entry is left for step 4b, which removes exactly the planned artifacts.
    ...ctx.targets.profiles.map(({ name, claudeArtifacts }) => async () => {
      await deleteProfileEverywhere(name, { keepDesktopEntry: true, claudeArtifacts });
      return () => consola.info(`Deleted ${profileLabel(name)}.`);
    }),
    // 3. Codex wiring, from EVERY known home: a farm home's config may reference the catalog file
    // step 7 removes (a dangling reference breaks Codex startup), and a profile wired while that
    // home was active left its tables there; step 2 stripped only the currently-effective home.
    () => {
      for (const home of ctx.codexHomes) {
        removeCodexDefaultWiring(home);
        for (const name of ctx.profiles) removeCodexProfile(home, name);
      }
      removeCodexHostFarm(ctx.targets.codexHostFarm);
      if (!ctx.codexSweepComplete) {
        consola.warn(
          "Could not enumerate every ~/.codex/hosts home; if Codex fails to start there " +
            "later, delete the stale model_catalog_json line from that config.toml.",
        );
      }
      return () => consola.info("Removed the copilot-env Codex wiring.");
    },
    // 4. Default Claude wiring. An exact-path-OWNED WebSearch deny is stripped even from a
    // foreign-edited config, ownership being the proof. The MCP registration is the deny's
    // web-search replacement, so it goes only once no owned deny remains.
    () => {
      const { ownedDenyRemains } = removeClaudeDefaultWiring(ctx.claudeHome);
      if (ownedDenyRemains) {
        consola.warn(
          `the copilot-env WebSearch deny in ${settingsPathFor(ctx.claudeHome)} could not ` +
            "be removed (the file could not be read, parsed, or rewritten); keeping the " +
            "copilot-env MCP registration as its marker (it stops working once copilot-env " +
            `is gone). Remove the deny by hand, then the copilot-env entry in ${claudeJsonPath()}.`,
        );
      } else if (ctx.targets.claudeMcpRegistration !== null) {
        try {
          removeClaudeMcpRegistration();
        } catch (e) {
          consola.warn(`could not remove the copilot-env MCP registration: ${errMessage(e)}`);
        }
      }
      return () => consola.info("Removed the copilot-env Claude wiring.");
    },
    // 4b. Claude Desktop's config library: owned entries and helper scripts only.
    () => {
      try {
        removeAllClaudeDesktopWiring(undefined, ctx.targets.desktop);
      } catch (e) {
        consola.warn(`could not remove the Claude Desktop entries: ${errMessage(e)}`);
      }
    },
    // 5. The default credential, before the home that stores it: if a later step fails partway,
    // the token is already gone.
    () => {
      new Credential().clear();
    },
    // 6. Shell integration.
    () => removeShellIntegrationFrom(ctx.targets.shellFiles),
    // 7. Stop again, then the copilot-api home. The second sweep closes the auto-start race: an
    // agent session could have relaunched a daemon between step 1 and the wiring removal; with the
    // wiring gone nothing can.
    async () => {
      await stopAllDaemons(ctx.profiles);
      // Before the home goes: a sidecar install can put the float's cache OUTSIDE the home, and
      // deleting the home alone would strand it.
      removeProxyFloatArtifacts(ctx.rootHome, ctx.targets.floatArtifacts);
      fs.rm(ctx.rootHome, { recursive: true, force: true, detail: "the copilot-api home" });
    },
    // 8. The install root, last and from a safe cwd. rmSync can fail mid-tree (Windows open
    // handles), so the exact finishing command and a non-zero exit let scripts tell "fully
    // removed" from "left behind".
    () => {
      const installRoot = ctx.installRoot.root;
      if (ctx.skipRootDelete) {
        consola.info(
          `${installRoot} is a source checkout; leaving it in place - delete it yourself, ` +
            "or re-run with --force.",
        );
        return;
      }
      // Already gone: a second run must be a silent no-op, not a refusal.
      if (!fs.exists(installRoot)) return;
      // The root is derived, so confirm it is really ours before deleting it recursively.
      if (!looksLikeInstallRoot(installRoot)) {
        consola.warn(
          `${installRoot} does not look like a copilot-env install root; leaving it ` +
            `in place. Remove it yourself if it is: ${manualRemoveCommand(installRoot)}`,
        );
        ctx.rootRemains = true;
        process.exitCode = 1;
        return;
      }
      try {
        process.chdir(homedir());
      } catch {
        // deletion may still succeed from the current cwd
      }
      try {
        fs.rm(installRoot, { recursive: true, force: true, detail: "the install directory" });
      } catch {
        consola.warn(
          `Could not fully delete ${installRoot} (files may be in use). ` +
            `Finish with: ${manualRemoveCommand(installRoot)}`,
        );
        ctx.rootRemains = true;
        process.exitCode = 1;
      }
    },
  ];
}

/** Exported so the plan/apply parity is testable: the dry run and the live run must both come from
 *  ONE context. `installRoot` is injected by the tests, so the suite can exercise a real deletion
 *  and never reach the directory the test process runs from. */
export function resolveUninstallContext(
  args: UninstallArgs,
  installRoot: RootMode = rootMode(),
): UninstallContext {
  const { homes: codexHomes, complete: codexSweepComplete } = knownCodexHomes();
  // A versioned install's compiled root is the `<top>/current` link; the DELETE target is the TOP
  // root (versions/, bin/, and the link itself).
  const deleteRoot: RootMode = installRoot.kind === "compiled"
    ? { kind: "compiled", root: installStateRoot(installRoot.root) }
    : installRoot;
  const rootHome = resolveRootHome();
  const claudeHome = resolveClaudeHome();
  const profiles = allProfileNames();
  return {
    profiles,
    codexHomes,
    codexSweepComplete,
    claudeHome,
    rootHome,
    targets: {
      profiles: profiles.map((name) => ({
        name,
        claudeArtifacts: claudeProfileArtifacts(claudeHome, name),
      })),
      claudeMcpRegistration: plannedClaudeMcpRemoval(),
      desktop: listClaudeDesktopOwnedArtifacts(),
      floatArtifacts: proxyFloatArtifactPaths(rootHome),
      codexHostFarm: recordedCodexHostFarm(),
      shellFiles: ownedShellTargets(),
    },
    installRoot: deleteRoot,
    skipRootDelete: isProtectedRoot(deleteRoot) && !args.force,
    rootRemains: false,
  };
}

export async function applyUninstall(ctx: UninstallContext): Promise<void> {
  for (const step of uninstallSteps(ctx)) {
    const landed = await step();
    // A dry run's stdout is the plan; what a step says once its removals are real waits for them.
    if (landed !== undefined && !fs.dryRunActive()) landed();
  }
}

export async function runUninstall(
  args: UninstallArgs,
  installRoot: RootMode = rootMode(),
): Promise<void> {
  // Before even enumerating anything.
  if (!args.yes && !args.dryRun) {
    if (!process.stdin.isTTY) {
      throw new Error("not a terminal - pass --yes to uninstall non-interactively");
    }
    const confirmed = await prompt(
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

  const ctx = resolveUninstallContext(args, installRoot);

  if (args.dryRun) {
    // The same steps on the dry run's overlay: every file and store slot they would take is the
    // plan, a daemon stop is its own line, and nothing lands.
    await runDryRun(() => applyUninstall(ctx));
    return;
  }

  await applyUninstall(ctx);

  if (ctx.rootRemains) {
    consola.info("Everything else is removed; finish with the command above.");
  } else {
    consola.success("copilot-env is uninstalled. Restart your shell to finish.");
  }
  consola.info(
    "Not removed: the agent CLIs themselves (claude / copilot / codex npm globals), " +
      "a deno installed for a source checkout (and its PATH entry), the " +
      "PowerShell execution policy, Codex's " +
      "sandbox_workspace_write.network_access key, other hosts' ~/.codex/hosts/* dirs " +
      "on a shared home, and the agents' own session history.",
  );
}
