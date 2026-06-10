// Codex desktop-app control (macOS + Windows): detect-installed / is-running /
// open / quit. Deliberately config-free so both mobile.ts (the --mobile pairing
// flow) and app_patch.ts (the image_generation app patch) can import it without
// creating an import cycle through config.ts.
//
// macOS drives the app via open/osascript/pgrep/pkill; Windows via PowerShell
// Get-Process/Start-Process/Stop-Process. There is no Linux Codex app.
import { consola } from "consola";
import { execa } from "execa";

export const APP_NAME = "Codex";
const QUIT_POLL_MS = 500;
const QUIT_TIMEOUT_MS = 8000;

export interface AppController {
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

/** Non-macOS fallback prompt when we can't reliably launch the app. */
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

export function appController(): AppController {
  return process.platform === "win32" ? windowsController() : macController();
}

/** Whether the Codex desktop app is currently running. */
export function isCodexRunning(): Promise<boolean> {
  return appController().isRunning();
}
