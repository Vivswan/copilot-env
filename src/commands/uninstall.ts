// `agent uninstall`: remove everything copilot-env manages from this machine, in
// dependency-safe order -- stop every daemon, delete every named profile, strip
// the DEFAULT Codex + Claude wiring, clear the credential, unwire the shell
// integration, delete the copilot-api home, and finally the install root
// itself. Destructive, so it confirms interactively (`--yes` for headless use)
// and offers `--dry-run`. Idempotent: a second run finds nothing and exits 0.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { consola } from "consola";
import { claudeProfileArtifacts, removeClaudeDefaultWiring } from "../claude/config.ts";
import {
  type ClaudeDesktopOwnedArtifacts,
  listClaudeDesktopOwnedArtifacts,
  removeAllClaudeDesktopWiring,
} from "../claude/desktop.ts";
import { removeClaudeMcpRegistration } from "../claude/mcp_registration.ts";
import { resolveClaudeHome, settingsPathFor } from "../claude/paths.ts";
import { knownCodexHomes, removeCodexDefaultWiring, removeCodexProfile } from "../codex/config.ts";
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
  /** `--yes`: skip the confirmation prompt (headless use). */
  yes?: boolean;
  /** `--dry-run`: print what would be removed without changing anything. */
  dryRun?: boolean;
  /** `--force`: also delete the install directory when it is a source checkout. */
  force?: boolean;
}

/**
 * Test seam (the repo's deps pattern, e.g. DirectProbeDeps): these targets can
 * resolve to REAL machine paths that test env vars cannot (or cannot portably)
 * redirect -- homedir() ignores `$HOME` on Windows and the codex farm follows
 * `$HOME` only on POSIX -- so tests inject substitutes.
 */
export interface UninstallDeps {
  codexHomes?: string[];
  removeCodexHostFarm?: () => void;
  removeShellIntegration?: () => void;
  /**
   * Claude Desktop's configLibrary dir: injected because homedir()-anchored paths
   * are not env-redirectable on Windows (the resolveClaudeHome precedent). Absent =
   * resolve for this machine; null = treat Desktop as absent.
   */
  claudeDesktopLibraryDir?: string | null;
  /**
   * The install root to tear down, and with it the policy for whether deleting it
   * needs `--force`. Injected rather than read from the ambient PROJECT_ROOT so the
   * suite exercises a real deletion against a sandbox root and can never reach the
   * directory the test process is running from.
   */
  installRoot?: RootMode;
}

/** The run-state-recorded CODEX_HOME farm dir an uninstall would remove, or null
 *  (Windows, or none recorded). The narration and the removal share this ONE
 *  resolver so the dry-run can never drift from what actually gets deleted. */
function recordedCodexHostFarm(): string | null {
  if (process.platform === "win32") return null;
  const recorded = new CopilotEnvRunState().read().codexHome;
  return recorded ? recorded : null;
}

/** Tear down the host's CODEX_HOME symlink farm (POSIX only) at `recorded`, the plan's
 *  resolution of recordedCodexHostFarm. Ownership AND the path come from run state --
 *  the `codex-host` derivation persisted the farm dir it built there -- so an untracked
 *  ~/.codex/hosts/<hostname> someone else created is never swept, and a farm built
 *  under a different HOME is still the one removed. */
function removeCodexHostFarm(recorded: string | null): void {
  if (recorded === null) return;
  removeTreeReported(recorded);
  new CopilotEnvRunState().set({ codexHome: null });
}

/** The exact shell command that finishes a checkout delete the process could not. */
function manualRemoveCommand(dir: string): string {
  return process.platform === "win32"
    ? `Remove-Item -Recurse -Force ${quotePowerShell(dir)}`
    : `rm -rf ${quotePosix(dir)}`;
}

/** Stop the default daemon plus every profile's. Any daemon NOT confirmed stopped --
 *  a kill survivor, or a stop refused because the pid could not be corroborated as our
 *  daemon (the refusal has already warned with the reason) -- throws, so the caller
 *  aborts instead of deleting under a possibly-live proxy. */
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

/** The removal targets resolved ONCE, before any step runs: the dry run renders these
 *  and the live run removes exactly these, so neither can name (or take) a path the
 *  other did not. */
export interface UninstallTargets {
  /** The Claude Desktop entries and helper scripts we own (or `blocked`). */
  desktop: ClaudeDesktopOwnedArtifacts;
  /** The proxy float's cache dirs, record dir and marked .npmrc -- the cache may sit
   *  OUTSIDE the root home, which is why it is named on its own. */
  floatArtifacts: string[];
  /** The run-state-recorded CODEX_HOME farm dir, or null (Windows, none recorded, or a
   *  test substitute injected for the removal). */
  codexHostFarm: string | null;
  /** The rc / PowerShell profile files carrying an owned block (empty when a test
   *  substitute is injected for the removal). */
  shellFiles: string[];
  /** Per named profile: the Claude files its teardown removes (settings, legacy
   *  helpers) and its daemon home. */
  profiles: { name: ProfileName; claudeArtifacts: string[]; home: string }[];
}

/** Everything a step needs, resolved once after the confirmation gate. */
export interface UninstallContext {
  profiles: ProfileName[];
  codexHomes: string[];
  codexSweepComplete: boolean;
  claudeHome: string;
  rootHome: string;
  targets: UninstallTargets;
  /** The install root being torn down (injectable; see UninstallDeps.installRoot). */
  installRoot: RootMode;
  /** The root is protected (a source checkout) and `--force` was not given. */
  skipRootDelete: boolean;
  deps: UninstallDeps;
  /** Set by the install-root step when its removal could not finish. */
  rootRemains: boolean;
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
    //    The profile's Claude Desktop entry is NOT taken here: the Desktop step below
    //    removes exactly the planned artifacts, which include it.
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
    // 3. Codex wiring, from EVERY known home: farm homes hold host-local config
    //    copies, each may reference the account-wide catalog file the root-home
    //    delete below removes (a dangling reference breaks Codex startup), and a
    //    profile wired while a farm home was active left its tables there too --
    //    step 2 only stripped the currently-effective home. Then the farm itself.
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
    // 4. Default Claude wiring (surgical: only managed keys; helper scripts by
    //    name; an exact-path-OWNED WebSearch deny is stripped even from a
    //    foreign-edited config -- ownership is the proof), plus the copilot-env
    //    MCP registration in Claude's global ~/.claude.json (best-effort: a
    //    warn, never an abort). The registration is the deny's web-search
    //    replacement, so it only goes once no owned deny remains.
    describe: (ctx) => [
      `Would remove the managed Claude wiring at ${settingsPathFor(ctx.claudeHome)}.`,
      "Would remove the copilot-env MCP registration from Claude's global ~/.claude.json " +
      "(kept, with a warning, while an owned WebSearch deny cannot be stripped).",
    ],
    run: (ctx) => {
      const { ownedDenyRemains } = removeClaudeDefaultWiring(ctx.claudeHome);
      if (ownedDenyRemains) {
        consola.warn(
          `the copilot-env WebSearch deny in ${settingsPathFor(ctx.claudeHome)} could not ` +
            "be removed (the file could not be read, parsed, or rewritten); keeping the " +
            "copilot-env MCP registration as its marker (it stops working once copilot-env " +
            "is gone). Remove the deny by hand, then the copilot-env entry in ~/.claude.json.",
        );
      } else {
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
    // 4b. Claude Desktop's config library: the entries copilot-env created or
    //     adopted (ownership-recorded), plus the generated credential-helper
    //     scripts. Owned entries only -- a user's own configs stay untouched.
    //     The dry run names every path the sweep would delete.
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
    // 5. The default credential (named profiles were cleared in step 2), BEFORE
    //    the home that stores it is deleted: if any later step fails partway,
    //    the token is already gone.
    describe: () => ["Would clear the stored GitHub credential."],
    run: () => new Credential().clear(),
  },
  {
    // 6. Shell integration + launchers: the owned block in each planned rc / profile file.
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
    // 7. Stop again, then delete the copilot-api home (proxy config/apiKeys, run
    //    state, sqlite usage DBs, the usage index and its price-list cache, logs,
    //    the stores, github_token, the catalog).
    //    The second sweep closes the auto-start race: an agent session could have
    //    relaunched a daemon between step 1 and the wiring removal above; now
    //    that the wiring is gone nothing can start another.
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
      // Before the home goes: the float's cache is wherever its record points, which a
      // sidecar install can put OUTSIDE the home -- deleting the home alone would strand it.
      removeProxyFloatArtifacts(ctx.rootHome, ctx.targets.floatArtifacts);
      removeTreeReported(ctx.rootHome);
      consola.info(`Deleted the copilot-api home: ${ctx.rootHome}`);
    },
  },
  {
    // 8. The install root -- where this process runs, so it goes last, from a
    //    safe cwd. rmSync can fail mid-tree (Windows open handles, permissions);
    //    report the exact finishing command and a non-zero exit so scripts can
    //    tell "fully removed" from "directory left behind". A SOURCE checkout is
    //    left in place unless `--force`: developers run this from a clone to test
    //    it, and a nuked repo is unrecoverable while a leftover directory is a
    //    one-line `rm`. An installed binary root holds nothing the user authored,
    //    so it deletes freely.
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
      // The root is derived (two levels up from the binary, or an env override), so
      // confirm it is really ours before deleting it recursively.
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
        // pass -- deletion may still succeed from the current cwd.
      }
      try {
        removeTreeReported(installRoot);
        consola.info(`Deleted the install directory: ${installRoot}`);
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

/** Resolve everything the steps read -- homes, the install root, and the removal
 *  targets -- once. Exported so the plan/apply parity is testable: the dry run and the
 *  live run must both be rendered from ONE of these. */
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
  // A versioned install's compiled root is the `<top>/current` link; the DELETE
  // target is the TOP root (versions/, bin/, and the link itself), never just
  // the link. Resolved once here so the narration and the removal agree.
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

/** The dry run: every step's "Would ..." lines, in step order. */
export function describeUninstall(ctx: UninstallContext): string[] {
  return UNINSTALL_STEPS.flatMap((step) => step.describe(ctx));
}

/** The live run: every step, in order. */
export async function applyUninstall(ctx: UninstallContext): Promise<void> {
  for (const step of UNINSTALL_STEPS) await step.run(ctx);
}

/**
 * `agent uninstall`: remove copilot-env entirely, driving BOTH `--dry-run` and
 * the real teardown from UNINSTALL_STEPS over ONE resolved context, so the
 * narration cannot drift from what actually runs.
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
