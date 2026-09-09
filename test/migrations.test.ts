import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "smol-toml";
import { directHelperCommand, proxyHelperCommand } from "../src/claude/config.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { startLockPath } from "../src/copilot_api/launch.ts";
import { OwnershipLedger } from "../src/copilot_api/ownership.ts";
import { defaultDaemonHome } from "../src/copilot_api/paths.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import {
  moveDataHome,
  moveDefaultDaemonHome,
  v356,
  v356ClaudeWiring,
  v356CodexWiring,
  v356DefaultHome,
  v356DefaultSlot,
  v356Ownership,
  v356ShellFence,
  v356VersionedLayout,
} from "../src/migrations/3.5.6.ts";
import {
  dropLegacyAutoupdateFlag,
  fenceUnfencedBlocks,
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
import { dueMigrations, type Migration, runMigrations } from "../src/migrations/index.ts";
import { readResolvedVersionRecord, writeResolvedVersionRecord } from "../src/proxy_float.ts";
import { acquireDaemonLockForLife, daemonLockPath } from "../src/scripts/daemon_lock.ts";
import { releaseFileLock, tryAcquireFileLock } from "../src/utils/file_lock.ts";
import {
  LAUNCHERS_MARKER,
  LAUNCHERS_MARKER_END,
  MARKER,
  MARKER_END,
} from "../src/shell/integration.ts";
import { proxyTokenCommand } from "../src/utils/root.ts";
import type { SemverString } from "../src/utils/semver.ts";
import { denoRunArgs, importSpecifier, ROOT, spawnChild } from "./helpers/run.ts";
import { afterEach, expect, removeDir, tempDir, test } from "./helpers/testing.ts";
import { envSnapshot, isolateProxyHome, writeRunState } from "./helpers.ts";

// Pure selection logic for which migrations run across a version range, with a synthetic
// registry so the real migrations' side effects are never triggered here. Migrations are
// named for the version they migrate AWAY FROM, and run for the range [from, to).
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
  // One row per selection guarantee, each named by its comment.
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
  // Adding a step has to be a deliberate edit to the registry, not an accident of
  // a stale import; this pins the full set BY IDENTITY and in order -- a count
  // (or a list of version strings) could stay green while a same-version fix-up
  // was silently dropped in a merge. Order matters within the version: the
  // later fix-ups read the state store the home move relocates, the default
  // daemon-home move relocates files inside that moved home, the three wiring
  // rewrites land before the layout adoption re-wires the shell through the
  // fence-only writer and sweeps the flat src/scripts, and the layout adoption runs
  // LAST among the 3.5.6 steps (it relocates the install the others fixed up). The
  // 4.0.0 registrations of the same rewrites follow, for installs already on 4.0.0.
  expect(dueMigrations("0.0.1", "999.0.0")).toEqual([
    // The LAYOUT steps are hoisted ahead of everything else, in version order:
    // the home move first (it may carry the old-name stores in), the root-store
    // rename second, and only then the steps that READ the stores -- through
    // the NEW code, so at the new paths. The Desktop helper move is deliberately
    // LAST: its wiring pass needs the v356/v400 wiring rewrites done.
    v356,
    v402RootLayout,
    v356Ownership,
    v356DefaultSlot,
    v356DefaultHome,
    v356ShellFence,
    v356CodexWiring,
    v356ClaudeWiring,
    v356VersionedLayout,
    v400ShellFence,
    v400CodexWiring,
    v400ClaudeWiring,
    v400AutoupdateFlag,
    v402GhAccountPin,
    v402DesktopHelpers,
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
  // Pin-less default + named gh-cli slots pin to the sole login; a pinned slot,
  // a token slot, and a non-gh-cli slot are untouched. Idempotent by re-run.
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

  // A sole login gh cannot serve pinned (`gh auth token --user` finds no saved
  // credential - an env-only GH_TOKEN) is never pinned: the pin would break a
  // working auto slot.
  state.setCredential(null, { kind: "gh-cli", ghUser: null });
  pinSoleGhAccount(() => solo, () => false);
  expect(state.readCredential(null)).toEqual({ kind: "gh-cli", ghUser: null });

  // Multiple accounts (or an unproven look): auto slots stay auto - only the
  // user can choose whose Copilot credit to spend. A BROKEN entry still counts
  // as an account: a broken active login is never abandoned for a healthy
  // bystander, and a login seen only broken could never verify its pin.
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
  // Stores renamed byte-identically; every old name and lock sidecar is gone;
  // unreferenced generated helpers removed while the lookalikes survive
  // (never ours).
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

  // Idempotent: nothing left to move, the wiring pass is not re-run, and the
  // renamed stores are untouched.
  moveRootStores(dir);
  await moveDesktopHelpers(dir, pass, () => true, none);
  expect(reconciled).toBe(1);
  expect(readFileSync(join(dir, "preferences.json"), "utf8")).toBe(
    `${JSON.stringify({ port: 4199 })}\n`,
  );

  // A helper a Desktop entry STILL references (the pass could not rewire it -
  // blocked metadata, a failed entry save) is kept: the entry keeps working off
  // it. Once nothing references it, a later run finishes the move.
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
  // Idempotent: a fenced file is byte-identical.
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
  // The step's outcome is the failure, but the convertible file was still converted.
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

  // Near misses at our name are the user's: untouched, settings included. A body that
  // only MENTIONS the resolver, a trailing shell command, a body addressed at another
  // profile, the pre-v3.3.5 `gh auth token` helper.
  // ...the OTHER platform's frame at this platform's path (no release paired them), and
  // the proxy body only unreleased mains wrote (the launcher's own subcommand).
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

test("an unparseable from or to bound throws instead of mis-selecting", () => {
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
  // A migration hiccup must never abort an otherwise-successful update, so the third
  // step still runs after the second throws -- and runMigrations itself must not reject.
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

/** A legacy home with a marker file, plus a codex config and a Desktop entry whose
 *  managed values point into it. */
function moveFixture(): MoveFixture {
  dir = tempDir("copilot-migrate-");
  delete process.env.COPILOT_API_HOME; // the unpinned path is the one under test
  const legacy = join(dir, "copilot-api");
  const next = join(dir, "copilot-env");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, "config.json"), "{}\n");
  const desktopEntry = join(dir, "entry.json");
  // The stores ride the move under their pre-4.0.2 names, and the move itself
  // must rename them BEFORE its ledger-fed rewrites: the entry below is only
  // discoverable through the renamed ownership.json, so a late rename would
  // leave the helper path unrepointed and fail the assertion.
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
        // The production binding: entries come from the ownership ledger, whose
        // reader knows ONLY the renamed store - readable at the moved home once
        // the move (incl. the in-move rename) has happened. Pinning the home at
        // INVOKE time mirrors how the real thunk resolves it post-move.
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

  // Idempotent: a re-run has nothing to move and rewrites nothing.
  await fx.run();
  expect(fx.stopped.count).toBe(1);
});

test("3.5.6 move: a stopDaemons refusal aborts the move -- the legacy home is untouched", async () => {
  const fx = moveFixture();
  // The production stopDaemons (stopLegacyDaemons) throws for ANY daemon not confirmed
  // stopped -- a kill survivor, or a stop refused because the pid could not be
  // corroborated as ours. The move must then never race the (possibly live) writer.
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
    // The refusal, staged for real: THIS test process holds legacy's daemon.lock (the
    // marker names our pid -- alive, but nothing like a daemon), and legacy's run state
    // tracks the same pid. The child's stopTrackedProxy reads lock-"alive", cannot
    // corroborate the pid, and refuses with stopped: false -- the guard must abort the
    // rename rather than race the (possibly live) writer.
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

// --- the 3.5.6 ownership adoption (second fix-up of the step) --------------------

test("3.5.6 ownership: legacy records move into the ledger; a re-run finds nothing", async () => {
  dir = isolateProxyHome("copilot-migrate-own-");
  writeFileSync(
    join(dir, "credentials.json"),
    `${
      JSON.stringify({
        githubToken: "ghu_keep",
        webSearchDenyOwnedPaths: ["/home/u/.claude/settings.json"],
        claudeDesktopOwnedPaths: ["/lib/uuid.json"],
      })
    }\n`,
  );

  await v356Ownership.run();
  const ledger = new OwnershipLedger();
  expect(ledger.ownedPaths("webSearchDeny")).toEqual(["/home/u/.claude/settings.json"]);
  expect(ledger.ownedPaths("claudeDesktop")).toEqual(["/lib/uuid.json"]);
  const raw = JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8")) as Record<
    string,
    unknown
  >;
  expect(raw.webSearchDenyOwnedPaths).toBeUndefined();
  expect(raw.claudeDesktopOwnedPaths).toBeUndefined();
  expect(raw.githubToken).toBe("ghu_keep");

  // Idempotent: the re-run has nothing to adopt and rewrites nothing.
  const stateBytes = readFileSync(join(dir, "credentials.json"), "utf8");
  await v356Ownership.run();
  expect(readFileSync(join(dir, "credentials.json"), "utf8")).toBe(stateBytes);
});

// --- the 3.5.6 default-slot lift (third fix-up of the step) -----------------------

test("3.5.6 default slot: the top-level pair lifts into profiles.default; a re-run is a no-op", async () => {
  dir = isolateProxyHome("copilot-migrate-slot-");
  const stateFile = join(dir, "credentials.json");
  writeFileSync(
    stateFile,
    `${
      JSON.stringify({
        githubToken: "ghu_keep",
        authProvider: "copilot",
        profiles: { work: { githubToken: "ghp_work", authProvider: "gh-token", mode: "proxy" } },
      })
    }\n`,
  );

  await v356DefaultSlot.run();
  const raw = JSON.parse(readFileSync(stateFile, "utf8")) as Record<
    string,
    Record<string, Record<string, unknown>>
  >;
  expect(raw.githubToken).toBeUndefined();
  expect(raw.authProvider).toBeUndefined();
  expect(raw.profiles?.default).toEqual({
    "authProvider": "copilot",
    "githubToken": "ghu_keep",
  });
  // Named slots are untouched (their stored keys are an external contract).
  expect(raw.profiles?.work).toEqual({
    "authProvider": "gh-token",
    "githubToken": "ghp_work",
    "mode": "proxy",
  });
  // The store, which reads the slot shape only, now answers the lifted credential.
  expect(new CopilotEnvState().readCredential(null)).toEqual({
    kind: "stored",
    provider: "copilot",
    token: "ghu_keep",
  });

  // Idempotent: the re-run finds nothing to lift and rewrites nothing.
  const stateBytes = readFileSync(stateFile, "utf8");
  await v356DefaultSlot.run();
  expect(readFileSync(stateFile, "utf8")).toBe(stateBytes);
});

test("3.5.6 default slot: a slot already holding a credential wins over a lingering pair", async () => {
  dir = isolateProxyHome("copilot-migrate-slot-");
  const stateFile = join(dir, "credentials.json");
  writeFileSync(
    stateFile,
    `${
      JSON.stringify({
        githubToken: "ghu_stale",
        authProvider: "copilot",
        profiles: { default: { githubToken: "ghu_slot", authProvider: "gh-token" } },
      })
    }\n`,
  );
  await v356DefaultSlot.run();
  const raw = JSON.parse(readFileSync(stateFile, "utf8")) as Record<
    string,
    Record<string, Record<string, unknown>>
  >;
  expect(raw.githubToken).toBeUndefined();
  expect(raw.profiles?.default?.githubToken).toBe("ghu_slot");
  expect(raw.profiles?.default?.authProvider).toBe("gh-token");
});

test("3.5.6 default slot: a store without legacy keys is untouched; an absent file is never created", async () => {
  dir = isolateProxyHome("copilot-migrate-slot-");
  const stateFile = join(dir, "credentials.json");
  // Fresh install: no state file at all -- the migration must not materialize one.
  await v356DefaultSlot.run();
  expect(existsSync(stateFile)).toBe(false);
  // Already-migrated (or never-authenticated) store: byte-identical after the run.
  writeFileSync(
    stateFile,
    `${JSON.stringify({ profiles: { default: { authProvider: "gh-cli" } } })}\n`,
  );
  const bytes = readFileSync(stateFile, "utf8");
  await v356DefaultSlot.run();
  expect(readFileSync(stateFile, "utf8")).toBe(bytes);
});

// --- the 3.5.6 default daemon-home move (fourth fix-up of the step) ----------------

// A pid no real process holds (far above any OS pid ceiling we run on): the fixture's
// stale lock marker must name a provably dead holder, or the dead-holder-only reclaim
// could refuse on a live coincidental pid and flake the test.
const DEAD_PID = 2_147_483_646;

/** A flat root: every daemon-home artifact at the root itself, a stale
 *  daemon.lock (marker file naming a dead pid, held by nobody), and the
 *  account-wide stores beside them. Returns the root (== dir). */
function flatRootFixture(): string {
  dir = isolateProxyHome("copilot-migrate-home-");
  mkdirSync(join(dir, ".run", "myhost"), { recursive: true });
  writeFileSync(join(dir, ".run", "myhost", ".state.json"), `${JSON.stringify({ port: 4141 })}\n`);
  mkdirSync(join(dir, "logs"), { recursive: true });
  writeFileSync(join(dir, "config.json"), "{}\n");
  writeFileSync(join(dir, ".copilot-env-projections.json"), "{}\n");
  writeFileSync(join(dir, "copilot-api.sqlite"), "");
  writeFileSync(daemonLockPath(dir), `${DEAD_PID}\n${Date.now()}\n`); // stale: holder dead
  writeFileSync(join(dir, "credentials.json"), `${JSON.stringify({ profiles: {} })}\n`);
  writeFileSync(join(dir, "github_token"), "ghu_keep\n");
  return dir;
}

test("3.5.6 default home: the flat daemon files move whole into profiles/default", async () => {
  const root = flatRootFixture();
  await moveDefaultDaemonHome();
  const target = join(root, "profiles", "default");
  // The daemon-home set moved -- contents included -- and the stale lock marker was
  // DELETED, not moved (its holder is dead; the new home takes a fresh one).
  expect(readFileSync(join(target, ".run", "myhost", ".state.json"), "utf8")).toContain("4141");
  for (
    const name of ["config.json", ".copilot-env-projections.json", "logs", "copilot-api.sqlite"]
  ) {
    expect(existsSync(join(target, name))).toBe(true);
    expect(existsSync(join(root, name))).toBe(false);
  }
  expect(existsSync(join(root, ".run"))).toBe(false);
  expect(existsSync(daemonLockPath(root))).toBe(false);
  expect(existsSync(daemonLockPath(target))).toBe(false);
  // No staging leftover: the flip renamed it into place whole.
  expect(existsSync(join(root, "profiles", ".default.migrating"))).toBe(false);
  // The account-wide files stay at the root -- that separation is the design.
  expect(existsSync(join(root, "credentials.json"))).toBe(true);
  expect(existsSync(join(root, "github_token"))).toBe(true);
  // The paths layer now resolves the default daemon into the moved home.
  expect(defaultDaemonHome()).toBe(target);
  // Idempotent: the re-run finds nothing flat and moves nothing.
  await moveDefaultDaemonHome();
  expect(existsSync(join(target, "config.json"))).toBe(true);
});

test("3.5.6 default home: a LIVE daemon.lock refuses the whole move, files untouched", async () => {
  const root = flatRootFixture();
  // Stand in for the still-running daemon: THIS process holds the root's lock.
  expect(acquireDaemonLockForLife(root, { waitMs: 0 })).toBe(true);
  try {
    await moveDefaultDaemonHome();
    // Nothing moved, nothing created: the daemon still owns the flat home.
    expect(existsSync(join(root, "profiles"))).toBe(false);
    expect(existsSync(join(root, "config.json"))).toBe(true);
    expect(existsSync(join(root, ".run", "myhost", ".state.json"))).toBe(true);
    expect(existsSync(daemonLockPath(root))).toBe(true);
    expect(defaultDaemonHome()).toBe(root); // flat tolerance still routes reads here
  } finally {
    releaseFileLock(daemonLockPath(root));
  }
});

test(
  "3.5.6 default home: a live PRE-LOCK daemon (tracked pid, no lock) refuses the move",
  async () => {
    const root = flatRootFixture();
    rmSync(daemonLockPath(root), { force: true }); // a pre-lock daemon holds no lock at all
    // A live daemon-shaped process tracked in the flat root's run state: the argv-scan
    // corroboration must refuse the move even though the lock is acquirable.
    const decoy = join(dir, "copilot-api-decoy.mjs");
    writeFileSync(decoy, "setTimeout(() => {}, 30_000);\n");
    const child = spawnChild(Deno.execPath(), {
      args: ["run", decoy, "start"],
      stdout: "null",
      stderr: "null",
    });
    try {
      writeRunState({ pid: child.pid, port: 4141 }); // resolves flat: the fixture is unmigrated
      await moveDefaultDaemonHome();
      expect(existsSync(join(root, "profiles", "default"))).toBe(false);
      expect(existsSync(join(root, "config.json"))).toBe(true);
      // The same refusal must hold when profiles/default ALREADY exists: the tracked
      // pid lives in the FLAT root's state file, which resolution no longer answers --
      // the check must read it by explicit path, or the per-file move would run under
      // the live daemon.
      mkdirSync(join(root, "profiles", "default"), { recursive: true });
      await moveDefaultDaemonHome();
      expect(existsSync(join(root, "config.json"))).toBe(true);
      expect(existsSync(join(root, "profiles", "default", "config.json"))).toBe(false);
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      await child.status;
    }
  },
  30_000,
);

test("3.5.6 default home: a busy start lock refuses the move (a launch is in flight)", async () => {
  const root = flatRootFixture();
  rmSync(daemonLockPath(root), { force: true });
  // Stand in for a mid-flight `agent start`: THIS process holds the global start lock
  // (which lives in the flat run dir while the root is unmigrated).
  const startLock = startLockPath();
  mkdirSync(dirname(startLock), { recursive: true });
  expect(tryAcquireFileLock(startLock, Number.POSITIVE_INFINITY)).toBe(true);
  try {
    await moveDefaultDaemonHome();
    expect(existsSync(join(root, "profiles"))).toBe(false);
    expect(existsSync(join(root, "config.json"))).toBe(true);
  } finally {
    releaseFileLock(startLock);
  }
});

test("3.5.6 default home: an UNREADABLE pid identity refuses the move (fail closed)", async () => {
  const root = flatRootFixture();
  rmSync(daemonLockPath(root), { force: true });
  // The tracked pid is alive (this very process) but its identity cannot be read -- a
  // restricted token, or a failed process scan. "Failed to look" is never "nobody
  // there": proceeding would relocate the home out from under a possibly-live pre-lock
  // daemon, so the move must refuse. (The kill paths' boolean scan reads this state as
  // false and would PROCEED here -- the inversion this control pins.)
  writeRunState({ pid: process.pid, port: 4141 });
  await moveDefaultDaemonHome(() => Promise.resolve("unknown" as const));
  expect(existsSync(join(root, "profiles", "default"))).toBe(false);
  expect(existsSync(join(root, "config.json"))).toBe(true);
  // Control: a CONFIDENT "no" (the pid is provably another process) proceeds -- the
  // refusal above is the classification's doing, not an unconditional block.
  await moveDefaultDaemonHome(() => Promise.resolve("no" as const));
  expect(existsSync(join(root, "profiles", "default", "config.json"))).toBe(true);
  expect(existsSync(join(root, "config.json"))).toBe(false);
});

test("3.5.6 default home: an artifact already in profiles/default is refused, never merged", async () => {
  const root = flatRootFixture();
  const target = join(root, "profiles", "default");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "config.json"), `{"keep":true}\n`);
  // A daemon RUNNING out of the pre-existing target refuses the per-file finish whole:
  // the flat root's lock says nothing about this home, so the move must take the
  // target's own lock before writing into it.
  expect(acquireDaemonLockForLife(target, { waitMs: 0 })).toBe(true);
  try {
    await moveDefaultDaemonHome();
    expect(existsSync(join(root, ".run"))).toBe(true); // nothing moved
  } finally {
    releaseFileLock(daemonLockPath(target));
  }
  await moveDefaultDaemonHome();
  // The conflicting artifact stayed on BOTH sides; the rest still moved.
  expect(readFileSync(join(target, "config.json"), "utf8")).toContain("keep");
  expect(existsSync(join(root, "config.json"))).toBe(true);
  expect(existsSync(join(target, ".run", "myhost", ".state.json"))).toBe(true);
  expect(existsSync(join(root, ".run"))).toBe(false);
});

test("3.5.6 default home: a crashed staging run resumes and still flips atomically", async () => {
  const root = flatRootFixture();
  // Stage what a mid-move crash leaves: some artifacts already in profiles/.default.migrating,
  // the rest still flat, and NO profiles/default -- reads must still resolve to the flat root.
  const staging = join(root, "profiles", ".default.migrating");
  mkdirSync(staging, { recursive: true });
  renameSync(join(root, "logs"), join(staging, "logs"));
  expect(defaultDaemonHome()).toBe(root); // no profiles/default yet: the flip never happened
  await moveDefaultDaemonHome();
  const target = join(root, "profiles", "default");
  expect(existsSync(join(target, "logs"))).toBe(true);
  expect(existsSync(join(target, "config.json"))).toBe(true);
  expect(existsSync(staging)).toBe(false);
  expect(defaultDaemonHome()).toBe(target);
});

test("3.5.6 default home: a FULLY staged crash still resolves flat, and the re-run finalizes", async () => {
  const root = flatRootFixture();
  rmSync(daemonLockPath(root), { force: true });
  // The worst crash point: EVERY artifact staged, the final rename never ran. With no
  // flat artifacts left, only the staging dir marks the root as mid-move -- without
  // that rule reads would see a fresh root and split from the staged data.
  const staging = join(root, "profiles", ".default.migrating");
  mkdirSync(staging, { recursive: true });
  for (
    const name of [
      "config.json",
      ".copilot-env-projections.json",
      ".run",
      "logs",
      "copilot-api.sqlite",
    ]
  ) {
    renameSync(join(root, name), join(staging, name));
  }
  expect(defaultDaemonHome()).toBe(root); // the staging dir alone keeps resolution flat
  await moveDefaultDaemonHome();
  const target = join(root, "profiles", "default");
  expect(readFileSync(join(target, ".run", "myhost", ".state.json"), "utf8")).toContain("4141");
  expect(existsSync(join(target, "config.json"))).toBe(true);
  expect(existsSync(staging)).toBe(false);
  expect(defaultDaemonHome()).toBe(target);
});

test("3.5.6 default home: a fresh (or migrated) root is a strict no-op", async () => {
  dir = isolateProxyHome("copilot-migrate-home-");
  writeFileSync(join(dir, "credentials.json"), `${JSON.stringify({ profiles: {} })}\n`);
  await moveDefaultDaemonHome();
  // Nothing fabricated: no profiles dir, no daemon files, no lock marker.
  expect(existsSync(join(dir, "profiles"))).toBe(false);
  expect(existsSync(join(dir, "config.json"))).toBe(false);
  expect(existsSync(daemonLockPath(dir))).toBe(false);
});
