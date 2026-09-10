// Floated-proxy smoke: the ONE run that uses the REAL @jeffreycao/copilot-api
// instead of test/copilot-api-fake.mjs.
//
// It cannot complete a lifecycle, because the real proxy needs a Copilot
// credential and there is none here. What it CAN prove, and what nothing else
// covers, is everything up to that point: the float resolves a version against
// the live registry and installs it, the daemon spawns under the production
// permission set with its `--preload` shims, and it runs far enough to start
// resolving an auth provider. The daemon dying for want of a credential after
// that is the expected end state, not a failure.
//
// Run it through the container, which is where the throwaway HOME comes from:
//   deno task test:docker --floated-lifecycle
// Run by checks.yml and scripts/test_docker.ts:
//   deno run --allow-env --allow-read --allow-run=deno .github/scripts/floated-smoke.ts
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
 * The first failed check's message, in assertion order, or null when the daemon got as
 * far as auth-provider resolution. Pure; exported for test/smoke_scripts.test.ts.
 * A recreated npm-default home means the spawn stopped pinning COPILOT_API_HOME. The
 * permission check is THE regression this job exists for: the real dependency tree
 * probes the environment in ways the fake never does (that is how the /proc read behind
 * node_compat_preload.ts was found). The auth check is matched loosely on purpose: the
 * wording is upstream's, so this fails for our regressions, not their copy edits.
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
  if (!/provider|auth/i.test(evidence.proxyLog)) {
    return "the daemon never reached auth-provider resolution; see the log above";
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

  // Expected to exit nonzero: no credential. The assertions are on what it got
  // through first, so the exit code alone tells us nothing.
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
    `floated proxy smoke OK on ${runnerOs()}: float installed a version, daemon started under the production permissions and reached auth`,
  );
}
