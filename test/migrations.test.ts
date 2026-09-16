import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify, TomlDate } from "smol-toml";
import { directHelperCommand, proxyHelperCommand } from "../src/claude/config.ts";
import { CopilotEnvConfig } from "../src/copilot_api/env_config.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { OwnershipLedger } from "../src/copilot_api/ownership.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import {
  moveDataHome,
  v356,
  v356ClaudeWiring,
  v356CodexWiring,
  v356ShellFence,
} from "../src/migrations/3.5.6.ts";
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
  moveCodexProfileTables,
  regroupPreferenceStore,
  scopeStaticKeyBoolean,
  stripLaunchersBlocks,
  v409CodexProfileFiles,
  v409IntegrationIdPin,
  v409LaunchersBlock,
  v409PreferenceGroups,
  v409StaticKeyScope,
} from "../src/migrations/4.0.9.ts";
import { dueMigrations, type Migration, runMigrations } from "../src/migrations/index.ts";
import { readResolvedVersionRecord, writeResolvedVersionRecord } from "../src/proxy_float.ts";
import { acquireDaemonLockForLife, daemonLockPath } from "../src/scripts/daemon_lock.ts";
import { releaseFileLock } from "../src/utils/file_lock.ts";
import { MARKER, MARKER_END } from "../src/shell/integration.ts";
import { proxyTokenCommand } from "../src/utils/root.ts";
import { consola } from "consola";
import type { SemverString } from "../src/utils/semver.ts";
import { denoRunArgs, importSpecifier, ROOT, spawnChild } from "./helpers/run.ts";
import { afterEach, expect, removeDir, tempDir, test } from "./helpers/testing.ts";
import { envSnapshot, isolateProxyHome, writeRunState } from "./helpers.ts";

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

afterEach(() => {
  restoreEnv();
  dir = removeDir(dir);
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

test("the shipped registry holds exactly the named fix-ups in order, home move first", () => {
  // Pinned BY IDENTITY and in order: a count or a list of version strings could stay green while a
  // same-version fix-up was dropped in a merge. Each position has a reason:
  //   layout steps first (home move, store rename, then the preference regrouping)
  //                                                      -> later steps read stores at the new paths and
  //                                                         through the new preference shape
  //   Desktop helper move, then the Codex profile files  -> each needs the 4.0.0 rewrites done
  expect(dueMigrations("0.0.1", "999.0.0")).toEqual([
    v356,
    v402RootLayout,
    v409PreferenceGroups,
    v356ShellFence,
    v356CodexWiring,
    v356ClaudeWiring,
    v400ShellFence,
    v400CodexWiring,
    v400ClaudeWiring,
    v400AutoupdateFlag,
    v402GhAccountPin,
    v402DesktopHelpers,
    v409CodexProfileFiles,
    v409IntegrationIdPin,
    v409StaticKeyScope,
    v409LaunchersBlock,
  ]);
  // An install already on 4.0.0 (whose readers tolerated the 3.5.6 shapes) still gets
  // every wiring rewrite on its way to the next release.
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
    accounts: [{ host: "github.com", login: "vivswan", active: true, source: "keyring" }],
  };
  state.setCredential(null, { kind: "gh-cli", ghUser: null });
  state.commitProfile(WORK, { credential: { kind: "gh-cli", ghUser: null }, mode: "direct" });
  state.commitProfile(OTHER, { credential: { kind: "gh-cli", ghUser: "kept" }, mode: "proxy" });
  const resolvable: string[] = [];
  pinSoleGhAccount(() => solo, (login) => {
    resolvable.push(login);
    return true;
  });
  expect(resolvable).toEqual(["vivswan"]);
  expect(state.readCredential(null)).toEqual({ kind: "gh-cli", ghUser: "vivswan" });
  expect(state.readCredential(WORK)).toEqual({ kind: "gh-cli", ghUser: "vivswan" });
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
  // The type demands a version-shaped literal, so only a cast reaches runtime -- but a
  // registry entry the range filter cannot see is a migration that never fires, so the
  // guard stays and names the offender.
  const bad = [mig("1.2.1"), { ...mig("1.2.5"), version: "oops" as SemverString }];
  expect(() => dueMigrations("1.0.0", "2.0.0", bad)).toThrow(
    'registry version (1.2.5) "oops" is not a semver version',
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

// --- the 3.5.6 data-home move (injectable core; real dirs never touched) --------

interface MoveFixture {
  legacy: string;
  next: string;
  codexConfig: string;
  desktopEntry: string;
  stopped: { count: number };
  run: () => Promise<void>;
}

function moveFixture(): MoveFixture {
  dir = tempDir("copilot-migrate-");
  delete process.env.COPILOT_API_HOME; // the unpinned path is the one under test
  const legacy = join(dir, "copilot-api");
  const next = join(dir, "copilot-env");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, "config.json"), "{}\n");
  const desktopEntry = join(dir, "entry.json");
  // The stores ride the move under their pre-4.0.2 names, and the move must rename them BEFORE its
  // ledger-fed rewrites: the entry below is only discoverable through the renamed ownership.json.
  writeFileSync(
    join(legacy, ".copilot-env-ownership.json"),
    `${JSON.stringify({ claudeDesktopPaths: [desktopEntry] })}\n`,
  );
  // The float record pins its deno cache by absolute path into the home.
  writeResolvedVersionRecord(legacy, "2.3.3", 1_700_000_000_000, join(legacy, "proxy", "deno"));
  const codexConfig = join(dir, "codex-config.toml");
  writeFileSync(
    codexConfig,
    `model_provider = "copilot-env"\nmodel_catalog_json = "${
      join(legacy, "codex-model-catalog.json").replaceAll("\\", "\\\\")
    }"\n`,
  );
  writeFileSync(
    desktopEntry,
    `${
      JSON.stringify({
        "inferenceCredentialHelper": join(legacy, "claude-desktop-token.sh"),
        "userKey": "keep",
      })
    }\n`,
  );
  const stopped = { count: 0 };
  return {
    legacy,
    next,
    codexConfig,
    desktopEntry,
    stopped,
    run: () =>
      moveDataHome({
        legacyHome: legacy,
        nextHome: next,
        stopDaemons: () => {
          stopped.count++;
          return Promise.resolve();
        },
        codexConfigPaths: () => [codexConfig],
        // The production binding: the ledger reader knows ONLY the renamed store, readable at the
        // moved home once the in-move rename happened. Pinning the home at INVOKE time mirrors the
        // real thunk.
        desktopEntryPaths: () => {
          process.env.COPILOT_API_HOME = next;
          return new OwnershipLedger().ownedPaths("claudeDesktop");
        },
      }),
  };
}

test("3.5.6 move: daemons stopped, dir renamed, both artifact kinds repointed", async () => {
  const fx = moveFixture();
  await fx.run();
  expect(fx.stopped.count).toBe(1);
  expect(existsSync(fx.legacy)).toBe(false);
  expect(existsSync(join(fx.next, "config.json"))).toBe(true);
  // The store rename happened INSIDE the move (before its ledger-fed rewrites).
  expect(existsSync(join(fx.next, "ownership.json"))).toBe(true);
  expect(existsSync(join(fx.next, ".copilot-env-ownership.json"))).toBe(false);
  expect(readFileSync(fx.codexConfig, "utf8")).toContain(
    join(fx.next, "codex-model-catalog.json").replaceAll("\\", "\\\\"),
  );
  const entry = JSON.parse(readFileSync(fx.desktopEntry, "utf8")) as Record<string, unknown>;
  expect(entry["inferenceCredentialHelper"]).toBe(join(fx.next, "claude-desktop-token.sh"));
  expect(entry["userKey"]).toBe("keep"); // foreign keys survive
  // The float record's deno_dir followed the home; version/timestamp untouched.
  expect(readResolvedVersionRecord(fx.next)).toEqual({
    version: "2.3.3",
    resolvedAtMs: 1_700_000_000_000,
    denoDir: join(fx.next, "proxy", "deno"),
  });

  await fx.run();
  expect(fx.stopped.count).toBe(1);
});

test("3.5.6 move: a re-run resuming after a crash mid-move still renames the stores first", async () => {
  const fx = moveFixture();
  // The crash point: the directory rename landed, the store rename did not.
  renameSync(fx.legacy, fx.next);
  await fx.run();
  expect(fx.stopped.count).toBe(0);
  expect(existsSync(join(fx.next, "ownership.json"))).toBe(true);
  expect(existsSync(join(fx.next, ".copilot-env-ownership.json"))).toBe(false);
  // The ledger-fed repoint found its entry through the renamed store.
  const entry = JSON.parse(readFileSync(fx.desktopEntry, "utf8")) as Record<string, unknown>;
  expect(entry["inferenceCredentialHelper"]).toBe(join(fx.next, "claude-desktop-token.sh"));
});

test("3.5.6 move: a stopDaemons refusal aborts the move -- the legacy home is untouched", async () => {
  const fx = moveFixture();
  // The production stopDaemons throws for a daemon it tried to stop and could not confirm stopped
  // (a kill survivor, or a pid it could not corroborate), so the move never proceeds over such a
  // writer. A lock holder with no recorded pid is not tried, and not refused.
  await expect(
    moveDataHome({
      legacyHome: fx.legacy,
      nextHome: fx.next,
      stopDaemons: () =>
        Promise.reject(new Error("a daemon (pid 123) under the legacy home would not stop")),
      codexConfigPaths: () => [fx.codexConfig],
      desktopEntryPaths: () => [fx.desktopEntry],
    }),
  ).rejects.toThrow("would not stop");
  expect(existsSync(join(fx.legacy, "config.json"))).toBe(true);
  expect(existsSync(fx.next)).toBe(false);
});

test(
  "3.5.6 move: the REAL stopLegacyDaemons guard aborts on a refused stop (subprocess)",
  async () => {
    dir = tempDir("copilot-migrate-guard-");
    const home = join(dir, "home");
    // LEGACY_HOME is frozen from homedir() at module load, so the real guard is only
    // reachable in a subprocess whose HOME points at the sandbox BEFORE the import.
    const legacy = join(home, ".local", "share", "copilot-api");
    const next = join(home, ".local", "share", "copilot-env");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "config.json"), "{}\n");
    // The refusal, staged for real: THIS process holds legacy's daemon.lock (the marker names our
    // pid, alive but nothing like a daemon) and legacy's run state tracks the same pid, so the
    // child's stopTrackedProxy reads lock-alive, cannot corroborate, and refuses (stopped: false).
    expect(acquireDaemonLockForLife(legacy, { waitMs: 0 })).toBe(true);
    const savedApiHome = process.env.COPILOT_API_HOME;
    process.env.COPILOT_API_HOME = legacy;
    try {
      writeRunState({ pid: process.pid, port: 4141 });
    } finally {
      if (savedApiHome === undefined) delete process.env.COPILOT_API_HOME;
      else process.env.COPILOT_API_HOME = savedApiHome;
    }
    const worker = join(dir, "worker.ts");
    writeFileSync(
      worker,
      `import { v356 } from ${importSpecifier(join(ROOT, "src", "migrations", "3.5.6.ts"))};\n` +
        "try {\n" +
        "  await v356.run();\n" +
        "  console.log('guard-missed: the move ran');\n" +
        "} catch (e) {\n" +
        "  console.log(`aborted: ${(e as Error).message}`);\n" +
        "}\n",
    );
    // Full parent env (Windows children need SystemRoot etc.) with HOME repointed and
    // COPILOT_API_HOME removed -- set, it would opt the whole migration out.
    const env: Record<string, string> = {
      ...Deno.env.toObject(),
      HOME: home,
      USERPROFILE: home,
    };
    delete env.COPILOT_API_HOME;
    delete env.COPILOT_ENV_ROOT_HOME;
    try {
      const child = spawnChild(Deno.execPath(), {
        args: [...denoRunArgs(), worker],
        env,
        clearEnv: true,
        stdout: "piped",
        stderr: "piped",
      });
      const output = await child.output();
      expect(new TextDecoder().decode(output.stdout)).toContain("would not stop");
      expect(existsSync(join(legacy, "config.json"))).toBe(true);
      expect(existsSync(next)).toBe(false);
    } finally {
      releaseFileLock(daemonLockPath(legacy));
    }
  },
  60_000,
);

test("3.5.6 move: both dirs existing is a refusal, never a merge", async () => {
  const fx = moveFixture();
  mkdirSync(fx.next, { recursive: true });
  await fx.run();
  expect(existsSync(join(fx.legacy, "config.json"))).toBe(true); // untouched
  expect(fx.stopped.count).toBe(0);
  // The codex value still points at the (still live) legacy home.
  expect(readFileSync(fx.codexConfig, "utf8")).toContain("copilot-api");
});

test("3.5.6 move: a pinned COPILOT_API_HOME opts the machine out entirely", async () => {
  const fx = moveFixture();
  process.env.COPILOT_API_HOME = fx.legacy;
  await fx.run();
  expect(existsSync(fx.legacy)).toBe(true);
  expect(fx.stopped.count).toBe(0);
});

test("3.5.6 move: foreign helper paths are never repointed", async () => {
  const fx = moveFixture();
  writeFileSync(
    fx.desktopEntry,
    `${JSON.stringify({ "inferenceCredentialHelper": "/opt/own/helper.sh" })}\n`,
  );
  await fx.run();
  const entry = JSON.parse(readFileSync(fx.desktopEntry, "utf8")) as Record<string, unknown>;
  expect(entry["inferenceCredentialHelper"]).toBe("/opt/own/helper.sh");
});

// --- 4.0.9: Codex named profiles -----------------------------------------------------

/** consola's lines at `level` for the span of `run`, restored after; the fix-ups report what they
 *  left and what they dropped. */
function warningsDuring(run: () => void, level: "warn" | "info" = "warn"): string[] {
  const lines: string[] = [];
  const original = consola[level];
  consola[level] = ((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  }) as typeof consola.warn;
  try {
    run();
  } finally {
    consola[level] = original;
  }
  return lines;
}

test("4.0.9 preferences: the flat camelCase store becomes grouped keys, the four profile keys under profiles.default", () => {
  // Readers know only the new shape, so an un-migrated store would read as empty: every key
  // moves verbatim, and the two 4.0.9 value fix-ups that follow judge it at the new place.
  const home = isolateProxyHome("copilot-mig-prefs-groups-");
  dir = home;
  const prefs = join(home, "preferences.json");
  writeFileSync(
    prefs,
    JSON.stringify({
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
    }),
  );
  expect(warningsDuring(regroupPreferenceStore, "info")).toHaveLength(1);
  const after = {
    global: {
      "daemon.auto-start": true,
      "daemon.port": 4199,
      "proxy.small-model": "gpt-5",
      "proxy.responses.context-management": true,
      "codex.home": "/srv/codex",
      "claude.wire-mcp": false,
    },
    profiles: {
      default: {
        identity: "copilot-developer-cli",
        host: "https://copilot-api.ghe.example",
        passthrough: "on",
        "static-key": true,
      },
    },
  };
  expect(JSON.parse(readFileSync(prefs, "utf8"))).toEqual(after);
  // The readers see the moved values through the precedence rule.
  const config = new CopilotEnvConfig();
  expect(config.defaultPort()).toBe(4199);
  expect(config.pinnedIntegrationId(null)).toBe("copilot-developer-cli");
  expect(config.copilotHost(null)).toBe("https://copilot-api.ghe.example");
  // Idempotent: a second run moves nothing and says nothing.
  expect(warningsDuring(regroupPreferenceStore, "info")).toEqual([]);
  expect(JSON.parse(readFileSync(prefs, "utf8"))).toEqual(after);
});

test("4.0.9 identity: a stored `codex` pin is dropped and said so; any other value stays", () => {
  // The domain refused `codex` only from #228 on; a pin stored before then reads as unset but
  // would sit in preferences.json forever, and its baked header outlives it until a rewire.
  const home = isolateProxyHome("copilot-mig-identity-pin-");
  dir = home;
  const prefs = join(home, "preferences.json");
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
    writeFileSync(prefs, `${JSON.stringify(shape(stored))}\n`);
    const lines = warningsDuring(dropCodexIdentityPin, "info");
    const raw = JSON.parse(readFileSync(prefs, "utf8")) as Record<string, unknown>;
    expect({ stored, raw, said: lines.length }).toEqual({
      stored,
      raw: shape(after),
      said: said ? 1 : 0,
    });
    if (said) expect(lines[0]).toContain("agent init");
  }
});

test("4.0.9 static-key: a stored boolean becomes the scope it meant, said once; a scope or nothing stays quiet", () => {
  // The key became a scope; a boolean left in preferences.json fails the domain and reads as
  // `none`, so an install that baked both agents would silently stop baking at its next wiring.
  const home = isolateProxyHome("copilot-mig-static-key-");
  dir = home;
  const prefs = join(home, "preferences.json");
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
    writeFileSync(prefs, `${JSON.stringify(shape(stored))}\n`);
    const lines = warningsDuring(scopeStaticKeyBoolean, "info");
    const raw = JSON.parse(readFileSync(prefs, "utf8")) as Record<string, unknown>;
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
