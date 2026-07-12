import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertReleaseComplete, mirror, PRESERVE, REQUIRED_FILES } from "../src/install/release.ts";

// POSIX-only because symlink creation is unreliable on Windows without privilege.
const skipWin = test.skipIf(process.platform === "win32");

let root = "";
let src = "";
let dest = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "copilot-release-"));
  src = join(root, "src");
  dest = join(root, "dest");
  mkdirSync(src, { recursive: true });
  mkdirSync(dest, { recursive: true });
});

afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true });
    root = "";
  }
});

/** Build a full release-shaped tree at `dir` so assertReleaseComplete passes. */
function writeCompleteTree(dir: string): void {
  for (const required of REQUIRED_FILES) {
    const target = join(dir, required);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, `content of ${required}`);
  }
}

describe("mirror", () => {
  test("replaces a tracked file with the source version", () => {
    writeFileSync(join(src, "package.json"), "new");
    writeFileSync(join(dest, "package.json"), "old");

    mirror(src, dest, new Set());

    expect(readFileSync(join(dest, "package.json"), "utf8")).toBe("new");
  });

  test("recurses into directories and creates missing ones", () => {
    mkdirSync(join(src, "bin"), { recursive: true });
    writeFileSync(join(src, "bin", "agent"), "#!/usr/bin/env bun\n");

    mirror(src, dest, new Set());

    expect(readFileSync(join(dest, "bin", "agent"), "utf8")).toBe("#!/usr/bin/env bun\n");
  });

  test("prunes a dest file the new release dropped", () => {
    writeFileSync(join(src, "keep.ts"), "keep");
    writeFileSync(join(dest, "keep.ts"), "keep");
    writeFileSync(join(dest, "stale.ts"), "stale"); // not in src -> dropped

    mirror(src, dest, new Set());

    expect(existsSync(join(dest, "keep.ts"))).toBe(true);
    expect(existsSync(join(dest, "stale.ts"))).toBe(false);
  });

  test("the preserve list keeps every non-shipped checkout file across an update", () => {
    // These live in the checkout but are gitignored, so a release tree never ships them;
    // applyRelease must never prune them. `.env` in particular holds the documented proxy
    // pin (COPILOT_API_VERSION), and its loss would silently un-pin the proxy float.
    for (const name of [".git", "node_modules", ".autoupdate", ".env"]) {
      expect(PRESERVE.has(name)).toBe(true);
    }
  });

  test("preserves a `keep` name at the top level even when src lacks it", () => {
    writeFileSync(join(src, "cli.ts"), "code");
    mkdirSync(join(dest, "node_modules"), { recursive: true });
    writeFileSync(join(dest, "node_modules", "marker"), "deps");

    mirror(src, dest, new Set(["node_modules"]));

    // node_modules survives untouched; the tracked file lands.
    expect(readFileSync(join(dest, "node_modules", "marker"), "utf8")).toBe("deps");
    expect(existsSync(join(dest, "cli.ts"))).toBe(true);
  });

  test("never copies a `keep` name from src over the preserved dest", () => {
    // A src that happens to contain node_modules must not clobber the live one.
    mkdirSync(join(src, "node_modules"), { recursive: true });
    writeFileSync(join(src, "node_modules", "fromsrc"), "src");
    mkdirSync(join(dest, "node_modules"), { recursive: true });
    writeFileSync(join(dest, "node_modules", "live"), "live");

    mirror(src, dest, new Set(["node_modules"]));

    expect(existsSync(join(dest, "node_modules", "live"))).toBe(true);
    expect(existsSync(join(dest, "node_modules", "fromsrc"))).toBe(false);
  });

  test("the preserve list applies only at the checkout root, not nested dirs", () => {
    mkdirSync(join(src, "vendor", "node_modules"), { recursive: true });
    writeFileSync(join(src, "vendor", "node_modules", "f"), "vendored");

    mirror(src, dest, new Set(["node_modules"]));

    // A nested node_modules is plain tracked source and IS mirrored.
    expect(readFileSync(join(dest, "vendor", "node_modules", "f"), "utf8")).toBe("vendored");
  });

  test("removes a non-dir in the way of a src directory", () => {
    mkdirSync(join(src, "bin"), { recursive: true });
    writeFileSync(join(src, "bin", "agent"), "script");
    writeFileSync(join(dest, "bin"), "i am a file, not a dir"); // wrong type in the way

    mirror(src, dest, new Set());

    expect(lstatSync(join(dest, "bin")).isDirectory()).toBe(true);
    expect(readFileSync(join(dest, "bin", "agent"), "utf8")).toBe("script");
  });

  skipWin("copies a file symlink verbatim (dereference:false)", () => {
    writeFileSync(join(src, "target.txt"), "payload");
    symlinkSync("target.txt", join(src, "link.txt"));

    mirror(src, dest, new Set());

    const copied = join(dest, "link.txt");
    expect(lstatSync(copied).isSymbolicLink()).toBe(true);
    expect(readlinkSync(copied)).toBe("target.txt");
  });

  skipWin("replaces a dest symlink standing where a src dir belongs", () => {
    mkdirSync(join(src, "bin"), { recursive: true });
    writeFileSync(join(src, "bin", "agent"), "script");
    // dest/bin is a symlink to a dir: must be removed so recursion stays in-checkout.
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(dest, "bin"));

    mirror(src, dest, new Set());

    expect(lstatSync(join(dest, "bin")).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(dest, "bin")).isDirectory()).toBe(true);
    expect(readFileSync(join(dest, "bin", "agent"), "utf8")).toBe("script");
    // The outside target was never recursed into / written through the link.
    expect(existsSync(join(outside, "agent"))).toBe(false);
  });
});

describe("assertReleaseComplete", () => {
  test("passes on a tree containing every required file", () => {
    writeCompleteTree(src);
    expect(() => assertReleaseComplete(src)).not.toThrow();
  });

  test("throws naming the first missing required file", () => {
    writeCompleteTree(src);
    rmSync(join(src, "bun.lock"));

    expect(() => assertReleaseComplete(src)).toThrow(
      "release archive is incomplete (missing bun.lock); update aborted",
    );
  });

  test("throws on a missing nested required file", () => {
    writeCompleteTree(src);
    rmSync(join(src, "src", "cli.ts"));

    expect(() => assertReleaseComplete(src)).toThrow("missing src/cli.ts");
  });

  test("REQUIRED_FILES lists the load-bearing release entries", () => {
    expect(REQUIRED_FILES).toEqual(["package.json", "bun.lock", "bin/agent", "src/cli.ts"]);
  });
});
