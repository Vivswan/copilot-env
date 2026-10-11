// Two facts about the release gate that nothing else reports: GitHub gives a job with no
// timeout-minutes six hours and says nothing, and a second repository-side call of
// release-gate.yml (a job in checks.yml, a second one in nightly.yml) runs the gate twice with no
// error. GitHub itself rejects the rest of the caller's contract (inputs, secrets, permissions
// past contents: read) on the release PR, and the platform's standard-checks lint the syntax.
import { parse as parseYaml } from "@std/yaml";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../src/utils/json.ts";
import { ROOT } from "../helpers/run.ts";
import { expect, test } from "../helpers/testing.ts";

const WORKFLOWS = join(ROOT, ".github", "workflows");
const GATE = "./.github/workflows/release-gate.yml";

function jobsOf(workflow: unknown): Record<string, unknown> {
  return isRecord(workflow) && isRecord(workflow.jobs) ? workflow.jobs : {};
}

/** The jobs of a release-gate document with no numeric `timeout-minutes`. */
function unboundedJobs(workflow: unknown): string[] {
  return Object.entries(jobsOf(workflow))
    .filter(([, job]) => !(isRecord(job) && typeof job["timeout-minutes"] === "number"))
    .map(([id]) => id);
}

/** `<file>:<job>` for every job across the given workflow documents that calls the gate. */
function gateCallers(workflows: Record<string, unknown>): string[] {
  return Object.entries(workflows).flatMap(([file, workflow]) =>
    Object.entries(jobsOf(workflow))
      .filter(([, job]) => isRecord(job) && job.uses === GATE)
      .map(([id]) => `${file}:${id}`)
  );
}

test("every release-gate job is bounded, and one repository-side job calls the gate", () => {
  const workflows = Object.fromEntries(
    readdirSync(WORKFLOWS)
      .filter((name) => name.endsWith(".yml"))
      .map((name) => [name, parseYaml(readFileSync(join(WORKFLOWS, name), "utf8"))]),
  );
  expect(unboundedJobs(workflows["release-gate.yml"])).toEqual([]);
  // ci.yml is the platform's caller (managed); the repository makes exactly one call of its own.
  const { "ci.yml": _platform, ...repoOwned } = workflows;
  const callers = gateCallers(repoOwned);
  expect(callers, callers.join(", ")).toHaveLength(1);

  // Controls: a job with no timeout and a second caller are each seen.
  expect(unboundedJobs({ jobs: { a: { "timeout-minutes": 5 }, b: { "runs-on": "x" } } }))
    .toEqual(["b"]);
  expect(gateCallers({ ...repoOwned, "checks.yml": { jobs: { gate: { uses: GATE } } } }))
    .toHaveLength(2);
});
