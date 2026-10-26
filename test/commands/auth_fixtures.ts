// What the auth e2e files share: the names a message carries, a gh account row, and the captured
// channels as words. Each file keeps its own isolate(): the home sandbox is per process, and a
// unit-shaped module may not reach it.
import type { GhAccount } from "../../src/copilot_api/gh_cli.ts";
import { parseProfileName } from "../../src/copilot_api/profile.ts";
import { captureChannels } from "../helpers/output.ts";

/** A branded fixture name: parseProfileName is the only mint for ProfileName. */
export const WORK = parseProfileName("work");

/** The retry command acquireCredential composes for the default slot's `auth`. */
export const AUTH_GH_CLI = "agent auth --provider gh-cli";

/** Every token the auth files provision reads as octocat's; a test that cares stubs its own. */
export const OCTOCAT_LOGINS = {
  ghu_inline_value: "octocat",
  ghu_new_from_env: "octocat",
  ghu_env_value: "octocat",
  ghu_x: "octocat",
  ghu_new: "octocat",
  ghu_stored123: "octocat",
};

/** A captured report as words: the logger and printWrapped wrap a line at COLUMNS when that is
 *  set, so an indented continuation line folds back onto its line. For assertions about the
 *  words, never the width (the 80-column layouts have their own explicit-width tests). */
export function words(captured: string): string {
  return captured.replace(/\n[ \t]+/g, " ");
}

export async function captureStderr(fn: () => Promise<void>): Promise<string> {
  return words((await captureChannels(fn)).stderr);
}

export async function captureStdout(fn: () => Promise<void>): Promise<string> {
  return (await captureChannels(fn)).stdout;
}

export function acct(login: string, active: boolean, source = "keyring"): GhAccount {
  return { host: "github.com", login, active, source };
}
