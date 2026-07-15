import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  posixBlock,
  posixLaunchersBlock,
  quotePosix,
  quotePowerShell,
  windowsExecutionPolicyCommand,
} from "../src/commands/shell_integration.ts";

// `agent shell` wires/unwires the rc block. Exercise the POSIX path by
// running the CLI with a throwaway $HOME so we never touch the real rc files.

const MARKER = "# copilot-env shell integration";
const LAUNCHERS_MARKER = "# copilot-env launchers";
// On win32 the command takes the Windows code path (writes the PS $PROFILE, not an
// rc file), so these POSIX-behavior tests only run off Windows.
const skipWin = test.skipIf(process.platform === "win32");
let home = "";

function shellFunctionBody(source: string, name: string): string {
  const match = source.match(new RegExp(`function ${name} \\{([\\s\\S]*?)\\n\\}`));
  if (!match) throw new Error(`function ${name} not found`);
  return match[1] as string;
}

function run(...args: string[]): { code: number; out: string } {
  const proc = Bun.spawnSync(["bun", "src/cli.ts", "shell", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: home, SHELL: "/bin/bash", CONSOLA_LEVEL: "5" },
  });
  return { code: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString() };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "copilot-si-"));
});
afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
});

skipWin("wires the integration into a freshly created rc file", () => {
  const { code } = run();
  expect(code).toBe(0);
  const rc = readFileSync(join(home, ".bashrc"), "utf-8");
  expect(rc).toContain(MARKER);
  expect(rc).toContain("agents.bashrc");
});

skipWin("is idempotent -- a second wire is byte-for-byte identical", () => {
  run();
  const first = readFileSync(join(home, ".bashrc"), "utf-8");
  run();
  const second = readFileSync(join(home, ".bashrc"), "utf-8");
  expect(second).toBe(first); // no duplicate block, no reordering
  expect(second.split(MARKER).length - 1).toBe(1);
});

skipWin("re-wiring refreshes the block in place without reordering later lines", () => {
  // A stale block followed by a user line that must stay AFTER the integration.
  const stale = `${MARKER}\nAGENTS_BASHRC="/old/agents.bashrc"\n[ -f "$AGENTS_BASHRC" ] && source "$AGENTS_BASHRC"`;
  writeFileSync(join(home, ".bashrc"), `export BEFORE=1\n\n${stale}\n\nexport AFTER=1\n`);
  run();
  const rc = readFileSync(join(home, ".bashrc"), "utf-8");
  expect(rc).toContain("shell/agents.bashrc"); // migrated in place
  expect(rc).not.toContain("/old/agents.bashrc");
  // BEFORE still precedes the block; AFTER still follows it.
  expect(rc.indexOf("export BEFORE=1")).toBeLessThan(rc.indexOf(MARKER));
  expect(rc.indexOf(MARKER)).toBeLessThan(rc.indexOf("export AFTER=1"));
});

skipWin("--remove strips the block back out", () => {
  run();
  expect(readFileSync(join(home, ".bashrc"), "utf-8")).toContain(MARKER);
  const { code } = run("--remove");
  expect(code).toBe(0);
  expect(readFileSync(join(home, ".bashrc"), "utf-8")).not.toContain(MARKER);
});

skipWin("shell wires and removes the integration", () => {
  expect(run().code).toBe(0);
  expect(readFileSync(join(home, ".bashrc"), "utf-8")).toContain(MARKER);
  expect(run("--remove").code).toBe(0);
  expect(readFileSync(join(home, ".bashrc"), "utf-8")).not.toContain(MARKER);
});

skipWin("wires an existing rc without clobbering its contents", () => {
  writeFileSync(join(home, ".bashrc"), "export EXISTING=1\n");
  run();
  const rc = readFileSync(join(home, ".bashrc"), "utf-8");
  expect(rc).toContain("export EXISTING=1");
  expect(rc).toContain(MARKER);
});

skipWin("--remove strips a CRLF-written block (Windows-style line endings)", () => {
  // Simulate a block written with CRLF (e.g. old PowerShell Add-Content / a CRLF rc).
  const block = `\r\n${MARKER}\r\nAGENTS_BASHRC="/x/agents.bashrc"\r\n[ -f "$AGENTS_BASHRC" ] && source "$AGENTS_BASHRC"\r\n`;
  writeFileSync(join(home, ".bashrc"), `export KEEP=1\r\n${block}`);
  const { code } = run("--remove");
  expect(code).toBe(0);
  const rc = readFileSync(join(home, ".bashrc"), "utf-8");
  expect(rc).not.toContain(MARKER);
  expect(rc).toContain("export KEEP=1");
});

skipWin("shell --launchers adds the opt-in launchers block; default does not", () => {
  run();
  let rc = readFileSync(join(home, ".bashrc"), "utf-8");
  expect(rc).toContain(MARKER);
  expect(rc).not.toContain(LAUNCHERS_MARKER);
  // Re-running with --launchers adds the launchers block without duplicating the
  // integration block (incremental opt-in).
  run("--launchers");
  rc = readFileSync(join(home, ".bashrc"), "utf-8");
  expect(rc).toContain("agents.launchers.bashrc");
  expect(rc.split(MARKER).length - 1).toBe(1);
  expect(rc.split(LAUNCHERS_MARKER).length - 1).toBe(1);
});

skipWin("shell --launchers wires the opt-in launchers block", () => {
  expect(run("--launchers").code).toBe(0);
  const rc = readFileSync(join(home, ".bashrc"), "utf-8");
  expect(rc).toContain(MARKER);
  expect(rc).toContain(LAUNCHERS_MARKER);
});

skipWin("shell --launchers --remove strips only the launchers block", () => {
  expect(run("--launchers").code).toBe(0);
  let rc = readFileSync(join(home, ".bashrc"), "utf-8");
  expect(rc).toContain(MARKER);
  expect(rc).toContain(LAUNCHERS_MARKER);

  expect(run("--launchers", "--remove").code).toBe(0);
  rc = readFileSync(join(home, ".bashrc"), "utf-8");
  expect(rc).toContain(MARKER);
  expect(rc).not.toContain(LAUNCHERS_MARKER);
});

skipWin("--remove strips both the integration and launchers blocks", () => {
  run("--launchers");
  const wired = readFileSync(join(home, ".bashrc"), "utf-8");
  expect(wired).toContain(MARKER);
  expect(wired).toContain(LAUNCHERS_MARKER);
  run("--remove");
  const rc = readFileSync(join(home, ".bashrc"), "utf-8");
  expect(rc).not.toContain(MARKER);
  expect(rc).not.toContain(LAUNCHERS_MARKER);
});

skipWin("re-wiring migrates a stale block to the current shell/ path", () => {
  // Simulate a pre-`shell/`-move block that points at the old root-level agents.bashrc.
  const stale = `\n${MARKER}\nAGENTS_BASHRC="/old/agents.bashrc"\n[ -f "$AGENTS_BASHRC" ] && source "$AGENTS_BASHRC"\n`;
  writeFileSync(join(home, ".bashrc"), `export KEEP=1\n${stale}`);
  run();
  const rc = readFileSync(join(home, ".bashrc"), "utf-8");
  expect(rc).toContain("export KEEP=1"); // user content preserved
  expect(rc).toContain("shell/agents.bashrc"); // migrated to the new path
  expect(rc).not.toContain("/old/agents.bashrc"); // stale path gone
  expect(rc.split(MARKER).length - 1).toBe(1); // exactly one block, not duplicated
});

skipWin("a plain re-wire preserves an already-wired launchers block", () => {
  run("--launchers");
  expect(readFileSync(join(home, ".bashrc"), "utf-8")).toContain(LAUNCHERS_MARKER);
  // Re-running plain shell wiring must not drop the user's launchers block.
  run();
  const rc = readFileSync(join(home, ".bashrc"), "utf-8");
  expect(rc).toContain(LAUNCHERS_MARKER);
  expect(rc.split(LAUNCHERS_MARKER).length - 1).toBe(1);
});

skipWin("posixBlock safely quotes paths with shell metacharacters", () => {
  // A path containing a single quote, $, backtick, and a space must round-trip
  // through `source` as the exact literal -- never expand or break parsing.
  const weird = "/tmp/we'ird $dir/`x`/agents.bashrc";
  const blockFile = join(home, "block.sh");
  writeFileSync(blockFile, posixBlock(weird));
  const proc = Bun.spawnSync([
    "bash",
    "-c",
    `source "$1"; printf %s "$AGENTS_BASHRC"`,
    "bash",
    blockFile,
  ]);
  expect(proc.stdout.toString()).toBe(weird);
});

test("quotePosix / quotePowerShell escape embedded single quotes", () => {
  expect(quotePosix("a'b")).toBe("'a'\\''b'");
  expect(quotePowerShell("a'b")).toBe("'a''b'");
});

test("windows execution policy command skips unavailable policy cmdlets", () => {
  const command = windowsExecutionPolicyCommand();
  expect(command).toContain("Get-Command Get-ExecutionPolicy -ErrorAction Stop");
  expect(command).toContain("Get-Command Set-ExecutionPolicy -ErrorAction Stop");
  expect(command).toContain("catch");
  expect(command).toContain("exit 0");
  // Desktop (5.1) inherits pwsh's PSModulePath when spawned from pwsh and the policy cmdlets
  // fail to autoload; reset it to the machine default so they resolve. Core is left alone.
  expect(command).toContain("$PSVersionTable.PSEdition -eq 'Desktop'");
  expect(command).toContain("[Environment]::GetEnvironmentVariable('PSModulePath','Machine')");
  expect(command).toContain(
    "Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force",
  );
});

test("posixLaunchersBlock sources the launchers file under its own marker", () => {
  const block = posixLaunchersBlock("/x/shell/agents.launchers.bashrc");
  expect(block).toContain(LAUNCHERS_MARKER);
  expect(block).toContain("agents.launchers.bashrc");
  // Distinct marker from the integration block, so removal can target each.
  expect(block).not.toContain(MARKER);
});

test("both launcher shell files exist for the env-emitted source directive", () => {
  // env.ts emits `source <shell/agents.launchers.{bashrc,ps1}>`; keep both present so
  // the wired path can never point at a missing file.
  expect(readFileSync(join(process.cwd(), "shell", "agents.launchers.bashrc"), "utf8")).toContain(
    "function cl",
  );
  expect(readFileSync(join(process.cwd(), "shell", "agents.launchers.ps1"), "utf8")).toContain(
    "function cl",
  );
});

test("the PowerShell agent wrapper evals every env line, mirroring the POSIX eval", () => {
  // agents.bashrc evals the whole `agent env` output unconditionally; the PS
  // wrapper must do the same (Invoke-Expression on every non-blank line, no
  // shape-matching filter), so a new upstream directive shape is never
  // silently dropped on Windows.
  const ps1 = readFileSync(join(process.cwd(), "shell", "agents.ps1"), "utf8");
  expect(ps1).toContain("Invoke-Expression");
  expect(ps1).not.toContain("$line -match");
});

test("env-refresh stderr parity: eager source is silenced, the agent wrapper's refresh is not (POSIX)", () => {
  const posix = readFileSync(join(process.cwd(), "shell", "agents.bashrc"), "utf8");

  // The eager startup `agent env` call silences stderr so bootstrap noise
  // doesn't break the prompt's instant-prompt guard.
  expect(posix).toMatch(/bin\/agent" env "\$@" 2>\/dev\/null/);

  // The `agent` wrapper's refresh must NOT silence stderr -- a genuine failure
  // should stay visible. Assert the refresh line and that it carries no redirect.
  const body = shellFunctionBody(posix, "agent");
  const refresh = body.split("\n").find((line) => line.includes('bin/agent" env)'));
  expect(refresh).toBeDefined();
  expect(refresh).toMatch(/_env="\$\("\$\{_COPILOT_AGENTS_DIR\}\/bin\/agent" env\)" && eval/);
  expect(refresh).not.toContain("2>/dev/null");
});

test("env-refresh stderr parity: Import-CopilotEnv takes -Quiet, eager passes it, the agent wrapper omits it (PowerShell)", () => {
  const powershell = readFileSync(join(process.cwd(), "shell", "agents.ps1"), "utf8");

  // Import-CopilotEnv declares a [switch]$Quiet param that gates the 2>$null redirect.
  expect(powershell).toMatch(/function Import-CopilotEnv\s*\{\s*param\(\[switch\]\$Quiet\)/);
  expect(powershell).toMatch(/if \(\$Quiet\) \{ Invoke-Agent env --format powershell 2>\$null \}/);

  // The eager startup call passes -Quiet to silence bootstrap noise.
  expect(powershell).toMatch(/Import-CopilotEnv -Quiet/);

  // The `agent` wrapper calls Import-CopilotEnv WITHOUT -Quiet so a real
  // refresh failure stays visible (mirrors the POSIX unsilenced refresh).
  const agentBody = shellFunctionBody(powershell, "agent");
  const refresh = agentBody.split("\n").find((line) => line.includes("Import-CopilotEnv"));
  expect(refresh).toBeDefined();
  expect(refresh?.trim()).toBe("Import-CopilotEnv");
  expect(refresh).not.toContain("-Quiet");
});

test("cx launchers start the proxy only for proxy-backed Codex configs", () => {
  const posix = readFileSync(join(process.cwd(), "shell", "agents.launchers.bashrc"), "utf8");
  // cl/cx delegate the provider sync to the shared helper.
  expect(shellFunctionBody(posix, "cx")).toContain("_copilot_wire_provider codex cx Codex");
  expect(shellFunctionBody(posix, "cl")).toContain("_copilot_wire_provider claude cl Claude");
  // Check-only: read the configured provider (no live probe), and re-sync proxy.
  const posixWire = shellFunctionBody(posix, "_copilot_wire_provider");
  expect(posixWire).toContain("--check");
  expect(posixWire).toContain("--proxy");
  expect(posixWire).toContain("_copilot_provider_status");
  expect(posixWire).toContain("-eq 0");
  expect(posixWire).toContain("-eq 2");
  expect(posixWire).toContain("_copilot_ensure_server");
  expect(posixWire).not.toContain("--json");
  expect(posixWire).not.toContain("jq");
  expect(posix).not.toContain("_copilot_codex_config_file");
  expect(posix).not.toContain("_copilot_codex_uses_proxy");
  // The launcher reconfigures proxy only; it never runs the live auto-detect.
  expect(posixWire).not.toContain("--auto");

  const powershell = readFileSync(join(process.cwd(), "shell", "agents.launchers.ps1"), "utf8");
  expect(shellFunctionBody(powershell, "cx")).toContain(
    "Sync-AgentProvider -Agent codex -Launcher cx -Display Codex",
  );
  expect(shellFunctionBody(powershell, "cl")).toContain(
    "Sync-AgentProvider -Agent claude -Launcher cl -Display Claude",
  );
  const powershellWire = shellFunctionBody(powershell, "Sync-AgentProvider");
  expect(powershellWire).toContain("--check");
  expect(powershellWire).toContain("--proxy");
  expect(powershellWire).toContain("$status -eq 2");
  expect(powershellWire).toContain("$status -ne 0");
  expect(powershellWire).toContain("Confirm-CopilotServer");
  expect(powershellWire).not.toContain("--json");
  expect(powershellWire).not.toContain("jq");
  expect(powershell).not.toContain("Get-CodexConfigPath");
  expect(powershell).not.toContain("Test-CodexProxyProvider");
  expect(powershellWire).not.toContain("--auto");
});
