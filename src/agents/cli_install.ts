// The agent CLIs copilot-env installs (`agent shell --clis`) and probes (`agent health`), each
// through its vendor's own installer, run as the vendor documents it: the vendor owns PATH,
// checksums, and self-update.
import { spawnSync } from "node:child_process";
import { posix, win32 } from "node:path";
import { consola } from "consola";
import type { ProbeFetch } from "../copilot_api/integration_identity.ts";
import { AGED_RELEASE_HORIZON, type ReleaseRepo, resolveAged } from "../install/resolve-release.ts";
import { assertNever } from "../utils/assert.ts";
import {
  type CommandLook,
  childEnv,
  currentPath,
  findCommand,
  LOOK_KILL_SIGNAL,
  POWERSHELL_COMMAND_TIMEOUT_MS,
  scratchPowershellProfile,
  withPowershellChildEnv,
} from "../utils/command.ts";
import { errMessage } from "../utils/error.ts";
import * as fs from "../utils/fs_facade.ts";
import { userHomeDir } from "../utils/home.ts";
import { caught, type ScannableMessage, scannable } from "../utils/message.ts";
import { reportValueWrite, reportWrite } from "../utils/report_write.ts";
import { sameVersion } from "../utils/semver.ts";
import { quotePowerShell } from "../utils/shell_quote.ts";

export const AGENT_CLIS = [
  { command: "claude", name: "Claude Code CLI" },
  { command: "copilot", name: "GitHub Copilot CLI" },
  { command: "codex", name: "Codex CLI" },
] as const;

export type AgentCli = (typeof AGENT_CLIS)[number];
export type CliCommand = AgentCli["command"];

/** Claude Code's documented POSIX one-liner; `bash -s stable` is the cooldown's channel pin. */
const CLAUDE_INSTALL_SH = "https://claude.ai/install.sh";

/** The Windows twin; a pin needs the scriptblock form, since `irm | iex` takes no argument. */
const CLAUDE_INSTALL_PS1 = "https://claude.ai/install.ps1";

/** GitHub's short link to the Copilot CLI installer; `VERSION=<pin>` in its environment pins it. */
const COPILOT_INSTALL_SH = "https://gh.io/copilot-install";

/** The Copilot CLI's winget package id: on Windows winget is the vendor's only installer. */
const COPILOT_WINGET_ID = "GitHub.Copilot";

/** Named as the manual download when winget is unavailable (an MSI, or the zip onto PATH). */
const COPILOT_RELEASES_URL = "https://github.com/github/copilot-cli/releases";

/** The winget community source's id: the second half of a portable's package directory name. */
const WINGET_SOURCE_ID = "Microsoft.Winget.Source_8wekyb3d8bbwe";

/** winget's own package data under %LOCALAPPDATA%: its tracking catalog, settings, and logs. */
const WINGET_PACKAGE_DATA = ["Packages", "Microsoft.DesktopAppInstaller_8wekyb3d8bbwe"];

/** The source package a due source refresh deploys, its version decided at the time. */
const WINGET_SOURCE_PACKAGE = "Microsoft.Winget.Source_<version>_neutral__8wekyb3d8bbwe";

/** The package directory name and Apps & features key of the GitHub.Copilot portable. */
const COPILOT_WINGET_PACKAGE = `${COPILOT_WINGET_ID}_${WINGET_SOURCE_ID}`;

/** The Apps & features hive a user-scope portable's uninstall entry goes under. */
const WINDOWS_UNINSTALL_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";

/** The PowerShell MSIX's full package name, version and architecture decided at install time. */
const PWSH_MSIX_PACKAGE = "Microsoft.PowerShell_<version>_<arch>__8wekyb3d8bbwe";

/** The Codex installer: CODEX_NON_INTERACTIVE=1 stops its prompts; `--release <pin>` pins it. */
const CODEX_INSTALL_SH = "https://chatgpt.com/codex/install.sh";

/** The Windows twin; a pin travels as `-Release <version>` through the scriptblock form. */
const CODEX_INSTALL_PS1 = "https://chatgpt.com/codex/install.ps1";

/** A `--version` can cold-start a CLI, so seconds; a minute would be a hang. */
const CLI_VERSION_TIMEOUT_MS = 15_000;

/** winget's APPINSTALLER_CLI_ERROR_UPDATE_NOT_APPLICABLE (0x8A15002B) as a spawn's int32 status. */
export const WINGET_UPDATE_NOT_APPLICABLE = -1978335189;

/** The User PATH the Codex Windows installer and winget edit. */
const WINDOWS_USER_PATH = "HKCU\\Environment\\Path";

/** A union so the representation cannot carry the --no-sudo/--no-prereqs conflict the parser
 *  rejects. */
export type CliSetup = { mode: "verify-only" } | CliInstall;

type CliInstall = {
  /** The discriminant against CliSetup's verify-only arm, which carries no knobs. */
  mode: "install";

  /** Days of release aging; null = each vendor's latest. */
  cooldown: number | null;

  /** No system package manager: on Windows that is winget, the Copilot CLI's only installer. */
  noSudo: boolean;
};

/** The host an install is planned for: what the vendors' install scripts read to decide where
 *  they write. The knobs `env` carries, as the installers read them: CODEX_INSTALL_DIR and
 *  CODEX_HOME (Codex), PREFIX, ZDOTDIR, and XDG_CONFIG_HOME (the Copilot CLI), XDG_DATA_HOME,
 *  XDG_STATE_HOME, XDG_CACHE_HOME, and CLAUDE_CONFIG_DIR (Claude Code), and SHELL (both profile
 *  picks). */
export interface InstallHost {
  /** Picks the path flavour and each vendor's Windows arm, so any OS's plan is computable here. */
  platform: NodeJS.Platform;

  /** The POSIX installers' default prefix root and profile home (Claude's Windows writes too). */
  home: string;

  /** %LOCALAPPDATA%: winget's portable layout and the Codex Windows install land under it. */
  localAppData: string;

  /** The vendors' own knobs, read as their installers read them (the list is in the doc above). */
  env: Record<string, string | undefined>;

  /** Root on POSIX: the Copilot installer's PREFIX then defaults to /usr/local. */
  root: boolean;

  /** The Copilot installer picks a bash profile by which of the user's files exist. */
  exists(path: string): boolean;
}

/** One write an installer makes outside copilot-env's homes; a `value` is a registry value, no
 *  file. */
export type VendorWrite =
  | { kind: "file"; path: string; detail?: string }
  | { kind: "link"; path: string; target: string; detail?: string }
  | { kind: "value"; path: string; detail: string };

/** How one vendor installs its CLI. `pin` is what `--cooldown` resolved: Claude's `stable`
 *  channel, a release version for a GitHub-released CLI, or null for the vendor's latest;
 *  `releases.version` spells a tag the way the installer takes it. */
interface Vendor {
  /** The repo whose newest old-enough stable release is the pin; null for a channel vendor. */
  releases: { repo: ReleaseRepo; version(tag: string): string } | null;

  /** The npm package an older install came from, named when such a copy shadows the new one. */
  npmPackage: string;

  /** The vendor's documented one-liner for a POSIX shell. */
  posixLine(pin: string | null): string;

  /** The vendor's PowerShell installer, or winget where that is all the vendor offers. */
  windows:
    | { kind: "powershell"; line(pin: string | null): string }
    | { kind: "winget"; id: string; manualDownload: string };

  /** The directory the installer puts the binary in, as its script resolves it from `host`
   *  (winget: the package directory of its portable layout). */
  binDir(host: InstallHost): string;

  /** What the installer writes outside copilot-env's homes, in the order it lands them, `binary`
   *  (installedBinaryPath) among them. */
  writes(host: InstallHost, binary: string): VendorWrite[];
}

/** One vendor installer run; `line` is the vendor's documented spelling, for the narration. */
export interface InstallerCommand {
  cli: CliCommand;
  kind: "posix" | "powershell" | "winget";
  file: string;
  args: string[];
  line: string;
  writes: VendorWrite[];
}

export type InstallPlan =
  | { kind: "run"; command: InstallerCommand }
  | { kind: "refused"; message: ScannableMessage };

/** What a spawned installer left behind; `status` null with no error is a signal death. */
export interface InstallerResult {
  status: number | null;
  signal?: string | null;
  error?: Error;
}

export type InstallerVerdict =
  | { kind: "installed" }
  /** winget's no-applicable-upgrade exit: the package was already current. */
  | { kind: "already-current" }
  | { kind: "failed"; detail: string };

export type VersionProof = { kind: "version"; line: string } | { kind: "failed"; detail: string };

/** The spawns and the network behind an install pass; tests hand installAgentClis a fake. */
export interface CliInstallDeps {
  /** Runs one installer for the user on inherited stdio. */
  run(command: InstallerCommand): InstallerResult;

  /** The GitHub Releases read behind `--cooldown`. */
  fetch: ProbeFetch;

  /** The PATH walk over `path`, the PATH an installer may just have changed. */
  look(command: string, path: string): CommandLook;

  /** `<path> --version` with `searchPath` as the child's PATH. */
  version(path: string, searchPath: string): VersionProof;
}

/** `candidate` is the vendor's install path nothing was found at. */
type Proof =
  | { kind: "found"; version: string }
  | { kind: "broken"; path: string; detail: string }
  | { kind: "absent"; candidate: string };

/** What `--cooldown` resolved for one vendor (see Vendor), or why it could not. */
type Pin =
  | { kind: "pin"; value: string | null; label: string }
  | { kind: "unread"; repo: string; cooldown: number }
  | { kind: "too-fresh"; repo: string; cooldown: number };

function pathOf(host: InstallHost): typeof posix | typeof win32 {
  return host.platform === "win32" ? win32 : posix;
}

/** A directory spelled with its trailing separator, as the disclosures name a tree. */
function tree(host: InstallHost, ...segments: string[]): string {
  const path = pathOf(host);
  return `${path.join(...segments)}${path.sep}`;
}

/** A vendor knob as the installers read it: `${VAR:-default}` in the shell scripts takes an empty
 *  value as unset, IsNullOrWhiteSpace in the PowerShell one a blank one too. */
function knob(host: InstallHost, name: string): string | undefined {
  const value = host.env[name];
  if (value === undefined) return undefined;
  const unset = host.platform === "win32" ? value.trim() === "" : value === "";
  return unset ? undefined : value;
}

/** The Codex installer's pick_profile: `case "$os:$SHELL"` on a SHELL ending in /zsh or /bash,
 *  else ~/.profile. */
function codexProfile(host: InstallHost): string {
  const shell = host.env.SHELL ?? "";
  const darwin = host.platform === "darwin";
  if (shell.endsWith("/zsh")) return posix.join(host.home, darwin ? ".zprofile" : ".zshrc");
  if (shell.endsWith("/bash")) return posix.join(host.home, darwin ? ".bash_profile" : ".bashrc");
  return posix.join(host.home, ".profile");
}

/** The Copilot installer's RC_FILE: zsh's `${ZDOTDIR:-$HOME}/.zprofile`; for bash the first of
 *  ~/.bash_profile and ~/.bash_login that exists, else ~/.profile; fish's conf.d file; else
 *  ~/.profile. */
function copilotProfile(host: InstallHost): string {
  switch (posix.basename(host.env.SHELL || "/bin/sh")) {
    case "zsh":
      return posix.join(knob(host, "ZDOTDIR") ?? host.home, ".zprofile");
    case "bash": {
      const candidates = [".bash_profile", ".bash_login"].map((name) =>
        posix.join(host.home, name),
      );
      return candidates.find((path) => host.exists(path)) ?? posix.join(host.home, ".profile");
    }
    case "fish":
      return posix.join(
        knob(host, "XDG_CONFIG_HOME") ?? posix.join(host.home, ".config"),
        "fish",
        "conf.d",
        "copilot.fish",
      );
    default:
      return posix.join(host.home, ".profile");
  }
}

function codexBinDir(host: InstallHost): string {
  const set = knob(host, "CODEX_INSTALL_DIR");
  if (set !== undefined) return set;
  return host.platform === "win32"
    ? win32.join(host.localAppData, "Programs", "OpenAI", "Codex", "bin")
    : posix.join(host.home, ".local", "bin");
}

const VENDORS: Record<CliCommand, Vendor> = {
  claude: {
    releases: null,
    npmPackage: "@anthropic-ai/claude-code",
    posixLine: (pin) => `curl -fsSL ${CLAUDE_INSTALL_SH} | bash${pin === null ? "" : ` -s ${pin}`}`,
    windows: {
      kind: "powershell",
      line: (pin) =>
        pin === null
          ? `irm ${CLAUDE_INSTALL_PS1} | iex`
          : `& ([scriptblock]::Create((irm ${CLAUDE_INSTALL_PS1}))) ${pin}`,
    },
    binDir: (host) => pathOf(host).join(host.home, ".local", "bin"),
    // As the vendor lists them: the launcher, a symlink into the data home's versions/; the data,
    // state, and cache homes under their XDG knobs; the download; and the global config file,
    // under CLAUDE_CONFIG_DIR when set. Windows is documented as writing under %USERPROFILE%.
    writes: (host, binary) => {
      const downloads: VendorWrite = {
        kind: "file",
        path: tree(host, host.home, ".claude", "downloads"),
        detail: "a download it removes again",
      };
      const config: VendorWrite = {
        kind: "file",
        path: pathOf(host).join(knob(host, "CLAUDE_CONFIG_DIR") ?? host.home, ".claude.json"),
        detail: "the install method it records",
      };
      if (host.platform === "win32") {
        return [
          { kind: "file", path: binary },
          { kind: "file", path: tree(host, host.home, ".local", "share", "claude") },
          downloads,
          config,
        ];
      }
      const xdg = (name: string, ...fallback: string[]): string =>
        knob(host, name) ?? posix.join(host.home, ...fallback);
      const data = xdg("XDG_DATA_HOME", ".local", "share");
      return [
        {
          kind: "link",
          path: binary,
          target: `${tree(host, data, "claude", "versions")}<version>`,
        },
        { kind: "file", path: tree(host, data, "claude"), detail: "each version it downloads" },
        {
          kind: "file",
          path: tree(host, xdg("XDG_STATE_HOME", ".local", "state"), "claude"),
          detail: "its lock files",
        },
        {
          kind: "file",
          path: tree(host, xdg("XDG_CACHE_HOME", ".cache"), "claude"),
          detail: "staged downloads",
        },
        downloads,
        config,
      ];
    },
  },
  copilot: {
    releases: {
      repo: { repo: "github/copilot-cli", tagPattern: /^v\d+\.\d+\.\d+$/ },
      version: (tag) => tag,
    },
    npmPackage: "@github/copilot",
    posixLine: (pin) =>
      `curl -fsSL ${COPILOT_INSTALL_SH} | ${pin === null ? "" : `VERSION=${pin} `}bash`,
    // The GitHub.Copilot manifest: a zip whose portable is copilot.exe, command `copilot`, and a
    // Microsoft.PowerShell 7 dependency winget installs first where the host lacks it.
    windows: {
      kind: "winget",
      id: COPILOT_WINGET_ID,
      manualDownload: `${COPILOT_RELEASES_URL} (copilot-x64.msi, or copilot-win32-x64.zip onto PATH)`,
    },
    binDir: (host) => {
      if (host.platform === "win32") {
        return win32.join(
          host.localAppData,
          "Microsoft",
          "WinGet",
          "Packages",
          COPILOT_WINGET_PACKAGE,
        );
      }
      const prefix =
        knob(host, "PREFIX") ?? (host.root ? "/usr/local" : posix.join(host.home, ".local"));
      return posix.join(prefix, "bin");
    },
    writes: (host, binary) => {
      if (host.platform !== "win32") {
        return [
          { kind: "file", path: binary },
          {
            kind: "file",
            path: copilotProfile(host),
            detail: "a PATH line it offers to append when its directory is not on PATH",
          },
        ];
      }
      const windowsApps = win32.join(host.env.ProgramFiles ?? "C:\\Program Files", "WindowsApps");
      const pwsh = win32.join(windowsApps, PWSH_MSIX_PACKAGE);
      return [
        { kind: "file", path: binary },
        // The archive's files land beside winget's portable index, <PackageId>_<SourceId>.db.
        {
          kind: "file",
          path: tree(host, VENDORS.copilot.binDir(host)),
          detail: "the archive's other files and winget's portable index",
        },
        // The alias is a symlink where the process may make one (Developer Mode or elevation);
        // otherwise the package directory goes on the PATH in the Links directory's place.
        {
          kind: "link",
          path: win32.join(host.localAppData, "Microsoft", "WinGet", "Links", "copilot.exe"),
          target: binary,
          detail: "where winget can make a symlink; else its directory goes on the PATH",
        },
        { kind: "value", path: WINDOWS_USER_PATH, detail: "the User PATH" },
        {
          kind: "value",
          path: `${WINDOWS_UNINSTALL_KEY}\\${COPILOT_WINGET_PACKAGE}`,
          detail: "its Apps & features entry",
        },
        {
          kind: "file",
          path: tree(host, host.localAppData, ...WINGET_PACKAGE_DATA),
          detail: "winget's own state: tracking, settings, logs",
        },
        {
          kind: "file",
          path: tree(host, windowsApps, WINGET_SOURCE_PACKAGE),
          detail: "its source index, when winget refreshes its source",
        },
        // Under the user scope winget takes the dependency's MSIX arm (its MSI arms are machine
        // scope): the package lands under WindowsApps, with pwsh.exe as an execution alias. Its
        // package family is Microsoft.PowerShell_8wekyb3d8bbwe.
        {
          kind: "file",
          path: `${pwsh}${win32.sep}`,
          detail: "pwsh 7 as its MSIX package, when PowerShell 7 is absent",
        },
        {
          kind: "link",
          path: win32.join(host.localAppData, "Microsoft", "WindowsApps", "pwsh.exe"),
          target: win32.join(pwsh, "pwsh.exe"),
          detail: "its execution alias, when PowerShell 7 is absent",
        },
      ];
    },
  },
  codex: {
    releases: {
      repo: { repo: "openai/codex", tagPattern: /^rust-v\d+\.\d+\.\d+$/ },
      version: (tag) => tag.slice("rust-v".length),
    },
    npmPackage: "@openai/codex",
    posixLine: (pin) =>
      `curl -fsSL ${CODEX_INSTALL_SH} | CODEX_NON_INTERACTIVE=1 sh${
        pin === null ? "" : ` -s -- --release ${pin}`
      }`,
    windows: {
      kind: "powershell",
      line: (pin) =>
        `$env:CODEX_NON_INTERACTIVE = '1'; ${
          pin === null
            ? `irm ${CODEX_INSTALL_PS1} | iex`
            : `& ([scriptblock]::Create((irm ${CODEX_INSTALL_PS1}))) -Release ${pin}`
        }`,
    },
    binDir: codexBinDir,
    // The visible command is a link into the release the standalone tree's `current` link
    // selects: on Windows the bin directory itself is a junction (its install.ps1 Ensure-Junction),
    // holding codex.exe and rg.exe; on POSIX codex, and on macOS codex-code-mode-host, are symlinks
    // (its install.sh update_visible_command), and rg lives inside the tree.
    writes: (host, binary) => {
      const path = pathOf(host);
      const codexHome = knob(host, "CODEX_HOME") ?? path.join(host.home, ".codex");
      const current = (...segments: string[]): string =>
        path.join(codexHome, "packages", "standalone", "current", ...segments);
      const standalone: VendorWrite = {
        kind: "file",
        path: tree(host, codexHome, "packages", "standalone"),
      };
      if (host.platform === "win32") {
        const bin = codexBinDir(host);
        return [
          {
            kind: "link",
            path: bin,
            target: `${current("bin")}${win32.sep}`,
            detail: "a junction",
          },
          { kind: "file", path: binary },
          { kind: "file", path: win32.join(bin, "rg.exe"), detail: "ripgrep, beside codex.exe" },
          standalone,
          { kind: "value", path: WINDOWS_USER_PATH, detail: "the User PATH" },
        ];
      }
      return [
        { kind: "link", path: binary, target: current("bin", "codex") },
        ...(host.platform === "darwin"
          ? [
              {
                kind: "link" as const,
                path: posix.join(codexBinDir(host), "codex-code-mode-host"),
                target: current("bin", "codex-code-mode-host"),
              },
            ]
          : []),
        standalone,
        {
          kind: "file",
          path: codexProfile(host),
          detail: "a PATH block it appends when its directory is not on PATH",
        },
      ];
    },
  },
};

export type AgentCliLook =
  | { kind: "found"; path: string }
  | { kind: "absent" }
  | { kind: "npm-shim"; path: string; note: string };

/** The classification over a raw PATH look (the install fixtures inject one). Pure. */
export function classifyAgentCli(command: CliCommand, look: CommandLook): AgentCliLook {
  if (look.kind === "absent") return look;
  // An npm .cmd or .bat shim needs cmd.exe, which nothing of ours routes through (a direct spawn
  // is EINVAL).
  if (!/\.(?:cmd|bat)$/i.test(look.path)) return { kind: "found", path: look.path };
  return {
    kind: "npm-shim",
    path: look.path,
    note: `${look.path} is an npm-installed copy of ${command} this build cannot run; npm uninstall -g ${VENDORS[command].npmPackage}, then agent shell --clis`,
  };
}

/** The one look every agent-CLI spawn site takes, over `searchPath`. */
export function resolveAgentCli(
  command: CliCommand,
  searchPath: string = currentPath(),
): AgentCliLook {
  return classifyAgentCli(command, findCommand(command, searchPath));
}

export function installedBinaryPath(cli: AgentCli, host: InstallHost): string {
  const name = host.platform === "win32" ? `${cli.command}.exe` : cli.command;
  return pathOf(host).join(VENDORS[cli.command].binDir(host), name);
}

/** The POSIX line runs under `bash -o pipefail`, so a curl that fails leaves no exit 0 behind
 *  it. */
export function planCliInstall(
  cli: AgentCli,
  pin: string | null,
  host: InstallHost,
  noSudo: boolean,
): InstallPlan {
  const vendor = VENDORS[cli.command];
  const writes = vendor.writes(host, installedBinaryPath(cli, host));
  if (host.platform !== "win32") {
    const line = vendor.posixLine(pin);
    return {
      kind: "run",
      command: {
        cli: cli.command,
        kind: "posix",
        file: "bash",
        args: ["-o", "pipefail", "-c", line],
        line,
        writes,
      },
    };
  }

  const windows = vendor.windows;
  if (windows.kind === "powershell") {
    const line = windows.line(pin);
    return {
      kind: "run",
      command: {
        cli: cli.command,
        kind: "powershell",
        file: "powershell",
        args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", line],
        line,
        writes,
      },
    };
  }

  if (noSudo) {
    return {
      kind: "refused",
      message: scannable({
        headline: `${cli.name} is left alone: --no-sudo rules out winget, its only installer on Windows.`,
        lead: "Pick one:",
        actions: [
          ["agent shell --clis", "let winget install it"],
          [windows.manualDownload, "install it yourself"],
        ],
      }),
    };
  }
  // The scope and location are pinned, so winget's own settings move nothing the ledger names.
  const args = [
    "install",
    "--id",
    windows.id,
    "--exact",
    "--scope",
    "user",
    "--location",
    vendor.binDir(host),
    "--accept-package-agreements",
    "--accept-source-agreements",
    ...(pin === null ? [] : ["--version", pin]),
  ];
  return {
    kind: "run",
    command: {
      cli: cli.command,
      kind: "winget",
      file: "winget",
      args,
      line: `winget ${args.map(spelled).join(" ")}`,
      writes,
    },
  };
}

/** For the narrated line, as a PowerShell user types it (a Windows user directory often holds a
 *  space); the spawn gets the argv literal. */
function spelled(arg: string): string {
  return /^[\w.:\\/-]+$/.test(arg) ? arg : quotePowerShell(arg);
}

/** winget's UPDATE_NOT_APPLICABLE means the package is installed and no upgrade applies, so a
 *  re-run is current, not failed. */
export function judgeInstallerExit(
  command: InstallerCommand,
  result: InstallerResult,
): InstallerVerdict {
  if (result.error)
    return { kind: "failed", detail: `the installer did not start: ${errMessage(result.error)}` };
  if (result.status === 0) return { kind: "installed" };
  if (command.kind === "winget" && result.status === WINGET_UPDATE_NOT_APPLICABLE) {
    return { kind: "already-current" };
  }
  const exit =
    result.status === null
      ? `was killed by ${result.signal ?? "a signal"}`
      : `exited ${result.status}`;
  return { kind: "failed", detail: `the installer ${exit}` };
}

export function currentHost(): InstallHost {
  const home = userHomeDir();
  return {
    platform: process.platform,
    home,
    localAppData: process.env.LOCALAPPDATA ?? win32.join(home, "AppData", "Local"),
    env: process.env,
    root: process.platform !== "win32" && process.getuid?.() === 0,
    exists: fs.exists,
  };
}

function runInstaller(command: InstallerCommand): InstallerResult {
  if (command.kind === "powershell") {
    return withPowershellChildEnv("powershell", (env) =>
      // biome-ignore lint/plugin/no_unbounded_child_spawn: a vendor installer runs for the user on inherited stdio
      spawnSync(command.file, command.args, { stdio: "inherit", env }),
    );
  }
  // biome-ignore lint/plugin/no_unbounded_child_spawn: a vendor installer runs for the user on inherited stdio
  return spawnSync(command.file, command.args, { stdio: "inherit" });
}

/** Exported for the installer smoke, which judges the same way. */
export function cliVersion(path: string, searchPath: string): VersionProof {
  const result = spawnSync(path, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    timeout: CLI_VERSION_TIMEOUT_MS,
    killSignal: LOOK_KILL_SIGNAL,
    env: childEnv({ path: searchPath }),
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return {
      kind: "failed",
      detail: `spawn failed${code ? ` (${code})` : ""}: ${errMessage(result.error)}`,
    };
  }
  const lines = (text: string | null | undefined): string[] =>
    (text ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
  const stderrTail = lines(result.stderr).at(-1);
  const said = stderrTail === undefined ? "" : `; stderr: ${stderrTail}`;
  if (result.status !== 0) {
    const exit =
      result.status === null ? `killed by ${result.signal ?? "a signal"}` : `exit ${result.status}`;
    return { kind: "failed", detail: `${exit}${said}` };
  }
  const first = lines(result.stdout)[0] ?? stderrTail;
  return first === undefined
    ? { kind: "failed", detail: "exit 0 with no output" }
    : { kind: "version", line: first };
}

export function defaultCliInstallDeps(): CliInstallDeps {
  return { run: runInstaller, fetch, look: findCommand, version: cliVersion };
}

/** The PATH a Windows installer may just have changed in the registry, re-read so the proof
 *  walks it. */
function refreshWindowsPath(): string | null {
  if (process.platform !== "win32") return null;
  const profile = scratchPowershellProfile();
  try {
    const result = withPowershellChildEnv("powershell", (env) =>
      spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          "$machine=[Environment]::GetEnvironmentVariable('Path','Machine');" +
            "$user=[Environment]::GetEnvironmentVariable('Path','User');" +
            "($machine,$user,$env:Path) -join ';'",
        ],
        {
          encoding: "utf8",
          env: { ...env, ...profile.env },
          timeout: POWERSHELL_COMMAND_TIMEOUT_MS,
          killSignal: LOOK_KILL_SIGNAL,
        },
      ),
    );
    if (result.status !== 0 || !result.stdout.trim()) {
      consola.warn("Could not re-read the PATH after the install; checking this process's own.");
      return null;
    }
    return result.stdout.trim();
  } finally {
    profile.dispose();
  }
}

export function hostSearchPath(): string {
  return refreshWindowsPath() ?? currentPath();
}

function assertWingetAvailable(deps: CliInstallDeps, searchPath: string): void {
  if (deps.look("winget", searchPath).kind === "found") return;
  throw new Error(
    `winget is unavailable; install App Installer from the Microsoft Store, or the CLI yourself from ${COPILOT_RELEASES_URL}`,
  );
}

/** One file is one file whatever its spelling or the link to it (winget's Links symlink is the
 *  package's copilot.exe, ~/.local/bin/claude the versions/ file it links). */
function samePath(a: string, b: string): boolean {
  const fold = (path: string): string =>
    process.platform === "win32" ? fs.realpath(path).toLowerCase() : fs.realpath(path);
  return fold(a) === fold(b);
}

/** Decided once for the pass and the installer smoke. `absent` whatever PATH holds: an older copy
 *  there proves no install. */
export type InstallProofTarget =
  | { kind: "destination"; path: string; onPath: "same" | "none" | { shadow: string } }
  | { kind: "absent"; destination: string };

export function installProofTarget(
  cli: AgentCli,
  host: InstallHost,
  onPath: AgentCliLook,
): InstallProofTarget {
  const destination = installedBinaryPath(cli, host);
  if (!host.exists(destination)) return { kind: "absent", destination };
  if (onPath.kind === "absent") return { kind: "destination", path: destination, onPath: "none" };
  const same = onPath.kind === "found" && samePath(onPath.path, destination);
  return {
    kind: "destination",
    path: destination,
    onPath: same ? "same" : { shadow: onPath.path },
  };
}

function notOnPathTail(binary: string): string {
  const dir = pathOf(currentHost()).dirname(binary);
  return `; ${dir} is not on this shell's PATH: add it where the installer did not, then open a new shell.`;
}

function proveBinary(
  cli: AgentCli,
  deps: CliInstallDeps,
  path: string,
  searchPath: string,
  tail: string,
): Proof {
  const proof = deps.version(path, searchPath);
  if (proof.kind === "failed") return { kind: "broken", path, detail: proof.detail };
  consola.info(`${cli.name}: ${proof.line} (${path})${tail}`);
  return { kind: "found", version: proof.line };
}

/** For a CLI nobody just installed; the vendor's path is tried after PATH, since an installer's
 *  PATH edit lands in new shells, not this process. */
function proveOnPath(cli: AgentCli, deps: CliInstallDeps, searchPath: string): Proof {
  const look = classifyAgentCli(cli.command, deps.look(cli.command, searchPath));
  if (look.kind === "npm-shim") return { kind: "broken", path: look.path, detail: look.note };
  if (look.kind === "found") return proveBinary(cli, deps, look.path, searchPath, ".");

  const candidate = installedBinaryPath(cli, currentHost());
  if (!fs.exists(candidate)) return { kind: "absent", candidate };
  return proveBinary(cli, deps, candidate, searchPath, notOnPathTail(candidate));
}

/** After an install the destination is proven, never an older copy ahead on PATH: an npm copy
 *  hides a broken native one, or fails a working one. */
function proveInstalled(cli: AgentCli, deps: CliInstallDeps, searchPath: string): Proof {
  const onPath = classifyAgentCli(cli.command, deps.look(cli.command, searchPath));
  const target = installProofTarget(cli, currentHost(), onPath);
  if (target.kind === "absent") return { kind: "absent", candidate: target.destination };

  const tail = target.onPath === "none" ? notOnPathTail(target.path) : ".";
  const proof = proveBinary(cli, deps, target.path, searchPath, tail);
  if (proof.kind === "found" && typeof target.onPath === "object") {
    consola.warn(
      scannable({
        headline: `${cli.name} on PATH is ${target.onPath.shadow}, which shadows the new install at ${target.path}.`,
        lead: "Pick one:",
        actions: [
          [`npm uninstall -g ${VENDORS[cli.command].npmPackage}`, "remove an npm copy"],
          [pathOf(currentHost()).dirname(target.path), "put this directory ahead on PATH"],
        ],
      }),
    );
  }
  return proof;
}

/** Under semver `v1.0.98` is `1.0.98`, and `1.0.9` is not. */
export type PinJudgement =
  | { kind: "pinned" }
  | { kind: "other"; proved: string }
  | { kind: "unverifiable" };

export function judgePin(line: string, pin: string): PinJudgement {
  const proved = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/.exec(line)?.[0];
  const same = proved === undefined ? null : sameVersion(proved, pin);
  if (proved === undefined || same === null) return { kind: "unverifiable" };
  return same ? { kind: "pinned" } : { kind: "other", proved };
}

/** Claude's `stable` channel runs about a week behind `latest`. */
async function resolvePin(
  cli: AgentCli,
  cooldown: number | null,
  deps: CliInstallDeps,
): Promise<Pin> {
  const { releases } = VENDORS[cli.command];
  if (releases === null) {
    return cooldown !== null && cooldown > 0
      ? { kind: "pin", value: "stable", label: "the stable channel, about a week behind latest" }
      : { kind: "pin", value: null, label: "latest" };
  }
  if (cooldown === null) return { kind: "pin", value: null, label: "latest" };

  const aged = await resolveAged(releases.repo, cooldown, { fetchImpl: deps.fetch });
  switch (aged.kind) {
    case "release": {
      const value = releases.version(aged.release.tag);
      return {
        kind: "pin",
        value,
        label: `${value}, the newest release at least ${cooldown} days old`,
      };
    }
    case "none":
      return { kind: "too-fresh", repo: releases.repo.repo, cooldown };
    case "unread":
      return { kind: "unread", repo: releases.repo.repo, cooldown };
    default:
      return assertNever(aged);
  }
}

function unpinnedMessage(cli: AgentCli, pin: Exclude<Pin, { kind: "pin" }>): ScannableMessage {
  const headline =
    pin.kind === "unread"
      ? `Could not read ${pin.repo}'s releases to pick one at least ${pin.cooldown} days old; skipping ${cli.name}.`
      : `No ${pin.repo} release among its newest ${AGED_RELEASE_HORIZON} is at least ${pin.cooldown} days old; skipping ${cli.name}.`;
  return scannable({
    headline,
    lead: "Fix:",
    actions: [["agent shell --clis", "take the vendor's latest instead"]],
  });
}

function writeDetail(write: VendorWrite, tail?: string): string {
  const target = write.kind === "link" ? `to ${write.target}` : undefined;
  return [target, write.detail, tail].filter((part) => part !== undefined).join(", ");
}

function wouldWrite(write: VendorWrite): string {
  const detail = writeDetail(write);
  const verb = write.kind === "link" ? "would link" : "would write";
  return `${verb}: ${write.path}${detail === "" ? "" : ` (${detail})`}`;
}

/** On the ledger before the installer runs. */
function discloseWrites(cli: AgentCli, command: InstallerCommand): void {
  for (const write of command.writes) {
    const detail = writeDetail(write, `by the ${cli.name} installer`);
    switch (write.kind) {
      case "file":
        reportWrite(fs.exists(write.path) ? "rewritten" : "created", write.path, detail);
        break;
      case "link":
        reportWrite("linked", write.path, detail);
        break;
      case "value":
        reportValueWrite(write.path, detail);
        break;
      default:
        assertNever(write);
    }
  }
}

/** The installer finished; the destination must prove itself, and a pinned version is checked
 *  against what it proved (a mismatch warns: the vendor's installer decided). */
function judgeInstalled(cli: AgentCli, pin: string | null, proof: Proof): void {
  switch (proof.kind) {
    case "found": {
      if (pin === null || VENDORS[cli.command].releases === null) return;
      const judged = judgePin(proof.version, pin);
      if (judged.kind === "other") {
        consola.warn(`${cli.name} proved ${judged.proved}, not the pinned ${pin}.`);
      }
      if (judged.kind === "unverifiable") {
        consola.warn(
          `${cli.name} proved "${proof.version}", a line naming no version to check against the pinned ${pin}.`,
        );
      }
      return;
    }
    case "broken":
      throw new Error(
        `the installer finished, but '${proof.path} --version' did not run (${proof.detail})`,
      );
    case "absent":
      throw new Error(
        `the installer finished, but ${proof.candidate} is absent; rerun 'agent shell --clis'`,
      );
    default:
      assertNever(proof);
  }
}

async function installCli(cli: AgentCli, setup: CliInstall, deps: CliInstallDeps): Promise<void> {
  const pin = await resolvePin(cli, setup.cooldown, deps);
  if (pin.kind !== "pin") {
    consola.warn(unpinnedMessage(cli, pin));
    return;
  }

  const plan = planCliInstall(cli, pin.value, currentHost(), setup.noSudo);
  if (plan.kind === "refused") {
    consola.warn(plan.message);
    return;
  }
  const { command } = plan;
  const searchPath = hostSearchPath();
  if (command.kind === "winget") assertWingetAvailable(deps, searchPath);

  const dry = fs.dryRunActive();
  consola.info(
    scannable({
      headline: `${dry ? "Would install" : "Installing"} ${cli.name} (${pin.label}) through its vendor's installer${dry ? "." : " ..."}`,
      evidence: [`runs: ${command.line}`, ...(dry ? command.writes.map(wouldWrite) : [])],
    }),
  );
  if (dry) return;

  discloseWrites(cli, command);
  const verdict = judgeInstallerExit(command, deps.run(command));
  if (verdict.kind === "failed") throw new Error(verdict.detail);
  if (verdict.kind === "already-current") {
    consola.info(`winget reports ${cli.name} already installed and current (0x8A15002B).`);
  }

  judgeInstalled(cli, pin.value, proveInstalled(cli, deps, hostSearchPath()));
}

/** Best-effort per CLI: a vendor installer that fails, or a CLI that cannot be proven, warns and
 *  the pass goes on, so the surrounding `agent shell` run still wires the integration. */
export async function installAgentClis(
  setup: CliSetup,
  deps: CliInstallDeps = defaultCliInstallDeps(),
): Promise<void> {
  switch (setup.mode) {
    case "verify-only": {
      const searchPath = hostSearchPath();
      for (const cli of AGENT_CLIS) {
        const proof = proveOnPath(cli, deps, searchPath);
        if (proof.kind === "broken") {
          consola.warn(
            `${cli.name}: ${proof.path} is installed, but '${cli.command} --version' did not run (${proof.detail}).`,
          );
        }
        if (proof.kind === "absent") {
          consola.warn(
            `${cli.name} ('${cli.command}') is not installed; \`agent shell --clis\` installs it.`,
          );
        }
      }
      return;
    }
    case "install": {
      for (const cli of AGENT_CLIS) {
        try {
          await installCli(cli, setup, deps);
        } catch (e) {
          consola.warn(
            caught(e, (message) => `Could not install ${cli.name} (${message}); continuing.`),
          );
        }
      }
      return;
    }
    default:
      assertNever(setup);
  }
}
