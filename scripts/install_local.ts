// `deno task install [--force] [installer flags]`: compile the host binary, then run the
// platform installer with COPILOT_ENV_DOWNLOAD_BASE at dist/ (the same override CI smokes
// use), so the result is exactly a release install whose source is this checkout.
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { currentReleaseTarget } from "../src/install/targets.ts";
import { looksLikeInstallRoot } from "../src/utils/root.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function die(message: string): never {
  console.error(`ERROR: ${message}`);
  Deno.exit(2);
}

/** The installers' flags, POSIX spelling on the left; the task forwards them untouched on
 *  POSIX and by this table on Windows. `value` names the argument a flag takes. */
interface ForwardedFlag {
  readonly posix: string;
  readonly windows: string;
  readonly value?: string;
  readonly windowsOnly?: true;
  readonly help: string;
}

const FORWARDED_FLAGS: readonly ForwardedFlag[] = [
  {
    posix: "--dir",
    windows: "-InstallDir",
    value: "DIR",
    help: "Install target (default ~/.copilot-env). Takes precedence over $COPILOT_ENV_DIR.",
  },
  {
    posix: "--no-shell-integration",
    windows: "-NoShellIntegration",
    help: "Do not wire ~/.bashrc / ~/.zshrc / $PROFILE. Run `agent shell` later to enable it.",
  },
  { posix: "--yes", windows: "-Yes", help: "Reload your shell at the end without asking." },
  { posix: "--no", windows: "-No", help: "Do not reload your shell at the end, and do not ask." },
  {
    posix: "--all-hosts",
    windows: "-AllHosts",
    windowsOnly: true,
    help: "Windows only: wire the CurrentUserAllHosts PowerShell profile instead of the host's.",
  },
];

const target = currentReleaseTarget();
if (target === null) {
  die(`no release target for this platform (${process.platform}/${process.arch}).`);
}
const isWindows = target.os === "win32";

function usage(): string {
  const width = Math.max(...FORWARDED_FLAGS.map((f) => `${f.posix} ${f.value ?? ""}`.length));
  const row = (flag: string, help: string) => `  ${flag.padEnd(width)}  ${help}`;
  return [
    "Usage: deno task install [--force] [installer flags]",
    "",
    "Compiles the host-target binary into dist/ and installs it via the platform",
    "installer (COPILOT_ENV_DOWNLOAD_BASE=dist/).",
    "",
    "Task flags:",
    row(
      "--force",
      "Delete the existing install root (--dir, else $COPILOT_ENV_DIR, else ~/.copilot-env) first.",
    ),
    "",
    `Installer flags (forwarded to ${isWindows ? "install.ps1" : "install.sh"}):`,
    ...FORWARDED_FLAGS.map((f) => row(`${f.posix} ${f.value ?? ""}`.trimEnd(), f.help)),
    "",
    "--version is not accepted: the task installs the binary it just compiled.",
  ].join("\n");
}

let force = false;
const forwarded: { flag: ForwardedFlag; value?: string }[] = [];
const args = [...Deno.args];
while (args.length > 0) {
  const arg = args.shift() ?? "";
  const eq = arg.indexOf("=");
  const name = eq === -1 ? arg : arg.slice(0, eq);
  const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);
  if (arg === "--force") {
    force = true;
    continue;
  }
  if (arg === "-h" || arg === "--help") {
    console.log(usage());
    Deno.exit(0);
  }
  if (name === "--version") {
    die(
      "--version is not accepted: the task installs the binary it just compiled " +
        "(COPILOT_ENV_DOWNLOAD_BASE=dist/), and the installer resolves no release tag there.",
    );
  }
  const flag = FORWARDED_FLAGS.find((f) => f.posix === name);
  if (flag === undefined) die(`unknown argument '${arg}' (try --help)`);
  if (flag.windowsOnly && !isWindows) {
    die(`${flag.posix}: install.sh has no such flag (Windows only).`);
  }
  // PowerShell refuses a repeated parameter, and by then --force has deleted the root.
  if (forwarded.some((f) => f.flag === flag)) die(`${flag.posix} given more than once.`);
  if (flag.value === undefined) {
    if (inlineValue !== undefined) die(`${flag.posix} takes no value.`);
    forwarded.push({ flag });
    continue;
  }
  const value = inlineValue ?? args.shift();
  if (value === undefined || value === "") die(`${flag.posix} needs a ${flag.value} argument.`);
  // An absolute --dir: the --force deletion and the installer then name the same path, and the
  // installer's lexical refusal of "." components cannot fire after the deletion.
  forwarded.push({ flag, value: flag.posix === "--dir" ? resolve(value) : value });
}
const given = (posix: string) => forwarded.find((f) => f.flag.posix === posix);
if (given("--yes") && given("--no")) die("--yes and --no conflict; pass one.");
const installDirArg = given("--dir")?.value;

function run(command: string, args: string[], env: Record<string, string> = {}): void {
  const { code } = new Deno.Command(command, {
    args,
    cwd: ROOT,
    env,
    stdout: "inherit",
    stderr: "inherit",
  }).outputSync();
  if (code !== 0) Deno.exit(code);
}

run("deno", ["task", "compile", "--target", target.triple]);

// Delete only after a successful compile, so a broken build never leaves the
// machine with no install at all.
if (force) {
  // The installers' exact precedence (--dir, then `${COPILOT_ENV_DIR:-default}`, PS
  // falsy-empty): only the EMPTY value reads as unset, or deletion and install could diverge.
  const envDir = process.env.COPILOT_ENV_DIR;
  const requested = installDirArg ??
    (envDir !== undefined && envDir !== "" ? envDir : join(homedir(), ".copilot-env"));
  if (existsSync(requested)) {
    // Physical paths on BOTH sides (mirrors the installers' canonicalization):
    // a case-aliased or symlinked spelling must not bypass the checkout guard,
    // and a symlinked install root must be judged (and refused) by its target.
    const installDir = realpathSync(requested);
    if (installDir === realpathSync(ROOT)) {
      die(`refusing --force: the install dir ${installDir} is this checkout.`);
    }
    if (!looksLikeInstallRoot(installDir)) {
      die(`refusing --force: ${installDir} does not look like a copilot-env install root.`);
    }
    console.error(`==> --force: removing ${installDir}`);
    rmSync(installDir, { recursive: true, force: true });
    // Recreate the canonical dir empty: a symlinked install root keeps pointing
    // at a live directory (the installer then fills it through the link), and
    // for a plain dir this is a harmless no-op the installer overwrites.
    mkdirSync(installDir, { recursive: true });
  }
}

const installerArgs = forwarded.flatMap(({ flag, value }) => [
  isWindows ? flag.windows : flag.posix,
  ...(value === undefined ? [] : [value]),
]);
const env = { "COPILOT_ENV_DOWNLOAD_BASE": join(ROOT, "dist") };
if (isWindows) {
  run(
    "powershell",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(ROOT, "install.ps1"),
      ...installerArgs,
    ],
    env,
  );
} else {
  // install.sh is a bash script (arrays); plain `sh` is dash on Debian/Ubuntu.
  run("bash", [join(ROOT, "install.sh"), ...installerArgs], env);
}
