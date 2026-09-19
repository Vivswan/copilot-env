import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { crypto } from "@std/crypto";
import { join } from "node:path";
import {
  applyUpdate,
  type ApplyUpdateOptions,
  type ProvenanceVerifier,
  resolveProvenanceDecision,
} from "../src/autoupdate/apply.ts";
import { ATTESTATION_NAME } from "../src/install/attestation.ts";
import { parseChecksums } from "../src/install/checksums.ts";
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
import { afterEach, beforeEach, describe, expect, tempDir, test } from "./helpers/testing.ts";

// The update is prepare-then-commit, so a pre-flip failure leaves the old version fully live:
//   download -> verify against the manifest -> attest (injected verifier) -> STAGE into its
//   own version root -> PROVISION by running the new binary's `install --assets-only` there
//   -> COMMIT by flipping the `current` link
// The real verifier needs the Sigstore trust root (test/provenance.test.ts). Downloads are
// redirected at a local directory through COPILOT_ENV_DOWNLOAD_BASE, the same hook install.sh
// and the CI smokes use.

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

/** Records every invocation with the root it was aimed at, and writes the per-version
 *  manifest `install` must leave behind (the provision postcondition). It lives at
 *  <top>/versions/<v>/bin/, hence the three hops up to the log. */
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
  root = tempDir("copilot-update-");
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

test("parseChecksums reads shasum and sha256sum output, binary-mode names included, and skips malformed lines", () => {
  const a = "a".repeat(64);
  const b = "b".repeat(64);
  const c = "c".repeat(64);
  const rows: { name: string; text: string; parsed: [string, string][] }[] = [
    // The leading "*" marks binary mode and is not part of the name.
    {
      name: "text and binary mode",
      text:
        `${a}  copilot-env-x86_64-unknown-linux-gnu\n${b} *copilot-env-x86_64-pc-windows-msvc.exe\n`,
      parsed: [["copilot-env-x86_64-unknown-linux-gnu", a], [
        "copilot-env-x86_64-pc-windows-msvc.exe",
        b,
      ]],
    },
    {
      name: "malformed lines are skipped, never thrown",
      text: `nonsense\n\nzz  bad-digest\n${c}  good\n`,
      parsed: [["good", c]],
    },
  ];
  for (const { name, text, parsed } of rows) {
    expect([...parseChecksums(text)], name).toEqual(parsed);
  }
});

test("release targets: each shipped (platform, arch) maps to its distinct triple and asset, null otherwise", () => {
  // The triples are the release-asset names, so they are external contracts; an unsupported
  // pair must resolve to null, never a guess.
  const rows: {
    platform: string;
    arch: string;
    triple: string | null;
    asset?: string;
    binary?: string;
  }[] = [
    {
      platform: "darwin",
      arch: "x64",
      triple: "x86_64-apple-darwin",
      asset: "copilot-env-x86_64-apple-darwin",
      binary: "copilot-env",
    },
    {
      platform: "darwin",
      arch: "arm64",
      triple: "aarch64-apple-darwin",
      asset: "copilot-env-aarch64-apple-darwin",
      binary: "copilot-env",
    },
    {
      platform: "linux",
      arch: "x64",
      triple: "x86_64-unknown-linux-gnu",
      asset: "copilot-env-x86_64-unknown-linux-gnu",
      binary: "copilot-env",
    },
    {
      platform: "linux",
      arch: "arm64",
      triple: "aarch64-unknown-linux-gnu",
      asset: "copilot-env-aarch64-unknown-linux-gnu",
      binary: "copilot-env",
    },
    {
      platform: "win32",
      arch: "x64",
      triple: "x86_64-pc-windows-msvc",
      asset: "copilot-env-x86_64-pc-windows-msvc.exe",
      binary: "copilot-env.exe",
    },
    { platform: "win32", arch: "arm64", triple: null },
    { platform: "aix", arch: "ppc64", triple: null },
    { platform: "linux", arch: "riscv64", triple: null },
  ];
  for (const { platform, arch, triple, asset, binary } of rows) {
    const why = `${platform}/${arch}`;
    const target = currentReleaseTarget(platform, arch);
    expect(target?.triple ?? null, why).toBe(triple);
    if (target) {
      expect(releaseAssetName(target), why).toBe(asset);
      expect(installedBinaryName(platform), why).toBe(binary);
    }
  }
  // Every shipped target has its own triple and asset: a duplicate would overwrite a release
  // asset on upload.
  const triples = RELEASE_TARGETS.map((t) => t.triple);
  const assets = RELEASE_TARGETS.map(releaseAssetName);
  expect(new Set(triples).size).toBe(RELEASE_TARGETS.length);
  expect(new Set(assets).size).toBe(RELEASE_TARGETS.length);
  expect(rows.filter((r) => r.triple !== null).map((r) => r.triple).sort()).toEqual(
    [...triples].sort(),
  );
  // If this fails, copilot-env cannot update itself on the machine running
  // the suite -- which is also a machine we claim to support.
  expect(currentReleaseTarget()).not.toBeNull();
});

describe("applyUpdate", () => {
  const target = { tag: "v9.9.9", dateSeconds: 0 };
  const quiet = { info: () => {}, warn: () => {}, success: () => {} };
  /** A verifier that accepts everything: the default here, so the existing cases
   *  run the full stage order (download -> verify -> attest -> ...) unchanged. */
  const acceptAll: ProvenanceVerifier = () => Promise.resolve({ signerIdentity: "test" });

  function apply(
    current: string,
    opts: Omit<ApplyUpdateOptions, "provenance"> & Partial<Pick<ApplyUpdateOptions, "provenance">>,
  ): Promise<void> {
    return applyUpdate(current, target, {
      provenance: { kind: "verify", verifier: acceptAll },
      ...opts,
    });
  }

  /** A logger that records what it was told. */
  function recordingLogger() {
    const infos: string[] = [];
    const warns: string[] = [];
    const successes: string[] = [];
    return {
      infos,
      warns,
      successes,
      logger: {
        info: (m: string) => infos.push(m),
        warn: (m: string) => warns.push(m),
        success: (m: string) => successes.push(m),
      },
    };
  }

  skipWin("hands the verifier the binary AND the manifest digests, then commits", async () => {
    const asset = writeRelease(RECORDING_BINARY);
    seedVersion("v9.9.8", "OLD");
    pointCurrentAt(installDir, "v9.9.8");
    const calls: Parameters<ProvenanceVerifier>[] = [];
    const { logger, successes } = recordingLogger();
    const signerIdentity = "https://github.com/example/publish.yml@refs/heads/main";

    await apply("v9.9.8", {
      root: installDir,
      logger,
      childStdoutToStderr: true,
      provenance: {
        kind: "verify",
        verifier: (...args) => {
          calls.push(args);
          return Promise.resolve({ signerIdentity });
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
    expect(successes).toContain(
      `Build provenance verified: attested by GitHub Actions for Vivswan/copilot-env (${signerIdentity}).`,
    );
  });

  test("a verifier verdict aborts BEFORE staging: nothing runs, nothing moves", async () => {
    writeRelease(RECORDING_BINARY);
    seedVersion("v9.9.8", "OLD");
    pointCurrentAt(installDir, "v9.9.8");

    await expect(
      apply("v9.9.8", {
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
    // The manifest disowns the binary. With the attestation ALSO missing, the checksum stage
    // must still win, so the message is the actionable SHA256 one and the opt-outs (which only
    // the fail-closed message carries) stay unsaid.
    for (const attestation of ["present", "missing"] as const) {
      writeRelease(RECORDING_BINARY, "f".repeat(64));
      if (attestation === "missing") rmSync(join(releaseDir, ATTESTATION_NAME));
      seedVersion("v9.9.8", "OLD");
      pointCurrentAt(installDir, "v9.9.8");

      const err = await apply("v9.9.8", { root: installDir, logger: quiet })
        .catch((e: unknown) => e as Error);
      expect((err as Error).message, attestation).toContain("SHA256 verification failed");
      expect((err as Error).message, attestation).not.toContain("--no-verify");
      expect(readCurrentVersionName(installDir), attestation).toBe("v9.9.8");
      expect(existsSync(join(installDir, VERSIONS_DIR, "v9.9.9")), attestation).toBe(false);
      expect(stagingDirs(), attestation).toEqual([]);
    }
  });

  test("a missing attestation.json fails closed, naming both opt-outs, before any verifier runs", async () => {
    writeRelease(RECORDING_BINARY);
    rmSync(join(releaseDir, ATTESTATION_NAME));
    seedVersion("v9.9.8", "OLD");
    pointCurrentAt(installDir, "v9.9.8");
    let verifierCalls = 0;

    const err = await apply("v9.9.8", {
      root: installDir,
      logger: quiet,
      provenance: {
        kind: "verify",
        verifier: () => {
          verifierCalls++;
          return Promise.resolve({ signerIdentity: "test" });
        },
      },
    }).catch((e: unknown) => e as Error);

    expect((err as Error).message).toContain("cannot verify the build provenance of v9.9.9");
    expect((err as Error).message).toContain("attestation.json could not be fetched");
    expect((err as Error).message).toContain("--no-verify");
    expect((err as Error).message).toContain("agent config set update.verify-provenance false");
    expect(verifierCalls).toBe(0);
    expect(readCurrentVersionName(installDir)).toBe("v9.9.8");
    expect(stagingDirs()).toEqual([]);
  });

  skipWin(
    "a skipped verification says so on the logger, naming the opt-out and its way back",
    async () => {
      const rows: {
        via: "--no-verify" | "verify-provenance";
        attestation: "present" | "missing";
        warns: (warns: string[]) => void;
      }[] = [
        // The flag needs no attestation at all.
        {
          via: "--no-verify",
          attestation: "missing",
          warns: (warns) =>
            expect(warns).toEqual(["Skipping build-provenance verification (--no-verify)."]),
        },
        {
          via: "verify-provenance",
          attestation: "present",
          warns: (warns) => {
            expect(warns).toHaveLength(1);
            expect(warns[0]).toContain("update.verify-provenance is false");
            expect(warns[0]).toContain("agent config unset update.verify-provenance");
          },
        },
      ];
      for (const { via, attestation, warns } of rows) {
        rmSync(installDir, { recursive: true, force: true });
        mkdirSync(join(installDir, "bin"), { recursive: true });
        writeRelease(RECORDING_BINARY);
        if (attestation === "missing") rmSync(join(releaseDir, ATTESTATION_NAME));
        seedVersion("v9.9.8", "OLD");
        pointCurrentAt(installDir, "v9.9.8");
        const recorder = recordingLogger();

        await apply("v9.9.8", {
          root: installDir,
          logger: recorder.logger,
          childStdoutToStderr: true,
          provenance: { kind: "skip", via },
        });

        expect(readCurrentVersionName(installDir), via).toBe("v9.9.9");
        warns(recorder.warns);
      }
    },
  );

  skipWin("stages, provisions inside the version root, then commits the flip", async () => {
    writeRelease(RECORDING_BINARY);
    seedVersion("v9.9.8", "OLD");
    pointCurrentAt(installDir, "v9.9.8");
    const { logger, infos } = recordingLogger();

    await apply("v9.9.8", {
      root: installDir,
      logger,
      childStdoutToStderr: true,
    });

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

    // Reads THROUGH the link reach the new binary: the shim dispatch path.
    expect(readCurrentVersionName(installDir)).toBe("v9.9.9");
    expect(
      readFileSync(join(installDir, CURRENT_LINK, "bin", installedBinaryName()), "utf8"),
    ).toBe(RECORDING_BINARY);
    expect(readFileSync(join(installDir, "bin", "agent"), "utf8")).toBe(POSIX_CURRENT_SHIM);
    // The shim writes are announced on the UPDATE's logger (stderr-only from the
    // preflight), never on the global stdout consola.
    expect(infos).toEqual(
      ["agent", "agent.ps1"].map((shim) => `Wrote launcher shim ${join(installDir, "bin", shim)}`),
    );

    // Both handoffs ran the NEW binary: the provision INSIDE its version root (pre-flip), the
    // migrations at the current link (post-flip).
    expect(invocations()).toEqual([
      `${versionRoot} install --assets-only`,
      `${join(installDir, CURRENT_LINK)} migrate 9.9.8 9.9.9`,
    ]);
    // The staging dir (inside the root, so the rename stays on one filesystem) never outlives
    // the call.
    expect(stagingDirs()).toEqual([]);
  });

  skipWin(
    "a first update into a root with no current link provisions, flips, and leaves no staging",
    async () => {
      writeRelease(RECORDING_BINARY);

      await apply("v9.9.8", { root: installDir, logger: quiet, childStdoutToStderr: true });

      expect(readCurrentVersionName(installDir)).toBe("v9.9.9");
      expect(
        readFileSync(join(installDir, CURRENT_LINK, "bin", installedBinaryName()), "utf8"),
      ).toBe(RECORDING_BINARY);
      expect(stagingDirs()).toEqual([]);
    },
  );

  skipWin("keeps exactly one previous version and GCs everything older", async () => {
    writeRelease(RECORDING_BINARY);
    seedVersion("v9.9.6");
    seedVersion("v9.9.7");
    seedVersion("v9.9.8", "OLD");
    pointCurrentAt(installDir, "v9.9.8");

    await apply("v9.9.8", { root: installDir, logger: quiet, childStdoutToStderr: true });

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

  skipWin(
    "a provision that fails, exits 0 without the manifest, or provisions the wrong release aborts BEFORE the flip",
    async () => {
      // Exit codes approximate; the per-version manifest naming this release is the postcondition.
      // Whatever the failure, the old version stays live and nothing is left staged.
      const versionRoot = join(installDir, VERSIONS_DIR, "v9.9.9");
      const rows: { name: string; binary: string; error: string; invocations: string[] | null }[] =
        [
          {
            name: "soft no-op install",
            binary: SOFT_NOOP_BINARY,
            error: "no valid install manifest",
            invocations: [`${versionRoot} install --assets-only`],
          },
          {
            name: "manifest for the wrong release",
            binary: WRONG_VERSION_BINARY,
            error: "provisioned version 0.0.1, not the v9.9.9 release",
            invocations: null, // this stand-in records nothing
          },
          {
            name: "failing install",
            binary: FAILING_PROVISION_BINARY,
            error: "failed to lay down its runtime files",
            invocations: [`${versionRoot} install --assets-only`],
          },
        ];
      for (const { name, binary, error, invocations: expected } of rows) {
        rmSync(installDir, { recursive: true, force: true });
        mkdirSync(join(installDir, "bin"), { recursive: true });
        writeRelease(binary);
        seedVersion("v9.9.8", "OLD");
        pointCurrentAt(installDir, "v9.9.8");

        await expect(
          apply("v9.9.8", { root: installDir, logger: quiet, childStdoutToStderr: true }),
          name,
        ).rejects.toThrow(error);

        expect(readCurrentVersionName(installDir), name).toBe("v9.9.8");
        expect(existsSync(versionRoot), name).toBe(false);
        expect(stagingDirs(), name).toEqual([]);
        if (expected !== null) expect(invocations(), name).toEqual(expected);
      }
    },
  );

  skipWin("refuses when current already points at the target version", async () => {
    // Releases only move forward; `current` naming the target while the version
    // check said "behind" means a corrupt layout -- refuse rather than guess.
    writeRelease(RECORDING_BINARY);
    seedVersion("v9.9.9", "ALREADY");
    pointCurrentAt(installDir, "v9.9.9");

    await expect(
      apply("v9.9.8", { root: installDir, logger: quiet }),
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

  test("fails when the release has no asset for this platform", async () => {
    // A manifest that vouches for other platforms only.
    writeFileSync(join(releaseDir, "checksums.txt"), `${"a".repeat(64)}  agent-other\n`);
    writeFileSync(join(releaseDir, releaseAssetName(hostTarget())), "x");

    await expect(
      apply("v9.9.8", { root: installDir, logger: quiet }),
    ).rejects.toThrow(`checksums.txt has no entry for ${releaseAssetName(hostTarget())}`);
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
