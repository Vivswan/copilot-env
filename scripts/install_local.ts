// Install copilot-env from this checkout: compile the host-platform binary,
// then run the platform installer with COPILOT_ENV_DOWNLOAD_BASE pointed at
// dist/ -- the same override CI uses to smoke installers against branch
// builds, so the result is exactly a release install whose source is the
// repo. Invoked as `deno task install`.
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { currentReleaseTarget } from "../src/install/targets.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const target = currentReleaseTarget();
if (target === null) {
  console.error(
    `ERROR: no release target for this platform (${process.platform}/${process.arch}).`,
  );
  Deno.exit(2);
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
