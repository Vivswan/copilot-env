import { dirname, join } from "node:path";
import { runSync, spawnChild } from "../helpers/run.ts";
import { outputOf } from "../helpers/subprocess.ts";
import { expect, tempDir, test, TEST_ROOT_ENV } from "../helpers/testing.ts";

// The env contract of the suite's one synchronous spawn: `undefined` means the key is really
// absent in the child, not merely unmentioned. Every isolation harness that spells an unset
// that way depends on it; childEnv in test/helpers/run.ts explains why it needs doing at all.

const PROBE = "COPILOT_ENV_RUN_HELPER_PROBE";

function childSees(key: string, env: Record<string, string | undefined>): string {
  // hasOwn, not `??`: bun's process.env answers an unset "toString" with Object.prototype's.
  const readProbe = `console.log("V=" + (Object.hasOwn(process.env, ${JSON.stringify(key)}) ? process.env[${
    JSON.stringify(key)
  }] : "<unset>"))`;
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

/** A path no executable occupies, so the spawn fails rather than running something.
 *  Built from the temp dir so it is absolute-and-absent on every platform. */
const UNSPAWNABLE = join(tempDir("copilot-env-definitely-not-"), "not-a-binary");

// Each row plants a parent value under `key` first, so a merge over the parent's env shows as
// the value leaking into the child, and a clearing span that never restores shows as the parent
// losing it afterwards.
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

const READ_HARNESS_KEY = `console.log(JSON.stringify(process.env[${
  JSON.stringify(TEST_ROOT_ENV)
}]))`;

test("both spawns put the temp root on the child, whatever the caller's env says", async () => {
  const root = dirname(tempDir("copilot-env-harness-"));
  // The harness key wins over the caller's env: a child that lost it would mint its root beside
  // ours, outside everything that removes it.
  const hostile = { ...platformEssentials(), [TEST_ROOT_ENV]: undefined };
  for (const env of [platformEssentials(), hostile]) {
    expect(JSON.parse(runSync(process.execPath, ["-e", READ_HARNESS_KEY], { env }).stdout))
      .toBe(root);
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
