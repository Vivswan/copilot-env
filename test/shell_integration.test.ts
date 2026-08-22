import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
  cheapWindowsProfilePaths,
  CI_PS_DOCUMENTS_DIR_ENV,
  CI_RC_DIR_ENV,
  launchersWired,
  posixBlock,
  posixLaunchersBlock,
  quotePosix,
  quotePowerShell,
  rcFiles,
  windowsExecutionPolicyCommand,
  windowsProfileTarget,
} from "../src/shell/integration.ts";
import { runCli, runSync } from "./helpers/run.ts";
import { afterEach, beforeEach, expect, test } from "./helpers/testing.ts";

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

/** Run `body` with env var `name` set to `value`, or cleared when null, restoring the
 *  prior value afterwards and returning whatever `body` returned. It mutates this
 *  process because deno's spawnSync MERGES the parent environment: a key merely absent
 *  from a child's `env` option still arrives from the parent, so clearing has to happen
 *  here to take effect there. */
function withEnv<T>(name: string, value: string | null, body: () => T): T {
  const previous = process.env[name];
  if (value === null) delete process.env[name];
  else process.env[name] = value;
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

function run(...args: string[]): { code: number | null; out: string } {
  // These tests drive the homedir()/$HOME path on purpose, so the rc-dir seam must not
  // reach the child: it outranks $HOME, and a suite-wide floor may set it.
  const proc = withEnv(CI_RC_DIR_ENV, null, () =>
    runCli(["shell", ...args], {
      env: { ...process.env, HOME: home, SHELL: "/bin/bash", CONSOLA_LEVEL: "5" },
    }));
  return { code: proc.exitCode, out: proc.stdout + proc.stderr };
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
  const stale =
    `${MARKER}\nAGENTS_BASHRC="/old/agents.bashrc"\n[ -f "$AGENTS_BASHRC" ] && source "$AGENTS_BASHRC"`;
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
  const block =
    `\r\n${MARKER}\r\nAGENTS_BASHRC="/x/agents.bashrc"\r\n[ -f "$AGENTS_BASHRC" ] && source "$AGENTS_BASHRC"\r\n`;
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
  const stale =
    `\n${MARKER}\nAGENTS_BASHRC="/old/agents.bashrc"\n[ -f "$AGENTS_BASHRC" ] && source "$AGENTS_BASHRC"\n`;
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
  const proc = runSync("bash", [
    "-c",
    `source "$1"; printf %s "$AGENTS_BASHRC"`,
    "bash",
    blockFile,
  ]);
  expect(proc.stdout).toBe(weird);
});

test("quotePosix / quotePowerShell escape embedded single quotes", () => {
  expect(quotePosix("a'b")).toBe("'a'\\''b'");
  expect(quotePowerShell("a'b")).toBe("'a''b'");
});

test("the Windows $PROFILE lookup honors the Documents redirect on every OS", () => {
  // The real lookup asks Windows itself where Documents is: unreachable from a POSIX
  // test and unredirectable on Windows. Under the redirect it is pure path math, so
  // resolving it here at all is the proof that PowerShell was never spawned.
  const documents = join(home, "Documents");
  withEnv(CI_PS_DOCUMENTS_DIR_ENV, documents, () => {
    // One filename per call, under each PowerShell edition's directory.
    expect(windowsProfileTarget(false).paths).toEqual([
      join(documents, "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1"),
      join(documents, "PowerShell", "Microsoft.PowerShell_profile.ps1"),
    ]);
    expect(windowsProfileTarget(true).paths).toEqual([
      join(documents, "WindowsPowerShell", "profile.ps1"),
      join(documents, "PowerShell", "profile.ps1"),
    ]);
    // Not the machine's own profile -- what stops the caller relaxing its policy.
    expect(windowsProfileTarget(false).source).toBe("redirected");
  });
});

test("both profile resolvers land on the same redirected tree", () => {
  // The authoritative resolver wires; the cheap one (behind `agent env`) inspects. Let
  // them disagree and a redirected run wires the launchers, then reports them unwired.
  const documents = join(home, "Documents");
  withEnv(CI_PS_DOCUMENTS_DIR_ENV, documents, () => {
    expect(new Set(cheapWindowsProfilePaths())).toEqual(
      new Set([...windowsProfileTarget(false).paths, ...windowsProfileTarget(true).paths]),
    );
  });
});

test("a set-but-unusable seam value is refused by every resolver", () => {
  // Quietly falling back to the machine's real startup file is the one failure a seam
  // whose job is isolation must not have: an empty value is an unexpanded interpolation,
  // a relative one resolves off the cwd. Windows cannot hold an empty env var (it reads
  // back as unset), so that case is only assertable where the OS preserves it.
  const relative = ["Documents", "./Documents"];
  const bad = process.platform === "win32" ? relative : ["", ...relative];
  for (const value of bad) {
    withEnv(CI_PS_DOCUMENTS_DIR_ENV, value, () => {
      expect(() => windowsProfileTarget(false)).toThrow("must be an absolute path");
      expect(() => cheapWindowsProfilePaths()).toThrow("must be an absolute path");
    });
    withEnv(CI_RC_DIR_ENV, value, () => {
      expect(() => rcFiles(true)).toThrow("must be an absolute path");
    });
  }
});

test("the POSIX rc lookup honors the rc-dir seam on every OS", () => {
  // homedir() does follow $HOME on POSIX, so this seam is not about reachability like its
  // Windows twin -- it is the floor that stops a test which forgot to isolate $HOME from
  // landing in the developer's real ~/.bashrc.
  const rcDir = join(home, "rc");
  mkdirSync(rcDir, { recursive: true });
  writeFileSync(join(rcDir, ".bashrc"), "export EXISTING=1\n");
  withEnv(CI_RC_DIR_ENV, rcDir, () => {
    expect(rcFiles(true)).toEqual([join(rcDir, ".bashrc")]);
    // With no rc file present the wiring path falls back to one named for $SHELL -- still
    // under the seam, never under $HOME.
    rmSync(join(rcDir, ".bashrc"));
    withEnv("SHELL", "/bin/zsh", () => {
      expect(rcFiles(false)).toEqual([join(rcDir, ".zshrc")]);
    });
    withEnv("SHELL", "/bin/bash", () => {
      expect(rcFiles(false)).toEqual([join(rcDir, ".bashrc")]);
    });
  });
});

skipWin("the rc-dir seam beats $HOME end to end, so a stray run cannot reach it", () => {
  // The structural floor: even with $HOME pointed at a live directory, the seam decides
  // where `agent shell` writes. This is what keeps a test that forgets its own isolation
  // from landing in the real ~/.bashrc.
  const rcDir = mkdtempSync(join(tmpdir(), "copilot-rc-"));
  try {
    const proc = runCli(["shell"], {
      env: {
        ...process.env,
        HOME: home,
        SHELL: "/bin/bash",
        CONSOLA_LEVEL: "5",
        [CI_RC_DIR_ENV]: rcDir,
      },
    });
    expect({ exitCode: proc.exitCode, stderr: proc.stderr }).toMatchObject({ exitCode: 0 });
    expect(readFileSync(join(rcDir, ".bashrc"), "utf-8")).toContain(MARKER);
    expect(existsSync(join(home, ".bashrc"))).toBe(false); // $HOME never touched
  } finally {
    rmSync(rcDir, { recursive: true, force: true });
  }
});

// Windows only, and the one test that exercises the REAL lookup end to end: it spawns
// PowerShell and asks the OS where Documents is. It clears any inherited redirect first,
// or it would quietly stop testing the thing it exists for. Read-only -- it resolves
// paths and writes nothing, so it is safe against a real profile.
test.skipIf(process.platform !== "win32")(
  "the un-redirected Windows lookup resolves the machine's real $PROFILE candidates",
  () => {
    withEnv(CI_PS_DOCUMENTS_DIR_ENV, null, () => {
      const target = windowsProfileTarget(false); // resolving at all is the assertion
      expect(target.source).toBe("system");
      expect(target.paths.length).toBe(2);
      for (const path of target.paths) {
        expect(basename(path)).toBe("Microsoft.PowerShell_profile.ps1");
        // GetFolderPath answered with a real location, not "" and not a bare name.
        expect(isAbsolute(path)).toBe(true);
      }
    });
  },
);

// Windows only: the cheap resolver behind `agent env` has to read the redirected tree.
// Asserting false on an empty tree FIRST is what proves the redirect was honored -- a
// resolver ignoring it could report true off an already-wired real profile.
test.skipIf(process.platform !== "win32")(
  "launchersWired inspects the redirected profile tree, not the machine's",
  () => {
    const documents = join(home, "Documents");
    const profile = join(documents, "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1");
    withEnv(CI_PS_DOCUMENTS_DIR_ENV, documents, () => {
      expect(launchersWired()).toBe(false);
      mkdirSync(dirname(profile), { recursive: true });
      writeFileSync(profile, `${LAUNCHERS_MARKER}\n`);
      expect(launchersWired()).toBe(true);
    });
  },
);

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
  // doesn't break the prompt's instant-prompt guard. It forwards NO arguments
  // (matching the ps1 twin's eager Import-CopilotEnv -Quiet).
  expect(posix).toMatch(/bin\/agent" env 2>\/dev\/null/);

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

test("the cl launchers state the same Claude flag set on both platforms", () => {
  // Each launcher spells the shared flag set once; this pin keeps the pair from
  // drifting apart again on the next edit.
  const posix = readFileSync(join(process.cwd(), "shell", "agents.launchers.bashrc"), "utf8");
  const powershell = readFileSync(join(process.cwd(), "shell", "agents.launchers.ps1"), "utf8");
  const posixSet = posix.match(/set -- (--[a-z- ]+?) "\$@"/)?.[1]?.split(" ") ?? [];
  const psSet = [
    ...(powershell.match(/\$claudeFlags = @\(([^)]*)\)/)?.[1] ?? "").matchAll(/'([^']+)'/g),
  ].map((m) => m[1]);
  expect(posixSet.length).toBeGreaterThan(0);
  expect(psSet).toEqual(posixSet);
});

// The seam NAMES are external contracts: the suite floor (test/helpers/testing.ts) exports
// them into every test process, and a child spawned with a hand-built env spells them as
// literals. Pin the exported constants to those literals so a rename fails here instead of
// silently orphaning a hand-spelled seam; asserting the live env also proves the floor is
// active in this very process.
test("the sandbox floor sets both shell seams under their exported names", () => {
  expect(CI_RC_DIR_ENV).toBe("COPILOT_ENV_CI_RC_DIR");
  expect(CI_PS_DOCUMENTS_DIR_ENV).toBe("COPILOT_ENV_CI_PS_DOCUMENTS_DIR");
  expect(Deno.env.get(CI_RC_DIR_ENV)).toBeDefined();
  expect(Deno.env.get(CI_PS_DOCUMENTS_DIR_ENV)).toBeDefined();
});
