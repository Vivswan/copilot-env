// The transition bridge (src/utils/fs_disk.ts, fs_facade.ts): while `--dry-run` still runs under
// the plan collector, a writer already on the facade previews exactly as one still on the wrappers,
// and reads back what it planned. This file goes with write_session.ts.
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderDryRun } from "../src/agents/write_plan.ts";
import { CopilotApiConfig } from "../src/copilot_api/config.ts";
import * as facade from "../src/utils/fs_facade.ts";
import { removeEmptyDirReported } from "../src/utils/report_write.ts";
import { collectDryRun } from "../src/utils/write_session.ts";
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
    // The fresh directory is a directory to a write, hides the disk under a sub-directory it
    // grows, and shows a byte write it takes.
    expect(() => facade.writeText(root, "x", { atomic: false })).toThrow(/EISDIR/);
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
  ]);
  expect(readFileSync(join(root, "stale.txt"), "utf8")).toBe("old");
});

test("under the plan collector a facade read answers from the plan: a planned write reads back, a planned delete reads as absent, a planned directory lists", async () => {
  dir = tempDir("copilot-bridge-");
  const file = join(dir, "f.txt");
  const made = join(dir, "made", "deep");
  writeFileSync(file, "disk");
  mkdirSync(join(dir, "other"));
  await collectDryRun(() => {
    expect(facade.dryRunActive()).toBe(true);
    facade.writeText(file, "planned", { atomic: false });
    expect([
      facade.readText(file),
      facade.readTextResult(file),
      facade.stat(file).size,
      facade.readdir(dir),
    ]).toEqual([
      "planned",
      { kind: "text", text: "planned" },
      7,
      ["f.txt", "other"],
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
      ["made", "other"],
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
      ["blob.bin", "made", "other"],
    ]);
    expect([facade.rm(blob, { force: true }), facade.exists(blob)]).toEqual([true, false]);
    facade.copyFile(join(dir, "other"), blob);
    expect(facade.exists(blob)).toBe(true);
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
