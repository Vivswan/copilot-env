import { dirname, join } from "node:path";
import { CHILD_VALUES, childValuesEnv, runSync, spawnChild } from "./helpers/run.ts";
import { expect, PINNED_DENO_DIR, tempDir, test, TEST_ROOT_ENV } from "./helpers/testing.ts";

// The env contract of the suite's one synchronous spawn: `undefined` means the key is really
// absent in the child, not merely unmentioned. Every isolation harness that spells an unset
// that way depends on it; childEnv in test/helpers/run.ts explains why it needs doing at all.

const PROBE = "COPILOT_ENV_RUN_HELPER_PROBE";
const readProbe = `console.log("V=" + (Deno.env.get(${JSON.stringify(PROBE)}) ?? "<unset>"))`;

function childSees(env: Record<string, string | undefined>): string {
  const result = runSync(Deno.execPath(), ["eval", readProbe], { env });
  expect(result.exitCode).toBe(0);
  return result.stdout.trim();
}

/**
 * Replacement semantics pass a partial env VERBATIM (Windows CreateProcess injects nothing), so
 * a child cannot reliably start without these. The partial-env tests assert one NAMED variable, never
 * that the env is minimal, so carrying the essentials costs the assertions nothing.
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
    expect(process.env[PROBE]).toBe("PARENT_VALUE");
  } finally {
    delete process.env[PROBE];
  }
});

test("runSync: a parent variable named after an Object prototype member is cleared too", () => {
  // childEnv's map is null-prototype and the clearing loop tests Object.hasOwn today; on an
  // ordinary object with an `in` test, `"toString" in wanted` is true through the prototype
  // chain, which would spare this key and leak it.
  // `protoKey` is typed as a plain string so it reaches ProcessEnv's index signature.
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
    expect(childSees({ ...process.env })).toBe("V=PARENT_VALUE");
    expect(childSees({ ...process.env, [PROBE]: undefined })).toBe("V=<unset>");
    expect(childSees({ ...process.env, [PROBE]: "CHILD_VALUE" })).toBe("V=CHILD_VALUE");
    expect(process.env[PROBE]).toBe("PARENT_VALUE");
  } finally {
    delete process.env[PROBE];
  }
});

/** A path no executable occupies, so the spawn fails rather than running something.
 *  Built from the temp dir so it is absolute-and-absent on every platform. */
const UNSPAWNABLE = join(tempDir("copilot-env-definitely-not-"), "not-a-binary");

test("runSync: an unset survives a failed spawn, and never leaks into the parent", () => {
  process.env[PROBE] = "PARENT_VALUE";
  try {
    // A missing executable surfaces differently per platform: POSIX throws, Windows node-compat
    // returns a nonzero status with no error. Either way is the failed spawn under test.
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

// --- the harness keys: on every child, over whatever env the caller gave ---------------

const READ_HARNESS_KEYS = `console.log(JSON.stringify([Deno.env.get(${
  JSON.stringify(TEST_ROOT_ENV)
}), Deno.env.get("DENO_DIR")]))`;

test("both spawns put the temp root and the cache pin on the child, whatever the caller's env says", async () => {
  const root = dirname(tempDir("copilot-env-harness-"));
  const expected = [root, PINNED_DENO_DIR];
  // The harness keys win over the caller's env: a child that lost them would mint its root
  // beside ours or grow a cache under its HOME.
  const hostile = { ...platformEssentials(), [TEST_ROOT_ENV]: undefined, DENO_DIR: "relative" };
  for (const env of [platformEssentials(), hostile]) {
    expect(JSON.parse(runSync(Deno.execPath(), ["eval", READ_HARNESS_KEYS], { env }).stdout))
      .toEqual(expected);
  }
  const child = spawnChild(Deno.execPath(), {
    args: ["eval", READ_HARNESS_KEYS],
    env: { [TEST_ROOT_ENV]: "elsewhere", DENO_DIR: "" },
    stdout: "piped",
    stderr: "null",
  });
  const out = await child.output();
  expect(JSON.parse(new TextDecoder().decode(out.stdout))).toEqual(expected);
  // An absolute cache the caller names is theirs to keep: the proxy float pins its own.
  const own = tempDir("copilot-env-own-cache-");
  const kept = runSync(Deno.execPath(), ["eval", READ_HARNESS_KEYS], {
    env: { ...process.env, DENO_DIR: own },
  });
  expect(JSON.parse(kept.stdout)).toEqual([root, own]);
});
