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
    // The platform's own code for a lookup at a file: Windows reports it as not found.
    const underFile = Deno.build.os === "windows" ? /ENOENT/ : /ENOTDIR/;
    expect(() => facade.rmdir(join(home, "child.txt"))).toThrow(underFile);
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

test("under the plan collector a store landed twice, the second restoring the disk bytes, prints unchanged; a secret declaration outlives a planned deletion; a table with an empty table below it is not absent", async () => {
  dir = tempDir("copilot-bridge-");
  const store = join(dir, "state.json");
  const text = `{\n  "port": 4141\n}\n`;
  writeFileSync(store, text);
  const a = join(dir, "a.json");
  const b = join(dir, "b.json");
  const config = join(dir, "config.toml");
  const grown = join(dir, "grown.toml");
  writeFileSync(config, "[a]\n");
  writeFileSync(grown, "[a]\n");
  const { files } = await collectDryRun(() => {
    const state = new CopilotApiConfig(store);
    state.update((d) => {
      d.lastEnsureAt = 1;
    });
    state.update((d) => {
      delete d.lastEnsureAt;
    });
    facade.writeText(a, '{"token":"x"}\n', { secret: true });
    facade.rm(a);
    facade.writeText(a, '{"token":"x"}\n');
    facade.copyFile(a, b);
    facade.writeText(b, "{}\n", { secretKeys: [] });
    facade.writeText(config, "[a.b]\n", { secretKeys: [] });
    facade.writeText(grown, "[a]\n[a.b]\n", { secretKeys: [] });
    return Promise.resolve();
  });
  expect(renderDryRun(files)).toEqual([
    `unchanged ${store}`,
    `create ${a}`,
    `create ${b}`,
    `rewrite ${config}`,
    `  - [a]`,
    `  + [a.b]`,
    `rewrite ${grown}`,
    `  + [a.b]`,
  ]);
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

test("a dropped empty TOML table is a row, while a JSON map kept, gained, emptied slot by slot, or dropped prints no row of its own", async () => {
  dir = tempDir("copilot-bridge-");
  const config = join(dir, "config.toml");
  const store = join(dir, "state.json");
  const kept = join(dir, "kept.json");
  const gained = join(dir, "gained.json");
  const dropped = join(dir, "dropped.json");
  writeFileSync(
    config,
    '[model_providers.copilot-env]\nbase_url = "https://x"\nhttp_headers = {}\n',
  );
  writeFileSync(store, '{"profiles":{"work":{"githubToken":"t"}}}\n');
  writeFileSync(kept, '{"count":1,"profiles":{}}\n');
  writeFileSync(gained, '{"count":1}\n');
  writeFileSync(dropped, '{"count":1,"profiles":{}}\n');
  const { files } = await collectDryRun(() => {
    facade.writeText(config, '[model_providers.copilot-env]\nbase_url = "https://x"\n', {
      secretKeys: [],
    });
    facade.writeText(store, '{"profiles":{}}\n', { secretKeys: ["profiles.work.githubToken"] });
    facade.writeText(kept, '{"count":2,"profiles":{}}\n', { secretKeys: [] });
    facade.writeText(gained, '{"count":1,"profiles":{}}\n', { secretKeys: [] });
    facade.writeText(dropped, '{"count":1}\n', { secretKeys: [] });
    return Promise.resolve();
  });
  expect(renderDryRun(files)).toEqual([
    `rewrite ${config}`,
    `  model_providers.copilot-env.http_headers  {} -> (absent)`,
    `rewrite ${store}`,
    `  profiles.work.githubToken  <redacted> -> (absent)`,
    `rewrite ${kept}`,
    `  count  1 -> 2`,
    `rewrite ${gained}`,
    `  (every managed attribute already holds its value)`,
    `rewrite ${dropped}`,
    `  (every managed attribute already holds its value)`,
  ]);
});

test("under the plan collector a moved or copied secret keeps its declaration through a later document write, a copied binary keeps its bytes, and a missing source is rename's ENOENT", async () => {
  dir = tempDir("copilot-bridge-");
  const bundle = join(dir, "bundle.json");
  const copy = join(dir, "copy.json");
  const moved = join(dir, "moved.json");
  const keyed = join(dir, "keyed.json");
  const keyedCopy = join(dir, "keyed-copy.json");
  const binary = join(dir, "tool.bin");
  const binaryCopy = join(dir, "tool-copy.bin");
  const blob = join(dir, "blob.bin");
  writeFileSync(binary, new Uint8Array([202, 254, 186, 190]));
  const { files } = await collectDryRun(() => {
    facade.writeText(bundle, '{"token":"example-token"}\n', { secret: true });
    facade.copyFile(bundle, copy);
    facade.rename(bundle, moved);
    // A later write of the copy or the moved file, declared or not, prints no value of the old
    // text.
    writeFileReported(copy, "plain\n");
    facade.writeText(moved, '{"x":1}\n', { secretKeys: [] });
    // Declared keys travel too: a later document write of the copy redacts them, and a later
    // undeclared write prints no line of either text.
    facade.writeText(keyed, '{"token":"t","n":1}\n', { secretKeys: ["token"] });
    facade.copyFile(keyed, keyedCopy);
    facade.writeText(keyedCopy, '{"n":2}\n', { secretKeys: [] });
    facade.copyFile(keyed, join(dir, "keyed-plain.json"));
    writeFileReported(join(dir, "keyed-plain.json"), '{"token":"t","n":3}\n');
    // An earlier plain write of the destination does not bring its text back into the diff, and an
    // earlier declared write's rows do not print beneath a later whole-file secret.
    const early = join(dir, "early.json");
    facade.writeText(early, "{}\n");
    facade.copyFile(keyed, early);
    writeFileReported(early, '{"token":"t","n":4}\n');
    const late = join(dir, "late.json");
    facade.writeText(late, '{"token":"t"}\n', { secretKeys: [] });
    facade.writeText(late, '{"token":"t"}\n', { secret: true });
    // Carried declarations govern rows the destination already has: a copy carrying a key
    // redacts the earlier row, a moved whole-file secret silences it.
    const carriedOnto = join(dir, "carried-onto.json");
    facade.writeText(carriedOnto, '{"token":"t"}\n', { secretKeys: [] });
    facade.copyFile(keyed, carriedOnto);
    const movedOnto = join(dir, "moved-onto.json");
    facade.writeText(movedOnto, '{"token":"t"}\n', { secretKeys: [] });
    facade.writeText(join(dir, "whole.json"), '{"token":"t"}\n', { secret: true });
    facade.rename(join(dir, "whole.json"), movedOnto);
    // A later declaration redacts a row an earlier write printed in the clear, and a path with
    // declared keys and no rows prints no line diff (its lines would carry the values).
    const later = join(dir, "later.json");
    writeFileSync(later, '{"token":"t"}\n');
    facade.writeText(later, '{"n":1}\n', { secretKeys: [] });
    facade.writeText(later, '{"n":2}\n', { secretKeys: ["token"] });
    const emptied = join(dir, "emptied.json");
    writeFileSync(emptied, '{"token":"t"}\n');
    facade.writeText(emptied, '{"token":"t"}\n');
    facade.copyFile(keyed, emptied);
    facade.writeText(emptied, '{"token":"t","n":1}\n', { secretKeys: [] });
    // Planned bytes decode as node decodes a file: a byte-order mark stays.
    facade.writeBytes(join(dir, "bom.txt"), new Uint8Array([239, 187, 191, 97]));
    expect(facade.readText(join(dir, "bom.txt"))).toBe("\uFEFFa");
    facade.copyFile(binary, binaryCopy);
    expect(facade.readBytes(binaryCopy)).toEqual(new Uint8Array([202, 254, 186, 190]));
    expect(() => facade.rename(join(dir, "missing"), join(dir, "elsewhere"))).toThrow(/ENOENT/);
    facade.writeBytes(blob, new Uint8Array([0, 255, 128]));
    const scratch = facade.scratchDir(join(dir, "scratch-"));
    facade.copyFile(blob, join(scratch, "blob.bin"));
    expect(new Uint8Array(readFileSync(join(scratch, "blob.bin")))).toEqual(
      new Uint8Array([0, 255, 128]),
    );
    facade.removeScratchDir(scratch);
    return Promise.resolve();
  });
  expect(renderDryRun(files)).toEqual([
    `create ${copy}`,
    `create ${moved}`,
    `create ${keyed}`,
    `  token  (absent) -> <redacted>`,
    `  n  (absent) -> 1`,
    `create ${keyedCopy}`,
    `  token  <redacted> -> (absent)`,
    `  n  1 -> 2`,
    `create ${join(dir, "keyed-plain.json")}`,
    `create ${join(dir, "early.json")}`,
    `create ${join(dir, "late.json")}`,
    `create ${join(dir, "carried-onto.json")}`,
    `  token  (absent) -> <redacted>`,
    `create ${join(dir, "moved-onto.json")}`,
    `rewrite ${join(dir, "later.json")}`,
    `  token  <redacted> -> (absent)`,
    `  n  (absent) -> 2`,
    `rewrite ${join(dir, "emptied.json")}`,
    `  (every managed attribute already holds its value)`,
    `create ${join(dir, "bom.txt")}`,
    `create ${binaryCopy}`,
    `create ${blob}`,
  ]);
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
    // A probe's scratch copy of a planned file gets the planned bytes, for real.
    facade.writeText(join(dir, "seed.toml"), 'model = "planned"\n', { atomic: false });
    facade.copyFile(join(dir, "seed.toml"), join(scratch, "config.toml"));
    expect(readFileSync(join(scratch, "config.toml"), "utf8")).toBe('model = "planned"\n');
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
    `create ${join(dir, "seed.toml")}`,
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
    expect(() => facade.writeText(join(swapped, "under"), "x", { atomic: false })).toThrow(
      Deno.build.os === "windows" ? /ENOENT/ : /ENOTDIR/,
    );
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

test("under the plan collector a stale staging file at the link's staging path is planned removed before the link", async () => {
  dir = tempDir("copilot-bridge-");
  const link = join(dir, "current");
  const staging = join(dir, `.current-next-${process.pid}`);
  writeFileSync(staging, "left by a crashed run");
  const { files } = await collectDryRun(() => {
    facade.atomicSymlink("versions/v1", link);
    return Promise.resolve();
  });
  expect(files.map((f) => `${f.verdict} ${f.path}`)).toEqual([
    `delete ${staging}`,
    `create ${link}`,
  ]);
  expect(readFileSync(staging, "utf8")).toBe("left by a crashed run");
});

test("a symlink never replaces: a disk entry or a planned file at the path is EEXIST under the collector as for real, and a fresh path records a create", async () => {
  dir = tempDir("copilot-bridge-");
  const onDisk = join(dir, "on-disk");
  const plannedFile = join(dir, "planned");
  const fresh = join(dir, "fresh");
  writeFileSync(onDisk, "kept");
  const exists = /EEXIST: file already exists, symlink/;
  const { files } = await collectDryRun(() => {
    facade.writeText(plannedFile, "x");
    expect(() => facade.symlink("target", onDisk)).toThrow(exists);
    expect(() => facade.symlink("target", plannedFile)).toThrow(exists);
    facade.symlink("target", fresh);
    return Promise.resolve();
  });
  expect(files.map((f) => `${f.verdict} ${f.path}`)).toEqual([
    `create ${plannedFile}`,
    `create ${fresh}`,
  ]);
  expect([readFileSync(onDisk, "utf8"), facade.exists(fresh)]).toEqual(["kept", false]);
  // The real call refuses with the same code (its message is the runtime's own spelling).
  if (Deno.build.os !== "windows") {
    let code = "ok";
    try {
      facade.symlink("target", onDisk);
    } catch (e) {
      code = (e as NodeJS.ErrnoException).code ?? "";
    }
    expect([code, readFileSync(onDisk, "utf8")]).toEqual(["EEXIST", "kept"]);
  }
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
    // by its parent, removable, and re-creatable after a planned deletion; a byte write reads back.
    const blob = join(dir, "blob.bin");
    facade.writeBytes(blob, new Uint8Array([1, 2, 3]));
    expect([facade.exists(blob), facade.stat(blob).isFile(), facade.readdir(dir)]).toEqual([
      true,
      true,
      ["blob.bin", "made", "other", "seed.txt"],
    ]);
    expect([facade.readBytes(blob), facade.stat(blob).size]).toEqual([
      new Uint8Array([1, 2, 3]),
      3,
    ]);
    facade.rename(blob, join(dir, "moved.bin"));
    expect(facade.readBytes(join(dir, "moved.bin"))).toEqual(new Uint8Array([1, 2, 3]));
    facade.rm(join(dir, "moved.bin"));
    facade.writeBytes(blob, new Uint8Array([1, 2, 3]));
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
