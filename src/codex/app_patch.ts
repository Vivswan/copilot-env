// Patch the Codex *desktop app*'s bundled JS (inside app.asar) so it doesn't offer
// `image_generation` in Direct mode, and restore it in Proxy mode — keeping the app
// consistent with the CLI's config.toml `[features]` toggle (src/codex/config.ts).
//
// This is BEST-EFFORT cosmetic polish: the config.toml write is the real contract,
// so every failure here only warns and never breaks `agent codex`. The app gates the
// feature in a minified loop that ignores config.toml, hence the binary patch.
//
// macOS and Windows only (there is no Linux Codex app). The pure source transforms
// are unit-tested; the asar/app-control side is untested in CI (no app there), exactly
// like the --mobile app control in mobile.ts.
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
import { APP_NAME, isCodexRunning } from "./app_control.ts";

const logger = createStderrLogger();

// --- pure source transforms (unit-tested) -----------------------------------

/**
 * The Codex app enables each feature gate in a minified loop shaped like
 *   for(let n of zg) Dt(e,n.gateName)&&(t[n.featureKey]=!0)
 * We insert a guard so the `image_generation` key is never enabled:
 *   …&&n.featureKey!=="image_generation"&&(t[n.featureKey]=!0)
 * Minified identifiers (the call fn, `n`, `t`) change every release, so we capture
 * them with backreferences rather than hardcoding `Dt`/`n`/`t`.
 */
const PATCH_RE =
  /(\(\s*[A-Za-z_$][\w$]*\s*,\s*([A-Za-z_$][\w$]*)\.gateName\s*\)\s*&&\s*)(\(\s*[A-Za-z_$][\w$]*\s*\[\s*\2\.featureKey\s*\]\s*=\s*!0\s*\))/;

/** The guarded form (matches our patch and the original shell script's backtick variant). */
const UNPATCH_RE =
  /(\(\s*[A-Za-z_$][\w$]*\s*,\s*([A-Za-z_$][\w$]*)\.gateName\s*\)\s*&&\s*)\2\.featureKey\s*!==\s*(?:"image_generation"|`image_generation`|'image_generation')\s*&&\s*(\(\s*[A-Za-z_$][\w$]*\s*\[\s*\2\.featureKey\s*\]\s*=\s*!0\s*\))/;

export type ImageGenPatchState = "patched" | "unpatched" | "absent";

/** Classify a JS source: already guarded, un-guarded gate loop present, or neither. */
export function imageGenerationPatchState(src: string): ImageGenPatchState {
  if (UNPATCH_RE.test(src)) return "patched";
  if (PATCH_RE.test(src)) return "unpatched";
  return "absent";
}

/** Insert the image_generation guard (idempotent; no-op if already patched/absent). Pure. */
export function patchImageGenerationSource(src: string): string {
  if (imageGenerationPatchState(src) !== "unpatched") return src;
  return src.replace(PATCH_RE, '$1$2.featureKey!=="image_generation"&&$3');
}

/** Remove the image_generation guard (idempotent; no-op if already clean/absent). Pure. */
export function unpatchImageGenerationSource(src: string): string {
  if (imageGenerationPatchState(src) !== "patched") return src;
  return src.replace(UNPATCH_RE, "$1$3");
}

// --- app.asar location ------------------------------------------------------

interface AsarTarget {
  asarPath: string;
  /** macOS .app bundle root (for the Info.plist integrity check); null on Windows. */
  bundle: string | null;
}

const ps = (script: string) =>
  execa("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { reject: false });

/** Resolve the Codex app's app.asar, or null (with a skip note) if not patchable. */
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
    return fs.existsSync(asarPath) ? { asarPath, bundle } : null;
  }

  // Windows: prefer the running/installed exe path, then the NSIS default location.
  const script =
    `$p=(Get-Process -Name '${APP_NAME}' -ErrorAction SilentlyContinue|Select-Object -First 1).Path;` +
    `if(-not $p){$c=Join-Path $env:LOCALAPPDATA 'Programs\\${APP_NAME}\\${APP_NAME}.exe';if(Test-Path $c){$p=$c}}` +
    `if($p){$p}else{exit 1}`;
  const r = await ps(script);
  if (r.exitCode !== 0 || !r.stdout.trim()) return null;
  const asarPath = join(dirname(r.stdout.trim()), "resources", "app.asar");
  if (/[\\/]WindowsApps[\\/]/i.test(asarPath)) {
    logger.info(
      `  Codex is installed as a packaged app (read-only) — skipping the image_generation app patch.`,
    );
    return null;
  }
  return fs.existsSync(asarPath) ? { asarPath, bundle: null } : null;
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

/** macOS app.asar integrity is enforced via Info.plist; modifying it would brick launch. */
function hasAsarIntegrityFuse(bundle: string | null): boolean {
  if (!bundle) return false; // Windows: fuse lives in the exe; we can't cheaply detect it.
  try {
    const plist = fs.readFileSync(join(bundle, "Contents", "Info.plist"), "utf8");
    return plist.includes("ElectronAsarIntegrity");
  } catch {
    return false;
  }
}

/** Find the bundled JS file holding the feature-gate loop (filename hash varies). */
function findGateBundle(asarPath: string): { rel: string; state: ImageGenPatchState } | null {
  const files = listPackage(asarPath, { isPack: false });
  for (const f of files) {
    // Narrow to the webview asset bundles (the gate loop lives there) before reading.
    if (!/webview[\\/]assets[\\/].*\.js$/i.test(f)) continue;
    let src: string;
    try {
      src = extractFile(asarPath, f.replace(/^[\\/]+/, "")).toString("utf8");
    } catch {
      continue;
    }
    const state = imageGenerationPatchState(src);
    if (state !== "absent") return { rel: f.replace(/^[\\/]+/, ""), state };
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
 * direct => patched out, proxy => restored. Best-effort and idempotent — never
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
  if (!target) return; // not installed / not patchable — resolveAppAsar already noted why

  const { asarPath, bundle } = target;
  // Drop any cached asar header for this path so every read below reflects the
  // current on-disk archive (a prior sync in this process may have replaced it).
  uncacheAll();
  if (hasAsarIntegrityFuse(bundle)) {
    logger.info("  Codex enforces app.asar integrity — skipping the image_generation app patch.");
    return;
  }
  if (hasUnpackedEntries(getRawHeader(asarPath).header) || fs.existsSync(`${asarPath}.unpacked`)) {
    logger.info(
      "  Codex app.asar has unpacked native files (unsafe to repack) — skipping the image_generation app patch.",
    );
    return;
  }

  const found = findGateBundle(asarPath);
  if (!found) {
    logger.info(
      "  Couldn't locate the image_generation gate in this Codex version — skipping the app patch.",
    );
    return;
  }

  const desired: ImageGenPatchState = direct ? "patched" : "unpatched";
  if (found.state === desired) return; // already in the desired state — no-op (the common case)

  // A change is needed: extract, transform the one file, repack, atomically replace.
  const tmpDir = fs.mkdtempSync(join(tmpdir(), "copilot-codex-asar-"));
  const tmpAsar = `${asarPath}.copilot-env-tmp`;
  try {
    extractAll(asarPath, tmpDir);
    const onDisk = join(tmpDir, ...found.rel.split(/[\\/]/));
    const src = fs.readFileSync(onDisk, "utf8");
    const next = direct ? patchImageGenerationSource(src) : unpatchImageGenerationSource(src);
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
    uncacheAll(); // the on-disk archive changed — invalidate @electron/asar's cached header
  } catch (e) {
    // On Windows a running app holds app.asar open, so the write fails with a
    // sharing-violation code (EBUSY/EPERM). Give an actionable hint for that case
    // only — don't mask unrelated failures (corruption, real permission errors),
    // which fall through to syncCodexAppImageGeneration's best-effort warn (with
    // the real message).
    const code = (e as NodeJS.ErrnoException | undefined)?.code;
    const lockLike = code === "EBUSY" || code === "EPERM";
    if (process.platform === "win32" && lockLike && (await isCodexRunning())) {
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
  if (await isCodexRunning()) {
    logger.info("  Restart the Codex app to apply the change.");
  }
}
