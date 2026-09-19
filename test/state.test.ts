import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CopilotEnvState, storedCredentialKind } from "../src/copilot_api/env_state.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import { CopilotEnvRunState } from "../src/copilot_api/run_state.ts";
import { afterEach, expect, removeDir, test } from "./helpers/testing.ts";
import { envSnapshot, isolateProxyHome } from "./helpers.ts";

// CopilotEnvState reads/writes the SHARED store under COPILOT_API_HOME, so isolate
// each test in a temp home (not the per-host .run state).
const restoreEnv = envSnapshot();
// A branded fixture name: parseProfileName is the only mint for ProfileName.
const WORK = parseProfileName("work");
let dir = "";

afterEach(() => {
  restoreEnv();
  dir = removeDir(dir);
});

function tmpHome(): void {
  dir = isolateProxyHome("copilot-envstate-");
}

/** Write the raw state file verbatim (fixtures the typed API cannot -- and must
 *  not -- produce: the legacy top-level pair, stray/junk fields). */
function seedRawState(data: Record<string, unknown>): void {
  // The slots are `profiles`; every other key of the old credentials shape is account-wide state
  // under `global`.
  const { profiles, ...global } = data;
  writeFileSync(join(dir, "state.json"), `${JSON.stringify({ global, profiles })}\n`);
}

/** The state as stored, flattened back to the shape the assertions read: `profiles` plus the
 *  account-wide keys of `global`. */
function rawState(): Record<string, unknown> {
  const doc = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as {
    global?: Record<string, unknown>;
    profiles?: unknown;
  };
  return { ...(doc.global ?? {}), profiles: doc.profiles };
}

test("the provisioned GitHub token and its provider round-trip through the shared store and clear", () => {
  tmpHome();
  const state = new CopilotEnvState();
  expect(state.read().githubToken).toBeNull();
  expect(state.read().authProvider).toBeNull();

  // Written by `agent auth`, read by every config write + `agent start`.
  state.setCredential(null, { kind: "stored", provider: "gh-token", token: "ghu_provisioned" });
  expect(state.read().githubToken).toBe("ghu_provisioned");
  expect(state.read().authProvider).toBe("gh-token");

  // On disk the credential lives in the reserved `default` slot, never in a
  // top-level pair.
  const raw = rawState();
  expect(raw.githubToken).toBeUndefined();
  expect(raw.authProvider).toBeUndefined();
  expect((raw.profiles as Record<string, Record<string, unknown>>).default?.githubToken).toBe(
    "ghu_provisioned",
  );

  // `agent auth --del` clears both halves (revert to the gh CLI / proxy device login).
  expect(state.clearCredential(null)).toBe(true);
  expect(state.read()).toEqual({
    githubToken: null,
    authProvider: null,
    ghUser: null,
    profiles: {},
    codexCatalogLastAttemptMs: 0,
    codexCatalogCodexVersion: null,
    codexCatalogPatchVersion: 0,
    codexCatalogAccepted: null,
    claudeModelVerdicts: {},
  });
});

test("the write boundary trims every string and refuses a blank token; a blank state value reads null", () => {
  const cases: {
    name: string;
    write: (state: CopilotEnvState) => void;
    throws?: RegExp;
    read: (state: CopilotEnvState) => unknown;
    expected: unknown;
  }[] = [
    {
      name: "credential token trimmed",
      write: (s) =>
        s.setCredential(null, { kind: "stored", provider: "gh-token", token: "  ghu_trimmed  " }),
      read: (s) => s.read().githubToken,
      expected: "ghu_trimmed",
    },
    {
      name: "set() trims",
      write: (s) => s.set({ codexCatalogCodexVersion: "  0.99.0  " }),
      read: (s) => s.read().codexCatalogCodexVersion,
      expected: "0.99.0",
    },
    {
      name: "set() blank clears a stored value to null",
      write: (s) => {
        s.set({ codexCatalogCodexVersion: "  0.99.0  " });
        s.set({ codexCatalogCodexVersion: "   " });
      },
      read: (s) => s.read().codexCatalogCodexVersion,
      expected: null,
    },
    {
      // Rejected at the boundary, never persisted as a partial profile.
      name: "blank profile token refused",
      write: (s) =>
        s.commitProfile(WORK, {
          credential: { kind: "stored", provider: "gh-token", token: "   " },
          mode: "direct",
        }),
      throws: /non-empty token/,
      read: (s) => s.profileNames(),
      expected: [],
    },
    {
      name: "empty default token refused",
      write: (s) => s.setCredential(null, { kind: "stored", provider: "copilot", token: "" }),
      throws: /non-empty token/,
      read: (s) => s.read().authProvider,
      expected: null,
    },
  ];
  for (const c of cases) {
    dir = removeDir(dir);
    tmpHome();
    const state = new CopilotEnvState();
    if (c.throws === undefined) c.write(state);
    else expect(() => c.write(state), c.name).toThrow(c.throws);
    expect(c.read(state), c.name).toEqual(c.expected);
  }
});

test("a store carrying only the legacy top-level pair reads as no default credential; writes preserve it", () => {
  tmpHome();
  // A pre-slot release's layout: the 3.5.6 migration lifts the pair into the
  // reserved slot. Until it runs the store reads the slot shape ONLY (an
  // `agent auth --check` finds nothing), and no store write of ours lifts or
  // drops the pair -- the migration must still find it.
  seedRawState({ githubToken: "ghu_legacy", authProvider: "copilot" });
  const state = new CopilotEnvState();
  expect(state.readCredential(null)).toEqual({ kind: "none", provider: null });
  expect(state.read().githubToken).toBeNull();
  expect(state.read().authProvider).toBeNull();
  state.recordDefaultMode("direct");
  expect(rawState()).toEqual({
    githubToken: "ghu_legacy",
    authProvider: "copilot",
    profiles: { default: { mode: "direct" } },
  });
});

test("recordDefaultMode records the agreed default wiring and clears on divergence", () => {
  tmpHome();
  const state = new CopilotEnvState();
  expect(state.readProfileSlot(null).mode).toBeNull();

  state.recordDefaultMode("proxy");
  expect(state.readProfileSlot(null).mode).toBe("proxy");

  // With a credential recorded too, the default slot parses complete -- the
  // same completeness rule as a named profile -- yet never surfaces as one.
  state.setCredential(null, { kind: "gh-cli", ghUser: null });
  expect(state.readProfileSlot(null)).toEqual({
    kind: "complete",
    credential: { kind: "gh-cli", ghUser: null },
    mode: "proxy",
  });
  expect(state.profileNames()).toEqual([]);

  // Divergent (or unreadable) agent wiring clears the record; the credential stays.
  state.recordDefaultMode(null);
  expect(state.readProfileSlot(null).mode).toBeNull();
  expect(state.readCredential(null)).toEqual({ kind: "gh-cli", ghUser: null });

  // Clearing on an empty store neither creates the slot nor the profiles map.
  state.clearCredential(null);
  state.recordDefaultMode(null);
  expect(rawState().profiles).toBeUndefined();
});

test("run-state clearIfPid clears the daemon tracking ONLY when the tracked pid matches", () => {
  tmpHome();
  const run = new CopilotEnvRunState();
  run.set({ pid: 4242, port: 5151, lastEnsureAt: 123 });

  // A different pid (a newer daemon replaced us) -> leave everything intact, so an old
  // idle watchdog can't clobber the successor's freshly written pid/port.
  run.clearIfPid(9999);
  expect(run.read().pid).toBe(4242);
  expect(run.read().port).toBe(5151);
  expect(run.read().lastEnsureAt).toBe(123);

  run.clearIfPid(4242);
  const after = run.read();
  expect(after.pid).toBeUndefined();
  expect(after.port).toBeUndefined();
  expect(after.lastEnsureAt).toBeUndefined();
});

test("setCredential on an unknown named profile errors instead of creating a half profile", () => {
  tmpHome();
  const state = new CopilotEnvState();
  expect(() => state.setCredential(WORK, { kind: "stored", provider: "gh-token", token: "ghp_x" }))
    .toThrow(/no such profile 'work'/);
  expect(state.profileNames()).toEqual([]);
  // The default slot is not a profile: it always accepts a credential.
  state.setCredential(null, { kind: "gh-cli", ghUser: null });
  expect(state.read().authProvider).toBe("gh-cli");
});

test("a gh-cli account pin round-trips; an absent/blank stored pin reads as auto (no migration)", () => {
  tmpHome();
  const state = new CopilotEnvState();
  state.setCredential(null, { kind: "gh-cli", ghUser: "work-bot" });
  expect(state.readCredential(null)).toEqual({ kind: "gh-cli", ghUser: "work-bot" });
  expect(state.read().ghUser).toBe("work-bot");

  // Re-recording auto removes the key from the file outright: absent = auto is
  // the semantic default, so a pre-pin store reads identically with no migration.
  state.setCredential(null, { kind: "gh-cli", ghUser: null });
  const slot = (rawState().profiles as Record<string, Record<string, unknown>>).default ?? {};
  expect(slot.authProvider).toBe("gh-cli");
  expect(slot.ghUser).toBeUndefined();
  expect(state.readCredential(null)).toEqual({ kind: "gh-cli", ghUser: null });

  // A pre-pin store (no ghUser key), a hand-mangled blank pin, and a pin outside
  // a GitHub login's alphabet all read auto: the pin becomes `gh auth token
  // --user` argv (through cmd.exe on Windows), so a shell metacharacter must be
  // unrepresentable in the parsed state.
  seedRawState({ profiles: { default: { authProvider: "gh-cli" } } });
  expect(state.readCredential(null)).toEqual({ kind: "gh-cli", ghUser: null });
  seedRawState({ profiles: { default: { authProvider: "gh-cli", ghUser: "   " } } });
  expect(state.readCredential(null)).toEqual({ kind: "gh-cli", ghUser: null });
  seedRawState({ profiles: { default: { authProvider: "gh-cli", ghUser: "%USERNAME%" } } });
  expect(state.readCredential(null)).toEqual({ kind: "gh-cli", ghUser: null });

  // A blank or ill-shaped pin is rejected at the same write choke point as a
  // blank token, and the pin is trimmed on the way in.
  for (const bad of ["  ", "%USERNAME%", "a b"]) {
    expect(() => state.setCredential(null, { kind: "gh-cli", ghUser: bad }))
      .toThrow(
        "a gh-cli account pin must be a GitHub login (1-39 letters, digits, dashes, or underscores)",
      );
  }
  state.setCredential(null, { kind: "gh-cli", ghUser: " work-bot " });
  expect(state.read().ghUser).toBe("work-bot");

  state.clearCredential(null);
  expect(state.read().ghUser).toBeNull();
  expect(state.readCredential(null)).toEqual({ kind: "none", provider: null });
});

test("a store write mutates in place: unknown slot keys and legacy top-level keys survive both slot writers, and stay out of read()", () => {
  tmpHome();
  // A newer release may write fields this version does not know, and pre-ledger installs
  // recorded artifact ownership under top-level keys that only the 3.5.6 migration moves into
  // the ledger (ownership.test.ts). Neither slot writer may erase either (the store-wide
  // preserve-unknown-keys contract), and read() surfaces neither.
  seedRawState({
    webSearchDenyOwnedPaths: ["/a/settings.json"],
    profiles: { work: { mode: "proxy", authProvider: "gh-token", futureField: "keep-me" } },
  });
  const state = new CopilotEnvState();
  expect("webSearchDenyOwnedPaths" in state.read()).toBe(false);
  // The default slot's creation ...
  state.setCredential(null, { kind: "stored", provider: "gh-token", token: "ghu_x" });
  expect(rawState().webSearchDenyOwnedPaths).toEqual(["/a/settings.json"]);
  // ... and a named profile's commit.
  state.commitProfile(WORK, {
    credential: { kind: "stored", provider: "gh-token", token: "ghp_new" },
    mode: "direct",
  });
  const raw = rawState() as {
    webSearchDenyOwnedPaths: unknown;
    profiles: Record<string, Record<string, unknown>>;
  };
  expect(raw.webSearchDenyOwnedPaths).toEqual(["/a/settings.json"]);
  expect(raw.profiles.default?.githubToken).toBe("ghu_x");
  expect(raw.profiles.work?.futureField).toBe("keep-me");
  expect(raw.profiles.work?.mode).toBe("direct");
  expect(raw.profiles.work?.githubToken).toBe("ghp_new");
});

test("the read boundary parses the stored pair fail-closed into the credential union", () => {
  tmpHome();
  const state = new CopilotEnvState();
  // A token without a provider can never resolve: kind none (no implicit gh).
  seedRawState({ profiles: { default: { githubToken: "ghu_orphan" } } });
  expect(state.readCredential(null)).toEqual({ kind: "none", provider: null });
  // A token-backed provider whose token is gone keeps the provider for diagnostics.
  seedRawState({ profiles: { default: { authProvider: "gh-token" } } });
  expect(state.readCredential(null)).toEqual({ kind: "none", provider: "gh-token" });
  // gh-cli holds no token of its own, even when a stray one is on disk.
  seedRawState({ profiles: { default: { githubToken: "ghu_stray", authProvider: "gh-cli" } } });
  expect(state.readCredential(null)).toEqual({ kind: "gh-cli", ghUser: null });
  seedRawState({ profiles: { default: { githubToken: "ghu_ok", authProvider: "copilot" } } });
  expect(state.readCredential(null)).toEqual({
    kind: "stored",
    provider: "copilot",
    token: "ghu_ok",
  });
  // The presence-only classifier (health facts) must agree with the parse.
  for (const provider of [null, "bogus", "gh-cli", "copilot", "gh-token"]) {
    for (const token of [null, "tok"]) {
      const pair = { githubToken: token ?? undefined, authProvider: provider ?? undefined };
      seedRawState({ profiles: { default: pair } });
      expect(new CopilotEnvState().readCredential(null).kind).toBe(
        storedCredentialKind(provider, token !== null),
      );
    }
  }
});

test("clearCredential clears even a parse-rejected stray token and reports what it removed", () => {
  tmpHome();
  const state = new CopilotEnvState();
  expect(state.clearCredential(null)).toBe(false);
  // Parses as none, but it IS on disk.
  seedRawState({ profiles: { default: { githubToken: "ghu_orphan" } } });
  expect(state.clearCredential(null)).toBe(true);
  expect(state.read().githubToken).toBeNull();
  expect(state.clearCredential(null)).toBe(false);

  // Named: de-auth clears the credential half, keeps the mode.
  state.commitProfile(WORK, {
    credential: { kind: "stored", provider: "gh-token", token: "ghp_w" },
    mode: "proxy",
  });
  expect(state.clearCredential(WORK)).toBe(true);
  const slot = state.readProfileSlot(WORK);
  expect(slot.kind).toBe("partial");
  expect(slot.credential).toEqual({ kind: "none", provider: null });
  expect(slot.mode).toBe("proxy");
  expect(state.clearCredential(WORK)).toBe(false);
});

test("profileNames skips a hand-edited invalid profile key so it can never reach a path join", () => {
  tmpHome();
  // The `profiles` map lives in the user-editable state file, so its keys are a
  // trust boundary: a corrupted key ("../escape" would traverse out of profiles/
  // if it ever reached profileHome; "con" cannot be a directory on Windows) is
  // dropped at the read boundary -- the same sweep semantic as profileHomeNames'
  // stray-directory filter -- while valid siblings still come back.
  seedRawState({
    profiles: {
      "../escape": { mode: "proxy", authProvider: "gh-token", githubToken: "ghp_evil" },
      con: { mode: "direct" },
      work: { mode: "direct" },
    },
  });
  expect(new CopilotEnvState().profileNames()).toEqual([WORK]);
});

test("a profile named 'constructor' reads an empty slot, not Object.prototype's", () => {
  tmpHome();
  // The profiles record carries Object.prototype, so without an own-property
  // check the lookup resolves to the (truthy) inherited function and the
  // empty-slot fallback never fires - misreading the profile as existing.
  const name = parseProfileName("constructor");
  const state = new CopilotEnvState();
  expect(state.readProfileSlot(name)).toEqual({
    kind: "partial",
    credential: { kind: "none", provider: null },
    mode: null,
  });
  expect(state.readCredential(name)).toEqual({ kind: "none", provider: null });
  expect(state.profileNames()).toEqual([]);
});
