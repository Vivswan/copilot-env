// Loaded before every test file (bunfig.toml's [test] preload): a test file runs only under a HOME
// that COPILOT_ENV_TEST_HOME names. Bun resolves os.homedir() once at startup, so a HOME the
// helpers retarget inside a test never reaches the paths derived from it, and a file started under
// the developer's own HOME writes there: one such run rewrote the real Claude and Codex configs.
// scripts/run_tests.ts starts every child under a scratch HOME and names it in that variable; a
// bare `bun test <file>` names nothing and is refused here. os.userInfo().homedir follows HOME
// under bun too, so there is no account home to compare against: the declaration is the proof.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

const HOME_ENV = process.platform === "win32" ? "USERPROFILE" : "HOME";
const TEST_HOME_ENV = "COPILOT_ENV_TEST_HOME";
const RUN_IT =
  "run the file through `bun run test:unit` or `bun run test <file>`, which start every test file under a scratch HOME";

/** The path as the filesystem resolves it (macOS puts the temp dir behind a symlink), or as
 *  written when it does not exist. */
function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

const home = process.env[HOME_ENV];
if (home === undefined || home === "") {
  throw new Error(`${HOME_ENV} is empty: ${RUN_IT}`);
}
const declared = process.env[TEST_HOME_ENV];
if (declared === undefined || declared === "" || canonical(declared) !== canonical(home)) {
  throw new Error(
    `${HOME_ENV} is not the test home ${TEST_HOME_ENV} names, so this is not a run the launcher started: ${RUN_IT}, or set ${TEST_HOME_ENV} to the HOME in use to run it here anyway`,
  );
}
