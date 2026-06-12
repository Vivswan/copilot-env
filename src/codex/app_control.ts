// Codex desktop-app control (macOS + Windows): detect-installed / is-running /
// open / quit. Deliberately config-free so both mobile.ts (the --mobile pairing
// flow) and app_patch.ts (the image_generation app patch) can import it without
// creating an import cycle through config.ts.
//
// macOS uses open/pgrep/osascript/pkill; Windows drives it via PowerShell
// (Get-StartApps/Get-Process/Start-Process/Stop-Process). There is no Linux Codex app.
import { consola } from "consola";
import { execa } from "execa";

export const APP_NAME = "Codex";
const QUIT_POLL_MS = 500;
const QUIT_TIMEOUT_MS = 8000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Drives the Codex desktop app (install check / running check / open / quit) across
 * macOS and Windows. macOS uses `open`/`pgrep`/`osascript`/`pkill`; Windows drives it
 * via PowerShell (Get-StartApps/Get-Process/Start-Process/Stop-Process). The
 * graceful-then-force `quit()` poll loop is shared; only the per-platform primitives differ.
 */
export class CodexAppController {
  private readonly windows = process.platform === "win32";

  private run(file: string, args: string[]) {
    return execa(file, args, { reject: false });
  }

  private ps(script: string) {
    return execa("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      reject: false,
    });
  }

  /** The Codex app appears installed. */
  async installed(): Promise<boolean> {
    if (this.windows) {
      return (
        (
          await this.ps(
            `if ((Get-StartApps | Where-Object { $_.Name -like '${APP_NAME}*' }) -or (Get-Process -Name '${APP_NAME}' -ErrorAction SilentlyContinue)) { exit 0 } exit 1`,
          )
        ).exitCode === 0
      );
    }
    return (await this.run("open", ["-Ra", APP_NAME])).exitCode === 0;
  }

  /** The Codex app is currently running. */
  async isRunning(): Promise<boolean> {
    if (this.windows) {
      return (
        (
          await this.ps(
            `if (Get-Process -Name '${APP_NAME}' -ErrorAction SilentlyContinue) { exit 0 } exit 1`,
          )
        ).exitCode === 0
      );
    }
    return (await this.run("pgrep", ["-x", APP_NAME])).exitCode === 0;
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
    const deadline = Date.now() + QUIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!(await this.isRunning())) return;
      await sleep(QUIT_POLL_MS);
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
