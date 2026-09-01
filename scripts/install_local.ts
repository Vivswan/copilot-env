// Install copilot-env from this checkout: compile the host-platform binary,
// then run the platform installer with COPILOT_ENV_DOWNLOAD_BASE pointed at
// dist/ -- the same override CI uses to smoke installers against branch
// builds, so the result is exactly a release install whose source is the
// repo. Invoked as `deno task install [--force]`.
//
// `--force` first deletes the existing install root -- the same directory the
// installer will target ($COPILOT_ENV_DIR, else ~/.copilot-env) -- for a
// from-scratch install. Deletion is guarded: never this checkout, and never a
// directory that does not carry the install-root markers.
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { currentReleaseTarget } from "../src/install/targets.ts";
import { looksLikeInstallRoot } from "../src/utils/root.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function die(message: string): never {
  console.error(`ERROR: ${message}`);
  Deno.exit(2);
}

let force = false;
for (const arg of Deno.args) {
  if (arg === "--force") {
    force = true;
  } else if (arg === "-h" || arg === "--help") {
    console.log(`Usage: deno task install [--force]

Compiles the host-target binary into dist/ and installs it via the platform
installer (COPILOT_ENV_DOWNLOAD_BASE=dist/). --force deletes the existing
install root ($COPILOT_ENV_DIR, else ~/.copilot-env) first.`);
    Deno.exit(0);
  } else {
    die(`unknown argument '${arg}' (try --help)`);
  }
}

const target = currentReleaseTarget();
if (target === null) {
  die(`no release target for this platform (${process.platform}/${process.arch}).`);
}

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
  // Exactly the installers' semantics (`${COPILOT_ENV_DIR:-default}` / PS
  // falsy-empty): only the EMPTY value reads as unset, everything else -- even
  // whitespace -- is used verbatim, or deletion and install could diverge.
  const envDir = process.env.COPILOT_ENV_DIR;
  const requested = envDir !== undefined && envDir !== ""
    ? envDir
    : join(homedir(), ".copilot-env");
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

const env = { "COPILOT_ENV_DOWNLOAD_BASE": join(ROOT, "dist") };
if (target.os === "win32") {
  run(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(ROOT, "install.ps1")],
    env,
  );
} else {
  // install.sh is a bash script (arrays); plain `sh` is dash on Debian/Ubuntu.
  run("bash", [join(ROOT, "install.sh")], env);
}
