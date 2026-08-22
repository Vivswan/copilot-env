import { runSync } from "./helpers/run.ts";
import { expect, test } from "./helpers/testing.ts";

// The env contract of the suite's one synchronous spawn: `undefined` means the key is really
// absent in the child, not merely unmentioned. Every isolation harness that spells an unset
// that way depends on it; childEnv in test/helpers/run.ts explains why it needs doing at all.

const PROBE = "COPILOT_ENV_RUN_HELPER_PROBE";
const readProbe = `console.log("V=" + (Deno.env.get(${JSON.stringify(PROBE)}) ?? "<unset>"))`;

/** The child's view of PROBE, spawned through runSync with `env`. */
function childSees(env: Record<string, string | undefined>): string {
  const result = runSync(Deno.execPath(), ["eval", readProbe], { env });
  expect(result.exitCode).toBe(0);
  return result.stdout.trim();
}

test("runSync: an explicitly undefined env value is unset in the child, not merged over", () => {
  process.env[PROBE] = "PARENT_VALUE";
  try {
    // Inherited when simply carried through.
    expect(childSees({ ...process.env })).toBe("V=PARENT_VALUE");
    // ... and genuinely gone when spelled as undefined.
    expect(childSees({ ...process.env, [PROBE]: undefined })).toBe("V=<unset>");
    // A set value still wins over the parent's.
    expect(childSees({ ...process.env, [PROBE]: "CHILD_VALUE" })).toBe("V=CHILD_VALUE");
    // The parent is left exactly as it was: the unset is scoped to the spawn.
    expect(process.env[PROBE]).toBe("PARENT_VALUE");
  } finally {
    delete process.env[PROBE];
  }
});

/** A path no executable occupies, so the spawn fails rather than running something. */
const UNSPAWNABLE = "/nonexistent/copilot-env/definitely-not-a-binary";

test("runSync: an unset survives a spawn that throws, and never leaks into the parent", () => {
  process.env[PROBE] = "PARENT_VALUE";
  try {
    // The restore has to run from the finally, not the happy path.
    expect(() => runSync(UNSPAWNABLE, [], { env: { ...process.env, [PROBE]: undefined } }))
      .toThrow();
    expect(process.env[PROBE]).toBe("PARENT_VALUE");
  } finally {
    delete process.env[PROBE];
  }
});
