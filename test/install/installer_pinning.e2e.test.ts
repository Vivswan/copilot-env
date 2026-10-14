import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, parse, posix, relative, sep } from "node:path";
import { compiledHealthFailures } from "../../.github/scripts/installer-smoke.ts";
import { INSTALLER_PINS } from "../../.github/scripts/release-assets.ts";
import { DAEMON_SHIM_DEPENDENCIES } from "../../src/copilot_api/shims.ts";
import {
  BUNDLED_ONLY_ASSETS,
  CHECKOUT_MARKERS,
  MATERIALIZED_ASSET_DIRS,
  MATERIALIZED_ASSET_FILES,
} from "../../src/install/installer.ts";
import { readInstallMinimumReleaseAge } from "../../src/utils/bunfig.ts";
import { childPathPrepending, withPowershellChildEnv } from "../../src/utils/command.ts";
import { readProjectConfig } from "../../src/utils/project_config.ts";
import {
  currentReleaseTarget,
  installedBinaryName,
  RELEASE_TARGETS,
  releaseAssetName,
} from "../../src/utils/targets.ts";
import { ROOT, runScript, runSync, spawnChild } from "../helpers/run.ts";
import { moduleSpecifiers, parseModule, resolveRelative, visit } from "../helpers/syntax.ts";
import { describe, expect, removeDir, tempDir, test } from "../helpers/testing.ts";
import { tsFilesUnder as srcFiles } from "../helpers/tree.ts";

// Shell cannot import TS, so the installers hand-roll lists TypeScript modules own; each guard
// parses a list back out of the script text and pins it to its source of truth.
// scripts/compile.ts imports RELEASE_TARGETS directly and needs no guard.

const installSh = readFileSync(join(ROOT, "install.sh"), "utf8");
const installPs1 = readFileSync(join(ROOT, "install.ps1"), "utf8");

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

describe("the embedded assets' fates", () => {
  // scripts/compile.ts embeds the three fate lists themselves, so the only way an asset can be
  // wrong is to sit in two of them.
  //   MATERIALIZED_*  -> written to the install root; something outside this process opens it by path
  //   BUNDLED_ONLY_*  -> read in-process through ASSET_ROOT, never written
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

  test("the build script's module graph loads before anything is compiled", () => {
    // A module on the graph that throws at import fails every release build at "Compile this
    // tree's host binary", after the PR merged green. `--help` loads every module and exits before
    // anything is compiled.
    const res = runScript(join(ROOT, "scripts", "compile.ts"), ["--help"]);
    expect(res.stdout, res.stderr).toContain("Usage: bun run build");
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
    // The converse guard: an asset a reader takes from ASSET_ROOT at run time (the project
    // config, the float's default cooldown) that left BUNDLED_ONLY_ASSETS breaks every compiled
    // install while the suite stays green on the checkout copy.
    const vfs = tempDir("ce-vfs-");
    try {
      for (const asset of BUNDLED_ONLY_ASSETS) {
        copyFileSync(join(ROOT, asset), join(vfs, asset));
      }
      const readers: Record<string, (root: string) => unknown> = {
        "project config": readProjectConfig,
        "default release cooldown": readInstallMinimumReleaseAge,
      };
      for (const [name, read] of Object.entries(readers)) {
        expect(() => read(vfs), name).not.toThrow();
        // Control: each reader really depends on the VFS, or the loop above proves nothing.
        expect(() => read(join(vfs, "missing")), name).toThrow();
      }
    } finally {
      removeDir(vfs);
    }
  });
});

describe("the materialized files are the shims' import closure", () => {
  // The shims in src/scripts run from real disk in the install root, so every local file their
  // imports reach must be materialized beside them or the daemon dies at module load.
  //   in the closure, not in MATERIALIZED_ASSET_FILES  -> broken daemon on every install
  //   in MATERIALIZED_ASSET_FILES, not in the closure  -> dead weight nothing imports
  /** Every specifier, type-only included: the closure materializes what the files name. */
  function localImportClosure(seeds: string[]): Set<string> {
    const seen = new Set<string>();
    const queue = [...seeds];
    while (queue.length > 0) {
      const rel = queue.pop() as string;
      if (seen.has(rel)) continue;
      seen.add(rel);
      const path = join(ROOT, rel);
      for (const specifier of moduleSpecifiers(parseModule(path))) {
        const target = resolveRelative(path, specifier);
        if (target !== null) queue.push(relative(ROOT, target).split(sep).join(posix.sep));
      }
    }
    return seen;
  }

  /** The packages the files import at run time: bare specifiers of value imports and re-exports
   *  (a type-only statement is erased), the modules the runtime answers itself aside. Bun resolves
   *  those to their own name, `node:` and `bun:` modules and the third-party names it ships built
   *  in (`undici`) alike, whatever node_modules holds. */
  function bareImports(files: Iterable<string>): string[] {
    const names = new Set<string>();
    const consider = (specifier: string): void => {
      const local = specifier.startsWith("./") || specifier.startsWith("../");
      if (local || Bun.resolveSync(specifier, ROOT) === specifier) return;
      names.add(specifier);
    };
    for (const rel of files) {
      visit(parseModule(join(ROOT, rel)).program, {
        ImportDeclaration(node) {
          if (node.importKind !== "type") consider(node.source.value);
        },
        ExportNamedDeclaration(node) {
          if (node.source !== null && node.exportKind !== "type") consider(node.source.value);
        },
        ExportAllDeclaration(node) {
          if (node.exportKind !== "type") consider(node.source.value);
        },
      });
    }
    return [...names].sort();
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
    const outside = [...closure].filter(
      (rel) => !MATERIALIZED_ASSET_DIRS.some((dir) => rel.startsWith(`${dir}/`)),
    );
    expect(outside.sort()).toEqual([...MATERIALIZED_ASSET_FILES].sort());
  });

  // A compiled install has no node_modules beside the shims: the float installs exactly
  // DAEMON_SHIM_DEPENDENCIES into the proxy home and the daemon runs with auto-install off, so a
  // package the closure imports but the list lacks kills the daemon at module load on every
  // install, while the suite (which resolves from the checkout) stays green.
  test("DAEMON_SHIM_DEPENDENCIES is exactly the closure's package imports", () => {
    const seeds = readdirSync(join(ROOT, "src", "scripts"))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => `src/scripts/${name}`);
    const imported = bareImports(localImportClosure(seeds));
    expect(imported.length).toBeGreaterThan(0); // the walk saw real imports
    expect(imported).toEqual([...DAEMON_SHIM_DEPENDENCIES].sort());
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
  const skipWin = test.skipIf(process.platform === "win32");
  /** What a marker-only root (no .git) carries: the first marker the binary refuses on. */
  const MARKER = CHECKOUT_MARKERS[0];

  /** Sorted relative paths + content hashes: byte-level proof a root was not touched. */
  function snapshotTree(dir: string, prefix = ""): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = posix.join(prefix, entry.name);
      if (entry.isDirectory()) {
        out.push(`${rel}/`, ...snapshotTree(join(dir, entry.name), rel));
      } else {
        const hash = createHash("sha256")
          .update(readFileSync(join(dir, entry.name)))
          .digest("hex");
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
    const body =
      process.platform === "win32"
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

  /** The installer's argv and environment for this platform. The Windows side runs under the
   *  real Windows PowerShell 5.1, by its fixed path so a PATH a test strips still finds it. */
  function installerCommand(
    root: string,
    downloadBase: string,
    extraEnv: Record<string, string> = {},
    extraArgs: string[] = [],
  ): { cmd: string; args: string[]; env: Record<string, string | undefined> } {
    const extra = { COPILOT_ENV_DOWNLOAD_BASE: downloadBase, CI: "1", ...extraEnv };
    if (process.platform === "win32") {
      return withPowershellChildEnv("powershell", (env) => ({
        cmd: join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        ),
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          join(ROOT, "install.ps1"),
          "-InstallDir",
          root,
          ...extraArgs,
        ],
        env: { ...env, ...extra },
      }));
    }
    return {
      cmd: "bash",
      args: [join(ROOT, "install.sh"), "--dir", root, ...extraArgs],
      env: { ...process.env, ...extra },
    };
  }

  function runInstaller(
    root: string,
    downloadDir: string,
    extraEnv: Record<string, string> = {},
    extraArgs: string[] = [],
  ): ReturnType<typeof runSync> {
    const { cmd, args, env } = installerCommand(root, downloadDir, extraEnv, extraArgs);
    return runSync(cmd, args, { env });
  }

  /** install.sh on a pseudo-terminal (`script`), CI unset, so the shell-reload offer at the end
   *  is reachable; $SHELL is a stand-in that records `$0.ran` when the reload execs it. Stdin is
   *  at EOF, so an offer that IS made reads no answer and declines. */
  function runInstallerOnTty(
    root: string,
    downloadDir: string,
    extraArgs: string[],
  ): { res: ReturnType<typeof runSync>; reloaded: boolean } {
    const shell = join(downloadDir, "reload-shell.sh");
    writeFileSync(shell, '#!/usr/bin/env bash\ntouch "$0.ran"\nexit 0\n', { mode: 0o755 });
    // $SHELL rides the command, not script's environment: util-linux script runs its -c string
    // through $SHELL, which would exec the stand-in in place of the installer.
    const command = [
      "env",
      `SHELL=${shell}`,
      "bash",
      join(ROOT, "install.sh"),
      "--dir",
      root,
      ...extraArgs,
    ];
    const env: Record<string, string | undefined> = {
      ...process.env,
      COPILOT_ENV_DOWNLOAD_BASE: downloadDir,
      CI: undefined,
      COPILOT_ENV_NO_EXEC_SHELL: undefined,
    };
    // BSD script (macOS) takes the command as trailing argv; util-linux takes one -c string.
    const res =
      process.platform === "darwin"
        ? runSync("script", ["-q", "/dev/null", ...command], { env })
        : runSync("script", ["-qec", command.map((a) => `'${a}'`).join(" "), "/dev/null"], { env });
    return { res, reloaded: existsSync(`${shell}.ran`) };
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
      `root exists=${existsSync(root)}; mutations: node_modules=${at(
        "node_modules",
      )} bin/${installedBinaryName()}=${at("bin", installedBinaryName())}`,
      "--- installer stdout ---",
      res.stdout,
      "--- installer stderr ---",
      res.stderr,
    ].join("\n");
  }

  /** install.sh exits 2 on a refusal; install.ps1's exit code is only known to be non-zero. */
  function expectRefused(res: ReturnType<typeof runSync>, why: string): void {
    if (process.platform === "win32") expect(res.exitCode, why).not.toBe(0);
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
    const root = makeRoot(MARKER, "none");
    try {
      const res = runInstaller(root, downloadDir);
      const why = evidence(res, root);
      // The installer sweeps nothing itself (it hands off to `agent install`), so the root's own
      // files must survive the handoff.
      expect(existsSync(join(root, "node_modules")), why).toBe(true);
      expect(existsSync(join(root, MARKER)), why).toBe(true);
      expect(existsSync(join(root, "bin", installedBinaryName())), why).toBe(true);
      if (process.platform === "win32") {
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

  // The one run that fetches over HTTP: the smokes and every other case here hand the installer
  // a directory, so the transport (curl on POSIX; on Windows the web cmdlets once curl.exe is off
  // PATH) runs against a real server nowhere else before a release. curl is install.sh's only
  // transport, and the container image (Dockerfile) ships none: there the POSIX run skips.
  const posixWithCurl = test.skipIf(process.platform !== "win32" && Bun.which("curl") === null);
  posixWithCurl(
    "the installer downloads from a URL base, on Windows with no curl.exe on PATH",
    async () => {
      const win = process.platform === "win32";
      const downloadDir = makeDownloadDir();
      const served = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(req) {
          const file = join(downloadDir, basename(new URL(req.url).pathname));
          return existsSync(file)
            ? new Response(Bun.file(file))
            : new Response("not here", { status: 404 });
        },
      });
      const root = makeRoot(MARKER, "none");
      // POSIX keeps its PATH: curl IS install.sh's transport, and the fallback under test is
      // install.ps1's. The key is spelled as this process's environment spells it, so the override
      // replaces the entry instead of adding a second one.
      const barePath = tempDir("ce-guard-bare-path-");
      const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
      try {
        const { cmd, args, env } = installerCommand(
          root,
          `http://127.0.0.1:${served.port}`,
          win ? { [pathKey]: barePath } : {},
        );
        const child = spawnChild(cmd, { args, env, stdout: "pipe", stderr: "pipe" });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        const res = { exitCode, stdout, stderr };
        const why = evidence(res, root);
        const installed = join(root, "bin", installedBinaryName());
        const target = currentReleaseTarget();
        if (target === null) throw new Error("no release target for this platform");
        const asset = releaseAssetName(target);
        // The bytes that reached bin/ are the served asset's: a run that skipped the fetch, or
        // fetched the wrong thing, fails the installer's own SHA256 check before this.
        expect(existsSync(installed), why).toBe(true);
        expect(readFileSync(installed, "utf8"), why).toBe(
          readFileSync(join(downloadDir, asset), "utf8"),
        );
        if (win) {
          // The stand-in .exe cannot run, so the handoff's non-zero exit is the only exit on offer.
          expect(exitCode, why).not.toBe(0);
        } else {
          expect(exitCode, why).toBe(0);
          expect(existsSync(`${installed}.invoked`), why).toBe(true);
        }
      } finally {
        served.stop(true);
        cleanup(root, downloadDir, barePath);
      }
    },
  );

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

  // POSIX only: the tokenless `latest` lookup is install.sh's. GitHub answers /releases/latest
  // with a redirect to the tag page; the tag is that final URL's last path segment, whatever
  // query, fragment, or trailing slash rides along. The tag is pinned where it leaves the
  // installer: the download URLs a curl stand-in on PATH logs.
  skipWin(
    "install.sh takes the release tag from the redirect's final URL without its query, fragment, or trailing slash",
    () => {
      const target = currentReleaseTarget();
      if (target === null) throw new Error("no release target for this platform");
      const asset = releaseAssetName(target);
      const tagPage = "https://github.com/Vivswan/copilot-env/releases/tag/v1.2.3";
      const finalUrls = [tagPage, `${tagPage}?view=1`, `${tagPage}#notes`, `${tagPage}/`];
      const downloadDir = makeDownloadDir();
      const binDir = tempDir("ce-guard-curl-");
      const log = join(binDir, "urls.log");
      writeFileSync(
        join(binDir, "curl"),
        [
          "#!/usr/bin/env bash",
          "set -eu",
          'dest=""; url=""; probe=false',
          "while [ $# -gt 0 ]; do",
          '  case "$1" in',
          '    -o) shift; dest="$1" ;;',
          "    -w) shift; probe=true ;;",
          "    -H) shift ;;",
          "    -*) ;;",
          '    *) url="$1" ;;',
          "  esac",
          "  shift",
          "done",
          `printf '%s\\n' "$url" >> "$CE_TEST_CURL_LOG"`,
          `if [ "$probe" = true ]; then printf '%s' "$CE_TEST_FINAL_URL"; exit 0; fi`,
          'cp -- "$CE_TEST_ASSET_DIR/$(basename "$url")" "$dest"',
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      try {
        for (const finalUrl of finalUrls) {
          const root = makeRoot(MARKER, "none");
          rmSync(log, { force: true });
          try {
            const res = runSync("bash", [join(ROOT, "install.sh"), "--dir", root], {
              env: {
                ...process.env,
                PATH: childPathPrepending([binDir]),
                CI: "1",
                CE_TEST_FINAL_URL: finalUrl,
                CE_TEST_CURL_LOG: log,
                CE_TEST_ASSET_DIR: downloadDir,
                COPILOT_ENV_DOWNLOAD_BASE: undefined,
                COPILOT_ENV_INSTALL_REF: undefined,
                GH_TOKEN: undefined,
                GITHUB_TOKEN: undefined,
              },
            });
            const why = `final URL ${finalUrl}\n${evidence(res, root)}`;
            expect(res.exitCode, why).toBe(0);
            expect(existsSync(join(root, "bin", `${installedBinaryName()}.invoked`)), why).toBe(
              true,
            );
            expect(readFileSync(log, "utf8").split("\n"), why).toEqual([
              "https://github.com/Vivswan/copilot-env/releases/latest",
              `https://github.com/Vivswan/copilot-env/releases/download/v1.2.3/${asset}`,
              "https://github.com/Vivswan/copilot-env/releases/download/v1.2.3/checksums.txt",
              "",
            ]);
          } finally {
            cleanup(root);
          }
        }
      } finally {
        cleanup(binDir, downloadDir);
      }
    },
  );

  test("the installer refuses a bad argument before any other work", () => {
    // An empty download directory keeps a regressed run off the network: it fails at the local copy.
    const win = process.platform === "win32";
    const refused: { args: string[]; reason: string }[] = [
      { args: win ? ["-Yes", "-No"] : ["--yes", "--no"], reason: "conflict" },
      // A flag where --dir's value should be is a missing value, not a path named "--yes";
      // install.ps1 refuses the missing argument natively.
      ...(win ? [] : [{ args: ["--dir", "--yes"], reason: "--dir needs a directory argument" }]),
    ];
    for (const { args, reason } of refused) {
      const root = tempDir("ce-guard-refused-");
      const downloadDir = tempDir("ce-guard-dl-empty-");
      try {
        const res = runInstaller(root, downloadDir, {}, args);
        const why = `${args.join(" ")}\n${evidence(res, root)}`;
        expectRefused(res, why);
        expect(res.stderr, why).toContain(reason);
        expect(existsSync(join(root, "bin")), why).toBe(false);
      } finally {
        cleanup(root, downloadDir);
      }
    }
  });

  skipWin("on a terminal, --no skips the reload offer and --yes takes it without asking", () => {
    const downloadDir = makeDownloadDir();
    const prompt = "Reload your shell now to activate copilot-env?";
    const rows: { args: string[]; prompted: boolean; reloaded: boolean }[] = [
      // Control: the offer is made here, so an absence below is the flag's doing.
      { args: [], prompted: true, reloaded: false },
      { args: ["--no"], prompted: false, reloaded: false },
      { args: ["--yes"], prompted: false, reloaded: true },
    ];
    try {
      for (const row of rows) {
        const root = makeRoot(MARKER, "none");
        try {
          const { res, reloaded } = runInstallerOnTty(root, downloadDir, row.args);
          const why = `${row.args.join(" ") || "(no flag)"}\n${evidence(res, root)}`;
          expect(res.exitCode, why).toBe(0);
          // The handoff ran, so the offer at the end was reached rather than skipped by a refusal.
          expect(existsSync(join(root, "bin", `${installedBinaryName()}.invoked`)), why).toBe(true);
          expect(res.stdout.includes(prompt), why).toBe(row.prompted);
          expect(reloaded, why).toBe(row.reloaded);
        } finally {
          cleanup(root);
          rmSync(join(downloadDir, "reload-shell.sh.ran"), { force: true });
        }
      }
    } finally {
      cleanup(downloadDir);
    }
  });

  test("the installer refuses the lexically unsafe targets before any other work", () => {
    // The installer keeps only a lexical pre-check (the canonical one is in the binary); it
    // must still stop the worst spellings before the first network call or write. The empty
    // download source keeps a regressed run off the network: it fails at the local copy.
    const win = process.platform === "win32";
    const home = (win ? process.env.USERPROFILE : process.env.HOME) ?? "";
    expect(home.length).toBeGreaterThan(0);
    const unsafe = win
      ? // The ps1 guard collapses separators and dot components via GetFullPath, so those
        // spellings land on the same refusals.
        [
          parse(home).root, // the filesystem root, e.g. C:\
          home,
          `${home}\\`, // trailing separator must not defeat the compare
          `${home}/`, // the alt separator spelling of the same
          home.replaceAll("\\", "\\\\"), // internal doubled separators
          `${home}\\.`, // GetFullPath collapses the dot component back to home
          `${home}\\*`, // wildcard rejection
        ]
      : //   "/Users//me"                  -> distinct from home unless separators collapse first
        //   internal-only doubled slash   -> pinned apart, or a leading-"//" rejection alone passes
        [
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
  const ps7Modules =
    process.platform === "win32"
      ? join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "Modules")
      : "";
  // Off CI a machine without pwsh 7 genuinely cannot host the poison; on CI a
  // missing directory must fail the test below instead, or a runner-image
  // change would silently retire this coverage.
  const winWithPwsh7 = test.skipIf(
    process.platform !== "win32" || (!existsSync(ps7Modules) && !process.env.CI),
  );

  winWithPwsh7("install.ps1 shields itself from a pwsh-poisoned PSModulePath", () => {
    // Regression guard for install.ps1's own PSModulePath reset: without it,
    // this exact environment killed the install at checksum verification.
    expect(existsSync(ps7Modules), `pwsh 7 module dir vanished: ${ps7Modules}`).toBe(true);
    const poisoned = `${ps7Modules};${process.env.PSModulePath ?? ""}`;
    // Negative control: the poison must bite on this machine, or the run below
    // proves nothing about the reset. Pin the failure to the Get-FileHash
    // autoload itself, so a timeout or an unrelated error cannot stand in.
    const probe = runSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-FileHash -LiteralPath $PSHOME\\powershell.exe -Algorithm SHA256",
      ],
      { env: { ...process.env, PSModulePath: poisoned } },
    );
    const probeWhy = `unshielded probe exit=${probe.exitCode}:\n${probe.stderr}`;
    expect(probe.exitCode, probeWhy).not.toBe(0);
    expect(probe.stderr, probeWhy).toContain("Get-FileHash");

    const downloadDir = makeDownloadDir();
    const root = makeRoot(MARKER, "none");
    try {
      const res = runInstaller(root, downloadDir, { PSModulePath: poisoned });
      const why = evidence(res, root);
      expect(existsSync(join(root, "bin", installedBinaryName())), why).toBe(true);
    } finally {
      cleanup(root, downloadDir);
    }
  });
});

// POSIX only: the stand-ins are shell scripts found through PATH, which Windows' spawn does not
// honour for `bun` and `powershell`.
describe("the install script's arguments", () => {
  const skipWin = test.skipIf(process.platform === "win32");
  const task = join(ROOT, "scripts", "install_local.ts");

  /** Stand-ins for the script's two spawns, first on PATH: `bun` (the build) and `bash` (the
   *  installer) each record their argv, one per line, instead of building or installing. */
  function standIns(): {
    env: Record<string, string | undefined>;
    argvOf: (name: string) => string[] | null;
    remove: () => void;
  } {
    const bin = tempDir("ce-task-bin-");
    for (const name of ["bun", "bash"]) {
      const record = join(bin, `${name}.argv`);
      writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "$@" > '${record}'\n`, {
        mode: 0o755,
      });
    }
    return {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      argvOf: (name) => {
        const file = join(bin, `${name}.argv`);
        return existsSync(file) ? readFileSync(file, "utf8").split("\n").slice(0, -1) : null;
      },
      remove: () => removeDir(bin),
    };
  }

  skipWin("a bad argument is refused before anything is compiled", () => {
    const refused: { args: string[]; reason: string }[] = [
      { args: ["--yes", "--no"], reason: "conflict" },
      { args: ["--bogus"], reason: "unknown argument '--bogus'" },
      // The task installs the binary it just compiled; a release tag has nothing to select.
      { args: ["--version", "v1.2.3"], reason: "--version is not accepted" },
      { args: ["--dir"], reason: "--dir needs a DIR argument" },
      // A flag where the value should be is a missing value, not a path named "--yes".
      { args: ["--dir", "--yes"], reason: "--dir needs a DIR argument" },
      // PowerShell refuses a repeated parameter, which would land after --force's deletion.
      { args: ["--dir", "/tmp/a", "--dir", "/tmp/b"], reason: "--dir given more than once" },
      { args: ["--all-hosts"], reason: "install.sh has no such flag" },
    ];
    for (const { args, reason } of refused) {
      const stubs = standIns();
      try {
        const res = runScript(task, args, { env: stubs.env });
        const why = `${args.join(" ")}\n${res.stderr}`;
        expect(res.exitCode, why).toBe(2);
        expect(res.stderr, why).toContain(reason);
        expect(stubs.argvOf("bun"), why).toBeNull();
      } finally {
        stubs.remove();
      }
    }
  });

  skipWin(
    "the installer flags reach install.sh's argv after the compile, --dir absolute, under the shell its shebang declares",
    () => {
      // A relative --dir is resolved against the task's cwd: --force and the installer would
      // otherwise name it from different rules (realpath here, install.sh's "." refusal there).
      const stubs = standIns();
      try {
        const res = runScript(task, ["--dir", "./local-install", "--yes"], { env: stubs.env });
        expect(res.exitCode, res.stderr).toBe(0);
        expect(stubs.argvOf("bun")?.slice(0, 2), res.stderr).toEqual(["run", "build"]);
        expect(stubs.argvOf("bash"), res.stderr).toEqual([
          join(ROOT, "install.sh"),
          "--dir",
          join(ROOT, "local-install"),
          "--yes",
        ]);
        // /bin/sh is dash on Debian/Ubuntu and install.sh uses bash arrays: the task spawned
        // `bash` above, so the script's own declaration must agree, not a lowest common sh.
        expect(installSh.split("\n", 1)[0] ?? "").toContain("bash");
      } finally {
        stubs.remove();
      }
    },
  );
});

describe("compiled-health smoke invariants fail closed", () => {
  // Optional-chaining past a renamed check id would print success while asserting nothing.
  const BINARY = "copilot-env";
  const good = () => ({
    checks: [
      { id: "bootstrap.nodeModules", status: "ok", value: { embedded: true } },
      { id: "proxy.package", status: "ok", value: {} },
      {
        id: "bootstrap.runtime",
        status: "ok",
        value: { executable: `/home/x/.copilot-env/versions/v1.0.0/bin/${BINARY}` } as Record<
          string,
          unknown
        >,
      },
    ],
  });

  test("healthy reports pass; every reshaped, missing, or non-ok row is one failure", () => {
    const runtime = (executable: unknown) => {
      const report = good();
      report.checks[2] = { id: "bootstrap.runtime", status: "ok", value: { executable } };
      return report;
    };
    const pkg = (status: string | undefined) => {
      const report = good();
      report.checks[1] = { id: "proxy.package", status: status as string, value: {} };
      return report;
    };
    const rows: { name: string; report: unknown; failures: number | string[] }[] = [
      { name: "the installed binary", report: good(), failures: [] },
      // A Windows install names the binary with its suffix: the check is given that name.
      {
        name: "a bun from PATH (a checkout's answer)",
        report: runtime("/usr/local/bin/bun"),
        failures: 1,
      },
      { name: "no executable in the row", report: runtime(undefined), failures: 1 },
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
    ];
    for (const { name, report, failures } of rows) {
      // The spelling judgment is the smoke's own (realpath on the runner); here the paths are fixtures.
      const got = compiledHealthFailures(report, BINARY, (a, b) => a.split("/").at(-1) === b);
      if (typeof failures === "number") expect(got, name).toHaveLength(failures);
      else expect(got, name).toEqual(failures);
    }
  });
});
