import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { INSTALLER_PINS } from "../.github/scripts/release-assets.ts";
import { compiledHealthFailures } from "../.github/scripts/installer-smoke.ts";
import {
  BUNDLED_ONLY_ASSETS,
  LEGACY_ARTIFACTS,
  MATERIALIZED_ASSET_DIRS,
  MATERIALIZED_ASSET_FILES,
} from "../src/install/installer.ts";
import { RELEASE_TARGETS } from "../src/install/targets.ts";
import { ROOT } from "./helpers/run.ts";
import { describe, expect, test } from "./helpers/testing.ts";

// The installers hand-roll lists that TypeScript modules own, and nothing at
// runtime ties them together: shell cannot import TS. Each guard below parses
// a list back out of the script text and pins it to its TS source of truth, so
// a drift fails at PR time instead of at release time or, worse, as a silently
// broken install.
//
// scripts/compile.ts needs no such guard for its target list: it imports
// RELEASE_TARGETS directly, so that drift is impossible by construction.

const installSh = readFileSync(join(ROOT, "install.sh"), "utf8");
const installPs1 = readFileSync(join(ROOT, "install.ps1"), "utf8");
const compileTs = readFileSync(join(ROOT, "scripts", "compile.ts"), "utf8");

describe("release-assets.ts pin needles", () => {
  // The release pipeline rewrites a handful of installer lines to the release
  // tag by byte-exact needle. Nothing runs that script at PR time, so without
  // this guard a cosmetic reformat of those lines merges green and then breaks
  // the main-branch release with "placeholder not found".
  test("match install.sh byte-for-byte", () => {
    for (const { needle } of INSTALLER_PINS["install.sh"]) {
      expect(installSh).toContain(needle);
    }
  });

  test("match install.ps1 byte-for-byte", () => {
    for (const { needle } of INSTALLER_PINS["install.ps1"]) {
      expect(installPs1).toContain(needle);
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
  // scripts/compile.ts builds RELEASE_TARGETS by importing it; the installers
  // decide which binary to download on a given machine and cannot import TS. A
  // platform mapped onto a triple outside the list is an install that 404s.
  const triples = RELEASE_TARGETS.map((t) => t.triple).sort();

  test("install.sh maps its platforms onto RELEASE_TARGETS triples", () => {
    const mapped = [...installSh.matchAll(/TARGET="([a-z0-9_-]+)"/g)].map((m) => m[1] ?? "");
    expect(mapped.length).toBeGreaterThan(0);
    for (const triple of mapped) {
      expect(triples).toContain(triple);
    }
    // Every non-Windows target must be reachable from install.sh.
    for (const target of RELEASE_TARGETS.filter((t) => t.os !== "win32")) {
      expect(mapped).toContain(target.triple);
    }
  });

  test("install.ps1 maps Windows onto a RELEASE_TARGETS triple", () => {
    const mapped = [...installPs1.matchAll(/return '([a-z0-9_-]+)'/g)].map((m) => m[1] ?? "");
    for (const target of RELEASE_TARGETS.filter((t) => t.os === "win32")) {
      expect(mapped).toContain(target.triple);
    }
  });
});

describe("compile.include matches what the binary actually needs", () => {
  // Three fates, one embed list. MATERIALIZED_* is written to the install root
  // because something outside this process opens it by path (the shim DIRS, and
  // the individual FILES their imports reach); BUNDLED_ONLY_* is read in-process
  // through ASSET_ROOT and must never be written. All have to be embedded, and
  // nothing else should be: an entry with no fate is dead weight in all five
  // binaries, and a fate with no entry is a file that is missing exactly when it
  // is first needed.
  //
  // The list lives in deno.json rather than in scripts/compile.ts on purpose:
  // a CLI --include MERGES with the config's list instead of replacing it, so
  // a second copy in the script would silently union rather than fail.
  const compileInclude: string[] = JSON.parse(
    readFileSync(join(ROOT, "deno.json"), "utf8"),
  ).compile?.include ?? [];
  const needed = [...MATERIALIZED_ASSET_DIRS, ...MATERIALIZED_ASSET_FILES, ...BUNDLED_ONLY_ASSETS];

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
});

describe("the materialized files are the shims' import closure", () => {
  // The daemon shims in src/scripts run on real disk in the install root, so
  // every LOCAL file their imports reach (transitively) must be materialized
  // beside them or the daemon dies at module load -- exactly the failure a new
  // shim import would silently reintroduce. This computes the closure from the
  // sources and pins MATERIALIZED_ASSET_FILES to it in both directions: a
  // missing file is a broken daemon on every install, an extra one is dead
  // weight nothing imports.
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

  test("negative control: the closure walk actually follows imports", () => {
    // A closure of only the seeds would mean the regex matched nothing and the
    // pin above was comparing empty sets of "outside" files by accident.
    const closure = localImportClosure(["src/scripts/daemon_runtime_preload.ts"]);
    expect(closure.size).toBeGreaterThan(1);
    expect(closure.has("src/copilot_api/config.ts")).toBe(true);
  });
});

describe("installers and the installer share one artifact list", () => {
  // install.sh / install.ps1 sweep the superseded source-install artifacts
  // before handing off, and `agent install` sweeps them again after. Both
  // lists have to name the same things or one of them leaves debris.
  const expected = [...LEGACY_ARTIFACTS].sort();

  test("install.sh LEGACY_ARTIFACTS matches", () => {
    const list = installSh.match(/^LEGACY_ARTIFACTS="([^"]*)"/m)?.[1] ?? "";
    expect(list.split(/\s+/).filter(Boolean).sort()).toEqual(expected);
  });

  test("install.ps1 $LegacyArtifacts matches", () => {
    const body = installPs1.match(/\$LegacyArtifacts = @\(([^)]*)\)/)?.[1] ?? "";
    const names = [...body.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? "").sort();
    expect(names).toEqual(expected);
  });
});

describe("the install task spawns what it is allowed to run", () => {
  // `deno task install` (scripts/install_local.ts) compiles the host binary
  // and hands off to the platform installer. The task's --allow-run list and
  // the script's spawn set are two hand-kept spellings of the same contract; a
  // drift is a permission prompt (or hard denial) at run time.
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
  // The CI smoke's compiledHealthFailures must treat a missing row, a reshaped
  // value, or an unexpected status/kind as a failure: optional-chaining past a
  // renamed check id would print success while asserting nothing.
  const good = () => ({
    checks: [
      { id: "bootstrap.nodeModules", status: "ok", value: { embedded: true } },
      { id: "proxy.package", status: "ok", value: {} },
      { id: "proxy.sidecar", status: "ok", value: { kind: "absent" } },
    ],
  });

  test("a healthy compiled report passes (provisioned or absent sidecar)", () => {
    expect(compiledHealthFailures(good())).toEqual([]);
    const provisioned = good();
    provisioned.checks[2] = { id: "proxy.sidecar", status: "ok", value: { kind: "provisioned" } };
    expect(compiledHealthFailures(provisioned)).toEqual([]);
  });

  test("negative controls: dev/unknown sidecar kind, non-ok package, non-embedded deps", () => {
    for (const kind of ["dev", "future-kind"]) {
      const bad = good();
      bad.checks[2] = { id: "proxy.sidecar", status: "ok", value: { kind } };
      expect(compiledHealthFailures(bad)).toHaveLength(1);
    }
    for (const status of ["fail", "warn", undefined] as const) {
      const bad = good();
      bad.checks[1] = { id: "proxy.package", status: status as string, value: {} };
      expect(compiledHealthFailures(bad)).toHaveLength(1);
    }
    const deps = good();
    deps.checks[0] = { id: "bootstrap.nodeModules", status: "fail", value: {} };
    expect(compiledHealthFailures(deps)).toHaveLength(1);
  });

  test("negative controls: missing rows, reshaped values, and non-report JSON all fail", () => {
    expect(compiledHealthFailures({ checks: [] })).toHaveLength(3);
    expect(compiledHealthFailures({})).toEqual(["health --json did not produce a checks array"]);
    expect(compiledHealthFailures(null)).toHaveLength(1);
    const reshaped = good();
    reshaped.checks[2] = { id: "proxy.sidecar", status: "ok", value: {} as { kind: string } };
    expect(compiledHealthFailures(reshaped)).toHaveLength(1);
  });
});
