// The transition bridge (src/utils/fs_disk.ts, fs_facade.ts): while `--dry-run` still runs under
// the plan collector, a writer already on the facade previews exactly as one still on the wrappers,
// and reads back what it planned. This file goes with write_session.ts.
import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderDryRun } from "../src/agents/write_plan.ts";
import { CopilotApiConfig } from "../src/copilot_api/config.ts";
import * as facade from "../src/utils/fs_facade.ts";
import { removeEmptyDirReported, writeFileReported } from "../src/utils/report_write.ts";
import { collectDryRun, filePlan, landPlan } from "../src/utils/write_session.ts";
import { afterEach, expect, removeDir, tempDir, test } from "./helpers/testing.ts";

let dir = "";
afterEach(() => {
  dir = removeDir(dir);
});

test("under the plan collector a facade write lands the rows the store's own plan lands, secrets redacted, and touches nothing", async () => {
  dir = tempDir("copilot-bridge-");
  const store = join(dir, "state.json");
  const before = `{\n  "global": {\n    "daemon.port": 4141,\n    "githubToken": "old"\n  }\n}\n`;
  const after = `{\n  "global": {\n    "daemon.port": 4242,\n    "githubToken": "new"\n  }\n}\n`;
  writeFileSync(store, before);
  const { files: viaStore } = await collectDryRun(() => {
    new CopilotApiConfig(store).update((doc) => {
      doc.global = { "daemon.port": 4242, githubToken: "new" };
    });
    return Promise.resolve();
  });
  const { files: viaFacade } = await collectDryRun(() => {
    facade.writeText(store, after, { mode: 0o600, secretKeys: ["global.githubToken"] });
    return Promise.resolve();
  });
  const lines = renderDryRun(viaFacade);
  expect(lines).toEqual(renderDryRun(viaStore));
  expect(lines).toEqual([
    `rewrite ${store}`,
    `  global."daemon.port"  4141 -> 4242`,
    `  global.githubToken  <redacted> -> <redacted>`,
  ]);
  expect(readFileSync(store, "utf8")).toBe(before);
});

test("under the plan collector a declared secret never prints, a blank file before it included", async () => {
  dir = tempDir("copilot-bridge-");
  const blank = join(dir, "settings.json");
  writeFileSync(blank, "");
  const { files } = await collectDryRun(() => {
    facade.writeText(blank, '{"env":{"ANTHROPIC_AUTH_TOKEN":"example-token"}}\n', {
      secretKeys: ["env.ANTHROPIC_AUTH_TOKEN"],
    });
    return Promise.resolve();
  });
  expect(renderDryRun(files)).toEqual([
    `rewrite ${blank}`,
    `  env.ANTHROPIC_AUTH_TOKEN  (absent) -> <redacted>`,
  ]);
});

test("under the plan collector a file the run created and removed prints nothing, and a planned chmod or explicit mode shows in stat", async () => {
  dir = tempDir("copilot-bridge-");
  const backup = join(dir, "backup.json");
  const helper = join(dir, "helper.sh");
  const fresh = join(dir, "fresh.sh");
  writeFileSync(helper, "#!/bin/sh\n");
  chmodSync(helper, 0o644);
  const { files } = await collectDryRun(() => {
    facade.writeText(backup, "{}");
    expect(facade.exists(backup)).toBe(true);
    expect(facade.rm(backup, { force: true })).toBe(true);
    facade.chmod(helper, 0o755);
    facade.writeText(fresh, "#!/bin/sh\n", { mode: 0o700 });
    if (Deno.build.os !== "windows") {
      expect([facade.stat(helper).mode & 0o777, facade.stat(fresh).mode & 0o777]).toEqual([
        0o755,
        0o700,
      ]);
    }
    return Promise.resolve();
  });
  expect(renderDryRun(files)).toEqual([`rewrite ${helper}`, `create ${fresh}`, `  + #!/bin/sh`]);
  if (Deno.build.os !== "windows") expect(statSync(helper).mode & 0o777).toBe(0o644);
});

test("under the plan collector a planned directory takes rm's and rmdir's own refusals, a chmod keeps planned text, and an unparsed document with declared secrets prints its path alone", async () => {
  dir = tempDir("copilot-bridge-");
  const home = join(dir, "home");
  const settings = join(dir, "settings.json");
  writeFileSync(settings, "{broken");
  const { files } = await collectDryRun(() => {
    facade.mkdir(home);
    expect(() => facade.rm(home)).toThrow(/EISDIR/);
    facade.writeText(join(home, "child.txt"), "planned", { atomic: false });
    expect(() => facade.rmdir(home)).toThrow(/ENOTEMPTY/);
    expect(() => facade.rmdir(join(home, "child.txt"))).toThrow(/ENOTDIR/);
    facade.chmod(join(home, "child.txt"), 0o600);
    expect(facade.readText(join(home, "child.txt"))).toBe("planned");
    facade.rm(join(home, "child.txt"));
    facade.rmdir(home);
    expect([facade.exists(home), facade.readdir(dir)]).toEqual([false, ["settings.json"]]);
    facade.writeText(settings, '{"env":{"TOKEN":"example-secret"}}\n', {
      secretKeys: ["env.TOKEN"],
    });
    return Promise.resolve();
  });
  expect(renderDryRun(files)).toEqual([`rewrite ${settings}`]);
});

test("under the plan collector a same-content document write with declared secrets prints unchanged alone", async () => {
  dir = tempDir("copilot-bridge-");
  const settings = join(dir, "settings.json");
  const text = '{\n  "env": {\n    "ANTHROPIC_AUTH_TOKEN": "example-token"\n  }\n}\n';
  writeFileSync(settings, text);
  const { files } = await collectDryRun(() => {
    facade.writeText(settings, text, { secretKeys: ["env.ANTHROPIC_AUTH_TOKEN"] });
    return Promise.resolve();
  });
  expect(renderDryRun(files)).toEqual([`unchanged ${settings}`]);
});

test("under the plan collector a copy prints the wrapper's row and folds with a later write as main did, and a dangling link is a rewrite", async () => {
  dir = tempDir("copilot-bridge-");
  const source = join(dir, "source.txt");
  const dst = join(dir, "dst.txt");
  const dangling = join(dir, "settings.json");
  writeFileSync(source, "copied\n");
  if (Deno.build.os !== "windows") symlinkSync(join(dir, "nowhere.json"), dangling);
  const { files } = await collectDryRun(() => {
    facade.copyFile(source, dst);
    expect(facade.readText(dst)).toBe("copied\n");
    writeFileReported(dst, "edited\n");
    if (Deno.build.os !== "windows") {
      facade.writeText(dangling, '{"a":1}\n', { secretKeys: [] });
    }
    return Promise.resolve();
  });
  const expected = [`create ${dst}`, `  + edited`];
  if (Deno.build.os !== "windows") expected.push(`rewrite ${dangling}`, `  a  (absent) -> 1`);
  expect(renderDryRun(files)).toEqual(expected);
});

test("under the plan collector a move is planned whole with the source's planned text, a move into scratch leaves the real source, and an in-place write under a removed parent is ENOENT", async () => {
  dir = tempDir("copilot-bridge-");
  const source = join(dir, "source.txt");
  const moved = join(dir, "moved.txt");
  const real = join(dir, "real.txt");
  const parent = join(dir, "parent");
  writeFileSync(source, "old");
  writeFileSync(real, "kept");
  mkdirSync(parent);
  const { files } = await collectDryRun(() => {
    facade.writeText(source, "new", { atomic: false });
    facade.rename(source, moved);
    expect([facade.exists(source), facade.readText(moved)]).toEqual([false, "new"]);
    const scratch = facade.scratchDir(join(dir, "scratch-"));
    facade.rename(real, join(scratch, "taken.txt"));
    expect(facade.exists(real)).toBe(false);
    facade.removeScratchDir(scratch);
    facade.rm(parent, { recursive: true });
    expect(() => facade.writeText(join(parent, "f"), "x", { atomic: false })).toThrow(/ENOENT/);
    return Promise.resolve();
  });
  expect(files.map((f) => `${f.verdict} ${f.path}`)).toEqual([
    `rewrite ${source}`,
    `create ${moved}`,
    `delete ${source}`,
    `delete ${real}`,
    `delete ${parent}`,
  ]);
  expect([readFileSync(source, "utf8"), readFileSync(real, "utf8")]).toEqual(["old", "kept"]);
});

test("under the plan collector a directory removed and made again is fresh and empty, and a removed file's path takes a directory", async () => {
  dir = tempDir("copilot-bridge-");
  const root = join(dir, "version");
  const file = join(dir, "marker");
  mkdirSync(root);
  writeFileSync(join(root, "stale.txt"), "old");
  writeFileSync(file, "a file today");
  const { files } = await collectDryRun(() => {
    facade.rm(root, { recursive: true });
    facade.mkdir(root);
    expect([facade.exists(root), facade.stat(root).isDirectory(), facade.readdir(root)]).toEqual([
      true,
      true,
      [],
    ]);
    expect(facade.exists(join(root, "stale.txt"))).toBe(false);
    // The fresh directory is a directory to a write (the platform's own code: Windows opens a
    // directory for writing with EINVAL), hides the disk under a sub-directory it grows, and shows
    // a byte write it takes.
    expect(() => facade.writeText(root, "x", { atomic: false })).toThrow(
      Deno.build.os === "windows" ? /EINVAL/ : /EISDIR/,
    );
    facade.mkdir(join(root, "sub"));
    expect(facade.readdir(join(root, "sub"))).toEqual([]);
    facade.writeBytes(join(root, "blob"), new Uint8Array([1]));
    expect([facade.exists(join(root, "blob")), facade.readdir(root)]).toEqual([true, [
      "blob",
      "sub",
    ]]);
    facade.rm(join(root, "blob"), { force: true });
    facade.rmdir(join(root, "sub"));
    removeEmptyDirReported(root);
    expect(facade.exists(root)).toBe(false);
    facade.rm(file);
    facade.mkdir(join(file, "deep"));
    expect([facade.readdir(dir), facade.readdir(join(file, "deep"))]).toEqual([
      ["marker"],
      [],
    ]);
    // A planned file is no directory to mkdir under.
    facade.writeText(join(dir, "leaf"), "x");
    expect(() => facade.mkdir(join(dir, "leaf", "child"))).toThrow(/ENOTDIR/);
    // A tree removal spends the landings under it; a byte write over a removed directory is a
    // file; a plan writer's create under a removed directory makes the parent fresh too.
    const nest = join(dir, "nest");
    facade.mkdir(nest);
    facade.writeBytes(join(nest, "b"), new Uint8Array([2]));
    facade.rm(nest, { recursive: true });
    expect(facade.exists(join(nest, "b"))).toBe(false);
    facade.mkdir(nest);
    expect(facade.readdir(nest)).toEqual([]);
    facade.rm(nest, { recursive: true });
    facade.writeBytes(nest, new Uint8Array([3]));
    expect([facade.stat(nest).isFile(), facade.rm(nest, { force: true })]).toEqual([true, true]);
    // A directory replaced by a file is a file to the next write and to a mkdir under it.
    const swapped = join(dir, "swapped");
    mkdirSync(swapped);
    facade.rm(swapped, { recursive: true });
    facade.writeText(swapped, "first", { atomic: false });
    facade.writeText(swapped, "second", { atomic: false });
    expect(() => facade.mkdir(join(swapped, "child"))).toThrow(/ENOTDIR/);
    expect(facade.readText(swapped)).toBe("second");
    const plannerRoot = join(dir, "planned");
    mkdirSync(plannerRoot);
    writeFileSync(join(plannerRoot, "old.txt"), "old");
    facade.rm(plannerRoot, { recursive: true });
    landPlan({
      files: [filePlan(join(plannerRoot, "new.txt"), "create", { before: null, content: "new" })],
      apply() {},
    });
    expect(facade.readdir(plannerRoot)).toEqual(["new.txt"]);
    return Promise.resolve();
  });
  expect(files.map((f) => `${f.verdict} ${f.path}${f.directory ? "/" : ""}`)).toEqual([
    `delete ${root}`,
    `create ${root}/`,
    `create ${join(root, "sub")}/`,
    `create ${join(root, "blob")}`,
    `delete ${join(root, "blob")}`,
    `delete ${join(root, "sub")}`,
    `delete ${root}`,
    `delete ${file}`,
    `create ${file}/`,
    `create ${join(file, "deep")}/`,
    `create ${join(dir, "leaf")}`,
    `create ${join(dir, "nest")}/`,
    `create ${join(dir, "nest", "b")}`,
    `delete ${join(dir, "nest")}`,
    `create ${join(dir, "nest")}/`,
    `delete ${join(dir, "nest")}`,
    `create ${join(dir, "nest")}`,
    `delete ${join(dir, "nest")}`,
    `delete ${join(dir, "swapped")}`,
    `create ${join(dir, "swapped")}`,
    `rewrite ${join(dir, "swapped")}`,
    `delete ${join(dir, "planned")}`,
    `create ${join(dir, "planned")}/`,
    `create ${join(dir, "planned", "new.txt")}`,
  ]);
  expect(readFileSync(join(root, "stale.txt"), "utf8")).toBe("old");
});

test("under the plan collector a facade read answers from the plan: a planned write reads back, a planned delete reads as absent, a planned directory lists", async () => {
  dir = tempDir("copilot-bridge-");
  const file = join(dir, "f.txt");
  const made = join(dir, "made", "deep");
  writeFileSync(file, "disk");
  writeFileSync(join(dir, "seed.txt"), "seed");
  mkdirSync(join(dir, "other"));
  await collectDryRun(() => {
    expect(facade.dryRunActive()).toBe(true);
    facade.writeText(file, "planned", { atomic: false });
    expect([
      facade.readText(file),
      facade.readTextResult(file),
      facade.stat(file).size,
      facade.readdir(dir),
    ])
      .toEqual([
        "planned",
        { kind: "text", text: "planned" },
        7,
        ["f.txt", "other", "seed.txt"],
      ]);
    facade.mkdir(made);
    expect([facade.exists(made), facade.stat(made).isDirectory(), facade.readdir(made)]).toEqual([
      true,
      true,
      [],
    ]);
    facade.rm(file, { force: true });
    expect([facade.exists(file), facade.readdir(dir), facade.readTextResult(file)]).toEqual([
      false,
      ["made", "other", "seed.txt"],
      { kind: "absent" },
    ]);
    expect(() => facade.readText(file)).toThrow(/ENOENT/);
    // A planned file whose bytes the plan does not carry is still present to a later read, listed
    // by its parent, removable, and re-creatable after a planned deletion.
    const blob = join(dir, "blob.bin");
    facade.writeBytes(blob, new Uint8Array([1, 2, 3]));
    expect([facade.exists(blob), facade.stat(blob).isFile(), facade.readdir(dir)]).toEqual([
      true,
      true,
      ["blob.bin", "made", "other", "seed.txt"],
    ]);
    expect([facade.rm(blob, { force: true }), facade.exists(blob)]).toEqual([true, false]);
    // A copy carries the source's text to the run's later readers.
    facade.copyFile(join(dir, "seed.txt"), blob);
    expect([facade.exists(blob), facade.readText(blob)]).toEqual([true, "seed"]);
    // A chmod on a directory the disk holds keeps it a directory.
    facade.chmod(join(dir, "other"), 0o700);
    expect([facade.stat(join(dir, "other")).isDirectory(), facade.readdir(join(dir, "other"))])
      .toEqual([true, []]);
    facade.rmdir(made);
    expect(facade.exists(made)).toBe(false);
    return Promise.resolve();
  });
  expect([readFileSync(file, "utf8"), facade.exists(made), facade.dryRunActive()]).toEqual([
    "disk",
    false,
    false,
  ]);
});
