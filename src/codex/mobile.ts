// `agent codex --mobile`: guide the user through pairing the Codex desktop app
// with the phone remote-control flow. Codex's phone pairing needs the app on its
// DEFAULT OpenAI provider, so this temporarily removes the managed `model_provider`
// from config.toml, walks the user through pairing in the app, then restores it.
//
// macOS and Windows drive the app programmatically (macOS: open/osascript/pgrep;
// Windows: PowerShell Get-Process/Start-Process/Stop-Process). There is no Linux
// Codex app, so `--mobile` is gated to macOS/Windows.
import * as fs from "node:fs";
import { consola } from "consola";
import { parse, stringify } from "smol-toml";
import { runCaptured } from "../utils/command.ts";
import { isRecord } from "../utils/json.ts";
import { createStderrLogger } from "../utils/logger.ts";
import { isCatalogFileUsable } from "./catalog.ts";
import { CODEX_PROVIDER_ID, effectiveCodexHome } from "./config.ts";
import { codexConfigPath } from "./paths.ts";

const logger = createStderrLogger();

const APP_NAME = "Codex";
const QUIT_POLL_MS = 500;
const QUIT_TIMEOUT_MS = 8000;

// --- pure config toggle (unit-tested) ---------------------------------------

/** Force `requires_openai_auth = false` on our managed provider table (idempotent). */
function ensureNoForcedOpenaiAuth(doc: Record<string, unknown>): void {
  const providers = isRecord(doc.model_providers) ? doc.model_providers : null;
  if (!providers) return;
  const table = providers[CODEX_PROVIDER_ID];
  if (isRecord(table)) table.requires_openai_auth = false;
}

/** Read the configured `model_provider` (null when unset/malformed). Pure. */
export function readModelProvider(configToml: string): string | null {
  try {
    const doc = parse(configToml);
    return isRecord(doc) && typeof doc.model_provider === "string" ? doc.model_provider : null;
  } catch {
    return null;
  }
}

/** Read the configured `model_catalog_json` path (null when unset/malformed). Pure. */
export function readModelCatalogJson(configToml: string): string | null {
  try {
    const doc = parse(configToml);
    return isRecord(doc) && typeof doc.model_catalog_json === "string"
      ? doc.model_catalog_json
      : null;
  } catch {
    return null;
  }
}

/**
 * Remove the top-level `model_provider` key (so the app uses its default OpenAI
 * provider for pairing) and re-assert `requires_openai_auth = false`. The
 * Copilot-patched `model_catalog_json` goes with it -- during pairing the app
 * runs the real OpenAI provider, whose limits the patched catalog would
 * misstate. Everything else in the file is preserved. Pure.
 */
export function stripModelProvider(configToml: string): string {
  const doc = parse(configToml) as Record<string, unknown>;
  delete doc.model_provider;
  delete doc.model_catalog_json;
  ensureNoForcedOpenaiAuth(doc);
  return stringify(doc);
}

/**
 * Restore the top-level `model_provider` key to `provider` (and, when captured,
 * the `model_catalog_json` path stripped alongside it). Pure.
 */
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A look by one of the app scans (running / installed): "present"/"absent" are PROVEN
 *  readings -- the scan ran to completion and emitted its verdict -- while "unproven"
 *  is a look that FAILED: pgrep/open/PowerShell erroring or missing, or the spawn
 *  itself failing. An unproven look never reads as a confident absence (the same
 *  failed-look discipline as classifyPidFromScan in src/copilot_api/process.ts). */
export type AppScan = "present" | "absent" | "unproven";

/** The shared verdict over a scripted platform scan, pure for testing: the scan script
 *  emits an explicit verdict word on stdout WITH exit 0, so those two readings are the
 *  only confident ones. The exit-0 guard is LOAD-BEARING beside the word check, not
 *  redundant with it: a scan killed AFTER printing its verdict (a timeout kill, OOM,
 *  a user interrupt) exits nonzero with a valid word already on stdout, and without
 *  the guard that killed look would mint a proven reading -- on the Windows path this
 *  guard is the sole protection. A missing or garbled word on exit 0 is equally
 *  unproven. */
export function appScanVerdict(result: { exitCode: number; stdout: string }): AppScan {
  if (result.exitCode !== 0) return "unproven";
  const verdict = result.stdout.trim();
  return verdict === "present" || verdict === "absent" ? verdict : "unproven";
}

/** The verdict over a scan whose TOOL already speaks a three-state exit vocabulary
 *  (pgrep, `open -Ra`: 0 match, 1 ran-no-match, anything else an error), pure for
 *  testing. The proven absence requires BOTH the tool's own exit 1 AND no launch-
 *  failure mark: runCaptured synthesizes the same exit 1 for a look that never ran
 *  (a spawn failure), and the mark is what keeps that failed look from reading as a
 *  confident absence. */
export function appScanFromExit(result: { exitCode: number; launchFailed?: true }): AppScan {
  if (result.launchFailed) return "unproven";
  if (result.exitCode === 0) return "present";
  return result.exitCode === 1 ? "absent" : "unproven";
}

/** The one honest warn for a running scan that failed -- contract text, chosen once,
 *  shared by the pre-swap close gate and the post-pairing close. */
const RUNNING_SCAN_UNPROVEN_WARN =
  `The process scan failed, so it could not prove the ${APP_NAME} app is closed.`;

/**
 * The close-gate judgment over a running scan, pure for testing. A PROVEN absence is
 * the only silent proceed; a proven-present app takes the interactive close gate; an
 * UNPROVEN look warns honestly and takes the SAME gate -- a scan that failed to run
 * never authorizes the confident "not running" that would swap config under a
 * possibly-open app. Its prompt never claims the app IS open, only possibly so.
 */
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

/**
 * The install-gate judgment over an installed scan, pure for testing. A proven
 * presence proceeds silently; a PROVEN absence aborts with the install hint; an
 * UNPROVEN look is NOT a "not installed" -- it says the scan could not check and
 * asks the user, who can see their own machine, whether to continue.
 */
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
      info: `Install the ${APP_NAME} app, then re-run \`agent codex --mobile\`.`,
    };
  }
  return {
    kind: "confirm",
    warn:
      `The install scan failed, so it could not check whether the ${APP_NAME} app is installed.`,
    prompt: "Continue with pairing anyway?",
  };
}

/**
 * The post-pairing close judgment, pure for testing: only a PROVEN-present app earns
 * the automatic quit -- an unproven look must not mint a close signal today's flow
 * never sent -- and the unproven look keeps the honest warn, because restore then
 * proceeds under an app the scan could not prove closed.
 */
export function postPairingCloseFromScan(scan: AppScan): { quit: boolean; warn: string | null } {
  if (scan === "present") return { quit: true, warn: null };
  if (scan === "absent") return { quit: false, warn: null };
  return { quit: false, warn: RUNNING_SCAN_UNPROVEN_WARN };
}

/** The Get-Process scan fragment shared by the Windows running and installed looks:
 *  'present' on a match, 'absent' ONLY on the SPECIFIC no-match error id, a nonzero
 *  verdict-less exit for every other failure -- so no real Get-Process error can
 *  flatten into a proven reading. */
const PS_PROCESS_SCAN =
  `try { $null = Get-Process -Name '${APP_NAME}' -ErrorAction Stop; 'present' } ` +
  "catch { if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenName*') { 'absent' } else { exit 1 } }";

/**
 * Drives the Codex desktop app (install check / running check / open / quit) across
 * macOS and Windows. macOS uses `open`/`pgrep`/`osascript`/`pkill`; Windows drives it
 * via PowerShell (Get-StartApps/Get-Process/Start-Process/Stop-Process). The
 * graceful-then-force `quit()` poll loop is shared; only the per-platform primitives differ.
 * The process executor, platform, and quit timing are injectable for tests only;
 * production callers construct it bare.
 */
export class CodexAppController {
  private readonly windows: boolean;
  private readonly exec: (
    file: string,
    args: string[],
  ) => Promise<{ exitCode: number; stdout: string; launchFailed?: true }>;
  private readonly quitTimeoutMs: number;
  private readonly quitPollMs: number;

  constructor(
    exec: (
      file: string,
      args: string[],
    ) => Promise<{ exitCode: number; stdout: string; launchFailed?: true }> = runCaptured,
    platform: string = process.platform,
    timing: { timeoutMs: number; pollMs: number } = {
      timeoutMs: QUIT_TIMEOUT_MS,
      pollMs: QUIT_POLL_MS,
    },
  ) {
    this.exec = exec;
    this.windows = platform === "win32";
    this.quitTimeoutMs = timing.timeoutMs;
    this.quitPollMs = timing.pollMs;
  }

  private run(file: string, args: string[]) {
    return this.exec(file, args);
  }

  private ps(script: string) {
    return this.run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
  }

  /** Three-state look at whether the app appears installed (see AppScan). */
  async installedState(): Promise<AppScan> {
    if (this.windows) {
      // Under Stop, a Get-StartApps that cannot run (module missing, restricted host)
      // exits nonzero -> unproven, never a false "absent". The Get-Process fallback is
      // the shared discriminated fragment: a REAL Get-Process error is never
      // suppressed into a proven absence either -- 'absent' needs Start Apps empty
      // AND the specific no-process error.
      return appScanVerdict(
        await this.ps(
          "$ErrorActionPreference = 'Stop'; " +
            `try { $apps = Get-StartApps | Where-Object { $_.Name -like '${APP_NAME}*' } } catch { exit 1 }; ` +
            `if ($apps) { 'present' } else { ${PS_PROCESS_SCAN} }`,
        ),
      );
    }
    // `open -Ra` exits 0 when the app resolves and, by convention, 1 when it does
    // not; a marked launch failure or any other exit stays unproven (appScanFromExit).
    // open(1) documents no exclusive exit vocabulary, so an exotic LaunchServices
    // failure could still exit 1 -- there is no stable further discriminant (stderr
    // text is not a contract), which is why the absent arm's rendering stays hedged
    // ("does not appear to be installed") rather than claiming proof.
    return appScanFromExit(await this.run("open", ["-Ra", APP_NAME]));
  }

  /** Three-state look at whether the app is currently running (see AppScan). */
  async runningState(): Promise<AppScan> {
    if (this.windows) {
      // The shared fragment: -ErrorAction Stop turns the no-match case into a
      // terminating error whose FullyQualifiedErrorId (NoProcessFoundForGivenName)
      // is the PROVEN absence. Every other failure -- other Get-Process errors, a
      // PowerShell launch that never ran (no verdict word) -- reads unproven.
      return appScanVerdict(await this.ps(PS_PROCESS_SCAN));
    }
    // pgrep's exit vocabulary is already three-state (0 match, 1 ran-no-match, >1
    // error); the launch-failure mark separates a REAL exit 1 from the one runCaptured
    // synthesizes for a pgrep that never ran (appScanFromExit).
    return appScanFromExit(await this.run("pgrep", ["-x", APP_NAME]));
  }

  /** Open / focus the app. On Windows, falls back to a manual prompt if it can't launch. */
  async open(): Promise<void> {
    if (this.windows) {
      const r = await this.ps(
        `$a = Get-StartApps | Where-Object { $_.Name -like '${APP_NAME}*' } | Select-Object -First 1;` +
          `if ($a) { Start-Process ('shell:AppsFolder\\' + $a.AppID) } else { Start-Process '${APP_NAME}' }`,
      );
      if (r.exitCode !== 0) await this.manualPromptOpen();
      return;
    }
    await this.run("open", ["-a", APP_NAME]);
  }

  /** Ensure the app is closed: ask it to quit, poll, then force-kill if it overstays. */
  async quit(): Promise<void> {
    await this.requestQuit();
    const deadline = Date.now() + this.quitTimeoutMs;
    while (Date.now() < deadline) {
      // Only a PROVEN absence ends the wait: an unproven look cannot satisfy "ensure
      // the app is closed", so it keeps polling toward the deadline, where the
      // pre-existing force-quit fires as before -- a targeted, by-name close attempt
      // that claims nothing about whether the app was actually running.
      if ((await this.runningState()) === "absent") return;
      await sleep(this.quitPollMs);
    }
    await this.forceQuit();
  }

  private async requestQuit(): Promise<void> {
    if (this.windows) {
      await this.ps(
        `Get-Process -Name '${APP_NAME}' -ErrorAction SilentlyContinue | ForEach-Object { $_.CloseMainWindow() | Out-Null }`,
      );
    } else {
      await this.run("osascript", ["-e", `tell application "${APP_NAME}" to quit`]);
    }
  }

  private async forceQuit(): Promise<void> {
    if (this.windows) {
      await this.ps(`Stop-Process -Name '${APP_NAME}' -Force -ErrorAction SilentlyContinue`);
    } else {
      await this.run("pkill", ["-x", APP_NAME]);
    }
  }

  /** Non-programmable launch fallback: ask the user to open the app. */
  private manualPromptOpen(): Promise<unknown> {
    return consola.prompt(`Open the ${APP_NAME} app, then press Enter.`, { type: "text" });
  }
}

// --- orchestration ----------------------------------------------------------

/**
 * `agent codex --mobile`: temporarily drop the managed model_provider, walk the
 * user through the Codex app's phone remote-control pairing, then restore it.
 * Interactive (TTY required). The config is restored in a finally block so an
 * abort mid-flow can't leave Codex unconfigured.
 */
export async function runCodexMobile(): Promise<void> {
  // The Codex desktop app exists on macOS and Windows only (no Linux app). Gate
  // other platforms BEFORE touching any config (mirrors host.ts's assertUnix).
  if (process.platform !== "darwin" && process.platform !== "win32") {
    logger.info(
      `The ${APP_NAME} desktop app isn't available on ${process.platform} - \`codex --mobile\` is macOS/Windows only.`,
    );
    process.exitCode = 1;
    return;
  }
  if (!process.stdin.isTTY) {
    throw new Error("`agent codex --mobile` is interactive - run it in a terminal.");
  }

  const home = effectiveCodexHome();
  const configPath = codexConfigPath(home);
  let original: string;
  try {
    original = fs.readFileSync(configPath, "utf8");
  } catch {
    throw new Error(`No Codex config at ${configPath}. Run \`agent codex\` first, then retry.`);
  }

  const provider = readModelProvider(original);
  if (provider === null) {
    throw new Error(
      "No model_provider is configured in config.toml - run `agent codex` first, then retry --mobile.",
    );
  }
  // Captured alongside the provider so restore() puts BOTH keys back.
  const catalogPath = readModelCatalogJson(original);

  const app = new CodexAppController();

  const installGate = installGateFromScan(await app.installedState());
  if (installGate.kind === "abort") {
    logger.warn(installGate.warn);
    logger.info(installGate.info);
    return;
  }
  if (installGate.kind === "confirm") {
    // A failed look is not a "not installed": say so honestly, and let the user --
    // who can see their own machine -- decide whether to continue.
    logger.warn(installGate.warn);
    const cont = await consola.prompt(installGate.prompt, {
      type: "confirm",
      initial: true,
    });
    if (!cont) {
      logger.info("Aborted - nothing was changed.");
      return;
    }
  }

  // Close the app first (ask permission, default yes) so the config swap is clean.
  // Three-stated: a FAILED scan (unproven) warns and takes the SAME interactive gate
  // as a proven-present app, never the silent proceed -- swapping config under a
  // possibly-open app is exactly what this gate exists to prevent.
  const gate = closeGateFromScan(await app.runningState());
  if (gate.close) {
    if (gate.warn !== null) logger.warn(gate.warn);
    const close = await consola.prompt(gate.prompt, {
      type: "confirm",
      initial: true,
    });
    if (!close) {
      logger.info("Aborted - the app must be closed to re-pair. Nothing was changed.");
      return;
    }
    await app.quit();
  }

  // Durable backup so a hard kill (SIGINT/SIGTERM) mid-pairing leaves a recovery
  // file rather than a Codex with no provider. Removed on a clean finish.
  const backupPath = `${configPath}.copilot-env-mobile.bak`;
  try {
    fs.writeFileSync(backupPath, original);
  } catch {
    logger.warn(`Could not write a backup at ${backupPath}; proceeding from memory.`);
  }

  const usableCatalog = (): string | null =>
    // Re-check at write time: disabling the opt-in catalog mid-pairing deletes the
    // file, and restoring a dangling reference is a Codex startup error.
    catalogPath !== null && isCatalogFileUsable(catalogPath) ? catalogPath : null;
  const rebuildFromOriginal = (): string =>
    // Strip+restore so the catalog guard applies (`original` may carry the deleted
    // path verbatim); the pure rewrites cannot throw -- `original` parsed at flow start.
    restoreModelProvider(stripModelProvider(original), provider, usableCatalog());

  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    let next: string;
    try {
      // Prefer re-applying onto the current file (the app may have edited it), but
      // fall back to the pre-flow config if it's now unreadable/invalid.
      next = restoreModelProvider(fs.readFileSync(configPath, "utf8"), provider, usableCatalog());
    } catch {
      next = rebuildFromOriginal();
    }
    fs.writeFileSync(configPath, next);
  };

  // `finally` does not run on a signal, so restore synchronously on SIGINT/SIGTERM
  // too -- otherwise Ctrl-C during pairing leaves config.toml without a provider.
  const onSignal = (): void => {
    try {
      restore();
    } catch {
      try {
        fs.writeFileSync(configPath, rebuildFromOriginal());
      } catch {
        // give up -- the backup file is the last resort
      }
    }
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    // Drop the managed provider so the app pairs on its default OpenAI provider.
    fs.writeFileSync(configPath, stripModelProvider(original));
    logger.success(`Temporarily removed model_provider (was "${provider}").`);

    await app.open();
    logger.box(
      [
        "Pairing",
        "",
        `  1. In the ${APP_NAME} app, complete the phone remote-control / sign-in flow.`,
        "  2. When your phone is connected, come back here.",
      ].join("\n"),
    );
    await consola.prompt("Press Enter once you've finished pairing on your phone.", {
      type: "text",
    });

    // Post-pairing close: the pure judgment (postPairingCloseFromScan) -- only a
    // PROVEN-present app earns the automatic quit, an unproven look warns honestly
    // instead (restore itself is swap-tolerant: it re-reads the current file and
    // falls back to the pre-flow config).
    const afterPairing = postPairingCloseFromScan(await app.runningState());
    if (afterPairing.warn !== null) logger.warn(afterPairing.warn);
    if (afterPairing.quit) await app.quit();
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    // Always put the managed provider back, even if the user aborts the prompt.
    restore();
    logger.success(`Restored model_provider = "${provider}".`);
    try {
      fs.rmSync(backupPath, { force: true });
    } catch {
      // best-effort cleanup of the backup
    }
  }

  await app.open();
  logger.box(
    [
      "Done",
      "",
      `  The ${APP_NAME} app is reopening. Check that it's connected to your phone`,
      `  and using your configured provider ("${provider}").`,
    ].join("\n"),
  );
}
