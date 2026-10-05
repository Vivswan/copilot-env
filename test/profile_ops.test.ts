// The runtime verbs of `agent profile [<name>] <verb>` (launch env proxy-token mcp start stop
// health models credits settings) route onto their commands with the profile they name. Pinned
// here: each spelling reaches its command on the right profile (the exit code, and the one value
// or file the command owns), the default-profile aliases (start, stop, models) are one code path
// with their verbs live, in twin homes, and a profile's settings bundle is that profile alone.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { desktopEntryName, META_FILENAME } from "../src/claude/desktop_library.ts";
import {
  expectIdentical,
  observe,
  scratchHome as scratchHomeOf,
  seedProxyProfiles,
  treeContents,
} from "./helpers/scratch_home.ts";
import { expect, test } from "./helpers/testing.ts";

const scratchHome = () => scratchHomeOf("copilot-profile-ops-");

interface HealthReport {
  profile: string | null;
  checks: {
    id: string;
    profile: string | null;
    status: string;
    fix?: string;
    value?: Record<string, unknown>;
  }[];
}

test(
  "each runtime verb reaches its command on the named profile: env on the port its health reports, the daemon verbs' down verdicts, the eval contracts' empty stdout, and the unknown-name refusal",
  () => {
    const scratch = scratchHome();
    seedProxyProfiles(scratch);
    // work's port is the one its daemon would bind, which its runtime health reports; the env
    // the shell evals points there, never at the default's pinned 4199.
    const runtime = observe(["profile", "work", "health", "--scope", "runtime", "--json"], scratch);
    expect(runtime.exitCode).toBe(1);
    const runtimeReport = JSON.parse(runtime.stdout) as HealthReport;
    expect(runtimeReport.profile).toBe("work");
    const portCheck = runtimeReport.checks.find((c) => c.id === "runtime.port");
    expect(portCheck).toMatchObject({ status: "fail", fix: "agent profile work start" });
    const port = portCheck?.value?.port;
    expect(port).not.toBe(4199);
    const env = observe(["profile", "work", "env"], scratch);
    expect(env.exitCode).toBe(0);
    expect(env.stdout).toBe(`export ANTHROPIC_BASE_URL='http://127.0.0.1:${port}'\n`);
    const powershell = observe(["profile", "work", "env", "--format", "powershell"], scratch);
    expect(powershell.exitCode).toBe(0);
    expect(powershell.stdout).toBe(`$env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:${port}'\n`);
    expect(observe(["profile", "env"], scratch)).toMatchObject({
      exitCode: 0,
      stdout: "export ANTHROPIC_BASE_URL='http://127.0.0.1:4199'\n",
    });
    // The auth scope narrowed to work is its one credential check, passing on the stored token.
    const auth = observe(["profile", "work", "health", "--scope", "auth", "--json"], scratch);
    expect(auth.exitCode).toBe(0);
    const authReport = JSON.parse(auth.stdout) as HealthReport;
    expect(authReport.checks.map((c) => [c.id, c.profile, c.status])).toEqual([
      ["setup.auth", "work", "ok"],
    ]);
    expect(authReport.checks[0]?.value).toMatchObject({ mode: "proxy", storedToken: true });
    // The daemon verbs on a profile whose daemon never ran: the down verdict is exit 1, worded as
    // not running rather than as a refusal, and the dry-run stop plans work's own run state.
    const check = observe(["profile", "work", "start", "--check"], scratch);
    expect(check.exitCode).toBe(1);
    expect(check.stdout + check.stderr).toContain("not running");
    const stop = observe(["profile", "work", "stop"], scratch);
    expect(stop.exitCode).toBe(1);
    expect(stop.stdout + stop.stderr).toContain("nothing to stop");
    const dryStop = observe(["profile", "work", "stop", "--dry-run"], scratch);
    expect(dryStop.exitCode).toBe(1);
    expect(dryStop.stdout).toContain(join(scratch.home, "profiles", "work", ".run"));
    expect(dryStop.stdout).not.toContain(join(scratch.home, ".run"));
    // Stdout is what Codex auth.command, Claude apiKeyHelper, and the launchers eval: byte-empty
    // on every refusal. The headless refusal says nothing on stderr either, so the proof that the
    // spelling reached work's resolver (a flag Commander rejects also exits 1 with an empty stdout)
    // is the resolver's one side effect: the heartbeat on work's run state, and no other file moves.
    const workRunState = [...treeContents(scratch.home).keys()].find((path) =>
      path.startsWith(join("profiles", "work", ".run")) && path.endsWith(".state.json")
    );
    if (workRunState === undefined) throw new Error("work has no run state to stamp");
    const beforeToken = treeContents(scratch.home);
    const askedAt = Date.now();
    const token = observe(["profile", "work", "proxy-token", "--yes"], scratch);
    expect(token.exitCode).toBe(1);
    expect(token.stdout).toBe("");
    const afterToken = treeContents(scratch.home);
    const touched = [...new Set([...beforeToken.keys(), ...afterToken.keys()])]
      .filter((path) => afterToken.get(path) !== beforeToken.get(path));
    expect(touched).toEqual([workRunState]);
    const heartbeat = JSON.parse(afterToken.get(workRunState) ?? "{}") as { lastEnsureAt?: number };
    expect(heartbeat.lastEnsureAt).toBeGreaterThanOrEqual(askedAt);
    const models = observe(["profile", "work", "models", "--proxy"], scratch);
    expect(models.exitCode).toBe(1);
    expect(models.stdout).toBe("");
    expect(models.stderr).toContain("the local proxy for profile 'work' is not running");
    expect(models.stderr).toContain("agent profile work start");
    // The launch refuses before it spawns anything: the missing CLI when no claude is on PATH,
    // else the missing profile (test/launch.test.ts pins that wording in-process). Either refusal
    // is the launch's own, so the spelling reached it rather than Commander.
    const launch = observe(["profile", "nope", "launch", "claude", "--", "x"], scratch);
    expect(launch.exitCode).toBe(1);
    expect(launch.stdout).toBe("");
    expect(launch.stderr).toMatch(/'claude' is not installed|profile 'nope' does not exist/);
    const credits = observe(["credits", "--target", "0"], scratch);
    expect(credits.exitCode).toBe(1);
    expect(credits.stderr).toContain("--target: must be between");
    // Sixteen cold CLI spawns; generous headroom for loaded Windows CI runners.
  },
  300_000,
);

test(
  "the default-profile aliases are one code path with their verbs: start, stop, and models in twin homes",
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
    // The proxy catalog with no daemon names the daemon to start (auto would fall through to
    // Direct and the network, where the two would fail alike for the wrong reason).
    const models = expectIdentical(
      { args: ["models", "--proxy"], scratch: twins[0] },
      { args: ["profile", "models", "--proxy"], scratch: twins[1] },
    );
    expect(models.exitCode).toBe(1);
    expect(models.stderr).toContain("the local proxy is not running");
    // An alias takes no name: a word after it never runs the default's verb; the refusal names it.
    const strayName = observe(["models", "work"], twins[0]);
    expect(strayName.exitCode).toBe(1);
    expect(strayName.stdout).toBe("");
    expect(strayName.stderr).toContain("work");
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
    // Seventeen cold CLI spawns; generous headroom for loaded Windows CI runners.
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
    seedProxyProfiles(scratch);
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
    // A daemon home with no store slot is not a profile an export can carry: refused with its
    // repair, so no bundle exists that its own import would refuse.
    mkdirSync(join(twin.home, "profiles", "ghost"), { recursive: true });
    const homeOnly = observe(["profile", "ghost", "settings", "--export"], twin);
    expect(homeOnly.exitCode).toBe(1);
    expect(homeOnly.stdout).toBe("");
    expect(homeOnly.stderr).toContain("profile 'ghost' has no store slot");
    expect(homeOnly.stderr).toContain("agent profile ghost add");
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
