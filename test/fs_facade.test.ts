// The dry-run filesystem: a run reads what it planned (the disk is untouched), a planned delete is
// invisible to every read, the errors the planned state determines carry the platform's own node:fs
// codes, and the report is a tree diff of the overlay against the disk in the one print format.
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, sep } from "node:path";
import { withDryRun } from "../src/utils/dry_run.ts";
import { renderDryRun } from "../src/utils/dry_run_report.ts";
import * as facade from "../src/utils/fs_facade.ts";
import { afterEach, expect, removeDir, tempDir, test } from "./helpers/testing.ts";

let dir = "";
afterEach(() => {
  dir = removeDir(dir);
});

const WINDOWS = Deno.build.os === "windows";

/** The thrown code (or the error's name when it carries none), or "ok": the shape both modes are
 *  compared in. */
function outcome(fn: () => unknown): string {
  try {
    fn();
    return "ok";
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return err.code ?? err.name;
  }
}

async function dryRun(body: () => void): Promise<string[]> {
  const run = await withDryRun(async () => body());
  if (run.status === "failed") throw run.error;
  return renderDryRun(run.changes);
}

const modeOf = (path: string): string =>
  (lstatSync(path).mode & 0o777).toString(8).padStart(4, "0");

test("a dry run reads its own writes and deletes back, and the disk keeps what it had", async () => {
  dir = tempDir("copilot-facade-");
  const a = join(dir, "a.txt");
  const b = join(dir, "b.txt");
  writeFileSync(a, "old");
  writeFileSync(b, "doomed");
  expect(facade.dryRunActive()).toBe(false);
  const run = await withDryRun(async () => {
    facade.writeText(a, "new");
    facade.rm(b);
    facade.writeText(join(dir, "c.txt"), "fresh");
    return {
      active: facade.dryRunActive(),
      a: facade.readText(a),
      size: facade.stat(a).size,
      bExists: facade.exists(b),
      bStat: outcome(() => facade.lstat(b)),
      listing: facade.readdir(dir),
    };
  });
  expect(run.status).toBe("done");
  if (run.status !== "done") return;
  expect(run.result).toEqual({
    active: true,
    a: "new",
    size: 3,
    bExists: false,
    bStat: "ENOENT",
    listing: ["a.txt", "c.txt"],
  });
  expect(facade.dryRunActive()).toBe(false);
  expect([
    readFileSync(a, "utf8"),
    readFileSync(b, "utf8"),
    outcome(() => lstatSync(join(dir, "c.txt"))),
  ]).toEqual(["old", "doomed", "ENOENT"]);
  expect(renderDryRun(run.changes)).toEqual([
    `rewrite ${a}`,
    `  - old`,
    `  + new`,
    `delete ${b}`,
    `create ${join(dir, "c.txt")}`,
    `  + fresh`,
  ]);
});

// Each case starts from the same pre-state, built on the disk for the real run and through the
// facade inside the dry run, so the code the overlay derives from planned state is checked against
// the code this platform's node:fs raises for the state itself.
const ERROR_CASES: Array<{
  name: string;
  setup: (root: string) => void;
  op: (root: string) => unknown;
  code: string;
  /** The code Windows' own node:fs raises for the same state, when it differs. */
  win32?: string;
  /** A state Windows cannot build without a privilege the runner lacks (a symlink). */
  posixOnly?: boolean;
}> = [
  {
    name: "write onto a directory",
    setup: (r) => facade.mkdir(join(r, "d")),
    op: (r) => facade.writeText(join(r, "d"), "x", { atomic: false }),
    code: "EISDIR",
    win32: "EINVAL",
  },
  {
    name: "staged write onto a directory",
    setup: (r) => facade.mkdir(join(r, "d")),
    op: (r) => facade.writeText(join(r, "d"), "x", { atomic: true }),
    code: "EISDIR",
    // Windows refuses the rename with EPERM, which the staged writer wraps for the installer.
    win32: "RenameRefusedError",
  },
  {
    name: "mkdir under a file",
    setup: (r) => facade.writeText(join(r, "f"), "x"),
    op: (r) => facade.mkdir(join(r, "f", "sub")),
    code: "ENOTDIR",
  },
  {
    name: "mkdir over a file",
    setup: (r) => facade.writeText(join(r, "f"), "x"),
    op: (r) => facade.mkdir(join(r, "f")),
    code: "EEXIST",
  },
  {
    name: "rm of a path already removed",
    setup: (r) => {
      facade.writeText(join(r, "f"), "x");
      facade.rm(join(r, "f"));
    },
    op: (r) => facade.rm(join(r, "f")),
    code: "ENOENT",
  },
  {
    name: "rm of a directory without recursive",
    setup: (r) => facade.mkdir(join(r, "d")),
    op: (r) => facade.rm(join(r, "d")),
    code: "ERR_FS_EISDIR",
  },
  {
    name: "readdir of a file",
    setup: (r) => facade.writeText(join(r, "f"), "x"),
    op: (r) => facade.readdir(join(r, "f")),
    code: "ENOTDIR",
  },
  {
    name: "read under a file",
    setup: (r) => facade.writeText(join(r, "f"), "x"),
    op: (r) => facade.readText(join(r, "f", "x")),
    code: "ENOTDIR",
    win32: "ENOENT",
  },
  {
    name: "write under a missing directory",
    setup: () => {},
    op: (r) => facade.writeText(join(r, "nope", "f"), "x", { atomic: false }),
    code: "ENOENT",
  },
  {
    name: "rm of a missing path with force",
    setup: () => {},
    op: (r) => facade.rm(join(r, "nope"), { force: true }),
    code: "ok",
  },
  {
    name: "rm under a file",
    setup: (r) => facade.writeText(join(r, "f"), "x"),
    op: (r) => facade.rm(join(r, "f", "child")),
    code: "ENOTDIR",
    win32: "ENOENT",
  },
  {
    name: "rm under a file with force",
    setup: (r) => facade.writeText(join(r, "f"), "x"),
    op: (r) => facade.rm(join(r, "f", "child"), { force: true }),
    code: "ENOTDIR",
    win32: "ok",
  },
  {
    name: "mkdir through a link whose target was removed",
    setup: (r) => {
      facade.mkdir(join(r, "target"));
      symlinkSync(join(r, "target"), join(r, "alias"));
      facade.rm(join(r, "target"), { recursive: true });
    },
    op: (r) => facade.mkdir(join(r, "alias")),
    code: "EEXIST",
    posixOnly: true,
  },
  {
    name: "mkdir under a link whose target was removed",
    setup: (r) => {
      facade.mkdir(join(r, "target"));
      symlinkSync(join(r, "target"), join(r, "alias"));
      facade.rm(join(r, "target"), { recursive: true });
    },
    op: (r) => facade.mkdir(join(r, "alias", "child")),
    code: "EEXIST",
    posixOnly: true,
  },
];

const CASES = ERROR_CASES.filter((c) => !c.posixOnly || !WINDOWS);

test("every error the overlay derives from planned state carries the code this platform's node:fs raises for that state", async () => {
  dir = tempDir("copilot-facade-");
  const real: Record<string, string> = {};
  const planned: Record<string, string> = {};
  for (const [i, c] of CASES.entries()) {
    const root = join(dir, `real-${i}`);
    mkdirSync(root);
    c.setup(root);
    real[c.name] = outcome(() => c.op(root));
  }
  await withDryRun(async () => {
    for (const [i, c] of CASES.entries()) {
      const root = join(dir, `dry-${i}`);
      mkdirSync(root);
      c.setup(root);
      planned[c.name] = outcome(() => c.op(root));
    }
  });
  const expected = Object.fromEntries(
    CASES.map((c) => [c.name, WINDOWS ? c.win32 ?? c.code : c.code]),
  );
  expect(planned).toEqual(expected);
  expect(real).toEqual(expected);
});

test("mkdir -p crosses real and planned ancestors, and the report names only the directories it makes", async () => {
  dir = tempDir("copilot-facade-");
  const real = join(dir, "real");
  mkdirSync(real);
  const deeper = join(real, "planned", "deeper");
  const lines = await dryRun(() => {
    facade.mkdir(deeper);
    facade.mkdir(deeper);
    expect(facade.readdir(real)).toEqual(["planned"]);
    expect(facade.stat(deeper).isDirectory()).toBe(true);
    expect(facade.readdir(deeper)).toEqual([]);
  });
  expect(lines).toEqual([
    `create ${join(real, "planned")}${sep}`,
    `create ${deeper}${sep}`,
  ]);
  expect(outcome(() => lstatSync(join(real, "planned")))).toBe("ENOENT");
});

test("rename moves planned text and whole disk trees by reference, a binary keeps its bytes, and a removed-then-remade directory hides the disk's children", async () => {
  dir = tempDir("copilot-facade-");
  const old = join(dir, "old.toml");
  const renamed = join(dir, "new.toml");
  writeFileSync(old, 'x = "disk"\n');
  const tree = join(dir, "tree");
  mkdirSync(join(tree, "inner"), { recursive: true });
  writeFileSync(join(tree, "inner", "f.txt"), "leaf");
  writeFileSync(join(tree, "top.txt"), "top");
  const moved = join(dir, "moved");
  // Ten bytes that are not UTF-8: decoding them would change their length.
  const blob = join(dir, "sidecar.bin");
  const movedBlob = join(dir, "sidecar-next.bin");
  const bytes = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0xff, 0xfe, 0x00, 0x80, 0xc0, 0x01]);
  writeFileSync(blob, bytes);
  const remade = join(dir, "remade");
  mkdirSync(remade);
  writeFileSync(join(remade, "stale.txt"), "stale");
  const lines = await dryRun(() => {
    facade.writeText(old, 'x = "planned"\n');
    facade.rename(old, renamed);
    facade.rename(tree, moved);
    facade.rename(blob, movedBlob);
    facade.rm(remade, { recursive: true });
    facade.mkdir(remade);
    facade.writeText(join(remade, "kept.txt"), "kept");
    expect([facade.readText(renamed), facade.exists(old)]).toEqual(['x = "planned"\n', false]);
    expect(facade.readdir(join(moved, "inner"))).toEqual(["f.txt"]);
    expect(facade.readText(join(moved, "inner", "f.txt"))).toBe("leaf");
    expect(facade.exists(tree)).toBe(false);
    expect([facade.stat(movedBlob).size, facade.exists(blob)]).toEqual([bytes.length, false]);
    expect(facade.readdir(remade)).toEqual(["kept.txt"]);
    expect(facade.exists(join(remade, "stale.txt"))).toBe(false);
  });
  expect(lines).toEqual([
    `delete ${old}`,
    `create ${renamed}`,
    `  x  (absent) -> "planned"`,
    `delete ${tree}${sep}`,
    `create ${moved}${sep}`,
    `create ${join(moved, "inner")}${sep}`,
    `create ${join(moved, "inner", "f.txt")}`,
    `create ${join(moved, "top.txt")}`,
    `delete ${blob}`,
    `create ${movedBlob}`,
    `unchanged ${remade}${sep}`,
    `delete ${join(remade, "stale.txt")}`,
    `create ${join(remade, "kept.txt")}`,
    `  + kept`,
  ]);
  expect(readFileSync(join(tree, "top.txt"), "utf8")).toBe("top");
  expect(new Uint8Array(readFileSync(blob))).toEqual(bytes);
});

test("a mode-only change is a rewrite with no row where the platform can change a mode; the same bytes written back are unchanged; nothing is nothing", async () => {
  dir = tempDir("copilot-facade-");
  const script = join(dir, "helper.sh");
  const both = join(dir, "both.sh");
  const same = join(dir, "same.txt");
  const staged = join(dir, "staged.txt");
  const restaged = join(dir, "restaged.sh");
  const transient = join(dir, "transient.txt");
  const swap = join(dir, "swap");
  const doc = join(dir, "doc.json");
  writeFileSync(script, "#!/bin/sh\n");
  writeFileSync(both, "old\n");
  writeFileSync(same, "keep");
  writeFileSync(staged, "keep");
  // Pinned away from 0600 so the staged write below is a mode change under any umask.
  chmodSync(staged, 0o644);
  writeFileSync(restaged, "#!/bin/sh\n");
  chmodSync(restaged, 0o755);
  writeFileSync(swap, "a file today");
  mkdirSync(doc);
  // The real run is the witness for what an explicit and a default mode land as on this platform
  // (a file's explicit mode is exact, a directory's and every default have the umask applied;
  // Windows folds every mode to its one read-only bit).
  facade.mkdir(join(dir, "real-d"), { mode: 0o777 });
  facade.writeText(join(dir, "real-f"), "x", { mode: 0o666 });
  facade.mkdir(join(dir, "real-d-default"));
  facade.writeText(join(dir, "real-f-default"), "x");
  const realModes = ["real-d", "real-f", "real-d-default", "real-f-default"].map((n) =>
    modeOf(join(dir, n))
  );
  const fileDefault = realModes[3] as string;
  const afterChmod = (mode: number): string => {
    const witness = join(dir, `witness-${mode.toString(8)}`);
    writeFileSync(witness, "x");
    chmodSync(witness, mode);
    return modeOf(witness);
  };
  const lines = await dryRun(() => {
    facade.chmod(script, 0o700);
    facade.writeText(both, "new\n", { mode: 0o700 });
    facade.writeText(same, "keep");
    facade.writeText(staged, "keep", { atomic: true, mode: 0o600 });
    facade.writeText(restaged, "#!/bin/sh\n", { atomic: true });
    facade.writeText(transient, "gone by the end");
    facade.rm(transient);
    facade.rm(swap);
    facade.mkdir(swap);
    facade.rm(doc, { recursive: true });
    facade.writeText(doc, '{"a":1}');
    facade.mkdir(join(dir, "dry-d"), { mode: 0o777 });
    facade.writeText(join(dir, "dry-f"), "x", { mode: 0o666 });
    facade.mkdir(join(dir, "dry-d-default"));
    facade.writeText(join(dir, "dry-f-default"), "x");
    expect((facade.stat(script).mode & 0o777).toString(8).padStart(4, "0")).toBe(
      afterChmod(0o700),
    );
    expect(
      ["dry-d", "dry-f", "dry-d-default", "dry-f-default"].map((n) =>
        (facade.stat(join(dir, n)).mode & 0o777).toString(8).padStart(4, "0")
      ),
    ).toEqual(realModes);
  });
  // A same-bytes write is a rewrite only where the mode it lands differs from the disk's; a staged
  // rewrite lands a fresh inode at the default mode, so an executable loses its bit where there is
  // one.
  const modeOnly = (path: string, after: string): string =>
    `${modeOf(path) === after ? "unchanged" : "rewrite"} ${path}`;
  expect(lines).toEqual([
    modeOnly(script, afterChmod(0o700)),
    `rewrite ${both}`,
    `  - old`,
    `  + new`,
    `unchanged ${same}`,
    modeOnly(staged, afterChmod(0o600)),
    modeOnly(restaged, fileDefault),
    `rewrite ${swap}${sep}`,
    `rewrite ${doc}`,
    `  a  (absent) -> 1`,
    `create ${join(dir, "dry-d")}${sep}`,
    `create ${join(dir, "dry-f")}`,
    `  + x`,
    `create ${join(dir, "dry-d-default")}${sep}`,
    `create ${join(dir, "dry-f-default")}`,
    `  + x`,
  ]);
  expect(await dryRun(() => {})).toEqual(["Nothing would be written."]);
});

test("JSON and TOML files print their leaf rows (set, change, remove); a declared secret key prints redacted for the path's whole run, and a declared file with no rows prints its verdict alone", async () => {
  dir = tempDir("copilot-facade-");
  const settings = join(dir, "settings.json");
  const config = join(dir, "config.toml");
  const slot = join(dir, "slot.json");
  const bundle = join(dir, "bundle.txt");
  const token = "ghu_octocat_token_value";
  writeFileSync(
    settings,
    JSON.stringify({
      env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:4141", ANTHROPIC_AUTH_TOKEN: token },
      model: "gpt-5",
    }),
  );
  const lines = await dryRun(() => {
    facade.writeText(
      settings,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://api.githubcopilot.com",
          ANTHROPIC_AUTH_TOKEN: `${token}-next`,
        },
        apiKeyHelper: "agent auth --get",
      }),
      { secretKeys: ["env.ANTHROPIC_AUTH_TOKEN"] },
    );
    facade.writeText(
      config,
      '[model_providers.copilot-env]\nbase_url = "https://api.githubcopilot.com"\n[model_providers.copilot-env.http_headers]\nAuthorization = "Bearer x"\n',
      { secretKeys: ["model_providers.copilot-env.http_headers.Authorization"] },
    );
    // A key once declared stays secret for the path: a delete and a plain rewrite do not unmark it.
    facade.writeText(slot, JSON.stringify({ token }), { secretKeys: ["token"] });
    facade.rm(slot);
    facade.writeText(slot, JSON.stringify({ token: `${token}-again` }));
    // A declared file with no leaf rows (not JSON or TOML) prints no text.
    facade.writeText(bundle, `token=${token}\n`, { secretKeys: ["token"] });
  });
  expect(lines).toEqual([
    `rewrite ${settings}`,
    `  env.ANTHROPIC_BASE_URL  "http://127.0.0.1:4141" -> "https://api.githubcopilot.com"`,
    `  env.ANTHROPIC_AUTH_TOKEN  <redacted> -> <redacted>`,
    `  model  "gpt-5" -> (absent)`,
    `  apiKeyHelper  (absent) -> "agent auth --get"`,
    `create ${config}`,
    `  model_providers.copilot-env.base_url  (absent) -> "https://api.githubcopilot.com"`,
    `  model_providers.copilot-env.http_headers.Authorization  (absent) -> <redacted>`,
    `create ${slot}`,
    `  token  (absent) -> <redacted>`,
    `create ${bundle}`,
  ]);
});

// Creating a directory symlink needs a privilege Windows does not grant by default.
test.skipIf(WINDOWS)(
  "a symlink alias reads its target's planned state, a staged write replaces the link itself, and the report names the path the run spelled",
  async () => {
    dir = tempDir("copilot-facade-");
    const real = join(dir, "real");
    const alias = join(dir, "alias");
    const link = join(dir, "link.txt");
    mkdirSync(real);
    writeFileSync(join(real, "f.txt"), "old");
    writeFileSync(join(real, "keep.txt"), "same");
    symlinkSync(real, alias);
    symlinkSync(join(real, "keep.txt"), link);
    const lines = await dryRun(() => {
      facade.writeText(join(alias, "f.txt"), "new");
      expect(facade.readText(join(real, "f.txt"))).toBe("new");
      facade.rm(join(real, "f.txt"));
      expect([facade.exists(join(alias, "f.txt")), facade.readdir(alias)]).toEqual([
        false,
        ["keep.txt"],
      ]);
      facade.writeText(join(alias, "g.txt"), "g");
      expect(facade.lstat(alias).isSymbolicLink()).toBe(true);
      // A staged write lands over the link itself; what the link pointed at is untouched.
      facade.writeText(link, "replaced", { atomic: true });
      expect([facade.lstat(link).isSymbolicLink(), facade.readText(join(real, "keep.txt"))])
        .toEqual([false, "same"]);
      // The alias follows into the remade target, which hides the disk's children.
      facade.rm(real, { recursive: true });
      facade.mkdir(real);
      expect([facade.exists(join(alias, "g.txt")), facade.readdir(alias)]).toEqual([false, []]);
      // Removing the link removes the alias, not what it pointed at.
      facade.rm(alias);
      expect([facade.exists(alias), facade.exists(real)]).toEqual([false, true]);
    });
    expect(lines).toEqual([
      `rewrite ${link}`,
      `  - same`,
      `  + replaced`,
      `unchanged ${real}${sep}`,
      `delete ${join(real, "f.txt")}`,
      `delete ${join(real, "keep.txt")}`,
      `delete ${alias}`,
    ]);
    expect(readFileSync(join(real, "f.txt"), "utf8")).toBe("old");
  },
);

test("outside a dry run every operation lands on the disk", () => {
  dir = tempDir("copilot-facade-");
  const home = join(dir, "home", "nested");
  const file = join(home, "state.json");
  const moved = join(home, "moved.json");
  facade.mkdir(home);
  facade.writeText(file, "{}", { atomic: true, mode: 0o600 });
  facade.rename(file, moved);
  facade.writeText(join(home, "doomed.txt"), "x");
  facade.rm(join(home, "doomed.txt"));
  expect(facade.readdir(home)).toEqual(["moved.json"]);
  expect(facade.readText(moved)).toBe("{}");
  expect(readFileSync(moved, "utf8")).toBe("{}");
  expect(facade.stat(moved).isFile() && facade.lstat(home).isDirectory()).toBe(true);
  expect(outcome(() => facade.rm(join(home, "missing")))).toBe("ENOENT");
  facade.rm(join(dir, "home"), { recursive: true });
  expect(facade.exists(home)).toBe(false);
});

test("a file declared secret as a whole prints its verdict alone, whatever its syntax", async () => {
  dir = tempDir("copilot-facade-");
  const bundle = join(dir, "bundle.json");
  const config = join(dir, "config.toml");
  const same = join(dir, "same.json");
  writeFileSync(config, 'model = "old"\n');
  writeFileSync(same, '{"token":"t"}');
  const lines = await dryRun(() => {
    facade.writeText(bundle, '{"token":"t"}', { secret: true });
    facade.writeText(config, 'model = "new"\n', { secret: true, atomic: false });
    facade.writeText(same, '{"token":"t"}', { secret: true, atomic: false });
    expect(facade.readText(bundle)).toBe('{"token":"t"}');
  });
  expect(lines).toEqual([`create ${bundle}`, `rewrite ${config}`, `unchanged ${same}`]);
});

test("a path's secret declarations travel with a rename and a copy, so the report at the new path redacts the same values", async () => {
  dir = tempDir("copilot-facade-");
  const staged = join(dir, "staged.json");
  const live = join(dir, "live.json");
  const copy = join(dir, "copy.json");
  const bundle = join(dir, "bundle.json");
  const bundleCopy = join(dir, "bundle-copy.json");
  const lines = await dryRun(() => {
    facade.writeText(staged, '{"token":"t"}', { secretKeys: ["token"] });
    facade.rename(staged, live);
    facade.copyFile(live, copy);
    facade.writeText(bundle, '{"token":"t"}', { secret: true });
    facade.copyFile(bundle, bundleCopy);
  });
  expect(lines).toEqual([
    `create ${live}`,
    `  token  (absent) -> <redacted>`,
    `create ${copy}`,
    `  token  (absent) -> <redacted>`,
    `create ${bundle}`,
    `create ${bundleCopy}`,
  ]);
});

test("a copy out of scratch survives the scratch dir's removal, and a byte write keeps its own copy of the buffer", async () => {
  dir = tempDir("copilot-facade-");
  const target = join(dir, "target.bin");
  const written = join(dir, "written.bin");
  writeFileSync(target, "old");
  const lines = await dryRun(() => {
    const scratch = facade.scratchDir(join(dir, "scratch-"));
    facade.writeText(join(scratch, "seed"), "fresh");
    facade.copyFile(join(scratch, "seed"), target);
    facade.removeScratchDir(scratch);
    const buffer = new Uint8Array([1, 2, 3]);
    facade.writeBytes(written, buffer);
    buffer.fill(9);
    expect([facade.readText(target), facade.readBytes(written)]).toEqual([
      "fresh",
      new Uint8Array([1, 2, 3]),
    ]);
  });
  expect(lines).toEqual([`rewrite ${target}`, `create ${written}`]);
});

// Creating a symlink needs a privilege Windows does not grant by default.
test.skipIf(WINDOWS)("a link to itself is ELOOP in a dry run, as on the disk", async () => {
  dir = tempDir("copilot-facade-");
  const loop = join(dir, "loop");
  symlinkSync(loop, loop);
  expect(outcome(() => facade.readText(loop))).toBe("ELOOP");
  await dryRun(() => {
    expect([outcome(() => facade.readText(loop)), outcome(() => facade.stat(loop))]).toEqual([
      "ELOOP",
      "ELOOP",
    ]);
  });
});

test("readTextResult tells absent from unreadable by lstat, in a dry run from the planned state; scratch stays real in a dry run and prints nothing", async () => {
  dir = tempDir("copilot-facade-");
  const file = join(dir, "f.txt");
  const dangling = join(dir, "dangling");
  const scratchRoot = join(dir, "scratch-");
  writeFileSync(file, "disk");
  if (!WINDOWS) symlinkSync(join(dir, "nowhere"), dangling);
  expect([facade.readTextResult(file), facade.readTextResult(join(dir, "missing")).kind]).toEqual([
    { kind: "text", text: "disk" },
    "absent",
  ]);
  if (!WINDOWS) expect(facade.readTextResult(dangling).kind).toBe("unreadable");
  expect(facade.dryRunActive()).toBe(false);
  let probe = "";
  const lines = await dryRun(() => {
    expect(facade.dryRunActive()).toBe(true);
    facade.writeText(file, "planned");
    expect(facade.readTextResult(file)).toEqual({ kind: "text", text: "planned" });
    facade.rm(file);
    expect(facade.readTextResult(file)).toEqual({ kind: "absent" });
    // A probe's throwaway config is written for real, so the CLI it spawns can read it.
    const scratch = facade.scratchDir(scratchRoot);
    probe = join(scratch, "config.toml");
    facade.mkdir(join(scratch, "sessions"));
    facade.writeText(probe, 'model = "x"\n');
    expect([readFileSync(probe, "utf8"), existsSync(join(scratch, "sessions"))]).toEqual([
      'model = "x"\n',
      true,
    ]);
    facade.removeScratchDir(scratch);
    expect(existsSync(scratch)).toBe(false);
  });
  expect(lines).toEqual([`delete ${file}`]);
  expect(readFileSync(file, "utf8")).toBe("disk");
});

test("writeText is staged by default: a stale temp under this pid goes first and none survives, and an explicit mode lands exactly", () => {
  dir = tempDir("copilot-facade-");
  const file = join(dir, "nested", "f.json");
  const stale = join(dir, "nested", `f.json.tmp.${process.pid}`);
  mkdirSync(join(dir, "nested"));
  writeFileSync(stale, "stale");
  facade.writeText(file, "{}", { mode: 0o600 });
  expect([readFileSync(file, "utf8"), existsSync(stale), facade.readdir(join(dir, "nested"))])
    .toEqual(["{}", false, ["f.json"]]);
  if (!WINDOWS) expect(modeOf(file)).toBe("0600");
});

// Creating a symlink needs a privilege Windows does not grant by default.
test.skipIf(WINDOWS)(
  "`atomic: false` writes through a link and keeps it; the staged default replaces the link with a file",
  () => {
    dir = tempDir("copilot-facade-");
    const target = join(dir, "target.txt");
    const link = join(dir, "link.txt");
    writeFileSync(target, "old");
    symlinkSync(target, link);
    facade.writeText(link, "through", { atomic: false });
    expect([lstatSync(link).isSymbolicLink(), readFileSync(target, "utf8")]).toEqual([
      true,
      "through",
    ]);
    facade.writeText(link, "replaced");
    expect([
      lstatSync(link).isSymbolicLink(),
      readFileSync(link, "utf8"),
      readFileSync(target, "utf8"),
    ]).toEqual([false, "replaced", "through"]);
  },
);

test.skipIf(WINDOWS)(
  "the installer's `current` swap in a dry run: a stray directory goes and the link lands as a link a lookup follows; a moved disk link stays a link",
  async () => {
    dir = tempDir("copilot-facade-");
    const target = join("versions", "v1");
    // Three tops: a stray directory at `current`, nothing there, and a link already there.
    const [stray, fresh, linked] = ["stray", "fresh", "linked"].map((name) => join(dir, name));
    const tops = [stray, fresh, linked] as string[];
    for (const top of tops) mkdirSync(join(top, target, "bin"), { recursive: true });
    mkdirSync(join(stray as string, "current"));
    symlinkSync(target, join(linked as string, "current"));
    const moved = { from: join(dir, "a"), to: join(dir, "b") };
    mkdirSync(moved.from);
    writeFileSync(join(moved.from, "target.txt"), "kept");
    symlinkSync("target.txt", join(moved.from, "ln"));
    const lines = await dryRun(() => {
      for (const top of tops) {
        const current = join(top, "current");
        if (facade.exists(current) && !facade.lstat(current).isSymbolicLink()) {
          facade.rmdir(current);
        }
        facade.atomicSymlink(target, current);
        expect([
          facade.lstat(current).isSymbolicLink(),
          facade.readlink(current),
          facade.stat(current).isDirectory(),
          facade.readdir(current),
          facade.readdirEntries(top).map((e) => [e.name, e.isSymbolicLink()]),
        ]).toEqual([true, target, true, ["bin"], [["current", true], ["versions", false]]]);
      }
      facade.rename(moved.from, moved.to);
      expect([
        facade.lstat(join(moved.to, "ln")).isSymbolicLink(),
        facade.readlink(join(moved.to, "ln")),
        facade.readText(join(moved.to, "ln")),
        facade.exists(moved.from),
      ]).toEqual([true, "target.txt", "kept", false]);
    });
    expect(lines).toEqual([
      `rewrite ${join(stray as string, "current")}`,
      `create ${join(fresh as string, "current")}`,
      `unchanged ${join(linked as string, "current")}`,
      `delete ${moved.from}${sep}`,
      `create ${moved.to}${sep}`,
      `create ${join(moved.to, "ln")}`,
      `create ${join(moved.to, "target.txt")}`,
    ]);
    // The disk kept every state the run started from.
    expect([
      lstatSync(join(stray as string, "current")).isDirectory(),
      existsSync(join(fresh as string, "current")),
      readlinkSync(join(linked as string, "current")),
      existsSync(moved.to),
    ]).toEqual([true, false, target, false]);
  },
);
