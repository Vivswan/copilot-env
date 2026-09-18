// `agent profile [<name>] <verb>` is routing onto the functions main's flat spellings called. The
// oracle is main's own output: test/fixtures/cli_redesign/main_oracle.json holds what each old
// spelling printed (stdout, exit code) in a scratch HOME, and the new spelling must print the same.
// verbs_oracle.json is the same kind of pin for the verbs' own output, captured when the tree only
// routed onto the flat commands' bodies: with the bodies folded under the verbs, each verb still
// names the same files in the same order. The two kept aliases (`agent init`, `agent auth`) are
// proven against their verbs live, in twin homes. The verbs are reserved names, pinned at the CLI.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { changedPaths } from "./helpers.ts";
import {
  expectIdentical,
  expectOracle as expectOracleOf,
  loadFixture,
  loadOracle,
  observe,
  type Oracle,
  type ScratchHome,
  scratchHome as scratchHomeOf,
  treeContents,
} from "./helpers/cli_oracle.ts";
import { expect, test } from "./helpers/testing.ts";

const ORACLE = loadOracle("main_oracle");

/** The verbs' own oracle: the commands that seed the scratch state, then what each verb printed
 *  for it. Only stdout the CLI writes itself (plans, key/value lines): a consola line's prefix
 *  differs between the CI reporter and the local one. */
const VERBS_ORACLE = loadFixture("verbs_oracle") as { seed: string[][]; observed: Oracle };

const scratchHome = () => scratchHomeOf("copilot-profile-verbs-");

/** The new spelling prints what main's old spelling printed. */
function expectOracle(oracleKey: string, args: string[], scratch: ScratchHome) {
  return expectOracleOf(ORACLE, oracleKey, args, scratch);
}

test(
  "the verbs are reserved words, a flag before the verb is refused, and `help <verb>` works",
  () => {
    const scratch = scratchHome();
    const refusals: [string[], string[]][] = [
      [["profile", "add", "sync"], ["'sync' is a reserved word"]],
      [["profile", "list"], ["'list' is a reserved word", "agent list"]],
      // A real name in the verb's argument slot is the old `--add <name>` habit, named as such.
      [["profile", "add", "work"], [
        "the profile name goes before the verb",
        "agent profile work add",
      ]],
      // A flag before the verb belongs to no command, so nothing runs (`--dry-run` before `del`
      // could otherwise delete for real).
      [["profile", "work", "--dry-run", "del"], ["unknown option '--dry-run'"]],
      // A named spelling of a default-only alias is the verb's, never a flag's.
      [["auth", "--profile", "work", "--get"], ["unknown option '--profile'"]],
    ];
    for (const [args, needles] of refusals) {
      const proc = observe(args, scratch);
      expect(proc.exitCode, args.join(" ")).toBe(1);
      // The needles avoid the backticked spans: consola's CI reporter keeps the backticks, the
      // interactive one strips them.
      for (const needle of needles) expect(proc.stderr, args.join(" ")).toContain(needle);
    }
    const help = observe(["profile", "help", "add"], scratch);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("Usage: agent profile add");
  },
  90_000,
);

test(
  "no name is the default profile: bare `agent profile` lists, auth reads the default slot, show names it, del refuses",
  () => {
    const scratch = scratchHome();
    expectOracle("auth --set", ["profile", "auth", "--set", "ghu_test"], scratch);
    expectOracle("auth --get", ["profile", "auth", "--get"], scratch);

    const show = observe(["profile", "show"], scratch);
    expect(show.exitCode).toBe(0);
    expect(show.stdout).toContain("default\n");
    expect(show.stdout).toContain("provider: gh-token");

    const del = observe(["profile", "del"], scratch);
    expect(del.exitCode).toBe(1);
    expect(del.stderr).toContain("the default profile cannot be deleted");

    // The default is a profile: with a credential stored it is the list's one row.
    const bare = observe(["profile"], scratch);
    expect(bare.exitCode).toBe(0);
    expect(bare.stdout + bare.stderr).toMatch(/default\s+incomplete\s+gh-token/);
    expect(observe(["list"], scratch).stdout + "").toBe(bare.stdout);

    // `set identity auto` is the pin's one spelling; `auto` stores without a probe.
    const identity = observe(["profile", "set", "identity", "auto"], scratch);
    expect(identity.exitCode).toBe(0);
    expect(identity.stdout + identity.stderr).toContain("identity = auto");
  },
  120_000,
);

test(
  "the kept aliases are one code path with their verbs: same exit code, output, and files in twin homes",
  () => {
    const fresh = [scratchHome(), scratchHome()] as const;
    const authed = expectIdentical(
      { args: ["auth", "--set", "ghu_test"], scratch: fresh[0] },
      { args: ["profile", "auth", "--set", "ghu_test"], scratch: fresh[1] },
    );
    expect(authed.exitCode).toBe(0);
    const wired = expectIdentical(
      { args: ["init", "--proxy"], scratch: fresh[0] },
      { args: ["profile", "add", "--proxy"], scratch: fresh[1] },
    );
    expect(wired.exitCode).toBe(0);
    expect(existsSync(join(fresh[1].home, ".codex", "config.toml"))).toBe(true);
    // No name on a profile-default key is `agent config`'s shared default: set, get, and unset
    // print the same and leave the same bytes (the default profile never carries an override).
    const shared = expectIdentical(
      { args: ["config", "set", "proxy.small-model", "gpt-x"], scratch: fresh[0] },
      { args: ["profile", "set", "proxy.small-model", "gpt-x"], scratch: fresh[1] },
    );
    expect(shared.exitCode).toBe(0);
    expect(readFileSync(join(fresh[1].home, "state.json"), "utf8")).toContain('"gpt-x"');
    const read = expectIdentical(
      { args: ["config", "get", "proxy.small-model"], scratch: fresh[0] },
      { args: ["profile", "get", "proxy.small-model"], scratch: fresh[1] },
    );
    expect(read.stdout).toBe("gpt-x\n");
    expect(read.stderr).toContain("proxy.small-model: the shared default");
    const dropped = expectIdentical(
      { args: ["config", "unset", "proxy.small-model"], scratch: fresh[0] },
      { args: ["profile", "unset", "proxy.small-model"], scratch: fresh[1] },
    );
    expect(dropped.exitCode).toBe(0);
    expect(readFileSync(join(fresh[1].home, "state.json"), "utf8")).not.toContain("gpt-x");
    // Ten cold CLI spawns; generous headroom for loaded Windows CI runners.
  },
  300_000,
);

test(
  "the verbs with their bodies folded under them print what the routing-only tree printed: the same files in the same order, the same rows",
  () => {
    const scratch = scratchHome();
    for (const args of VERBS_ORACLE.seed) {
      expect(observe(args, scratch).exitCode, args.join(" ")).toBe(0);
    }
    for (const key of Object.keys(VERBS_ORACLE.observed)) {
      expectOracleOf(VERBS_ORACLE.observed, key, key.split(" "), scratch);
    }
    // Fifteen cold CLI spawns; generous headroom for loaded Windows CI runners.
  },
  240_000,
);

test(
  "the tree prints what main's deleted spellings printed: the checks, the resolver, a named profile",
  () => {
    const scratch = scratchHome();
    expect(observe(["auth", "--set", "ghu_test"], scratch).exitCode).toBe(0);
    expectOracle("init --proxy", ["profile", "add", "--proxy"], scratch);
    expectOracle("claude --check", ["profile", "check", "--claude"], scratch);
    expectOracle("codex --check", ["profile", "check", "--codex"], scratch);
    // The old one-shot add is two commands now: the mode, then the credential that wires.
    expectOracle(
      "profile --add work",
      ["profile", "work", "add", "--proxy", "--no-auth"],
      scratch,
    );
    expect(observe(["profile", "work", "auth", "--set", "ghu_work"], scratch).exitCode).toBe(0);
    expect(existsSync(join(scratch.home, ".claude", "settings-work.json"))).toBe(true);
    expectOracle("profile --check work", ["profile", "work", "check"], scratch);
    // The agent flags on a named profile: one agent's file, read as the launcher reads it.
    const claude = observe(["profile", "work", "check", "--claude"], scratch);
    expect(claude.exitCode).toBe(2);
    expect(claude.stdout).toContain("Claude provider mode: proxy");
    expect(claude.stdout).toContain("settings-work.json: <HOME>/.claude/settings-work.json");
    const codex = observe(["profile", "work", "check", "--codex"], scratch);
    expect(codex.exitCode).toBe(2);
    expect(codex.stdout).toContain("Codex provider mode: proxy");
    // A named sync with an agent flag re-renders that agent's files alone: each deleted file comes
    // back only under its own flag, and nothing else in the home moves.
    const claudeFile = join(scratch.home, ".claude", "settings-work.json");
    const codexFile = join(scratch.home, ".codex", "work.config.toml");
    rmSync(claudeFile);
    rmSync(codexFile);
    const bothGone = treeContents(scratch.home);
    const codexOnly = observe(["profile", "work", "sync", "--codex"], scratch);
    expect(codexOnly.exitCode).toBe(0);
    expect(codexOnly.stderr).toContain("Synced profile 'work' (Codex only).");
    const codexBack = treeContents(scratch.home);
    expect([...changedPaths(bothGone, codexBack)]).toEqual([relative(scratch.home, codexFile)]);
    expect(observe(["profile", "work", "sync", "--claude"], scratch).exitCode).toBe(0);
    expect([...changedPaths(codexBack, treeContents(scratch.home))]).toEqual([
      relative(scratch.home, claudeFile),
    ]);
    expectOracle("auth --get --profile work", ["profile", "work", "auth", "--get"], scratch);
    expectOracle(
      "config --get identity --profile work",
      ["profile", "work", "get", "identity"],
      scratch,
    );
    // A named profile's preference write previews through the verb untouched: the plan prints and
    // the store stays as it was.
    const before = treeContents(scratch.home);
    const planned = observe(["profile", "work", "set", "passthrough", "off", "--dry-run"], scratch);
    expect(planned.exitCode).toBe(0);
    expect(planned.stdout).toContain("DRY RUN: nothing was written");
    expect(treeContents(scratch.home)).toEqual(before);
    // Fifteen cold CLI spawns; generous headroom for loaded Windows CI runners.
  },
  240_000,
);

test(
  "add and del ask before a change: a script without --yes is refused, --yes answers, --dry-run never asks",
  () => {
    const scratch = scratchHome();
    expect(observe(["auth", "--set", "ghu_test"], scratch).exitCode).toBe(0);
    // A fresh profile and a same-mode re-add ask nothing.
    expect(observe(["profile", "work", "add", "--proxy", "--no-auth"], scratch).exitCode).toBe(0);
    expect(observe(["profile", "work", "auth", "--set", "ghu_work"], scratch).exitCode).toBe(0);
    expect(observe(["profile", "work", "add", "--proxy"], scratch).exitCode).toBe(0);
    // A mode change asks; headless, that is the refusal.
    const change = observe(["profile", "work", "add", "--direct"], scratch);
    expect(change.exitCode).toBe(1);
    expect(change.stderr).toContain("pass --yes to switch the mode");
    expect(observe(["profile", "work", "add", "--direct", "--dry-run"], scratch).exitCode).toBe(0);
    // del always asks.
    const del = observe(["profile", "work", "del"], scratch);
    expect(del.exitCode).toBe(1);
    expect(del.stderr).toContain("pass --yes to delete the profile");
    expect(existsSync(join(scratch.home, ".claude", "settings-work.json"))).toBe(true);
    expect(observe(["profile", "work", "del", "--dry-run"], scratch).exitCode).toBe(0);
    expect(existsSync(join(scratch.home, ".claude", "settings-work.json"))).toBe(true);
    expect(observe(["profile", "work", "del", "--yes"], scratch).exitCode).toBe(0);
    expect(existsSync(join(scratch.home, ".claude", "settings-work.json"))).toBe(false);
    // Nine cold CLI spawns; generous headroom for loaded Windows CI runners.
  },
  240_000,
);

test(
  "the identity verb's flags are the set/get/unset spellings: same store bytes, same output",
  () => {
    const pairs: [string[], string[]][] = [
      [["profile", "set", "identity", "auto"], ["profile", "identity", "--set", "auto"]],
      [["profile", "get", "identity"], ["profile", "identity", "--get"]],
      [["profile", "unset", "identity"], ["profile", "identity", "--del"]],
    ];
    const twins = [scratchHome(), scratchHome()] as const;
    for (const s of twins) expect(observe(["auth", "--set", "ghu_test"], s).exitCode).toBe(0);
    for (const [verb, alias] of pairs) {
      const seen = expectIdentical(
        { args: verb, scratch: twins[0] },
        { args: alias, scratch: twins[1] },
      );
      expect(seen.exitCode, verb.join(" ")).toBe(0);
    }
    // Eight cold CLI spawns; generous headroom for loaded Windows CI runners.
  },
  240_000,
);

test(
  "add runs the credential step on a profile without one: headless it refuses naming --no-auth, --no-auth records the mode and prints the step, --dry-run plans it, a credential is never asked again",
  () => {
    const scratch = scratchHome();
    const before = treeContents(scratch.home);
    // Headless, no credential, no flag: refused BEFORE the mode lands (named and default alike).
    // The needles stop at the backticked command: consola's CI reporter keeps the backticks, the
    // interactive one strips them.
    const named = observe(["profile", "work", "add", "--proxy"], scratch);
    expect(named.exitCode).toBe(1);
    expect(named.stderr).toContain("pass --no-auth to record the mode alone");
    expect(named.stderr).toContain("agent profile work auth --provider");
    const init = observe(["init", "--proxy"], scratch);
    expect(init.exitCode).toBe(1);
    expect(init.stderr).toContain("pass --no-auth to record the mode alone");
    expect(init.stderr).toContain("agent auth --provider");
    expect(treeContents(scratch.home)).toEqual(before);
    // --dry-run: the mode's plan and the planned step, nothing run.
    const dry = observe(["profile", "work", "add", "--proxy", "--dry-run"], scratch);
    expect(dry.exitCode).toBe(0);
    expect(dry.stdout).toContain('profiles.work.mode  (absent) -> "proxy"');
    expect(dry.stderr).toContain("Would run the credential step (agent profile work auth)");
    expect(treeContents(scratch.home)).toEqual(before);
    // --no-auth: the mode lands, the step is printed.
    const noAuth = observe(["profile", "work", "add", "--proxy", "--no-auth"], scratch);
    expect(noAuth.exitCode).toBe(0);
    expect(noAuth.stderr).toContain("Next:  agent profile work auth --provider");
    expect(observe(["profile", "work", "show"], scratch).stdout).toContain(
      "provider: no credential",
    );
    // The default's add records its mode like a named profile's: a dry run plans the record and
    // names the step, --no-auth lands the record and prints the one next step.
    const afterNamed = treeContents(scratch.home);
    const initDry = observe(["init", "--proxy", "--dry-run"], scratch);
    expect(initDry.exitCode).toBe(0);
    expect(initDry.stdout).toContain('profiles.default.mode  (absent) -> "proxy"');
    expect(initDry.stderr).toContain("Would run the credential step (agent auth)");
    expect(treeContents(scratch.home)).toEqual(afterNamed);
    const initNoAuth = observe(["init", "--proxy", "--no-auth"], scratch);
    expect(initNoAuth.exitCode).toBe(0);
    expect(initNoAuth.stderr).toContain("Next:  agent auth --provider");
    expect(initNoAuth.stderr).not.toContain("then:");
    const store = JSON.parse(readFileSync(join(scratch.home, "state.json"), "utf8")) as {
      profiles?: { default?: { mode?: string } };
    };
    expect(store.profiles?.default?.mode).toBe("proxy");
    // With no mode to record, --no-auth has nothing to land and says which flag it needs.
    const bare = observe(["profile", "add", "--no-auth"], scratchHome());
    expect(bare.exitCode).toBe(1);
    expect(bare.stderr).toContain("pass --direct or --proxy");
    // With a credential, add never asks again: a headless re-add succeeds without the flag.
    expect(observe(["profile", "work", "auth", "--set", "ghu_work"], scratch).exitCode).toBe(0);
    const again = observe(["profile", "work", "add", "--proxy"], scratch);
    expect(again.exitCode).toBe(0);
    expect(again.stderr).not.toContain("--no-auth");
    // Eight cold CLI spawns; generous headroom for loaded Windows CI runners.
  },
  240_000,
);

test(
  "`agent sync` re-renders the default profile too: a deleted settings.json comes back from the slot",
  () => {
    const scratch = scratchHome();
    expect(observe(["auth", "--set", "ghu_test"], scratch).exitCode).toBe(0);
    expect(observe(["init", "--proxy"], scratch).exitCode).toBe(0);
    const settings = join(scratch.home, ".claude", "settings.json");
    const before = readFileSync(settings, "utf8");
    rmSync(settings);
    const dry = observe(["sync", "--dry-run"], scratch);
    expect(dry.exitCode).toBe(0);
    expect(dry.stdout.split("DRY RUN:").length - 1).toBe(1);
    expect(existsSync(settings)).toBe(false);
    const sync = observe(["sync"], scratch);
    expect(sync.exitCode).toBe(0);
    expect(sync.stderr).toContain("Synced 1 profile (the default included)");
    expect(readFileSync(settings, "utf8")).toBe(before);
  },
  120_000,
);

test(
  "`agent sync` exits 1 when a named profile's re-render fails: a foreign settings-<name>.json is never overwritten, and the failure is the exit code",
  () => {
    const scratch = scratchHome();
    expect(observe(["auth", "--set", "ghu_test"], scratch).exitCode).toBe(0);
    expect(observe(["profile", "work", "add", "--proxy", "--no-auth"], scratch).exitCode).toBe(0);
    expect(observe(["profile", "work", "auth", "--set", "ghu_work"], scratch).exitCode).toBe(0);
    const foreign = JSON.stringify({ apiKeyHelper: "/opt/x/helper.sh" });
    writeFileSync(join(scratch.home, ".claude", "settings-work.json"), foreign);
    const sync = observe(["sync"], scratch);
    expect(sync.exitCode).toBe(1);
    expect(sync.stderr).toContain("could not sync profile 'work'");
    expect(readFileSync(join(scratch.home, ".claude", "settings-work.json"), "utf8")).toBe(foreign);
    // The default's failure never stops the named sweep: with the default's settings.json
    // unparseable and work's file removed, sync records the default's failure, re-renders work,
    // and exits 1 for the default.
    expect(observe(["init", "--proxy"], scratch).exitCode).toBe(0);
    rmSync(join(scratch.home, ".claude", "settings-work.json"));
    writeFileSync(join(scratch.home, ".claude", "settings.json"), "{ not json");
    const partial = observe(["sync"], scratch);
    expect(partial.exitCode).toBe(1);
    expect(partial.stderr).toContain("could not sync the default profile");
    expect(partial.stderr).toContain("Synced 1 profile.");
    expect(existsSync(join(scratch.home, ".claude", "settings-work.json"))).toBe(true);
    // Six cold CLI spawns; generous headroom for loaded Windows CI runners.
  },
  180_000,
);

test(
  "set identity: an unknown named profile is refused like every other key, and --dry-run plans the pin without writing",
  () => {
    const scratch = scratchHome();
    expect(observe(["auth", "--set", "ghu_test"], scratch).exitCode).toBe(0);
    const before = treeContents(scratch.home);
    for (
      const args of [["profile", "ghost", "set", "identity", "auto"], [
        "profile",
        "ghost",
        "identity",
        "--set",
        "auto",
      ]]
    ) {
      const ghost = observe(args, scratch);
      expect(ghost.exitCode, args.join(" ")).toBe(1);
      expect(ghost.stderr, args.join(" ")).toContain("no such profile 'ghost'");
    }
    expect(treeContents(scratch.home)).toEqual(before);
    const list = observe(["list"], scratch);
    expect(list.stdout + list.stderr).not.toContain("ghost");
    const dry = observe(["profile", "set", "identity", "auto", "--dry-run"], scratch);
    expect(dry.exitCode).toBe(0);
    expect(dry.stdout).toContain("DRY RUN: nothing was written");
    expect(dry.stdout).toContain("identity");
    expect(dry.stderr).not.toContain("identity = auto");
    expect(treeContents(scratch.home)).toEqual(before);
    // Five cold CLI spawns; generous headroom for loaded Windows CI runners.
  },
  180_000,
);
