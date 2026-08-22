import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIRECT_HELPER_NAME, PROXY_HELPER_NAME } from "../src/claude/paths.ts";
import { CI_PS_DOCUMENTS_DIR_ENV, MARKER as SHELL_MARKER } from "../src/shell/integration.ts";
import { getSanitizedHostname } from "../src/utils/hostname.ts";
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

test("cli.ts mcp --serve --profile '' hard-fails instead of serving the default credential", () => {
  // A supplied-but-blank --profile (an unset shell var in `--profile "$P"`) must
  // never silently resolve the DEFAULT credential (the named-profile hard-fail rule).
  const blank = runCli(["mcp", "--serve", "--profile", ""], {
    env: { ...process.env, CONSOLA_LEVEL: "5" },
  });
  expect(blank.exitCode).not.toBe(0);
  expect(blank.stderr).toContain("--profile expects a profile name");
});

for (const args of [["shell"]] as const) {
  test(`cli.ts ${args.join(" ")} --help loads command help and exits 0`, () => {
    const { exitCode, output } = helpScreen(...args, "--help");

    expect(exitCode).toBe(0);
    expect(output).toContain(args[0]);
  });
}

test("env --help surfaces --format and --profile", () => {
  const help = helpScreen("env", "--help");
  expect(help.exitCode).toBe(0);
  expect(help.output).toContain("--format");
  expect(help.output).toContain("--profile");
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
  // The per-host farm flags live on `codex` too, not a separate command.
  expect(helpOut).toContain("--host");
  expect(helpOut).toContain("--delete-host");
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
  // command would error later (non---add profile, --mobile) reject the pair first.
  for (
    const argv of [
      ["models", "--direct", "--proxy"],
      ["profile", "--list", "--direct", "--proxy"],
      ["codex", "--mobile", "--direct", "--proxy"],
    ]
  ) {
    const conflict = runCli([...argv], { env: isolatedEnv() });
    expect(conflict.exitCode).toBe(1);
    expect(conflict.stderr).toContain("--direct and --proxy are mutually exclusive");
  }
});

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

test("the launcher / CLI-install flags live on shell, not init", () => {
  const shell = helpScreen("shell", "--help");
  const init = helpScreen("init", "--help");
  expect(shell.exitCode).toBe(0);
  expect(init.exitCode).toBe(0);
  for (const flag of ["--launchers", "--clis"]) {
    expect(shell.output).toContain(flag);
    expect(init.output).not.toContain(flag);
  }
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

test("shell --help surfaces the install/launcher flags", () => {
  const help = helpScreen("shell", "--help");
  expect(help.exitCode).toBe(0);
  for (
    const flag of [
      "--launchers",
      "--clis",
      "--cooldown",
      "--no-sudo",
      "--no-prereqs",
      "--remove",
    ]
  ) {
    expect(help.output).toContain(flag);
  }
});

// `agent shell` wires whatever this platform's startup file is: the POSIX rc files under
// an isolated HOME, or the PowerShell $PROFILE under a redirected Documents folder. The
// Windows lookup asks the OS where Documents is, so no HOME override can move it --
// COPILOT_ENV_CI_PS_DOCUMENTS_DIR is the seam that can. Both targets are throwaway, so the
// wiring runs for real on every OS and the machine is never touched.
test("shell --clis --no-prereqs verifies only and wires this platform's startup file", () => {
  const root = mkdtempSync(join(tmpdir(), "copilot-shell-clis-"));
  const documents = join(root, "Documents");
  const ok = runCli(["shell", "--clis", "--no-prereqs"], {
    env: isolatedEnv({ HOME: root, SHELL: "/bin/bash", [CI_PS_DOCUMENTS_DIR_ENV]: documents }),
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
  // setup-clis / setup-shell / setup-launchers were folded into init/shell.
  for (const stale of ["setup-clis", "setup-shell", "setup-launchers"]) {
    expect(rootOut).not.toContain(stale);
    const gone = runCli([stale], { env: { ...process.env, CONSOLA_LEVEL: "5" } });
    expect(gone.exitCode).not.toBe(0);
    expect(gone.stderr).toContain("unknown command");
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

test("health --help surfaces --scope and --json", () => {
  const help = helpScreen("health", "--help");
  expect(help.exitCode).toBe(0);
  expect(help.output).toContain("--scope");
  expect(help.output).toContain("--json");
});

test("health --scope runtime exits 1 when no proxy is running", () => {
  // Proxy-wired Codex (not both-direct) so a down proxy is a genuine failure;
  // the default port has nothing listening + isolated state => probe always fails.
  const proc = runCli(["health", "--scope", "runtime"], { env: isolatedProxyEnv({}) });
  expect(proc.exitCode).toBe(1);
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
// `agent health` exercises the whole import graph plus the live probes (bun,
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

test("health --scope claude covers only Claude wiring", () => {
  const home = mkdtempSync(join(tmpdir(), "copilot-claude-scope-"));
  // Proxy wiring (the proxy is Claude's default; CI has no gh/direct) =>
  // providerMode "proxy", status ok.
  writeClaudeSettings(home, { apiKeyHelper: join(home, PROXY_HELPER_NAME) });
  const proc = runCli(["health", "--scope", "claude", "--json"], {
    env: isolatedEnv({ CLAUDE_CONFIG_DIR: home }),
  });
  const json = JSON.parse(proc.stdout) as HealthJson;
  expect(json.scope).toBe("claude");
  expect(json.checks.map((c) => c.id)).toEqual(["setup.claude"]);
  expect(json.checks[0]?.value?.providerMode).toBe("proxy");
  expect(json.exitCode).toBe(0);
}, 15_000);

// --- autoupdate management flags --------------------------------------------

test("start --help documents its flags including --force", () => {
  const help = helpScreen("start", "--help");
  expect(help.exitCode).toBe(0);
  for (const flag of ["--dry-run", "--port", "--record-event", "--check", "--force"]) {
    expect(help.output).toContain(flag);
  }
});

test("update --help documents the autoupdate flags alongside the manual ones", () => {
  const help = helpScreen("update", "--help");
  expect(help.exitCode).toBe(0);
  for (const flag of ["--auto", "--no-auto", "--auto-status", "--check", "--force"]) {
    expect(help.output).toContain(flag);
  }
});

test("update --auto-status reports status and exits 0 (offline, read-only)", () => {
  const proc = runCli(["update", "--auto-status"], { env: { ...process.env, CONSOLA_LEVEL: "5" } });
  const out = proc.stdout + proc.stderr;
  expect(proc.exitCode).toBe(0);
  expect(out).toContain("Autoupdate:");
});
