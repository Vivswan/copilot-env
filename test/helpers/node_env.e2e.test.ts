// The preload runs before a test file's own imports, so a file that never loads the harness still
// starts with no width. CI exports no COLUMNS, so a dropped removal would stay green there; this
// child starts under one, with the preload alone.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bunRunArgs, ROOT, runSync } from "./run.ts";
import { expect, tempDir, test } from "./testing.ts";

test("a process started with the preload alone has no COLUMNS whatever the runner exported", () => {
  const program = join(tempDir("preload-columns-"), "columns.mjs");
  writeFileSync(program, "console.log(JSON.stringify(process.env.COLUMNS ?? null));\n");
  const preload = join(ROOT, "test", "helpers", "node_env.ts");
  const res = runSync(process.execPath, [...bunRunArgs("--preload", preload), program], {
    env: { ...process.env, COLUMNS: "40" },
  });
  expect({ exitCode: res.exitCode, columns: res.stdout.trim() }, res.stderr).toEqual({
    exitCode: 0,
    columns: "null",
  });
});
