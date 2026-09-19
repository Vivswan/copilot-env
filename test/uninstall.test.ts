// Every run injects the install root it deletes (a sandbox directory, never the tree this process
// runs from); the codex homes, the host farm, the shell rc files, and the Desktop library resolve
// through the suite's redirected HOME and env seams.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import { parse } from "smol-toml";
import { configureClaudeConfig, WEBSEARCH_DENY_RULE } from "../src/claude/config.ts";
import { desktopHelperPath } from "../src/claude/desktop_helper_scripts.ts";
import { CLAUDE_DESKTOP_DIR_ENV, desktopLibraryDirUnder } from "../src/claude/desktop_library.ts";
import { claudeJsonPath, registerClaudeMcpServer } from "../src/claude/mcp_registration.ts";
import { settingsPathFor } from "../src/claude/paths.ts";
import { configureCodexConfig } from "../src/codex/config.ts";
import { codexConfigPath, codexProfileConfigPath } from "../src/codex/paths.ts";
import {
  applyUninstall,
  resolveUninstallContext,
  runUninstall,
} from "../src/commands/uninstall.ts";
import { Credential } from "../src/copilot_api/credential.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { OwnershipLedger } from "../src/copilot_api/ownership.ts";
import { CopilotApiPaths, profileHome, resolveRootHome } from "../src/copilot_api/paths.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import { CopilotEnvRunState } from "../src/copilot_api/run_state.ts";
import { isRecord } from "../src/utils/json.ts";
import { INSTALL_MANIFEST_FILE, type RootMode } from "../src/utils/root.ts";
import { pointCurrentAt } from "../src/install/installer.ts";
import { writeResolvedVersionRecord } from "../src/proxy_float.ts";
import {
  CI_PS_DOCUMENTS_DIR_ENV,
  CI_RC_DIR_ENV,
  MARKER as SHELL_MARKER,
  MARKER_END,
  shellTargetFiles,
} from "../src/shell/integration.ts";
import type { FileChange } from "../src/utils/dry_run.ts";
import { deferWriteReports, flushWriteReports } from "../src/utils/report_write.ts";
import { captureChannels } from "./helpers/output.ts";
import { ROOT } from "./helpers/run.ts";
import { afterEach, expect, removeDir, test } from "./helpers/testing.ts";
import { envSnapshot, isolateAgentHomes, resetExitCode } from "./helpers/env.ts";
import { stageRefusedStop } from "./helpers/daemon.ts";
import { dryRunChanges } from "./helpers/dry_run.ts";

// A branded fixture name: parseProfileName is the only mint for ProfileName.
const WORK = parseProfileName("work");
const COMMAND = { kind: "command" } as const;

const restoreEnv = envSnapshot();
let dir = "";

// The delete step chdir's out of the doomed directory; every other test file that
// reads a cwd-relative path would inherit that move, so put it back.
const startCwd = process.cwd();

afterEach(() => {
  restoreEnv();
  process.chdir(startCwd);
  // An aborted run's exit 1 must never leak into the whole `deno test` run.
  resetExitCode();
  dir = removeDir(dir);
});

function tmpHomes(): { proxyHome: string; claudeHome: string; codexHome: string } {
  const homes = isolateAgentHomes("copilot-uninstall-");
  dir = homes.dir;
  return homes;
}

/**
 * `kind: "compiled"` makes the delete step REALLY remove the root: the production path, run
 * against a temp directory instead of the tree under test.
 */
function sandboxRoot(kind: RootMode["kind"] = "compiled"): RootMode {
  if (dir === "") throw new Error("call tmpHomes() first: sandboxRoot needs the per-test tmp dir");
  const root = join(dir, "install-root");
  // Carry the marker layout looksLikeInstallRoot() requires, so the delete step sees a
  // root shaped like a real one rather than being turned away by the safety guard.
  for (const marker of ["bin", "shell", join("src", "scripts")]) {
    mkdirSync(join(root, marker), { recursive: true });
  }
  writeFileSync(join(root, "bin", "copilot-env"), "#!/bin/sh\n");
  return { kind, root };
}

/** The Desktop library under the suite's env seam, created so Desktop reads as present. */
function desktopLibrary(): string {
  const desktopData = join(dir, "desktop");
  process.env[CLAUDE_DESKTOP_DIR_ENV] = desktopData;
  const library = desktopLibraryDirUnder(desktopData);
  mkdirSync(library, { recursive: true });
  return library;
}

// The record is POSIX only (Windows builds no farm), so the deletion proof is too.
const skipWin = test.skipIf(process.platform === "win32");

skipWin(
  "the recorded farm is planned and deleted only while it still carries our config.toml; a foreign directory at the recorded path is left alone",
  async () => {
    tmpHomes();
    // A farm under a `codex-home` root the user has since removed stays recorded until the next
    // wiring pass; the only difference between ours and a replacement is the config inside.
    const recorded = join(dir, "old-root", "hosts", "box");
    for (const ours of [true, false]) {
      mkdirSync(recorded, { recursive: true });
      if (ours) {
        configureCodexConfig(recorded, { credential: COMMAND, mode: "direct", direct: null });
      } else writeFileSync(join(recorded, "config.toml"), 'model_provider = "openai"\n');
      new CopilotEnvRunState().set({ codexHome: recorded });
      // A fresh sandbox per pass: the live apply deletes it.
      const ctx = resolveUninstallContext({ yes: true }, sandboxRoot());
      expect(ctx.targets.codexHostFarm).toBe(ours ? recorded : null);
      const { changes } = await dryRunChanges(() => applyUninstall(ctx));
      expect(changes.some((c) => c.path === recorded && c.verdict === "delete")).toBe(ours);
      expect(existsSync(recorded)).toBe(true);
      await applyUninstall(ctx);
      expect(existsSync(recorded)).toBe(!ours);
    }
  },
);

function readToml(codexHome: string): Record<string, unknown> {
  return parse(readFileSync(join(codexHome, "config.toml"), "utf8")) as Record<string, unknown>;
}

test(
  "uninstall: a REFUSED stop aborts before anything is deleted",
  async () => {
    const { proxyHome, codexHome } = tmpHomes();
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "config.toml"), 'foo = "bar"\n');
    const root = sandboxRoot();
    const fx = stageRefusedStop(new CopilotApiPaths().home);
    try {
      // The refusal (an uncorroborated lock holder) surfaces from the FIRST step, so
      // no wiring, farm, shell, or data removal ever runs under the live daemon.
      await expect(runUninstall({ yes: true }, root)).rejects.toThrow("did not stop");
      expect(existsSync(proxyHome)).toBe(true);
      expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toContain('foo = "bar"');
      expect(existsSync(root.root)).toBe(true);
      expect(new CopilotEnvRunState().read().pid).toBe(fx.bystanderPid);
    } finally {
      await fx.teardown();
    }
  },
  30_000,
);

test("uninstall removes everything managed and preserves user config", async () => {
  const { proxyHome, claudeHome, codexHome } = tmpHomes();

  mkdirSync(claudeHome, { recursive: true });
  writeFileSync(settingsPathFor(claudeHome), JSON.stringify({ model: "opus" }));
  configureClaudeConfig(claudeHome, { credential: COMMAND, mode: "direct", direct: null });
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(
    join(codexHome, "config.toml"),
    ['foo = "bar"', "", "[model_providers.mine]", 'base_url = "https://example.test"', ""].join(
      "\n",
    ),
  );
  configureCodexConfig(codexHome, {
    credential: COMMAND,
    mode: "proxy",
    baseUrl: "http://127.0.0.1:4199/v1",
  });

  new Credential().store("gh-token", "ghp_default");
  new CopilotEnvState().commitProfile(WORK, {
    credential: { kind: "stored", provider: "gh-token", token: "ghp_work" },
    mode: "direct",
  });
  configureClaudeConfig(claudeHome, {
    credential: COMMAND,
    mode: "direct",
    direct: null,
    profile: WORK,
  });
  configureCodexConfig(codexHome, {
    credential: COMMAND,
    mode: "direct",
    direct: null,
    profile: WORK,
  });
  mkdirSync(profileHome(WORK), { recursive: true });

  // A second Codex home, a farm home under the redirected HOME (from when it was the effective
  // one), carrying BOTH default and profile wiring: the sweep enumerates and cleans it too.
  const codexHome2 = join(dir, ".codex", "hosts", "old-box");
  configureCodexConfig(codexHome2, {
    credential: COMMAND,
    mode: "proxy",
    baseUrl: "http://127.0.0.1:4199/v1",
  });
  configureCodexConfig(codexHome2, {
    credential: COMMAND,
    mode: "direct",
    direct: null,
    profile: WORK,
  });

  const root = sandboxRoot();
  await runUninstall({ yes: true }, root);
  // exitCode stays undefined until someone sets it; a clean run sets nothing.
  expect(process.exitCode ?? 0).toBe(0);

  expect(existsSync(settingsPathFor(claudeHome, WORK))).toBe(false);
  expect(existsSync(profileHome(WORK))).toBe(false);

  const settings = JSON.parse(readFileSync(settingsPathFor(claudeHome), "utf8")) as Record<
    string,
    unknown
  >;
  expect(settings.apiKeyHelper).toBeUndefined();
  expect(settings.env).toBeUndefined();
  // The MCP + WebSearch-deny pair the direct wiring added is fully taken back.
  expect(settings.permissions).toBeUndefined();
  expect(
    (JSON.parse(readFileSync(claudeJsonPath(), "utf8")) as Record<string, unknown>).mcpServers,
  ).toBeUndefined();
  expect(settings.model).toBe("opus");

  for (const home of [codexHome, codexHome2]) {
    const swept = readToml(home);
    expect(swept.model_provider).toBeUndefined();
    expect(swept.web_search).toBeUndefined();
    expect(swept.profiles).toBeUndefined();
    const sweptProviders = isRecord(swept.model_providers) ? swept.model_providers : {};
    expect(sweptProviders["copilot-env"]).toBeUndefined();
    expect(sweptProviders["copilot-env-work"]).toBeUndefined();
  }
  const doc = readToml(codexHome);
  const providers = isRecord(doc.model_providers) ? doc.model_providers : {};
  expect(isRecord(providers.mine)).toBe(true);
  expect(doc.foo).toBe("bar");

  // The install root deleted is the injected sandbox; the tree this process runs from is
  // untouched.
  expect(existsSync(proxyHome)).toBe(false);
  expect(existsSync(root.root)).toBe(false);
  expect(existsSync(join(ROOT, "package.json"))).toBe(true);
});

test("a source-checkout root survives the uninstall unless --force is given", async () => {
  tmpHomes();
  for (const force of [false, true]) {
    const root = sandboxRoot("checkout");

    await runUninstall({ yes: true, force }, root);

    // Protection follows the injected RootMode's kind, not any ambient .git probe:
    // nothing was created or removed inside the sandbox to make it look like a clone.
    expect(existsSync(root.root), `force ${force}`).toBe(!force);
    if (!force) expect(existsSync(join(root.root, ".git"))).toBe(false);
  }
});

test("uninstall refuses a root that does not look like a copilot-env install", async () => {
  tmpHomes();
  // A compiled binary dropped in ~/.local/bin resolves its root to ~/.local: unprotected
  // by kind, but not ours to delete. Only `bin` is present, none of the other markers.
  const stray = join(dir, "stray-root");
  mkdirSync(join(stray, "bin"), { recursive: true });

  await runUninstall({ yes: true }, { kind: "compiled", root: stray });

  expect(existsSync(stray)).toBe(true);
  expect(process.exitCode).toBe(1);
});

test("uninstall on a VERSIONED install deletes the whole top, not just the link", async () => {
  tmpHomes();
  // A versioned install's compiled root is the `<top>/current` link. The delete
  // must resolve to the TOP (versions/, bin/, and the link), or an uninstall
  // would remove one directory entry and leave the entire install behind.
  const top = join(dir, "versioned-root");
  const versionRoot = join(top, "versions", "v9.9.9");
  mkdirSync(join(versionRoot, "bin"), { recursive: true });
  mkdirSync(join(top, "bin"), { recursive: true });
  writeFileSync(join(versionRoot, "bin", "copilot-env"), "#!/bin/sh\n");
  writeFileSync(
    join(versionRoot, INSTALL_MANIFEST_FILE),
    JSON.stringify({ "version": "9.9.9", "kind": "installed", "assets": ["shell"] }),
  );
  pointCurrentAt(top, "v9.9.9");

  await runUninstall({ yes: true }, { kind: "compiled", root: join(top, "current") });

  expect(existsSync(top)).toBe(false);
});

test("uninstall leaves foreign Claude/Codex wiring untouched", async () => {
  const { claudeHome, codexHome } = tmpHomes();
  mkdirSync(claudeHome, { recursive: true });
  const settingsText = JSON.stringify({
    apiKeyHelper: "/usr/local/bin/my-helper",
    env: { ANTHROPIC_BASE_URL: "https://my-gateway.test" },
  });
  writeFileSync(settingsPathFor(claudeHome), settingsText);
  mkdirSync(codexHome, { recursive: true });
  const tomlText = ['model_provider = "openai"', 'web_search = "live"', ""].join("\n");
  writeFileSync(join(codexHome, "config.toml"), tomlText);

  await runUninstall({ yes: true }, sandboxRoot());

  expect(readFileSync(settingsPathFor(claudeHome), "utf8")).toBe(settingsText);
  expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(tomlText);
});

test("uninstall on a foreign-edited config strips OUR deny, then removes the registration", async () => {
  const { claudeHome } = tmpHomes();
  configureClaudeConfig(claudeHome, { credential: COMMAND, mode: "direct", direct: null }); // deny + registration + ownership
  const settingsPath = settingsPathFor(claudeHome);
  const doc = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  doc.apiKeyHelper = "/usr/local/bin/my-helper"; // foreign edit: wiring classifies "other"
  writeFileSync(settingsPath, JSON.stringify(doc));

  await runUninstall({ yes: true }, sandboxRoot());

  // The OWNED deny went (ownership is the proof, not the mode classification);
  // the foreign wiring itself stayed whole.
  const after = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  expect(after.permissions).toBeUndefined();
  expect(after.apiKeyHelper).toBe("/usr/local/bin/my-helper");
  // With no owned deny left, the MCP registration was removable.
  expect(
    (JSON.parse(readFileSync(claudeJsonPath(), "utf8")) as Record<string, unknown>).mcpServers,
  ).toBeUndefined();
});

test("uninstall never touches a user's own deny on a foreign config (registration still goes)", async () => {
  const { claudeHome } = tmpHomes();
  mkdirSync(claudeHome, { recursive: true });
  const settingsText = JSON.stringify({
    apiKeyHelper: "/usr/local/bin/my-helper",
    permissions: { deny: [WEBSEARCH_DENY_RULE] }, // the user's own rule, never claimed
  });
  writeFileSync(settingsPathFor(claudeHome), settingsText);
  expect(registerClaudeMcpServer()).toBe(true); // a leftover registration

  await runUninstall({ yes: true }, sandboxRoot());

  expect(readFileSync(settingsPathFor(claudeHome), "utf8")).toBe(settingsText);
  expect(
    (JSON.parse(readFileSync(claudeJsonPath(), "utf8")) as Record<string, unknown>).mcpServers,
  ).toBeUndefined();
});

test("uninstall keeps the MCP registration while an owned deny cannot be stripped", async () => {
  const { claudeHome } = tmpHomes();
  configureClaudeConfig(claudeHome, { credential: COMMAND, mode: "direct", direct: null }); // deny + registration + ownership
  const settingsPath = settingsPathFor(claudeHome);
  writeFileSync(settingsPath, "{ not json"); // the owned deny is now unverifiable

  await runUninstall({ yes: true }, sandboxRoot());

  // Never a denied builtin with no replacement: the file stays whole and the
  // registration (the deny's web-search replacement) stays with it.
  expect(readFileSync(settingsPath, "utf8")).toBe("{ not json");
  expect(
    (JSON.parse(readFileSync(claudeJsonPath(), "utf8")) as Record<string, unknown>).mcpServers,
  ).toBeDefined();
});

test("uninstall is idempotent: a second run finds nothing and exits 0", async () => {
  tmpHomes();
  const root = sandboxRoot();
  await runUninstall({ yes: true }, root);
  await runUninstall({ yes: true }, root);
  expect(process.exitCode ?? 0).toBe(0);
});

test("uninstall without --yes on a non-TTY refuses and deletes nothing", async () => {
  const { proxyHome, claudeHome } = tmpHomes();
  mkdirSync(claudeHome, { recursive: true });
  configureClaudeConfig(claudeHome, { credential: COMMAND, mode: "direct", direct: null });
  new Credential().store("gh-token", "ghp_default");

  // the test runner's stdin is not a TTY, so the guard fires before the prompt.
  await expect(runUninstall({}, sandboxRoot())).rejects.toThrow(/--yes/);
  expect(existsSync(settingsPathFor(claudeHome))).toBe(true);
  expect(existsSync(proxyHome)).toBe(true);
});

test("uninstall --dry-run prints every file and store slot it would take as the plan, and changes nothing", async () => {
  const { proxyHome, claudeHome, codexHome } = tmpHomes();
  mkdirSync(claudeHome, { recursive: true });
  configureClaudeConfig(claudeHome, { credential: COMMAND, mode: "direct", direct: null });
  configureCodexConfig(codexHome, {
    credential: COMMAND,
    mode: "proxy",
    baseUrl: "http://127.0.0.1:4199/v1",
  });
  new Credential().store("gh-token", "ghp_default");

  // Owned and foreign Claude Desktop entries side by side, through the env seam's library dir.
  const library = desktopLibrary();
  writeFileSync(join(library, "ours.json"), '{"inferenceGatewayBaseUrl":"x"}\n');
  writeFileSync(join(library, "theirs.json"), '{"userKey":1}\n');
  writeFileSync(
    join(library, "_meta.json"),
    `${
      JSON.stringify({
        entries: [{ id: "ours", name: "copilot-env" }, { id: "theirs", name: "Mine" }],
      })
    }\n`,
  );
  new OwnershipLedger().record("claudeDesktop", join(library, "ours.json"));
  const helper = desktopHelperPath(resolveRootHome(), "direct", null);
  mkdirSync(dirname(helper), { recursive: true });
  writeFileSync(helper, "#!/bin/sh\n");

  const root = sandboxRoot();
  // The farm record is POSIX only (Windows builds no farm).
  const farm = join(dir, "farm");
  const posix = process.platform !== "win32";
  if (posix) {
    configureCodexConfig(farm, { credential: COMMAND, mode: "direct", direct: null });
    new CopilotEnvRunState().set({ codexHome: farm });
  }

  const cwd = process.cwd();
  const { stdout, stderr } = await captureChannels(() => runUninstall({ dryRun: true }, root));
  // A dry run moves nothing of the process either: the live delete step leaves the doomed tree.
  expect(process.cwd()).toBe(cwd);
  // The plan is the tree diff on stdout: every removal outside our homes by path, the wiring
  // rewrites by attribute, the home (the Desktop helper inside it included) and the install root
  // as whole trees.
  expect(stdout).toContain("DRY RUN: nothing was written. The command would:");
  for (
    const line of [
      `delete ${join(library, "ours.json")}`,
      `rewrite ${join(library, "_meta.json")}`,
      `delete ${settingsPathFor(claudeHome)}`,
      `rewrite ${codexConfigPath(codexHome)}`,
      'model_provider  "copilot-env" -> (absent)',
      `delete ${proxyHome}${sep}`,
      `delete ${root.root}${sep}`,
      ...(posix ? [`delete ${farm}${sep}`] : []),
    ]
  ) {
    expect(stdout).toContain(line);
  }
  // The foreign sibling is never named: it would never be deleted. No daemon is tracked, so
  // nothing is said about stopping one, and the live run's success lines wait for a landing.
  expect(stdout + stderr).not.toContain(join(library, "theirs.json"));
  expect(stdout + stderr).not.toContain("Would stop the tracked proxy daemon");
  expect(stdout + stderr).not.toContain("Removed the copilot-env");
  expect(stdout + stderr).not.toContain("is uninstalled");

  expect(existsSync(root.root)).toBe(true);
  expect(existsSync(settingsPathFor(claudeHome))).toBe(true);
  expect(readToml(codexHome).model_provider).toBe("copilot-env");
  expect(new Credential().resolve()).toBe("ghp_default");
  expect(existsSync(proxyHome)).toBe(true);
  expect(existsSync(join(library, "ours.json"))).toBe(true);
  expect(existsSync(helper)).toBe(true);
  if (posix) expect(existsSync(farm)).toBe(true);
});

test.skipIf(process.platform === "win32")(
  "uninstall removes only the run-state-recorded codex farm, never an untracked dir",
  async () => {
    tmpHomes();
    const farm = join(dir, "farm");
    const untracked = join(dir, "untracked-farm");
    // Both carry our config, as a wiring pass leaves a farm; the record alone separates them.
    configureCodexConfig(farm, { credential: COMMAND, mode: "direct", direct: null });
    configureCodexConfig(untracked, { credential: COMMAND, mode: "direct", direct: null });
    new CopilotEnvRunState().set({ codexHome: farm });

    await runUninstall({ yes: true }, sandboxRoot());

    expect(existsSync(farm)).toBe(false);
    expect(existsSync(untracked)).toBe(true);
  },
);

test("uninstall removes owned Claude Desktop entries from the library the env seam names", async () => {
  tmpHomes();
  const library = desktopLibrary();
  writeFileSync(join(library, "ours.json"), '{"inferenceGatewayBaseUrl":"x"}\n');
  writeFileSync(join(library, "theirs.json"), '{"userKey":1}\n');
  writeFileSync(
    join(library, "_meta.json"),
    `${
      JSON.stringify({
        appliedId: "ours",
        entries: [{ id: "ours", name: "copilot-env" }, { id: "theirs", name: "Mine" }],
      })
    }\n`,
  );
  new OwnershipLedger().record("claudeDesktop", join(library, "ours.json"));

  await runUninstall({ yes: true }, sandboxRoot());

  expect(existsSync(join(library, "ours.json"))).toBe(false);
  expect(existsSync(join(library, "theirs.json"))).toBe(true);
  const meta = JSON.parse(readFileSync(join(library, "_meta.json"), "utf8")) as {
    appliedId?: string;
    entries: unknown[];
  };
  expect(meta.entries).toEqual([{ id: "theirs", name: "Mine" }]);
  expect(meta.appliedId).toBeUndefined(); // ours was applied; the reference is dropped
});

test("uninstall's dry run and live run land ONE resolved plan", async () => {
  const { proxyHome, claudeHome, codexHome } = tmpHomes();
  mkdirSync(claudeHome, { recursive: true });
  configureClaudeConfig(claudeHome, { credential: COMMAND, mode: "direct", direct: null });
  expect(registerClaudeMcpServer()).toBe(true); // our MCP entry is in .claude.json
  // A named profile with a daemon home, so the profile step has a tree to delete.
  new CopilotEnvState().commitProfile(WORK, {
    credential: { kind: "stored", provider: "gh-token", token: "ghp_work" },
    mode: "direct",
  });
  configureClaudeConfig(claudeHome, {
    credential: COMMAND,
    mode: "direct",
    direct: null,
    profile: WORK,
  });
  // The Codex profile file is a deletion OUTSIDE our homes, so the plan must name it.
  configureCodexConfig(codexHome, {
    credential: COMMAND,
    mode: "direct",
    direct: null,
    profile: WORK,
  });
  mkdirSync(profileHome(WORK), { recursive: true });
  const library = desktopLibrary();
  const rootHome = resolveRootHome();
  mkdirSync(rootHome, { recursive: true });
  const defaultHelper = desktopHelperPath(rootHome, "direct", null);
  const workHelper = desktopHelperPath(rootHome, "direct", WORK);
  mkdirSync(dirname(defaultHelper), { recursive: true });
  writeFileSync(defaultHelper, "#!/bin/sh\n");
  writeFileSync(workHelper, "#!/bin/sh\n");
  const entryFor = (helper: string): string =>
    `${JSON.stringify({ inferenceGatewayBaseUrl: "x", inferenceCredentialHelper: helper })}\n`;
  const metaRows = [{ id: "ours", name: "copilot-env" }, {
    id: "gone",
    name: "copilot-env (work)",
  }];
  writeFileSync(join(library, "ours.json"), entryFor(defaultHelper));
  writeFileSync(join(library, "_meta.json"), `${JSON.stringify({ entries: metaRows })}\n`);
  const ledger = new OwnershipLedger();
  ledger.record("claudeDesktop", join(library, "ours.json"));
  // A stale claim: an owned row whose file is already gone.
  ledger.record("claudeDesktop", join(library, "gone.json"));
  // A float cache recorded OUTSIDE the root home: only the plan can name it.
  const elsewhere = join(dir, "float-elsewhere");
  mkdirSync(elsewhere, { recursive: true });
  writeResolvedVersionRecord(proxyHome, "1.10.30", Date.now(), elsewhere);
  // A wired rc / PowerShell profile on a scratch home, resolved by the REAL shell resolver: the
  // plan must name the concrete file.
  const rcDir = join(dir, "rc");
  process.env[CI_RC_DIR_ENV] = rcDir;
  process.env[CI_PS_DOCUMENTS_DIR_ENV] = rcDir;
  const rc = process.platform === "win32"
    ? shellTargetFiles()[0] as string
    : join(rcDir, ".bashrc");
  mkdirSync(dirname(rc), { recursive: true });
  writeFileSync(rc, `echo mine\n${SHELL_MARKER}\nsource ours\n${MARKER_END}\n`);

  const ctx = resolveUninstallContext({ yes: true }, sandboxRoot());
  expect(ctx.targets.desktop.helpers.sort()).toEqual([defaultHelper, workHelper].sort());
  expect(ctx.targets.desktop.staleClaims).toEqual([join(library, "gone.json")]);
  expect(ctx.targets.shellFiles).toEqual([rc]);
  // The MCP registration file follows CLAUDE_CONFIG_DIR (the isolated home), and holds
  // our entry, so the plan names the rewrite.
  expect(claudeJsonPath()).toBe(join(claudeHome, ".claude.json"));
  expect(ctx.targets.claudeMcpRegistration).toBe(claudeJsonPath());
  const metaPath = join(library, "_meta.json");
  expect(ctx.targets.desktop.metaRewrite).toBe(metaPath);
  expect(ctx.targets.profiles).toEqual([{
    name: WORK,
    claudeArtifacts: [settingsPathFor(claudeHome, WORK)],
  }]);
  // The dry run: the same steps on the overlay, nothing landed, and the shell-restart hint that
  // follows a landed removal is not said.
  let changes: FileChange[] = [];
  const preview = await captureChannels(async () => {
    ({ changes } = await dryRunChanges(() => applyUninstall(ctx)));
  });
  expect(preview.all).not.toContain("Restart");
  const named = new Set(changes.map((c) => c.path));
  expect(readFileSync(rc, "utf8")).toContain(SHELL_MARKER);
  expect(existsSync(join(library, "ours.json"))).toBe(true);
  expect(existsSync(elsewhere)).toBe(true);
  // Planted AFTER planning: a LISTED owned Desktop entry attributed to the profile the
  // profile step deletes. Neither that step nor the Desktop sweep may take a path the
  // dry run never named.
  writeFileSync(join(library, "late.json"), entryFor(workHelper));
  metaRows.push({ id: "late", name: "copilot-env (work, late)" });
  writeFileSync(join(library, "_meta.json"), `${JSON.stringify({ entries: metaRows })}\n`);
  ledger.record("claudeDesktop", join(library, "late.json"));

  deferWriteReports();
  await applyUninstall(ctx);
  const reported = flushWriteReports();
  const deleted = new Set(
    reported
      .filter((line) => line.startsWith("deleted -> "))
      .map((line) => line.slice("deleted -> ".length).replace(/ \(.*\)$/, "")),
  );
  // The block went, the user's own line stayed, and the rewrite was named, once.
  expect(readFileSync(rc, "utf8")).toBe("echo mine\n");
  expect(reported.filter((line) => line.includes(rc))).toEqual([
    `rewritten -> ${rc} (shell integration removed)`,
  ]);
  // The other outside-home REWRITE the sweep performs is named live too, and the dry
  // run named its path (asserted with the deletions below).
  const rewritten = new Set(
    reported
      .filter((line) => line.startsWith("rewritten -> "))
      .map((line) => line.slice("rewritten -> ".length).replace(/ \(.*\)$/, "")),
  );
  expect(rewritten.has(metaPath)).toBe(true);
  // .claude.json was CREATED in this process (the registration above), so the uninstall's
  // rewrite is the same per-process fact and prints no second line: the entry being gone,
  // and the dry run naming the file (below), are the observables.
  expect(
    (JSON.parse(readFileSync(claudeJsonPath(), "utf8")) as Record<string, unknown>).mcpServers,
  ).toBeUndefined();

  expect(existsSync(join(library, "late.json"))).toBe(true);
  expect(existsSync(join(library, "ours.json"))).toBe(false);
  expect(existsSync(elsewhere)).toBe(false);
  // The live row and the stale claim's row went; the late row stayed (the ledger itself
  // lives in the root home the uninstall deleted, so the rows are the observable).
  const meta = JSON.parse(readFileSync(join(library, "_meta.json"), "utf8")) as {
    entries: { id: string }[];
  };
  expect(meta.entries.map((row) => row.id)).toEqual(["late"]);

  // Exact parity, both ways: every path the live run deleted or rewrote outside the data home
  // is a row of the plan, and the plan's rows are paths, so an ancestor is never counted as named.
  expect([...deleted].filter((path) => !named.has(path))).toEqual([]);
  expect([...rewritten].filter((path) => !named.has(path))).toEqual([]);
  expect(named.has(rc)).toBe(true);
  expect(named.has(claudeJsonPath())).toBe(true);
  const workCodexFile = codexProfileConfigPath(codexHome, WORK);
  expect(deleted.has(workCodexFile)).toBe(true);
  expect(named.has(workCodexFile)).toBe(true);
  const planned = [
    ...ctx.targets.desktop.entries,
    ...ctx.targets.desktop.helpers,
    ...ctx.targets.floatArtifacts,
    ...ctx.targets.profiles.flatMap((p) => [...p.claudeArtifacts, profileHome(p.name)]),
    ctx.rootHome,
    ctx.installRoot.root,
  ];
  // Inside the data home the removals are bookkeeping (never named); every planned
  // path outside it, and the home itself, must have been named as deleted.
  const outside = planned.filter((path) => !path.startsWith(ctx.rootHome + sep));
  expect(outside.filter((path) => !deleted.has(path))).toEqual([]);
  expect(outside).toContain(ctx.rootHome);
  // Negative control: the tmp root is a prefix of every named path and is not itself one.
  expect(changes.some((c) => c.path.startsWith(dir + sep))).toBe(true);
  expect(named.has(dir)).toBe(false);
});

test.skipIf(process.platform === "win32")(
  "an rc entry whose block cannot be read refuses the uninstall before anything is removed: a dangling symlink, an unreadable file",
  async () => {
    const { proxyHome } = tmpHomes();
    new Credential().store("gh-token", "ghp_default");
    const rcDir = join(dir, "rc");
    process.env[CI_RC_DIR_ENV] = rcDir;
    mkdirSync(rcDir, { recursive: true });
    const dangling = join(rcDir, ".zshrc");
    const unreadable = join(rcDir, ".bashrc");
    const rows: Array<{ rc: string; stage: () => void; unstage: () => void }> = [
      {
        rc: dangling,
        stage: () => symlinkSync(join(rcDir, "gone"), dangling), // existsSync follows it: "absent"
        unstage: () => rmSync(dangling),
      },
    ];
    // mode 000 stops a user, never root (the container suite).
    if (process.getuid?.() !== 0) {
      rows.push({
        rc: unreadable,
        stage: () => {
          writeFileSync(unreadable, `${SHELL_MARKER}\nsource ours\n${MARKER_END}\n`);
          chmodSync(unreadable, 0o000);
        },
        unstage: () => chmodSync(unreadable, 0o644),
      });
    }
    const root = sandboxRoot();
    for (const { rc, stage, unstage } of rows) {
      stage();
      try {
        await expect(runUninstall({ yes: true }, root)).rejects.toThrow(rc);
        expect(new Credential().resolve(), rc).toBe("ghp_default");
        expect(existsSync(proxyHome), rc).toBe(true);
        expect(existsSync(root.root), rc).toBe(true);
      } finally {
        unstage();
      }
    }
  },
);
