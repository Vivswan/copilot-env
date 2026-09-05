import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deferWriteReports,
  flushWriteReports,
  removeScratchDir,
  type ScratchDir,
  scratchDir,
  writeFileReported,
} from "../src/utils/report_write.ts";
import { CHILD_VALUES, childValuesEnv, importSpecifier, ROOT, runScript } from "./helpers/run.ts";
import { expect, test } from "./helpers/testing.ts";

// The seam's contract is per PROCESS (dedup, stderr-only, immune to the consola level),
// so it is pinned from outside: one child runs every kind and the parent reads what
// reached which stream.

const SEAM = join(ROOT, "src", "utils", "report_write.ts");

test("every kind prints once per process, on stderr only, and a delete re-arms the path", () => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-report-"));
  try {
    const script = join(dir, "worker.ts");
    writeFileSync(
      script,
      [
        `import { join } from "node:path";`,
        `import {`,
        `  mkdirReported, removeEmptyDirReported, removeReported, renameReported, reportWrite,`,
        `  symlinkReported, writeFileReported,`,
        `} from ${importSpecifier(SEAM)};`,
        `const dir = ${CHILD_VALUES}.dir;`,
        `const a = join(dir, "a.txt");`,
        `writeFileReported(a, "1");`, // created
        `writeFileReported(a, "2");`, // a rewrite of a path already announced: silent
        `reportWrite("rewritten", a);`, // silent too
        `removeReported(a);`, // deleted
        `removeReported(a);`, // absent: nothing happened, nothing said
        `writeFileReported(a, "3");`, // re-created after the delete: announced again
        `removeReported(a);`, // and the second delete is a new epoch too
        `const b = join(dir, "b.txt");`,
        `writeFileReported(b, "");`,
        `renameReported(b, join(dir, "c.txt"));`, // moved
        // A directory target: on Windows only a junction needs no privilege, and a
        // junction is removed like a directory.
        `const target = join(dir, "target"); mkdirReported(target);`,
        `const type = process.platform === "win32" ? "junction" : undefined;`,
        `const unlink = process.platform === "win32" ? removeEmptyDirReported : removeReported;`,
        `const link = join(dir, "link");`,
        `symlinkReported(target, link, type);`, // linked
        `symlinkReported(target, link + "2", type); unlink(link); symlinkReported(target, link, type);`,
        `console.log("stdout-untouched");`,
      ].join("\n"),
    );
    // CONSOLA_LEVEL 0 silences every consola logger: the report lines must not be.
    const result = runScript(script, [], {
      env: { ...process.env, ...childValuesEnv({ dir }), CONSOLA_LEVEL: "0" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("stdout-untouched\n");
    const a = join(dir, "a.txt");
    const b = join(dir, "b.txt");
    const link = join(dir, "link");
    const target = join(dir, "target");
    // Deno's own permissions-config notice is the one line on stderr that is not ours.
    const ours = result.stderr.split("\n").filter((l) => !l.includes("Permissions in the config"));
    expect(ours).toEqual([
      `created -> ${a}`,
      `deleted -> ${a}`,
      `created -> ${a}`,
      `deleted -> ${a}`,
      `created -> ${b}`,
      `moved -> ${join(dir, "c.txt")} (from ${b})`,
      `created -> ${target}`,
      `linked -> ${link} (to ${target})`,
      `linked -> ${link}2 (to ${target})`,
      `deleted -> ${link}`,
      `linked -> ${link} (to ${target})`,
      "",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scratch dirs are silent, and deferred reports come out at the flush in order", () => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-report-"));
  try {
    deferWriteReports();
    const scratch = scratchDir(join(dir, "scratch-"));
    writeFileReported(join(scratch, "probe.json"), "{}");
    removeScratchDir(scratch);
    // A root this process never minted is not scratch: refused, never removed silently.
    expect(() => removeScratchDir(join(dir, "permanent") as ScratchDir)).toThrow(
      "not a scratch dir",
    );
    const kept = join(dir, "kept.txt");
    writeFileReported(kept, "");
    expect(flushWriteReports()).toEqual([`created -> ${kept}`]);
    // Flushed once: a second flush has nothing left.
    expect(flushWriteReports()).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
