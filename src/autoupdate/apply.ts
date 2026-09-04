// Apply a resolved release with a prepare-then-commit pipeline over the
// versioned install layout (src/install/installer.ts owns the layout):
//
//   1. download + verify into a staging dir inside the install root: the
//      SHA256 against checksums.txt first (integrity, cheap, and its failure
//      message is the actionable one), then the release's Sigstore
//      build-provenance attestation (origin; src/install/attestation.ts says
//      why both), unless the caller decided to skip it,
//   2. STAGE the verified binary into `<top>/versions/vNEW/bin/`,
//   3. PROVISION: run the NEW binary's `install --assets-only` INSIDE that
//      version root (aimed with COPILOT_ENV_INSTALL_ROOT), so the release that
//      owns the assets writes them -- while the OLD version is still live,
//   4. COMMIT: flip the `current` link (and refresh the top-level shims).
//
// Any failure BEFORE the flip leaves the old version fully live and removes the
// half-prepared version dir; nothing pre-commit is best-effort. A failure OF
// the flip itself also leaves the old version live (the link is replaced
// atomically on POSIX; Windows restores the old junction on a failed create,
// except a double fault -- restore failing too -- which leaves the link absent
// and says so in the error), with the fully-provisioned new version dir left
// inert on disk -- a retry's staging removes it. Only the post-flip steps are
// best-effort: `agent migrate` on the new binary, then the GC that keeps
// exactly ONE previous version for rollback -- the flip has already moved the
// install forward, so failing there would strand it instead of retrying.
//
// The one update implementation, shared by `agent update` (src/commands/update.ts)
// and the autoupdate preflight (./preflight.ts). Callers own the up-to-date /
// `--check` / dev-checkout gates.
//
// The pipeline stages hand branded tokens forward (the brand is module-private,
// so a token can only come from the real stage function). That is what makes
// "committed a version nobody provisioned" unrepresentable rather than merely
// untrue today:
//
//   download -> Downloaded -> verify -> Verified -> attest -> Attested
//     -> stage -> Staged -> provision -> Provisioned -> commit -> Committed
//     -> (migrate, GC)
import { spawnSync, type StdioOptions } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { consola } from "consola";

import {
  ATTESTATION_NAME,
  type AttestedSubject,
  cannotVerifyMessage,
} from "../install/attestation.ts";
import {
  type Checksums,
  expectedDigest,
  fileSha256,
  parseChecksums,
} from "../install/checksums.ts";
import {
  classifyInstallRoot,
  currentLinkPath,
  INSTALL_ROOT_ENV,
  isCheckoutShapedRoot,
  pointCurrentAt,
  readCurrentVersionName,
  removeFlatArtifacts,
  removeFlatBinaryResidue,
  removeVersionDirsExcept,
  versionDirName,
  versionRootPath,
  writeTopLevelShims,
} from "../install/installer.ts";
import type { Release } from "../install/resolve-release.ts";
import { currentReleaseTarget, installedBinaryName, releaseAssetName } from "../install/targets.ts";
import type { HeldUpdateLock } from "./lock.ts";
import { errMessage } from "../utils/error.ts";
import { PROJECT_ROOT, readInstallManifest } from "../utils/root.ts";
import { stripV } from "../utils/semver.ts";

const REPO = "Vivswan/copilot-env";
const CHECKSUMS_NAME = "checksums.txt";

/** Points the download at a directory or base URL instead of the GitHub release.
 *  The same hook install.sh / install.ps1 honor, so a smoke test can drive the
 *  whole update against locally built artifacts. */
const DOWNLOAD_BASE_ENV = "COPILOT_ENV_DOWNLOAD_BASE";

/** Minimal sink so the preflight can route progress to a stderr-only logger. */
interface UpdateLogger {
  warn(message: string): void;
  success(message: string): void;
}

/** Verifies a release's attestation.json text against the digests about to be
 *  installed; rejects with the attestation.ts wording. Injectable for tests. */
export type ProvenanceVerifier = (
  tag: string,
  bundleJson: string,
  required: readonly AttestedSubject[],
) => Promise<void>;

/**
 * The caller's ONE decision about build-provenance verification, resolved at
 * the boundary (flag > stored config > default, see resolveProvenanceDecision)
 * and carried into the pipeline, so no stage re-derives it and no caller can
 * forget it (the option is required). Skipping records WHICH opt-out did it,
 * because the warning names the way back.
 */
export type ProvenanceDecision =
  | { kind: "verify"; verifier?: ProvenanceVerifier }
  | { kind: "skip"; via: "--no-verify" | "verify-provenance" };

/** flag (`--verify` / `--no-verify`) > the resolved `verify-provenance` config
 *  (stored value, else its default: verify). */
export function resolveProvenanceDecision(
  flag: boolean | undefined,
  configEnabled: boolean,
): ProvenanceDecision {
  if (flag === true) return { kind: "verify" };
  if (flag === false) return { kind: "skip", via: "--no-verify" };
  return configEnabled ? { kind: "verify" } : { kind: "skip", via: "verify-provenance" };
}

/** The real verifier, loaded on first use: the sigstore stack is well over a
 *  megabyte of CommonJS and `agent env` runs at every shell start. */
const defaultVerifier: ProvenanceVerifier = async (tag, bundleJson, required) => {
  const { verifyReleaseProvenance } = await import("../install/provenance.ts");
  await verifyReleaseProvenance(tag, bundleJson, required);
};

// Stage tokens. The brand is a module-private symbol, so no caller outside this
// file can fabricate one and skip a stage.
declare const stageBrand: unique symbol;

interface Downloaded {
  readonly [stageBrand]: "downloaded";
  /** The downloaded binary, still in the temp directory. */
  readonly path: string;
  /** Its release-asset name, i.e. the key to look up in the manifest. */
  readonly asset: string;
  readonly checksums: Checksums;
  /** The downloaded checksums.txt itself: attested alongside the binary. */
  readonly checksumsPath: string;
  /** Where the release files came from, for the attestation fetched later. */
  readonly source: DownloadSource;
  /** The staging dir the attestation lands in. */
  readonly dir: string;
}

interface Verified {
  readonly [stageBrand]: "verified";
  readonly path: string;
  readonly asset: string;
  readonly sha256: string;
  readonly checksumsSha256: string;
  readonly source: DownloadSource;
  readonly dir: string;
}

interface Attested {
  readonly [stageBrand]: "attested";
  readonly path: string;
  readonly sha256: string;
}

interface Staged {
  readonly [stageBrand]: "staged";
  /** The new binary, on disk inside its NOT-yet-live version root. */
  readonly binary: string;
  readonly versionName: string;
  readonly versionRoot: string;
  /** The version-dir name `current` pointed at before this update -- the
   *  rollback candidate the GC keeps -- or null (first versioned update). */
  readonly previous: string | null;
}

interface Provisioned {
  readonly [stageBrand]: "provisioned";
  readonly binary: string;
  readonly versionName: string;
  readonly previous: string | null;
}

interface Committed {
  readonly [stageBrand]: "committed";
  readonly binary: string;
  readonly versionName: string;
  readonly previous: string | null;
  /** Whether the top shims now dispatch through the link (or the top is a
   *  checkout, whose bin/agent is not ours). While false, the pre-versioned
   *  adjacent-dispatch shims may still be live -- the flat binary they invoke
   *  must then survive the GC. */
  readonly shimsRefreshed: boolean;
}

/** Where to fetch a release file from: a local directory or a URL prefix. */
type DownloadSource =
  | { kind: "directory"; path: string }
  | { kind: "url"; base: string };

function downloadSource(tag: string): DownloadSource {
  const override = process.env[DOWNLOAD_BASE_ENV];
  if (override) {
    // A directory override is what CI and the installer e2e use; anything else
    // is treated as a base URL (mirrors install.sh's `[ -d ... ]` branch).
    try {
      if (Deno.statSync(override).isDirectory) return { kind: "directory", path: override };
    } catch {
      // not a path on this machine: fall through and treat it as a URL
    }
    return { kind: "url", base: override.replace(/\/+$/, "") };
  }
  return { kind: "url", base: `https://github.com/${REPO}/releases/download/${tag}` };
}

/** Fetch one release file into `dest`, streaming rather than buffering: the
 *  binaries run to tens of megabytes. */
async function fetchReleaseFile(source: DownloadSource, name: string, dest: string): Promise<void> {
  if (source.kind === "directory") {
    copyFileSync(join(source.path, name), dest);
    return;
  }
  const url = `${source.base}/${name}`;
  const res = await fetch(url, { headers: { "User-Agent": "copilot-env" } });
  if (!res.ok || !res.body) {
    throw new Error(`failed to download ${name} (HTTP ${res.status})`);
  }
  using file = await Deno.open(dest, { write: true, create: true, truncate: true });
  await res.body.pipeTo(file.writable);
}

/** Stage 1: pull this platform's binary and the release manifest into `dir`. */
async function download(tag: string, dir: string): Promise<Downloaded> {
  const target = currentReleaseTarget();
  if (!target) {
    throw new Error(
      `copilot-env ships no compiled binary for ${process.platform}/${process.arch}.`,
    );
  }
  const asset = releaseAssetName(target);
  const source = downloadSource(tag);
  const path = join(dir, asset);
  await fetchReleaseFile(source, asset, path);
  const manifest = join(dir, CHECKSUMS_NAME);
  await fetchReleaseFile(source, CHECKSUMS_NAME, manifest);
  return {
    path,
    asset,
    checksums: parseChecksums(readFileSync(manifest, "utf8")),
    checksumsPath: manifest,
    source,
    dir,
  } as Downloaded;
}

/** Stage 2: hash what actually landed and refuse anything the release manifest
 *  does not vouch for. */
async function verify(downloaded: Downloaded): Promise<Verified> {
  const expected = expectedDigest(downloaded.checksums, downloaded.asset);
  const actual = await fileSha256(downloaded.path);
  if (actual !== expected) {
    throw new Error(
      `SHA256 verification failed for ${downloaded.asset}: expected ${expected}, got ${actual}`,
    );
  }
  return {
    path: downloaded.path,
    asset: downloaded.asset,
    sha256: actual,
    checksumsSha256: await fileSha256(downloaded.checksumsPath),
    source: downloaded.source,
    dir: downloaded.dir,
  } as Verified;
}

/**
 * Stage 2b: prove ORIGIN, not just integrity -- the binary AND the manifest it
 * was checked against must both be subjects of the release's attestation, and
 * the attestation must be signed by our release workflow. It runs AFTER the
 * checksum stage on purpose: a corrupt download is reported as the cheap
 * integrity failure, never as a provenance verdict. Fetching the attestation
 * belongs here too, so a missing bundle (the fail-closed case) can only be
 * reported for bytes that already passed the manifest. Skipping is the
 * caller's recorded decision and is said out loud, naming the way back.
 */
async function attest(
  verified: Verified,
  tag: string,
  decision: ProvenanceDecision,
  logger: UpdateLogger,
): Promise<Attested> {
  if (decision.kind === "skip") {
    logger.warn(
      decision.via === "--no-verify"
        ? "Skipping build-provenance verification (--no-verify)."
        : "Skipping build-provenance verification (verify-provenance is false; " +
          "`agent config --del verify-provenance` restores it).",
    );
    return { path: verified.path, sha256: verified.sha256 } as Attested;
  }
  const bundlePath = join(verified.dir, ATTESTATION_NAME);
  try {
    await fetchReleaseFile(verified.source, ATTESTATION_NAME, bundlePath);
  } catch (e) {
    throw new Error(
      cannotVerifyMessage(tag, `${ATTESTATION_NAME} could not be fetched (${errMessage(e)})`),
    );
  }
  const verifier = decision.verifier ?? defaultVerifier;
  await verifier(tag, readFileSync(bundlePath, "utf8"), [
    { name: verified.asset, sha256: verified.sha256 },
    { name: CHECKSUMS_NAME, sha256: verified.checksumsSha256 },
  ]);
  logger.success(
    "Build provenance verified: attested by GitHub Actions for Vivswan/copilot-env " +
      "(release.yml@refs/heads/main).",
  );
  return { path: verified.path, sha256: verified.sha256 } as Attested;
}

/**
 * Stage 3: place the attested binary into its own version root,
 * `<top>/versions/<versionName>/bin/` -- a rename, since the staging dir lives
 * inside the same filesystem. The OLD version's files are never touched, so
 * there is no running-image problem on any platform: the running binary lives
 * in ITS version dir, and this write happens in a brand-new one (a stale dir
 * from a crashed earlier attempt is removed first; it is never `current`).
 */
function stage(attested: Attested, top: string, versionName: string): Staged {
  const previous = readCurrentVersionName(top);
  if (previous === versionName) {
    throw new Error(
      `refusing to update: ${currentLinkPath(top)} already points at ${versionName}; ` +
        "to refresh this version in place, re-run `agent install`",
    );
  }
  const versionRoot = versionRootPath(top, versionName);
  rmSync(versionRoot, { recursive: true, force: true });
  const binDir = join(versionRoot, "bin");
  mkdirSync(binDir, { recursive: true });
  const binary = join(binDir, installedBinaryName());
  if (process.platform !== "win32") chmodSync(attested.path, 0o755);
  renameSync(attested.path, binary);
  return { binary, versionName, versionRoot, previous } as Staged;
}

/**
 * Stage 4: run the NEW binary's `install --assets-only` INSIDE its version
 * root, aimed there explicitly -- the new release is the only thing that knows
 * its own runtime files, and the aim must beat any root the binary would
 * derive (the `current` link still names the OLD version here). Exit 0 is not
 * trusted alone: the per-version manifest the materialization writes LAST is
 * the postcondition, and its version must be the release being applied. A
 * failure is FATAL to the update: nothing has been committed, the old version
 * is live.
 */
function provision(staged: Staged, stdio: StdioOptions): Provisioned {
  const result = spawnSync(staged.binary, ["install", "--assets-only"], {
    cwd: staged.versionRoot,
    stdio,
    env: { ...process.env, [INSTALL_ROOT_ENV]: staged.versionRoot },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      "the new version failed to lay down its runtime files; the current version is untouched",
    );
  }
  const manifest = readInstallManifest(staged.versionRoot);
  if (manifest.kind !== "valid") {
    throw new Error(
      "the new version reported success but wrote no valid install manifest; " +
        "the current version is untouched",
    );
  }
  if (versionDirName(manifest.manifest.version) !== staged.versionName) {
    throw new Error(
      `the staged binary provisioned version ${manifest.manifest.version}, not the ` +
        `${staged.versionName} release being applied; the current version is untouched`,
    );
  }
  return {
    binary: staged.binary,
    versionName: staged.versionName,
    previous: staged.previous,
  } as Provisioned;
}

/**
 * Stage 5, THE commit: flip `current` at the fully-provisioned version root,
 * then refresh the stable top-level shims (identical text is skipped, so this
 * is a no-op on healthy versioned installs and a repair on a flat root or a
 * crashed earlier commit). The shim refresh is best-effort: the flip has
 * already landed, and a locked shim file must not fail a committed update.
 * A checkout-shaped root (`--force` on a dev clone) keeps its own bin/agent --
 * that file is source.
 */
function commit(provisioned: Provisioned, top: string, logger: UpdateLogger): Committed {
  pointCurrentAt(top, provisioned.versionName);
  let shimsRefreshed = true;
  if (!isCheckoutShapedRoot(top)) {
    try {
      writeTopLevelShims(top);
    } catch (error) {
      shimsRefreshed = false;
      logger.warn(`Could not refresh the launcher shims: ${errMessage(error)}`);
    }
  }
  return {
    binary: provisioned.binary,
    versionName: provisioned.versionName,
    previous: provisioned.previous,
    shimsRefreshed,
  } as Committed;
}

/** Run the COMMITTED binary for a post-flip step, rooted at the `current` link
 *  (the aim must beat derivation here too: a checkout-shaped top would derive
 *  wrong, and the migrations must see the finished layout). */
function runNewBinary(
  committed: Committed,
  top: string,
  args: string[],
  stdio: StdioOptions,
): number | null {
  const result = spawnSync(committed.binary, args, {
    cwd: top,
    stdio,
    env: { ...process.env, [INSTALL_ROOT_ENV]: currentLinkPath(top) },
  });
  if (result.error) throw result.error;
  return result.status;
}

export interface ApplyUpdateOptions {
  /** Where progress/warnings go (default: the global stdout consola). */
  logger?: UpdateLogger;
  /**
   * Send the child processes' stdout to stderr (so migration output can't
   * pollute stdout). The preflight sets this to protect the `agent env` stdout
   * contract on platforms where the launcher can't redirect streams.
   */
  childStdoutToStderr?: boolean;
  /** The install root to update. Defaults to the live one. */
  root?: string;
  /** Verify the release's build provenance, or skip it -- decided by the caller
   *  (see ProvenanceDecision), never defaulted here. */
  provenance: ProvenanceDecision;
}

/** `_lock` is the caller's evidence that the update lock is held (only withUpdateLock's
 *  held branch mints one), so every apply happens inside that lock's scope. */
export async function applyUpdate(
  current: string,
  target: Release,
  _lock: HeldUpdateLock,
  opts: ApplyUpdateOptions,
): Promise<void> {
  const logger = opts.logger ?? consola;
  const root = opts.root ?? PROJECT_ROOT;
  // ["ignore", 2, 2] => stdin closed, child stdout AND stderr both go to our fd2.
  const stdio: StdioOptions = opts.childStdoutToStderr ? ["ignore", 2, 2] : "inherit";

  const shape = classifyInstallRoot(root);
  const top = shape.top;
  const versionName = versionDirName(target.tag);
  const versionRoot = versionRootPath(top, versionName);

  // Stage the download inside the install root, not the system temp dir: the
  // placement into the version dir is a rename, which needs one filesystem.
  const staging = mkdtempSync(join(top, ".update-"));
  let provisioned: Provisioned;
  try {
    provisioned = provision(
      stage(
        await attest(
          await verify(await download(target.tag, staging)),
          target.tag,
          opts.provenance,
          logger,
        ),
        top,
        versionName,
      ),
      stdio,
    );
  } catch (error) {
    // Pre-commit failure: the old version is fully live; remove the
    // half-prepared version dir so a retry starts clean. (The guard is
    // paranoia -- `current` cannot name the new version before commit.)
    if (readCurrentVersionName(top) !== versionName) {
      rmSync(versionRoot, { recursive: true, force: true });
    }
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  const committed = commit(provisioned, top, logger);

  // Everything after the flip is best-effort: `current` has already moved
  // forward, so a later `agent update` would see "up to date" and never retry --
  // failing here would strand the install instead of fixing anything.
  try {
    if (
      runNewBinary(committed, top, ["migrate", stripV(current), stripV(target.tag)], stdio) !== 0
    ) {
      logger.warn("Post-update migrations reported a problem; see the output above.");
    }
  } catch (error) {
    logger.warn(`Post-update migrations could not run: ${errMessage(error)}`);
  }

  // GC: keep the new version plus exactly ONE previous (the rollback
  // candidate); everything older goes, along with pre-versioned binary residue
  // in <top>/bin and -- when this update versioned a flat root -- the flat
  // runtime files the new layout supersedes. The flat shell payload is spared:
  // nothing here rewires the rc block that may still source it (the 3.5.6
  // migration and `agent shell` own that), and a stale payload that works
  // beats a swept one a block still points at.
  const keep = new Set(
    committed.previous === null
      ? [committed.versionName]
      : [committed.versionName, committed.previous],
  );
  removeVersionDirsExcept(top, keep);
  // Only once the top shims dispatch through the link: while they are the old
  // adjacent-dispatch text, the flat binary AND its runtime assets are what
  // they invoke -- neither may go out from under them.
  if (committed.shimsRefreshed) {
    removeFlatBinaryResidue(top);
    if (shape.kind === "flat") removeFlatArtifacts(top, new Set(["shell"]));
  }

  logger.success(
    `Updated copilot-env ${current} -> ${target.tag}. Restart your agents to pick it up.`,
  );
}
