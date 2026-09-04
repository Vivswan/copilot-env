import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { crypto } from "@std/crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyUpdate,
  type ApplyUpdateOptions,
  type ProvenanceVerifier,
  resolveProvenanceDecision,
} from "../src/autoupdate/apply.ts";
import { withUpdateLockForTests } from "../src/autoupdate/lock.ts";
import { ATTESTATION_NAME } from "../src/install/attestation.ts";
import { expectedDigest, fileSha256, parseChecksums } from "../src/install/checksums.ts";
import {
  CURRENT_LINK,
  pointCurrentAt,
  POSIX_CURRENT_SHIM,
  readCurrentVersionName,
  VERSIONS_DIR,
} from "../src/install/installer.ts";
import {
  currentReleaseTarget,
  installedBinaryName,
  RELEASE_TARGETS,
  releaseAssetName,
} from "../src/install/targets.ts";
import { afterEach, beforeEach, describe, expect, test } from "./helpers/testing.ts";

// The compiled-era update: fetch this platform's binary, verify it against the
// release manifest and (through an injected verifier -- the real one needs the
// Sigstore trust root, see test/provenance.test.ts) the release's attestation,
// STAGE it into its own version root, PROVISION that root by
// running the new binary's `install --assets-only` inside it, then COMMIT by
// flipping the `current` link -- prepare-then-commit, so a pre-flip failure
// leaves the old version fully live. The download source is redirected at a
// local directory through COPILOT_ENV_DOWNLOAD_BASE, which is the same hook
// install.sh and the CI smokes use.

const skipWin = test.skipIf(process.platform === "win32");

let root = "";
let releaseDir = "";
let installDir = "";

/** Stand-in attestation text: the injected verifier receives it verbatim. */
const FAKE_BUNDLE = '{"fake":"attestation"}';

/** A stand-in release directory: the "binary" for this platform, the
 *  checksums.txt that vouches for it, and the attestation.json a verifier reads. */
function writeRelease(contents: string, digestOverride?: string): string {
  const asset = releaseAssetName(hostTarget());
  writeFileSync(join(releaseDir, asset), contents);
  const digest = digestOverride ?? sha256Hex(contents);
  writeFileSync(join(releaseDir, "checksums.txt"), `${digest}  ${asset}\n`);
  writeFileSync(join(releaseDir, ATTESTATION_NAME), FAKE_BUNDLE);
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

/** A shell script standing in for the staged binary: it records every
 *  invocation (with the root it was aimed at) so the provision/migrate handoff
 *  can be asserted, and writes the per-version manifest `install` must leave
 *  behind (the provision postcondition). It lives at <top>/versions/<v>/bin/,
 *  hence the three hops up to the log at the top. */
const RECORDING_BINARY = `#!/bin/sh
HERE="$(dirname "$0")"
echo "\${COPILOT_ENV_INSTALL_ROOT:-} $@" >> "$HERE/../../../invocations.log"
if [ "$1" = "install" ]; then
  printf '{"version":"9.9.9","kind":"installed","assets":[]}' > "$HERE/../.copilot-env-install.json"
fi
`;

/** Like RECORDING_BINARY, but its `install` step fails: the provision stage. */
const FAILING_PROVISION_BINARY = `#!/bin/sh
echo "\${COPILOT_ENV_INSTALL_ROOT:-} $@" >> "$(dirname "$0")/../../../invocations.log"
[ "$1" = "install" ] && exit 7
exit 0
`;

/** Exit 0 but write NO manifest: the soft no-op the postcondition must catch. */
const SOFT_NOOP_BINARY = `#!/bin/sh
echo "\${COPILOT_ENV_INSTALL_ROOT:-} $@" >> "$(dirname "$0")/../../../invocations.log"
exit 0
`;

/** Writes a VALID manifest for the wrong release: the version-match half. */
const WRONG_VERSION_BINARY = `#!/bin/sh
HERE="$(dirname "$0")"
if [ "$1" = "install" ]; then
  printf '{"version":"0.0.1","kind":"installed","assets":[]}' > "$HERE/../.copilot-env-install.json"
fi
exit 0
`;

/** Seed one version dir (with a stand-in binary) inside the install root. */
function seedVersion(name: string, contents = name): string {
  const dir = join(installDir, VERSIONS_DIR, name);
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "bin", installedBinaryName()), contents);
  return dir;
}

function invocations(): string[] {
  return readFileSync(join(installDir, "invocations.log"), "utf8").trim().split("\n");
}

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

  test("currentReleaseTarget maps each shipped (platform, arch) to its triple, null otherwise", () => {
    // The full mapping, positives and negatives in one table: an unsupported
    // pair must resolve to null (never a guess), and each supported pair to
    // exactly its triple -- these are the release-asset names, so they are
    // external contracts, not restated implementation.
    const cases: { platform: string; arch: string; triple: string | null }[] = [
      { platform: "darwin", arch: "x64", triple: "x86_64-apple-darwin" },
      { platform: "darwin", arch: "arm64", triple: "aarch64-apple-darwin" },
      { platform: "linux", arch: "x64", triple: "x86_64-unknown-linux-gnu" },
      { platform: "linux", arch: "arm64", triple: "aarch64-unknown-linux-gnu" },
      { platform: "win32", arch: "x64", triple: "x86_64-pc-windows-msvc" },
      { platform: "win32", arch: "arm64", triple: null },
      { platform: "aix", arch: "ppc64", triple: null },
      { platform: "linux", arch: "riscv64", triple: null },
    ];
    for (const { platform, arch, triple } of cases) {
      expect(currentReleaseTarget(platform, arch)?.triple ?? null, `${platform}/${arch}`).toBe(
        triple,
      );
    }
    // If this fails, copilot-env cannot update itself on the machine running
    // the suite -- which is also a machine we claim to support.
    expect(currentReleaseTarget()).not.toBeNull();
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
  /** A verifier that accepts everything: the default here, so the existing cases
   *  run the full stage order (download -> verify -> attest -> ...) unchanged. */
  const acceptAll: ProvenanceVerifier = () => Promise.resolve();

  /** Run applyUpdate the only way it can be run: under the update lock, whose held
   *  branch mints the HeldLock evidence the signature demands (via the hermetic-path
   *  test seam, so the suite never touches the install root's real lock). */
  function applyLocked(
    current: string,
    opts: Omit<ApplyUpdateOptions, "provenance"> & Partial<Pick<ApplyUpdateOptions, "provenance">>,
  ): Promise<void> {
    return withUpdateLockForTests(join(root, "update.lock"), Date.now(), (outcome) => {
      if (!outcome.held) throw new Error("test could not take its own update lock");
      return applyUpdate(current, target, outcome, {
        provenance: { kind: "verify", verifier: acceptAll },
        ...opts,
      });
    });
  }

  /** A logger that records what it was told. */
  function recordingLogger() {
    const warns: string[] = [];
    const successes: string[] = [];
    return {
      warns,
      successes,
      logger: { warn: (m: string) => warns.push(m), success: (m: string) => successes.push(m) },
    };
  }

  skipWin("hands the verifier the binary AND the manifest digests, then commits", async () => {
    const asset = writeRelease(RECORDING_BINARY);
    seedVersion("v9.9.8", "OLD");
    pointCurrentAt(installDir, "v9.9.8");
    const calls: Parameters<ProvenanceVerifier>[] = [];
    const { logger, successes } = recordingLogger();

    await applyLocked("v9.9.8", {
      root: installDir,
      logger,
      childStdoutToStderr: true,
      provenance: {
        kind: "verify",
        verifier: (...args) => {
          calls.push(args);
          return Promise.resolve();
        },
      },
    });

    expect(calls).toEqual([[
      "v9.9.9",
      FAKE_BUNDLE,
      [
        { name: asset, sha256: sha256Hex(RECORDING_BINARY) },
        { name: "checksums.txt", sha256: sha256Hex(`${sha256Hex(RECORDING_BINARY)}  ${asset}\n`) },
      ],
    ]]);
    expect(readCurrentVersionName(installDir)).toBe("v9.9.9");
    expect(successes.some((m) => m.startsWith("Build provenance verified"))).toBe(true);
  });

  test("a verifier verdict aborts BEFORE staging: nothing runs, nothing moves", async () => {
    writeRelease(RECORDING_BINARY);
    seedVersion("v9.9.8", "OLD");
    pointCurrentAt(installDir, "v9.9.8");

    await expect(
      applyLocked("v9.9.8", {
        root: installDir,
        logger: quiet,
        provenance: {
          kind: "verify",
          verifier: () =>
            Promise.reject(new Error("build provenance verification FAILED for v9.9.9")),
        },
      }),
    ).rejects.toThrow("build provenance verification FAILED for v9.9.9");

    expect(readCurrentVersionName(installDir)).toBe("v9.9.8");
    expect(existsSync(join(installDir, VERSIONS_DIR, "v9.9.9"))).toBe(false);
    expect(existsSync(join(installDir, "invocations.log"))).toBe(false);
    expect(stagingDirs()).toEqual([]);
  });

  test("a corrupt download is an integrity failure, never a provenance verdict", async () => {
    // Both wrong: the manifest disowns the binary AND the attestation is missing.
    // The checksum stage must win, so the message is the actionable SHA256 one
    // and the opt-outs (which only the fail-closed message carries) stay unsaid.
    writeRelease(RECORDING_BINARY, "f".repeat(64));
    rmSync(join(releaseDir, ATTESTATION_NAME));
    seedVersion("v9.9.8", "OLD");
    pointCurrentAt(installDir, "v9.9.8");

    const err = await applyLocked("v9.9.8", { root: installDir, logger: quiet })
      .catch((e: unknown) => e as Error);
    expect((err as Error).message).toContain("SHA256 verification failed");
    expect((err as Error).message).not.toContain("--no-verify");
    expect(readCurrentVersionName(installDir)).toBe("v9.9.8");
    expect(stagingDirs()).toEqual([]);
  });

  test("a missing attestation.json fails closed, naming both opt-outs, before any verifier runs", async () => {
    writeRelease(RECORDING_BINARY);
    rmSync(join(releaseDir, ATTESTATION_NAME));
    seedVersion("v9.9.8", "OLD");
    pointCurrentAt(installDir, "v9.9.8");
    let verifierCalls = 0;

    const err = await applyLocked("v9.9.8", {
      root: installDir,
      logger: quiet,
      provenance: {
        kind: "verify",
        verifier: () => {
          verifierCalls++;
          return Promise.resolve();
        },
      },
    }).catch((e: unknown) => e as Error);

    expect((err as Error).message).toContain("cannot verify the build provenance of v9.9.9");
    expect((err as Error).message).toContain("attestation.json could not be fetched");
    expect((err as Error).message).toContain("--no-verify");
    expect((err as Error).message).toContain("agent config --set verify-provenance false");
    expect(verifierCalls).toBe(0);
    expect(readCurrentVersionName(installDir)).toBe("v9.9.8");
    expect(stagingDirs()).toEqual([]);
  });

  skipWin("--no-verify skips the check out loud and needs no attestation", async () => {
    writeRelease(RECORDING_BINARY);
    rmSync(join(releaseDir, ATTESTATION_NAME));
    seedVersion("v9.9.8", "OLD");
    pointCurrentAt(installDir, "v9.9.8");
    const { logger, warns } = recordingLogger();

    await applyLocked("v9.9.8", {
      root: installDir,
      logger,
      childStdoutToStderr: true,
      provenance: { kind: "skip", via: "--no-verify" },
    });

    expect(readCurrentVersionName(installDir)).toBe("v9.9.9");
    expect(warns).toEqual(["Skipping build-provenance verification (--no-verify)."]);
  });

  skipWin("a stored opt-out is named as such, with the way back", async () => {
    writeRelease(RECORDING_BINARY);
    seedVersion("v9.9.8", "OLD");
    pointCurrentAt(installDir, "v9.9.8");
    const { logger, warns } = recordingLogger();

    await applyLocked("v9.9.8", {
      root: installDir,
      logger,
      childStdoutToStderr: true,
      provenance: { kind: "skip", via: "verify-provenance" },
    });

    expect(readCurrentVersionName(installDir)).toBe("v9.9.9");
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("verify-provenance is false");
    expect(warns[0]).toContain("agent config --del verify-provenance");
  });

  skipWin("stages, provisions inside the version root, then commits the flip", async () => {
    writeRelease(RECORDING_BINARY);
    seedVersion("v9.9.8", "OLD");
    pointCurrentAt(installDir, "v9.9.8");

    await applyLocked("v9.9.8", {
      root: installDir,
      logger: quiet,
      childStdoutToStderr: true,
    });

    // The new binary landed in ITS version root; the old version is untouched.
    const versionRoot = join(installDir, VERSIONS_DIR, "v9.9.9");
    expect(readFileSync(join(versionRoot, "bin", installedBinaryName()), "utf8")).toBe(
      RECORDING_BINARY,
    );
    expect(
      readFileSync(
        join(installDir, VERSIONS_DIR, "v9.9.8", "bin", installedBinaryName()),
        "utf8",
      ),
    ).toBe("OLD");

    // The commit: current points at the new version, and reads THROUGH the
    // link reach the new binary (the shim dispatch path).
    expect(readCurrentVersionName(installDir)).toBe("v9.9.9");
    expect(
      readFileSync(join(installDir, CURRENT_LINK, "bin", installedBinaryName()), "utf8"),
    ).toBe(RECORDING_BINARY);
    expect(readFileSync(join(installDir, "bin", "agent"), "utf8")).toBe(POSIX_CURRENT_SHIM);

    // Both handoffs ran the NEW binary, each aimed at the right root: the
    // provision INSIDE its version root (pre-flip), the migrations at the
    // current link (post-flip).
    expect(invocations()).toEqual([
      `${versionRoot} install --assets-only`,
      `${join(installDir, CURRENT_LINK)} migrate 9.9.8 9.9.9`,
    ]);
  });

  skipWin("a flat (pre-versioned) root is versioned by the same update", async () => {
    writeRelease(RECORDING_BINARY);
    writeFileSync(join(installDir, "bin", installedBinaryName()), "FLAT-LIVE");
    mkdirSync(join(installDir, "shell"), { recursive: true });
    writeFileSync(join(installDir, "shell", "payload.txt"), "flat");

    await applyLocked("v9.9.8", { root: installDir, logger: quiet, childStdoutToStderr: true });

    expect(readCurrentVersionName(installDir)).toBe("v9.9.9");
    expect(readFileSync(join(installDir, "bin", "agent"), "utf8")).toBe(POSIX_CURRENT_SHIM);
    // The flat binary is superseded and swept post-flip; the flat SHELL payload
    // is spared -- nothing in the update rewires the rc block that may still
    // source it (the 3.5.6 migration and `agent shell` own that).
    expect(existsSync(join(installDir, "bin", installedBinaryName()))).toBe(false);
    expect(existsSync(join(installDir, "shell"))).toBe(true);
  });

  skipWin("keeps exactly one previous version and GCs everything older", async () => {
    writeRelease(RECORDING_BINARY);
    seedVersion("v9.9.6");
    seedVersion("v9.9.7");
    seedVersion("v9.9.8", "OLD");
    pointCurrentAt(installDir, "v9.9.8");

    await applyLocked("v9.9.8", { root: installDir, logger: quiet, childStdoutToStderr: true });

    expect(existsSync(join(installDir, VERSIONS_DIR, "v9.9.9"))).toBe(true);
    expect(existsSync(join(installDir, VERSIONS_DIR, "v9.9.8"))).toBe(true); // the rollback keep
    expect(existsSync(join(installDir, VERSIONS_DIR, "v9.9.7"))).toBe(false);
    expect(existsSync(join(installDir, VERSIONS_DIR, "v9.9.6"))).toBe(false);

    // ROLLBACK: the kept previous version is actually usable -- pointing the
    // link back at it dispatches its binary again.
    pointCurrentAt(installDir, "v9.9.8");
    expect(
      readFileSync(join(installDir, CURRENT_LINK, "bin", installedBinaryName()), "utf8"),
    ).toBe("OLD");
  });

  skipWin("a provision that exits 0 without the manifest still aborts pre-flip", async () => {
    // Exit codes approximate; the per-version manifest is the postcondition.
    // A soft no-op `install` must never see its version committed.
    writeRelease(SOFT_NOOP_BINARY);
    seedVersion("v9.9.8", "OLD");
    pointCurrentAt(installDir, "v9.9.8");

    await expect(
      applyLocked("v9.9.8", { root: installDir, logger: quiet, childStdoutToStderr: true }),
    ).rejects.toThrow("no valid install manifest");

    expect(readCurrentVersionName(installDir)).toBe("v9.9.8");
    expect(existsSync(join(installDir, VERSIONS_DIR, "v9.9.9"))).toBe(false);
  });

  skipWin("a provision whose manifest names the wrong release aborts pre-flip", async () => {
    writeRelease(WRONG_VERSION_BINARY);
    seedVersion("v9.9.8", "OLD");
    pointCurrentAt(installDir, "v9.9.8");

    await expect(
      applyLocked("v9.9.8", { root: installDir, logger: quiet, childStdoutToStderr: true }),
    ).rejects.toThrow("provisioned version 0.0.1, not the v9.9.9 release");

    expect(readCurrentVersionName(installDir)).toBe("v9.9.8");
    expect(existsSync(join(installDir, VERSIONS_DIR, "v9.9.9"))).toBe(false);
  });

  skipWin("a failed shim refresh keeps the flat binary the old shims still dispatch", async () => {
    // The commit is best-effort about the shims, but while the OLD
    // adjacent-dispatch shims are live, the flat binary is what they invoke --
    // the GC must not take it out from under them.
    writeRelease(RECORDING_BINARY);
    writeFileSync(join(installDir, "bin", installedBinaryName()), "FLAT-LIVE");
    // A DIRECTORY at the shim path defeats both the rename and the fallback write.
    mkdirSync(join(installDir, "bin", "agent"), { recursive: true });

    await applyLocked("v9.9.8", { root: installDir, logger: quiet, childStdoutToStderr: true });

    expect(readCurrentVersionName(installDir)).toBe("v9.9.9"); // committed regardless
    expect(readFileSync(join(installDir, "bin", installedBinaryName()), "utf8")).toBe(
      "FLAT-LIVE",
    );
  });

  skipWin("a provision failure aborts BEFORE the flip: the old version stays live", async () => {
    writeRelease(FAILING_PROVISION_BINARY);
    seedVersion("v9.9.8", "OLD");
    pointCurrentAt(installDir, "v9.9.8");

    await expect(
      applyLocked("v9.9.8", { root: installDir, logger: quiet, childStdoutToStderr: true }),
    ).rejects.toThrow("failed to lay down its runtime files");

    // Nothing was committed: current still names the old version, the
    // half-prepared version dir is gone, and no migration ran.
    expect(readCurrentVersionName(installDir)).toBe("v9.9.8");
    expect(existsSync(join(installDir, VERSIONS_DIR, "v9.9.9"))).toBe(false);
    expect(invocations()).toEqual([
      `${join(installDir, VERSIONS_DIR, "v9.9.9")} install --assets-only`,
    ]);
    expect(stagingDirs()).toEqual([]);
  });

  skipWin("refuses a binary the release manifest does not vouch for", async () => {
    writeRelease(RECORDING_BINARY, "f".repeat(64));
    seedVersion("v9.9.8", "OLD");
    pointCurrentAt(installDir, "v9.9.8");

    await expect(
      applyLocked("v9.9.8", { root: installDir, logger: quiet }),
    ).rejects.toThrow("SHA256 verification failed");

    // Nothing was staged or committed, and the staging directory is gone.
    expect(readCurrentVersionName(installDir)).toBe("v9.9.8");
    expect(existsSync(join(installDir, VERSIONS_DIR, "v9.9.9"))).toBe(false);
    expect(stagingDirs()).toEqual([]);
  });

  skipWin("refuses when current already points at the target version", async () => {
    // Releases only move forward; `current` naming the target while the version
    // check said "behind" means a corrupt layout -- refuse rather than guess.
    writeRelease(RECORDING_BINARY);
    seedVersion("v9.9.9", "ALREADY");
    pointCurrentAt(installDir, "v9.9.9");

    await expect(
      applyLocked("v9.9.8", { root: installDir, logger: quiet }),
    ).rejects.toThrow(
      "already points at v9.9.9; to refresh this version in place, re-run `agent install`",
    );
    // The live version dir was NOT clobbered by staging.
    expect(
      readFileSync(
        join(installDir, VERSIONS_DIR, "v9.9.9", "bin", installedBinaryName()),
        "utf8",
      ),
    ).toBe("ALREADY");
  });

  skipWin("leaves no staging directory behind on success", async () => {
    writeRelease(RECORDING_BINARY);
    await applyLocked("v9.9.8", { root: installDir, logger: quiet, childStdoutToStderr: true });
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

describe("resolveProvenanceDecision", () => {
  test("the flag beats the resolved config, and each skip names its opt-out", () => {
    expect(resolveProvenanceDecision(true, false)).toEqual({ kind: "verify" });
    expect(resolveProvenanceDecision(false, true)).toEqual({ kind: "skip", via: "--no-verify" });
    expect(resolveProvenanceDecision(undefined, false)).toEqual({
      kind: "skip",
      via: "verify-provenance",
    });
    expect(resolveProvenanceDecision(undefined, true)).toEqual({ kind: "verify" });
  });
});

/** Staging dirs applyUpdate creates inside the install root (rename needs one
 *  filesystem), which must never outlive the call. */
function stagingDirs(): string[] {
  return [...Deno.readDirSync(installDir)]
    .filter((e) => e.name.startsWith(".update-"))
    .map((e) => e.name);
}
