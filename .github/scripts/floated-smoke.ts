// The one run that floats the REAL @jeffreycao/copilot-api against the live registry and runs
// the daemon; the container suite launches the real proxy too, but offline from the warmed
// fixture, and the lifecycle smoke uses test/copilot-api-fake.mjs. The credential is a fake
// (`agent start` refuses without one; the identity pin and host literal keep the launch from
// probing Copilot with it), so the daemon dying at upstream auth is the expected end state, not
// a failure.
//
//   float resolves + installs a version -> daemon spawns under the production permission set
//   with its `--preload` shims -> runs with the passed token, which upstream rejects
//
// On a developer machine: deno task test:docker --floated-lifecycle
import { join } from "node:path";
import { cli, fail, requireDisposableHome, runnerOs } from "./smoke-support.ts";

/** What the smoke observed, gathered before any verdict is drawn. */
export interface FloatedSmokeEvidence {
  /** `agent start`'s stdout and stderr together; its exit code is expected nonzero. */
  startOutput: string;
  /** The daemon's proxy log, or null when it wrote none under the data home. */
  proxyLog: string | null;
  /** Whether `~/.local/share/copilot-api` (the npm package's own default home) exists. */
  legacyHomeExists: boolean;
}

/**
 * The first failed check, in assertion order, or null once the daemon ran with the token it was
 * handed. Pure; test/smoke_scripts.test.ts drives it.
 *
 * legacy home recreated  -> the spawn stopped pinning COPILOT_API_HOME
 * NotCapable in the log  -> THE regression this job exists for: the real dependency tree
 *                           probes the environment in ways the fake never does
 * the passed token       -> upstream's line for a `--github-token` it was handed; a daemon that
 *                           logged in on its own, or died before auth, never writes it
 */
export function floatedSmokeFailure(evidence: FloatedSmokeEvidence): string | null {
  if (!evidence.startOutput.includes("now using @jeffreycao/copilot-api@")) {
    return "the proxy float did not resolve and install a version";
  }
  if (evidence.proxyLog === null) return "the daemon never wrote a proxy log";
  if (evidence.legacyHomeExists) return "the daemon recreated the legacy copilot-api home";
  if (/NotCapable|Requires all access/.test(evidence.proxyLog)) {
    return "the daemon hit a permission error under the production grant set";
  }
  if (!evidence.proxyLog.includes("Using provided GitHub token")) {
    return "the daemon never ran with the passed token; see the log above";
  }
  return null;
}

/** The first file named `.log` under `dir`, or null. A missing `dir` is "no log". */
function findProxyLog(dir: string): string | null {
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(dir)];
  } catch {
    return null;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isFile && entry.name === ".log") return path;
    if (entry.isDirectory) {
      const found = findProxyLog(path);
      if (found !== null) return found;
    }
  }
  return null;
}

function dirExists(path: string): boolean {
  try {
    return Deno.statSync(path).isDirectory;
  } catch {
    return false;
  }
}

if (import.meta.main) {
  requireDisposableHome("floated-smoke.ts", "floats a real proxy into", "--floated-lifecycle");
  const home = Deno.env.get("HOME") ?? fail("HOME is unset");

  // A fake credential: the daemon spawns and fails upstream auth, so `start` is expected to exit
  // nonzero. The assertions are on what it got through first, so the exit code alone tells us
  // nothing.
  cli(["profile", "set", "identity", "copilot-developer-cli"]);
  cli(["profile", "set", "host", "https://copilot.invalid"]);
  cli(["auth", "--set", "fake-default-token"]);
  const start = cli(["start"], { stdout: "piped", stderr: "piped" });
  const startOutput = start.stdout + start.stderr;
  console.log("--- agent start output ---");
  console.log(startOutput);

  const proxyLogPath = findProxyLog(join(home, ".local", "share", "copilot-env"));
  const proxyLog = proxyLogPath === null ? null : Deno.readTextFileSync(proxyLogPath);
  if (proxyLog !== null) {
    console.log("--- proxy log ---");
    console.log(proxyLog);
  }
  const failure = floatedSmokeFailure({
    startOutput,
    proxyLog,
    legacyHomeExists: dirExists(join(home, ".local", "share", "copilot-api")),
  });
  if (failure !== null) fail(failure);
  console.log(
    `floated proxy smoke OK on ${runnerOs()}: float installed a version, daemon started under the production permissions and ran with the passed token`,
  );
}
