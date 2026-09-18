// The runtime verbs of `agent profile [<name>] <verb>` (launch env proxy-token mcp start stop
// health models credits settings) route onto the functions the base's flat `--profile <name>`
// spellings called. The oracle is the base's own output: test/fixtures/cli_redesign/
// profile_ops_oracle.json holds what each old spelling printed (stdout, exit code) in a scratch
// HOME, and the new spelling must print the same. The two default-profile aliases (start, stop)
// are proven against their verbs live, in twin homes; the flat spellings are gone; a profile's
// settings bundle is that profile alone.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { desktopEntryName, META_FILENAME } from "../src/claude/desktop.ts";
import {
  expectIdentical,
  expectOracle as expectOracleOf,
  loadOracle,
  normalize,
  observe,
  type ScratchHome,
  scratchHome as scratchHomeOf,
} from "./helpers/cli_oracle.ts";
import { expect, test } from "./helpers/testing.ts";

const ORACLE = loadOracle("profile_ops_oracle");

const scratchHome = () => scratchHomeOf("copilot-profile-ops-");

/** The base's setup, as the oracle was captured: a proxy default and a proxy profile `work`, each
 *  with a stored token. */
function seed(scratch: ScratchHome): void {
  for (
    const args of [
      ["auth", "--set", "ghu_test"],
      ["init", "--proxy"],
      ["profile", "work", "add", "--proxy", "--no-auth"],
      ["profile", "work", "auth", "--set", "ghu_work"],
    ]
  ) {
    expect(observe(args, scratch).exitCode, args.join(" ")).toBe(0);
  }
}

/** The base's hints inside a report spelled the daemon commands the old way; the oracle's stdout is
 *  respelled to the verb form, which is the one change the move makes to them. */
function respellDaemonHints(stdout: string): string {
  return stdout
    .replaceAll("agent start --profile work", "agent profile work start")
    .replaceAll("agent stop --profile work", "agent profile work stop");
}

test("the oracle fold keeps a profile named like the checkout's directory and a JSON escape", () => {
  // The container suite mounts the checkout at /work (the fixture profile's name): the root folds
  // as a whole path only, and a `--json` report's `\n` escape is not a Windows separator.
  const folded = normalize(
    "/tmp/h",
    [
      "unchanged /tmp/h/profiles/work/.run/x/.state.json",
      "apiKeyHelper: /work/bin/agent profile proxy-token --yes",
      '"detail": "credential: stored\\nresolved by"',
      "/tmp/h\\\\profiles\\\\work",
    ].join("\n"),
    "/work",
  );
  expect(folded.split("\n")).toEqual([
    "unchanged <HOME>/profiles/work/.run/x/.state.json",
    "apiKeyHelper: <ROOT>/bin/agent profile proxy-token --yes",
    '"detail": "credential: stored\\nresolved by"',
    "<HOME>/profiles/work",
  ]);
});

test(
  "each verb prints what the base's --profile spelling printed; the whole-store settings export and the top-level credits flags are unchanged",
  () => {
    const scratch = scratchHome();
    seed(scratch);
    const oracle = (key: string, args: string[], respell?: (s: string) => string) =>
      expectOracleOf(ORACLE, key, args, scratch, respell);
    oracle("env", ["profile", "env"]);
    oracle("env --profile work", ["profile", "work", "env"]);
    oracle("env --format powershell --profile work", [
      "profile",
      "work",
      "env",
      "--format",
      "powershell",
    ]);
    oracle("start --check --profile work", ["profile", "work", "start", "--check"]);
    oracle("stop --profile work", ["profile", "work", "stop"]);
    oracle("stop --profile work --dry-run", ["profile", "work", "stop", "--dry-run"]);
    oracle("proxy-token --yes --profile work", ["profile", "work", "proxy-token", "--yes"]);
    oracle(
      "health --scope runtime --profile work --json",
      ["profile", "work", "health", "--scope", "runtime", "--json"],
      respellDaemonHints,
    );
    oracle(
      "health --scope auth --profile work --json",
      ["profile", "work", "health", "--scope", "auth", "--json"],
      respellDaemonHints,
    );
    const models = oracle("models --proxy --profile work", [
      "profile",
      "work",
      "models",
      "--proxy",
    ]);
    expect(models.stderr).toContain("the local proxy for profile 'work' is not running");
    expect(models.stderr).toContain("agent profile work start");
    // The launch refuses before it reaches the CLI: with or without a claude on PATH, the missing
    // profile or the missing CLI is named on stderr and nothing is spawned.
    oracle("launch claude --profile nope -- x", [
      "profile",
      "nope",
      "launch",
      "claude",
      "--",
      "x",
    ]);
    const mcp = oracle("mcp", ["profile", "mcp"]);
    expect(mcp.stderr).toContain("Claude registration");
    oracle("settings --export", ["settings", "--export"]);
    const credits = oracle("credits --target 0", ["credits", "--target", "0"]);
    expect(credits.stderr).toContain("--target: must be between");
    // Eighteen cold CLI spawns; generous headroom for loaded Windows CI runners.
  },
  300_000,
);

test(
  "the default-profile aliases are one code path with their verbs: start and stop in twin homes",
  () => {
    const twins = [scratchHome(), scratchHome()] as const;
    for (const s of twins) {
      expect(observe(["auth", "--set", "ghu_test"], s).exitCode).toBe(0);
      expect(observe(["init", "--proxy"], s).exitCode).toBe(0);
    }
    const pairs: [string[], string[], number][] = [
      [["start", "--check"], ["profile", "start", "--check"], 1],
      [["stop"], ["profile", "stop"], 1],
      [["stop", "--dry-run"], ["profile", "stop", "--dry-run"], 1],
      [["stop", "--all"], ["profile", "stop", "--all"], 1],
    ];
    for (const [alias, verb, exitCode] of pairs) {
      const seen = expectIdentical(
        { args: alias, scratch: twins[0] },
        { args: verb, scratch: twins[1] },
      );
      expect(seen.exitCode, alias.join(" ")).toBe(exitCode);
    }
    // --all takes no name: the named verb refuses it.
    const namedAll = observe(["profile", "work", "stop", "--all"], twins[0]);
    expect(namedAll.exitCode).toBe(1);
    expect(namedAll.stderr).toContain("--all stops every daemon; it takes no profile name");
    // A named profile hard-fails on every arm: `--check` on a profile that does not exist is the
    // refusal, never "not running" for a daemon that never was.
    const ghost = observe(["profile", "ghost", "start", "--check"], twins[0]);
    expect(ghost.exitCode).toBe(1);
    expect(ghost.stdout).toBe("");
    expect(ghost.stderr).toContain("no such profile 'ghost'");
    // Fourteen cold CLI spawns; generous headroom for loaded Windows CI runners.
  },
  300_000,
);

interface Bundle {
  formatVersion: number;
  config: { global: Record<string, unknown>; profiles: Record<string, Record<string, unknown>> };
  credential: { githubToken: string | null; authProvider: string | null; ghUser: string | null };
  profiles: Record<
    string,
    { mode: string | null; authProvider: string | null; githubToken: string | null }
  >;
  modes: { codex: string; claude: string };
}

test(
  "profile settings is one profile's bundle: a named profile's slot and section, the default's credential, modes, and shared defaults; its import lands that profile alone and refuses the whole store",
  () => {
    const scratch = scratchHome();
    seed(scratch);
    for (
      const args of [
        ["profile", "work", "set", "passthrough", "off"],
        ["config", "set", "proxy.small-model", "gpt-x"],
        ["config", "set", "daemon.strict-port", "true"],
      ]
    ) {
      expect(observe(args, scratch).exitCode, args.join(" ")).toBe(0);
    }
    const named = JSON.parse(
      observe(["profile", "work", "settings", "--export"], scratch).stdout,
    ) as Bundle;
    expect(named.config).toEqual({ global: {}, profiles: { work: { passthrough: "off" } } });
    expect(named.credential).toEqual({ githubToken: null, authProvider: null, ghUser: null });
    expect(Object.keys(named.profiles)).toEqual(["work"]);
    expect(named.profiles.work).toMatchObject({ mode: "proxy", authProvider: "gh-token" });
    expect(named.modes).toEqual({ codex: "none", claude: "none" });

    const byDefault = JSON.parse(
      observe(["profile", "settings", "--export"], scratch).stdout,
    ) as Bundle;
    // The shared proxy default travels with the default profile; the machine keys never do.
    expect(byDefault.config.global).toEqual({ "proxy.small-model": "gpt-x" });
    expect(Object.keys(byDefault.config.profiles).filter((k) => k !== "default")).toEqual([]);
    expect(byDefault.credential).toMatchObject({ authProvider: "gh-token" });
    expect(byDefault.profiles).toEqual({});
    expect(byDefault.modes).toEqual({ codex: "proxy", claude: "proxy" });

    const whole = observe(["settings", "--export"], scratch).stdout;
    const wholeBundle = JSON.parse(whole) as Bundle;
    expect(wholeBundle.config.global).toEqual({
      "daemon.port": 4199,
      "daemon.strict-port": true,
      "proxy.small-model": "gpt-x",
    });
    expect(Object.keys(wholeBundle.profiles)).toEqual(["work"]);

    // work's bundle lands work in a twin home and nothing else: the twin's own default
    // credential and machine keys read back as they were.
    const twin = scratchHome();
    expect(observe(["auth", "--set", "ghu_twin"], twin).exitCode).toBe(0);
    const bundleFile = join(twin.home, "work.json");
    writeFileSync(
      bundleFile,
      observe(["profile", "work", "settings", "--export", "--with-credentials"], scratch).stdout,
    );
    const imported = observe(
      ["profile", "work", "settings", "--import", bundleFile, "--force"],
      twin,
    );
    expect(imported.exitCode).toBe(0);
    expect(observe(["profile", "work", "show"], twin).stdout).toContain("provider: gh-token");
    const twinStore = JSON.parse(
      observe(["settings", "--export", "--with-credentials"], twin).stdout,
    ) as Bundle;
    expect(twinStore.config).toEqual({
      global: { "daemon.port": 4199 },
      profiles: { work: { passthrough: "off" } },
    });
    expect(twinStore.profiles.work).toMatchObject({
      mode: "proxy",
      authProvider: "gh-token",
      githubToken: "ghu_work",
    });
    expect(twinStore.credential).toMatchObject({
      authProvider: "gh-token",
      githubToken: "ghu_twin",
    });
    expect(twinStore.modes).toEqual({ codex: "none", claude: "none" });

    // A named import reaches its profile alone: the default's Desktop entry, made stale by
    // hand, is byte-identical after it, and a default write (`agent sync`) is what rewrites it.
    const desktop = join(twin.home, "claude-desktop");
    const library = join(desktop, "configLibrary");
    mkdirSync(library, { recursive: true });
    const withDesktop = {
      ...twin,
      env: { ...twin.env, COPILOT_ENV_CI_CLAUDE_DESKTOP_DIR: desktop },
    };
    expect(observe(["init", "--proxy"], withDesktop).exitCode).toBe(0);
    const meta = JSON.parse(readFileSync(join(library, META_FILENAME), "utf8")) as {
      entries: { id: string; name: string }[];
    };
    const defaultId = meta.entries.find((e) => e.name === desktopEntryName(null))?.id;
    expect(defaultId).toBeDefined();
    const defaultEntry = join(library, `${defaultId}.json`);
    const stale = readFileSync(defaultEntry, "utf8").replace(
      "http://127.0.0.1:4199",
      "http://127.0.0.1:4100",
    );
    expect(stale).not.toBe(readFileSync(defaultEntry, "utf8"));
    writeFileSync(defaultEntry, stale);
    const namedImport = observe(
      ["profile", "work", "settings", "--import", bundleFile, "--force"],
      withDesktop,
    );
    expect(namedImport.exitCode).toBe(0);
    expect(readFileSync(defaultEntry, "utf8")).toBe(stale);
    expect(observe(["sync"], withDesktop).exitCode).toBe(0);
    expect(readFileSync(defaultEntry, "utf8")).not.toBe(stale);

    // The whole store is not one profile's bundle.
    const wholeFile = join(twin.home, "all.json");
    writeFileSync(wholeFile, whole);
    const refused = observe(
      ["profile", "work", "settings", "--import", wholeFile, "--force"],
      twin,
    );
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("not a bundle of profile 'work' alone");
    expect(refused.stderr).toContain("agent settings --import");
    // A fresh machine's empty whole-store export (no keys, no credential, no slot, no mode)
    // carries no slot for work: read as work's bundle it would clear work's preferences and land
    // nothing, so it is refused and the store is untouched.
    const emptyFile = join(twin.home, "empty.json");
    writeFileSync(
      emptyFile,
      JSON.stringify({
        formatVersion: 2,
        config: { global: {}, profiles: {} },
        credential: { githubToken: null, authProvider: null, ghUser: null },
        profiles: {},
        modes: { codex: "none", claude: "none" },
      }),
    );
    const beforeEmpty = observe(["settings", "--export"], twin).stdout;
    const empty = observe(["profile", "work", "settings", "--import", emptyFile, "--force"], twin);
    expect(empty.exitCode).toBe(1);
    expect(empty.stderr).toContain("carries no slot for profile 'work'");
    expect(observe(["settings", "--export"], twin).stdout).toBe(beforeEmpty);
    // Sixteen cold CLI spawns; generous headroom for loaded Windows CI runners.
  },
  300_000,
);
