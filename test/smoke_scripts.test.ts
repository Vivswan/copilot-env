import { join } from "node:path";
import {
  type FloatedSmokeEvidence,
  floatedSmokeFailure,
} from "../.github/scripts/floated-smoke.ts";
import { CONTAINER_MARKERS, homeIsDisposable } from "../.github/scripts/smoke-support.ts";
import { existsSync } from "node:fs";
import { ROOT, runScript } from "./helpers/run.ts";
import { describe, expect, tempDir, test } from "./helpers/testing.ts";

// The smokes rewire agent configs (or float a real proxy) in whatever HOME they see, so they
// must refuse to start on a developer machine. Both scripts call one pure predicate.
describe("the smokes' disposable-HOME guard", () => {
  test("admits only a GitHub Actions runner or a container marker", () => {
    const none = (): boolean => false;
    const cases: { githubActions: string | undefined; marker: string | null; admits: boolean }[] = [
      { githubActions: undefined, marker: null, admits: false },
      { githubActions: "", marker: null, admits: false },
      { githubActions: "false", marker: null, admits: false },
      { githubActions: "TRUE", marker: null, admits: false },
      { githubActions: "true", marker: null, admits: true },
      { githubActions: undefined, marker: "/.dockerenv", admits: true },
      { githubActions: "", marker: "/run/.containerenv", admits: true },
      { githubActions: undefined, marker: "/etc/hostname", admits: false },
    ];
    for (const row of cases) {
      const exists = row.marker === null ? none : (path: string) => path === row.marker;
      // The row rides along in the asserted value so a red run names it.
      expect({ ...row, admits: homeIsDisposable(row.githubActions, exists) }).toEqual(row);
    }
    expect(CONTAINER_MARKERS).toEqual(["/.dockerenv", "/run/.containerenv"]);
  });

  // In container or CI-marked runs the markers legitimately admit the scripts, so the executed
  // control runs only where the guard can fire.
  const guardReachable = process.platform !== "win32" &&
    !CONTAINER_MARKERS.some((marker) => existsSync(marker));
  test.skipIf(!guardReachable)(
    "both smoke scripts die on the guard with the test:docker hint",
    () => {
      const scratch = tempDir("copilot-smoke-guard-");
      const smokes = [
        {
          script: "lifecycle-smoke.ts",
          line: "::error::lifecycle-smoke.ts mutates the HOME it runs in; " +
            "use 'deno task test:docker --lifecycle' on a developer machine",
        },
        {
          script: "floated-smoke.ts",
          line: "::error::floated-smoke.ts floats a real proxy into the HOME it runs in; " +
            "use 'deno task test:docker --floated-lifecycle' on a developer machine",
        },
      ];
      for (const { script, line } of smokes) {
        // Safe by construction, not by the guard alone: the scripts spawn `deno` by NAME
        // and the child's PATH points at nothing, so even a broken guard could never
        // launch the real lifecycle. The scratch homes are belt and braces on top.
        const proc = runScript(join(ROOT, ".github", "scripts", script), [], {
          env: {
            ...process.env,
            "GITHUB_ACTIONS": "",
            "PATH": join(scratch, "no-bin"),
            "HOME": scratch,
            "COPILOT_API_HOME": scratch,
            "CODEX_HOME": join(scratch, ".codex"),
            "CLAUDE_CONFIG_DIR": join(scratch, ".claude"),
          },
        });
        // The guard's line must be the LAST thing on stderr and stdout stays empty: a guard
        // that printed but no longer exited would run on into the (unresolvable) spawn and
        // exit 1 for the wrong reason, with its own error after the hint.
        const stderrTail = proc.stderr.trimEnd().split("\n").at(-1);
        expect({ script, exitCode: proc.exitCode, stdout: proc.stdout, stderrTail })
          .toEqual({ script, exitCode: 1, stdout: "", stderrTail: line });
      }
    },
  );
});

// The checks fire in order, so each failing row trips exactly one of them; the two null rows
// pass, one on drifted upstream wording that still reads as reaching auth.
test("the floated smoke's verdict names the first failed check", () => {
  const healthy: FloatedSmokeEvidence = {
    startOutput: "info: now using @jeffreycao/copilot-api@2.3.4\nerror: no credential",
    proxyLog: "[info] Resolving auth provider...\n[error] no GitHub token",
    legacyHomeExists: false,
  };
  const cases: { name: string; evidence: FloatedSmokeEvidence; failure: string | null }[] = [
    {
      name: "no float marker",
      evidence: { ...healthy, startOutput: "error: registry unreachable" },
      failure: "the proxy float did not resolve and install a version",
    },
    {
      name: "no proxy log",
      evidence: { ...healthy, proxyLog: null },
      failure: "the daemon never wrote a proxy log",
    },
    {
      name: "npm-default home recreated",
      evidence: { ...healthy, legacyHomeExists: true },
      failure: "the daemon recreated the legacy copilot-api home",
    },
    {
      name: "permission error (NotCapable)",
      evidence: { ...healthy, proxyLog: 'NotCapable: Requires read access to "/proc/self"' },
      failure: "the daemon hit a permission error under the production grant set",
    },
    {
      name: "permission error (Requires all access)",
      evidence: { ...healthy, proxyLog: "Requires all access; auth provider skipped" },
      failure: "the daemon hit a permission error under the production grant set",
    },
    {
      name: "died before auth",
      evidence: { ...healthy, proxyLog: "[info] listening on 127.0.0.1:4141\n" },
      failure: "the daemon never reached auth-provider resolution; see the log above",
    },
    {
      name: "upstream wording drifted but still about auth",
      evidence: { ...healthy, proxyLog: "[warn] AUTH: nothing configured" },
      failure: null,
    },
    { name: "expected end state", evidence: healthy, failure: null },
  ];
  for (const row of cases) {
    expect({ name: row.name, failure: floatedSmokeFailure(row.evidence) })
      .toEqual({ name: row.name, failure: row.failure });
  }
});
