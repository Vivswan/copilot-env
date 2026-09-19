import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, parse, posix } from "node:path";
import { INSTALLER_PINS } from "../.github/scripts/release-assets.ts";
import { compiledHealthFailures } from "../.github/scripts/installer-smoke.ts";
import {
  BUNDLED_ONLY_ASSETS,
  CHECKOUT_MARKERS,
  MATERIALIZED_ASSET_DIRS,
  MATERIALIZED_ASSET_FILES,
} from "../src/install/installer.ts";
import {
  currentReleaseTarget,
  installedBinaryName,
  RELEASE_TARGETS,
  releaseAssetName,
} from "../src/install/targets.ts";
import { readDvmrcPin } from "../src/copilot_api/sidecar.ts";
import { writeDaemonConfig } from "../src/proxy_float.ts";
import { readProjectConfig } from "../src/utils/project_config.ts";
import { ROOT, runSync } from "./helpers/run.ts";
import { describe, expect, removeDir, tempDir, test } from "./helpers/testing.ts";
import { tsFilesUnder as srcFiles } from "./helpers/tree.ts";

// Shell cannot import TS, so the installers hand-roll lists TypeScript modules own; each guard
// parses a list back out of the script text and pins it to its source of truth.
// scripts/compile.ts imports RELEASE_TARGETS directly and needs no guard.

const installSh = readFileSync(join(ROOT, "install.sh"), "utf8");
const installPs1 = readFileSync(join(ROOT, "install.ps1"), "utf8");
const compileTs = readFileSync(join(ROOT, "scripts", "compile.ts"), "utf8");

describe("release-assets.ts pin needles", () => {
  // The release pipeline rewrites these installer lines by byte-exact needle and nothing runs
  // it at PR time, so a cosmetic reformat would merge green and break the release with
  // "placeholder not found".
  test("match each installer byte-for-byte", () => {
    const installers: Record<string, string> = {
      "install.sh": installSh,
      "install.ps1": installPs1,
    };
    for (const [file, pins] of Object.entries(INSTALLER_PINS)) {
      const text = installers[file];
      expect(text, file).toBeDefined();
      for (const { needle } of pins) {
        expect(text, file).toContain(needle);
      }
    }
  });

  test("pinned() forms carry the tag and drop the floating default", () => {
    // validate() derives from the same pinned() as prepare(), so it cannot
    // catch a bad transform; this guards the realistic typo class instead.
    for (const pins of Object.values(INSTALLER_PINS)) {
      for (const { pinned } of pins) {
        const form = pinned("v9.9.9-test");
        expect(form).toContain("v9.9.9-test");
        expect(form).not.toContain("latest");
      }
    }
  });
});

describe("compile targets match the installers", () => {
  // A platform mapped onto a triple outside RELEASE_TARGETS is an install that 404s.
  const triples = RELEASE_TARGETS.map((t) => t.triple).sort();

  test("install.sh and install.ps1 map their platforms onto RELEASE_TARGETS triples", () => {
    const rows: { file: string; mapped: string[]; os: (os: string) => boolean }[] = [
      {
        file: "install.sh",
        mapped: [...installSh.matchAll(/TARGET="([a-z0-9_-]+)"/g)].map((m) => m[1] ?? ""),
        os: (os) => os !== "win32",
      },
      {
        file: "install.ps1",
        mapped: [...installPs1.matchAll(/return '([a-z0-9_-]+)'/g)].map((m) => m[1] ?? ""),
        os: (os) => os === "win32",
      },
    ];
    for (const { file, mapped, os } of rows) {
      expect(mapped.length, file).toBeGreaterThan(0);
      for (const triple of mapped) {
        expect(triples, file).toContain(triple);
      }
      for (const target of RELEASE_TARGETS.filter((t) => os(t.os))) {
        expect(mapped, file).toContain(target.triple);
      }
    }
  });
});

describe("compile.include matches what the binary actually needs", () => {
  // Every embedded asset has exactly one fate, and every fate needs its entry embedded.
  //   MATERIALIZED_*  -> written to the install root; something outside this process opens it by path
  //   BUNDLED_ONLY_*  -> read in-process through ASSET_ROOT, never written
  //   entry, no fate  -> dead weight in all five binaries
  //   fate, no entry  -> missing exactly when first needed
  const needed = [...MATERIALIZED_ASSET_DIRS, ...MATERIALIZED_ASSET_FILES, ...BUNDLED_ONLY_ASSETS];
  // A CLI --include MERGES with deno.json's list instead of replacing it, so a second copy in
  // scripts/compile.ts would silently union rather than fail.
  const compileInclude: string[] = JSON.parse(
    readFileSync(join(ROOT, "deno.json"), "utf8"),
  ).compile?.include ?? [];

  test("compile.include is exactly the union of the fates", () => {
    expect([...compileInclude].sort()).toEqual([...needed].sort());
  });

  test("the fates are disjoint", () => {
    // A path in two fates would be materialized AND read from the VFS, i.e. two
    // copies that can disagree after an update; a file already inside a
    // materialized dir would be copied twice.
    for (const entry of BUNDLED_ONLY_ASSETS) {
      expect(MATERIALIZED_ASSET_DIRS).not.toContain(entry);
      expect(MATERIALIZED_ASSET_FILES).not.toContain(entry);
    }
    for (const file of MATERIALIZED_ASSET_FILES) {
      expect(MATERIALIZED_ASSET_DIRS.some((dir) => file.startsWith(`${dir}/`))).toBe(false);
    }
  });

  test("scripts/compile.ts does not carry a second include list", () => {
    // Comments may mention --include; no executable line may pass it.
    const code = compileTs.split("\n").filter((line) => !line.trim().startsWith("//"));
    expect(code.some((line) => line.includes("--include"))).toBe(false);
  });

  test("the compile task's module graph loads under the task's own permissions", () => {
    // The task grants no env permission; a module on the graph that reads the environment at
    // import (the ansi helpers once did) fails every release build at "Compile this tree's host
    // binary". `--help` loads every module and exits before anything is compiled.
    const task: string = JSON.parse(readFileSync(join(ROOT, "deno.json"), "utf8")).tasks.compile;
    const [bin, ...args] = task.split(/\s+/);
    expect(bin).toBe("deno");
    expect(args.some((arg) => arg.startsWith("--allow-env"))).toBe(false);
    const res = runSync(Deno.execPath(), [...args, "--help"]);
    expect(res.stderr).not.toContain("NotCapable");
    expect(res.stdout).toContain("Usage: deno task compile");
    expect(res.exitCode).toBe(0);
  });
});

describe("bundled-only assets are never read through PROJECT_ROOT", () => {
  // A bundled-only asset read through PROJECT_ROOT passes every checkout test (the two roots
  // coincide there) and fails only on a real install; such reads go through ASSET_ROOT.
  test("no src line names PROJECT_ROOT and a bundled-only asset together", () => {
    let projectRootLines = 0;
    for (const file of srcFiles(join(ROOT, "src"))) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (!line.includes("PROJECT_ROOT")) return;
        projectRootLines += 1;
        for (const asset of BUNDLED_ONLY_ASSETS) {
          if (line.includes(asset)) {
            throw new Error(
              `${file}:${index + 1} reads ${asset} through PROJECT_ROOT; ` +
                `bundled-only assets exist only in the VFS/checkout -- read them via ASSET_ROOT`,
            );
          }
        }
      });
    }
    // Negative control: the scan must actually be seeing PROJECT_ROOT lines,
    // or the loop above was comparing nothing.
    expect(projectRootLines).toBeGreaterThan(0);
  });

  test("a VFS holding exactly the bundled-only assets satisfies every run-time reader", () => {
    // The converse guard: an asset a reader takes from ASSET_ROOT at run time (the daemon's
    // import map, the sidecar's Deno pin, the project config) that left BUNDLED_ONLY_ASSETS
    // breaks every compiled install while `deno test` stays green on the checkout copy.
    const vfs = tempDir("ce-vfs-");
    const home = tempDir("ce-vfs-home-");
    try {
      for (const asset of BUNDLED_ONLY_ASSETS) {
        copyFileSync(join(ROOT, asset), join(vfs, asset));
      }
      const readers: Record<string, (root: string) => unknown> = {
        "daemon import map": (root) => writeDaemonConfig(home, root),
        "Deno version pin": readDvmrcPin,
        "project config": readProjectConfig,
      };
      for (const [name, read] of Object.entries(readers)) {
        expect(() => read(vfs), name).not.toThrow();
        // Control: each reader really depends on the VFS, or the loop above proves nothing.
        expect(() => read(join(vfs, "missing")), name).toThrow();
      }
    } finally {
      removeDir(vfs);
      removeDir(home);
    }
  });
});

describe("the materialized files are the shims' import closure", () => {
  // The shims in src/scripts run from real disk in the install root, so every local file their
  // imports reach must be materialized beside them or the daemon dies at module load.
  //   in the closure, not in MATERIALIZED_ASSET_FILES  -> broken daemon on every install
  //   in MATERIALIZED_ASSET_FILES, not in the closure  -> dead weight nothing imports
  const importRe = /(?:import|export)[^"']*?["'](\.[^"']+\.ts)["']/g;

  function localImportClosure(seeds: string[]): Set<string> {
    const seen = new Set<string>();
    const queue = [...seeds];
    while (queue.length > 0) {
      const rel = queue.pop() as string;
      if (seen.has(rel)) continue;
      seen.add(rel);
      const text = readFileSync(join(ROOT, rel), "utf8");
      for (const match of text.matchAll(importRe)) {
        queue.push(posix.normalize(posix.join(posix.dirname(rel), match[1] ?? "")));
      }
    }
    return seen;
  }

  test("MATERIALIZED_ASSET_FILES is exactly the closure outside the materialized dirs", () => {
    // Arm the walk first: a closure of only the seeds would mean the regex matched nothing and
    // the comparison below was checking empty sets of "outside" files by accident.
    const control = localImportClosure(["src/scripts/daemon_runtime_preload.ts"]);
    expect(control.size).toBeGreaterThan(1);
    expect(control.has("src/copilot_api/config.ts")).toBe(true);

    const seeds = readdirSync(join(ROOT, "src", "scripts"))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => `src/scripts/${name}`);
    expect(seeds.length).toBeGreaterThan(0);
    const closure = localImportClosure(seeds);
    const outside = [...closure].filter((rel) =>
      !MATERIALIZED_ASSET_DIRS.some((dir) => rel.startsWith(`${dir}/`))
    );
    expect(outside.sort()).toEqual([...MATERIALIZED_ASSET_FILES].sort());
  });
});

describe("installers mirror the binary's checkout refusal markers", () => {
  // The installers' marker lists are hand-rolled twins of CHECKOUT_MARKERS. Order is part of
  // the contract: the refusal names the first present marker.
  const expected = [...CHECKOUT_MARKERS];

  test("install.sh and install.ps1 guard markers match CHECKOUT_MARKERS in order", () => {
    const sh = installSh.match(/^\s*for _marker in ([^;]+); do$/m)?.[1] ?? "";
    const ps1 = installPs1.match(/foreach \(\$marker in @\(([^)]*)\)\)/)?.[1] ?? "";
    const rows: Record<string, string[]> = {
      "install.sh": sh.split(/\s+/).filter(Boolean),
      "install.ps1": [...ps1.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? ""),
    };
    for (const [file, names] of Object.entries(rows)) {
      expect(names, file).toEqual(expected);
    }
  });
});

describe("installer checkout guard refuses before mutating, proceeds on legacy roots", () => {
  // The real installer scripts against throwaway roots, fed by a directory download source:
  // the guard's point is ordering, so it must fire before the bin write touches the root.
  const skipWin = test.skipIf(Deno.build.os === "windows");

  /** Sorted relative paths + content hashes: byte-level proof a root was not touched. */
  function snapshotTree(dir: string, prefix = ""): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = posix.join(prefix, entry.name);
      if (entry.isDirectory()) {
        out.push(`${rel}/`, ...snapshotTree(join(dir, entry.name), rel));
      } else {
        const hash = createHash("sha256").update(readFileSync(join(dir, entry.name))).digest("hex");
        out.push(`${rel} ${hash}`);
      }
    }
    return out.sort();
  }

  /** This platform's asset plus checksums.txt; the POSIX stand-in records its own invocation
   *  so a test can prove the handoff ran. */
  function makeDownloadDir(): string {
    const target = currentReleaseTarget();
    if (target === null) throw new Error("no release target for this platform");
    const dir = tempDir("ce-guard-dl-");
    const asset = releaseAssetName(target);
    const body = Deno.build.os === "windows"
      ? "not a real executable\n"
      : '#!/usr/bin/env bash\ntouch "$0.invoked"\nexit 0\n';
    writeFileSync(join(dir, asset), body);
    const sha = createHash("sha256").update(body).digest("hex");
    writeFileSync(join(dir, "checksums.txt"), `${sha}  ${asset}\n`);
    return dir;
  }

  /** `git: "file"` is the worktree-style .git (a gitdir pointer), refused like the directory. */
  function makeRoot(marker: string, git: "dir" | "file" | "none"): string {
    const root = tempDir("ce-guard-root-");
    writeFileSync(join(root, marker), "{}\n");
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "node_modules", "keep.txt"), "keep\n");
    if (git === "dir") {
      mkdirSync(join(root, ".git"));
      writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    } else if (git === "file") {
      writeFileSync(join(root, ".git"), "gitdir: /elsewhere\n");
    }
    return root;
  }

  function runInstaller(
    root: string,
    downloadDir: string,
    extraEnv: Record<string, string> = {},
  ): ReturnType<typeof runSync> {
    const env: Record<string, string | undefined> = {
      ...process.env,
      "COPILOT_ENV_DOWNLOAD_BASE": downloadDir,
      "CI": "1",
    };
    // GitHub's windows runner hands this process pwsh's PSModulePath, which breaks 5.1's module
    // autoload; drop it under any key spelling (Windows env keys are case-insensitive) so the
    // spawn models a stock powershell.exe session.
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === "psmodulepath") delete env[key];
    }
    Object.assign(env, extraEnv);
    if (Deno.build.os === "windows") {
      return runSync("powershell", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(ROOT, "install.ps1"),
        "-InstallDir",
        root,
      ], { env });
    }
    return runSync("bash", [join(ROOT, "install.sh"), "--dir", root], { env });
  }

  function cleanup(...dirs: string[]): void {
    for (const dir of dirs) removeDir(dir);
  }

  /** Attached to every assertion so a red on a remote-only platform is diagnosable without a
   *  rerun. The root's existence is reported too, so a vanished root never reads as a clean sweep. */
  function evidence(res: ReturnType<typeof runSync>, root: string): string {
    const at = (...parts: string[]) => existsSync(join(root, ...parts));
    return [
      `installer exit=${res.exitCode}`,
      `root exists=${existsSync(root)}; mutations: node_modules=${
        at("node_modules")
      } bin/${installedBinaryName()}=${at("bin", installedBinaryName())}`,
      "--- installer stdout ---",
      res.stdout,
      "--- installer stderr ---",
      res.stderr,
    ].join("\n");
  }

  /** install.sh exits 2 on a refusal; install.ps1's exit code is only known to be non-zero. */
  function expectRefused(res: ReturnType<typeof runSync>, why: string): void {
    if (Deno.build.os === "windows") expect(res.exitCode, why).not.toBe(0);
    else expect(res.exitCode, why).toBe(2);
  }

  test("the installer refuses a checkout root and leaves it byte-identical", () => {
    const downloadDir = makeDownloadDir();
    try {
      for (const git of ["dir", "file"] as const) {
        const root = makeRoot("package.json", git);
        try {
          const before = snapshotTree(root);
          const res = runInstaller(root, downloadDir);
          const why = evidence(res, root);
          expectRefused(res, why);
          expect(res.stderr, why).toContain("source checkout");
          expect(snapshotTree(root), why).toEqual(before);
        } finally {
          cleanup(root);
        }
      }
    } finally {
      cleanup(downloadDir);
    }
  });

  test("the installer proceeds on a marker-only root (no .git) and hands off to the binary", () => {
    const downloadDir = makeDownloadDir();
    const root = makeRoot("deno.json", "none");
    try {
      const res = runInstaller(root, downloadDir);
      const why = evidence(res, root);
      // The installer sweeps nothing itself (it hands off to `agent install`), so the root's own
      // files must survive the handoff.
      expect(existsSync(join(root, "node_modules")), why).toBe(true);
      expect(existsSync(join(root, "deno.json")), why).toBe(true);
      expect(existsSync(join(root, "bin", installedBinaryName())), why).toBe(true);
      if (Deno.build.os === "windows") {
        // The stand-in .exe cannot run, so the non-zero exit proves the handoff was attempted
        // and the mutations above prove the guard let the marker-only root through.
        expect(res.exitCode, why).not.toBe(0);
      } else {
        expect(res.exitCode, why).toBe(0);
        // An installer that never invoked the binary would pass the assertions above while
        // installing nothing.
        expect(existsSync(join(root, "bin", `${installedBinaryName()}.invoked`)), why).toBe(true);
      }
    } finally {
      cleanup(root, downloadDir);
    }
  });

  // POSIX only: the Windows stand-in asset is deliberately not executable (the refusal
  // tests never reach the handoff), and this case needs the handoff to succeed.
  skipWin(
    "a fresh install names the root it creates, in the seam's shape, before the handoff",
    () => {
      // The root does not exist yet, so the shell creates it before the binary (which
      // names its own writes) can: the installer must say so itself, on stderr.
      const downloadDir = makeDownloadDir();
      const parent = tempDir("ce-guard-fresh-");
      // Two levels deep: the missing ancestor is created too, and named before the root.
      const root = join(parent, "nested", "copilot-env");
      try {
        const res = runInstaller(root, downloadDir);
        const why = evidence(res, root);
        expect(res.exitCode, why).toBe(0);
        const created = res.stderr.split(/\r?\n/).filter((l) => l.startsWith("created -> "));
        expect(created, why).toEqual([
          `created -> ${join(parent, "nested")}`,
          `created -> ${root}`,
        ]);
        // Control: a pre-existing root is not announced as created.
        const again = runInstaller(root, downloadDir);
        expect(again.exitCode, evidence(again, root)).toBe(0);
        expect(again.stderr, evidence(again, root)).not.toContain(`created -> ${root}`);
      } finally {
        cleanup(parent, downloadDir);
      }
    },
  );

  test("the installer refuses the lexically unsafe targets before any other work", () => {
    // The installer keeps only a lexical pre-check (the canonical one is in the binary); it
    // must still stop the worst spellings before the first network call or write. The empty
    // download source keeps a regressed run off the network: it fails at the local copy.
    const win = Deno.build.os === "windows";
    const home = (win ? process.env.USERPROFILE : process.env.HOME) ?? "";
    expect(home.length).toBeGreaterThan(0);
    const unsafe = win
      // The ps1 guard collapses separators and dot components via GetFullPath, so those
      // spellings land on the same refusals.
      ? [
        parse(home).root, // the filesystem root, e.g. C:\
        home,
        `${home}\\`, // trailing separator must not defeat the compare
        `${home}/`, // the alt separator spelling of the same
        home.replaceAll("\\", "\\\\"), // internal doubled separators
        `${home}\\.`, // GetFullPath collapses the dot component back to home
        `${home}\\*`, // wildcard rejection
      ]
      //   "/Users//me"                  -> distinct from home unless separators collapse first
      //   internal-only doubled slash   -> pinned apart, or a leading-"//" rejection alone passes
      : [
        "/",
        "//",
        home,
        `${home}/`,
        home.replaceAll("/", "//"),
        home.replace(/\/(?=[^/]*$)/, "//"), // internal-only: double just the last slash
        "/tmp/..",
        `${home}/.`,
        ".",
      ];
    const emptyDownloadDir = tempDir("ce-lexical-dl-");
    try {
      for (const dir of unsafe) {
        const res = runInstaller(dir, emptyDownloadDir);
        const why = `target '${dir}' exit=${res.exitCode}:\n${res.stderr}`;
        expectRefused(res, why);
        expect(res.stderr, why).toContain("unsafe install directory");
      }
    } finally {
      removeDir(emptyDownloadDir);
    }
  });

  // PowerShell 7's own module directory: prepended onto a 5.1 child's
  // PSModulePath (what a pwsh parent does), its Core-edition in-box modules
  // shadow 5.1's and cannot load there, so autoload of Get-FileHash dies.
  const ps7Modules = Deno.build.os === "windows"
    ? join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "Modules")
    : "";
  // Off CI a machine without pwsh 7 genuinely cannot host the poison; on CI a
  // missing directory must fail the test below instead, or a runner-image
  // change would silently retire this coverage.
  const winWithPwsh7 = test.skipIf(
    Deno.build.os !== "windows" || (!existsSync(ps7Modules) && !process.env.CI),
  );

  winWithPwsh7("install.ps1 shields itself from a pwsh-poisoned PSModulePath", () => {
    // Regression guard for install.ps1's own PSModulePath reset: without it,
    // this exact environment killed the install at checksum verification.
    expect(existsSync(ps7Modules), `pwsh 7 module dir vanished: ${ps7Modules}`).toBe(true);
    const poisoned = `${ps7Modules};${process.env.PSModulePath ?? ""}`;
    // Negative control: the poison must bite on this machine, or the run below
    // proves nothing about the reset. Pin the failure to the Get-FileHash
    // autoload itself, so a timeout or an unrelated error cannot stand in.
    const probe = runSync("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-FileHash -LiteralPath $PSHOME\\powershell.exe -Algorithm SHA256",
    ], { env: { ...process.env, "PSModulePath": poisoned } });
    const probeWhy = `unshielded probe exit=${probe.exitCode}:\n${probe.stderr}`;
    expect(probe.exitCode, probeWhy).not.toBe(0);
    expect(probe.stderr, probeWhy).toContain("Get-FileHash");

    const downloadDir = makeDownloadDir();
    const root = makeRoot("deno.json", "none");
    try {
      const res = runInstaller(root, downloadDir, { "PSModulePath": poisoned });
      const why = evidence(res, root);
      expect(existsSync(join(root, "bin", installedBinaryName())), why).toBe(true);
    } finally {
      cleanup(root, downloadDir);
    }
  });
});

describe("the install task spawns what it is allowed to run", () => {
  // The task's --allow-run list and scripts/install_local.ts's spawn set are two hand-kept
  // spellings of one contract; a drift is a permission prompt or denial at run time.
  const installLocal = readFileSync(join(ROOT, "scripts", "install_local.ts"), "utf8");

  test("--allow-run covers exactly the spawned commands", () => {
    const denoJson = JSON.parse(readFileSync(join(ROOT, "deno.json"), "utf8")) as {
      tasks: Record<string, string>;
    };
    const allow = denoJson.tasks.install?.match(/--allow-run=(\S+)/)?.[1]?.split(",") ?? [];
    const spawned = [...installLocal.matchAll(/run\(\s*\n?\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(spawned)).toEqual(new Set(allow));
    // The --force path additionally reads env + home and deletes the install
    // root; a dropped flag is a hard denial at run time.
    for (const flag of ["--allow-env", "--allow-read", "--allow-write", "--allow-sys=homedir"]) {
      expect(denoJson.tasks.install).toContain(flag);
    }
  });

  test("install.sh is invoked under the shell its shebang declares", () => {
    // /bin/sh is dash on Debian/Ubuntu and install.sh uses bash arrays: the
    // spawn must match the script's own declaration, not a lowest common sh.
    const shebang = installSh.split("\n", 1)[0] ?? "";
    expect(shebang).toContain("bash");
    expect(installLocal).toContain('run("bash", [join(ROOT, "install.sh")]');
  });
});

describe("compiled-health smoke invariants fail closed", () => {
  // Optional-chaining past a renamed check id would print success while asserting nothing.
  const good = () => ({
    checks: [
      { id: "bootstrap.nodeModules", status: "ok", value: { embedded: true } },
      { id: "proxy.package", status: "ok", value: {} },
      { id: "proxy.sidecar", status: "ok", value: { kind: "absent" } },
    ],
  });

  test("healthy reports pass; every reshaped, missing, or non-ok row is one failure", () => {
    const sidecar = (kind: string) => {
      const report = good();
      report.checks[2] = { id: "proxy.sidecar", status: "ok", value: { kind } };
      return report;
    };
    const pkg = (status: string | undefined) => {
      const report = good();
      report.checks[1] = { id: "proxy.package", status: status as string, value: {} };
      return report;
    };
    const rows: { name: string; report: unknown; failures: number | string[] }[] = [
      { name: "absent sidecar", report: good(), failures: [] },
      { name: "provisioned sidecar", report: sidecar("provisioned"), failures: [] },
      { name: "dev sidecar", report: sidecar("dev"), failures: 1 },
      { name: "unknown sidecar kind", report: sidecar("future-kind"), failures: 1 },
      { name: "package fail", report: pkg("fail"), failures: 1 },
      { name: "package warn", report: pkg("warn"), failures: 1 },
      { name: "package status missing", report: pkg(undefined), failures: 1 },
      {
        name: "non-embedded deps",
        report: (() => {
          const report = good();
          report.checks[0] = { id: "bootstrap.nodeModules", status: "fail", value: {} };
          return report;
        })(),
        failures: 1,
      },
      { name: "every row missing", report: { checks: [] }, failures: 3 },
      {
        name: "no checks array",
        report: {},
        failures: ["health --json did not produce a checks array"],
      },
      { name: "null", report: null, failures: 1 },
      {
        name: "sidecar value reshaped",
        report: (() => {
          const report = good();
          report.checks[2] = { id: "proxy.sidecar", status: "ok", value: {} as { kind: string } };
          return report;
        })(),
        failures: 1,
      },
    ];
    for (const { name, report, failures } of rows) {
      const got = compiledHealthFailures(report);
      if (typeof failures === "number") expect(got, name).toHaveLength(failures);
      else expect(got, name).toEqual(failures);
    }
  });
});
