import { dirname, join } from "node:path";
import { runSync, spawnChild } from "../helpers/run.ts";
import { outputOf } from "../helpers/subprocess.ts";
import { expect, TEST_ROOT_ENV, tempDir, test } from "../helpers/testing.ts";

// The env contract of the suite's one synchronous spawn: `undefined` means the key is really
// absent in the child, not merely unmentioned. Every isolation harness that spells an unset
// that way depends on it; childEnv in test/helpers/run.ts explains why it needs doing at all.

const PROBE = "COPILOT_ENV_RUN_HELPER_PROBE";

function childSees(key: string, env: Record<string, string | undefined>): string {
  // hasOwn, not `??`: bun's process.env answers an unset "toString" with Object.prototype's.
  const readProbe = `console.log("V=" + (Object.hasOwn(process.env, ${JSON.stringify(key)}) ? process.env[${JSON.stringify(
    key,
  )}] : "<unset>"))`;
  const result = runSync(process.execPath, ["-e", readProbe], { env });
  expect(result.exitCode).toBe(0);
  return result.stdout.trim();
}

/**
 * Replacement semantics pass a partial env VERBATIM (Windows CreateProcess injects nothing), so
 * a child cannot reliably start without these. The partial-env rows assert one NAMED variable,
 * never that the env is minimal, so carrying the essentials costs the assertions nothing.
 */
function platformEssentials(): Record<string, string> {
  const keep = new Set(["SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "TEMP", "TMP"]);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && keep.has(key.toUpperCase())) out[key] = value;
  }
  return out;
}

/** Under the temp dir: absolute and absent on every platform, so the spawn fails rather than running something. */
const UNSPAWNABLE = join(tempDir("copilot-env-definitely-not-"), "not-a-binary");

// Each row plants a parent value under `key` first: a merge leaks it into the child, an unrestored span loses it.
const ENV_SHAPES: {
  shape: string;
  key: string;
  env: () => Record<string, string | undefined>;
  sees: string;
}[] = [
  {
    // A PARTIAL env is the case that separates replacement from merge: under a merge the parent's
    // value reaches the child even though the caller never mentioned it.
    shape: "a partial env that never names the variable",
    key: PROBE,
    env: () => ({ ...platformEssentials(), SOMETHING_ELSE: "x" }),
    sees: "V=<unset>",
  },
  {
    // childEnv's map is null-prototype and the clearing loop tests Object.hasOwn; on an ordinary
    // object with an `in` test, `"toString" in wanted` is true through the prototype chain, which
    // would spare this key and leak it.
    shape: "a partial env, with the parent's variable named after an Object prototype member",
    key: "toString",
    env: () => ({ ...platformEssentials(), SOMETHING_ELSE: "x" }),
    sees: "V=<unset>",
  },
  {
    shape: "the parent's env spread whole",
    key: PROBE,
    env: () => ({ ...process.env }),
    sees: "V=PARENT_VALUE",
  },
  {
    shape: "the parent's env with the variable explicitly undefined",
    key: PROBE,
    env: () => ({ ...process.env, [PROBE]: undefined }),
    sees: "V=<unset>",
  },
  {
    shape: "the parent's env with the caller's own value",
    key: PROBE,
    env: () => ({ ...process.env, [PROBE]: "CHILD_VALUE" }),
    sees: "V=CHILD_VALUE",
  },
];

test("runSync: the child gets EXACTLY the requested env, and the parent's is restored afterwards", () => {
  for (const { shape, key, env, sees } of ENV_SHAPES) {
    process.env[key] = "PARENT_VALUE";
    try {
      expect({ shape, sees: childSees(key, env()) }).toEqual({ shape, sees });
      expect({ shape, parent: process.env[key] }).toEqual({ shape, parent: "PARENT_VALUE" });
    } finally {
      delete process.env[key];
    }
  }
  // The restore must also survive a spawn that never ran. A missing executable surfaces
  // differently per platform: POSIX throws, Windows node-compat returns a nonzero status with no
  // error. Either way is the failed spawn under test.
  process.env[PROBE] = "PARENT_VALUE";
  try {
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

// --- the harness key: on every child, over whatever env the caller gave ------------------

const READ_HARNESS_KEY = `console.log(JSON.stringify(process.env[${JSON.stringify(
  TEST_ROOT_ENV,
)}]))`;

test("both spawns put the temp root on the child, whatever the caller's env says", async () => {
  const root = dirname(tempDir("copilot-env-harness-"));
  // The harness key wins over the caller's env: a child that lost it would mint its root beside
  // ours, outside everything that removes it.
  const hostile = { ...platformEssentials(), [TEST_ROOT_ENV]: undefined };
  for (const env of [platformEssentials(), hostile]) {
    expect(JSON.parse(runSync(process.execPath, ["-e", READ_HARNESS_KEY], { env }).stdout)).toBe(
      root,
    );
  }
  const child = spawnChild(process.execPath, {
    args: ["-e", READ_HARNESS_KEY],
    env: { [TEST_ROOT_ENV]: "elsewhere" },
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = await outputOf(child);
  expect(JSON.parse(out.stdout)).toBe(root);
});

// --- the width: a child has no COLUMNS unless the caller's env names it -------------------
//
// The caller's env is the channel: a COLUMNS key in it is the child's verbatim, whatever its
// value (one equal to the runner's export included), and otherwise the child has none, as the
// process has none.

/** Stands in for a width the runner exported; the preload leaves the test process with none. */
const RUNNER_COLUMNS = "81";

/** The child program: its COLUMNS as JSON, or null when it has none. */
const READ_COLUMNS = "console.log(JSON.stringify(process.env.COLUMNS ?? null))";

/** `passed` is the env the caller hands the helper, or none; the essentials ride along under
 *  runSync's replacement semantics so COLUMNS alone comes from `passed`. */
async function childColumns(
  helper: "spawnChild" | "runSync",
  passed: Record<string, string | undefined> | undefined,
): Promise<string | null> {
  if (helper === "runSync") {
    const env = passed === undefined ? undefined : { ...platformEssentials(), ...passed };
    return JSON.parse(runSync(process.execPath, ["-e", READ_COLUMNS], { env }).stdout);
  }

  const child = spawnChild(process.execPath, {
    args: ["-e", READ_COLUMNS],
    env: passed,
    stdout: "pipe",
    stderr: "ignore",
  });
  return JSON.parse((await outputOf(child)).stdout);
}

test("both spawns: the child has no COLUMNS unless the caller's env names it, whose value it gets verbatim, the runner's own included", async () => {
  const rows: {
    name: string;
    passed: Record<string, string | undefined> | undefined;
    child: string | null;
  }[] = [
    { name: "no env", passed: undefined, child: null },
    { name: "an env without the key", passed: {}, child: null },
    { name: "a width of its own", passed: { COLUMNS: "60" }, child: "60" },
    { name: "the runner's own width", passed: { COLUMNS: RUNNER_COLUMNS }, child: RUNNER_COLUMNS },
    { name: "the key scrubbed", passed: { COLUMNS: undefined }, child: null },
  ];
  process.env.COLUMNS = RUNNER_COLUMNS;
  try {
    for (const helper of ["spawnChild", "runSync"] as const) {
      for (const row of rows) {
        expect(await childColumns(helper, row.passed), `${helper}: ${row.name}`).toBe(row.child);
      }
    }
  } finally {
    delete process.env.COLUMNS;
  }
});
