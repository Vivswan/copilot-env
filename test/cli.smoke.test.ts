import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacyDirectHelperScript, legacyProxyHelperScript } from "../src/claude/config.ts";
import { DIRECT_HELPER_NAME, PROXY_HELPER_NAME } from "../src/claude/paths.ts";
import {
  CI_PS_DOCUMENTS_DIR_ENV,
  CI_RC_DIR_ENV,
  MARKER as SHELL_MARKER,
} from "../src/shell/integration.ts";
import { getSanitizedHostname } from "../src/utils/hostname.ts";
import { USAGE_INDEX_DIR_NAME } from "../src/usage/paths.ts";
import { loadPricing } from "../src/usage/pricing.ts";
import { MILLISECONDS_PER_DAY } from "../src/utils/time.ts";
import { runCli } from "./helpers/run.ts";
import { expect, test } from "./helpers/testing.ts";
import { writeClaudeSettings, writeCodexConfigToml } from "./helpers.ts";

// A throwaway COPILOT_API_HOME so the runtime probe sees no tracked pid/port. We pin the
// default proxy port to 4199 via config (isolated from any real proxy on 4141 on this host).
// HOME/USERPROFILE are isolated too: the codex host-farm and shell probes resolve through
// the home directory, so a developer machine with a built farm or a wired rc file would
// otherwise leak into the children's health reports.
function isolatedEnv(extra: Record<string, string> = {}): Record<string, string> {
  const home = mkdtempSync(join(tmpdir(), "copilot-health-"));
  writeFileSync(join(home, ".copilot-env-config.json"), JSON.stringify({ port: 4199 }));
  return {
    ...process.env,
    CONSOLA_LEVEL: "5",
    COPILOT_API_HOME: home,
    HOME: home,
    USERPROFILE: home,
    // Pointed at THIS home: both override HOME, and the suite-wide sandbox always sets them,
    // so inheriting would send the child's agent state outside the home built for it.
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CODEX_HOME: join(home, ".codex"),
    ...extra,
  };
}

function isolatedProxyEnv(extra: Record<string, string> = {}): Record<string, string> {
  const root = mkdtempSync(join(tmpdir(), "copilot-health-proxy-"));
  const codexHome = join(root, ".codex");
  // Production shape: the writer emits 127.0.0.1 (not localhost) so the agent reaches the
  // IPv4 proxy on Windows. The matcher accepts both; the other fixture keeps a localhost
  // case to prove backward-compat acceptance.
  writeCodexConfigToml(codexHome, {
    baseUrl: "http://127.0.0.1:4199/v1",
    envKey: "OPENAI_API_KEY",
  });
  writeFileSync(join(codexHome, ".env"), "OPENAI_API_KEY=test-key\n");
  return isolatedEnv({ CODEX_HOME: codexHome, ...extra });
}

// Pure help screens are read-only and deterministic, so each unique argv is spawned
// once and its output shared by every test that asserts on it (a cold CLI child
// spawn is expensive; the suite asserts on the same screens many times over).
const HELP_CACHE = new Map<string, { exitCode: number | null; stdout: string; output: string }>();

function helpScreen(...args: string[]): {
  exitCode: number | null;
  stdout: string;
  output: string;
} {
  const key = args.join(" ");
  const cached = HELP_CACHE.get(key);
  if (cached) return cached;
  const proc = runCli([...args], { env: { ...process.env, CONSOLA_LEVEL: "5" } });
  const stdout = proc.stdout;
  const entry = { exitCode: proc.exitCode, stdout, output: stdout + proc.stderr };
  HELP_CACHE.set(key, entry);
  return entry;
}

// End-to-end smoke test: the Commander CLI must load its whole import graph and
// print help without a running daemon or any auth. Catches wiring/import
// regressions that unit tests on individual modules would miss.
//
// CONSOLA_LEVEL is forced for the run* command output (consola silences itself
// when it detects a "test" environment, as the test runner is); Commander prints its
// own help to stdout directly, independent of consola.
test("`cli.ts --help` loads the CLI and exits 0", () => {
  const { exitCode, output } = helpScreen("--help");

  expect(exitCode).toBe(0);
  expect(output).toContain("start");
  expect(output).toContain("shell");
  expect(output).toContain("uninstall");
  expect(output).toContain("mcp");
  // No hidden commands: the resolver and the migration runner are documented surface.
  expect(output).toContain("proxy-token");
  expect(output).toContain("migrate");
  // `init` is the headline command and appears first in the COMMANDS list.
  expect(output).toContain("init");
  expect(output.indexOf("init")).toBeLessThan(output.indexOf("start"));
  // Flat command tree: there is no nested `setup` parent, and the root help
  // surfaces the global --version flag.
  expect(output).toContain("--version");
});

test("cli.ts mcp --help exposes the server flags; --remove rejects serve-only flags", () => {
  const help = helpScreen("mcp", "--help");
  expect(help.exitCode).toBe(0);
  expect(help.output).toContain("--serve");
  expect(help.output).toContain("--remove");
  expect(help.output).toContain("--profile");
  expect(help.output).toContain("--model");

  const conflict = runCli(["mcp", "--remove", "--model", "x"], {
    env: { ...process.env, CONSOLA_LEVEL: "5" },
  });
  expect(conflict.exitCode).not.toBe(0);
  expect(conflict.stderr).toContain("--remove takes no --profile/--model");

  const serveRemove = runCli(["mcp", "--serve", "--remove"], {
    env: { ...process.env, CONSOLA_LEVEL: "5" },
  });
  expect(serveRemove.exitCode).not.toBe(0);
  expect(serveRemove.stderr).toContain("mutually exclusive");

  // Serve-only flags without --serve must not silently start a server (or anything).
  const statusModel = runCli(["mcp", "--model", "x"], {
    env: { ...process.env, CONSOLA_LEVEL: "5" },
  });
  expect(statusModel.exitCode).not.toBe(0);
  expect(statusModel.stderr).toContain("apply to --serve");
});

test("cli.ts mcp (bare) prints the wiring status and exits 0", () => {
  // Hermetic homes: a temp CLAUDE_CONFIG_DIR (no registration) and an isolated
  // copilot-env home, so the status never reads or creates real user state.
  const claudeDir = mkdtempSync(join(tmpdir(), "copilot-mcp-status-"));
  const status = runCli(["mcp"], { env: isolatedEnv({ CLAUDE_CONFIG_DIR: claudeDir }) });
  const output = status.stderr;
  expect(status.exitCode).toBe(0);
  expect(output).toContain("not registered");
  expect(output).toContain("wire-mcp: true (default)");
  expect(output).toContain("--serve");
  // Read-only: the status must not create .claude.json.
  expect(existsSync(join(claudeDir, ".claude.json"))).toBe(false);
});

// Commander folds --verify/--no-verify into ONE optional boolean. Proven at the
// CLI boundary, not by calling the parser directly: each spelling must reach
// parseUpdateAction as a SET verify flag, which the report-flag rejection makes
// observable without any network (--check alone would go on to resolve releases).
// Which VALUE wins when both are given is Commander's negatable-option contract
// (last one); observing it needs the apply path, so it is not asserted here.
test("cli.ts update folds --verify/--no-verify into the verify flag", () => {
  for (
    const args of [
      ["update", "--check", "--no-verify"],
      ["update", "--verify", "--auto-status"],
    ]
  ) {
    const run = runCli(args, { env: { ...process.env, CONSOLA_LEVEL: "5" } });
    expect(run.exitCode, args.join(" ")).not.toBe(0);
    expect(run.stderr, args.join(" ")).toContain(
      "--verify/--no-verify only apply to the manual update",
    );
  }
});

test("cli.ts mcp --serve --profile '' hard-fails instead of serving the default credential", () => {
  // A supplied-but-blank --profile (an unset shell var in `--profile "$P"`) must
  // never silently resolve the DEFAULT credential (the named-profile hard-fail rule).
  const blank = runCli(["mcp", "--serve", "--profile", ""], {
    env: { ...process.env, CONSOLA_LEVEL: "5" },
  });
  expect(blank.exitCode).not.toBe(0);
  expect(blank.stderr).toContain("--profile expects a profile name");
});

// One help-surface case per command: shared shape (exit 0, the usage header, every
// flag named), varying needles. Successor of the former per-command env/shell/
// health/start/update --help tests; commands whose help test carries extra
// rejection runs (mcp, launch, codex, claude, init, uninstall, install) stay separate.
// "--verify " keeps its trailing space: bare "--verify" is a substring of --no-verify,
// so it alone could not miss a dropped --verify flag.
const HELP_SURFACES: { cmd: string; needles: string[] }[] = [
  { cmd: "env", needles: ["--format", "--profile"] },
  {
    cmd: "shell",
    needles: ["--clis", "--cooldown", "--no-sudo", "--no-prereqs", "--remove"],
  },
  { cmd: "health", needles: ["--scope", "--json"] },
  { cmd: "start", needles: ["--dry-run", "--port", "--record-event", "--check", "--force"] },
  {
    cmd: "update",
    needles: ["--auto-status", "--check", "--force", "--verify ", "--no-verify"],
  },
];

// Preferences that moved into `agent config` have no imperative twin left: the
// autoupdate toggle is the `auto-update` key ("--auto " with its trailing space, as
// bare "--auto" is a substring of the surviving --auto-status).
const REMOVED_FLAGS: { cmd: string; flags: string[] }[] = [
  { cmd: "update", flags: ["--auto ", "--no-auto"] },
  { cmd: "shell", flags: ["--launchers"] },
  { cmd: "codex", flags: ["--host", "--delete-host"] },
];

test("the flags that became config keys are gone from the help screens", () => {
  for (const { cmd, flags } of REMOVED_FLAGS) {
    const screen = helpScreen(cmd, "--help");
    expect(screen.exitCode).toBe(0);
    for (const flag of flags) expect(screen.output, `${cmd} ${flag}`).not.toContain(flag);
  }
});

test("each command's --help exits 0 and surfaces its flags", () => {
  for (const { cmd, needles } of HELP_SURFACES) {
    const help = helpScreen(cmd, "--help");
    expect(help.exitCode, cmd).toBe(0);
    expect(help.output, cmd).toContain(`Usage: agent ${cmd}`);
    for (const needle of needles) {
      expect(help.output, `${cmd} --help must surface ${needle}`).toContain(needle);
    }
  }
});

for (const args of [["codex"], ["claude"]] as const) {
  test(`cli.ts ${args.join(" ")} --help exposes provider modes`, () => {
    const { exitCode, output } = helpScreen(...args, "--help");

    expect(exitCode).toBe(0);
    expect(output).toContain("--proxy");
    expect(output).toContain("--direct");
  });
}

test("codex exposes and runs check mode", () => {
  const root = mkdtempSync(join(tmpdir(), "copilot-codex-check-"));
  const codexHome = join(root, ".codex");
  const directHome = join(root, "direct-codex");
  const otherHome = join(root, "other-codex");
  const noneHome = join(root, "none-codex");
  const unsetHome = join(root, "unset-codex");
  mkdirSync(noneHome, { recursive: true });
  mkdirSync(otherHome, { recursive: true });
  mkdirSync(unsetHome, { recursive: true });
  writeCodexConfigToml(codexHome, {
    baseUrl: "http://localhost:4199/v1",
    envKey: "OPENAI_API_KEY",
  });
  writeCodexConfigToml(directHome, { baseUrl: "https://api.githubcopilot.com" });
  writeFileSync(join(otherHome, "config.toml"), 'model_provider = "openai"\n');
  writeFileSync(join(unsetHome, "config.toml"), "[analytics]\nenabled = false\n");

  const helpOut = helpScreen("codex", "--help").output;
  expect(helpOut).toContain("--check");
  // The per-host farm is driven by the `codex-host` config key; no flag builds it.
  expect(helpOut).not.toContain("--host");
  expect(helpOut).not.toContain("--delete-host");
  expect(helpOut).toContain("--mobile");

  const runCheck = (home: string) =>
    runCli(["codex", "--check"], { env: isolatedEnv({ CODEX_HOME: home }) });

  const proxy = runCheck(codexHome);
  expect(proxy.exitCode).toBe(2);
  expect(proxy.stdout).toContain("Codex provider mode: proxy");
  expect(proxy.stdout).toContain("local copilot-api proxy");
  expect(proxy.stdout).toContain(`config.toml: ${join(codexHome, "config.toml")}`);

  const direct = runCheck(directHome);
  expect(direct.exitCode).toBe(0);
  expect(direct.stdout).toContain("Codex provider mode: direct");
  expect(direct.stdout).toContain("GitHub Copilot Direct");
  expect(direct.stdout).toContain(`config.toml: ${join(directHome, "config.toml")}`);

  const other = runCheck(otherHome);
  expect(other.exitCode).toBe(1);
  expect(other.stdout).toContain("Codex provider mode: other");
  expect(other.stdout).toContain(`config.toml: ${join(otherHome, "config.toml")}`);

  // none (no config.toml) now exits 2 (proxy default), matching Claude.
  const missing = runCheck(noneHome);
  expect(missing.exitCode).toBe(2);
  expect(missing.stdout).toContain("Codex provider mode: none");
  expect(missing.stdout).toContain("no config.toml found");

  const unset = runCheck(unsetHome);
  expect(unset.exitCode).toBe(2);
  expect(unset.stdout).toContain("Codex provider mode: none");
  expect(unset.stdout).toContain("no model_provider configured");

  const conflicting = runCli(["codex", "--proxy", "--direct"], {
    env: isolatedEnv({ CODEX_HOME: codexHome }),
  });
  expect(conflicting.exitCode).toBe(1);
  expect(conflicting.stderr).toContain("--direct and --proxy are mutually exclusive");
});

test("claude exposes and runs check mode", () => {
  const root = mkdtempSync(join(tmpdir(), "copilot-claude-check-"));
  const directHome = join(root, "direct");
  const proxyHome = join(root, "proxy");
  const otherHome = join(root, "other");
  const noneHome = join(root, "none"); // no settings.json at all
  mkdirSync(noneHome, { recursive: true });
  writeClaudeSettings(directHome, { apiKeyHelper: join(directHome, DIRECT_HELPER_NAME) });
  writeClaudeSettings(proxyHome, { apiKeyHelper: join(proxyHome, PROXY_HELPER_NAME) });
  // A helper-path apiKeyHelper classifies as ours only while the file body is exactly
  // what the pre-inline releases wrote: stage genuine legacy installs (the path alone
  // reads "other" -- exit 1 -- pinned in claude_config.test.ts).
  writeFileSync(join(directHome, DIRECT_HELPER_NAME), legacyDirectHelperScript());
  writeFileSync(join(proxyHome, PROXY_HELPER_NAME), legacyProxyHelperScript());
  writeClaudeSettings(otherHome, { apiKeyHelper: "/opt/x/helper.sh" });

  expect(helpScreen("claude", "--help").output).toContain("--check");

  const runCheck = (home: string) =>
    runCli(["claude", "--check"], { env: isolatedEnv({ CLAUDE_CONFIG_DIR: home }) });

  const direct = runCheck(directHome);
  expect(direct.exitCode).toBe(0);
  expect(direct.stdout).toContain("Claude provider mode: direct");
  expect(direct.stdout).toContain(`settings.json: ${join(directHome, "settings.json")}`);

  const proxy = runCheck(proxyHome);
  expect(proxy.exitCode).toBe(2);
  expect(proxy.stdout).toContain("Claude provider mode: proxy");

  // No settings.json at all is "none" -- still exit 2 (the proxy is the default).
  const none = runCheck(noneHome);
  expect(none.exitCode).toBe(2);
  expect(none.stdout).toContain("Claude provider mode: none");

  const other = runCheck(otherHome);
  expect(other.exitCode).toBe(1);
  expect(other.stdout).toContain("Claude provider mode: other");

  const conflicting = runCli(["claude", "--proxy", "--direct"], {
    env: isolatedEnv({ CLAUDE_CONFIG_DIR: proxyHome }),
  });
  expect(conflicting.exitCode).toBe(1);
  expect(conflicting.stderr).toContain("--direct and --proxy are mutually exclusive");
});

test("launch --help documents the contract; bad invocations are boundary rejections", () => {
  const help = helpScreen("launch", "--help");
  expect(help.exitCode).toBe(0);
  for (const needle of ["claude | codex | copilot", "--profile", "--relaxed"]) {
    expect(help.output).toContain(needle);
  }

  const unknown = runCli(["launch", "cursor"], { env: isolatedEnv() });
  expect(unknown.exitCode).toBe(1);
  expect(unknown.stderr).toContain(
    "unknown agent CLI 'cursor' (expected claude | codex | copilot)",
  );

  const copilotProfile = runCli(["launch", "copilot", "--profile", "work"], {
    env: isolatedEnv(),
  });
  expect(copilotProfile.exitCode).toBe(1);
  expect(copilotProfile.stderr).toContain("--profile does not apply to copilot");

  // Agent-CLI flags belong AFTER `--`; before it they are Commander's to reject,
  // so a typo'd launch flag is never silently forwarded to the agent.
  const beforeDashes = runCli(["launch", "claude", "--resume"], { env: isolatedEnv() });
  expect(beforeDashes.exitCode).toBe(1);
  expect(beforeDashes.stderr).toContain("unknown option");
  // Four cold CLI spawns; generous headroom for loaded Windows CI runners.
}, 90_000);

test("agent claude reconciles the Desktop library after its write; --check reports drift", () => {
  const env = isolatedEnv();
  const dataDir = join(env.COPILOT_API_HOME!, "claude-desktop");
  const library = join(dataDir, "configLibrary");
  mkdirSync(library, { recursive: true });
  env.COPILOT_ENV_CI_CLAUDE_DESKTOP_DIR = dataDir;
  // An owned entry no profile promises (an orphan), in the child's own ledger.
  writeFileSync(join(library, "old.json"), '{"inferenceGatewayBaseUrl":"x"}\n');
  writeFileSync(
    join(library, "_meta.json"),
    `${JSON.stringify({ entries: [{ id: "old", name: "copilot-env: old" }] })}\n`,
  );
  writeFileSync(
    join(env.COPILOT_API_HOME!, ".copilot-env-ownership.json"),
    `${JSON.stringify({ claudeDesktopPaths: [join(library, "old.json")] })}\n`,
  );

  // Before any wiring: --check names the leftover as drift, on the proxy/none exit code.
  const check = runCli(["claude", "--check"], { env });
  expect(check.exitCode).toBe(2);
  expect(check.stdout).toContain("Claude provider mode: none");
  expect(check.stdout).toContain(`"copilot-env: old" orphaned at ${join(library, "old.json")}`);
  expect(check.stdout).toContain("fix: agent claude");

  // The configure chain: the default entry lands and the orphan goes, in one run.
  const wire = runCli(["claude", "--proxy"], { env });
  expect(wire.exitCode).toBe(0);
  const meta = JSON.parse(readFileSync(join(library, "_meta.json"), "utf8")) as {
    entries: { name: string }[];
  };
  expect(meta.entries.map((e) => e.name)).toEqual(["copilot-env"]);
  expect(existsSync(join(library, "old.json"))).toBe(false);
  const after = runCli(["claude", "--check"], { env });
  expect(after.exitCode).toBe(2);
  expect(after.stdout).toMatch(/Claude Desktop: "copilot-env" \(proxy\) wired at /);
}, 60_000);

test("claude --desktop is deleted, not aliased: an unknown option, exit 1", () => {
  const gone = runCli(["claude", "--desktop"], { env: isolatedEnv() });
  expect(gone.exitCode).toBe(1);
  expect(gone.stderr).toContain("unknown option '--desktop'");
});

test("init configures both agents and rejects --direct + --proxy", () => {
  const help = helpScreen("init", "--help");
  expect(help.exitCode).toBe(0);
  expect(help.output).toContain("--direct");
  expect(help.output).toContain("--proxy");

  // --proxy forces BOTH agents to the proxy (no probe); isolate the homes so we
  // never touch the real ~/.codex or ~/.claude.
  const root = mkdtempSync(join(tmpdir(), "copilot-init-"));
  const proc = runCli(["init", "--proxy"], {
    env: isolatedEnv({
      CODEX_HOME: join(root, ".codex"),
      CLAUDE_CONFIG_DIR: join(root, ".claude"),
    }),
  });
  expect(proc.exitCode).toBe(0);
  const out = proc.stdout + proc.stderr;
  expect(out).toContain("local proxy");
  expect(existsSync(join(root, ".codex", "config.toml"))).toBe(true);
  expect(existsSync(join(root, ".claude", "settings.json"))).toBe(true);

  const conflict = runCli(["init", "--direct", "--proxy"], { env: isolatedEnv() });
  expect(conflict.exitCode).toBe(1);
  expect(conflict.stderr).toContain("--direct and --proxy are mutually exclusive");
});

test("profile rejects --direct + --proxy at the CLI boundary with its own wording", () => {
  const conflict = runCli(["profile", "--add", "work", "--direct", "--proxy"], {
    env: isolatedEnv(),
  });
  expect(conflict.exitCode).toBe(1);
  expect(conflict.stderr).toContain(
    "--direct and --proxy are mutually exclusive (a profile has ONE mode)",
  );
});

test("the mode conflict is rejected at the boundary on every command that takes the pair", () => {
  // Boundary parse runs before any per-command logic, so even invocations whose
  // command would error later (non---add profile, --mobile, --check) reject
  // the pair first.
  for (
    const argv of [
      ["models", "--direct", "--proxy"],
      ["profile", "--list", "--direct", "--proxy"],
      ["codex", "--mobile", "--direct", "--proxy"],
      ["claude", "--check", "--direct", "--proxy"],
    ]
  ) {
    const conflict = runCli([...argv], { env: isolatedEnv() });
    expect(conflict.exitCode).toBe(1);
    expect(conflict.stderr).toContain("--direct and --proxy are mutually exclusive");
  }
});

test("codex/claude reject flag combinations the old routing order silently resolved", () => {
  // `codex --check --direct` used to run the check and drop the mode;
  // `codex --mobile --check` used to run mobile and drop the check. Each
  // combination is now a boundary rejection (units in provider_mode.test.ts;
  // this pins the cli.ts wiring end-to-end).
  const cases: Array<{ argv: string[]; message: string }> = [
    { argv: ["codex", "--check", "--direct"], message: "does not combine with --direct/--proxy" },
    { argv: ["codex", "--mobile", "--check"], message: "--mobile is an interactive pairing flow" },
    { argv: ["claude", "--check", "--proxy"], message: "does not combine with --direct/--proxy" },
  ];
  for (const { argv, message } of cases) {
    const proc = runCli(argv, { env: isolatedEnv() });
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr).toContain(message);
  }
  // Three cold CLI spawns; generous headroom for loaded Windows CI runners.
}, 90_000);

test("codex --mobile refuses to run (non-TTY, or unsupported platform)", () => {
  // Spawned without a TTY: the interactive pairing flow must bail with a clear
  // message + exit 1 instead of hanging on a prompt. On macOS/Windows that's the
  // TTY guard ("interactive"); on Linux the platform gate fires first (no Codex
  // app there). Either way it refuses.
  const proc = runCli(["codex", "--mobile"], { env: isolatedEnv() });
  expect(proc.exitCode).toBe(1);
  const err = proc.stderr;
  if (process.platform === "darwin" || process.platform === "win32") {
    expect(err).toContain("interactive");
  } else {
    expect(err).toContain("macOS/Windows only");
  }
});

test("the CLI-install flag lives on shell, not init", () => {
  const shell = helpScreen("shell", "--help");
  const init = helpScreen("init", "--help");
  expect(shell.exitCode).toBe(0);
  expect(init.exitCode).toBe(0);
  expect(shell.output).toContain("--clis");
  expect(init.output).not.toContain("--clis");
  // init keeps the agent-config flags; shell does not configure agents. The
  // credential flags moved to `agent auth`, so init no longer carries --gh-token.
  expect(init.output).toContain("--direct");
  expect(init.output).not.toContain("--gh-token");
  expect(shell.output).not.toContain("--gh-token");
});

test("uninstall: help surfaces the flags; a non-TTY run without --yes refuses", () => {
  const help = helpScreen("uninstall", "--help");
  expect(help.exitCode).toBe(0);
  for (const flag of ["--yes", "--dry-run", "--force"]) {
    expect(help.output).toContain(flag);
  }

  // Spawned without a TTY and without --yes: the confirmation guard must bail
  // with a clear pointer to --yes (exit 1) instead of hanging on a prompt.
  const refused = runCli(["uninstall"], { env: isolatedEnv() });
  expect(refused.exitCode).toBe(1);
  expect(refused.stderr).toContain("--yes");
});

test("install --help surfaces the wiring flags; unknown flags are rejected", () => {
  const help = helpScreen("install", "--help");
  expect(help.exitCode).toBe(0);
  for (const flag of ["--no-shell-integration", "--all-hosts", "--assets-only"]) {
    expect(help.output).toContain(flag);
  }

  // Commander's declaration is the argv boundary: a flag from another command
  // (--clis lives on `shell`) must be rejected, never absorbed into an install.
  const unknown = runCli(["install", "--clis"], { env: isolatedEnv() });
  expect(unknown.exitCode).toBe(1);
  expect(unknown.stderr).toContain("unknown option");
  expect(unknown.stderr).toContain("--clis");
}, 30_000);

// In a checkout `install` builds the in-place plan (the checkout's own files are
// never rewritten), so what the flags observably steer is the shell wiring and
// the epilogue -- exactly the option mapping under test. Both rc seams point at
// a throwaway root, so the wiring runs for real without touching the machine.
test("bare install defaults to shell wiring; the negated and assets-only flags map through", () => {
  const root = mkdtempSync(join(tmpdir(), "copilot-install-smoke-"));
  const documents = join(root, "Documents");
  const wired = runCli(["install"], {
    env: isolatedEnv({
      HOME: root,
      SHELL: "/bin/bash",
      [CI_PS_DOCUMENTS_DIR_ENV]: documents,
      [CI_RC_DIR_ENV]: root,
    }),
  });
  expect({ exitCode: wired.exitCode, stderr: wired.stderr }).toMatchObject({ exitCode: 0 });
  expect(wired.stdout).toContain("Next steps:");
  const rcTargets = process.platform === "win32"
    ? ["WindowsPowerShell", "PowerShell"].map((edition) =>
      join(documents, edition, "Microsoft.PowerShell_profile.ps1")
    )
    : [join(root, ".bashrc")];
  for (const file of rcTargets) {
    expect(readFileSync(file, "utf-8")).toContain(SHELL_MARKER);
  }

  // --no-shell-integration: Commander's negated flag (opts.shellIntegration ===
  // false) must reach the runner as a skip, announced as such.
  const skipped = runCli(["install", "--no-shell-integration"], { env: isolatedEnv() });
  expect(skipped.exitCode).toBe(0);
  expect(skipped.stdout + skipped.stderr).toContain("Skipping shell integration");

  // --assets-only parses and stays machine-quiet: it is the step `agent update`
  // drives after the swap, so its stdout carries nothing for humans.
  const assetsOnly = runCli(["install", "--assets-only"], { env: isolatedEnv() });
  expect(assetsOnly.exitCode).toBe(0);
  expect(assetsOnly.stdout).toBe("");
  // Three cold CLI spawns; generous headroom for loaded Windows CI runners.
}, 90_000);

// `agent shell` wires whatever this platform's startup file is: the POSIX rc files under
// an isolated HOME, or the PowerShell $PROFILE under a redirected Documents folder. The
// Windows lookup asks the OS where Documents is, so no HOME override can move it --
// COPILOT_ENV_CI_PS_DOCUMENTS_DIR is the seam that can. Both targets are throwaway, so the
// wiring runs for real on every OS and the machine is never touched.
test("shell --clis --no-prereqs verifies only and wires this platform's startup file", () => {
  const root = mkdtempSync(join(tmpdir(), "copilot-shell-clis-"));
  const documents = join(root, "Documents");
  // Both seams point at the throwaway root, so this run is floor-proof: it cannot be
  // moved by an ambient rc-dir value, and it never reaches the machine's own files.
  // (The homedir()/$HOME fallback keeps its coverage in shell_integration.test.ts.)
  const ok = runCli(["shell", "--clis", "--no-prereqs"], {
    env: isolatedEnv({
      HOME: root,
      SHELL: "/bin/bash",
      [CI_PS_DOCUMENTS_DIR_ENV]: documents,
      [CI_RC_DIR_ENV]: root,
    }),
  });
  // Exit code asserted together with stderr, so a failure reports the child's real error
  // instead of a bare "expected 0".
  expect({ exitCode: ok.exitCode, stderr: ok.stderr }).toMatchObject({ exitCode: 0 });

  // Marker AND payload: a block that lost its `agents.*` path would still carry a marker.
  const windows = process.platform === "win32";
  const wired = windows
    ? ["WindowsPowerShell", "PowerShell"].map((edition) =>
      join(documents, edition, "Microsoft.PowerShell_profile.ps1")
    )
    : [join(root, ".bashrc")];
  const payload = windows ? "agents.ps1" : "agents.bashrc";
  for (const file of wired) {
    const content = readFileSync(file, "utf-8");
    expect(content).toContain(SHELL_MARKER);
    expect(content).toContain(payload);
  }
}, 30_000);

test("shell --clis --no-prereqs rejects --cooldown, never drops it", () => {
  // A cooldown has nothing to steer when nothing installs, so the boundary rejects the
  // pair (it used to be silently dropped). The optional-valued flag still PARSES in
  // every spelling -- the failure below is the boundary conflict, not a parse error.
  const root = mkdtempSync(join(tmpdir(), "copilot-shell-clis-"));
  for (const args of [["--cooldown"], ["--cooldown=0"], ["--cooldown", "14"]] as const) {
    const proc = runCli(["shell", "--clis", "--no-prereqs", ...args], {
      env: isolatedEnv({ HOME: root, SHELL: "/bin/bash" }),
    });
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr).toContain("--cooldown and --no-prereqs are mutually exclusive");
  }
  // Three cold CLI spawns; on a loaded Windows CI runner each cold start + TS
  // load can take several seconds, so allow generous headroom to avoid flaky timeouts.
}, 90_000);

test("the merged commands are gone; --gh-token is off the per-agent commands", () => {
  const rootOut = helpScreen("--help").output;
  // setup-clis / setup-shell / setup-launchers were folded into init/shell. The
  // cached help screen is the reintroduction guard: a re-registered command
  // would surface there (the CLI has a no-hidden-commands rule).
  for (const stale of ["setup-clis", "setup-shell", "setup-launchers"]) {
    expect(rootOut).not.toContain(stale);
  }

  // --gh-token now lives only on init, not on codex/claude.
  for (const cmd of ["codex", "claude"] as const) {
    const help = helpScreen(cmd, "--help");
    expect(help.exitCode).toBe(0);
    expect(help.output).not.toContain("--gh-token");
  }
});

test("--full-help prints the overview plus every subcommand's help", () => {
  const proc = helpScreen("--full-help");
  expect(proc.exitCode).toBe(0);
  // Top-level overview + a sampling of subcommand help sections.
  for (const needle of ["agent init", "agent shell", "agent start", "agent codex", "--clis"]) {
    expect(proc.stdout).toContain(needle);
  }
});

test("health --scope runtime exits 1 naming the failed checks when no proxy is running", () => {
  // Proxy-wired Codex (not both-direct) so a down proxy is a genuine failure;
  // the default port has nothing listening + isolated state => probe always fails.
  const proc = runCli(["health", "--scope", "runtime"], { env: isolatedProxyEnv({}) });
  expect(proc.exitCode).toBe(1);
  // The report must NAME a failed check: a bare exit 1 could come from any
  // crash in the child. The pid verdict is the deterministic one (the isolated
  // home tracks no pid; the port probe's wording could vary if something
  // unrelated happened to listen on the pinned 4199).
  const out = proc.stdout + proc.stderr;
  expect(out).toContain("no tracked copilot-api pid");
  expect(out).toContain("fix: agent start");
});

test("health --json emits a parseable report with scope/exitCode/checks", () => {
  const proc = runCli(["health", "--scope", "runtime", "--json"], { env: isolatedEnv({}) });
  const parsed = JSON.parse(proc.stdout);
  expect(parsed.scope).toBe("runtime");
  expect(typeof parsed.exitCode).toBe("number");
  expect(Array.isArray(parsed.checks)).toBe(true);
  expect(parsed.checks.map((c: { id: string }) => c.id)).toEqual(["runtime.port", "runtime.pid"]);
});

test("health --scope bogus exits 1 with a helpful message", () => {
  const proc = runCli(["health", "--scope", "bogus"], { env: isolatedEnv() });
  const out = proc.stdout + proc.stderr;
  expect(proc.exitCode).toBe(1);
  expect(out).toContain("--scope must be one of");
});

// --- profile-aware health ------------------------------------------------------

/** An isolated env with a seeded proxy profile 'p': store slot (gh-token, proxy),
 *  daemon home, and a reserved port in its run state -- plus throwaway agent
 *  homes so the wiring checks never read the real ~/.codex / ~/.claude. */
function seededProfileEnv(): Record<string, string> {
  const root = mkdtempSync(join(tmpdir(), "copilot-health-profile-"));
  const home = join(root, "api-home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, ".copilot-env-config.json"), JSON.stringify({ port: 4199 }));
  writeFileSync(
    join(home, ".copilot-env-state.json"),
    JSON.stringify({
      "profiles": {
        "p": { "githubToken": "fake-profile-token", "authProvider": "gh-token", "mode": "proxy" },
      },
    }),
  );
  const runDir = join(home, "profiles", "p", ".run", getSanitizedHostname());
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, ".state.json"), JSON.stringify({ port: 4555 }));
  return {
    ...process.env,
    CONSOLA_LEVEL: "5",
    COPILOT_API_HOME: home,
    CODEX_HOME: join(root, ".codex"),
    CLAUDE_CONFIG_DIR: join(root, ".claude"),
  };
}

interface ProfiledCheck {
  id: string;
  profile: string | null;
  status: string;
  detail: string;
  fix?: string;
}

test("health sweep reports a seeded proxy profile as its own runtime target", () => {
  const env = seededProfileEnv();
  const proc = runCli(["health", "--json"], { env });
  const json = JSON.parse(proc.stdout) as {
    profile: string | null;
    exitCode: number;
    checks: ProfiledCheck[];
  };
  expect(json.profile).toBeNull();
  // The profile's consistency check and daemon rows, stamped with its name.
  const consistency = json.checks.find((c) => c.id === "profile.consistency");
  expect(consistency?.profile).toBe("p");
  expect(consistency?.status).toBe("ok");
  const ports = json.checks.filter((c) => c.id === "runtime.port");
  expect(ports.map((c) => c.profile)).toEqual([null, "p"]);
  // Nothing listens on p's reserved 4555 and auto-start is off: the profile's
  // rows fail with the profile-addressed fix, and the exit code reflects it.
  const profilePort = ports.find((c) => c.profile === "p");
  expect(profilePort?.status).toBe("fail");
  expect(profilePort?.detail).toContain("4555");
  expect(profilePort?.fix).toBe("agent start --profile p");
  expect(json.exitCode).toBe(1);
  expect(proc.exitCode).toBe(1);
  // The fast launcher probe stays the default daemon alone.
  const fast = runCli(["health", "--scope", "runtime", "--json"], { env });
  const fastJson = JSON.parse(fast.stdout) as { checks: ProfiledCheck[] };
  expect(fastJson.checks.map((c) => `${c.id}@${c.profile}`)).toEqual([
    "runtime.port@null",
    "runtime.pid@null",
  ]);
}, 30_000);

test("health --profile narrows the run and excludes account-wide checks", () => {
  const env = seededProfileEnv();
  const proc = runCli(["health", "--profile", "p", "--json"], { env });
  const json = JSON.parse(proc.stdout) as {
    profile: string | null;
    exitCode: number;
    checks: ProfiledCheck[];
  };
  expect(json.profile).toBe("p");
  const ids = json.checks.map((c) => c.id);
  for (
    const id of [
      "profile.consistency",
      "runtime.port",
      "setup.auth",
      "setup.codex",
      "setup.claude",
    ]
  ) {
    expect(ids).toContain(id);
  }
  for (
    const id of [
      "bootstrap.version",
      "bootstrap.deno",
      "bootstrap.nodeModules",
      "proxy.package",
      "setup.shell",
      "setup.launchers",
      "setup.tool.node",
      "setup.tool.npm",
      "setup.codex-host",
      "setup.autoupdate",
    ]
  ) {
    expect(ids).not.toContain(id);
  }
  // Every check in a narrowed run describes the addressed profile.
  for (const c of json.checks) expect(c.profile).toBe("p");
  // The unwired agent homes read as interrupted profile wiring (warn), and the
  // down daemon fails -- both fixes address the profile.
  expect(json.checks.find((c) => c.id === "setup.codex")?.fix).toBe("agent profile --add p");
  expect(json.checks.find((c) => c.id === "runtime.port")?.fix).toBe("agent start --profile p");
  expect(json.exitCode).toBe(1);

  // The acceptance narrowing: --profile with the fast runtime scope.
  const narrowed = runCli(["health", "--profile", "p", "--scope", "runtime", "--json"], { env });
  const narrowedJson = JSON.parse(narrowed.stdout) as {
    profile: string | null;
    checks: ProfiledCheck[];
  };
  expect(narrowedJson.profile).toBe("p");
  expect(narrowedJson.checks.map((c) => c.id)).toEqual([
    "profile.consistency",
    "runtime.port",
    "runtime.pid",
  ]);
}, 30_000);

test("health --profile with an unknown name is a hard error naming the known profiles", () => {
  const proc = runCli(["health", "--profile", "nope"], { env: seededProfileEnv() });
  expect(proc.exitCode).toBe(1);
  const err = proc.stderr;
  expect(err).toContain("no such profile 'nope'");
  expect(err).toContain("known profiles: p");
});

// End-to-end coverage of the full diagnostic command: running the REAL
// `agent health` exercises the whole import graph plus the live probes (deno,
// node_modules, proxy package, runtime, shell wiring, CLIs, Codex), so it
// cross-validates the rest of the codebase the way the unit tests can't. An
// isolated COPILOT_API_HOME + a dead port make the runtime checks deterministic.
function runHealthJson(scope: string): { exitCode: number | null; json: HealthJson } {
  const proc = runCli(["health", "--scope", scope, "--json"], { env: isolatedProxyEnv({}) });
  return { exitCode: proc.exitCode, json: JSON.parse(proc.stdout) as HealthJson };
}

interface HealthJson {
  scope: string;
  ok: boolean;
  exitCode: number;
  checks: {
    id: string;
    group: string;
    status: string;
    detail: string;
    value?: Record<string, unknown>;
  }[];
}

test("health --scope full runs every group end-to-end and fails on a dead proxy", () => {
  const { exitCode, json } = runHealthJson("full");
  const ids = json.checks.map((c) => c.id);
  expect(json.scope).toBe("full");
  // Representative checks from each group are present.
  for (
    const id of [
      "bootstrap.deno",
      "proxy.package",
      "runtime.port",
      "setup.shell",
      "setup.codex",
      "setup.codex-host",
    ]
  ) {
    expect(ids).toContain(id);
  }
  // No daemon + isolated state => runtime fails => exit 1, ok=false.
  expect(json.exitCode).toBe(1);
  expect(json.ok).toBe(false);
  expect(exitCode).toBe(1);
  // Every check carries the structured fields the report/JSON rely on.
  for (const c of json.checks) {
    expect(typeof c.id).toBe("string");
    expect(typeof c.status).toBe("string");
    expect(typeof c.detail).toBe("string");
  }
  const codex = json.checks.find((c) => c.id === "setup.codex");
  expect(codex?.value?.providerMode).toBe("proxy");
  expect(typeof codex?.value?.configFile).toBe("string");
  expect(codex?.detail).toContain("provider: proxy");
  expect(codex?.detail).toContain("config.toml:");
}, 15_000);

test("health --scope proxy covers bootstrap+proxy+runtime, not setup", () => {
  const { json } = runHealthJson("proxy");
  const ids = json.checks.map((c) => c.id);
  expect(json.scope).toBe("proxy");
  expect(ids).toContain("proxy.package");
  expect(ids).toContain("runtime.port");
  expect(ids).not.toContain("setup.shell");
  expect(json.exitCode).toBe(1); // runtime unreachable
});

test("health --scope setup covers wiring only and never fails (warnings exit 0)", () => {
  const { exitCode, json } = runHealthJson("setup");
  const ids = json.checks.map((c) => c.id);
  expect(json.scope).toBe("setup");
  expect(ids).toContain("setup.shell");
  expect(ids).toContain("setup.codex");
  expect(ids).toContain("setup.codex-host");
  const codexHost = json.checks.find((c) => c.id === "setup.codex-host");
  // Unbuilt farm: optional on Linux/macOS (POSIX symlinks), unsupported on Windows.
  const expectedHostDetail = process.platform === "win32"
    ? "not built (unsupported on Windows)"
    : "not built (optional)";
  expect(codexHost?.detail).toBe(expectedHostDetail);
  expect(codexHost?.detail).not.toContain(String(codexHost?.value?.hostHome));
  expect(codexHost?.detail).not.toContain("config.toml:");
  expect(typeof codexHost?.value?.configFile).toBe("string");
  // Setup-only: no runtime/bootstrap checks can drag the exit code to 1.
  expect(ids).not.toContain("runtime.port");
  expect(ids).not.toContain("bootstrap.deno");
  expect(json.checks.every((c) => c.status !== "fail")).toBe(true);
  expect(json.exitCode).toBe(0);
  expect(exitCode).toBe(0);
}, 15_000);

test("health --scope codex covers only Codex wiring", () => {
  const { exitCode, json } = runHealthJson("codex");
  const ids = json.checks.map((c) => c.id);
  expect(json.scope).toBe("codex");
  expect(ids).toEqual(["setup.codex"]);
  expect(json.checks[0]?.value?.providerMode).toBe("proxy");
  expect(json.exitCode).toBe(0);
  expect(exitCode).toBe(0);
}, 15_000);

test("health --scope claude covers only Claude wiring (Code + Desktop)", () => {
  const home = mkdtempSync(join(tmpdir(), "copilot-claude-scope-"));
  // Proxy wiring (the proxy is Claude's default; CI has no gh/direct) =>
  // providerMode "proxy", status ok. Legacy helper-path wiring counts only with
  // the exact pre-inline file body in place.
  writeClaudeSettings(home, { apiKeyHelper: join(home, PROXY_HELPER_NAME) });
  writeFileSync(join(home, PROXY_HELPER_NAME), legacyProxyHelperScript());
  const proc = runCli(["health", "--scope", "claude", "--json"], {
    env: isolatedEnv({ CLAUDE_CONFIG_DIR: home }),
  });
  const json = JSON.parse(proc.stdout) as HealthJson;
  expect(json.scope).toBe("claude");
  expect(json.checks.map((c) => c.id)).toEqual(["setup.claude", "setup.claude-desktop"]);
  expect(json.checks[0]?.value?.providerMode).toBe("proxy");
  // The suite floor's Desktop seam points at a dir that never exists: no app, no drift.
  expect(json.checks[1]?.status).toBe("ok");
  expect(json.checks[1]?.detail).toContain("not detected");
  expect(json.exitCode).toBe(0);
}, 15_000);

// --- autoupdate management flags --------------------------------------------

test("update --auto-status reports the auto-update key honestly, on and off (offline, read-only)", () => {
  // The key half of the line is exact per stored value; the last-check half comes from
  // the install root's own throttle state, which a child cannot be pointed away from.
  for (const [autoUpdate, word] of [[true, "enabled"], [false, "disabled"]] as const) {
    const home = mkdtempSync(join(tmpdir(), "copilot-autostatus-"));
    writeFileSync(
      join(home, ".copilot-env-config.json"),
      JSON.stringify({ autoUpdate, updateCooldown: 3 }),
    );
    const proc = runCli(["update", "--auto-status"], {
      env: isolatedEnv({ COPILOT_API_HOME: home }),
    });
    expect(proc.exitCode, word).toBe(0);
    expect(proc.stdout + proc.stderr, word).toContain(
      `Autoupdate: ${word} (the auto-update config key) | cooldown 3d | last check `,
    );
  }
});

// `--no-index` is a Commander negated flag (stored as `index: false`); only a real
// parse proves the mapping onto runCost's `noIndex`. The pricing URL points at a
// closed local port so the run prices nothing and never leaves the machine.
test("cli.ts cost --no-index parses every log; without it the usage index is used", () => {
  const env = isolatedEnv();
  const projects = join(env.CLAUDE_CONFIG_DIR ?? "", "projects", "-Users-x-proj");
  mkdirSync(projects, { recursive: true });
  writeFileSync(
    join(projects, "aaa.jsonl"),
    `${
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-01T10:00:00.000Z",
        message: {
          id: "msg_1",
          model: "claude-opus-4-8",
          role: "assistant",
          usage: { "input_tokens": 10, "output_tokens": 20 },
        },
      })
    }\n`,
  );
  const runtimeOf = (...flags: string[]) => {
    const proc = runCli(
      ["cost", "--json", "--pricing-url", "https://127.0.0.1:9/models", ...flags],
      { env },
    );
    expect(proc.exitCode).toBe(0);
    return JSON.parse(proc.stdout).runtime as { indexed: boolean };
  };
  expect(runtimeOf().indexed).toBe(true);
  expect(runtimeOf("--no-index").indexed).toBe(false);
  expect(helpScreen("cost", "--help").output).toContain("--no-index");
});

// `--pricing-url` has no Commander default on purpose: an omitted flag must fall through to
// the stored `pricing-url` key. Only the price CACHE tells the two URLs apart from outside
// (warnings never name a URL): a stale cache seeded for the stored URL prices the run when
// the stored URL is used and cannot when the flag points elsewhere.
test("cli.ts cost prices at the stored pricing-url when the flag is omitted, and the flag overrides it", async () => {
  const env = isolatedEnv();
  const projects = join(env.CLAUDE_CONFIG_DIR ?? "", "projects", "-Users-x-proj");
  mkdirSync(projects, { recursive: true });
  writeFileSync(
    join(projects, "aaa.jsonl"),
    `${
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-01T10:00:00.000Z",
        message: {
          id: "msg_1",
          model: "claude-opus-4-8",
          role: "assistant",
          usage: { "input_tokens": 10, "output_tokens": 20 },
        },
      })
    }\n`,
  );
  const storedUrl = "https://127.0.0.1:9/stored/models";
  const flagUrl = "https://127.0.0.1:9/flag/models";
  const priced = ((): Promise<Response> =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          data: [{
            id: "anthropic/claude-opus-4.8",
            pricing: { prompt: "0.000015", completion: "0.000075" },
          }],
        }),
        { status: 200 },
      ),
    )) as typeof fetch;
  // Two days old: expired, so the run refreshes (fails at 127.0.0.1:9) and falls back to it.
  await loadPricing(storedUrl, {
    cacheDir: join(env.COPILOT_API_HOME ?? "", USAGE_INDEX_DIR_NAME),
    nowMs: Date.now() - 2 * MILLISECONDS_PER_DAY,
    fetchImpl: priced,
  });
  expect(runCli(["config", "--set", "pricing-url", storedUrl], { env }).exitCode).toBe(0);

  const totalUsdOf = (...flags: string[]) => {
    const proc = runCli(["cost", "--json", "--no-index", ...flags], { env });
    expect(proc.exitCode).toBe(0);
    expect(proc.stderr).not.toContain("127.0.0.1");
    return JSON.parse(proc.stdout).claudeSessions.totalUsd as number;
  };
  // 10 in at $15/M + 20 out at $75/M, from the stored URL's cache.
  expect(totalUsdOf()).toBe(0.0017);
  // The flag's URL has no cache and cannot be fetched: tokens only.
  expect(totalUsdOf("--pricing-url", flagUrl)).toBe(0);
});
