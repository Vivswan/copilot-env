import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  atomicWriteFile,
  deferWriteReports,
  flushWriteReports,
  removeScratchDir,
  type ScratchDir,
  scratchDir,
  withReportedPaths,
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
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a deep look sees a nested rewrite the root's own metadata would hide", () => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-report-"));
  try {
    const tree = join(dir, "tree");
    mkdirSync(join(tree, "inner"), { recursive: true });
    const nested = join(tree, "inner", "data.bin");
    writeFileSync(nested, "aaaa");
    // The original's mtime is pinned to the past: an equal-size rewrite landing within
    // the same mtime tick as the original write is the seam's documented proven-only
    // miss (same dev/ino/mtime/size, no transition), and the test must not depend on
    // the platform's tick (rm + write below may also change the inode, but nothing here
    // relies on that).
    utimesSync(nested, new Date(0), new Date(0));
    // A future-dated sibling pins the tree's latest mtime; the rewrite below keeps the
    // nested file's size, so only its identity/mtime moves.
    writeFileSync(join(tree, "inner", "pinned"), "");
    utimesSync(
      join(tree, "inner", "pinned"),
      new Date(Date.now() + 86_400_000),
      new Date(Date.now() + 86_400_000),
    );
    utimesSync(join(tree, "inner"), new Date(0), new Date(0));
    utimesSync(tree, new Date(0), new Date(0));
    deferWriteReports();
    withReportedPaths([tree], () => {
      rmSync(nested);
      writeFileSync(nested, "bbbb");
      utimesSync(join(tree, "inner"), new Date(0), new Date(0));
    });
    expect(flushWriteReports()).toEqual([`rewritten -> ${tree}`]);
    // Unchanged tree: nothing.
    deferWriteReports();
    withReportedPaths([tree], () => {});
    expect(flushWriteReports()).toEqual([]);
    // A topology change with every directory's metadata pinned back: the moved entry is
    // the same inode under a new relative path, and that alone is a rewrite of the tree
    // (a fresh tree: the first one's rewrite is already on record for this process).
    const tree2 = join(dir, "tree2");
    mkdirSync(join(tree2, "inner"), { recursive: true });
    writeFileSync(join(tree2, "peer"), "");
    const pin = (): void => {
      for (const d of [tree2, join(tree2, "inner")]) utimesSync(d, new Date(0), new Date(0));
    };
    pin();
    deferWriteReports();
    withReportedPaths([tree2], () => {
      renameSync(join(tree2, "peer"), join(tree2, "inner", "peer"));
      pin();
    });
    expect(flushWriteReports()).toEqual([`rewritten -> ${tree2}`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** One contract case: set up under `dir`, run under deferred reporting, and the exact
 *  lines it must produce (paths relative to `dir`). */
interface ContractCase {
  name: string;
  skip?: boolean;
  setup?: (dir: string) => void;
  run: (dir: string) => void;
  lines: (dir: string) => string[];
}

const CONTRACTS: ContractCase[] = [
  {
    name: "kinds filter: a rewrite inside fn is not attributed when only created/deleted are asked",
    setup: (dir) => writeFileSync(join(dir, "wal"), "a"),
    run: (dir) =>
      withReportedPaths([join(dir, "wal")], () => writeFileSync(join(dir, "wal"), "ab"), {
        kinds: ["created", "deleted"],
      }),
    lines: () => [],
  },
  {
    name: "kinds default: the same rewrite is named",
    setup: (dir) => writeFileSync(join(dir, "wal"), "a"),
    run: (dir) =>
      withReportedPaths([join(dir, "wal")], () => writeFileSync(join(dir, "wal"), "ab")),
    lines: (dir) => [`rewritten -> ${join(dir, "wal")}`],
  },
  {
    name: "a thenable result is refused",
    run: () => {
      expect(() => withReportedPaths([], () => Promise.resolve())).toThrow("synchronous");
    },
    lines: () => [],
  },
  {
    name: "a dangling symlink is present (lstat), so removing it is a deletion",
    skip: process.platform === "win32",
    setup: (dir) => symlinkSync(join(dir, "missing-target"), join(dir, "dangling")),
    run: (dir) => withReportedPaths([join(dir, "dangling")], () => rmSync(join(dir, "dangling"))),
    lines: (dir) => [`deleted -> ${join(dir, "dangling")}`],
  },
  {
    name: "a tree with an unlistable level cannot be judged: silent",
    // mode 000 stops a user, never root (the container suite).
    skip: process.platform === "win32" || process.getuid?.() === 0,
    setup: (dir) => {
      mkdirSync(join(dir, "tree", "sealed"), { recursive: true });
      chmodSync(join(dir, "tree", "sealed"), 0o000);
    },
    run: (dir) => {
      try {
        withReportedPaths([join(dir, "tree")], () => writeFileSync(join(dir, "tree", "new"), ""));
      } finally {
        chmodSync(join(dir, "tree", "sealed"), 0o755);
      }
    },
    lines: () => [],
  },
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
    lines: (dir) => [`created -> ${join(dir, "secret")}`],
  },
];

test("the before/after contracts of withReportedPaths and the transient cleanup", () => {
  for (const c of CONTRACTS) {
    if (c.skip) continue;
    const dir = mkdtempSync(join(tmpdir(), "copilot-report-"));
    try {
      c.setup?.(dir);
      deferWriteReports();
      c.run(dir);
      expect(flushWriteReports(), c.name).toEqual(c.lines(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
    rmSync(dir, { recursive: true, force: true });
  }
});
