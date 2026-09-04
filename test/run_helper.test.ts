import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_VALUES, childValuesEnv, runSync } from "./helpers/run.ts";
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

/**
 * The parent variables a child process cannot reliably start without. Replacement semantics
 * mean a partial env is passed VERBATIM (Windows CreateProcess injects nothing), so the two
 * partial-env tests below fold these in: they assert a NAMED variable's presence/absence,
 * never that the env is minimal, so carrying the essentials costs the assertions nothing
 * and keeps the child spawnable on all three platforms.
 */
function platformEssentials(): Record<string, string> {
  const keep = new Set(["SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "TEMP", "TMP"]);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && keep.has(key.toUpperCase())) out[key] = value;
  }
  return out;
}

test("runSync: the child gets EXACTLY the requested env, not the parent merged with it", () => {
  process.env[PROBE] = "PARENT_VALUE";
  try {
    // A PARTIAL env is the case that separates replacement from merge: under Deno's native
    // merge the parent's value reaches the child even though the caller never mentioned it.
    expect(childSees({ ...platformEssentials(), SOMETHING_ELSE: "x" })).toBe("V=<unset>");
    // The parent is untouched by the clearing.
    expect(process.env[PROBE]).toBe("PARENT_VALUE");
  } finally {
    delete process.env[PROBE];
  }
});

test("runSync: a parent variable named after an Object prototype member is cleared too", () => {
  // Pins the clearing loop's membership test against prototype pollution: childEnv's map is
  // null-prototype today (where `in` and hasOwn agree), but if it ever returns an ordinary
  // object again, an `in` test would see `"toString" in wanted` as true through the prototype
  // chain and spare this key, leaking it into a child that never asked for it. Typed as a
  // plain string so it reaches ProcessEnv's index signature rather than
  // Object.prototype.toString.
  const protoKey: string = "toString";
  process.env[protoKey] = "PARENT_VALUE";
  try {
    const seen = runSync(Deno.execPath(), [
      "eval",
      'console.log("V=" + (Deno.env.get("toString") ?? "<unset>"))',
    ], { env: { ...platformEssentials(), SOMETHING_ELSE: "x" } });
    expect(seen.stdout.trim()).toBe("V=<unset>");
    expect(process.env[protoKey]).toBe("PARENT_VALUE");
  } finally {
    delete process.env[protoKey];
  }
});

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

/** A path no executable occupies, so the spawn fails rather than running something.
 *  Built from the temp dir so it is absolute-and-absent on every platform. */
const UNSPAWNABLE = join(tmpdir(), "copilot-env-definitely-not", "not-a-binary");

test("runSync: an unset survives a failed spawn, and never leaks into the parent", () => {
  process.env[PROBE] = "PARENT_VALUE";
  try {
    // The restore must hold however the platform surfaces a missing executable:
    // POSIX throws out of res.error, Windows node-compat returns normally with a
    // nonzero status and no error at all. The contract under test is the parent
    // restoration after a FAILED spawn, not the failure vehicle.
    let failed = false;
    try {
      const res = runSync(UNSPAWNABLE, [], { env: { ...process.env, [PROBE]: undefined } });
      failed = res.exitCode !== 0;
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(process.env[PROBE]).toBe("PARENT_VALUE");
  } finally {
    delete process.env[PROBE];
  }
});

test("CHILD_VALUES: the env payload round-trips paths, markup, and terminators as data", () => {
  // The control for the constant-source contract: values that are awkward inside SOURCE
  // (a script-closing tag, raw line terminators, a quoted backslash Windows path) arrive
  // intact as DATA, and keys are read back by name.
  const values = {
    ready: 'C:\\tmp\\ready "quoted" \\ end',
    tag: "</script><script>alert(1)</script>",
    terminators: "a\u2028b\u2029c",
    n: 42,
  };
  const script =
    `const v = ${CHILD_VALUES}; console.log(JSON.stringify([v.ready, v.tag, v.terminators, v.n]));`;
  const result = runSync(Deno.execPath(), ["eval", script], {
    env: { ...process.env, ...childValuesEnv(values) },
  });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([
    values.ready,
    values.tag,
    values.terminators,
    values.n,
  ]);
  // And without the env entry the object is empty, never a crash: an unset key reads undefined.
  const bare = runSync(Deno.execPath(), ["eval", `console.log(String(${CHILD_VALUES}.ready))`], {
    env: { ...process.env },
  });
  expect(bare.stdout.trim()).toBe("undefined");
});
