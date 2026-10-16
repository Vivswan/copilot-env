import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  chooseGhAccount,
  ghCannotServeByName,
  loginWithGhCli,
  parseAcquisition,
  runAuth,
} from "../../src/commands/auth.ts";
import { addProfile } from "../../src/commands/profile.ts";
import {
  accountSourceLabel,
  Credential,
  credentialSourceLabel,
  type GhAccountsLook,
  type GhTokenLook,
  ghAccountsLookFromSpawn,
  ghAuthTokenLookVia,
  ghTokenLookFromSpawn,
  liveCredentialSourceLabel,
  runGhSpecAsync,
} from "../../src/copilot_api/credential.ts";
import { CopilotEnvState } from "../../src/copilot_api/env_state.ts";
import {
  activeGhLogin,
  type GhSpawnSpec,
  ghAuthStatusSpawnSpec,
  ghAuthTokenSpawnSpec,
  parseGhAuthStatusAccounts,
} from "../../src/copilot_api/gh_cli.ts";
import { setGithubLoginFetch } from "../../src/copilot_api/github_login.ts";
import { parseProfileName } from "../../src/copilot_api/profile.ts";
import { errMessage } from "../../src/utils/error.ts";
import { envSnapshot, isolateAgentHomes, resetExitCode } from "../helpers/env.ts";
import { stubGithubLogins } from "../helpers/fixtures.ts";
import { captureChannels } from "../helpers/output.ts";
import { runCli } from "../helpers/run.ts";
import { afterEach, expect, test } from "../helpers/testing.ts";
import { AUTH_GH_CLI, acct, captureStderr, OCTOCAT_LOGINS, words } from "./auth_fixtures.ts";

const restoreEnv = envSnapshot(["PATH"]);
let dir = "";

afterEach(() => {
  restoreEnv();
  resetExitCode();
  setGithubLoginFetch(null);
});

function isolate(): { claudeHome: string; codexHome: string } {
  const homes = isolateAgentHomes("copilot-auth-");
  dir = homes.dir;
  stubGithubLogins(OCTOCAT_LOGINS);
  return { claudeHome: homes.claudeHome, codexHome: homes.codexHome };
}

test("resolveWithReason: one probe answers with the token or names the provider and gh's detail", () => {
  isolate();
  const credential = new Credential(new CopilotEnvState());
  const noGh: GhTokenLook = { kind: "absent", detail: "`gh` is not on this process's PATH" };
  expect(credential.resolveWithReason(() => noGh)).toEqual({
    token: null,
    reason: "no GitHub credential configured - run `agent auth` to log in",
  });
  credential.record({ kind: "gh-cli", ghUser: "octocat" });
  expect(
    credential.resolveWithReason(() => ({ kind: "found", token: "tok", command: "gh auth token" })),
  ).toEqual({
    token: "tok",
    reason: null,
  });
  // gh-cli recorded but gh missing from this process's PATH (the MCP-server case): the
  // provider is named and nothing sends the user to `agent auth`, which from a shell
  // where gh IS on PATH would say "already authenticated".
  const missing = credential.resolveWithReason(() => noGh).reason;
  expect(missing).toContain("provider 'gh-cli as octocat' is selected but no credential resolves");
  expect(missing).toContain("`gh` is not on this process's PATH");
  expect(missing).toContain("minimal PATH");
  expect(missing).not.toContain("agent auth");
  const refused = credential.resolveWithReason(() => ({
    kind: "absent",
    detail: "`gh auth token` exited 1: no oauth token",
  })).reason;
  expect(refused).toContain("no oauth token");
  expect(refused).not.toContain("minimal PATH");
  const named = new Credential(new CopilotEnvState(), parseProfileName("p1"));
  expect(named.resolveWithReason(() => noGh).reason).toContain(
    "for profile 'p1' - run `agent profile p1 auth` to log in (a named profile never falls back",
  );
});

test("ghTokenLookFromSpawn: completed exits prove, a dead spawn stays unproven", () => {
  expect(ghTokenLookFromSpawn({ status: 0, stdout: " tok \n" })).toEqual({
    kind: "found",
    token: "tok",
    command: "gh auth token",
  });
  // gh RAN: proven misses, the detail carrying gh's own first stderr line when there is one.
  expect(
    ghTokenLookFromSpawn({ status: 0, stdout: "", stderr: "credential unavailable\n" }),
  ).toEqual({
    kind: "absent",
    detail: "`gh auth token` printed no token: credential unavailable",
  });
  expect(
    ghTokenLookFromSpawn({ status: 1, stdout: "", stderr: "no oauth token\r\nmore\r\n" }),
  ).toEqual({
    kind: "absent",
    detail: "`gh auth token` exited 1: no oauth token",
  });
  // The spawn never completed (timeout kill / spawn error): proven NOTHING.
  expect(ghTokenLookFromSpawn({ status: null })).toEqual({
    kind: "unproven",
    detail: "`gh auth token` did not complete (the spawn was killed)",
  });
  expect(ghTokenLookFromSpawn({ status: 1, error: new Error("ETIMEDOUT"), stdout: "" })).toEqual({
    kind: "unproven",
    detail: "`gh auth token` did not complete (ETIMEDOUT)",
  });
});

const AUTO = { kind: "auto", activeLogin: null } as const;
const PINNED_WORK = { kind: "pinned", login: "work" } as const;
const WORK_MISS_DETAIL =
  "`gh auth token --user work --hostname github.com` exited 1: no oauth token found";
/** The refusal as the user reads it, every line: the headline, gh's own answer, the ways out with
 *  the command first. The lines are what a user acts on, so the whole message is the contract. */
const WORK_REFUSAL = [
  "gh cannot serve the pinned account by name.",
  "  account: work",
  `  ${WORK_MISS_DETAIL}`,
  "Pick one:",
  "  gh auth login              re-login on gh 2.40 or newer, then retry",
  "  agent auth --gh-user auto  follow gh's active account (switches with gh)",
].join("\n");

test("the refusal paints only what the reader acts on (the login, each command) and stays aligned with color off", () => {
  const CYAN = "\x1b[36m";
  const CLOSE = "\x1b[39m";
  const detail =
    "`gh auth token --user octocat --hostname github.com` exited 1: no oauth token found";
  const painted = ghCannotServeByName("octocat", detail, "agent auth", true, 80).message;
  expect(painted).toBe(
    [
      "gh cannot serve the pinned account by name.",
      `  account: ${CYAN}octocat${CLOSE}`,
      `  ${detail}`,
      "Pick one:",
      `  ${CYAN}gh auth login${CLOSE}              re-login on gh 2.40 or newer, then retry`,
      `  ${CYAN}agent auth --gh-user auto${CLOSE}  follow gh's active account (switches with gh)`,
    ].join("\n"),
  );
  // A pipe or NO_COLOR: the same bytes minus the escapes, so the columns do not shift.
  expect(ghCannotServeByName("octocat", detail, "agent auth", false, 80).message).toBe(
    painted.replaceAll(CYAN, "").replaceAll(CLOSE, ""),
  );
  // A named profile's command is longer. At 80 columns the description wraps under its own
  // column; left to the logger, the hanging indent would put "retry" under the command.
  expect(ghCannotServeByName("octocat", detail, "agent profile work auth", false, 80).message).toBe(
    [
      "gh cannot serve the pinned account by name.",
      "  account: octocat",
      `  ${detail}`,
      "Pick one:",
      "  gh auth login                           re-login on gh 2.40 or newer, then",
      "                                          retry",
      "  agent profile work auth --gh-user auto  follow gh's active account (switches",
      "                                          with gh)",
    ].join("\n"),
  );
});

test("loginWithGhCli: an UNPROVEN look says could-not-check; a pin gh cannot serve by name refuses and never consults the plain call", async () => {
  isolate(); // clears GH_TOKEN/GITHUB_TOKEN so a runner credential never shapes the wording
  const killed: GhTokenLook = {
    kind: "unproven",
    detail: "`gh auth token` did not complete (killed)",
  };
  expect(() => loginWithGhCli(AUTO, () => killed)).toThrow(
    [
      "could not check gh authentication.",
      "  `gh auth token` did not complete (killed)",
      "Fix:",
      "  agent auth  retry",
    ].join("\n"),
  );
  expect(() =>
    loginWithGhCli(AUTO, () => ({
      kind: "absent",
      detail: "`gh auth token` exited 1: not logged in",
    })),
  ).toThrow(
    [
      "gh is not authenticated.",
      "  `gh auth token` exited 1: not logged in",
      "Fix:",
      "  gh auth login  log in",
      "  agent auth     then retry",
    ].join("\n"),
  );
  expect(() =>
    loginWithGhCli(AUTO, () => ({ kind: "found", token: "tok", command: "gh auth token" })),
  ).not.toThrow();
  // The auto success line names the followed account when known (nothing hidden).
  const named = await captureStderr(() => {
    loginWithGhCli({ kind: "auto", activeLogin: "octocat" }, () => ({
      kind: "found",
      token: "tok",
      command: "gh auth token",
    }));
    return Promise.resolve();
  });
  expect(named).toContain(
    "Using the gh CLI login on AUTO as the Direct credential. currently account octocat " +
      "follows gh account switches",
  );
  // A pinned account wears its own words: the miss is about THAT account (gh's active login may
  // well be fine), the look receives the pin to verify, and gh's own stderr is quoted verbatim.
  const asked: Array<string | null> = [];
  const miss: GhTokenLook = { kind: "absent", detail: WORK_MISS_DETAIL };
  const pinnedMiss = (ghUser: string | null) => {
    asked.push(ghUser);
    return miss;
  };
  // An Error argument makes toThrow compare the whole message, not a substring.
  expect(() => loginWithGhCli(PINNED_WORK, pinnedMiss)).toThrow(new Error(WORK_REFUSAL));
  expect(() => loginWithGhCli(PINNED_WORK, () => killed)).toThrow(
    [
      "could not check gh authentication.",
      "  `gh auth token` did not complete (killed)",
      "Fix:",
      "  agent auth  retry",
    ].join("\n"),
  );
  expect(asked).toEqual(["work"]);
  expect(
    loginWithGhCli(PINNED_WORK, () => ({ kind: "found", token: "tok", command: "gh auth token" })),
  ).toEqual({ kind: "pinned", ghUser: "work" });

  // The one saved login on a hosts.yml gh wrote before 2.40: `--user` refuses it while the plain
  // call would serve it. That token is whichever account gh has active, so the pin refuses rather
  // than follow it (a later `gh auth login` would spend the other account's Copilot credit), and
  // the plain call is never asked. The fallback this replaces shipped as #395.
  const served = (ghUser: string | null): GhTokenLook => {
    asked.push(ghUser);
    return ghUser === null
      ? { kind: "found", token: "gho_active", command: "gh auth token --hostname github.com" }
      : miss;
  };
  asked.length = 0;
  expect(() => loginWithGhCli(PINNED_WORK, served)).toThrow(new Error(WORK_REFUSAL));
  expect(asked).toEqual(["work"]);
  // The way out names the command that reruns THIS acquisition: a named profile's user following
  // the default's would re-auth the wrong slot. Width-independent (the command column never
  // wraps); the 80-column layout is pinned above with an explicit width.
  const forWork = thrownBy(() =>
    loginWithGhCli(PINNED_WORK, pinnedMiss, "agent profile work auth"),
  );
  expect(forWork).toContain("  agent profile work auth --gh-user auto  ");
  expect(forWork).not.toContain("agent auth --gh-user auto");
});

/** The message `run` throws, or "" when it returns. */
function thrownBy(run: () => unknown): string {
  try {
    run();
  } catch (e) {
    return errMessage(e);
  }
  return "";
}

// --- the pinned look: one gh call, quoted back on a miss ------------------------------------

/** A remote Linux box: a hosts.yml login and a missing-scope warning that makes `gh auth status`
 *  exit 1. The check marks are gh's output, fine inside a fixture literal. */
const HOSTS_YML_STATUS = `github.com
  \u2713 Logged in to github.com account work-bot (/home/user/.config/gh/hosts.yml)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************
  - Token scopes: 'read:user', 'repo'
  ! Missing required token scopes: 'read:org'
  - To request missing scopes, run: gh auth refresh -h github.com
`;

type GhRun = (spec: GhSpawnSpec) => { status: number | null; stdout: string; stderr: string };

function fakeGh(reply: { status: number | null; stdout?: string; stderr?: string }): {
  run: GhRun;
  calls: string[];
} {
  const calls: string[] = [];
  const run: GhRun = (spec) => {
    calls.push(spec.args.join(" "));
    return { stdout: "", stderr: "", ...reply };
  };
  return { run, calls };
}

const NO_TOKEN_FOR_USER = {
  status: 1,
  stderr: "no oauth token found for github.com account work-bot",
};
const PINNED_CALL = "auth token --user work-bot --hostname github.com";

test("ghAuthTokenLookVia: one gh call per look; a pin gh cannot serve is a proven miss quoting gh, never another account's token", () => {
  isolate();
  const rows: Array<{
    label: string;
    ghUser: string | null;
    reply: { status: number | null; stdout?: string; stderr?: string };
    look: GhTokenLook;
    calls: string[];
  }> = [
    {
      label: "a served pin names the --user call",
      ghUser: "work-bot",
      reply: { status: 0, stdout: "gho_pinned\n" },
      look: { kind: "found", token: "gho_pinned", command: `gh ${PINNED_CALL}` },
      calls: [PINNED_CALL],
    },
    {
      label: "a refused pin quotes gh and asks nothing else",
      ghUser: "work-bot",
      reply: NO_TOKEN_FOR_USER,
      look: {
        kind: "absent",
        detail: `\`gh ${PINNED_CALL}\` exited 1: no oauth token found for github.com account work-bot`,
      },
      calls: [PINNED_CALL],
    },
    {
      label: "auto follows gh's active account through the plain call",
      ghUser: null,
      reply: { status: 1, stderr: "not logged in" },
      look: {
        kind: "absent",
        detail: "`gh auth token --hostname github.com` exited 1: not logged in",
      },
      calls: ["auth token --hostname github.com"],
    },
  ];
  for (const row of rows) {
    const gh = fakeGh(row.reply);
    expect({
      label: row.label,
      look: ghAuthTokenLookVia(row.ghUser, "/opt/gh/gh", gh.run),
      calls: gh.calls,
    }).toEqual({ label: row.label, look: row.look, calls: row.calls });
  }
});

test.skipIf(process.platform === "win32")(
  "runGhSpecAsync settles when gh exits, not when a descendant releases the pipes",
  async () => {
    // A background child inherits gh's stdout: `close` would wait for it, `exit` does not. Its
    // pid comes back on stderr so the test ends it instead of leaving it to run out.
    const started = Date.now();
    const result = await runGhSpecAsync({
      file: "sh",
      args: ["-c", "echo tok; sleep 5 & echo $! >&2"],
      shell: false,
      timeout: 10_000,
      env: { PATH: "/usr/bin:/bin" },
    });
    const elapsed = Date.now() - started;
    const descendant = Number(result.stderr?.trim());
    try {
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("tok\n");
      expect(elapsed).toBeLessThan(900);
    } finally {
      process.kill(descendant);
    }
  },
);

// The production path end to end through a fake `gh` on PATH: status listing -> pin -> the pinned
// look, then the recorded slot resolves through the same code every `--get` runs.
// (POSIX shell scripts; the Windows .cmd dispatch is covered by the launch tests.)
const onPosix = test.skipIf(process.platform === "win32");

function fakeGhOnPath(script: string): void {
  const bin = join(dir, "fake-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "gh"), `#!/bin/sh\n${script}`, { mode: 0o755 });
  // The fake bin dir FIRST, with the system dirs kept: findCommand resolves through `sh`.
  process.env.PATH = `${bin}:/usr/bin:/bin`;
}

/** A gh whose `--user work-bot` call answers `user` (exit 0 serves the token, exit 1 refuses the
 *  pin), whose plain `auth token` serves `plain` when given, and whose status prints `status`
 *  with `statusExit`. Every other call is a test failure. */
function ghScript(
  user: { reply: string; exit: number },
  status: string,
  statusExit: number,
  plain?: string,
): string {
  return [
    'case "$*" in',
    `  "auth token --user work-bot --hostname github.com") echo "${user.reply}"${
      user.exit === 0 ? "" : " >&2"
    }; exit ${user.exit};;`,
    ...(plain === undefined
      ? []
      : [`  "auth token --hostname github.com") echo "${plain}"; exit 0;;`]),
    `  "auth status --hostname github.com") cat <<'STATUS'\n${status}STATUS\n    exit ${statusExit};;`,
    '  *) echo "unexpected gh call: $*" >&2; exit 2;;',
    "esac",
    "",
  ].join("\n");
}

onPosix(
  "auth --provider gh-cli lands a hosts.yml login through a fake gh; a pin gh cannot serve by name refuses, and only --gh-user auto follows the active account",
  async () => {
    const hadTty = process.stdin.isTTY;
    process.stdin.isTTY = false;
    try {
      isolate();
      fakeGhOnPath(ghScript({ reply: "gho_saved", exit: 0 }, HOSTS_YML_STATUS, 1));
      await runAuth({ provider: "gh-cli" });
      const stored = new CopilotEnvState().read();
      expect([stored.authProvider, stored.ghUser]).toEqual(["gh-cli", "work-bot"]);
      expect(new Credential().resolveWithReason()).toEqual({ token: "gho_saved", reason: null });
      // The same box after `gh auth switch` to another account: the failure quotes gh's own refusal
      // and never adopts the active account's token in the pin's place.
      const WORK_BOT_REFUSAL = [
        "gh cannot serve the pinned account by name.",
        "  account: work-bot",
        "  `gh auth token --user work-bot --hostname github.com` exited 1: no oauth token found " +
          "for github.com account work-bot",
        "Pick one:",
        "  gh auth login              re-login on gh 2.40 or newer, then retry",
        "  agent auth --gh-user auto  follow gh's active account (switches with gh)",
      ].join("\n");
      isolate();
      fakeGhOnPath(ghScript({ reply: NO_TOKEN_FOR_USER.stderr, exit: 1 }, TWO_ACCOUNT_STATUS, 0));
      await expect(runAuth({ provider: "gh-cli", ghUser: "work-bot" })).rejects.toThrow(
        new Error(WORK_BOT_REFUSAL),
      );
      expect(new CopilotEnvState().read().authProvider).toBeNull();
      // The pre-2.40 single-account hosts.yml (no `users:` map): status lists the one login,
      // `--user` refuses it, the plain call would serve it. Following the active account is the
      // user's choice, never a fallback, so nothing lands and the refusal names that choice.
      isolate();
      fakeGhOnPath(
        ghScript({ reply: NO_TOKEN_FOR_USER.stderr, exit: 1 }, HOSTS_YML_STATUS, 1, "gho_legacy"),
      );
      await expect(runAuth({ provider: "gh-cli" })).rejects.toThrow(new Error(WORK_BOT_REFUSAL));
      expect(new CopilotEnvState().read().authProvider).toBeNull();
      // The named way out, taken: `--gh-user auto` lands the auto slot, says which account it
      // follows right now, and resolves through the plain call.
      const chosen = await captureStderr(() => runAuth({ provider: "gh-cli", ghUser: "auto" }));
      expect(chosen).toContain(
        "Using the gh CLI login on AUTO as the Direct credential. currently account work-bot " +
          "follows gh account switches",
      );
      const landed = new CopilotEnvState().read();
      expect([landed.authProvider, landed.ghUser]).toEqual(["gh-cli", null]);
      expect(new Credential().resolveWithReason()).toEqual({ token: "gho_legacy", reason: null });
    } finally {
      process.stdin.isTTY = hadTty;
    }
  },
);

onPosix(
  "a fresh named profile's `add --auto --gh-user <login>` refusal names the add form it can rerun, never an auth command whose slot does not exist yet",
  async () => {
    const hadTty = process.stdin.isTTY;
    // addNamedProbed signs in only in a terminal; with --gh-user nothing is asked.
    process.stdin.isTTY = true;
    try {
      isolate();
      fakeGhOnPath(
        ghScript({ reply: NO_TOKEN_FOR_USER.stderr, exit: 1 }, HOSTS_YML_STATUS, 1, "gho_legacy"),
      );
      const work = parseProfileName("work");
      let refusal = "";
      await captureStderr(async () => {
        try {
          await addProfile(work, { mode: "auto", ghUser: "work-bot" });
        } catch (e) {
          refusal = errMessage(e);
        }
      });
      expect(refusal).toContain("gh cannot serve the pinned account by name.\n  account: work-bot");
      expect(refusal).toContain("  agent profile work add --auto --gh-user auto  ");
      expect(refusal).not.toContain("work auth");
      // Nothing landed: the slot the auth form would need still does not exist.
      expect(new CopilotEnvState().profileSlotStatus(work).exists).toBe(false);
      // --gh-user is the sign-in step's flag, so it cannot ride with --no-auth.
      await expect(
        addProfile(work, { mode: "direct", ghUser: "auto", noAuth: true }),
      ).rejects.toThrow("--gh-user runs the sign-in step; drop --no-auth");
    } finally {
      process.stdin.isTTY = hadTty;
    }
  },
);

onPosix(
  "a dry run checks an explicit --gh-user pin as the real run does: the same refusal before anything is planned, and a servable pin's slot planned on the overlay with nothing written",
  async () => {
    const hadTty = process.stdin.isTTY;
    process.stdin.isTTY = true;
    try {
      // The pre-2.40 hosts.yml: `--user` refuses, the plain call would serve. Before this fix the
      // dry run of every add form printed "Would run the credential step" and succeeded while the
      // real run refused the pin.
      isolate();
      fakeGhOnPath(
        ghScript({ reply: NO_TOKEN_FOR_USER.stderr, exit: 1 }, HOSTS_YML_STATUS, 1, "gho_legacy"),
      );
      const work = parseProfileName("work");
      const refusals: Record<string, string> = {};
      const attempt = async (label: string, run: () => Promise<void>): Promise<string> => {
        let message = "";
        const { stdout } = await captureChannels(async () => {
          try {
            await run();
          } catch (e) {
            message = errMessage(e);
          }
        });
        refusals[label] = message;
        return words(stdout);
      };
      const flaggedDry = await attempt("flagged dry", () =>
        addProfile(work, { mode: "proxy", ghUser: "work-bot", dryRun: true }),
      );
      expect(refusals["flagged dry"]).toContain(
        "gh cannot serve the pinned account by name.\n  account: work-bot",
      );
      // The mode landed on the overlay before the step refused, so the plan shows what the real
      // run would have written before failing, and the store itself is untouched.
      expect(flaggedDry).toContain("Before it failed, the command would have:");
      expect(flaggedDry).toContain('profiles.work.mode  (absent) -> "proxy"');
      expect(new CopilotEnvState().profileSlotStatus(work).exists).toBe(false);
      await attempt("probed dry", () =>
        addProfile(work, { mode: "auto", ghUser: "work-bot", dryRun: true }),
      );
      expect(refusals["probed dry"]).toContain("  agent profile work add --auto --gh-user auto  ");
      expect(new CopilotEnvState().profileSlotStatus(work).exists).toBe(false);
      // The real flagged run refuses with the very same message (the mode record stays, as before).
      await attempt("flagged real", () => addProfile(work, { mode: "proxy", ghUser: "work-bot" }));
      expect(refusals["flagged real"]).toBe(refusals["flagged dry"]);
      // A servable pin: the dry run plans the slot's credential through the same step.
      isolate();
      fakeGhOnPath(ghScript({ reply: "gho_saved", exit: 0 }, HOSTS_YML_STATUS, 1));
      const planned = await attempt("servable dry", () =>
        addProfile(work, { mode: "proxy", ghUser: "work-bot", dryRun: true }),
      );
      expect(refusals["servable dry"]).toBe("");
      expect(planned).toContain("DRY RUN: nothing was written. The command would:");
      expect(planned).toContain('profiles.work.mode  (absent) -> "proxy"');
      expect(planned).toContain('profiles.work.ghUser  (absent) -> "work-bot"');
      expect(new CopilotEnvState().profileSlotStatus(work).exists).toBe(false);
    } finally {
      process.stdin.isTTY = hadTty;
    }
  },
);

onPosix(
  "headless, a dry run and the real run agree: an explicit --gh-user needs no terminal in either, a bare sign-in refuses in both, and only a terminal's bare dry run narrates the step",
  async () => {
    const hadTty = process.stdin.isTTY;
    process.stdin.isTTY = false;
    try {
      isolate();
      fakeGhOnPath(ghScript({ reply: "gho_saved", exit: 0 }, HOSTS_YML_STATUS, 1));
      const outcome = async (run: () => Promise<void>): Promise<string> => {
        let message = "";
        await captureChannels(async () => {
          try {
            await run();
          } catch (e) {
            message = errMessage(e);
          }
        });
        return message;
      };
      // A flag-settled acquisition prompts for nothing, so headless it runs in both: the dry run
      // plans, the real run lands the slot.
      const work = parseProfileName("work");
      const settledDry = await outcome(() =>
        addProfile(work, { mode: "proxy", ghUser: "work-bot", dryRun: true }),
      );
      expect(new CopilotEnvState().profileSlotStatus(work).exists).toBe(false);
      const settledReal = await outcome(() =>
        addProfile(work, { mode: "proxy", ghUser: "work-bot" }),
      );
      expect(settledReal).toBe(settledDry);
      expect(settledReal).toBe("");
      expect(new CopilotEnvState().profileSlotStatus(work).slot.credential).toMatchObject({
        kind: "gh-cli",
        ghUser: "work-bot",
      });
      // A bare sign-in would prompt, so headless both runs refuse before anything lands or plans.
      const other = parseProfileName("other");
      for (const mode of ["proxy", "auto"] as const) {
        const bareDry = await outcome(() => addProfile(other, { mode, dryRun: true }));
        const bareReal = await outcome(() => addProfile(other, { mode }));
        expect(bareReal, mode).toBe(bareDry);
        expect(bareReal, mode).toContain("not a terminal - pass ");
        expect(new CopilotEnvState().profileSlotStatus(other).exists, mode).toBe(false);
      }
      // In a terminal the bare dry run cannot prompt either: it names the step it would run.
      process.stdin.isTTY = true;
      const named = await captureStderr(() => addProfile(other, { mode: "proxy", dryRun: true }));
      expect(named).toContain("Would run the credential step (agent profile other auth)");
      const init = await captureStderr(() => addProfile(null, { mode: "proxy", dryRun: true }));
      expect(init).toContain("Would run the credential step (agent auth)");
    } finally {
      process.stdin.isTTY = hadTty;
    }
  },
);

onPosix(
  "agent init takes --gh-user <login|auto> like add: the default profile's dry run plans the pinned slot headless",
  () => {
    isolate();
    fakeGhOnPath(ghScript({ reply: "gho_saved", exit: 0 }, HOSTS_YML_STATUS, 1));
    const env = { ...process.env, NO_COLOR: "1" };
    const help = runCli(["init", "--help"], { env });
    expect(help.stdout).toContain("--gh-user <login|auto>");
    const dry = runCli(["init", "--proxy", "--gh-user", "work-bot", "--dry-run"], { env });
    expect([dry.exitCode, dry.stderr]).toEqual([0, expect.not.stringContaining("unknown option")]);
    expect(dry.stdout).toContain("DRY RUN: nothing was written. The command would:");
    expect(dry.stdout).toContain('"work-bot"');
    expect(new CopilotEnvState().read().authProvider).toBeNull();
  },
);

// --- gh multi-account selection (choice menu only, never an auth verdict) ------

// Real `gh auth status` shape (gh >= 2.40): per-host blocks, one "Logged in to"
// line per account, the active one flagged on its own line. The check mark is
// gh's output, fine inside a fixture literal.
const TWO_ACCOUNT_STATUS = `github.com
  ✓ Logged in to github.com account octocat (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************
  ✓ Logged in to github.com account work-bot (keyring)
  - Active account: false
`;

/** The gap that sets a bare retry cell level with the ` --gh-user <login>` one beside it. */
const PAD = " ".repeat(" --gh-user <login>".length + 2);

test("parseGhAuthStatusAccounts: accounts with active attribution; broken logins and noise never match", () => {
  expect(parseGhAuthStatusAccounts(TWO_ACCOUNT_STATUS)).toEqual([
    acct("octocat", true),
    acct("work-bot", false),
  ]);
  // A broken login is never pickable, and its block's own "Active account: true" must not mark the
  // healthy account parsed before it, in ANY of gh's failure wordings. Each failure block sits
  // DIRECTLY after a healthy account, so a reset regex missing that wording marks the wrong
  // account.
  const withBrokenActive = [
    "github.com",
    "  ✓ Logged in to github.com account healthy (keyring)",
    "  - Active account: false",
    "  ✗ Timeout trying to log in to github.com account slow (keyring)",
    "  - Active account: true",
    "  ✓ Logged in to github.com account steady (keyring)",
    "  - Active account: false",
    "  ✗ Failed to log in to github.com account broken (keyring)",
    "  - Active account: true",
    "enterprise.example",
    "  ✗ Failed to log in to enterprise.example using token (GH_ENTERPRISE_TOKEN)",
    "  - Active account: true",
  ].join("\n");
  expect(parseGhAuthStatusAccounts(withBrokenActive)).toEqual([
    acct("healthy", false),
    { host: "github.com", login: "slow", active: true, source: "keyring", broken: true },
    acct("steady", false),
    { host: "github.com", login: "broken", active: true, source: "keyring", broken: true },
    {
      host: "enterprise.example",
      login: "",
      active: true,
      source: "GH_ENTERPRISE_TOKEN",
      broken: true,
    },
  ]);
  // The BROKEN active login still names what auto follows: gh's bare resolution tracks the active
  // account even when its login is broken.
  expect(activeGhLogin(parseGhAuthStatusAccounts(withBrokenActive))).toBe("slow");
  expect(parseGhAuthStatusAccounts("You are not logged into any GitHub hosts.")).toEqual([]);
  // The credential source is captured for DISPLAY only: an exported GH_TOKEN can shadow a saved
  // keyring credential for the same login, so the source never decides pinnability.
  const envOverlap = parseGhAuthStatusAccounts(
    [
      "  ✓ Logged in to github.com account ci-bot (GH_TOKEN)",
      "  - Active account: true",
      "  ✓ Logged in to github.com account ci-bot (keyring)",
      "  - Active account: false",
    ].join("\n"),
  );
  expect(envOverlap).toEqual([acct("ci-bot", true, "GH_TOKEN"), acct("ci-bot", false)]);
  expect(activeGhLogin(envOverlap)).toBe("ci-bot");
  expect(activeGhLogin([acct("solo", false)])).toBe("solo");
  expect(activeGhLogin([acct("a", false), acct("b", false)])).toBeNull();
  expect(activeGhLogin([])).toBeNull();
  // No active marker + a broken sibling: ambiguous, so nothing is named (the
  // only-login fallback needs the WHOLE list, broken included, to agree).
  expect(
    activeGhLogin([
      acct("healthy", false),
      { host: "github.com", login: "slow", active: false, source: "keyring", broken: true },
    ]),
  ).toBeNull();
  // An active entry whose login is unparseable (per-host env failure) names nothing.
  expect(
    activeGhLogin([
      { host: "github.com", login: "", active: true, source: "GH_TOKEN", broken: true },
      acct("healthy", false),
    ]),
  ).toBeNull();
  // No marker + an UNNAMED broken sibling: still ambiguous, still nothing named.
  expect(
    activeGhLogin([
      { host: "github.com", login: "", active: false, source: "GH_TOKEN", broken: true },
      acct("healthy", false),
    ]),
  ).toBeNull();
  // A repeated host+login+source triple collapses to one menu entry.
  expect(parseGhAuthStatusAccounts(TWO_ACCOUNT_STATUS + TWO_ACCOUNT_STATUS).length).toBe(2);
});

test("the gh spawn recipes: every token call names github.com, a pinned account adds --user", () => {
  // Host-scoped both ways: a bare `gh auth token` follows a GH_HOST override to another host.
  const AUTO_CALL = ["auth", "token", "--hostname", "github.com"];
  expect(ghAuthTokenSpawnSpec("/opt/gh/gh").args).toEqual(AUTO_CALL);
  expect(ghAuthTokenSpawnSpec("/opt/gh/gh", null).args).toEqual(AUTO_CALL);
  // The pin was chosen from github.com's logins, so the resolve names the host:
  // a GH_HOST override must not point --user at another host's accounts.
  expect(ghAuthTokenSpawnSpec("/opt/gh/gh", "work-bot").args).toEqual([
    "auth",
    "token",
    "--user",
    "work-bot",
    "--hostname",
    "github.com",
  ]);
  // The status probe is scoped to the pinnable host (an unreachable enterprise
  // host must not eat the timeout), and its machine-parsed output is stripped of
  // forced color: NO_COLOR set, the forcing vars dropped.
  const hadForce = process.env.CLICOLOR_FORCE;
  process.env.CLICOLOR_FORCE = "1";
  try {
    const status = ghAuthStatusSpawnSpec("/opt/gh/gh");
    expect(status.args).toEqual(["auth", "status", "--hostname", "github.com"]);
    expect(status.env.NO_COLOR).toBe("1");
    expect(status.env.CLICOLOR_FORCE).toBeUndefined();
  } finally {
    if (hadForce === undefined) delete process.env.CLICOLOR_FORCE;
    else process.env.CLICOLOR_FORCE = hadForce;
  }
});

test("ghAccountsLookFromSpawn: ANY completed exit parses stdout+stderr; a dead spawn is unproven", () => {
  const logins = (look: GhAccountsLook): string[] | "unproven" =>
    look.kind === "listed" ? look.accounts.map((a) => a.login) : look.kind;
  expect(
    logins(ghAccountsLookFromSpawn({ status: 0, stdout: TWO_ACCOUNT_STATUS, stderr: "" })),
  ).toEqual(["octocat", "work-bot"]);
  // gh exits non-zero when one account's login is broken but still lists the
  // healthy ones, and older gh printed the status to stderr: both stay proven.
  expect(
    logins(ghAccountsLookFromSpawn({ status: 1, stdout: null, stderr: TWO_ACCOUNT_STATUS })),
  ).toEqual(["octocat", "work-bot"]);
  expect(ghAccountsLookFromSpawn({ status: null })).toEqual({ kind: "unproven" });
  expect(ghAccountsLookFromSpawn({ status: 0, error: new Error("ETIMEDOUT") })).toEqual({
    kind: "unproven",
  });
});

test("chooseGhAccount: pinning is the only default - sole login pins, non-TTY pins the active, auto never settles itself", async () => {
  // Pin stdin to non-TTY for the duration: the settle rules under test are the
  // non-interactive ones, and an interactive dev run must not open a prompt.
  const hadTty = process.stdin.isTTY;
  process.stdin.isTTY = false;
  try {
    // Nothing pinnable is an ERROR naming the escape hatches - recording auto
    // would let a later `gh auth login` spend an unchosen account's credit.
    await expect(chooseGhAccount(AUTH_GH_CLI, () => ({ kind: "unproven" }))).rejects.toThrow(
      [
        "could not list gh accounts.",
        "  `gh auth status` did not run to completion",
        "Pick one:",
        `  ${AUTH_GH_CLI}${PAD}run it again`,
        `  ${AUTH_GH_CLI} --gh-user <login>  pin an account by name, no listing needed`,
      ].join("\n"),
    );
    await expect(
      chooseGhAccount(AUTH_GH_CLI, () => ({ kind: "listed", accounts: [] })),
    ).rejects.toThrow(
      [
        "gh has no logged-in github.com account.",
        "Fix:",
        "  gh auth login                 log in",
        "  agent auth --provider gh-cli  then run it again",
      ].join("\n"),
    );
    // One saved account: pinned to it. The slot write refuses when gh cannot serve it by name;
    // it never settles on auto for the user.
    expect(
      await chooseGhAccount(AUTH_GH_CLI, () => ({
        kind: "listed",
        accounts: [acct("solo", true)],
      })),
    ).toEqual({
      kind: "pinned",
      login: "solo",
    });
    // Another host's login is not a github.com choice (Copilot's host).
    expect(
      await chooseGhAccount(AUTH_GH_CLI, () => ({
        kind: "listed",
        accounts: [
          acct("solo", true),
          {
            host: "ghe.example.com",
            login: "enterprise",
            active: false,
            source: "keyring",
          },
        ],
      })),
    ).toEqual({ kind: "pinned", login: "solo" });
    // 2+ logins, non-TTY: the ACTIVE one is pinned, with a hint naming it and
    // the escape hatches (an env-token source is still a choice - it may
    // shadow a saved credential; the verify step is the gate, never the menu).
    let envChoice: Awaited<ReturnType<typeof chooseGhAccount>> | undefined;
    const envErr = (
      await captureChannels(async () => {
        envChoice = await chooseGhAccount(AUTH_GH_CLI, () => ({
          kind: "listed",
          accounts: [acct("solo", false), acct("ci-bot", true, "GH_TOKEN")],
        }));
      })
    ).stderr;
    expect(envChoice).toEqual({ kind: "pinned", login: "ci-bot" });
    expect(envErr).toContain(
      "gh has 2 logged-in accounts; pinning the active one.\n  active account: ci-bot\n",
    );
    expect(envErr).toContain(
      [
        "Pick one:",
        `  ${AUTH_GH_CLI} --gh-user <login>  pin another account`,
        `  ${AUTH_GH_CLI}${PAD}choose in a terminal (auto included)`,
        "",
      ].join("\n"),
    );
    // The env-token overlap of a saved login must not shrink the choice set.
    let overlapChoice: Awaited<ReturnType<typeof chooseGhAccount>> | undefined;
    await captureStderr(async () => {
      overlapChoice = await chooseGhAccount(AUTH_GH_CLI, () => ({
        kind: "listed",
        accounts: [
          acct("octocat", true, "GH_TOKEN"),
          acct("octocat", false),
          acct("work-bot", false),
        ],
      }));
    });
    expect(overlapChoice).toEqual({ kind: "pinned", login: "octocat" });
    // 2+ logins and NO determinable active account: an error, never a guess.
    await expect(
      chooseGhAccount(AUTH_GH_CLI, () => ({
        kind: "listed",
        accounts: [acct("a", false), acct("b", false)],
      })),
    ).rejects.toThrow(
      [
        "gh has 2 logged-in accounts and no pinnable active one.",
        "  pinnable: a, b",
        "Pick one:",
        `  ${AUTH_GH_CLI} --gh-user <login>  pin one of them`,
        `  ${AUTH_GH_CLI}${PAD}choose in a terminal`,
      ].join("\n"),
    );
    // A BROKEN entry still counts as an account: {healthy bystander, broken
    // active} is a multi-account machine, so the bystander is never pinned
    // silently - without a TTY that is the same honest error.
    await expect(
      chooseGhAccount(AUTH_GH_CLI, () => ({
        kind: "listed",
        accounts: [acct("healthy", false), { ...acct("hurt", true), broken: true as const }],
      })),
    ).rejects.toThrow(
      [
        "gh has 2 logged-in accounts and no pinnable active one.",
        "  pinnable: healthy",
        "Pick one:",
        `  ${AUTH_GH_CLI} --gh-user <login>  pin one of them`,
        `  ${AUTH_GH_CLI}${PAD}choose in a terminal`,
      ].join("\n"),
    );
    // A dry run has one way out: the flag, since a preview never prompts.
    await expect(
      chooseGhAccount(
        AUTH_GH_CLI,
        () => ({ kind: "listed", accounts: [acct("a", false), acct("b", false)] }),
        "dry-run",
      ),
    ).rejects.toThrow(
      [
        "gh has 2 logged-in accounts and no pinnable active one.",
        "  pinnable: a, b",
        "Fix:",
        "  --gh-user <login>  add it to plan that landing (a dry run never prompts)",
      ].join("\n"),
    );
    // Every way out is the acquisition's own retry command or extends it: for a named profile
    // that is its own `auth`, never the default slot's `agent auth`, which would leave the profile
    // as it was.
    const WORK = "agent profile work auth --provider gh-cli";
    await expect(chooseGhAccount(WORK, () => ({ kind: "unproven" }))).rejects.toThrow(
      [
        "Pick one:",
        `  ${WORK}${PAD}run it again`,
        `  ${WORK} --gh-user <login>  pin an account by name, no listing needed`,
      ].join("\n"),
    );
    const workPin = (
      await captureChannels(async () => {
        await chooseGhAccount(WORK, () => ({
          kind: "listed",
          accounts: [acct("solo", false), acct("ci-bot", true)],
        }));
      })
    ).stderr;
    expect(workPin).toContain(
      [
        "Pick one:",
        `  ${WORK} --gh-user <login>  pin another account`,
        `  ${WORK}${PAD}choose in a terminal (auto included)`,
        "",
      ].join("\n"),
    );
    await expect(
      chooseGhAccount(WORK, () => ({
        kind: "listed",
        accounts: [acct("a", false), acct("b", false)],
      })),
    ).rejects.toThrow(
      [
        "Pick one:",
        `  ${WORK} --gh-user <login>  pin one of them`,
        `  ${WORK}${PAD}choose in a terminal`,
      ].join("\n"),
    );
    // A sole ENV-ONLY login still pins without a TTY (nothing to ask): its
    // verification failure names the recovery.
    expect(
      await chooseGhAccount(AUTH_GH_CLI, () => ({
        kind: "listed",
        accounts: [acct("solo", true, "GH_TOKEN")],
      })),
    ).toEqual({ kind: "pinned", login: "solo" });
  } finally {
    process.stdin.isTTY = hadTty;
  }
});

test("parseAcquisition: --gh-user implies gh-cli and rejects every conflicting flag", () => {
  expect(parseAcquisition(undefined, undefined, "work-bot")).toEqual({
    kind: "gh-cli",
    account: { kind: "pinned", login: "work-bot" },
  });
  expect(parseAcquisition("gh-cli", undefined, " work-bot ")).toEqual({
    kind: "gh-cli",
    account: { kind: "pinned", login: "work-bot" },
  });
  // A bare gh-cli provider still asks (a sole saved login pins itself).
  expect(parseAcquisition("gh-cli", undefined, undefined)).toEqual({
    kind: "gh-cli",
    account: { kind: "choose" },
  });
  // `auto` is the one value that is not a login: the explicit choice to follow gh's active
  // account. Any casing, as GitHub logins are case-blind, so no spelling of it pins a user.
  for (const auto of ["auto", " AUTO "]) {
    expect(parseAcquisition(undefined, undefined, auto)).toEqual({
      kind: "gh-cli",
      account: { kind: "auto" },
    });
  }
  expect(() => parseAcquisition("copilot", undefined, "x")).toThrow(
    "--gh-user only applies to `--provider gh-cli`",
  );
  expect(() => parseAcquisition(undefined, "tok", "x")).toThrow("--set implies gh-token");
  // The shape gate: the pin becomes a `gh auth token --user` argv token that
  // crosses cmd.exe on Windows, so anything outside a GitHub login's alphabet
  // (blank included) is rejected before it can reach a shell.
  for (const bad of ["   ", "%USERNAME%", "a b", "x;rm", "why'd"]) {
    expect(() => parseAcquisition(undefined, undefined, bad)).toThrow(
      "--gh-user must be a GitHub login (1-39 letters, digits, dashes, or underscores) or `auto`",
    );
  }
});

test("Credential.resolve threads the slot's account pin into the gh probe", () => {
  isolate();
  const asked: Array<string | null> = [];
  const gh = (ghUser: string | null): string | null => {
    asked.push(ghUser);
    return "tok";
  };
  new CopilotEnvState().setCredential(null, { kind: "gh-cli", ghUser: null });
  expect(new Credential().resolve(gh)).toBe("tok");
  new CopilotEnvState().setCredential(null, { kind: "gh-cli", ghUser: "work-bot" });
  expect(new Credential().resolve(gh)).toBe("tok");
  expect(asked).toEqual([null, "work-bot"]);
});

test("liveCredentialSourceLabel: an auto slot SAYS auto and lists what it may use, bracket-free", () => {
  const cred = { kind: "gh-cli", ghUser: null } as const;
  // Auto is explicit, the followed account is named, and every account it may
  // use is listed -- with NO nested brackets (callers add the one paren level).
  expect(
    liveCredentialSourceLabel(cred, () => ({
      kind: "listed",
      accounts: [acct("octocat", true), acct("work-bot", false)],
    })),
  ).toBe("gh-cli on auto: currently octocat; may use octocat, work-bot");
  // Unproven/empty looks keep the bare auto label (never a guessed account),
  // and a pinned slot never spawns the look at all.
  expect(liveCredentialSourceLabel(cred, () => ({ kind: "unproven" }))).toBe("gh-cli on auto");
  expect(
    liveCredentialSourceLabel({ kind: "gh-cli", ghUser: "work-bot" }, () => {
      throw new Error("a pinned slot must not probe gh");
    }),
  ).toBe("gh-cli as work-bot");
});

test("accountSourceLabel: a missed look's raw error text stays bracket-free, and no kind probes the other's source", async () => {
  const stored = { kind: "stored", provider: "gh-env", token: "ghu_env_value" } as const;
  const gh = () => {
    throw new Error("a stored token never probes gh");
  };
  // The callers wrap the label in their one paren level, so an OS error's own parens would nest.
  expect(
    await accountSourceLabel(stored, gh, () =>
      Promise.resolve({
        login: null,
        detail: "GitHub could not be reached: dns error (os error 2)",
      }),
    ),
  ).toBe("gh-env; account unverified: GitHub could not be reached: dns error, os error 2");
  // A gh-cli slot's account comes from gh, so it never costs a GitHub call (and works offline).
  const github = () => {
    throw new Error("a gh-cli slot must not ask GitHub");
  };
  expect(await accountSourceLabel({ kind: "gh-cli", ghUser: "work-bot" }, gh, github)).toBe(
    "gh-cli as work-bot",
  );
});

test("credentialSourceLabel: a pinned gh account is named, bracket-free", () => {
  // The static half of the read-back label: BRACKET-FREE by contract (the
  // surfaces wrap it in their one paren level; nested brackets are unreadable).
  expect(credentialSourceLabel({ kind: "gh-cli", ghUser: null })).toBe("gh-cli");
  expect(credentialSourceLabel({ kind: "gh-cli", ghUser: "work-bot" })).toBe("gh-cli as work-bot");
  expect(credentialSourceLabel({ kind: "stored", provider: "gh-token", token: "t" })).toBe(
    "gh-token",
  );
  expect(credentialSourceLabel({ kind: "none", provider: null })).toBeNull();
});
