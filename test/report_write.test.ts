import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { resolveRootHome } from "../src/copilot_api/paths.ts";
import {
  atomicWriteFile,
  deferWriteReports,
  flushWriteReports,
  hideWritesUnder,
  mkdirReported,
  removeScratchDir,
  type ScratchDir,
  scratchDir,
  writeFileReported,
} from "../src/utils/report_write.ts";
import { CHILD_VALUES, childValuesEnv, importSpecifier, ROOT, runScript } from "./helpers/run.ts";
import { envSnapshot, isolateAgentHomes } from "./helpers.ts";
import { expect, removeDir, tempDir, test } from "./helpers/testing.ts";

const restoreEnv = envSnapshot();

// The seam's contract is per PROCESS (dedup, stderr-only, immune to the consola level),
// so it is pinned from outside: one child runs every kind and the parent reads what
// reached which stream.

const SEAM = join(ROOT, "src", "utils", "report_write.ts");

test("every kind prints once per process, on stderr only, and a delete re-arms the path", () => {
  const dir = tempDir("copilot-report-");
  try {
    mkdirSync(join(dir, "occupied"));
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
        // A write refused by the OS (the path is a directory) changed nothing: no line. The
        // directory is one the seam never saw, so dedup cannot be what keeps it quiet.
        `try { writeFileReported(join(dir, "occupied"), "x"); } catch { /* EISDIR / EPERM */ }`,
        `const type = process.platform === "win32" ? "junction" : undefined;`,
        `const unlink = process.platform === "win32" ? removeEmptyDirReported : removeReported;`,
        `const link = join(dir, "link");`,
        `symlinkReported(target, link, type);`, // linked
        `symlinkReported(target, link + "2", type); unlink(link); symlinkReported(target, link, type);`,
        // A writer's meaning rides as the line's detail; mkdir's lands on the leaf only.
        `const d = join(dir, "d.txt");`,
        `writeFileReported(d, "", { detail: "why it was written" });`,
        `mkdirReported(join(dir, "n", "leaf"), undefined, "leaf only");`,
        `removeReported(d, "why it went");`,
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
      `created -> ${join(dir, "d.txt")} (why it was written)`,
      `created -> ${join(dir, "n")}`,
      `created -> ${join(dir, "n", "leaf")} (leaf only)`,
      `deleted -> ${join(dir, "d.txt")} (why it went)`,
      "",
    ]);
  } finally {
    removeDir(dir);
  }
});

interface ContractCase {
  name: string;
  skip?: boolean;
  setup?: (dir: string) => void;
  run: (dir: string) => void;
  lines: (dir: string) => string[];
}

const CONTRACTS: ContractCase[] = [
  {
    name: "an atomic write whose temp path is occupied by a directory changes nothing: silent",
    setup: (dir) => mkdirSync(join(dir, `target.tmp.${process.pid}`)),
    run: (dir) => {
      expect(() => atomicWriteFile(join(dir, "target"), "x")).toThrow();
    },
    lines: () => [],
  },
  {
    name: "a stale permissive temp under this pid never publishes its old mode",
    skip: process.platform === "win32",
    setup: (dir) => writeFileSync(join(dir, `secret.tmp.${process.pid}`), "old", { mode: 0o644 }),
    run: (dir) => {
      atomicWriteFile(join(dir, "secret"), "new", 0o600);
      expect(statSync(join(dir, "secret")).mode & 0o777).toBe(0o600);
    },
    lines: (dir) => [
      `deleted -> ${join(dir, `secret.tmp.${process.pid}`)} (stale temp file)`,
      `created -> ${join(dir, "secret")}`,
    ],
  },
];

test("the transient cleanup names only a proven change", () => {
  for (const c of CONTRACTS) {
    if (c.skip) continue;
    const dir = tempDir("copilot-report-");
    try {
      c.setup?.(dir);
      deferWriteReports();
      c.run(dir);
      expect(flushWriteReports(), c.name).toEqual(c.lines(dir));
    } finally {
      removeDir(dir);
    }
  }
});

test("scratch dirs are silent, and deferred reports come out at the flush in order", () => {
  const dir = tempDir("copilot-report-");
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
    expect(flushWriteReports()).toEqual([]);

    // Deferred and never flushed by hand (the launch path): the lines reach stderr at
    // process exit, after everything else the process printed.
    const script = join(dir, "deferred.ts");
    writeFileSync(
      script,
      [
        `import { join } from "node:path";`,
        `import { deferWriteReports, writeFileReported } from ${importSpecifier(SEAM)};`,
        `deferWriteReports();`,
        `writeFileReported(join(${CHILD_VALUES}.dir, "late.txt"), "");`,
        `console.error("before-exit");`,
      ].join("\n"),
    );
    const result = runScript(script, [], {
      env: { ...process.env, ...childValuesEnv({ dir }), CONSOLA_LEVEL: "0" },
    });
    expect(result.exitCode).toBe(0);
    const ours = result.stderr.split("\n").filter((l) => !l.includes("Permissions in the config"));
    expect(ours).toEqual(["before-exit", `created -> ${join(dir, "late.txt")}`, ""]);
  } finally {
    removeDir(dir);
  }
});

test("writes inside copilot-env's own homes print nothing; the same write outside does", () => {
  const { dir: home, proxyHome } = isolateAgentHomes("copilot-report-scope-");
  try {
    const rootHome = resolveRootHome();
    expect(rootHome).toBe(proxyHome);
    deferWriteReports();
    // The home itself is a path the user sees appear: named.
    mkdirReported(rootHome);
    // Inside it: a store, a lock sidecar's directory, a profile home -- bookkeeping.
    writeFileReported(join(rootHome, "credentials.json"), "{}");
    mkdirReported(join(rootHome, "profiles", "work"));
    const codexConfig = join(home, ".codex", "config.toml");
    mkdirReported(join(home, ".codex"));
    writeFileReported(codexConfig, "");
    expect(flushWriteReports()).toEqual([
      `created -> ${rootHome}`,
      `created -> ${join(home, ".codex")}`,
      `created -> ${codexConfig}`,
    ]);
    // A home nested inside another (the data home under the install root) still prints
    // itself: a root is never a descendant, whatever it sits under.
    const nested = join(rootHome, "data");
    hideWritesUnder(() => nested);
    deferWriteReports();
    mkdirReported(nested);
    writeFileReported(join(nested, "store.json"), "{}");
    expect(flushWriteReports()).toEqual([`created -> ${nested}`]);
    // A registered home spelled with a trailing separator hides its descendants all the
    // same (the shape a filesystem root resolves to).
    hideWritesUnder(() => `${join(home, "hidden")}${sep}`);
    deferWriteReports();
    mkdirReported(join(home, "hidden", "inner"));
    expect(flushWriteReports()).toEqual([`created -> ${join(home, "hidden")}`]);
    // On POSIX a trailing backslash is part of the name, never a separator: a home named
    // `keep\` hides nothing under its sibling `keep`.
    if (process.platform !== "win32") {
      hideWritesUnder(() => join(home, "keep\\"));
      deferWriteReports();
      mkdirReported(join(home, "keep", "inner"));
      expect(flushWriteReports()).toEqual([
        `created -> ${join(home, "keep")}`,
        `created -> ${join(home, "keep", "inner")}`,
      ]);
    }
  } finally {
    restoreEnv();
    removeDir(home);
  }
});
