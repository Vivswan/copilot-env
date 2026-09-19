// Codex's phone pairing needs the app on its DEFAULT OpenAI provider, so `agent codex-mobile`
// temporarily removes the managed `model_provider`, walks the user through pairing in the app, then
// restores it. There is no Linux Codex app, so it is gated to macOS/Windows.
import { setTimeout as sleep } from "node:timers/promises";
import { parse, stringify } from "smol-toml";
import {
  appRunning,
  type AppScan,
  appScanFromExit,
  appScanVerdict,
  processScanScript,
  runPowershell,
} from "../utils/app_scan.ts";
import { runCaptured } from "../utils/command.ts";
import * as fs from "../utils/fs_facade.ts";
import { isRecord } from "../utils/json.ts";
import { createStderrLogger, prompt } from "../utils/logger.ts";
import { inspectCatalogFile } from "./catalog.ts";
import { effectiveCodexHome } from "./host.ts";
import { CODEX_PROVIDER_ID, codexConfigPath } from "./paths.ts";
import { codexBearerLeaf } from "./toml_io.ts";

const logger = createStderrLogger();

const APP_NAME = "Codex";

/** The one leaf a preview of the pairing's config writes must redact. */
const CONFIG_SECRETS: readonly string[] = [codexBearerLeaf(CODEX_PROVIDER_ID)];
const QUIT_POLL_MS = 500;
const QUIT_TIMEOUT_MS = 8000;

// --- pure config toggle (unit-tested) ---------------------------------------

function ensureNoForcedOpenaiAuth(doc: Record<string, unknown>): void {
  const providers = isRecord(doc.model_providers) ? doc.model_providers : null;
  if (!providers) return;
  const table = providers[CODEX_PROVIDER_ID];
  if (isRecord(table)) table.requires_openai_auth = false;
}

/** A top-level string of config.toml; null when absent, not a string, or the TOML does not parse. */
export function readTopLevelString(configToml: string, key: string): string | null {
  try {
    const doc = parse(configToml);
    const value = isRecord(doc) ? doc[key] : undefined;
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/** The Copilot-patched `model_catalog_json` goes with the provider: during pairing the app runs the
 *  real OpenAI provider, whose limits the patched catalog would misstate. */
export function stripModelProvider(configToml: string): string {
  const doc = parse(configToml) as Record<string, unknown>;
  delete doc.model_provider;
  delete doc.model_catalog_json;
  ensureNoForcedOpenaiAuth(doc);
  return stringify(doc);
}

export function restoreModelProvider(
  configToml: string,
  provider: string,
  modelCatalogJson: string | null = null,
): string {
  const doc = parse(configToml) as Record<string, unknown>;
  doc.model_provider = provider;
  if (modelCatalogJson !== null) doc.model_catalog_json = modelCatalogJson;
  ensureNoForcedOpenaiAuth(doc);
  return stringify(doc);
}

// --- desktop app control ----------------------------------------------------

/** Contract text, shared by the pre-swap close gate and the post-pairing close. */
const RUNNING_SCAN_UNPROVEN_WARN =
  `The process scan failed, so it could not prove the ${APP_NAME} app is closed.`;

/** A PROVEN absence is the only silent proceed. An UNPROVEN look warns and takes the SAME gate as a
 *  proven-present app: a scan that failed to run never authorizes swapping config under a possibly
 *  open app, and its prompt never claims the app IS open. */
export function closeGateFromScan(
  scan: AppScan,
): { close: false } | { close: true; warn: string | null; prompt: string } {
  if (scan === "absent") return { close: false };
  if (scan === "present") {
    return { close: true, warn: null, prompt: `The ${APP_NAME} app is open. Close it now?` };
  }
  return {
    close: true,
    warn: RUNNING_SCAN_UNPROVEN_WARN,
    prompt: `Treat the ${APP_NAME} app as possibly open and close it now?`,
  };
}

/** An UNPROVEN look is NOT "not installed": it says the scan could not check and asks the user, who
 *  can see their own machine, whether to continue. */
export function installGateFromScan(
  scan: AppScan,
):
  | { kind: "proceed" }
  | { kind: "abort"; warn: string; info: string }
  | { kind: "confirm"; warn: string; prompt: string } {
  if (scan === "present") return { kind: "proceed" };
  if (scan === "absent") {
    return {
      kind: "abort",
      warn: `The ${APP_NAME} app does not appear to be installed.`,
      info: `Install the ${APP_NAME} app, then re-run \`agent codex-mobile\`.`,
    };
  }
  return {
    kind: "confirm",
    warn:
      `The install scan failed, so it could not check whether the ${APP_NAME} app is installed.`,
    prompt: "Continue with pairing anyway?",
  };
}

/** Only a PROVEN-present app earns the automatic quit; an unproven look keeps the warn, because
 *  restore then proceeds under an app the scan could not prove closed. */
export function postPairingCloseFromScan(scan: AppScan): { quit: boolean; warn: string | null } {
  if (scan === "present") return { quit: true, warn: null };
  if (scan === "absent") return { quit: false, warn: null };
  return { quit: false, warn: RUNNING_SCAN_UNPROVEN_WARN };
}

/** Shared by the Windows running and installed looks. */
const PS_PROCESS_SCAN = processScanScript(APP_NAME);

// The per-platform primitives: PowerShell scans and signals on Windows (nothing they start
// outlives them, so runPowershell's scratch profile is theirs), open/pgrep/osascript/pkill on macOS.

/** Three-state look at whether the app appears installed (see AppScan). */
export async function installedState(): Promise<AppScan> {
  if (process.platform === "win32") {
    // Under Stop, a Get-StartApps that cannot run (module missing, restricted host) exits
    // nonzero, never a false 'absent'; 'absent' needs Start Apps empty AND the specific
    // no-process error.
    return appScanVerdict(
      await runPowershell(
        "$ErrorActionPreference = 'Stop'; " +
          `try { $apps = Get-StartApps | Where-Object { $_.Name -like '${APP_NAME}*' } } catch { exit 1 }; ` +
          `if ($apps) { 'present' } else { ${PS_PROCESS_SCAN} }`,
      ),
    );
  }
  // `open -Ra` exits 1 by convention when the app does not resolve, but open(1) documents no
  // exclusive exit vocabulary, so an exotic LaunchServices failure could still exit 1 (stderr
  // text is not a contract). Hence the absent arm's rendering stays hedged ("does not appear to
  // be").
  return appScanFromExit(await runCaptured("open", ["-Ra", APP_NAME]));
}

/** Three-state look at whether the app is currently running (see AppScan). */
export function runningState(): Promise<AppScan> {
  return appRunning(APP_NAME);
}

/** On Windows, falls back to a manual prompt if it can't launch. The app this starts inherits
 *  the spawn's environment, so the launch runs under the user's own profile, never the scans'
 *  scratch one. */
async function openApp(): Promise<void> {
  if (process.platform === "win32") {
    const r = await runCaptured("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$a = Get-StartApps | Where-Object { $_.Name -like '${APP_NAME}*' } | Select-Object -First 1;` +
      `if ($a) { Start-Process ('shell:AppsFolder\\' + $a.AppID) } else { Start-Process '${APP_NAME}' }`,
    ]);
    if (r.exitCode !== 0) {
      await prompt(`Open the ${APP_NAME} app, then press Enter.`, { type: "text" });
    }
    return;
  }
  await runCaptured("open", ["-a", APP_NAME]);
}

/** Graceful quit, polled; the by-name force-quit fires at the deadline. */
export async function quitApp(): Promise<void> {
  if (process.platform === "win32") {
    await runPowershell(
      `Get-Process -Name '${APP_NAME}' -ErrorAction SilentlyContinue | ForEach-Object { $_.CloseMainWindow() | Out-Null }`,
    );
  } else {
    await runCaptured("osascript", ["-e", `tell application "${APP_NAME}" to quit`]);
  }
  const deadline = Date.now() + QUIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // Only a PROVEN absence ends the wait: an unproven look keeps polling toward the deadline,
    // where the by-name force-quit fires and claims nothing about whether the app was running.
    if ((await runningState()) === "absent") return;
    await sleep(QUIT_POLL_MS);
  }
  if (process.platform === "win32") {
    await runPowershell(`Stop-Process -Name '${APP_NAME}' -Force -ErrorAction SilentlyContinue`);
  } else {
    await runCaptured("pkill", ["-x", APP_NAME]);
  }
}

// --- orchestration ----------------------------------------------------------

/** Interactive (TTY required). Restore re-applies onto the current file and falls back to the
 *  pre-flow one; it runs in a `finally` and again on SIGINT/SIGTERM, and those two paths part
 *  company once the write itself fails.
 *
 *    on the signal  -> one retry, then exit 130 either way
 *    in `finally`   -> the error propagates, leaving config.toml with no provider
 *
 *  Both leave the best-effort backup beside config.toml as the recovery. */
export async function runCodexMobile(): Promise<void> {
  // Gate other platforms BEFORE touching any config.
  if (process.platform !== "darwin" && process.platform !== "win32") {
    logger.info(
      `The ${APP_NAME} desktop app isn't available on ${process.platform} - \`codex --mobile\` is macOS/Windows only.`,
    );
    process.exitCode = 1;
    return;
  }
  if (!process.stdin.isTTY) {
    throw new Error("`agent codex-mobile` is interactive - run it in a terminal.");
  }

  const home = effectiveCodexHome();
  const configPath = codexConfigPath(home);
  let original: string;
  try {
    original = fs.readText(configPath);
  } catch {
    throw new Error(
      `No Codex config at ${configPath}. Run \`agent profile sync --codex\` first, then retry.`,
    );
  }

  const provider = readTopLevelString(original, "model_provider");
  if (provider === null) {
    throw new Error(
      "No model_provider is configured in config.toml - run `agent profile sync --codex` first, then retry --mobile.",
    );
  }
  // Captured alongside the provider so restore() puts BOTH keys back.
  const catalogPath = readTopLevelString(original, "model_catalog_json");

  const installGate = installGateFromScan(await installedState());
  if (installGate.kind === "abort") {
    logger.warn(installGate.warn);
    logger.info(installGate.info);
    return;
  }
  if (installGate.kind === "confirm") {
    logger.warn(installGate.warn);
    const cont = await prompt(installGate.prompt, {
      type: "confirm",
      initial: true,
    });
    if (!cont) {
      logger.info("Aborted - nothing was changed.");
      return;
    }
  }

  // Close the app first (ask permission, default yes) so the config swap is clean.
  const gate = closeGateFromScan(await runningState());
  if (gate.close) {
    if (gate.warn !== null) logger.warn(gate.warn);
    const close = await prompt(gate.prompt, {
      type: "confirm",
      initial: true,
    });
    if (!close) {
      logger.info("Aborted - the app must be closed to re-pair. Nothing was changed.");
      return;
    }
    await quitApp();
  }

  // A durable backup so a hard kill mid-pairing leaves a recovery file rather than a Codex with no
  // provider. Removed on a clean finish.
  const backupPath = `${configPath}.copilot-env-mobile.bak`;
  let backupWritten = false;
  try {
    fs.writeText(backupPath, original, {
      atomic: false,
      secretKeys: CONFIG_SECRETS,
      detail: "Codex config backup for the pairing",
    });
    backupWritten = true;
  } catch {
    logger.warn(`Could not write a backup at ${backupPath}; proceeding from memory.`);
  }

  const usableCatalog = (): string | null => {
    // Re-checked at write time: disabling the opt-in catalog mid-pairing deletes the file, and a
    // dangling or schema-rejected reference is a Codex startup error.
    if (catalogPath === null) return null;
    const verdict = inspectCatalogFile(catalogPath);
    return verdict === "accepted" || verdict === "unverifiable" ? catalogPath : null;
  };
  const rebuildFromOriginal = (): string =>
    // Strip+restore so the catalog guard applies (`original` may carry the deleted path verbatim);
    // the pure rewrites cannot throw, since `original` parsed at flow start.
    restoreModelProvider(stripModelProvider(original), provider, usableCatalog());

  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    let next: string;
    try {
      // The app may have edited the file, so re-apply onto the current one; fall back to the
      // pre-flow config when it is now unreadable or invalid.
      next = restoreModelProvider(fs.readText(configPath), provider, usableCatalog());
    } catch {
      next = rebuildFromOriginal();
    }
    // A rewrite of the path the strip below already named: the seam says nothing more.
    fs.writeText(configPath, next, { atomic: false, secretKeys: CONFIG_SECRETS });
  };

  // `finally` does not run on a signal, so restore synchronously on SIGINT/SIGTERM too; otherwise
  // Ctrl-C during pairing leaves config.toml without a provider.
  const onSignal = (): void => {
    try {
      restore();
    } catch {
      try {
        fs.writeText(configPath, rebuildFromOriginal(), {
          atomic: false,
          secretKeys: CONFIG_SECRETS,
        });
      } catch {
        // give up -- the backup file is the last resort
      }
    }
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    // The restore below rewrites the same path silently (the seam names a path once per process),
    // so this line names the act and nothing about a write not yet made.
    fs.writeText(configPath, stripModelProvider(original), {
      atomic: false,
      secretKeys: CONFIG_SECRETS,
      detail: `Codex config, rewritten around the pairing (model_provider "${provider}")`,
    });

    await openApp();
    logger.box(
      [
        "Pairing",
        "",
        `  1. In the ${APP_NAME} app, complete the phone remote-control / sign-in flow.`,
        "  2. When your phone is connected, come back here.",
      ].join("\n"),
    );
    await prompt("Press Enter once you've finished pairing on your phone.", {
      type: "text",
    });

    // Restore itself is swap-tolerant (it re-reads the current file and falls back to the pre-flow
    // config), so an unproven look here only warns.
    const afterPairing = postPairingCloseFromScan(await runningState());
    if (afterPairing.warn !== null) logger.warn(afterPairing.warn);
    if (afterPairing.quit) await quitApp();
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    // Always put the managed provider back, even if the user aborts the prompt.
    restore();
    if (backupWritten) {
      try {
        fs.rm(backupPath, { force: true, detail: "pairing finished" });
      } catch {
        logger.warn(`Could not remove the backup at ${backupPath}.`);
      }
    }
  }

  await openApp();
  logger.box(
    [
      "Done",
      "",
      `  The ${APP_NAME} app is reopening. Check that it's connected to your phone`,
      `  and using your configured provider ("${provider}").`,
    ].join("\n"),
  );
}
