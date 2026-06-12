// Patch the Codex *desktop app*'s bundled JS (inside app.asar) so it doesn't offer
// `image_generation` in Direct mode, and restore it in Proxy mode -- keeping the app
// consistent with the CLI's config.toml `[features]` toggle. The app gates the
// feature in its own minified bundle and ignores config.toml (see openai/codex#21952),
// hence the binary patch.
//
// BEST-EFFORT cosmetic polish: the config.toml write is the real contract, so every
// failure here only warns and never breaks `agent codex`. macOS + Windows only.
//
// VERSION-COUPLED: the gate's minified shape changes between Codex app releases, so
// the shapes live in a version-keyed table (GATE_SHAPES) -- each entry's regexes are
// validated against one known build. When Codex ships a new bundle the shape stops
// matching (-> a logged skip); re-verify against the new app.asar and APPEND a new
// GATE_SHAPES entry (keyed by its minVersion) -- older builds keep using older entries.
import * as fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createPackage,
  extractAll,
  extractFile,
  getRawHeader,
  listPackage,
  uncacheAll,
} from "@electron/asar";
import { execa } from "execa";
import { isRecord } from "../utils/json.ts";
import { createStderrLogger } from "../utils/logger.ts";
import { versionLessThan } from "../utils/semver.ts";
import { APP_NAME, CodexAppController } from "./app_control.ts";

const logger = createStderrLogger();

// --- versioned gate shapes (unit-tested) ------------------------------------

export type ImageGenPatchState = "patched" | "unpatched" | "absent";

/** A Codex-app gate shape and the version range it applies to. */
export interface GateShape {
  /** Applies to Codex app builds >= this version, until a higher entry supersedes it. */
  minVersion: string;
  /**
   * Inclusive upper bound: the newest Codex build this entry applies to. Leave
   * undefined for no ceiling. Set it once a future Codex build no longer needs the
   * patch (e.g. the app starts honoring config.toml) -- builds newer than this select
   * no shape and skip, so the patch auto-disables from that version on.
   */
  maxVersion?: string;
  /** Matches the un-guarded gate loop for this shape (loop var captured via `\2`). */
  patch: RegExp;
  /** Matches our guarded form for this shape (so it round-trips). */
  unpatch: RegExp;
}

/**
 * The Codex app enables each feature gate in a minified loop shaped like
 *   for(let n of ng) ln(e,n.gateName,{disableExposureLog:!0})&&(t[n.featureKey]=!0)
 * We insert a guard so the `image_generation` key is never enabled:
 *   ...&&n.featureKey!=="image_generation"&&(t[n.featureKey]=!0)
 * That minified shape CHANGES between Codex releases, so this is a TABLE keyed by the
 * oldest app build each shape applies to (verified by reading that build's app.asar).
 * `selectGateShape` picks the entry for the installed build. When a future Codex build
 * changes the shape, APPEND a new entry (don't edit shipped ones) with its minVersion
 * and freshly-verified regexes -- older builds keep using the older entry. When a build
 * no longer needs the patch at all, set that entry's `maxVersion` (the patch then
 * auto-disables for newer builds).
 *
 * The loop var + gate-check fn are minified (capture the loop var via a backref);
 * `[^)]*` tolerates extra gate-check args (e.g. the `{disableExposureLog:!0}` newer
 * builds added) and also matches an older arg-less shape. The `unpatch` regex accepts
 * "/`/' quoting so it also cleans the original shell script's backtick variant.
 */
export const GATE_SHAPES: GateShape[] = [
  {
    minVersion: "26.609.30741",
    patch:
      /(([A-Za-z_$][\w$]*)\.gateName[^)]*\)\s*&&\s*)(\(\s*[A-Za-z_$][\w$]*\[\s*\2\.featureKey\s*\]\s*=\s*!0\s*\))/,
    unpatch:
      /(([A-Za-z_$][\w$]*)\.gateName[^)]*\)\s*&&\s*)\2\.featureKey\s*!==\s*(?:"image_generation"|`image_generation`|'image_generation')\s*&&\s*(\(\s*[A-Za-z_$][\w$]*\[\s*\2\.featureKey\s*\]\s*=\s*!0\s*\))/,
  },
];

/**
 * The gate shape for an installed Codex app `version`: the entry with the greatest
 * `minVersion` that is still <= `version` and within the entry's `maxVersion` ceiling
 * (if any). Returns null when `version` is not a comparable `x.y.z` (so a garbage
 * Info.plist value never mis-selects), predates every entry, or sits above an entry's
 * maxVersion with no other match -- all mean "leave this build alone".
 */
export function selectGateShape(
  version: string,
  shapes: GateShape[] = GATE_SHAPES,
): GateShape | null {
  if (!/^\d+\.\d+\.\d+/.test(version.trim())) return null;
  let best: GateShape | null = null;
  for (const shape of shapes) {
    // "shape.minVersion <= version" is the same as "!(version < shape.minVersion)".
    if (versionLessThan(version, shape.minVersion)) continue;
    // "version <= shape.maxVersion" is the same as "!(shape.maxVersion < version)".
    if (shape.maxVersion !== undefined && versionLessThan(shape.maxVersion, version)) continue;
    if (best === null || versionLessThan(best.minVersion, shape.minVersion)) best = shape;
  }
  return best;
}

/** Classify a JS source for a shape: already guarded, un-guarded loop present, or neither. */
export function imageGenerationPatchState(src: string, shape: GateShape): ImageGenPatchState {
  if (shape.unpatch.test(src)) return "patched";
  if (shape.patch.test(src)) return "unpatched";
  return "absent";
}

/** Insert the image_generation guard (idempotent; no-op if already patched/absent). Pure. */
export function patchImageGenerationSource(src: string, shape: GateShape): string {
  if (imageGenerationPatchState(src, shape) !== "unpatched") return src;
  return src.replace(shape.patch, '$1$2.featureKey!=="image_generation"&&$3');
}

/** Remove the image_generation guard (idempotent; no-op if already clean/absent). Pure. */
export function unpatchImageGenerationSource(src: string, shape: GateShape): string {
  if (imageGenerationPatchState(src, shape) !== "patched") return src;
  return src.replace(shape.unpatch, "$1$3");
}

// --- app.asar location + version --------------------------------------------

interface AsarTarget {
  asarPath: string;
  version: string | null;
  /** macOS enforces app.asar integrity via Info.plist; true means a repack would brick launch. */
  integrityFused: boolean;
}

const ps = (script: string) =>
  execa("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { reject: false });

const PLIST_VERSION_RE = /CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/;

/** Resolve the Codex app's app.asar + version, or null (with a skip note) if not patchable. */
async function resolveAppAsar(): Promise<AsarTarget | null> {
  if (process.platform === "darwin") {
    const r = await execa(
      "osascript",
      ["-e", `POSIX path of (path to application "${APP_NAME}")`],
      { reject: false },
    );
    if (r.exitCode !== 0 || !r.stdout.trim()) return null;
    const bundle = r.stdout.trim().replace(/\/$/, "");
    const asarPath = join(bundle, "Contents", "Resources", "app.asar");
    if (!fs.existsSync(asarPath)) return null;
    let plist = "";
    try {
      plist = fs.readFileSync(join(bundle, "Contents", "Info.plist"), "utf8");
    } catch {
      // version stays null, integrity treated as absent
    }
    return {
      asarPath,
      version: plist.match(PLIST_VERSION_RE)?.[1]?.trim() ?? null,
      integrityFused: plist.includes("ElectronAsarIntegrity"),
    };
  }

  // Windows: prefer the running/installed exe path, then the NSIS default location.
  const script =
    `$p=(Get-Process -Name '${APP_NAME}' -ErrorAction SilentlyContinue|Select-Object -First 1).Path;` +
    `if(-not $p){$c=Join-Path $env:LOCALAPPDATA 'Programs\\${APP_NAME}\\${APP_NAME}.exe';if(Test-Path $c){$p=$c}}` +
    `if($p){Write-Output $p; Write-Output (Get-Item $p).VersionInfo.ProductVersion}else{exit 1}`;
  const r = await ps(script);
  if (r.exitCode !== 0 || !r.stdout.trim()) return null;
  const [exe, ver] = r.stdout.trim().split(/\r?\n/);
  if (!exe) return null;
  const asarPath = join(dirname(exe), "resources", "app.asar");
  if (/[\\/]WindowsApps[\\/]/i.test(asarPath)) {
    logger.info(
      "  Codex is installed as a packaged app (read-only) — skipping the image_generation app patch.",
    );
    return null;
  }
  if (!fs.existsSync(asarPath)) return null;
  // The integrity fuse lives in the exe on Windows; we can't cheaply detect it.
  return { asarPath, version: ver?.trim() || null, integrityFused: false };
}

// --- asar helpers -----------------------------------------------------------

/** True if any entry in the asar header is marked `unpacked` (then a repack is unsafe). */
function hasUnpackedEntries(node: unknown): boolean {
  if (!isRecord(node)) return false;
  if (node.unpacked === true) return true;
  if (isRecord(node.files)) {
    for (const child of Object.values(node.files)) {
      if (hasUnpackedEntries(child)) return true;
    }
  }
  return false;
}

/** Find the bundled JS file holding the feature-gate loop (filename hash varies). */
function findGateBundle(
  asarPath: string,
  shape: GateShape,
): { rel: string; state: ImageGenPatchState } | null {
  for (const f of listPackage(asarPath, { isPack: false })) {
    // Narrow to the webview asset bundles (the gate loop lives there) before reading.
    if (!/webview[\\/]assets[\\/].*\.js$/i.test(f)) continue;
    const rel = f.replace(/^[\\/]+/, "");
    let src: string;
    try {
      src = extractFile(asarPath, rel).toString("utf8");
    } catch {
      continue;
    }
    const state = imageGenerationPatchState(src, shape);
    if (state !== "absent") return { rel, state };
  }
  return null;
}

/** Best-effort clear of the Electron Code Cache so the new bundle is recompiled. */
function clearCodeCache(): void {
  const base =
    process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support", APP_NAME)
      : join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), APP_NAME);
  for (const dir of [join(base, "Code Cache"), join(base, "Default", "Code Cache")]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

// --- orchestration ----------------------------------------------------------

/**
 * Sync the Codex desktop app's `image_generation` gate to the resolved mode:
 * direct => patched out, proxy => restored. Best-effort and idempotent -- never
 * throws into the caller. Called by runCodex/runCodexHost after the config write.
 */
export async function syncCodexAppImageGeneration(direct: boolean): Promise<void> {
  try {
    await syncImpl(direct);
  } catch (e) {
    logger.warn(
      `  Could not sync the Codex app's image_generation toggle: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

async function syncImpl(direct: boolean): Promise<void> {
  // Opt-out escape hatch (and the guard that keeps the test suite from patching a
  // real installed Codex app): COPILOT_API_NO_APP_PATCH disables this entirely.
  if (process.env.COPILOT_API_NO_APP_PATCH) return;
  if (process.platform !== "darwin" && process.platform !== "win32") return; // no Codex app

  const target = await resolveAppAsar();
  if (!target) return; // not installed / not patchable -- resolveAppAsar already noted why
  const { asarPath, version, integrityFused } = target;

  // Version gate: only touch a build whose gate shape we've verified (GATE_SHAPES).
  // Unknown, garbage, or too-old versions select no shape and are left alone.
  if (version === null) {
    logger.info("  Couldn't read the Codex app version — skipping the image_generation app patch.");
    return;
  }
  const shape = selectGateShape(version);
  if (shape === null) {
    logger.info(
      `  Codex app ${version} has no verified image_generation gate shape — skipping (add it to GATE_SHAPES).`,
    );
    return;
  }
  if (integrityFused) {
    logger.info("  Codex enforces app.asar integrity — skipping the image_generation app patch.");
    return;
  }

  // Drop any cached asar header for this path so reads reflect the current archive.
  uncacheAll();
  if (hasUnpackedEntries(getRawHeader(asarPath).header) || fs.existsSync(`${asarPath}.unpacked`)) {
    logger.info(
      "  Codex app.asar has unpacked native files (unsafe to repack) — skipping the image_generation app patch.",
    );
    return;
  }

  const found = findGateBundle(asarPath, shape);
  if (!found) {
    logger.info(
      "  Couldn't locate the image_generation gate in this Codex version — skipping the app patch.",
    );
    return;
  }

  const desired: ImageGenPatchState = direct ? "patched" : "unpatched";
  if (found.state === desired) return; // already in the desired state -- no-op (the common case)

  // A change is needed: extract, transform the one file, repack, atomically replace.
  const tmpDir = fs.mkdtempSync(join(tmpdir(), "copilot-codex-asar-"));
  const tmpAsar = `${asarPath}.copilot-env-tmp`;
  try {
    extractAll(asarPath, tmpDir);
    const onDisk = join(tmpDir, ...found.rel.split(/[\\/]/));
    const src = fs.readFileSync(onDisk, "utf8");
    const next = direct
      ? patchImageGenerationSource(src, shape)
      : unpatchImageGenerationSource(src, shape);
    if (next === src) return; // nothing actually changed (idempotent guard)
    fs.writeFileSync(onDisk, next);

    // One-time safety backup of the pristine archive (only the un-guarded original).
    const origBackup = `${asarPath}.copilot-env-orig`;
    if (found.state === "unpatched" && !fs.existsSync(origBackup)) {
      try {
        fs.copyFileSync(asarPath, origBackup);
      } catch {
        // best-effort safety net
      }
    }

    await createPackage(tmpDir, tmpAsar);
    fs.renameSync(tmpAsar, asarPath); // same-dir rename => atomic, even if the app is running (macOS)
    uncacheAll(); // the on-disk archive changed -- invalidate @electron/asar's cached header
  } catch (e) {
    // On Windows a running app holds app.asar open, so the write fails with a
    // sharing-violation code (EBUSY/EPERM). Give an actionable hint for that case
    // only -- don't mask unrelated failures, which fall through to the best-effort warn.
    const code = (e as NodeJS.ErrnoException | undefined)?.code;
    const lockLike = code === "EBUSY" || code === "EPERM";
    if (process.platform === "win32" && lockLike && (await new CodexAppController().isRunning())) {
      logger.warn(
        "  Codex is running and is locking app.asar — close it and re-run `agent codex` to apply.",
      );
      return;
    }
    throw e;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(tmpAsar, { force: true });
    } catch {
      // best-effort cleanup
    }
  }

  clearCodeCache();
  logger.log(
    `  ✓ Codex app image_generation ${direct ? "disabled (direct)" : "restored (proxy)"}.`,
  );
  if (await new CodexAppController().isRunning()) {
    logger.info("  Restart the Codex app to apply the change.");
  }
}
