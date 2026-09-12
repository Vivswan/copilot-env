// Idempotent: a second run finds nothing and exits 0.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { consola } from "consola";
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
import { knownCodexHomes } from "../codex/host.ts";
import { codexConfigPath } from "../codex/paths.ts";
import { Credential } from "../copilot_api/credential.ts";
import { stopTrackedProxy } from "../copilot_api/daemon.ts";
import { allProfileNames } from "../copilot_api/env_state.ts";
import { profileHome, resolveRootHome } from "../copilot_api/paths.ts";
import { DAEMON_SIGKILL_GRACE_MS } from "../copilot_api/process.ts";
import { profileLabel, type ProfileName } from "../copilot_api/profile.ts";
import { CopilotEnvRunState } from "../copilot_api/state.ts";
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
import { removeTreeReported } from "../utils/report_write.ts";
import { deleteProfileEverywhere } from "./profile.ts";

export interface UninstallArgs {
  yes?: boolean;
  dryRun?: boolean;
  force?: boolean;
}

/** These targets can resolve to REAL machine paths that test env vars cannot redirect (homedir()
 *  ignores `$HOME` on Windows; the codex farm follows `$HOME` only on POSIX), so tests inject
 *  substitutes. */
export interface UninstallDeps {
  codexHomes?: string[];
  removeCodexHostFarm?: () => void;
  removeShellIntegration?: () => void;
  /** Absent = resolve for this machine; null = treat Desktop as absent. */
  claudeDesktopLibraryDir?: string | null;
  /** Injected rather than read from PROJECT_ROOT so the suite can exercise a real deletion and
   *  never reach the directory the test process runs from. */
  installRoot?: RootMode;
}

/** The narration and the removal share this one resolver, so the dry run cannot drift from what
 *  gets deleted. */
function recordedCodexHostFarm(): string | null {
  if (process.platform === "win32") return null;
  const recorded = new CopilotEnvRunState().read().codexHome;
  return recorded ? recorded : null;
}

/** Ownership AND the path come from run state, so an untracked ~/.codex/hosts/<hostname> someone
 *  else created is never swept, and a farm built under a different HOME is still the one removed.
 */
function removeCodexHostFarm(recorded: string | null): void {
  if (recorded === null) return;
  removeTreeReported(recorded);
  new CopilotEnvRunState().set({ codexHome: null });
}

function manualRemoveCommand(dir: string): string {
  return process.platform === "win32"
    ? `Remove-Item -Recurse -Force ${quotePowerShell(dir)}`
    : `rm -rf ${quotePosix(dir)}`;
}

/** Any daemon NOT confirmed stopped (a kill survivor, or a stop refused because the pid could not
 *  be corroborated as ours) throws, so the caller aborts instead of deleting under a possibly-live
 *  proxy. */
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

/** Resolved once before any step runs: the dry run renders these and the live run removes exactly
 *  these, so neither can name (or take) a path the other did not. */
export interface UninstallTargets {
  desktop: ClaudeDesktopOwnedArtifacts;
  /** Named on its own because the float's cache may sit OUTSIDE the root home. */
  floatArtifacts: string[];
  /** Null on Windows, when none is recorded, or when a test substitute does the removal. */
  codexHostFarm: string | null;
  /** Empty when a test substitute does the removal. */
  shellFiles: string[];
  profiles: { name: ProfileName; claudeArtifacts: string[]; home: string }[];
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
  deps: UninstallDeps;
  /** Set by the install-root step when its removal could not finish. */
  rootRemains: boolean;
}

/** The dry-run narration and the real work come from the same entry, so neither can drift from the
 *  other. */
interface UninstallStep {
  describe: (ctx: UninstallContext) => string[];
  run: (ctx: UninstallContext) => void | Promise<void>;
}

/** Order matters: daemons first (they hold the credential in memory, and a stuck one aborts before
 *  anything is deleted), all wiring and store work before the copilot-api home they read from, and
 *  the checkout (where this very process runs) dead last. */
const UNINSTALL_STEPS: UninstallStep[] = [
  {
    // 1. Daemons.
    describe: (ctx) => [
      `Would stop the default proxy daemon${
        ctx.profiles.length > 0 ? ` and ${ctx.profiles.length} profile daemon(s)` : ""
      }.`,
    ],
    run: (ctx) => stopAllDaemons(ctx.profiles),
  },
  {
    // 2. Named profiles. The Desktop entry is left for step 4b, which removes exactly the planned
    // artifacts.
    describe: (ctx) =>
      ctx.targets.profiles.map(
        ({ name, claudeArtifacts, home }) =>
          `Would delete ${profileLabel(name)}: its credential, its Codex profile tables, ` +
          `${[...claudeArtifacts, home].join(", ")}.`,
      ),
    run: async (ctx) => {
      for (const { name, claudeArtifacts } of ctx.targets.profiles) {
        await deleteProfileEverywhere(name, { keepDesktopEntry: true, claudeArtifacts });
        consola.info(`Deleted ${profileLabel(name)}.`);
      }
    },
  },
  {
    // 3. Codex wiring, from EVERY known home: a farm home's config may reference the catalog file
    // step 7 removes (a dangling reference breaks Codex startup), and a profile wired while that
    // home was active left its tables there; step 2 stripped only the currently-effective home.
    describe: (ctx) => {
      const lines = ctx.codexHomes.map(
        (home) => `Would remove the copilot-env wiring from ${codexConfigPath(home)}.`,
      );
      const farm = ctx.targets.codexHostFarm;
      if (farm !== null) lines.push(`Would delete the CODEX_HOME host farm: ${farm}`);
      return lines;
    },
    run: (ctx) => {
      for (const home of ctx.codexHomes) {
        removeCodexDefaultWiring(home);
        for (const name of ctx.profiles) removeCodexProfile(home, name);
      }
      if (ctx.deps.removeCodexHostFarm !== undefined) ctx.deps.removeCodexHostFarm();
      else removeCodexHostFarm(ctx.targets.codexHostFarm);
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
    // 4. Default Claude wiring. An exact-path-OWNED WebSearch deny is stripped even from a
    // foreign-edited config, ownership being the proof. The MCP registration is the deny's
    // web-search replacement, so it goes only once no owned deny remains.
    describe: (ctx) => [
      `Would remove the managed Claude wiring at ${settingsPathFor(ctx.claudeHome)}.`,
      ctx.targets.claudeMcpRegistration === null
        ? `Would leave ${claudeJsonPath()} alone (no removable copilot-env MCP registration found in it).`
        : `Would remove the copilot-env MCP registration from ${ctx.targets.claudeMcpRegistration} ` +
          "(kept, with a warning, while an owned WebSearch deny cannot be stripped).",
    ],
    run: (ctx) => {
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
      consola.info("Removed the copilot-env Claude wiring.");
    },
  },
  {
    // 4b. Claude Desktop's config library: owned entries and helper scripts only.
    describe: (ctx) => {
      const { entries, staleClaims, helpers, blocked } = ctx.targets.desktop;
      const paths = [...entries, ...helpers];
      if (blocked) {
        return [
          "Would leave Claude Desktop's config library alone (its _meta.json could not be read); " +
          "its copilot-env entries will point at credential-helper scripts that go with the " +
          "copilot-api home below.",
        ];
      }
      const stale = staleClaims.map(
        (p) => `Would release the stale Claude Desktop claim on ${p} (file already gone).`,
      );
      const meta = ctx.targets.desktop.metaRewrite;
      if (meta !== null) stale.push(`Would rewrite ${meta} (copilot-env rows removed).`);
      if (paths.length === 0) {
        return [
          "Would remove the copilot-env entries from Claude Desktop's config library (none found).",
          ...stale,
        ];
      }
      return [
        "Would remove the copilot-env entries from Claude Desktop's config library:",
        ...paths.map((p) => `  ${p}`),
        ...stale,
      ];
    },
    run: (ctx) => {
      try {
        removeAllClaudeDesktopWiring(ctx.deps.claudeDesktopLibraryDir, ctx.targets.desktop);
      } catch (e) {
        consola.warn(`could not remove the Claude Desktop entries: ${errMessage(e)}`);
      }
    },
  },
  {
    // 5. The default credential, before the home that stores it: if a later step fails partway, the
    // token is already gone.
    describe: () => ["Would clear the stored GitHub credential."],
    run: () => new Credential().clear(),
  },
  {
    // 6. Shell integration.
    describe: (ctx) =>
      ctx.targets.shellFiles.length === 0
        ? [
          "Would remove the shell integration block from the rc / PowerShell profile files (none found).",
        ]
        : ctx.targets.shellFiles.map((file) =>
          `Would remove the shell integration block from ${file}.`
        ),
    run: (ctx) => {
      if (ctx.deps.removeShellIntegration !== undefined) ctx.deps.removeShellIntegration();
      else removeShellIntegrationFrom(ctx.targets.shellFiles);
    },
  },
  {
    // 7. Stop again, then the copilot-api home. The second sweep closes the auto-start race: an
    // agent session could have relaunched a daemon between step 1 and the wiring removal; with the
    // wiring gone nothing can.
    describe: (ctx) => [
      "Would stop any proxy daemon relaunched in the meantime (second sweep).",
      ...(ctx.targets.floatArtifacts.length === 0
        ? ["Would delete the floated proxy's deno cache and resolved-version record (none found)."]
        : [
          "Would delete the floated proxy's deno cache and resolved-version record:",
          ...ctx.targets.floatArtifacts.map((p) => `  ${p}`),
        ]),
      `Would delete the copilot-api home: ${ctx.rootHome} (including the usage index and the price-list cache).`,
    ],
    run: async (ctx) => {
      await stopAllDaemons(ctx.profiles);
      // Before the home goes: a sidecar install can put the float's cache OUTSIDE the home, and
      // deleting the home alone would strand it.
      removeProxyFloatArtifacts(ctx.rootHome, ctx.targets.floatArtifacts);
      removeTreeReported(ctx.rootHome, "the copilot-api home");
    },
  },
  {
    // 8. The install root, last and from a safe cwd. rmSync can fail mid-tree (Windows open
    // handles), so the exact finishing command and a non-zero exit let scripts tell "fully removed"
    // from "left behind".
    describe: (ctx) => [
      ctx.skipRootDelete
        ? `Would leave ${ctx.installRoot.root} in place (source checkout; re-run with --force to delete it).`
        : `Would delete the install directory: ${ctx.installRoot.root}`,
    ],
    run: (ctx) => {
      const installRoot = ctx.installRoot.root;
      if (ctx.skipRootDelete) {
        consola.info(
          `${installRoot} is a source checkout; leaving it in place - delete it yourself, ` +
            "or re-run with --force.",
        );
        return;
      }
      // Already gone: a second run must be a silent no-op, not a refusal.
      if (!existsSync(installRoot)) return;
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
        removeTreeReported(installRoot, "the install directory");
      } catch {
        consola.warn(
          `Could not fully delete ${installRoot} (files may be in use). ` +
            `Finish with: ${manualRemoveCommand(installRoot)}`,
        );
        ctx.rootRemains = true;
        process.exitCode = 1;
      }
    },
  },
];

/** Exported so the plan/apply parity is testable: the dry run and the live run must both come from
 *  ONE context. */
export function resolveUninstallContext(
  args: UninstallArgs,
  deps: UninstallDeps,
): UninstallContext {
  let codexHomes: string[];
  let codexSweepComplete = true;
  if (deps.codexHomes !== undefined) {
    codexHomes = deps.codexHomes;
  } else {
    ({ homes: codexHomes, complete: codexSweepComplete } = knownCodexHomes());
  }
  const mode = deps.installRoot ?? rootMode();
  // A versioned install's compiled root is the `<top>/current` link; the DELETE target is the TOP
  // root (versions/, bin/, and the link itself).
  const installRoot: RootMode = mode.kind === "compiled"
    ? { kind: "compiled", root: installStateRoot(mode.root) }
    : mode;
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
        home: profileHome(name),
      })),
      claudeMcpRegistration: plannedClaudeMcpRemoval(),
      desktop: listClaudeDesktopOwnedArtifacts(deps.claudeDesktopLibraryDir),
      floatArtifacts: proxyFloatArtifactPaths(rootHome),
      // A test substitute does its own (redirected) work, not this state-recorded rm.
      codexHostFarm: deps.removeCodexHostFarm === undefined ? recordedCodexHostFarm() : null,
      shellFiles: deps.removeShellIntegration === undefined ? ownedShellTargets() : [],
    },
    installRoot,
    skipRootDelete: isProtectedRoot(installRoot) && !args.force,
    deps,
    rootRemains: false,
  };
}

export function describeUninstall(ctx: UninstallContext): string[] {
  return UNINSTALL_STEPS.flatMap((step) => step.describe(ctx));
}

export async function applyUninstall(ctx: UninstallContext): Promise<void> {
  for (const step of UNINSTALL_STEPS) await step.run(ctx);
}

export async function runUninstall(args: UninstallArgs, deps: UninstallDeps = {}): Promise<void> {
  // Before even enumerating anything.
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

  const ctx = resolveUninstallContext(args, deps);

  if (args.dryRun) {
    consola.info("DRY RUN: nothing will be removed.");
    for (const line of describeUninstall(ctx)) consola.info(`   ${line}`);
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
