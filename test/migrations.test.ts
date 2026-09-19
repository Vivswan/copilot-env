import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { parse, stringify, TomlDate } from "smol-toml";
import { directHelperCommand, proxyHelperCommand } from "../src/claude/config.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { OwnershipLedger } from "../src/copilot_api/ownership.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import {
  dropLegacyAutoupdateFlag,
  fenceUnfencedBlocks,
  LAUNCHERS_MARKER,
  LAUNCHERS_MARKER_END,
  removeEnvKey,
  rewriteClaudeWiring,
  rewriteLegacyClaudeHelper,
  rewriteLegacyCodexTables,
  v400AutoupdateFlag,
  v400ClaudeWiring,
  v400CodexWiring,
  v400ShellFence,
} from "../src/migrations/4.0.0.ts";
import {
  moveDesktopHelpers,
  moveRootStores,
  pinSoleGhAccount,
  v402DesktopHelpers,
  v402GhAccountPin,
  v402RootLayout,
} from "../src/migrations/4.0.2.ts";
import {
  dropCodexIdentityPin,
  dropSlotIdentityCache,
  foldRootStores,
  moveCodexProfileTables,
  moveProfilesToVerbTree,
  moveRootDaemonHome,
  renameAutoupdateThrottle,
  rewriteDesktopMcpArgv,
  scopeStaticKeyBoolean,
  stripLaunchersBlocks,
  v409CodexProfileFiles,
  v409DesktopMcpArgv,
  v409IdentityCache,
  v409IntegrationIdPin,
  v409LaunchersBlock,
  v409ProfileVerbTree,
  v409RootDaemonHome,
  v409StateFold,
  v409StaticKeyScope,
} from "../src/migrations/4.0.9.ts";
import { dueMigrations, type Migration, runMigrations } from "../src/migrations/index.ts";
import { MARKER, MARKER_END } from "../src/shell/integration.ts";
import { agentAuthGetArgs, agentLauncherCommand, proxyTokenCommand } from "../src/utils/root.ts";
import { writeDesktopHelperScript } from "../src/claude/desktop_helper_scripts.ts";
import { CLAUDE_DESKTOP_DIR_ENV, META_FILENAME } from "../src/claude/desktop_library.ts";
import { mcpServeArgs } from "../src/claude/desktop_payload.ts";
import { claudeJsonPath, inspectMcpRegistration } from "../src/claude/mcp_registration.ts";
import {
  resetIntegrationIdentityCache,
  setIntegrationProbeFetch,
} from "../src/copilot_api/integration_identity.ts";
import { managedProxyProvider } from "../src/codex/config.ts";
import { CopilotEnvRunState } from "../src/copilot_api/run_state.ts";
import { deferWriteReports, flushWriteReports } from "../src/utils/report_write.ts";
import { renderDryRun } from "../src/utils/dry_run_report.ts";
import { captureChannels } from "./helpers/output.ts";
import { runCli } from "./helpers/run.ts";
import { consola } from "consola";
import type { SemverString } from "../src/utils/semver.ts";
import { afterEach, expect, tempDir, test } from "./helpers/testing.ts";
import { envSnapshot, isolateAgentHomes, isolateProxyHome } from "./helpers/env.ts";
import { writeRunState } from "./helpers/fixtures.ts";
import { dryRunChanges, fingerprintTree } from "./helpers/dry_run.ts";

// A synthetic registry: the real migrations' side effects never run here.
const mig = (version: SemverString): Migration => ({
  version,
  description: version,
  run: () => {},
});
const LIST = [mig("1.2.1"), mig("1.2.5"), mig("1.3.0")];
const WORK = parseProfileName("work");
const OTHER = parseProfileName("other");

const restoreEnv = envSnapshot();
let dir = "";

/** state.json written and read raw (fixtures the typed API cannot produce). */
function writeStore(file: string, doc: unknown): void {
  writeFileSync(file, `${JSON.stringify(doc)}\n`);
}

function readStore(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

afterEach(() => {
  restoreEnv();
});

test("dueMigrations selects [from, to) in ascending order over the registry", () => {
  const cases: { from: string; to: string; expected: string[] }[] = [
    { from: "1.2.1", to: "1.3.0", expected: ["1.2.1", "1.2.5"] }, // ascending [from, to)
    { from: "1.2.5", to: "1.3.0", expected: ["1.2.5"] }, // from included, to excluded
    { from: "1.2.5", to: "3.0.0", expected: ["1.2.5", "1.3.0"] }, // 1.2.1 already left behind never re-runs
    { from: "1.3.0", to: "1.3.0", expected: [] }, // already up to date: nothing due
    { from: "v1.2.1", to: "v1.3.0", expected: ["1.2.1", "1.2.5"] }, // leading v tolerated on either bound
  ];
  for (const { from, to, expected } of cases) {
    // The bounds ride along in the asserted value so a red run names the failing row.
    expect({ from, to, due: dueMigrations(from, to, LIST).map((m) => m.version) }).toEqual({
      from,
      to,
      due: expected,
    });
  }
});

test("the shipped registry holds exactly the named fix-ups in order, layout steps first", () => {
  // Pinned BY IDENTITY and in order: a count or a list of version strings could stay green while a
  // same-version fix-up was dropped in a merge. Each position has a reason:
  //   layout steps first (store rename, the state.json fold, the root daemon home, the Desktop MCP
  //   argv)                                              -> later steps read stores at the new paths,
  //                                                         through the new preference shape, and
  //                                                         the Desktop entries through the new reader
  //   Desktop helper move, then the Codex profile files  -> each needs the 4.0.0 rewrites done
  expect(dueMigrations("0.0.1", "999.0.0")).toEqual([
    v402RootLayout,
    v409StateFold,
    v409RootDaemonHome,
    v409DesktopMcpArgv,
    v400ShellFence,
    v400CodexWiring,
    v400ClaudeWiring,
    v400AutoupdateFlag,
    v402GhAccountPin,
    v402DesktopHelpers,
    v409CodexProfileFiles,
    v409IntegrationIdPin,
    v409StaticKeyScope,
    v409IdentityCache,
    v409LaunchersBlock,
    v409ProfileVerbTree,
  ]);
  // A 4.0.0 install gets every wiring rewrite on its way to the next release.
  expect(dueMigrations("4.0.0", "4.0.1")).toEqual([
    v400ShellFence,
    v400CodexWiring,
    v400ClaudeWiring,
    v400AutoupdateFlag,
  ]);
});

test("4.0.2 gh pin: sole-account machines pin every pin-less gh-cli slot; anything else is left alone", () => {
  dir = isolateProxyHome("copilot-migrate-pin-");
  const state = new CopilotEnvState();
  const solo = {
    accounts: [{ host: "github.com", login: "octocat", active: true, source: "keyring" }],
  };
  state.setCredential(null, { kind: "gh-cli", ghUser: null });
  state.commitProfile(WORK, { credential: { kind: "gh-cli", ghUser: null }, mode: "direct" });
  state.commitProfile(OTHER, { credential: { kind: "gh-cli", ghUser: "kept" }, mode: "proxy" });
  const resolvable: string[] = [];
  pinSoleGhAccount(() => solo, (login) => {
    resolvable.push(login);
    return true;
  });
  expect(resolvable).toEqual(["octocat"]);
  expect(state.readCredential(null)).toEqual({ kind: "gh-cli", ghUser: "octocat" });
  expect(state.readCredential(WORK)).toEqual({ kind: "gh-cli", ghUser: "octocat" });
  expect(state.readCredential(OTHER)).toEqual({ kind: "gh-cli", ghUser: "kept" });
  pinSoleGhAccount(() => {
    throw new Error("nothing left to pin - the look must not run");
  });

  // A sole login gh cannot serve pinned (an env-only GH_TOKEN: `gh auth token --user` finds no
  // saved credential) is never pinned: the pin would break a working auto slot.
  state.setCredential(null, { kind: "gh-cli", ghUser: null });
  pinSoleGhAccount(() => solo, () => false);
  expect(state.readCredential(null)).toEqual({ kind: "gh-cli", ghUser: null });

  // Multiple accounts, or an unproven look: only the user can choose whose Copilot credit to spend.
  // A BROKEN entry still counts: a broken active login is never abandoned for a healthy bystander,
  // and a login seen only broken could never verify its pin.
  state.setCredential(null, { kind: "gh-cli", ghUser: null });
  pinSoleGhAccount(() => ({
    accounts: [
      { host: "github.com", login: "a", active: true, source: "keyring" },
      { host: "github.com", login: "b", active: false, source: "keyring" },
    ],
  }));
  expect(state.readCredential(null)).toEqual({ kind: "gh-cli", ghUser: null });
  pinSoleGhAccount(() => ({
    accounts: [
      { host: "github.com", login: "healthy", active: false, source: "keyring" },
      { host: "github.com", login: "hurt", active: true, source: "keyring", broken: true },
    ],
  }), () => true);
  expect(state.readCredential(null)).toEqual({ kind: "gh-cli", ghUser: null });
  pinSoleGhAccount(() => ({
    accounts: [
      { host: "github.com", login: "hurt", active: true, source: "keyring", broken: true },
    ],
  }), () => true);
  expect(state.readCredential(null)).toEqual({ kind: "gh-cli", ghUser: null });
  pinSoleGhAccount(() => ({ accounts: [], unproven: true }));
  expect(state.readCredential(null)).toEqual({ kind: "gh-cli", ghUser: null });
});

test("4.0.2 root layout: stores rename, lock debris clears, loose helpers regenerate via the wiring", async () => {
  dir = isolateProxyHome("copilot-migrate-layout-");
  writeFileSync(join(dir, ".copilot-env-state.json"), `${JSON.stringify({ profiles: {} })}\n`);
  writeFileSync(join(dir, ".copilot-env-config.json"), `${JSON.stringify({ port: 4199 })}\n`);
  writeFileSync(join(dir, ".copilot-env-state.json.lock.oslock"), "");
  writeFileSync(join(dir, ".copilot-env-ownership.json.ops.lock.oslock"), "");
  writeFileSync(join(dir, ".profile-ports.lock.oslock"), "");
  writeFileSync(join(dir, "github_token.login.lock.oslock"), "");
  writeFileSync(join(dir, "claude-desktop-token.sh"), "#!/bin/sh\n");
  writeFileSync(join(dir, "claude-desktop-proxy-token-work.cmd"), "@echo off\n");
  writeFileSync(join(dir, "claude-desktop-token.sh.bak"), "not ours\n");
  // Lookalikes the generator can never produce (reserved `default` suffix, a
  // dotted infix): the sweep classifies by desktopHelperScriptWiring, so they
  // survive like any neighbour's file.
  writeFileSync(join(dir, "claude-desktop-token-default.sh"), "not ours\n");
  writeFileSync(join(dir, "claude-desktop-token-work.bak.sh"), "not ours\n");
  let reconciled = 0;
  const pass = () => {
    reconciled++;
    return Promise.resolve();
  };
  const none = () => new Set<string>();
  moveRootStores(dir);
  // A WIRED Desktop whose pass rewired every entry to helpers/: nothing
  // references the loose helpers anymore, so they go after ONE pass.
  await moveDesktopHelpers(dir, pass, () => true, none);
  expect(readFileSync(join(dir, "credentials.json"), "utf8")).toBe(
    `${JSON.stringify({ profiles: {} })}\n`,
  );
  expect(readFileSync(join(dir, "preferences.json"), "utf8")).toBe(
    `${JSON.stringify({ port: 4199 })}\n`,
  );
  for (
    const gone of [
      ".copilot-env-state.json",
      ".copilot-env-config.json",
      ".copilot-env-state.json.lock.oslock",
      ".copilot-env-ownership.json.ops.lock.oslock",
      ".profile-ports.lock.oslock",
      "github_token.login.lock.oslock",
      "claude-desktop-token.sh",
      "claude-desktop-proxy-token-work.cmd",
    ]
  ) expect(existsSync(join(dir, gone))).toBe(false);
  expect(existsSync(join(dir, "claude-desktop-token.sh.bak"))).toBe(true);
  expect(existsSync(join(dir, "claude-desktop-token-default.sh"))).toBe(true);
  expect(existsSync(join(dir, "claude-desktop-token-work.bak.sh"))).toBe(true);
  expect(reconciled).toBe(1);

  // Idempotent: the wiring pass is not re-run.
  moveRootStores(dir);
  await moveDesktopHelpers(dir, pass, () => true, none);
  expect(reconciled).toBe(1);
  expect(readFileSync(join(dir, "preferences.json"), "utf8")).toBe(
    `${JSON.stringify({ port: 4199 })}\n`,
  );

  // A helper a Desktop entry STILL references (the pass could not rewire it: blocked metadata, a
  // failed entry save) is kept so the entry keeps working; a later run finishes the move.
  const helper = join(dir, "claude-desktop-token.sh");
  writeFileSync(helper, "#!/bin/sh\n");
  await moveDesktopHelpers(dir, () => Promise.resolve(), () => true, () => new Set([helper]));
  expect(existsSync(helper)).toBe(true);
  await moveDesktopHelpers(dir, pass, () => true, none);
  expect(existsSync(helper)).toBe(false);

  // The wiring key OFF preserves the default entry (the removeUnmanaged
  // contract): its still-referenced helper survives WITHOUT any wiring pass,
  // while an unreferenced one goes.
  writeFileSync(helper, "#!/bin/sh\n");
  writeFileSync(join(dir, "claude-desktop-proxy-token-work.cmd"), "@echo off\n");
  await moveDesktopHelpers(
    dir,
    () => {
      throw new Error("wiring off - no pass");
    },
    () => false,
    () => new Set([helper]),
  );
  expect(existsSync(helper)).toBe(true);
  expect(existsSync(join(dir, "claude-desktop-proxy-token-work.cmd"))).toBe(false);
  rmSync(helper);

  // The REAL reference scanner (no `referenced` stub): the ownership ledger
  // names the entry document, whose inferenceCredentialHelper is the reference.
  const entryPath = join(dir, "desktop-entry.json");
  new OwnershipLedger().record("claudeDesktop", entryPath);
  writeFileSync(helper, "#!/bin/sh\n");
  writeFileSync(entryPath, `${JSON.stringify({ inferenceCredentialHelper: helper })}\n`);
  await moveDesktopHelpers(dir, () => Promise.resolve(), () => false);
  expect(existsSync(helper)).toBe(true);
  // Once the entry points under helpers/, the loose helper is unreferenced.
  writeFileSync(
    entryPath,
    `${
      JSON.stringify({
        inferenceCredentialHelper: join(dir, "helpers", "claude-desktop-token.sh"),
      })
    }\n`,
  );
  await moveDesktopHelpers(dir, () => Promise.resolve(), () => false);
  expect(existsSync(helper)).toBe(false);

  // A NEW-name store never gets clobbered by a lingering old one (mixed-version
  // window): the old file survives for the user to inspect, the new one wins.
  writeFileSync(join(dir, ".copilot-env-config.json"), `${JSON.stringify({ port: 1 })}\n`);
  moveRootStores(dir);
  expect(readFileSync(join(dir, "preferences.json"), "utf8")).toBe(
    `${JSON.stringify({ port: 4199 })}\n`,
  );
  expect(existsSync(join(dir, ".copilot-env-config.json"))).toBe(true);
});

// --- the 4.0.0 wiring rewrites (pure cores; no real home touched) -----------------

test("fenceUnfencedBlocks fences the 3.5.6 rc blocks and leaves everything else alone", () => {
  const main = `${MARKER}\nAGENTS_BASHRC="/x/shell/agents.bashrc"\n` +
    `[ -f "$AGENTS_BASHRC" ] && source "$AGENTS_BASHRC"`;
  const launchers = `${LAUNCHERS_MARKER}\nAGENTS_LAUNCHERS="/x/l.bashrc"\n` +
    `[ -f "$AGENTS_LAUNCHERS" ] && source "$AGENTS_LAUNCHERS"`;
  const rc = `export KEEP=1\n\n${main}\n\n${launchers}\nexport AFTER=1\n`;
  expect(fenceUnfencedBlocks(rc)).toBe(
    `export KEEP=1\n\n${main}\n${MARKER_END}\n\n${launchers}\n${LAUNCHERS_MARKER_END}\nexport AFTER=1\n`,
  );
  expect(fenceUnfencedBlocks(fenceUnfencedBlocks(rc))).toBe(fenceUnfencedBlocks(rc));
  // A lookalike in the guard position (the user's own assignment) is not the pair:
  // nothing is fenced, nothing is touched.
  const lookalike = `${MARKER}\nAGENTS_BASHRC="/x/agents.bashrc"\nAGENTS_BASHRC=/user-owned\n`;
  expect(fenceUnfencedBlocks(lookalike)).toBe(lookalike);
  // The PowerShell pair, CRLF: the fence adopts the file's line ending.
  const ps = `${MARKER}\r\n$AgentsPs1 = "C:\\x\\agents.ps1"\r\n` +
    `if (Test-Path $AgentsPs1) { . $AgentsPs1 }\r\nWrite-Host after\r\n`;
  expect(fenceUnfencedBlocks(ps)).toBe(
    `${MARKER}\r\n$AgentsPs1 = "C:\\x\\agents.ps1"\r\n` +
      `if (Test-Path $AgentsPs1) { . $AgentsPs1 }\r\n${MARKER_END}\r\nWrite-Host after\r\n`,
  );
});

test("4.0.9 launchers block: stripped whole with its blanks, bounded like the shell writer's blocks", () => {
  const main = `${MARKER}\nAGENTS_BASHRC="/x/shell/agents.bashrc"\n` +
    `[ -f "$AGENTS_BASHRC" ] && source "$AGENTS_BASHRC"\n${MARKER_END}`;
  const block = `${LAUNCHERS_MARKER}\nAGENTS_LAUNCHERS="/x/l.bashrc"\n` +
    `[ -f "$AGENTS_LAUNCHERS" ] && source "$AGENTS_LAUNCHERS"\n${LAUNCHERS_MARKER_END}`;
  // The shipped adjacency (main block, launchers block, the user's line): the block goes with the
  // blank before it and the ONE blank after its end fence; the main block and the user line stay.
  const rc = `export A=1\n\n${main}\n\n${block}\n\nexport B=1\n`;
  const once = stripLaunchersBlocks(rc);
  expect(once).toEqual({ content: `export A=1\n\n${main}\nexport B=1\n`, leftBehind: [] });
  expect(stripLaunchersBlocks(once.content)).toEqual(once);
  // The lone final "" is the file terminator, never the owned blank: the final newline survives.
  expect(stripLaunchersBlocks(`before\n${block}\n`).content).toBe("before\n");
  // An unclosed marker owns only its own line; the user line under it is reported, not eaten,
  // and the search never borrows the end fence of a later block or crosses the main block.
  const unclosed = `${LAUNCHERS_MARKER}\nexport KEEP=1\n\n${block}\nexport AFTER=1\n`;
  expect(stripLaunchersBlocks(unclosed)).toEqual({
    content: "export KEEP=1\nexport AFTER=1\n",
    leftBehind: ["export KEEP=1"],
  });
  const crossing = `${LAUNCHERS_MARKER}\n${main}\n${LAUNCHERS_MARKER_END}\n`;
  expect(stripLaunchersBlocks(crossing)).toEqual({
    content: `${main}\n${LAUNCHERS_MARKER_END}\n`,
    leftBehind: [],
  });
  // CRLF: the CR rides along with each stripped line; nothing else changes.
  const crlf = `Write-Host before\r\n\r\n${block.replaceAll("\n", "\r\n")}\r\n`;
  expect(stripLaunchersBlocks(crlf).content).toBe("Write-Host before\r\n");
});

test("rewriteLegacyCodexTables moves the 3.5.6 tables to the managed auth block", () => {
  // The 3.5.6 auth block on each platform (the src/scripts forwarder at some root).
  const scriptAuth = { "command": "/bin/sh", "args": ["/r/src/scripts/proxy-token.sh", "--yes"] };
  const scriptAuthWin = {
    "command": "powershell",
    "args": [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "C:\\r\\src\\scripts\\proxy-token.ps1",
      "--yes",
      "--profile",
      "win",
    ],
  };
  const doc = parse(stringify({
    "model_provider": "copilot-env",
    "model_providers": {
      // The 3.5.6 default table: the script forwarder as auth.command.
      "copilot-env": {
        "name": "copilot-env",
        "base_url": "http://localhost:4141/v1",
        "user_extra": "kept",
        "auth": scriptAuth,
      },
      "copilot-env-win": { "base_url": "http://localhost:4250/v1", "auth": scriptAuthWin },
      // Not the 3.5.6 argv: a resolver addressed at ANOTHER profile, or carrying an
      // extra argument. Left alone.
      "copilot-env-other": {
        "base_url": "http://localhost:4260/v1",
        "auth": { "command": "/bin/sh", "args": [...scriptAuth.args, "--profile", "work"] },
      },
      "copilot-env-extra": {
        "base_url": "http://localhost:4270/v1",
        "auth": { "command": "/bin/sh", "args": [...scriptAuth.args, "--verbose"] },
      },
      // A managed table whose auth merely mentions a same-named script elsewhere is
      // not the 3.5.6 shape: left alone (the only change is its stray env_key).
      "copilot-env-mine": {
        "base_url": "http://localhost:4300/v1",
        "auth": { "command": "/usr/local/bin/wrap", "args": ["/opt/x/proxy-token.sh", "--yes"] },
      },
      // A named profile still on the env_key wiring older still.
      "copilot-env-work": { "base_url": "http://localhost:4200/v1", "env_key": "OPENAI_API_KEY" },
      // A direct-era table: the baked env_key goes, nothing else is invented.
      "copilot-env-old": {
        "base_url": "https://api.githubcopilot.com",
        "env_key": "COPILOT_ENV_GH_TOKEN",
      },
      // Foreign tables are never touched.
      "other": { "base_url": "http://other/v1", "env_key": "OTHER_KEY" },
    },
  }));
  expect(rewriteLegacyCodexTables(doc)).toBe(true);
  const providers = doc.model_providers as Record<string, Record<string, unknown>>;
  const main = providers["copilot-env"]!;
  expect(main.base_url).toBe("http://localhost:4141/v1");
  expect(main.user_extra).toBe("kept");
  expect((main.auth as Record<string, unknown>).command).toBe(proxyTokenCommand().command);
  expect((main.auth as Record<string, unknown>).args).toEqual(proxyTokenCommand().args);
  const work = providers["copilot-env-work"]!;
  expect(work.env_key).toBeUndefined();
  expect((work.auth as Record<string, unknown>).args).toEqual(proxyTokenCommand(WORK).args);
  expect((providers["copilot-env-win"]!.auth as Record<string, unknown>).args).toEqual(
    proxyTokenCommand(parseProfileName("win")).args,
  );
  expect(providers["copilot-env-old"]).toEqual({ "base_url": "https://api.githubcopilot.com" });
  expect((providers["copilot-env-mine"]!.auth as Record<string, unknown>).command).toBe(
    "/usr/local/bin/wrap",
  );
  for (const id of ["copilot-env-other", "copilot-env-extra"]) {
    expect((providers[id]!.auth as Record<string, unknown>).command, id).toBe("/bin/sh");
  }
  expect(providers.other).toEqual({ "base_url": "http://other/v1", "env_key": "OTHER_KEY" });
  // Converged: a second pass changes nothing.
  expect(rewriteLegacyCodexTables(doc)).toBe(false);
});

test("a file that cannot be converted fails the step; the other files still convert", () => {
  dir = tempDir("copilot-mig-claude-fail-");
  process.env.CLAUDE_CONFIG_DIR = dir;
  const ext = process.platform === "win32" ? "cmd" : "sh";
  // The default profile: a released helper body, convertible.
  const direct = join(dir, `copilot-token.${ext}`);
  writeFileSync(
    direct,
    process.platform === "win32"
      ? '@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "C:\\r\\bin\\agent.ps1" auth --get\r\n'
      : "#!/bin/sh\nexec '/r/bin/agent' 'auth' '--get'\n",
  );
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ apiKeyHelper: direct }));
  // The work profile: its helper path is a DIRECTORY, so the body read fails (not absent).
  const workHelper = join(dir, `copilot-token-work.${ext}`);
  mkdirSync(workHelper);
  writeFileSync(join(dir, "settings-work.json"), JSON.stringify({ apiKeyHelper: workHelper }));

  expect(() => rewriteClaudeWiring()).toThrow(join(dir, "settings-work.json"));
  expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).apiKeyHelper).toBe(
    directHelperCommand(),
  );
  expect(existsSync(direct)).toBe(false);
  expect(JSON.parse(readFileSync(join(dir, "settings-work.json"), "utf8")).apiKeyHelper).toBe(
    workHelper,
  );
});

test("removeEnvKey drops every assignment of the key and nothing else", () => {
  dir = tempDir("copilot-mig-env-");
  const env = join(dir, ".env");
  writeFileSync(
    env,
    "# mine\nFOO=bar\nCOPILOT_ENV_GH_TOKEN=ghp_a\nexport COPILOT_ENV_GH_TOKEN=ghp_b\nOPENAI_API_KEY=user\n",
  );
  expect(removeEnvKey(env, "COPILOT_ENV_GH_TOKEN")).toBe(true);
  expect(readFileSync(env, "utf8")).toBe("# mine\nFOO=bar\nOPENAI_API_KEY=user\n");
  expect(removeEnvKey(env, "COPILOT_ENV_GH_TOKEN")).toBe(false); // nothing left: no rewrite
  expect(removeEnvKey(join(dir, "absent.env"), "COPILOT_ENV_GH_TOKEN")).toBe(false);
  expect(existsSync(join(dir, "absent.env"))).toBe(false);
});

test("rewriteLegacyClaudeHelper inlines a released helper body and removes the file", () => {
  dir = tempDir("copilot-mig-claude-");
  const win = process.platform === "win32";
  const ext = win ? "cmd" : "sh";
  // The v3.5.6 renderings from tag history, at a root that is not this checkout.
  const directBody = win
    ? '@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "C:\\other root\\bin\\agent.ps1" auth --get\r\n'
    : "#!/bin/sh\nexec '/other root/bin/agent' 'auth' '--get'\n";
  const workProxyBody = win
    ? '@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "C:\\other root\\src\\scripts\\proxy-token.ps1" --yes --profile work\r\n'
    : "#!/bin/sh\nexec '/other root/src/scripts/proxy-token.sh' '--yes' '--profile' 'work'\n";
  const direct = join(dir, `copilot-token.${ext}`);
  writeFileSync(direct, directBody);
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ apiKeyHelper: direct, model: "opus" }),
  );
  const workProxy = join(dir, `copilot-proxy-token-work.${ext}`);
  writeFileSync(workProxy, workProxyBody);
  writeFileSync(join(dir, "settings-work.json"), JSON.stringify({ apiKeyHelper: workProxy }));

  expect(rewriteLegacyClaudeHelper(dir, null)).toBe(true);
  expect(rewriteLegacyClaudeHelper(dir, WORK)).toBe(true);
  const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  expect(settings).toEqual({ apiKeyHelper: directHelperCommand(), model: "opus" });
  expect(existsSync(direct)).toBe(false);
  const work = JSON.parse(readFileSync(join(dir, "settings-work.json"), "utf8"));
  expect(work.apiKeyHelper).toBe(proxyHelperCommand(WORK));
  expect(existsSync(workProxy)).toBe(false);
  // Converged: the inline command is not a helper path.
  expect(rewriteLegacyClaudeHelper(dir, null)).toBe(false);

  // Near misses at our name are the user's: untouched, settings included. Bodies that only MENTION
  // the resolver, carry a trailing command, address another profile, use the pre-v3.3.5
  // `gh auth token` helper, wear the OTHER platform's frame, or use the proxy body only unreleased
  // mains wrote.
  const nearMisses = win
    ? [
      '@echo off\r\npowershell -File "C:\\r\\bin\\agent.ps1" auth --get\r\n',
      '@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "C:\\r\\bin\\agent.ps1" auth --get --profile work\r\n',
      "@echo off\r\ngh auth token\r\n",
      "#!/bin/sh\nexec '/r/bin/agent' 'auth' '--get'\n",
    ]
    : [
      "#!/bin/sh\n# runs agent auth --get\nexec my-resolver\n",
      "#!/bin/sh\nexec '/r/bin/agent' 'auth' '--get' ; evil\n",
      "#!/bin/sh\nexec '/r/bin/agent' 'auth' '--get' '--profile' 'work'\n",
      "#!/bin/sh\nexec gh auth token\n",
      '@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "C:\\r\\bin\\agent.ps1" auth --get\r\n',
    ];
  const proxyNearMisses = win
    ? [
      '@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "C:\\r\\bin\\agent.ps1" proxy-token --yes\r\n',
    ]
    : ["#!/bin/sh\nexec '/r/bin/agent' 'proxy-token' '--yes'\n"];
  const proxy = join(dir, `copilot-proxy-token.${ext}`);
  for (
    const [file, body] of [
      ...nearMisses.map((b) => [direct, b] as const),
      ...proxyNearMisses.map((b) => [proxy, b] as const),
    ]
  ) {
    writeFileSync(file, body);
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ apiKeyHelper: file }));
    expect(rewriteLegacyClaudeHelper(dir, null), body).toBe(false);
    expect(existsSync(file), body).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).apiKeyHelper, body)
      .toBe(file);
  }
});

test("dropLegacyAutoupdateFlag removes only the retired field, once; an absent file stays absent", () => {
  dir = tempDir("copilot-mig-autoupdate-");
  const file = join(dir, "state.json");
  expect(dropLegacyAutoupdateFlag(file)).toBe(false);
  expect(existsSync(file)).toBe(false);
  writeFileSync(file, JSON.stringify({ enabled: true, lastCheckMs: 5, lastResult: "old" }));
  expect(dropLegacyAutoupdateFlag(file)).toBe(true);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ lastCheckMs: 5, lastResult: "old" });
  expect(dropLegacyAutoupdateFlag(file)).toBe(false); // nothing left to drop: no rewrite
});

test("equal-version fix-ups keep their registry order across the sort", () => {
  const first = { ...mig("1.2.5"), description: "first" };
  const second = { ...mig("1.2.5"), description: "second" };
  expect(dueMigrations("1.0.0", "2.0.0", [first, second]).map((m) => m.description)).toEqual([
    "first",
    "second",
  ]);
});

test("an unparseable registry version throws instead of silently never running", () => {
  // SemverString admits "1.2.3-", which toSemverString rejects; a registry entry the range filter
  // cannot see is a migration that never fires, so the guard names the offender.
  const bad = [mig("1.2.1"), { ...mig("1.2.5"), version: "1.2.3-" as SemverString }];
  expect(() => dueMigrations("1.0.0", "2.0.0", bad)).toThrow(
    'registry version (1.2.5) "1.2.3-" is not a semver version',
  );
});

test("an unparseable from or to bound throws instead of selecting the wrong migrations", () => {
  // A garbage `to` would otherwise select [] (no migration runs); a garbage `from`
  // would select everything below `to` -- both silent, both wrong.
  expect(() => dueMigrations("1.0.0", "oops", LIST)).toThrow(
    'to version "oops" is not a semver version',
  );
  expect(() => dueMigrations("oops", "2.0.0", LIST)).toThrow(
    'from version "oops" is not a semver version',
  );
});

test("runMigrations is best-effort: a failing step never stops the rest", async () => {
  const ran: string[] = [];
  const steps: Migration[] = [
    { version: "1.0.0", description: "ok", run: () => void ran.push("first") },
    {
      version: "1.1.0",
      description: "boom",
      run: () => {
        throw new Error("migration exploded");
      },
    },
    { version: "1.2.0", description: "ok", run: () => void ran.push("third") },
  ];
  // A migration hiccup must never abort an otherwise-successful update, and runMigrations itself
  // must not reject.
  await runMigrations("1.0.0", "2.0.0", steps);
  expect(ran).toEqual(["first", "third"]);
});

// --- 4.0.9: Codex named profiles -----------------------------------------------------

/** consola's lines at `level` for the span of `run`, restored after; the fix-ups report what they
 *  left and what they dropped. */
function captureConsola(level: "warn" | "info"): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = consola[level];
  consola[level] = ((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  }) as typeof consola.warn;
  return { lines, restore: () => void (consola[level] = original) };
}

function warningsDuring(run: () => void, level: "warn" | "info" = "warn"): string[] {
  const captured = captureConsola(level);
  try {
    run();
  } finally {
    captured.restore();
  }
  return captured.lines;
}

test("4.0.9 fold of a flat preferences.json: the camelCase keys land grouped, the four profile keys in every profile's map", () => {
  // Readers know only the grouped shape, so an un-migrated store would read as empty: every key
  // moves verbatim as it folds, and the 4.0.9 value fix-ups that follow judge it at the new place.
  const home = isolateProxyHome("copilot-mig-prefs-groups-");
  dir = home;
  writeStore(join(home, "preferences.json"), {
    autoStart: true,
    port: 4199,
    smallModel: "gpt-5",
    useResponsesApiContextManagement: true,
    codexHome: "/srv/codex",
    wireMcp: false,
    integrationId: "copilot-developer-cli",
    copilotHost: "https://copilot-api.ghe.example",
    passthrough: "on",
    staticKey: true,
  });
  // Two named profiles read the global profile keys before: each keeps reading them, from its own
  // map, beside its credential slot.
  const slot = (name: string) => ({
    githubToken: `ghp_${name}`,
    authProvider: "gh-token",
    mode: "direct",
  });
  writeStore(join(home, "credentials.json"), {
    profiles: { work: slot("work"), home: slot("home") },
    codexCatalogLastAttemptMs: 5,
  });
  expect(warningsDuring(() => foldRootStores(home), "info")).toHaveLength(2);
  const moved = {
    identity: "copilot-developer-cli",
    host: "https://copilot-api.ghe.example",
    passthrough: "on",
    "static-key": true,
  };
  const after = {
    global: {
      codexCatalogLastAttemptMs: 5,
      "daemon.auto-start": true,
      "daemon.port": 4199,
      "proxy.small-model": "gpt-5",
      "proxy.responses.context-management": true,
      "codex.home": "/srv/codex",
      "claude.wire-mcp": false,
    },
    profiles: {
      default: moved,
      work: { ...slot("work"), ...moved },
      home: { ...slot("home"), ...moved },
    },
  };
  const stateFile = join(home, "state.json");
  expect(readStore(stateFile)).toEqual(after);
  // The readers see the moved values through the precedence rule, each picking its own keys.
  const config = new CopilotEnvConfig();
  expect(config.defaultPort()).toBe(4199);
  expect(config.pinnedIntegrationId(null)).toBe("copilot-developer-cli");
  expect(config.copilotHost(null)).toBe("https://copilot-api.ghe.example");
  expect(config.copilotHost(parseProfileName("work"))).toBe("https://copilot-api.ghe.example");
  expect(new CopilotEnvState().readProfileSlot(parseProfileName("home")).mode).toBe("direct");
  // Idempotent: nothing left to fold, nothing said.
  expect(warningsDuring(() => foldRootStores(home), "info")).toEqual([]);
  expect(readStore(stateFile)).toEqual(after);
  // The value fix-up that follows judges EVERY map the copy wrote, not the default's alone: the
  // boolean becomes the scope for all three profiles.
  expect(warningsDuring(scopeStaticKeyBoolean, "info")).toHaveLength(3);
  for (const profile of [null, parseProfileName("work"), parseProfileName("home")]) {
    expect(config.staticKeyScope(profile)).toBe("all");
  }
});

test("4.0.9 identity: a stored `codex` pin is dropped and said so; any other value stays", () => {
  // The domain refused `codex` only from #228 on; a pin stored before then reads as unset but
  // would sit in the settings section forever, and its baked header outlives it until a rewire.
  const home = isolateProxyHome("copilot-mig-identity-pin-");
  dir = home;
  const prefs = join(home, "state.json");
  const cases: { stored: string | undefined; after: string | undefined; said: boolean }[] = [
    { stored: "codex", after: undefined, said: true },
    { stored: "Codex ", after: undefined, said: true },
    { stored: "copilot-developer-cli", after: "copilot-developer-cli", said: false },
    { stored: undefined, after: undefined, said: false },
  ];
  const shape = (identity: string | undefined) => ({
    global: { "daemon.port": 4199 },
    profiles: identity === undefined ? {} : { default: { identity } },
  });
  for (const { stored, after, said } of cases) {
    writeStore(prefs, shape(stored));
    const lines = warningsDuring(dropCodexIdentityPin, "info");
    const raw = readStore(prefs);
    expect({ stored, raw, said: lines.length }).toEqual({
      stored,
      raw: shape(after),
      said: said ? 1 : 0,
    });
    if (said) expect(lines[0]).toContain("agent init");
  }
});

test("4.0.9 static-key: a stored boolean becomes the scope it meant, said once; a scope or nothing stays quiet", () => {
  // The key became a scope; a boolean left in the settings section fails the domain and reads as
  // `none`, so an install that baked both agents would silently stop baking at its next wiring.
  const home = isolateProxyHome("copilot-mig-static-key-");
  dir = home;
  const prefs = join(home, "state.json");
  const cases: { stored: unknown; after: string | undefined; said: boolean }[] = [
    { stored: true, after: "all", said: true },
    { stored: false, after: undefined, said: true },
    { stored: "claude", after: "claude", said: false },
    { stored: undefined, after: undefined, said: false },
  ];
  const shape = (staticKey: unknown) => ({
    global: { "daemon.port": 4199 },
    profiles: staticKey === undefined ? {} : { default: { "static-key": staticKey } },
  });
  for (const { stored, after, said } of cases) {
    writeStore(prefs, shape(stored));
    const lines = warningsDuring(scopeStaticKeyBoolean, "info");
    const raw = readStore(prefs);
    expect({ stored, raw, said: lines.length }).toEqual({
      stored,
      raw: shape(after),
      said: said ? 1 : 0,
    });
    // Idempotent: the mapped store is a scope or absent, so a re-run has nothing to say.
    expect(warningsDuring(scopeStaticKeyBoolean, "info")).toEqual([]);
  }
});

test("4.0.9 codex profiles: an owned [profiles.<name>] table becomes <name>.config.toml; foreign ones are reported, not moved", () => {
  // Codex 0.153 refuses `codex --profile work` on a [profiles.work] table (and every launch on a
  // top-level `profile` key), so what 4.0.9 wrote must move; what the user wrote is theirs.
  dir = tempDir("copilot-mig-codex-profiles-");
  const configPath = join(dir, "config.toml");
  writeFileSync(
    configPath,
    stringify({
      "model_provider": "copilot-env",
      "profile": "theirs",
      "model_providers": {
        "copilot-env-work": { "base_url": "http://localhost:4545/v1" },
        "copilot-env-fast": { "base_url": "https://api.githubcopilot.com" },
      },
      "profiles": {
        // Ours, with a model pin the user added to the table: the pin rides along.
        "work": { "model_provider": "copilot-env-work", "model": "gpt-5.4" },
        // Ours, and the user already made a work-alike file by hand: its leaves win, the table's
        // other nested keys survive (Codex layers the two the same way), the selector stays ours.
        "fast": {
          "model_provider": "copilot-env-fast",
          "model": "from-table",
          "features": { "multi_agent": true, "shell_tool": true },
          // A date-time scalar on both sides: a leaf, never recursed into as a table.
          "stamp": new TomlDate("2025-01-01T00:00:00Z"),
        },
        // Not ours (a foreign provider, a misaddressed one, a name copilot-env never mints):
        // left, reported.
        "theirs": { "model_provider": "openai" },
        "wrong": { "model_provider": "copilot-env-work" },
        "personal_dev": { "model_provider": "copilot-env-personal_dev" },
      },
    }),
  );
  writeFileSync(
    join(dir, "fast.config.toml"),
    stringify({
      "model": "from-file",
      "model_provider": "x",
      "features": { "shell_tool": false },
      "stamp": new TomlDate("2026-01-01T00:00:00Z"),
    }),
  );

  const warnings = warningsDuring(() => moveCodexProfileTables(dir));

  const config = parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  expect(config.profiles).toEqual({
    "theirs": { "model_provider": "openai" },
    "wrong": { "model_provider": "copilot-env-work" },
    "personal_dev": { "model_provider": "copilot-env-personal_dev" },
  });
  expect(config.profile).toBe("theirs"); // never copilot-env's to delete
  expect(config.model_providers).toEqual({
    "copilot-env-work": { "base_url": "http://localhost:4545/v1" },
    "copilot-env-fast": { "base_url": "https://api.githubcopilot.com" },
  });
  expect(parse(readFileSync(join(dir, "work.config.toml"), "utf8"))).toEqual({
    "model_provider": "copilot-env-work",
    "model": "gpt-5.4",
  });
  expect(parse(readFileSync(join(dir, "fast.config.toml"), "utf8"))).toEqual({
    "model_provider": "copilot-env-fast",
    "model": "from-file",
    "features": { "multi_agent": true, "shell_tool": false },
    "stamp": new TomlDate("2026-01-01T00:00:00Z"),
  });
  // Each thing left behind is named once, with the Codex error it causes.
  expect(warnings.filter((w) => w.includes("[profiles.theirs]"))).toHaveLength(1);
  expect(warnings.filter((w) => w.includes("[profiles.wrong]"))).toHaveLength(1);
  expect(warnings.filter((w) => w.includes("[profiles.personal_dev]"))).toHaveLength(1);
  expect(warnings.filter((w) => w.includes('profile = "theirs"'))).toHaveLength(1);
  expect(warnings.every((w) => w.includes("refuses"))).toBe(true);

  // Idempotent: a re-run has nothing of ours left to move and rewrites nothing.
  const after = readFileSync(configPath, "utf8");
  expect(warningsDuring(() => moveCodexProfileTables(dir))).toEqual(warnings);
  expect(readFileSync(configPath, "utf8")).toBe(after);
});

test("4.0.9 codex profiles: an unparseable <name>.config.toml keeps its table and fails the step after the others moved", () => {
  // No wiring command removes a legacy table, so the only way out is a re-run of the migration
  // once the file is repaired: the step must fail (the runner names the re-run), not report clean.
  dir = tempDir("copilot-mig-codex-profiles-stuck-");
  const configPath = join(dir, "config.toml");
  writeFileSync(
    configPath,
    stringify({
      "profiles": {
        "work": { "model_provider": "copilot-env-work" },
        "fast": { "model_provider": "copilot-env-fast" },
      },
    }),
  );
  writeFileSync(join(dir, "work.config.toml"), 'model_provider = "unclosed');

  let thrown: unknown;
  const warnings = warningsDuring(() => {
    try {
      moveCodexProfileTables(dir);
    } catch (e) {
      thrown = e;
    }
  });
  expect(String(thrown)).toMatch(/work\.config\.toml/);
  expect(warnings.filter((w) => w.includes("left [profiles.work]"))).toHaveLength(1);
  expect(readFileSync(join(dir, "work.config.toml"), "utf8")).toBe('model_provider = "unclosed');
  expect(parse(readFileSync(configPath, "utf8"))).toEqual({
    "profiles": { "work": { "model_provider": "copilot-env-work" } },
  });
  expect(parse(readFileSync(join(dir, "fast.config.toml"), "utf8"))).toEqual({
    "model_provider": "copilot-env-fast",
  });
});

test("4.0.9 identity cache: the four cached keys go from a slot in the old shape, said once, promoting nothing into the pair; a new-shape slot and a clean store are untouched", () => {
  const home = isolateProxyHome("copilot-mig-identity-cache-");
  dir = home;
  const store = join(home, "state.json");
  const carrying = {
    profiles: {
      // No validity key: indistinguishable from the pair the new wiring stores, so it stays.
      default: { githubToken: "ghp_d", authProvider: "gh-token", integrationIdentity: "codex" },
      work: {
        githubToken: "ghp_w",
        authProvider: "gh-token",
        mode: "direct",
        integrationIdentity: "copilot-developer-cli",
        copilotHost: "https://api.enterprise.githubcopilot.com",
        copilotHostIdentity: "copilot-developer-cli",
        copilotHostSource: "auto",
        futureKey: true,
      },
      alt: { authProvider: "gh-cli", mode: "proxy" },
      // A half-cached slot: its host key goes with the rest, and it reads as never probed
      // like every other slot.
      half: {
        githubToken: "ghp_h",
        authProvider: "gh-token",
        mode: "direct",
        copilotHost: "https://api.githubcopilot.com",
        copilotHostSource: "auto",
      },
    },
    codexCatalogLastAttemptMs: 5,
  };
  const { profiles, ...global } = carrying;
  writeStore(store, { global, profiles });
  expect(warningsDuring(dropSlotIdentityCache, "info")).toHaveLength(1);
  expect(readStore(store)).toEqual({
    global: { codexCatalogLastAttemptMs: 5 },
    profiles: {
      default: { githubToken: "ghp_d", authProvider: "gh-token", integrationIdentity: "codex" },
      work: { githubToken: "ghp_w", authProvider: "gh-token", mode: "direct", futureKey: true },
      alt: { authProvider: "gh-cli", mode: "proxy" },
      half: { githubToken: "ghp_h", authProvider: "gh-token", mode: "direct" },
    },
  });
  // No pair survives (the cache is not promoted into state), so the next Direct re-render of each
  // slot probes once through the gap and stores what it finds.
  const state = new CopilotEnvState(store);
  expect(state.readProfileDirectPair(parseProfileName("work"))).toEqual({});
  expect(state.readProfileDirectPair(parseProfileName("half"))).toEqual({});
  // Idempotent and quiet once clean: the pair the new wiring then stores is not the cache, so a
  // re-run neither writes nor speaks.
  const pair = { integrationId: "copilot-developer-cli", host: "https://api.githubcopilot.com" };
  state.setProfileDirectPair(parseProfileName("work"), pair);
  const bytes = readFileSync(store, "utf8");
  expect(warningsDuring(dropSlotIdentityCache, "info")).toHaveLength(0);
  expect(readFileSync(store, "utf8")).toBe(bytes);
  expect(state.readProfileDirectPair(parseProfileName("work"))).toEqual(pair);
});

// A credentials.json that fails validation never costs preferences.json a profile's settings.
test("4.0.9 state fold: a junk credentials.json loses nothing of preferences.json: grouped sections fold whole, a flat store is held until the slots can be read", () => {
  const home = isolateProxyHome("copilot-mig-state-fold-junk-");
  dir = home;
  const GHE = "https://copilot-api.ghe.example";
  const stateFile = join(home, "state.json");
  writeFileSync(join(home, "credentials.json"), "{ not json\n");
  // Grouped: every section preferences.json holds is carried, the slots unknown.
  writeStore(join(home, "preferences.json"), {
    global: { "daemon.port": 4199 },
    profiles: { work: { host: GHE } },
  });
  expect(warningsDuring(() => foldRootStores(home), "warn")).toHaveLength(1); // credentials.json
  expect(readStore(stateFile)).toEqual({
    global: { "daemon.port": 4199 },
    profiles: { work: { host: GHE } },
  });
  expect(existsSync(join(home, "preferences.json"))).toBe(false);
  expect(existsSync(join(home, "credentials.json"))).toBe(true);
  expect(new CopilotEnvConfig().copilotHost(parseProfileName("work"))).toBe(GHE);
  // Flat: the profile keys copy into every profile credentials.json names, so the file is held
  // (kept, named) until credentials.json can be read; nothing is folded of it.
  rmSync(stateFile);
  writeStore(join(home, "preferences.json"), { port: 4199, copilotHost: GHE });
  const heldWarnings = warningsDuring(() => foldRootStores(home), "warn");
  expect(heldWarnings).toHaveLength(2);
  expect(heldWarnings.join("\n")).toContain("preferences.json kept");
  expect(existsSync(join(home, "preferences.json"))).toBe(true);
  expect(existsSync(stateFile)).toBe(false);
  // credentials.json fixed: the flat keys land in the default AND every named slot, then the file goes.
  writeStore(join(home, "credentials.json"), {
    profiles: { work: { githubToken: "ghp_w", authProvider: "gh-token", mode: "direct" } },
  });
  expect(warningsDuring(() => foldRootStores(home), "warn")).toEqual([]);
  expect(readStore(stateFile)).toEqual({
    global: { "daemon.port": 4199 },
    profiles: {
      default: { host: GHE },
      work: { githubToken: "ghp_w", authProvider: "gh-token", mode: "direct", host: GHE },
    },
  });
  expect(existsSync(join(home, "preferences.json"))).toBe(false);
  expect(existsSync(join(home, "credentials.json"))).toBe(false);
});

test("4.0.9 state fold: the three stores become one state.json (global, profiles, ownership); every removal is named; the root github_token and its login lock go, a foreign file stays; idempotent; a half-migrated store is kept and named", () => {
  const home = isolateProxyHome("copilot-mig-state-fold-");
  dir = home;
  const autoupdateHome = join(home, ".autoupdate");
  mkdirSync(join(home, "locks"), { recursive: true });
  mkdirSync(join(home, "opencode"), { recursive: true });
  mkdirSync(autoupdateHome, { recursive: true });
  const slot = { githubToken: "ghp_d", authProvider: "gh-token", mode: "proxy" };
  writeStore(join(home, "credentials.json"), {
    profiles: { default: slot },
    codexCatalogLastAttemptMs: 5,
  });
  writeStore(join(home, "preferences.json"), {
    global: { "daemon.port": 4199 },
    profiles: { default: { passthrough: "on" } },
  });
  writeStore(join(home, "ownership.json"), { claudeDesktopPaths: ["/lib/uuid.json"] });
  const locks = [
    "credentials.json.lock.oslock",
    "preferences.json.lock",
    "ownership.json.ops.lock.oslock",
  ];
  for (const lock of locks) writeFileSync(join(home, "locks", lock), "");
  writeFileSync(join(home, "opencode", "github_token"), "gho_stale");
  writeFileSync(join(home, "codex-model-catalog.json.bak"), "{}");
  writeFileSync(join(home, "github_token"), "");
  writeFileSync(join(home, "locks", "github_token.login.lock"), "");
  writeFileSync(join(home, "locks", "github_token.login.lock.oslock"), "");
  writeFileSync(join(home, "notes.txt"), "not ours");
  writeFileSync(join(autoupdateHome, "state.json"), `${JSON.stringify({ lastCheckMs: 7 })}\n`);

  const fold = () => {
    foldRootStores(home);
    renameAutoupdateThrottle(autoupdateHome);
  };
  const said = warningsDuring(fold, "info");
  // Every file the pass touches, one line each: three folds, three lock sidecars, the opencode
  // token and its emptied directory, the catalog backup, the root github_token and its two login
  // lock files, the throttle move.
  expect(said).toHaveLength(13);
  for (const lock of locks) expect(said.join("\n")).toContain(join(home, "locks", lock));
  const stateFile = join(home, "state.json");
  const merged = {
    global: { codexCatalogLastAttemptMs: 5, "daemon.port": 4199 },
    profiles: { default: { ...slot, passthrough: "on" } },
    ownership: { claudeDesktopPaths: ["/lib/uuid.json"] },
  };
  expect(readStore(stateFile)).toEqual(merged);
  for (
    const gone of [
      "credentials.json",
      "preferences.json",
      "ownership.json",
      ...locks.map((lock) => join("locks", lock)),
      join("opencode", "github_token"),
      "opencode",
      "codex-model-catalog.json.bak",
      "github_token",
      join("locks", "github_token.login.lock"),
      join("locks", "github_token.login.lock.oslock"),
      join(".autoupdate", "state.json"),
    ]
  ) expect(existsSync(join(home, gone))).toBe(false);
  for (const kept of ["notes.txt", join(".autoupdate", "autoupdate.json")]) {
    expect(existsSync(join(home, kept))).toBe(true);
  }
  // The readers see the folded values through one file, each picking its own keys.
  expect(new CopilotEnvConfig().defaultPort()).toBe(4199);
  expect(new CopilotEnvConfig().read().profiles).toEqual({ default: { passthrough: "on" } });
  expect(new CopilotEnvState().readProfileSlot(null).mode).toBe("proxy");
  expect(new OwnershipLedger().ownedPaths("claudeDesktop")).toEqual(["/lib/uuid.json"]);
  // Idempotent and quiet once folded.
  const bytes = readFileSync(stateFile, "utf8");
  expect(warningsDuring(fold, "info")).toEqual([]);
  expect(readFileSync(stateFile, "utf8")).toBe(bytes);
  // Half-migrated (a crash between the write and the delete): an old store beside its keys already
  // in state.json is kept as it is and named, and nothing is folded twice. The other two stores
  // are judged on their own, so a credentials.json reappearing beside the folded slot is kept too.
  writeStore(join(home, "ownership.json"), { claudeDesktopPaths: ["/lib/other.json"] });
  writeStore(join(home, "credentials.json"), { profiles: { default: { mode: "direct" } } });
  const warned = warningsDuring(() => foldRootStores(home), "warn");
  expect(warned).toHaveLength(2);
  expect(warned.join("\n")).toContain("delete ownership.json by hand");
  expect(warned.join("\n")).toContain("delete credentials.json by hand");
  expect(existsSync(join(home, "ownership.json"))).toBe(true);
  expect(existsSync(join(home, "credentials.json"))).toBe(true);
  expect(readFileSync(stateFile, "utf8")).toBe(bytes);
  rmSync(join(home, "ownership.json"));
  rmSync(join(home, "credentials.json"));
  // A store that is not a JSON object is left in place and named, and the parser's message (which
  // can quote the file's text) is never echoed.
  writeFileSync(join(home, "ownership.json"), "[1]\n");
  writeFileSync(join(home, "preferences.json"), '{"githubToken": ghp_leak}\n');
  const junk = warningsDuring(() => foldRootStores(home), "warn");
  expect(junk).toHaveLength(2);
  expect(junk.join("\n")).not.toContain("ghp_leak");
  expect(existsSync(join(home, "ownership.json"))).toBe(true);
  expect(existsSync(join(home, "preferences.json"))).toBe(true);
  expect(readFileSync(stateFile, "utf8")).toBe(bytes);
});

test("4.0.9 throttle rename: an old state.json back beside autoupdate.json is removed with its lock and named; the new file is untouched", () => {
  dir = tempDir("copilot-mig-throttle-");
  const autoupdateHome = join(dir, ".autoupdate");
  mkdirSync(autoupdateHome, { recursive: true });
  const kept = `${JSON.stringify({ lastCheckMs: 9 })}\n`;
  writeFileSync(join(autoupdateHome, "autoupdate.json"), kept);
  writeFileSync(join(autoupdateHome, "state.json"), `${JSON.stringify({ lastCheckMs: 7 })}\n`);
  writeFileSync(join(autoupdateHome, "state.json.lock"), "");
  const said = warningsDuring(() => renameAutoupdateThrottle(autoupdateHome), "info");
  expect(said).toHaveLength(2);
  expect(said.join("\n")).toContain(join(autoupdateHome, "state.json.lock"));
  expect(existsSync(join(autoupdateHome, "state.json"))).toBe(false);
  expect(existsSync(join(autoupdateHome, "state.json.lock"))).toBe(false);
  expect(readFileSync(join(autoupdateHome, "autoupdate.json"), "utf8")).toBe(kept);
});

test("4.0.9 root daemon home: a default daemon at the root is stopped and its files move into profiles/default, each named; a refused stop or another host's tracked pid moves nothing; a leftover beside its moved twin is kept and named", async () => {
  dir = tempDir("copilot-mig-root-home-");
  const root = dir;
  const runState = join(".run", "host-a", ".state.json");
  mkdirSync(join(root, ".run", "host-a"), { recursive: true });
  writeFileSync(join(root, runState), `${JSON.stringify({ pid: 4242 })}\n`);
  writeFileSync(join(root, "config.json"), "{}\n");
  writeFileSync(join(root, "state.json"), "{}\n"); // account-wide: stays at the root
  const untouched = () => {
    expect(existsSync(join(root, runState))).toBe(true);
    expect(existsSync(join(root, "profiles", "default"))).toBe(false);
  };
  // A daemon that will not stop: nothing moves, the step fails for the runner to name the re-run.
  await expect(
    moveRootDaemonHome(root, () => Promise.reject(new Error("would not stop")), "host-a"),
  )
    .rejects.toThrow("would not stop");
  untouched();
  // Another machine's daemon over a shared home: its pid cannot be stopped from here, so the move
  // refuses and names that host's state file; the local stop is never attempted.
  await expect(moveRootDaemonHome(root, () => Promise.reject(new Error("must not stop")), "host-b"))
    .rejects.toThrow(join(root, runState));
  untouched();

  let stops = 0;
  const captured = captureConsola("info");
  try {
    await moveRootDaemonHome(root, () => {
      stops++;
      return Promise.resolve();
    }, "host-a");
  } finally {
    captured.restore();
  }
  expect(stops).toBe(1);
  const target = join(root, "profiles", "default");
  for (const moved of [runState, "config.json"]) {
    expect(existsSync(join(root, moved))).toBe(false);
    expect(existsSync(join(target, moved))).toBe(true);
  }
  expect(existsSync(join(root, "state.json"))).toBe(true);
  expect(captured.lines).toHaveLength(2);
  // `.run` goes last, so an interrupted run still finds the daemon home at the root and resumes.
  expect(captured.lines[1]).toContain(`${join(root, ".run")} -> ${join(target, ".run")}`);
  // A leftover beside its moved twin is never merged over it: kept at the root and named.
  writeFileSync(join(root, "config.json"), "{}\n");
  const kept = captureConsola("warn");
  try {
    await moveRootDaemonHome(root, () => Promise.resolve(), "host-a");
  } finally {
    kept.restore();
  }
  expect(kept.lines).toHaveLength(1);
  expect(kept.lines[0]).toContain(`keeping ${join(target, "config.json")}`);
  expect(existsSync(join(root, "config.json"))).toBe(true);
});

test("4.0.9 root daemon home: a .run/<host>/.state.json that cannot be parsed is never 'no daemon': the move refuses and names the file", async () => {
  dir = tempDir("copilot-mig-root-home-");
  const file = join(dir, ".run", "host-a", ".state.json");
  mkdirSync(join(dir, ".run", "host-a"), { recursive: true });
  writeFileSync(file, '{"pid":');
  writeFileSync(join(dir, "config.json"), "{}\n");
  await expect(moveRootDaemonHome(dir, () => Promise.reject(new Error("must not stop")), "host-b"))
    .rejects.toThrow(file);
  expect(existsSync(join(dir, "config.json"))).toBe(true);
  expect(existsSync(join(dir, "profiles", "default"))).toBe(false);
});

test("4.0.9 root daemon home: a login's config.json at the root with no .run still moves into profiles/default", async () => {
  dir = tempDir("copilot-mig-root-home-");
  writeFileSync(join(dir, "config.json"), '{"auth":{"apiKeys":["k"]}}\n');
  const captured = captureConsola("info");
  try {
    await moveRootDaemonHome(dir, () => Promise.resolve(), "host-a");
  } finally {
    captured.restore();
  }
  expect(captured.lines).toHaveLength(1);
  expect(existsSync(join(dir, "config.json"))).toBe(false);
  expect(readFileSync(join(dir, "profiles", "default", "config.json"), "utf8")).toBe(
    '{"auth":{"apiKeys":["k"]}}\n',
  );
});

// The 4.0.9 resolver line of a named profile, built from the current one so the launcher path and
// its quoting are this platform's; the replacement failing to match would leave the line
// unrecognised and the assertions below red.
function legacyHelperLine(profile: string): string {
  return directHelperCommand(parseProfileName(profile)).replace(
    `profile ${profile} auth --get`,
    `auth --get --profile ${profile}`,
  );
}

test("4.0.9 profile verb tree: a malformed Desktop index refuses a rename before its first delete, and the step reports it", async () => {
  // Without the check the rename would move the store and home, write the new helper, delete
  // the old one, then find the index unreadable and leave the owned entry pointing at the deleted
  // helper with the old argv, while the step reported success.
  const homes = isolateAgentHomes("copilot-mig-verb-tree-meta-", { mkdirs: true });
  dir = homes.dir;
  const desktop = join(dir, "desktop");
  const library = join(desktop, "configLibrary");
  mkdirSync(library, { recursive: true });
  process.env[CLAUDE_DESKTOP_DIR_ENV] = desktop;
  const SYNC = parseProfileName("sync");
  try {
    writeStore(join(homes.proxyHome, "state.json"), {
      global: { "daemon.port": 4199 },
      profiles: {
        sync: { githubToken: "ghp_sync", authProvider: "gh-token", mode: "proxy" },
      },
    });
    mkdirSync(join(homes.proxyHome, "profiles", "sync"), { recursive: true });
    const helper = writeDesktopHelperScript("proxy", SYNC);
    writeFileSync(join(library, META_FILENAME), "{ not json");
    const before = fingerprintTree(dir);
    const run = await captureChannels(() =>
      expect(moveProfilesToVerbTree()).rejects.toThrow("not moved: profile 'sync'")
    );
    expect(run.all).toContain("could not move profile 'sync'");
    expect(run.all).toContain("has an unexpected shape");
    // Nothing moved, nothing deleted: the store slot, the daemon home, and the helper stand.
    expect(fingerprintTree(dir)).toEqual(before);
    expect(existsSync(helper)).toBe(true);
    expect(new CopilotEnvState().profileNames()).toEqual([SYNC]);
  } finally {
    delete process.env[CLAUDE_DESKTOP_DIR_ENV];
  }
});

test("4.0.9 profile verb tree: the default's MCP registration moves to `agent profile mcp --serve` on its own, with no re-render to redo it", async () => {
  // A Direct default with no credential: its slot is incomplete, so the step retargets the
  // registration and re-renders nothing, and the retarget alone must leave the entry current.
  const homes = isolateAgentHomes("copilot-mig-verb-tree-mcp-", { mkdirs: true });
  dir = homes.dir;
  writeStore(join(homes.proxyHome, "state.json"), {
    profiles: { default: { mode: "direct" } },
  });
  const legacyMcp = agentLauncherCommand(["mcp", "--serve"]);
  writeFileSync(
    claudeJsonPath(),
    JSON.stringify({
      mcpServers: {
        "copilot-env": { type: "stdio", command: legacyMcp.command, args: legacyMcp.args },
        "theirs": { type: "stdio", command: "x", args: [] },
      },
    }),
  );
  const run = await captureChannels(() => moveProfilesToVerbTree());
  expect(run.all).toContain("default has no complete wiring to re-render");
  expect(inspectMcpRegistration().status).toBe("ours-current");
  const doc = JSON.parse(readFileSync(claudeJsonPath(), "utf8")) as {
    mcpServers: Record<string, { args: string[] }>;
  };
  expect(doc.mcpServers["copilot-env"]?.args).toEqual(
    agentLauncherCommand(["profile", "mcp", "--serve"]).args,
  );
  expect(doc.mcpServers["theirs"]).toEqual({ type: "stdio", command: "x", args: [] });
  // Idempotent: the second run finds the new shape and writes nothing.
  const before = fingerprintTree(dir);
  await captureChannels(() => moveProfilesToVerbTree());
  expect(fingerprintTree(dir)).toEqual(before);
});

test(
  "4.0.9 profile verb tree, dry run: a moved profile home is a directory row the re-render builds under, and a retargeted settings file never prints its token",
  async () => {
    const homes = isolateAgentHomes("copilot-mig-verb-dry-", { mkdirs: true });
    dir = homes.dir;
    const desktop = join(dir, "desktop");
    mkdirSync(join(desktop, "configLibrary"), { recursive: true });
    process.env[CLAUDE_DESKTOP_DIR_ENV] = desktop;
    const LIST = parseProfileName("list");
    try {
      writeStore(join(homes.proxyHome, "state.json"), {
        global: { "daemon.port": 4199 },
        profiles: {
          default: { githubToken: "ghp_default", authProvider: "gh-token", mode: "proxy" },
          list: { githubToken: "ghp_list", authProvider: "gh-token", mode: "proxy" },
          // No credential: the Direct re-render refuses, so the retarget's write is the settings
          // file's only landing (the case whose line diff would print the token).
          work: { authProvider: "gh-token", mode: "direct" },
        },
      });
      writeRunState({ port: 4555 }, LIST);
      writeFileSync(join(homes.proxyHome, "profiles", "list", "config.json"), "{}\n");
      // The legacy provider table the retarget renames and re-resolves; a static-key bearer sits
      // in it so the preview's redaction is exercised on the row that carries a credential.
      const listAuth = proxyTokenCommand(LIST);
      writeFileSync(
        join(homes.codexHome, "config.toml"),
        [
          "[model_providers.copilot-env-list]",
          'base_url = "http://127.0.0.1:4555/v1"',
          "",
          "[model_providers.copilot-env-list.http_headers]",
          'Authorization = "Bearer example-secret-token"',
          "",
          "[model_providers.copilot-env-list.auth]",
          `command = ${JSON.stringify(listAuth.command)}`,
          `args = ${JSON.stringify(listAuth.args)}`,
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(homes.codexHome, "list.config.toml"),
        'model_provider = "copilot-env-list"\n',
      );
      // Minified, so the retarget's pretty-print reflows every line: a line diff would print
      // the token.
      writeFileSync(
        join(homes.claudeHome, "settings-work.json"),
        JSON.stringify({
          apiKeyHelper: legacyHelperLine("work"),
          env: { ANTHROPIC_AUTH_TOKEN: "example-secret-token" },
        }),
      );
      writeFileSync(
        join(homes.claudeHome, "settings-list.json"),
        JSON.stringify({
          apiKeyHelper: proxyHelperCommand(LIST),
          env: {
            ANTHROPIC_BASE_URL: "http://127.0.0.1:4555",
            ANTHROPIC_AUTH_TOKEN: "example-secret-token",
          },
        }),
      );
      setIntegrationProbeFetch(() =>
        Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }))
      );
      resetIntegrationIdentityCache();
      const before = fingerprintTree(dir);
      let narrated = "";
      const { changes } = await dryRunChanges(async () => {
        narrated = (await captureChannels(() => moveProfilesToVerbTree())).all;
      });
      expect(fingerprintTree(dir)).toEqual(before);
      const rendered = renderDryRun(changes);
      const newHome = join(homes.proxyHome, "profiles", "list-1");
      expect(rendered).toContain(`create ${newHome}${sep}`);
      expect(rendered.some((l) => l.startsWith(`create ${join(newHome, ".run")}${sep}`))).toBe(
        true,
      );
      expect(
        rendered.some((l) =>
          l.endsWith(join(".run", ".state.json").slice(4)) && l.includes(newHome)
        ),
      )
        .toBe(true);
      expect(narrated).toContain("re-rendered profile 'list-1'");
      const text = rendered.join("\n");
      expect(text).not.toContain("example-secret-token");
      // The retargeted file is new at its path: its rows read from absent, the bearer redacted.
      expect(text).toContain("env.ANTHROPIC_AUTH_TOKEN  (absent) -> <redacted>");
      // config.toml prints attribute by attribute (a whole-file secret flag would print the
      // rewrite bare): the table moves under the new id, its bearer redacted, and the profile
      // file's selector follows.
      const configToml = join(homes.codexHome, "config.toml");
      expect(rendered).toContain(`rewrite ${configToml}`);
      expect(text).toContain(
        '  model_providers.copilot-env-list.base_url  "http://127.0.0.1:4555/v1" -> (absent)',
      );
      expect(text).toContain(
        "  model_providers.copilot-env-list.http_headers.Authorization  <redacted> -> (absent)",
      );
      expect(text).toContain(
        `  model_providers.copilot-env-list-1.auth.args  (absent) -> ${
          JSON.stringify(proxyTokenCommand(parseProfileName("list-1")).args)
        }`,
      );
      expect(text).toContain("  sandbox_workspace_write.network_access  (absent) -> true");
      expect(rendered).toContain(`create ${join(homes.codexHome, "list-1.config.toml")}`);
      expect(text).toContain('  model_provider  (absent) -> "copilot-env-list-1"');
    } finally {
      delete process.env[CLAUDE_DESKTOP_DIR_ENV];
      setIntegrationProbeFetch(null);
    }
  },
  120_000,
);

test(
  "4.0.9 profile verb tree: a verb-named profile becomes the first free <name>-<n> with every " +
    "artifact retargeted and re-rendered, a named Direct profile's resolver line and the default's " +
    "proxy line, MCP registration, and Desktop row move to the new spelling, the user's keys " +
    "survive, and a re-run writes nothing",
  async () => {
    const homes = isolateAgentHomes("copilot-mig-verb-tree-", { mkdirs: true });
    dir = homes.dir;
    const desktop = join(dir, "desktop");
    const library = join(desktop, "configLibrary");
    mkdirSync(library, { recursive: true });
    process.env[CLAUDE_DESKTOP_DIR_ENV] = desktop;
    const SYNC = parseProfileName("sync");
    const SYNC2 = parseProfileName("sync-2");
    const entryPath = join(library, "e1.json");
    const defaultEntryPath = join(library, "e0.json");
    try {
      // A proxy profile named like a verb, a Direct profile whose files carry the 4.0.9 resolver
      // line, and a proxy default whose files, registration, and Desktop row carry the 4.0.9
      // spellings too.
      writeStore(join(homes.proxyHome, "state.json"), {
        global: { "daemon.port": 4199 },
        profiles: {
          default: { githubToken: "ghp_default", authProvider: "gh-token", mode: "proxy" },
          sync: {
            githubToken: "ghp_sync",
            authProvider: "gh-token",
            mode: "proxy",
            passthrough: "off",
          },
          // No stored pair, as on a real 4.0.9 store once the identity-cache step ran: the
          // re-render probes for it (the stub accepts the first candidate) and stores it.
          work: { githubToken: "ghp_work", authProvider: "gh-token", mode: "direct" },
        },
        ownership: { claudeDesktopPaths: [entryPath, defaultEntryPath] },
      });
      writeRunState({ port: 4555 }, SYNC);
      writeFileSync(
        join(homes.claudeHome, "settings-work.json"),
        JSON.stringify({ apiKeyHelper: legacyHelperLine("work"), hand: "kept" }),
      );
      writeFileSync(
        join(homes.claudeHome, "settings-sync.json"),
        JSON.stringify({
          apiKeyHelper: proxyHelperCommand(SYNC),
          env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:4555" },
          hand: "kept",
        }),
      );
      const legacyDefaultProxy = agentLauncherCommand(["proxy-token", "--yes"]);
      writeFileSync(
        join(homes.claudeHome, "settings.json"),
        JSON.stringify({
          apiKeyHelper: proxyHelperCommand().replace(
            "profile proxy-token --yes",
            "proxy-token --yes",
          ),
          env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:4199" },
          hand: "kept",
        }),
      );
      const legacyMcp = agentLauncherCommand(["mcp", "--serve"]);
      writeFileSync(
        claudeJsonPath(),
        JSON.stringify({
          mcpServers: {
            "copilot-env": { type: "stdio", command: legacyMcp.command, args: legacyMcp.args },
          },
        }),
      );
      const legacyWork = agentLauncherCommand(["auth", "--get", "--profile", "work"]);
      const defaultTable = managedProxyProvider("http://127.0.0.1:4199/v1", null, {
        kind: "command",
      }) as Record<string, unknown>;
      defaultTable.auth = {
        ...(defaultTable.auth as Record<string, unknown>),
        args: legacyDefaultProxy.args,
      };
      writeFileSync(
        join(homes.codexHome, "config.toml"),
        stringify({
          "model_provider": "copilot-env",
          "model_providers": {
            "copilot-env": defaultTable,
            "copilot-env-work": {
              "name": "copilot-env-work",
              "base_url": "https://api.githubcopilot.com",
              "auth": { "command": legacyWork.command, "args": legacyWork.args },
            },
            "copilot-env-sync": managedProxyProvider("http://127.0.0.1:4555/v1", SYNC, {
              kind: "command",
            }),
          },
        }),
      );
      writeFileSync(
        join(homes.codexHome, "sync.config.toml"),
        stringify({ "model_provider": "copilot-env-sync", "model": "gpt-5.4" }),
      );
      // `sync-1` is taken by a file of the user's, so the free name is `sync-2`.
      writeFileSync(join(homes.codexHome, "sync-1.config.toml"), stringify({ "model": "theirs" }));
      writeFileSync(
        join(library, META_FILENAME),
        JSON.stringify({
          appliedId: "e1",
          entries: [
            { id: "e0", name: "copilot-env", pinned: false },
            { id: "e1", name: "copilot-env: sync", pinned: true },
          ],
        }),
      );
      writeFileSync(
        defaultEntryPath,
        JSON.stringify({
          inferenceGatewayBaseUrl: "http://127.0.0.1:4199",
          managedMcpServers: [{ name: "copilot-env", args: legacyMcp.args }],
        }),
      );
      writeFileSync(
        entryPath,
        JSON.stringify({
          inferenceGatewayBaseUrl: "http://127.0.0.1:4555",
          managedMcpServers: [
            { name: "copilot-env", args: ["mcp", "--serve", "--profile", "sync"] },
            // Another program's row, with a `--profile` of its own: never ours to retarget.
            { name: "other-tool", args: ["--profile", "list"] },
          ],
        }),
      );

      setIntegrationProbeFetch(() =>
        Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }))
      );
      resetIntegrationIdentityCache();
      // The layout step runs first in a real update: the default's Desktop row is in the new shape
      // before any reconcile reads it, and the foreign row is left as it was.
      await captureChannels(() => Promise.resolve(rewriteDesktopMcpArgv()));
      const defaultEntry = JSON.parse(readFileSync(defaultEntryPath, "utf8")) as {
        managedMcpServers: { name: string; args: string[] }[];
      };
      expect(defaultEntry.managedMcpServers[0]?.args).toEqual(
        agentLauncherCommand(mcpServeArgs(null)).args,
      );
      // Each move is reported once: the reporter's line (Deno.stderr, so it is deferred and read
      // back), never a second narration line through consola.
      deferWriteReports();
      const run = await captureChannels(() => moveProfilesToVerbTree());
      const reports = flushWriteReports();
      expect(reports.filter((l) => l.startsWith("moved ->") && l.includes("settings-sync-2.json")))
        .toHaveLength(1);
      // The one narrated move is the daemon home, which the reporter hides (own-homes rule).
      const narrated = run.all.split("\n").filter((l) => l.includes("moved"));
      expect(narrated).toHaveLength(1);
      expect(narrated[0]).toContain(join("profiles", "sync-2"));
      expect(run.all).toContain("re-rendered profile 'work'");
      expect(run.all).toContain("re-rendered default's agent files");

      // The default's proxy line moved in both agent files, the user's key survived, and the
      // proxy re-render took the registration out (proxy wiring registers no server).
      const settingsDefault = JSON.parse(
        readFileSync(join(homes.claudeHome, "settings.json"), "utf8"),
      );
      expect(settingsDefault.apiKeyHelper).toBe(proxyHelperCommand());
      expect(settingsDefault.hand).toBe("kept");
      expect(inspectMcpRegistration().status).toBe("absent");

      const store = readStore(join(homes.proxyHome, "state.json"));
      const profiles = store.profiles as Record<string, Record<string, unknown>>;
      expect(profiles.sync).toBeUndefined();
      expect(profiles["sync-2"]).toMatchObject({
        githubToken: "ghp_sync",
        mode: "proxy",
        passthrough: "off",
      });
      expect(existsSync(join(homes.proxyHome, "profiles", "sync"))).toBe(false);
      expect(CopilotEnvRunState.forProfile(SYNC2).read().port).toBe(4555);

      const settingsWork = JSON.parse(
        readFileSync(join(homes.claudeHome, "settings-work.json"), "utf8"),
      );
      expect(settingsWork.apiKeyHelper).toBe(directHelperCommand(parseProfileName("work")));
      expect(settingsWork.hand).toBe("kept");
      expect(existsSync(join(homes.claudeHome, "settings-sync.json"))).toBe(false);
      const named = JSON.parse(
        readFileSync(join(homes.claudeHome, "settings-sync-2.json"), "utf8"),
      );
      expect(named.apiKeyHelper).toBe(proxyHelperCommand(SYNC2));
      expect(named.hand).toBe("kept");
      expect(named.env.ANTHROPIC_BASE_URL).toContain("4555");

      const config = parse(readFileSync(join(homes.codexHome, "config.toml"), "utf8")) as {
        model_providers: Record<string, { name: string; auth: { args: string[] } }>;
      };
      expect(config.model_providers["copilot-env"]?.auth.args).toEqual(proxyTokenCommand().args);
      expect(config.model_providers["copilot-env-work"]?.auth.args).toEqual(
        agentLauncherCommand(agentAuthGetArgs(parseProfileName("work"))).args,
      );
      expect(config.model_providers["copilot-env-sync"]).toBeUndefined();
      expect(config.model_providers["copilot-env-sync-2"]).toMatchObject({
        name: "copilot-env-sync-2",
        auth: { args: proxyTokenCommand(SYNC2).args },
      });
      expect(existsSync(join(homes.codexHome, "sync.config.toml"))).toBe(false);
      expect(parse(readFileSync(join(homes.codexHome, "sync-2.config.toml"), "utf8"))).toEqual({
        "model_provider": "copilot-env-sync-2",
        "model": "gpt-5.4",
      });
      expect(parse(readFileSync(join(homes.codexHome, "sync-1.config.toml"), "utf8"))).toEqual({
        "model": "theirs",
      });

      const meta = JSON.parse(readFileSync(join(library, META_FILENAME), "utf8"));
      expect(meta.appliedId).toBe("e1");
      expect(meta.entries).toContainEqual({ id: "e1", name: "copilot-env: sync-2", pinned: true });
      // The default's entry keeps its id through the layout step, the re-render, and the
      // reconcile; its row is the new shape.
      expect(meta.entries).toContainEqual({ id: "e0", name: "copilot-env", pinned: false });
      const defaultAfter = JSON.parse(readFileSync(defaultEntryPath, "utf8")) as {
        managedMcpServers: { name: string; args: string[] }[];
      };
      expect(defaultAfter.managedMcpServers.find((r) => r.name === "copilot-env")?.args).toEqual(
        agentLauncherCommand(mcpServeArgs(null)).args,
      );
      const entry = JSON.parse(readFileSync(entryPath, "utf8")) as {
        managedMcpServers: { name: string; args: string[] }[];
      };
      // By name: the re-render rebuilds our row and keeps the foreign one as it was.
      const row = (name: string) => entry.managedMcpServers.find((r) => r.name === name);
      expect(row("copilot-env")?.args).toContain("sync-2");
      expect(row("other-tool")).toEqual({ name: "other-tool", args: ["--profile", "list"] });
      // The re-render stored the pair it probed for.
      expect(typeof profiles.work?.integrationIdentity).toBe("string");

      expect(new CopilotEnvState().profileNames()).toEqual([SYNC2, WORK]);
      const list = runCli(["profile"], {
        env: { ...process.env, CONSOLA_LEVEL: "5", NO_COLOR: "1" },
      });
      expect(list.exitCode).toBe(0);
      expect(list.stdout + list.stderr).toContain("sync-2");

      // Idempotent: nothing left at an old spelling or name, so the re-run touches no file.
      const before = fingerprintTree(dir);
      await captureChannels(() => moveProfilesToVerbTree());
      expect(fingerprintTree(dir)).toEqual(before);

      // The verbs stay creatable-by-no-one: the one creator refuses the word.
      expect(() =>
        new CopilotEnvState().commitProfile(SYNC, {
          credential: { kind: "stored", provider: "gh-token", token: "ghp_x" },
          mode: "proxy",
        })
      ).toThrow(/reserved/);
    } finally {
      delete process.env[CLAUDE_DESKTOP_DIR_ENV];
      setIntegrationProbeFetch(null);
    }
  },
  120_000,
);
