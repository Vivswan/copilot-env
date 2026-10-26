import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { consola } from "consola";
import {
  AGENT_CLIS,
  type AgentCli,
  type CliInstallDeps,
  classifyAgentCli,
  defaultCliInstallDeps,
  type InstallerCommand,
  type InstallHost,
  installedBinaryPath,
  judgeInstallerExit,
  judgePin,
  planCliInstall,
  type VendorWrite,
  WINGET_UPDATE_NOT_APPLICABLE,
} from "../../src/agents/cli_install.ts";
import { runShell } from "../../src/commands/setup.ts";
import { CopilotEnvConfig } from "../../src/copilot_api/env_config.ts";
import { CI_RC_DIR_ENV, MARKER } from "../../src/shell/integration.ts";
import { type CommandLook, findCommand } from "../../src/utils/command.ts";
import { envSnapshot, isolateProxyHome } from "../helpers/env.ts";
import { captureChannels } from "../helpers/output.ts";
import { expect, removeDir, tempDir, test } from "../helpers/testing.ts";

const [CLAUDE, COPILOT, CODEX] = AGENT_CLIS;

// runShell's flag validation throws BEFORE any install or rc wiring, so these
// need no filesystem/network isolation.

test("shell: the CLI-install tuning flags require --clis, --no-prereqs excludes --no-sudo and --cooldown, the cooldown is a non-negative integer, and --clis never combines with --remove", () => {
  const rows: Array<[Parameters<typeof runShell>[0], string]> = [
    [{ cooldown: 7 }, "require --clis"],
    [{ noSudo: true }, "require --clis"],
    [{ noPrereqs: true }, "require --clis"],
    [{ clis: true, noSudo: true, noPrereqs: true }, "mutually exclusive"],
    // --no-prereqs installs nothing, so a cooldown has nothing to steer; the boundary
    // rejects the pair instead of silently dropping the cooldown.
    [
      { clis: true, cooldown: 7, noPrereqs: true },
      "--cooldown and --no-prereqs are mutually exclusive",
    ],
    [{ clis: true, cooldown: 1.5 }, "--cooldown"],
    [{ clis: true, cooldown: -1 }, "--cooldown"],
    [{ clis: true, remove: true }, "cannot be combined with --remove"],
  ];
  for (const [opts, message] of rows) {
    expect(() => runShell(opts), JSON.stringify(opts)).toThrow(message);
  }
});

// The rc writes ride the suite's rc-dir/Documents seams, so this runs for real on every OS.
test("runShell reports the launchers key on a plain wire and never writes it", async () => {
  const restore = envSnapshot();
  let dir = isolateProxyHome("copilot-setup-");
  const lines: string[] = [];
  const orig = consola.info;
  consola.info = ((msg: string) => {
    lines.push(String(msg));
  }) as typeof consola.info;
  try {
    await runShell({});
    expect(lines.at(-1)).toContain("Launchers: disabled (the shell.launchers config key)");
    expect(new CopilotEnvConfig().read().global["shell.launchers"]).toBeUndefined();
    new CopilotEnvConfig().set({ "shell.launchers": true });
    await runShell({});
    expect(lines.at(-1)).toContain("Launchers: enabled (the shell.launchers config key)");
    await runShell({ remove: true }); // the unwire is the rc block's; the key is the user's
    expect(new CopilotEnvConfig().launchersEnabled()).toBe(true);
  } finally {
    consola.info = orig;
    restore();
    dir = removeDir(dir);
  }
});

// --- the installer commands ------------------------------------------------------

const CLAUDE_SH = "https://claude.ai/install.sh";
const CLAUDE_PS1 = "https://claude.ai/install.ps1";
const COPILOT_SH = "https://gh.io/copilot-install";
const CODEX_SH = "https://chatgpt.com/codex/install.sh";
const CODEX_PS1 = "https://chatgpt.com/codex/install.ps1";
const POWERSHELL_ARGS = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"];
const COPILOT_PACKAGE_DIR =
  "C:\\Users\\user\\AppData\\Local\\Microsoft\\WinGet\\Packages\\GitHub.Copilot_Microsoft.Winget.Source_8wekyb3d8bbwe";

const WINGET_ARGS = [
  "install",
  "--id",
  "GitHub.Copilot",
  "--exact",
  // The scope and the package directory are pinned, so winget's own settings move nothing the ledger names.
  "--scope",
  "user",
  "--location",
  COPILOT_PACKAGE_DIR,
  "--accept-package-agreements",
  "--accept-source-agreements",
];

/** Hand-written hosts for the pure planner and path tests: a user on each platform, no vendor
 *  knobs set, no profile file present. */
function host(platform: NodeJS.Platform, over: Partial<InstallHost> = {}): InstallHost {
  const windows = platform === "win32";
  return {
    platform,
    home: windows ? "C:\\Users\\user" : "/home/user",
    localAppData: windows ? "C:\\Users\\user\\AppData\\Local" : "/home/user/.local",
    env: {},
    root: false,
    exists: () => false,
    ...over,
  };
}

const LATEST_POSIX_LINES = [
  `curl -fsSL ${CLAUDE_SH} | bash`,
  `curl -fsSL ${COPILOT_SH} | bash`,
  `curl -fsSL ${CODEX_SH} | CODEX_NON_INTERACTIVE=1 sh`,
];

// The vendors' documented installers, read 2026-10-17: https://code.claude.com/docs/en/setup
// (stable / latest / a version as the script's argument), https://github.com/github/copilot-cli
// (install.sh takes VERSION; Windows is winget GitHub.Copilot), and https://github.com/openai/codex
// (install.sh --release, install.ps1 -Release, CODEX_NON_INTERACTIVE skips its prompts). CI runs
// only the unpinned lines live (the installer smoke legs), so the pinned spellings and the
// --no-sudo refusal are pinned here per platform. The POSIX line runs under `bash -o pipefail`:
// a curl that fails must not leave the pipeline at `sh`'s exit 0.
test("planCliInstall spells each vendor's documented installer per platform under bash -o pipefail, splices the pin --cooldown resolved, and refuses winget under --no-sudo", () => {
  const posixRows: Array<[AgentCli, string | null, string]> = [
    [CLAUDE, null, `curl -fsSL ${CLAUDE_SH} | bash`],
    [CLAUDE, "stable", `curl -fsSL ${CLAUDE_SH} | bash -s stable`],
    [COPILOT, null, `curl -fsSL ${COPILOT_SH} | bash`],
    [COPILOT, "v1.0.95", `curl -fsSL ${COPILOT_SH} | VERSION=v1.0.95 bash`],
    [CODEX, null, `curl -fsSL ${CODEX_SH} | CODEX_NON_INTERACTIVE=1 sh`],
    [
      CODEX,
      "0.163.0",
      `curl -fsSL ${CODEX_SH} | CODEX_NON_INTERACTIVE=1 sh -s -- --release 0.163.0`,
    ],
  ];
  for (const platform of ["linux", "darwin"] as const) {
    for (const [cli, pin, line] of posixRows) {
      // --no-sudo changes nothing here: every POSIX installer is user-local.
      for (const noSudo of [false, true]) {
        expect(
          planCliInstall(cli, pin, host(platform), noSudo),
          `${platform} ${cli.command} ${pin}`,
        ).toEqual({
          kind: "run",
          command: {
            cli: cli.command,
            kind: "posix",
            file: "bash",
            args: ["-o", "pipefail", "-c", line],
            line,
            writes: expect.any(Array),
          },
        });
      }
    }
  }

  const windowsRows: Array<
    [AgentCli, string | null, Pick<InstallerCommand, "kind" | "file" | "args" | "line">]
  > = [
    [
      CLAUDE,
      null,
      {
        kind: "powershell",
        file: "powershell",
        args: [...POWERSHELL_ARGS, `irm ${CLAUDE_PS1} | iex`],
        line: `irm ${CLAUDE_PS1} | iex`,
      },
    ],
    [
      CLAUDE,
      "stable",
      {
        kind: "powershell",
        file: "powershell",
        args: [...POWERSHELL_ARGS, `& ([scriptblock]::Create((irm ${CLAUDE_PS1}))) stable`],
        line: `& ([scriptblock]::Create((irm ${CLAUDE_PS1}))) stable`,
      },
    ],
    [
      CODEX,
      null,
      {
        kind: "powershell",
        file: "powershell",
        args: [...POWERSHELL_ARGS, `$env:CODEX_NON_INTERACTIVE = '1'; irm ${CODEX_PS1} | iex`],
        line: `$env:CODEX_NON_INTERACTIVE = '1'; irm ${CODEX_PS1} | iex`,
      },
    ],
    [
      CODEX,
      "0.163.0",
      {
        kind: "powershell",
        file: "powershell",
        args: [
          ...POWERSHELL_ARGS,
          `$env:CODEX_NON_INTERACTIVE = '1'; & ([scriptblock]::Create((irm ${CODEX_PS1}))) -Release 0.163.0`,
        ],
        line: `$env:CODEX_NON_INTERACTIVE = '1'; & ([scriptblock]::Create((irm ${CODEX_PS1}))) -Release 0.163.0`,
      },
    ],
    [
      COPILOT,
      null,
      {
        kind: "winget",
        file: "winget",
        args: WINGET_ARGS,
        line: `winget ${WINGET_ARGS.join(" ")}`,
      },
    ],
    [
      COPILOT,
      "v1.0.95",
      {
        kind: "winget",
        file: "winget",
        args: [...WINGET_ARGS, "--version", "v1.0.95"],
        line: `winget ${WINGET_ARGS.join(" ")} --version v1.0.95`,
      },
    ],
  ];
  for (const [cli, pin, command] of windowsRows) {
    expect(planCliInstall(cli, pin, host("win32"), false), `win32 ${cli.command} ${pin}`).toEqual({
      kind: "run",
      command: { cli: cli.command, ...command, writes: expect.any(Array) },
    });
  }
  // The argv stays literal; the narrated line quotes, for PowerShell, a path a shell would split
  // at its space.
  const spaced = planCliInstall(
    COPILOT,
    null,
    host("win32", { localAppData: "C:\\Users\\example user\\AppData\\Local" }),
    false,
  );
  const spacedDir =
    "C:\\Users\\example user\\AppData\\Local\\Microsoft\\WinGet\\Packages\\GitHub.Copilot_Microsoft.Winget.Source_8wekyb3d8bbwe";
  expect(spaced.kind === "run" ? spaced.command.args : null).toContain(spacedDir);
  expect(spaced.kind === "run" ? spaced.command.line : null).toContain(`--location '${spacedDir}'`);

  // The vendor PowerShell installers are user-local, so --no-sudo keeps them.
  expect(planCliInstall(CLAUDE, null, host("win32"), true).kind).toBe("run");
  expect(planCliInstall(CODEX, null, host("win32"), true).kind).toBe("run");

  const refused = planCliInstall(COPILOT, null, host("win32"), true);
  expect(refused.kind).toBe("refused");
  if (refused.kind === "refused") {
    const text = refused.message.render(null);
    expect(text).toContain("--no-sudo rules out winget, its only installer on Windows");
    expect(text).toContain("https://github.com/github/copilot-cli/releases");
  }
});

// The install paths the vendors' scripts resolve (the same sources as above, read in their
// install.sh / install.ps1): where an install is proven when this process's PATH predates the
// installer's PATH edit, and what the disclosure names.
test("installedBinaryPath follows each vendor's script: ~/.local/bin by default, CODEX_INSTALL_DIR and PREFIX when set, /usr/local for a root Copilot install, the Windows dirs, and winget's package directory for the Copilot CLI", () => {
  const rows: Array<[string, AgentCli, InstallHost, string]> = [
    ["claude linux", CLAUDE, host("linux"), "/home/user/.local/bin/claude"],
    ["copilot darwin", COPILOT, host("darwin"), "/home/user/.local/bin/copilot"],
    ["codex linux", CODEX, host("linux"), "/home/user/.local/bin/codex"],
    [
      "codex honors CODEX_INSTALL_DIR",
      CODEX,
      host("linux", { env: { CODEX_INSTALL_DIR: "/opt/codex-bin" } }),
      "/opt/codex-bin/codex",
    ],
    [
      "copilot honors PREFIX",
      COPILOT,
      host("linux", { env: { PREFIX: "/home/user/custom" } }),
      "/home/user/custom/bin/copilot",
    ],
    // `${VAR:-default}` in the POSIX scripts: only an EMPTY knob is unset, a blank one is a
    // directory named by a space; the PowerShell installer's IsNullOrWhiteSpace takes a blank as
    // unset too.
    [
      "an empty knob is unset",
      CODEX,
      host("linux", { env: { CODEX_INSTALL_DIR: "" } }),
      "/home/user/.local/bin/codex",
    ],
    [
      "a blank knob names a directory on POSIX",
      CODEX,
      host("linux", { env: { CODEX_INSTALL_DIR: " " } }),
      " /codex",
    ],
    [
      "a blank knob is unset on Windows",
      CODEX,
      host("win32", { env: { CODEX_INSTALL_DIR: " " } }),
      "C:\\Users\\user\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe",
    ],
    [
      "an empty PREFIX is unset",
      COPILOT,
      host("linux", { env: { PREFIX: "" } }),
      "/home/user/.local/bin/copilot",
    ],
    [
      "copilot as root defaults to /usr/local",
      COPILOT,
      host("linux", { root: true }),
      "/usr/local/bin/copilot",
    ],
    ["claude win32", CLAUDE, host("win32"), "C:\\Users\\user\\.local\\bin\\claude.exe"],
    [
      "codex win32",
      CODEX,
      host("win32"),
      "C:\\Users\\user\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe",
    ],
    [
      "codex win32 honors CODEX_INSTALL_DIR",
      CODEX,
      host("win32", { env: { CODEX_INSTALL_DIR: "D:\\tools\\codex" } }),
      "D:\\tools\\codex\\codex.exe",
    ],
    [
      "copilot win32 is winget's package directory",
      COPILOT,
      host("win32"),
      `${COPILOT_PACKAGE_DIR}\\copilot.exe`,
    ],
  ];
  for (const [name, cli, at, path] of rows) {
    expect(installedBinaryPath(cli, at), name).toBe(path);
  }
  // The Codex POSIX installer symlinks codex (and on macOS codex-code-mode-host) into the release
  // its `current` link selects.
  const plan = planCliInstall(CODEX, null, host("darwin", { env: { SHELL: "/bin/zsh" } }), false);
  expect(plan.kind === "run" ? plan.command.writes : []).toEqual([
    {
      kind: "link",
      path: "/home/user/.local/bin/codex",
      target: "/home/user/.codex/packages/standalone/current/bin/codex",
    },
    {
      kind: "link",
      path: "/home/user/.local/bin/codex-code-mode-host",
      target: "/home/user/.codex/packages/standalone/current/bin/codex-code-mode-host",
    },
    { kind: "file", path: "/home/user/.codex/packages/standalone/" },
    {
      kind: "file",
      path: "/home/user/.zprofile",
      detail: "a PATH block it appends when its directory is not on PATH",
    },
  ]);
});

// The Claude installer's writes as its vendor lists them (its install troubleshooting page, read
// 2026-10-17): the launcher is a symlink into the data home's versions/; XDG_DATA_HOME,
// XDG_STATE_HOME, and XDG_CACHE_HOME replace ~/.local/share, ~/.local/state, and ~/.cache; the
// global config file follows CLAUDE_CONFIG_DIR. Windows is documented as writing under
// %USERPROFILE% only.
test("the Claude writes follow the XDG homes and CLAUDE_CONFIG_DIR on POSIX, an empty knob unset, and stay under the profile on Windows", () => {
  const writes = (at: InstallHost): VendorWrite[] | null => {
    const plan = planCliInstall(CLAUDE, null, at, false);
    return plan.kind === "run" ? plan.command.writes : null;
  };
  expect(writes(host("linux"))).toEqual([
    {
      kind: "link",
      path: "/home/user/.local/bin/claude",
      target: "/home/user/.local/share/claude/versions/<version>",
    },
    { kind: "file", path: "/home/user/.local/share/claude/", detail: "each version it downloads" },
    { kind: "file", path: "/home/user/.local/state/claude/", detail: "its lock files" },
    { kind: "file", path: "/home/user/.cache/claude/", detail: "staged downloads" },
    { kind: "file", path: "/home/user/.claude/downloads/", detail: "a download it removes again" },
    { kind: "file", path: "/home/user/.claude.json", detail: "the install method it records" },
  ]);
  const knobs = host("linux", {
    env: {
      XDG_DATA_HOME: "/mnt/data",
      XDG_STATE_HOME: "/mnt/state",
      XDG_CACHE_HOME: "",
      CLAUDE_CONFIG_DIR: "/home/user/cfg/claude",
    },
  });
  expect(writes(knobs)?.map((write) => write.path)).toEqual([
    "/home/user/.local/bin/claude",
    "/mnt/data/claude/",
    "/mnt/state/claude/",
    "/home/user/.cache/claude/",
    "/home/user/.claude/downloads/",
    "/home/user/cfg/claude/.claude.json",
  ]);
  expect(writes(knobs)?.[0]).toEqual({
    kind: "link",
    path: "/home/user/.local/bin/claude",
    target: "/mnt/data/claude/versions/<version>",
  });
  expect(writes(host("win32"))).toEqual([
    { kind: "file", path: "C:\\Users\\user\\.local\\bin\\claude.exe" },
    { kind: "file", path: "C:\\Users\\user\\.local\\share\\claude\\" },
    {
      kind: "file",
      path: "C:\\Users\\user\\.claude\\downloads\\",
      detail: "a download it removes again",
    },
    {
      kind: "file",
      path: "C:\\Users\\user\\.claude.json",
      detail: "the install method it records",
    },
  ]);
});

// The profile files the vendors' scripts edit, as their scripts pick them (read 2026-10-17):
// Codex's pick_profile switches on `$os:$SHELL` (`*/zsh`, `*/bash`, else ~/.profile); the
// Copilot installer on `basename "${SHELL:-/bin/sh}"` (zsh: `${ZDOTDIR:-$HOME}/.zprofile`; bash:
// the first of ~/.bash_profile and ~/.bash_login that exists, else ~/.profile; fish: its conf.d
// file; else ~/.profile). The Codex Windows installer edits the User PATH in the registry.
test("the disclosed profile file is the one each vendor's script picks from the shell, the platform, and the files present", () => {
  const pathEdit = (cli: AgentCli, at: InstallHost): VendorWrite | undefined => {
    const plan = planCliInstall(cli, null, at, false);
    return plan.kind === "run" ? plan.command.writes.at(-1) : undefined;
  };
  const codexRows: Array<[string, InstallHost, string]> = [
    ["darwin zsh", host("darwin", { env: { SHELL: "/bin/zsh" } }), "/home/user/.zprofile"],
    ["darwin bash", host("darwin", { env: { SHELL: "/bin/bash" } }), "/home/user/.bash_profile"],
    ["linux zsh", host("linux", { env: { SHELL: "/usr/bin/zsh" } }), "/home/user/.zshrc"],
    ["linux bash", host("linux", { env: { SHELL: "/bin/bash" } }), "/home/user/.bashrc"],
    ["linux fish", host("linux", { env: { SHELL: "/usr/bin/fish" } }), "/home/user/.profile"],
    ["no SHELL", host("linux"), "/home/user/.profile"],
  ];
  for (const [name, at, path] of codexRows) {
    expect(pathEdit(CODEX, at), `codex ${name}`).toEqual({
      kind: "file",
      path,
      detail: "a PATH block it appends when its directory is not on PATH",
    });
  }
  expect(pathEdit(CODEX, host("win32"))).toEqual({
    kind: "value",
    path: "HKCU\\Environment\\Path",
    detail: "the User PATH",
  });

  const bashProfile = (...present: string[]): InstallHost =>
    host("linux", {
      env: { SHELL: "/bin/bash" },
      exists: (path) => present.includes(path),
    });
  const copilotRows: Array<[string, InstallHost, string]> = [
    ["zsh", host("linux", { env: { SHELL: "/bin/zsh" } }), "/home/user/.zprofile"],
    [
      "zsh with ZDOTDIR",
      host("linux", { env: { SHELL: "/bin/zsh", ZDOTDIR: "/home/user/.config/zsh" } }),
      "/home/user/.config/zsh/.zprofile",
    ],
    [
      "bash with a .bash_profile",
      bashProfile("/home/user/.bash_profile"),
      "/home/user/.bash_profile",
    ],
    [
      "bash with only a .bash_login",
      bashProfile("/home/user/.bash_login"),
      "/home/user/.bash_login",
    ],
    ["bash with neither", bashProfile(), "/home/user/.profile"],
    [
      "fish",
      host("linux", { env: { SHELL: "/usr/bin/fish" } }),
      "/home/user/.config/fish/conf.d/copilot.fish",
    ],
    [
      "fish with XDG_CONFIG_HOME",
      host("darwin", {
        env: { SHELL: "/opt/homebrew/bin/fish", XDG_CONFIG_HOME: "/home/user/cfg" },
      }),
      "/home/user/cfg/fish/conf.d/copilot.fish",
    ],
    ["no SHELL (sh)", host("linux"), "/home/user/.profile"],
  ];
  for (const [name, at, path] of copilotRows) {
    expect(pathEdit(COPILOT, at), `copilot ${name}`).toEqual({
      kind: "file",
      path,
      detail: "a PATH line it offers to append when its directory is not on PATH",
    });
  }
  // The Codex Windows installer makes the visible bin dir a junction into the standalone tree's
  // current release (its Ensure-Junction), holding codex.exe and rg.exe (its required files); on
  // POSIX rg lives inside the standalone tree named above.
  const codexWindows = planCliInstall(CODEX, null, host("win32"), false);
  expect(codexWindows.kind === "run" ? codexWindows.command.writes : null).toEqual([
    {
      kind: "link",
      path: "C:\\Users\\user\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin",
      target: "C:\\Users\\user\\.codex\\packages\\standalone\\current\\bin\\",
      detail: "a junction",
    },
    {
      kind: "file",
      path: "C:\\Users\\user\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe",
    },
    {
      kind: "file",
      path: "C:\\Users\\user\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\rg.exe",
      detail: "ripgrep, beside codex.exe",
    },
    { kind: "file", path: "C:\\Users\\user\\.codex\\packages\\standalone\\" },
    { kind: "value", path: "HKCU\\Environment\\Path", detail: "the User PATH" },
  ]);

  // winget's footprint for GitHub.Copilot (its manifest and winget's sources, read 2026-10-17).
  // The dependency lands as an MSIX: the user scope rules out Microsoft.PowerShell's machine-scope
  // MSI arms.
  const winget = planCliInstall(
    COPILOT,
    null,
    host("win32", { env: { ProgramFiles: "D:\\Program Files" } }),
    false,
  );
  const pwsh =
    "D:\\Program Files\\WindowsApps\\Microsoft.PowerShell_<version>_<arch>__8wekyb3d8bbwe";
  expect(winget.kind === "run" ? winget.command.writes : null).toEqual([
    { kind: "file", path: `${COPILOT_PACKAGE_DIR}\\copilot.exe` },
    {
      kind: "file",
      path: `${COPILOT_PACKAGE_DIR}\\`,
      detail: "the archive's other files and winget's portable index",
    },
    {
      kind: "link",
      path: "C:\\Users\\user\\AppData\\Local\\Microsoft\\WinGet\\Links\\copilot.exe",
      target: `${COPILOT_PACKAGE_DIR}\\copilot.exe`,
      detail: "where winget can make a symlink; else its directory goes on the PATH",
    },
    { kind: "value", path: "HKCU\\Environment\\Path", detail: "the User PATH" },
    {
      kind: "value",
      path: "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\GitHub.Copilot_Microsoft.Winget.Source_8wekyb3d8bbwe",
      detail: "its Apps & features entry",
    },
    {
      kind: "file",
      path: "C:\\Users\\user\\AppData\\Local\\Packages\\Microsoft.DesktopAppInstaller_8wekyb3d8bbwe\\",
      detail: "winget's own state: tracking, settings, logs",
    },
    {
      kind: "file",
      path: "D:\\Program Files\\WindowsApps\\Microsoft.Winget.Source_<version>_neutral__8wekyb3d8bbwe\\",
      detail: "its source index, when winget refreshes its source",
    },
    {
      kind: "file",
      path: `${pwsh}\\`,
      detail: "pwsh 7 as its MSIX package, when PowerShell 7 is absent",
    },
    {
      kind: "link",
      path: "C:\\Users\\user\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe",
      target: `${pwsh}\\pwsh.exe`,
      detail: "its execution alias, when PowerShell 7 is absent",
    },
  ]);
});

// --cooldown pins a release; the proof's `--version` line names whatever landed. A substring
// match took 1.0.98 for a pinned 1.0.9, so the line's version token is compared as a semver.
test("judgePin compares the --version line's version token with the pin as a semver: the v prefix and the vendor's wording ignored, a prefix no match, a line without a version unverifiable", () => {
  const rows: Array<[string, string, ReturnType<typeof judgePin>]> = [
    ["codex-cli 0.163.0", "0.163.0", { kind: "pinned" }],
    ["1.0.95", "v1.0.95", { kind: "pinned" }],
    ["2.0.14 (Claude Code)", "2.0.14", { kind: "pinned" }],
    ["GitHub Copilot CLI 1.0.98", "v1.0.9", { kind: "other", proved: "1.0.98" }],
    ["copilot 1.0.98-1", "v1.0.98", { kind: "other", proved: "1.0.98-1" }],
    ["copilot 9.9.9 (fake)", "v1.0.95", { kind: "other", proved: "9.9.9" }],
    ["codex (fake)", "0.163.0", { kind: "unverifiable" }],
    ["codex 0.163.0", "stable", { kind: "unverifiable" }],
  ];
  for (const [line, pin, judgement] of rows) {
    expect(judgePin(line, pin), `${line} vs ${pin}`).toEqual(judgement);
  }
});

// An npm-installed CLI on Windows is a `.cmd` shim that only cmd.exe runs, and nothing of ours
// routes through cmd.exe any more: one classification, shared by every spawn site, decides by
// the extension, not by the EINVAL a spawn would give.
test("classifyAgentCli reads a .cmd or .bat path as an npm shim this build cannot run, with the uninstall line; any other path is found; absent stays absent", () => {
  const found = (path: string): CommandLook => ({ kind: "found", path });
  const shim = (path: string): ReturnType<typeof classifyAgentCli> => ({
    kind: "npm-shim",
    path,
    note: `${path} is an npm-installed copy of codex this build cannot run; npm uninstall -g @openai/codex, then agent shell --clis`,
  });
  const rows: Array<[CommandLook, ReturnType<typeof classifyAgentCli>]> = [
    [found("C:\\npm\\codex.cmd"), shim("C:\\npm\\codex.cmd")],
    [found("C:\\npm\\codex.CMD"), shim("C:\\npm\\codex.CMD")],
    [found("C:\\npm\\codex.bat"), shim("C:\\npm\\codex.bat")],
    [
      found("C:\\Users\\user\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe"),
      {
        kind: "found",
        path: "C:\\Users\\user\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe",
      },
    ],
    [found("/home/user/.local/bin/codex"), { kind: "found", path: "/home/user/.local/bin/codex" }],
    [{ kind: "absent" }, { kind: "absent" }],
  ];
  for (const [look, classified] of rows) {
    expect(classifyAgentCli("codex", look), JSON.stringify(look)).toEqual(classified);
  }
  const claude = classifyAgentCli("claude", found("C:\\npm\\claude.cmd"));
  expect(claude.kind === "npm-shim" ? claude.note : null).toContain(
    "npm uninstall -g @anthropic-ai/claude-code",
  );
});

// winget answers 0x8A15002B (APPINSTALLER_CLI_ERROR_UPDATE_NOT_APPLICABLE, -1978335189 as the
// int32 a spawn reports) when the package is installed and no upgrade applies: a re-run of --clis
// with the Copilot CLI current is not a failed install. Nothing on CI re-runs winget, so the code
// is pinned here.
test("judgeInstallerExit: exit 0 installed, winget's no-applicable-upgrade code already current, every other exit or spawn error failed with the reason", () => {
  const posix = planCliInstall(CLAUDE, null, host("linux"), false);
  const winget = planCliInstall(COPILOT, null, host("win32"), false);
  if (posix.kind !== "run" || winget.kind !== "run") throw new Error("both plans must run");
  const rows: Array<
    [
      string,
      InstallerCommand,
      Parameters<typeof judgeInstallerExit>[1],
      ReturnType<typeof judgeInstallerExit>,
    ]
  > = [
    ["exit 0", posix.command, { status: 0 }, { kind: "installed" }],
    [
      "winget already current",
      winget.command,
      { status: WINGET_UPDATE_NOT_APPLICABLE },
      { kind: "already-current" },
    ],
    [
      "the same code from another installer is a failure",
      posix.command,
      { status: WINGET_UPDATE_NOT_APPLICABLE },
      { kind: "failed", detail: "the installer exited -1978335189" },
    ],
    ["exit 1", posix.command, { status: 1 }, { kind: "failed", detail: "the installer exited 1" }],
    [
      "a signal death",
      posix.command,
      { status: null, signal: "SIGKILL" },
      { kind: "failed", detail: "the installer was killed by SIGKILL" },
    ],
    [
      "a spawn error",
      posix.command,
      { status: null, error: new Error("spawnSync bash ENOENT") },
      { kind: "failed", detail: "the installer did not start: spawnSync bash ENOENT" },
    ],
  ];
  for (const [name, command, result, verdict] of rows) {
    expect(judgeInstallerExit(command, result), name).toEqual(verdict);
  }
});

// --- the best-effort `--clis` install run ---------------------------------------
//
// POSIX-only: the installs and the `--version` proofs run real `sh` shims.

type Command = AgentCli["command"];

type Landing = "vendor-dir" | "unversioned" | "broken" | "nowhere";

interface Fixture {
  /** The temp root holding pathBin, the HOME and the rc dir. */
  dir: string;

  /** The first PATH entry: where pre-existing copies sit. */
  pathBin: string;

  /** The vendors' install dir under the fixture HOME, on PATH unless the row says otherwise. */
  vendorBin: string;

  /** HOME for the run: the vendors' writes, CODEX_HOME and CLAUDE_CONFIG_DIR all sit under it. */
  home: string;

  /** The rc file the wire targets (pre-created so rcFiles picks it). */
  bashrc: string;

  /** Every installer command the run handed the fake, in order. */
  runs: InstallerCommand[];

  /** The seams: a recording fake runner, a fetch over the row's releases, the real version and (unless given) look. */
  deps: CliInstallDeps;
}

/** The unit `release` ages a published_at by. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** The Claude installer's XDG knobs: cleared per fixture so its writes land under the fixture HOME. */
const XDG_HOMES = ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"] as const;

/** A hand-written GitHub release row published `daysAgo` days before the run. */
function release(tag: string, daysAgo: number, flags: { prerelease?: boolean } = {}): unknown {
  return {
    tag_name: tag,
    published_at: new Date(Date.now() - daysAgo * DAY_MS).toISOString(),
    draft: false,
    prerelease: flags.prerelease ?? false,
  };
}

/** Each vendor's releases as API pages, newest first; a short page is the last one. */
const COPILOT_PAGES: unknown[][] = [
  [
    release("v1.0.99", 1),
    release("v1.0.100-1", 0, { prerelease: true }),
    release("v1.0.95", 8),
    release("v1.0.90", 20),
  ],
];

/** openai/codex's page: today's alpha first, the stable release two days behind it. */
const CODEX_PAGES: unknown[][] = [
  [
    release("rust-v0.164.0-alpha.1", 0, { prerelease: true }),
    release("rust-v0.164.0", 2),
    release("rust-v0.163.0", 9),
    release("rust-v0.160.0", 30),
  ],
];

/** A full first page of fresh alphas (openai/codex most days); the week-old stable release sits on the page after. */
const CODEX_PAGED: unknown[][] = [
  Array.from({ length: 100 }, (_, i) =>
    release(`rust-v0.165.0-alpha.${i}`, 0, { prerelease: true }),
  ),
  [release("rust-v0.163.0", 9)],
];

/**
 * Nothing real may satisfy a look: PATH holds the fixture bin (`sh` for the shims plus any
 * pre-existing copies) and the vendors' install dir under the fixture HOME; SHELL is bash and
 * CODEX_HOME the fixture's so the vendors' write picks are known; the rc seam targets a fresh dir.
 */
function stageFixture(opts: {
  /** Where each CLI's installer leaves its binary; "vendor-dir" when absent. */
  lands?: Partial<Record<Command, Landing>>;

  /** CLIs whose installer exits 1. */
  fails?: readonly Command[];

  /** Copies already on PATH (ahead of the vendors' dir) before the run. */
  preinstalled?: readonly Command[];

  /** Copies already on PATH whose `--version` exits 1. */
  brokenOnPath?: readonly Command[];

  /** The vendors' install dir is NOT on PATH: a fresh host whose installer edit lands in new shells. */
  vendorOffPath?: boolean;

  /** `owner/name` -> its release pages, or the HTTP status its lookup answers. */
  releases?: Record<string, unknown[][] | number>;

  /** The PATH look, where a row needs an answer no POSIX PATH can give (a `.cmd` shim). */
  look?: CliInstallDeps["look"];
}): Fixture {
  const dir = tempDir("copilot-setup-clis-");
  const pathBin = join(dir, "path-bin");
  const home = join(dir, "home");
  const vendorBin = join(home, ".local", "bin");
  const rcDir = join(dir, "rc");
  for (const d of [pathBin, vendorBin, rcDir]) mkdirSync(d, { recursive: true });
  const bashrc = join(rcDir, ".bashrc");
  writeFileSync(bashrc, "");
  symlinkSync("/bin/sh", join(pathBin, "sh"));

  const shim = (where: string, command: string, body = `echo "${command} 9.9.9 (fake)"`): void => {
    writeFileSync(join(where, command), `#!/bin/sh\n${body}\n`);
    chmodSync(join(where, command), 0o755);
  };
  for (const command of opts.preinstalled ?? []) shim(pathBin, command);
  for (const command of opts.brokenOnPath ?? []) shim(pathBin, command, "echo boom >&2; exit 1");

  process.env.PATH = opts.vendorOffPath ? pathBin : `${pathBin}:${vendorBin}`;
  process.env.HOME = home;
  process.env.SHELL = "/bin/bash";
  // The Codex installer reads CODEX_HOME for its package tree; the suite exports one, so the
  // fixture pins the home's own.
  process.env.CODEX_HOME = join(home, ".codex");
  // The Claude installer reads CLAUDE_CONFIG_DIR (the suite points it at its sandbox) and the
  // XDG homes: the fixture pins the config dir under its home and clears the knobs.
  process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
  for (const name of XDG_HOMES) delete process.env[name];
  process.env[CI_RC_DIR_ENV] = rcDir;

  const runs: InstallerCommand[] = [];
  const real = defaultCliInstallDeps();
  const releases = opts.releases ?? {};
  const deps: CliInstallDeps = {
    run(command) {
      runs.push(command);
      if (opts.fails?.includes(command.cli)) return { status: 1 };
      const landing = opts.lands?.[command.cli] ?? "vendor-dir";
      if (landing === "vendor-dir") shim(vendorBin, command.cli);
      if (landing === "unversioned") {
        shim(vendorBin, command.cli, `echo "${command.cli} (fake, no version)"`);
      }
      if (landing === "broken") shim(vendorBin, command.cli, "echo boom >&2; exit 1");
      return { status: 0 };
    },
    fetch: (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const repo = Object.keys(releases).find((name) => url.pathname.includes(`/repos/${name}/`));
      const answer = repo === undefined ? 404 : (releases[repo] ?? 404);
      if (typeof answer === "number") return Promise.resolve(new Response("", { status: answer }));
      const page = Number(url.searchParams.get("page"));
      return Promise.resolve(Response.json(answer[page - 1] ?? []));
    },
    look: opts.look ?? real.look,
    version: real.version,
  };
  return { dir, pathBin, vendorBin, home, bashrc, runs, deps };
}

/** The keys a row's own snapshot restores: PATH and SHELL as stageFixture rewrites them, the XDG knobs it clears. */
const CLI_ENV_EXTRAS = ["PATH", "Path", "SHELL", ...XDG_HOMES] as const;

/** The Codex installer's bash profile pick on this platform (pick_profile in its install.sh). */
const CODEX_BASH_PROFILE = process.platform === "darwin" ? ".bash_profile" : ".bashrc";

interface CliInstallRow {
  name: string;
  opts: Parameters<typeof stageFixture>[0];
  args: Parameters<typeof runShell>[0];
  lines: (fixture: Fixture) => readonly string[];
  never: readonly string[];
  runs: readonly string[];
  launchers: boolean;
  wired: boolean;
}

const CLI_INSTALL_ROWS: readonly CliInstallRow[] = [
  {
    name: "the plain run installs each CLI through its vendor's installer, names its writes on the ledger first, proves it with --version at the vendor's path, turns the launchers on, and wires the shell",
    opts: {},
    args: { clis: true },
    lines: (f) => [
      "Installing Claude Code CLI (latest) through its vendor's installer ...",
      `runs: curl -fsSL ${CLAUDE_SH} | bash`,
      `linked -> ${join(f.vendorBin, "claude")} (to ${join(f.home, ".local", "share", "claude", "versions")}/<version>, by the Claude Code CLI installer)`,
      `created -> ${join(f.home, ".local", "share", "claude")}/ (each version it downloads, by the Claude Code CLI installer)`,
      `created -> ${join(f.home, ".local", "state", "claude")}/ (its lock files, by the Claude Code CLI installer)`,
      `created -> ${join(f.home, ".cache", "claude")}/ (staged downloads, by the Claude Code CLI installer)`,
      `created -> ${join(f.home, ".claude", "downloads")}/ (a download it removes again, by the Claude Code CLI installer)`,
      `created -> ${join(f.home, ".claude", ".claude.json")} (the install method it records, by the Claude Code CLI installer)`,
      `created -> ${join(f.vendorBin, "copilot")} (by the GitHub Copilot CLI installer)`,
      `created -> ${join(f.home, ".profile")} (a PATH line it offers to append when its directory is not on PATH, by the GitHub Copilot CLI installer)`,
      `linked -> ${join(f.vendorBin, "codex")} (to ${join(f.home, ".codex", "packages", "standalone", "current", "bin", "codex")}, by the Codex CLI installer)`,
      `created -> ${join(f.home, ".codex", "packages", "standalone")}/ (by the Codex CLI installer)`,
      `created -> ${join(f.home, CODEX_BASH_PROFILE)} (a PATH block it appends when its directory is not on PATH, by the Codex CLI installer)`,
      `Claude Code CLI: claude 9.9.9 (fake) (${join(f.vendorBin, "claude")}).`,
      `GitHub Copilot CLI: copilot 9.9.9 (fake) (${join(f.vendorBin, "copilot")}).`,
      `Codex CLI: codex 9.9.9 (fake) (${join(f.vendorBin, "codex")}).`,
      "Set shell.launchers to true (--clis turns the launchers on).",
      "Launchers: enabled (the shell.launchers config key)",
    ],
    never: ["Could not", "shadows", "would write"],
    runs: LATEST_POSIX_LINES,
    launchers: true,
    wired: true,
  },
  {
    name: "one installer failing warns as itself; the other two still install and the wiring lands",
    opts: { fails: ["copilot"] },
    args: { clis: true },
    lines: () => [
      "Could not install GitHub Copilot CLI (the installer exited 1); continuing.",
      "Claude Code CLI: claude 9.9.9 (fake)",
      "Codex CLI: codex 9.9.9 (fake)",
      "Launchers: enabled (the shell.launchers config key)",
    ],
    never: ["GitHub Copilot CLI: copilot"],
    runs: LATEST_POSIX_LINES,
    launchers: true,
    wired: true,
  },
  {
    name: "--cooldown pins codex and copilot to the newest stable release old enough and puts claude on its stable channel",
    opts: { releases: { "github/copilot-cli": COPILOT_PAGES, "openai/codex": CODEX_PAGES } },
    args: { clis: true, cooldown: 7 },
    lines: () => [
      "Installing Claude Code CLI (the stable channel, about a week behind latest) through its vendor's installer ...",
      "Installing GitHub Copilot CLI (v1.0.95, the newest release at least 7 days old) through its vendor's installer ...",
      "Installing Codex CLI (0.163.0, the newest release at least 7 days old) through its vendor's installer ...",
      "GitHub Copilot CLI proved 9.9.9, not the pinned v1.0.95.",
      "Codex CLI proved 9.9.9, not the pinned 0.163.0.",
    ],
    never: ["Could not"],
    runs: [
      `curl -fsSL ${CLAUDE_SH} | bash -s stable`,
      `curl -fsSL ${COPILOT_SH} | VERSION=v1.0.95 bash`,
      `curl -fsSL ${CODEX_SH} | CODEX_NON_INTERACTIVE=1 sh -s -- --release 0.163.0`,
    ],
    launchers: true,
    wired: true,
  },
  {
    name: "a --version line naming no version cannot be checked against the pin, and the proof says so instead of guessing",
    opts: {
      releases: { "github/copilot-cli": COPILOT_PAGES, "openai/codex": CODEX_PAGES },
      lands: { codex: "unversioned" },
    },
    args: { clis: true, cooldown: 7 },
    lines: () => [
      'Codex CLI proved "codex (fake, no version)", a line naming no version to check against the pinned 0.163.0.',
    ],
    never: ["Could not", "not the pinned 0.163.0"],
    runs: [
      `curl -fsSL ${CLAUDE_SH} | bash -s stable`,
      `curl -fsSL ${COPILOT_SH} | VERSION=v1.0.95 bash`,
      `curl -fsSL ${CODEX_SH} | CODEX_NON_INTERACTIVE=1 sh -s -- --release 0.163.0`,
    ],
    launchers: true,
    wired: true,
  },
  {
    name: "a week-old release on the second page is still the pin",
    opts: { releases: { "github/copilot-cli": COPILOT_PAGES, "openai/codex": CODEX_PAGED } },
    args: { clis: true, cooldown: 7 },
    lines: () => ["Installing Codex CLI (0.163.0, the newest release at least 7 days old)"],
    never: ["Could not", "skipping"],
    runs: [
      `curl -fsSL ${CLAUDE_SH} | bash -s stable`,
      `curl -fsSL ${COPILOT_SH} | VERSION=v1.0.95 bash`,
      `curl -fsSL ${CODEX_SH} | CODEX_NON_INTERACTIVE=1 sh -s -- --release 0.163.0`,
    ],
    launchers: true,
    wired: true,
  },
  {
    name: "a failed release lookup skips that CLI with its repo named; the rest still install",
    opts: { releases: { "github/copilot-cli": COPILOT_PAGES, "openai/codex": 404 } },
    args: { clis: true, cooldown: 7 },
    lines: () => [
      "Could not read openai/codex's releases to pick one at least 7 days old; skipping Codex CLI.",
      "agent shell --clis  take the vendor's latest instead",
      "Installing GitHub Copilot CLI (v1.0.95, the newest release at least 7 days old)",
    ],
    never: ["Installing Codex CLI", "Could not install"],
    runs: [
      `curl -fsSL ${CLAUDE_SH} | bash -s stable`,
      `curl -fsSL ${COPILOT_SH} | VERSION=v1.0.95 bash`,
    ],
    launchers: true,
    wired: true,
  },
  {
    name: "a vendor whose releases are all fresher than the cooldown is skipped, never pinned to a fresh one",
    opts: {
      releases: {
        "github/copilot-cli": COPILOT_PAGES,
        "openai/codex": [[release("rust-v0.164.0", 2)]],
      },
    },
    args: { clis: true, cooldown: 7 },
    lines: () => [
      "No openai/codex release among its newest 500 is at least 7 days old; skipping Codex CLI.",
      "agent shell --clis  take the vendor's latest instead",
    ],
    never: ["Installing Codex CLI", "0.164.0"],
    runs: [
      `curl -fsSL ${CLAUDE_SH} | bash -s stable`,
      `curl -fsSL ${COPILOT_SH} | VERSION=v1.0.95 bash`,
    ],
    launchers: true,
    wired: true,
  },
  {
    name: "on a host whose PATH predates the installer's edit, the binary is proven at the vendor's path and the missing PATH entry is named",
    opts: { vendorOffPath: true },
    args: { clis: true },
    lines: (f) => [
      `Claude Code CLI: claude 9.9.9 (fake) (${join(f.vendorBin, "claude")}); ${f.vendorBin} is not on this shell's PATH: add it where the installer did not, then open a new shell.`,
    ],
    never: ["Could not"],
    runs: LATEST_POSIX_LINES,
    launchers: true,
    wired: true,
  },
  {
    name: "an older copy ahead on PATH is never the one proven; it is named as shadowing the new install, with the npm uninstall line",
    opts: { preinstalled: ["claude"] },
    args: { clis: true },
    lines: (f) => [
      `Claude Code CLI: claude 9.9.9 (fake) (${join(f.vendorBin, "claude")}).`,
      `Claude Code CLI on PATH is ${join(f.pathBin, "claude")}, which shadows the new install at ${join(f.vendorBin, "claude")}.`,
      // The action table pads its columns, so the command and its meaning are pinned apart.
      "npm uninstall -g @anthropic-ai/claude-code",
      "remove an npm copy",
    ],
    never: ["Could not", `(${join("path-bin", "claude")})`],
    runs: LATEST_POSIX_LINES,
    launchers: true,
    wired: true,
  },
  {
    name: "an installer that lands nothing at the vendor's path fails that CLI, naming the path",
    opts: { lands: { codex: "nowhere" } },
    args: { clis: true },
    lines: (f) => [
      `Could not install Codex CLI (the installer finished, but ${join(f.vendorBin, "codex")} is absent; rerun 'agent shell --clis'); continuing.`,
      "Launchers: enabled (the shell.launchers config key)",
    ],
    never: ["Codex CLI: codex"],
    runs: LATEST_POSIX_LINES,
    launchers: true,
    wired: true,
  },
  {
    name: "an installer that lands a binary whose --version fails has not proven the install, and the failure says what happened",
    opts: { lands: { copilot: "broken" } },
    args: { clis: true },
    lines: (f) => [
      `Could not install GitHub Copilot CLI (the installer finished, but '${join(f.vendorBin, "copilot")} --version' did not run (exit 1; stderr: boom)); continuing.`,
    ],
    never: ["GitHub Copilot CLI: copilot"],
    runs: LATEST_POSIX_LINES,
    launchers: true,
    wired: true,
  },
  {
    name: "an npm .cmd shim ahead on PATH is classified once with every spawn site: named as shadowing the new install, never spawned",
    opts: {
      look: (command, path) =>
        command === "codex"
          ? { kind: "found", path: "C:\\npm\\codex.cmd" }
          : findCommand(command, path),
    },
    args: { clis: true },
    lines: (f) => [
      `Codex CLI: codex 9.9.9 (fake) (${join(f.vendorBin, "codex")}).`,
      `Codex CLI on PATH is C:\\npm\\codex.cmd, which shadows the new install at ${join(f.vendorBin, "codex")}.`,
      "npm uninstall -g @openai/codex",
    ],
    never: ["Could not", "EINVAL", "spawn failed"],
    runs: LATEST_POSIX_LINES,
    launchers: true,
    wired: true,
  },
  {
    name: "the dry run names every installer line, every write it would make, and the config write, and runs and writes nothing",
    opts: {},
    args: { clis: true, dryRun: true },
    lines: (f) => [
      "Would install Claude Code CLI (latest) through its vendor's installer.",
      `runs: curl -fsSL ${CLAUDE_SH} | bash`,
      `would link: ${join(f.vendorBin, "claude")} (to ${join(f.home, ".local", "share", "claude", "versions")}/<version>)`,
      `would write: ${join(f.home, ".claude", "downloads")}/ (a download it removes again)`,
      `would write: ${join(f.home, ".claude", ".claude.json")} (the install method it records)`,
      "Would install GitHub Copilot CLI (latest) through its vendor's installer.",
      `runs: curl -fsSL ${COPILOT_SH} | bash`,
      `would write: ${join(f.home, ".profile")} (a PATH line it offers to append when its directory is not on PATH)`,
      "Would install Codex CLI (latest) through its vendor's installer.",
      `runs: curl -fsSL ${CODEX_SH} | CODEX_NON_INTERACTIVE=1 sh`,
      `would link: ${join(f.vendorBin, "codex")} (to ${join(f.home, ".codex", "packages", "standalone", "current", "bin", "codex")})`,
      "Would set shell.launchers to true (--clis turns the launchers on).",
      "Launchers: enabled (the shell.launchers config key)",
      "DRY RUN: nothing was written.",
    ],
    never: ["Installing", "Set shell.launchers", "created ->", "linked ->"],
    runs: [],
    launchers: false,
    wired: false,
  },
  {
    name: "--no-prereqs reports each CLI as found, absent, or broken with the reason, installs nothing, and leaves the launchers off",
    opts: { preinstalled: ["claude"], brokenOnPath: ["codex"] },
    args: { clis: true, noPrereqs: true },
    lines: (f) => [
      `Claude Code CLI: claude 9.9.9 (fake) (${join(f.pathBin, "claude")}).`,
      // The basic reporter (NO_COLOR, pinned for the suite) keeps the backticks CI sees too.
      "GitHub Copilot CLI ('copilot') is not installed; `agent shell --clis` installs it.",
      `Codex CLI: ${join(f.pathBin, "codex")} is installed, but 'codex --version' did not run (exit 1; stderr: boom).`,
      "Launchers: disabled (the shell.launchers config key)",
    ],
    never: ["Installing", "Would", "shell.launchers to true"],
    runs: [],
    launchers: false,
    wired: true,
  },
  {
    name: "--no-prereqs reads an npm .cmd shim on PATH as broken by its extension, with the uninstall line, and never spawns it",
    opts: {
      preinstalled: ["claude", "copilot"],
      look: (command, path) =>
        command === "codex"
          ? { kind: "found", path: "C:\\npm\\codex.cmd" }
          : findCommand(command, path),
    },
    args: { clis: true, noPrereqs: true },
    lines: () => [
      "Codex CLI: C:\\npm\\codex.cmd is installed, but 'codex --version' did not run (C:\\npm\\codex.cmd is an npm-installed copy of codex this build cannot run; npm uninstall -g @openai/codex, then agent shell --clis).",
    ],
    never: ["Installing", "spawn failed", "EINVAL"],
    runs: [],
    launchers: false,
    wired: true,
  },
];

test.skipIf(process.platform === "win32")(
  "shell --clis: every vendor installer runs as documented, its writes are on the ledger, each outcome is reported as itself, the other CLIs still install, the launchers turn on, and the wiring lands",
  async () => {
    for (const row of CLI_INSTALL_ROWS) {
      const restore = envSnapshot(CLI_ENV_EXTRAS);
      let dir = "";
      let proxyHome = isolateProxyHome("copilot-setup-clis-home-");
      try {
        const fixture = stageFixture(row.opts);
        dir = fixture.dir;
        const output = (
          await captureChannels(() => runShell(row.args, fixture.deps), { writeReports: true })
        ).all;
        for (const line of row.lines(fixture)) expect(output, row.name).toContain(line);
        for (const line of row.never) expect(output, row.name).not.toContain(line);
        expect(
          fixture.runs.map((command) => command.line),
          row.name,
        ).toEqual([...row.runs]);
        expect(new CopilotEnvConfig().launchersEnabled(), row.name).toBe(row.launchers);
        expect(readFileSync(fixture.bashrc, "utf-8").includes(MARKER), row.name).toBe(row.wired);
        expect(existsSync(fixture.bashrc), row.name).toBe(true);
      } finally {
        restore();
        dir = removeDir(dir);
        proxyHome = removeDir(proxyHome);
      }
    }
  },
);
