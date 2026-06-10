// `agent codex --mobile`: guide the user through pairing the Codex desktop app
// with the phone remote-control flow. Codex's phone pairing needs the app on its
// DEFAULT OpenAI provider, so this temporarily removes the managed `model_provider`
// from config.toml, walks the user through pairing in the app, then restores it.
//
// macOS and Windows drive the app programmatically (macOS: open/osascript/pgrep;
// Windows: PowerShell Get-Process/Start-Process/Stop-Process). There is no Linux
// Codex app, so `--mobile` is gated to macOS/Windows.
import * as fs from "node:fs";
import { join } from "node:path";
import { consola } from "consola";
import { execa } from "execa";
import { parse, stringify } from "smol-toml";
import { isRecord } from "../utils/json.ts";
import { createStderrLogger } from "../utils/logger.ts";
import {
  CODEX_PROVIDER_ID,
  type CodexConfigArgs,
  DIRECT_PROVIDER_ID,
  effectiveCodexHome,
} from "./config.ts";

const logger = createStderrLogger();

const APP_NAME = "Codex";
const QUIT_POLL_MS = 500;
const QUIT_TIMEOUT_MS = 8000;

export type CodexMobileArgs = Pick<CodexConfigArgs, "codex-home">;

// --- pure config toggle (unit-tested) ---------------------------------------

/** The provider tables whose `requires_openai_auth` we keep false. */
const MANAGED_PROVIDER_IDS = [CODEX_PROVIDER_ID, DIRECT_PROVIDER_ID];

/** Force `requires_openai_auth = false` on our managed provider tables (idempotent). */
function ensureNoForcedOpenaiAuth(doc: Record<string, unknown>): void {
  const providers = isRecord(doc.model_providers) ? doc.model_providers : null;
  if (!providers) return;
  for (const id of MANAGED_PROVIDER_IDS) {
    const table = providers[id];
    if (isRecord(table)) table.requires_openai_auth = false;
  }
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

/**
 * Remove the top-level `model_provider` key (so the app uses its default OpenAI
 * provider for pairing) and re-assert `requires_openai_auth = false`. Everything
 * else in the file is preserved. Pure.
 */
export function stripModelProvider(configToml: string): string {
  const doc = parse(configToml) as Record<string, unknown>;
  delete doc.model_provider;
  ensureNoForcedOpenaiAuth(doc);
  return stringify(doc);
}

/** Restore the top-level `model_provider` key to `provider`. Pure. */
export function restoreModelProvider(configToml: string, provider: string): string {
  const doc = parse(configToml) as Record<string, unknown>;
  doc.model_provider = provider;
  ensureNoForcedOpenaiAuth(doc);
  return stringify(doc);
}

// --- desktop app control ----------------------------------------------------

interface AppController {
  /** The Codex app appears installed. */
  installed(): Promise<boolean>;
  /** The Codex app is currently running. */
  isRunning(): Promise<boolean>;
  /** Ensure the app is closed (graceful, then forced). */
  quit(): Promise<void>;
  /** Open / focus the app. */
  open(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function macController(): AppController {
  const run = (file: string, args: string[]) => execa(file, args, { reject: false });
  const isRunning = async () => (await run("pgrep", ["-x", APP_NAME])).exitCode === 0;
  return {
    installed: async () => (await run("open", ["-Ra", APP_NAME])).exitCode === 0,
    isRunning,
    open: async () => {
      await run("open", ["-a", APP_NAME]);
    },
    quit: async () => {
      await run("osascript", ["-e", `tell application "${APP_NAME}" to quit`]);
      // Wait for a graceful quit; force-kill if it overstays.
      const deadline = Date.now() + QUIT_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (!(await isRunning())) return;
        await sleep(QUIT_POLL_MS);
      }
      await run("pkill", ["-x", APP_NAME]);
    },
  };
}

/** Non-macOS fallback: we can't reliably drive the app, so ask the user to. */
function manualPromptOpen(): Promise<unknown> {
  return consola.prompt(`Open the ${APP_NAME} app, then press Enter.`, { type: "text" });
}

/**
 * Windows: drive the app via PowerShell (mirrors macController). Process/Start-menu
 * name is APP_NAME ("Codex"). isRunning/quit are fully programmatic; open resolves
 * the Start-menu app (covers Store + most installers) and falls back to a manual
 * prompt only if it can't launch.
 */
function windowsController(): AppController {
  const ps = (script: string) =>
    execa("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { reject: false });
  const isRunning = async () =>
    (
      await ps(
        `if (Get-Process -Name '${APP_NAME}' -ErrorAction SilentlyContinue) { exit 0 } exit 1`,
      )
    ).exitCode === 0;
  return {
    installed: async () =>
      (
        await ps(
          `if ((Get-StartApps | Where-Object { $_.Name -like '${APP_NAME}*' }) -or (Get-Process -Name '${APP_NAME}' -ErrorAction SilentlyContinue)) { exit 0 } exit 1`,
        )
      ).exitCode === 0,
    isRunning,
    open: async () => {
      const r = await ps(
        `$a = Get-StartApps | Where-Object { $_.Name -like '${APP_NAME}*' } | Select-Object -First 1;` +
          `if ($a) { Start-Process ('shell:AppsFolder\\' + $a.AppID) } else { Start-Process '${APP_NAME}' }`,
      );
      if (r.exitCode !== 0) await manualPromptOpen();
    },
    quit: async () => {
      // Graceful: ask the window to close, then poll, then force.
      await ps(
        `Get-Process -Name '${APP_NAME}' -ErrorAction SilentlyContinue | ForEach-Object { $_.CloseMainWindow() | Out-Null }`,
      );
      const deadline = Date.now() + QUIT_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (!(await isRunning())) return;
        await sleep(QUIT_POLL_MS);
      }
      await ps(`Stop-Process -Name '${APP_NAME}' -Force -ErrorAction SilentlyContinue`);
    },
  };
}

function appController(): AppController {
  return process.platform === "win32" ? windowsController() : macController();
}

// --- orchestration ----------------------------------------------------------

/**
 * `agent codex --mobile`: temporarily drop the managed model_provider, walk the
 * user through the Codex app's phone remote-control pairing, then restore it.
 * Interactive (TTY required). The config is restored in a finally block so an
 * abort mid-flow can't leave Codex unconfigured.
 */
export async function runCodexMobile(args: CodexMobileArgs): Promise<void> {
  // The Codex desktop app exists on macOS and Windows only (no Linux app). Gate
  // other platforms BEFORE touching any config (mirrors host.ts's assertUnix).
  if (process.platform !== "darwin" && process.platform !== "win32") {
    logger.info(
      `The ${APP_NAME} desktop app isn't available on ${process.platform} — \`codex --mobile\` is macOS/Windows only.`,
    );
    process.exitCode = 1;
    return;
  }
  if (!process.stdin.isTTY) {
    throw new Error("`agent codex --mobile` is interactive — run it in a terminal.");
  }

  const home = effectiveCodexHome(args);
  const configPath = join(home, "config.toml");
  let original: string;
  try {
    original = fs.readFileSync(configPath, "utf8");
  } catch {
    throw new Error(`No Codex config at ${configPath}. Run \`agent codex\` first, then retry.`);
  }

  const provider = readModelProvider(original);
  if (provider === null) {
    throw new Error(
      "No model_provider is configured in config.toml — run `agent codex` first, then retry --mobile.",
    );
  }

  const app = appController();

  if (!(await app.installed())) {
    logger.warn(`The ${APP_NAME} app does not appear to be installed.`);
    logger.info(`Install the ${APP_NAME} app, then re-run \`agent codex --mobile\`.`);
    return;
  }

  // Close the app first (ask permission, default yes) so the config swap is clean.
  if (await app.isRunning()) {
    const close = await consola.prompt(`The ${APP_NAME} app is open. Close it now?`, {
      type: "confirm",
      initial: true,
    });
    if (!close) {
      logger.info("Aborted — the app must be closed to re-pair. Nothing was changed.");
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

  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    let next: string;
    try {
      // Prefer re-applying onto the current file (the app may have edited it), but
      // fall back to the exact pre-flow config if it's now unreadable/invalid.
      next = restoreModelProvider(fs.readFileSync(configPath, "utf8"), provider);
    } catch {
      next = original;
    }
    fs.writeFileSync(configPath, next);
  };

  // `finally` does not run on a signal, so restore synchronously on SIGINT/SIGTERM
  // too — otherwise Ctrl-C during pairing leaves config.toml without a provider.
  const onSignal = (): void => {
    try {
      restore();
    } catch {
      try {
        fs.writeFileSync(configPath, original);
      } catch {
        // give up — the backup file is the last resort
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

    if (await app.isRunning()) await app.quit();
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
