import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { crypto } from "@std/crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyUpdate, type ApplyUpdateOptions } from "../src/autoupdate/apply.ts";
import { withUpdateLock } from "../src/autoupdate/lock.ts";
import { expectedDigest, fileSha256, parseChecksums } from "../src/install/checksums.ts";
import {
  currentReleaseTarget,
  installedBinaryName,
  RELEASE_TARGETS,
  releaseAssetName,
} from "../src/install/targets.ts";
import { afterEach, beforeEach, describe, expect, test } from "./helpers/testing.ts";

// The compiled-era update: fetch this platform's binary, verify it against the
// release manifest, swap it in, then hand off to the NEW binary. The download
// source is redirected at a local directory through COPILOT_ENV_DOWNLOAD_BASE,
// which is the same hook install.sh and the CI smokes use.

const skipWin = test.skipIf(process.platform === "win32");

let root = "";
let releaseDir = "";
let installDir = "";

/** A stand-in release directory: the "binary" for this platform plus the
 *  checksums.txt that vouches for it. */
function writeRelease(contents: string, digestOverride?: string): string {
  const asset = releaseAssetName(hostTarget());
  writeFileSync(join(releaseDir, asset), contents);
  const digest = digestOverride ?? sha256Hex(contents);
  writeFileSync(join(releaseDir, "checksums.txt"), `${digest}  ${asset}\n`);
  return asset;
}

/** SHA256 of a string, via the same primitive the verifier uses. */
function sha256Hex(text: string): string {
  const digest = crypto.subtle.digestSync("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** This platform's release target, or a failed test rather than a null deref. */
function hostTarget() {
  const target = currentReleaseTarget();
  if (!target) throw new Error("no release target for this platform");
  return target;
}

/** A shell script standing in for the swapped-in binary: it records every
 *  invocation so the post-swap handoff can be asserted. */
const RECORDING_BINARY = `#!/bin/sh
echo "$@" >> "$(dirname "$0")/../invocations.log"
`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "copilot-update-"));
  releaseDir = join(root, "release");
  installDir = join(root, "install");
  mkdirSync(releaseDir, { recursive: true });
  mkdirSync(join(installDir, "bin"), { recursive: true });
  process.env.COPILOT_ENV_DOWNLOAD_BASE = releaseDir;
});

afterEach(() => {
  delete process.env.COPILOT_ENV_DOWNLOAD_BASE;
  if (root) {
    rmSync(root, { recursive: true, force: true });
    root = "";
  }
});

describe("parseChecksums", () => {
  test("reads shasum and sha256sum output, including binary-mode names", () => {
    const digest = "a".repeat(64);
    const other = "b".repeat(64);
    const checksums = parseChecksums(
      `${digest}  copilot-env-x86_64-unknown-linux-gnu\n${other} *copilot-env-x86_64-pc-windows-msvc.exe\n`,
    );
    expect(checksums.get("copilot-env-x86_64-unknown-linux-gnu")).toBe(digest);
    // The leading "*" marks binary mode and is not part of the name.
    expect(checksums.get("copilot-env-x86_64-pc-windows-msvc.exe")).toBe(other);
  });

  test("skips malformed lines rather than throwing", () => {
    const digest = "c".repeat(64);
    const checksums = parseChecksums(`nonsense\n\nzz  bad-digest\n${digest}  good\n`);
    expect([...checksums.keys()]).toEqual(["good"]);
  });

  test("expectedDigest names the asset the manifest lacked", () => {
    expect(() => expectedDigest(parseChecksums(""), "agent-x")).toThrow(
      "checksums.txt has no entry for agent-x",
    );
  });
});

describe("fileSha256", () => {
  test("hashes a file by streaming it", async () => {
    const file = join(root, "payload");
    writeFileSync(file, "hello");
    expect(await fileSha256(file)).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});

describe("release targets", () => {
  test("every target has a distinct triple and asset name", () => {
    const triples = RELEASE_TARGETS.map((t) => t.triple);
    const assets = RELEASE_TARGETS.map(releaseAssetName);
    expect(new Set(triples).size).toBe(triples.length);
    expect(new Set(assets).size).toBe(assets.length);
  });

  test("only Windows assets carry the .exe suffix", () => {
    for (const target of RELEASE_TARGETS) {
      expect(releaseAssetName(target).endsWith(".exe")).toBe(target.os === "win32");
    }
  });

  test("the running platform resolves to a target", () => {
    // If this fails, copilot-env cannot update itself on the machine running
    // the suite -- which is also a machine we claim to support.
    expect(currentReleaseTarget()).not.toBeNull();
  });

  test("an unsupported platform resolves to null rather than guessing", () => {
    expect(currentReleaseTarget("aix", "ppc64")).toBeNull();
    expect(currentReleaseTarget("linux", "riscv64")).toBeNull();
  });

  test("the installed binary name is platform-shaped", () => {
    expect(installedBinaryName("win32")).toBe("copilot-env.exe");
    expect(installedBinaryName("linux")).toBe("copilot-env");
    expect(installedBinaryName("darwin")).toBe("copilot-env");
  });
});

describe("applyUpdate", () => {
  const target = { tag: "v9.9.9", dateSeconds: 0 };
  const quiet = { warn: () => {}, success: () => {} };

  /** Run applyUpdate the only way it can be run: under the update lock, whose held
   *  branch mints the HeldLock evidence the signature demands. */
  function applyLocked(current: string, opts: ApplyUpdateOptions): Promise<void> {
    return withUpdateLock(Date.now(), (outcome) => {
      if (!outcome.held) throw new Error("test could not take its own update lock");
      return applyUpdate(current, target, outcome, opts);
    }, join(root, "update.lock"));
  }

  skipWin("verifies, swaps in the binary, and runs the new one", async () => {
    writeRelease(RECORDING_BINARY);

    await applyLocked("v9.9.8", {
      root: installDir,
      logger: quiet,
      childStdoutToStderr: true,
    });

    const live = join(installDir, "bin", installedBinaryName());
    expect(readFileSync(live, "utf8")).toBe(RECORDING_BINARY);

    // Both post-swap steps must run the NEW binary: it is the only thing that
    // knows its own assets and its own migrations.
    const log = readFileSync(join(installDir, "invocations.log"), "utf8").trim().split("\n");
    expect(log).toEqual(["install --assets-only", "migrate 9.9.8 9.9.9"]);
  });

  skipWin("refuses a binary the release manifest does not vouch for", async () => {
    writeRelease(RECORDING_BINARY, "f".repeat(64));

    await expect(
      applyLocked("v9.9.8", { root: installDir, logger: quiet }),
    ).rejects.toThrow("SHA256 verification failed");

    // Nothing was swapped in, and the staging directory did not survive.
    expect(() => readFileSync(join(installDir, "bin", installedBinaryName()))).toThrow();
    expect(stagingDirs()).toEqual([]);
  });

  skipWin("leaves no staging directory behind on success", async () => {
    writeRelease(RECORDING_BINARY);
    await applyLocked("v9.9.8", { root: installDir, logger: quiet });
    expect(stagingDirs()).toEqual([]);
  });

  test("fails when the release has no asset for this platform", async () => {
    // A manifest that vouches for other platforms only.
    writeFileSync(join(releaseDir, "checksums.txt"), `${"a".repeat(64)}  agent-other\n`);
    writeFileSync(join(releaseDir, releaseAssetName(hostTarget())), "x");

    await expect(
      applyLocked("v9.9.8", { root: installDir, logger: quiet }),
    ).rejects.toThrow("checksums.txt has no entry for");
  });
});

/** Staging dirs applyUpdate creates inside the install root (rename needs one
 *  filesystem), which must never outlive the call. */
function stagingDirs(): string[] {
  return [...Deno.readDirSync(installDir)]
    .filter((e) => e.name.startsWith(".update-"))
    .map((e) => e.name);
}
