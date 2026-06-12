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

test("posixBlock safely quotes paths with shell metacharacters", () => {
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

test("cx launchers start the proxy only for proxy-backed Codex configs", () => {
  const posix = readFileSync(join(process.cwd(), "shell", "agents.launchers.bashrc"), "utf8");
  const posixCx = shellFunctionBody(posix, "cx");
  // Check-only: read the configured provider (no live probe), and re-sync proxy.
  expect(posixCx).toContain("codex --check");
  expect(posixCx).toContain("codex --proxy");
  expect(posixCx).toContain("_codex_provider_status");
  expect(posixCx).toContain("-eq 0");
  expect(posixCx).toContain("-eq 2");
  expect(posixCx).toContain("_copilot_ensure_server");
  expect(posixCx).not.toContain("--json");
  expect(posixCx).not.toContain("jq");
  expect(posix).not.toContain("_copilot_codex_config_file");
  expect(posix).not.toContain("_copilot_codex_uses_proxy");
  // The launcher reconfigures proxy only; it never runs the live auto-detect.
  expect(posixCx).not.toContain("--auto");

  const powershell = readFileSync(join(process.cwd(), "shell", "agents.launchers.ps1"), "utf8");
  const powershellCx = shellFunctionBody(powershell, "cx");
  expect(powershellCx).toContain("codex --check");
  expect(powershellCx).toContain("codex --proxy");
  expect(powershellCx).toContain("$codexProviderStatus");
  expect(powershellCx).toContain("$codexProviderStatus -eq 2");
  expect(powershellCx).toContain("$codexProviderStatus -ne 0");
  expect(powershellCx).toContain("Confirm-CopilotServer");
  expect(powershellCx).not.toContain("--json");
  expect(powershellCx).not.toContain("jq");
  expect(powershell).not.toContain("Get-CodexConfigPath");
  expect(powershell).not.toContain("Test-CodexProxyProvider");
  expect(powershellCx).not.toContain("--auto");
});
