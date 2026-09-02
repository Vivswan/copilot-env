import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CopilotEnvState, storedCredentialKind } from "../src/copilot_api/env_state.ts";
import { parseProfileName } from "../src/copilot_api/profile.ts";
import { CopilotEnvRunState } from "../src/copilot_api/state.ts";
import { afterEach, expect, test } from "./helpers/testing.ts";
import { envSnapshot, isolateProxyHome, removeDir } from "./helpers.ts";

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

/** Write the raw state file verbatim (layout fixtures the typed API cannot --
 *  and must not -- produce: the legacy top-level pair, stray/junk fields). */
function seedRawState(data: Record<string, unknown>): void {
  writeFileSync(join(dir, ".copilot-env-state.json"), `${JSON.stringify(data)}\n`);
}

function rawState(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, ".copilot-env-state.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

test("the provisioned GitHub token round-trips through the shared store and clears", () => {
  tmpHome();
  const state = new CopilotEnvState();
  expect(state.read().githubToken).toBeNull();

  // Written by `agent auth`, read by every config write + `agent start`.
  state.setCredential(null, { kind: "stored", provider: "gh-token", token: "ghu_provisioned" });
  expect(state.read().githubToken).toBe("ghu_provisioned");

  // On disk the credential lives in the reserved `default` slot, never in the
  // legacy top-level pair (the write-side layout lift).
  const raw = rawState();
  expect(raw.githubToken).toBeUndefined();
  expect(raw.authProvider).toBeUndefined();
  expect((raw.profiles as Record<string, Record<string, unknown>>).default?.githubToken).toBe(
    "ghu_provisioned",
  );

  // `agent auth --del` clears it (revert to the gh CLI / proxy device login).
  expect(state.clearCredential(null)).toBe(true);
  expect(state.read().githubToken).toBeNull();
});

test("a credential token is trimmed at the write boundary", () => {
  tmpHome();
  const state = new CopilotEnvState();
  state.setCredential(null, { kind: "stored", provider: "gh-token", token: "  ghu_trimmed  " });
  expect(state.read().githubToken).toBe("ghu_trimmed");
});

test("set() trims; a blank/whitespace value reads back as null", () => {
  tmpHome();
  const state = new CopilotEnvState();
  state.set({ codexCatalogCodexVersion: "  0.99.0  " });
  expect(state.read().codexCatalogCodexVersion).toBe("0.99.0");

  state.set({ codexCatalogCodexVersion: "   " });
  expect(state.read().codexCatalogCodexVersion).toBeNull();
});

test("the auth provider round-trips and clears alongside the token", () => {
  tmpHome();
  const state = new CopilotEnvState();
  expect(state.read().authProvider).toBeNull();

  state.setCredential(null, { kind: "stored", provider: "gh-token", token: "ghu_x" });
  expect(state.read().authProvider).toBe("gh-token");

  // `--del` clears both halves at once.
  state.clearCredential(null);
  expect(state.read()).toEqual({
    githubToken: null,
    authProvider: null,
    profiles: {},
    codexCatalogLastAttemptMs: 0,
    codexCatalogCodexVersion: null,
    codexCatalogPatchVersion: 0,
    claudeModelVerdicts: {},
  });
});

test("an unmigrated store's top-level pair reads as the default credential", () => {
  tmpHome();
  // A pre-slot release stored the default credential in the top-level fields;
  // the read boundary must keep answering from them until a write/migration
  // lifts the pair (the migration runner is best-effort).
  seedRawState({ githubToken: "ghu_legacy", authProvider: "copilot" });
  const state = new CopilotEnvState();
  expect(state.read().githubToken).toBe("ghu_legacy");
  expect(state.read().authProvider).toBe("copilot");
  expect(state.readCredential(null)).toEqual({
    kind: "stored",
    provider: "copilot",
    token: "ghu_legacy",
  });
  // The legacy layout never carried mode/identity: the slot reads partial.
  expect(state.readProfileSlot(null)).toEqual({
    kind: "partial",
    credential: { kind: "stored", provider: "copilot", token: "ghu_legacy" },
    mode: null,
    integrationIdentity: null,
  });
});

test("the reserved default slot wins over a lingering legacy pair", () => {
  tmpHome();
  // Both layouts at once is reachable only by hand edit; the slot (what every
  // new write produces) must answer deterministically -- read and write sides
  // apply the same precedence, so a lift can never drop the pair a read still
  // serves.
  seedRawState({
    githubToken: "ghu_stale",
    authProvider: "copilot",
    profiles: { default: { githubToken: "ghu_slot", authProvider: "gh-token" } },
  });
  expect(new CopilotEnvState().readCredential(null)).toEqual({
    kind: "stored",
    provider: "gh-token",
    token: "ghu_slot",
  });
});

test("every default-slot write lifts the legacy pair into the reserved slot", () => {
  tmpHome();
  seedRawState({ githubToken: "ghu_legacy", authProvider: "copilot" });
  const state = new CopilotEnvState();
  // A cache write against the LEGACY-layout credential: the lift runs first, so
  // the credential comparison sees the pair wherever the store carried it.
  state.setProfileIntegrationIdentity(null, "copilot-developer-cli", {
    kind: "stored",
    provider: "copilot",
    token: "ghu_legacy",
  });
  const raw = rawState();
  expect(raw.githubToken).toBeUndefined();
  expect(raw.authProvider).toBeUndefined();
  const slot = (raw.profiles as Record<string, Record<string, unknown>>).default;
  expect(slot?.githubToken).toBe("ghu_legacy");
  expect(slot?.authProvider).toBe("copilot");
  expect(slot?.integrationIdentity).toBe("copilot-developer-cli");
  // The unified read answers identically after the lift.
  expect(state.readCredential(null)).toEqual({
    kind: "stored",
    provider: "copilot",
    token: "ghu_legacy",
  });
});

test("the lift answers read-identically across every pair/slot shape (parser-drift guard)", () => {
  tmpHome();
  // The write-side lift judges "does the slot hold a credential?" on the raw
  // JSON while the read side judges the parsed slot; this table pins the two
  // judgements together across blank/junk/partial values and both layouts, so
  // either parser drifting alone fails here instead of dropping a credential.
  const tokens = [undefined, "   ", "tok"];
  const providers = [undefined, "bogus", "gh-cli", "copilot", "gh-token"];
  const slots: Array<Record<string, unknown> | undefined> = [
    undefined,
    { githubToken: "ghu_slot", authProvider: "gh-token" },
    { githubToken: "   " }, // junk-only slot: carries no credential fields
    { mode: "proxy" },
  ];
  for (const token of tokens) {
    for (const provider of providers) {
      for (const slot of slots) {
        seedRawState({
          githubToken: token,
          authProvider: provider,
          ...(slot === undefined ? {} : { profiles: { default: slot } }),
        });
        const before = new CopilotEnvState().readProfileSlot(null);
        new CopilotEnvState().adoptLegacyDefaultCredential();
        expect(new CopilotEnvState().readProfileSlot(null)).toEqual(before);
        // Positive control: whenever legacy keys were present, the lift really
        // ran (the equivalence above must not pass vacuously on no-op runs).
        if (token !== undefined || provider !== undefined) {
          const raw = rawState();
          expect(raw.githubToken).toBeUndefined();
          expect(raw.authProvider).toBeUndefined();
        }
      }
    }
  }
});

test("the default slot's integrationIdentity is a credential-derived cache like a named profile's", () => {
  tmpHome();
  const state = new CopilotEnvState();
  const pat = { kind: "stored", provider: "gh-token", token: "github_pat_d" } as const;
  // No credential recorded anywhere: the keyed cache write finds nothing to key to.
  state.setProfileIntegrationIdentity(null, "copilot-developer-cli", pat);
  expect(state.readProfileSlot(null).integrationIdentity).toBeNull();

  state.setCredential(null, pat);
  state.setProfileIntegrationIdentity(null, "copilot-developer-cli", pat);
  expect(state.readProfileSlot(null).integrationIdentity).toBe("copilot-developer-cli");

  // Re-auth invalidates the derived identity, exactly like a named slot.
  state.setCredential(null, { kind: "gh-cli" });
  expect(state.readProfileSlot(null).integrationIdentity).toBeNull();
});

test("recordDefaultMode records the agreed default wiring and clears on divergence", () => {
  tmpHome();
  const state = new CopilotEnvState();
  expect(state.readProfileSlot(null).mode).toBeNull();

  state.recordDefaultMode("proxy");
  expect(state.readProfileSlot(null).mode).toBe("proxy");

  // With a credential recorded too, the default slot parses complete -- the
  // same completeness rule as a named profile.
  state.setCredential(null, { kind: "gh-cli" });
  expect(state.readProfileSlot(null)).toEqual({
    kind: "complete",
    credential: { kind: "gh-cli" },
    mode: "proxy",
    integrationIdentity: null,
  });

  // Divergent (or unreadable) agent wiring clears the record; the credential stays.
  state.recordDefaultMode(null);
  expect(state.readProfileSlot(null).mode).toBeNull();
  expect(state.readCredential(null)).toEqual({ kind: "gh-cli" });

  // Clearing on an empty store neither creates the slot nor the profiles map.
  state.clearCredential(null);
  state.recordDefaultMode(null);
  expect(rawState().profiles).toBeUndefined();
});

test("the reserved default slot never surfaces as a named profile", () => {
  tmpHome();
  const state = new CopilotEnvState();
  state.setCredential(null, { kind: "gh-cli" });
  state.recordDefaultMode("direct");
  expect(state.profileNames()).toEqual([]);
});

test("the state lives in the shared home, independent of per-host .run state", () => {
  tmpHome();
  new CopilotEnvState().setCredential(null, {
    kind: "stored",
    provider: "gh-token",
    token: "ghu_shared",
  });
  // Stored beside config.json at the home root, not under .run/<host>/.
  expect(new CopilotEnvState().read().githubToken).toBe("ghu_shared");
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

  // The matching pid -> clears pid/port/lastEnsureAt together.
  run.clearIfPid(4242);
  const after = run.read();
  expect(after.pid).toBeUndefined();
  expect(after.port).toBeUndefined();
  expect(after.lastEnsureAt).toBeUndefined();
});

test("a named profile's integrationIdentity is a credential-derived cache: setCredential clears it", () => {
  tmpHome();
  const state = new CopilotEnvState();
  state.commitProfile(WORK, {
    credential: { kind: "stored", provider: "gh-token", token: "github_pat_x" },
    mode: "direct",
  });
  const patX = { kind: "stored", provider: "gh-token", token: "github_pat_x" } as const;
  state.setProfileIntegrationIdentity(WORK, "copilot-developer-cli", patX);
  expect(state.readProfileSlot(WORK).integrationIdentity).toBe("copilot-developer-cli");

  // Re-auth (any credential write) invalidates the derived identity, so a stale id can
  // never outlive the credential it was probed for -- the next wiring re-derives it.
  state.setCredential(WORK, { kind: "stored", provider: "gh-token", token: "github_pat_y" });
  expect(state.readProfileSlot(WORK).integrationIdentity).toBeNull();
  expect(state.readProfileSlot(WORK).mode).toBe("direct"); // mode is untouched

  // Deleting the profile removes the whole slot in one write.
  state.deleteProfile(WORK);
  expect(state.profileNames()).toEqual([]);
});

test("commitProfile writes both slot halves atomically and keeps an unchanged credential's identity", () => {
  tmpHome();
  const state = new CopilotEnvState();
  state.commitProfile(WORK, {
    credential: { kind: "stored", provider: "gh-token", token: "github_pat_x" },
    mode: "direct",
  });
  const slot = state.readProfileSlot(WORK);
  expect(slot.kind).toBe("complete");
  expect(slot.mode).toBe("direct");
  expect(slot.credential).toEqual({ kind: "stored", provider: "gh-token", token: "github_pat_x" });

  // A mode-only re-commit with the SAME credential keeps the probed identity
  // (it is derived from the credential, and the credential did not change).
  state.setProfileIntegrationIdentity(WORK, "copilot-developer-cli", {
    kind: "stored",
    provider: "gh-token",
    token: "github_pat_x",
  });
  state.commitProfile(WORK, {
    credential: { kind: "stored", provider: "gh-token", token: "github_pat_x" },
    mode: "proxy",
  });
  expect(state.readProfileSlot(WORK).mode).toBe("proxy");
  expect(state.readProfileSlot(WORK).integrationIdentity).toBe("copilot-developer-cli");

  // A commit that CHANGES the credential invalidates it, like setCredential.
  state.commitProfile(WORK, {
    credential: { kind: "stored", provider: "gh-token", token: "github_pat_y" },
    mode: "proxy",
  });
  expect(state.readProfileSlot(WORK).integrationIdentity).toBeNull();
});

test("setCredential on an unknown named profile errors instead of creating a half profile", () => {
  tmpHome();
  const state = new CopilotEnvState();
  expect(() => state.setCredential(WORK, { kind: "stored", provider: "gh-token", token: "ghp_x" }))
    .toThrow(/no such profile 'work'/);
  expect(state.profileNames()).toEqual([]);
  // The default slot is not a profile: it always accepts a credential.
  state.setCredential(null, { kind: "gh-cli" });
  expect(state.read().authProvider).toBe("gh-cli");
});

test("a blank token is rejected at the write boundary, never persisted as a partial", () => {
  tmpHome();
  const state = new CopilotEnvState();
  expect(() =>
    state.commitProfile(WORK, {
      credential: { kind: "stored", provider: "gh-token", token: "   " },
      mode: "direct",
    })
  ).toThrow(/non-empty token/);
  expect(state.profileNames()).toEqual([]);
  expect(() => state.setCredential(null, { kind: "stored", provider: "copilot", token: "" }))
    .toThrow(/non-empty token/);
  expect(state.read().authProvider).toBeNull();
});

test("setProfileIntegrationIdentity is a credential-keyed cache write: no create, no resurrect, no stale attach", () => {
  tmpHome();
  const state = new CopilotEnvState();
  const ghpW = { kind: "stored", provider: "gh-token", token: "ghp_w" } as const;
  // Missing slot (never created, or deleted by a racing --del): a no-op.
  state.setProfileIntegrationIdentity(WORK, "copilot-developer-cli", ghpW);
  expect(state.profileNames()).toEqual([]);
  state.commitProfile(WORK, { credential: ghpW, mode: "direct" });
  state.deleteProfile(WORK);
  state.setProfileIntegrationIdentity(WORK, "copilot-developer-cli", ghpW);
  expect(state.profileNames()).toEqual([]);
  // A rotation that raced the probe: the identity was derived from ghp_w, the
  // slot now holds ghp_rotated -- the stale verdict is dropped, never attached.
  state.commitProfile(WORK, {
    credential: { kind: "stored", provider: "gh-token", token: "ghp_rotated" },
    mode: "direct",
  });
  state.setProfileIntegrationIdentity(WORK, "copilot-developer-cli", ghpW);
  expect(state.readProfileSlot(WORK).integrationIdentity).toBeNull();
});

test("commitProfile mutates the raw slot in place, preserving unknown keys", () => {
  tmpHome();
  // A newer release may write fields this version does not know; the commit
  // must not erase them (the store-wide preserve-unknown-keys contract).
  writeFileSync(
    join(dir, ".copilot-env-state.json"),
    `${
      JSON.stringify({
        profiles: { work: { mode: "proxy", authProvider: "gh-token", futureField: "keep-me" } },
      })
    }\n`,
  );
  const state = new CopilotEnvState();
  state.commitProfile(WORK, {
    credential: { kind: "stored", provider: "gh-token", token: "ghp_new" },
    mode: "direct",
  });
  const raw = JSON.parse(readFileSync(join(dir, ".copilot-env-state.json"), "utf8")) as {
    profiles: Record<string, Record<string, unknown>>;
  };
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
  expect(state.readCredential(null)).toEqual({ kind: "gh-cli" });
  seedRawState({ profiles: { default: { githubToken: "ghu_ok", authProvider: "copilot" } } });
  expect(state.readCredential(null)).toEqual({
    kind: "stored",
    provider: "copilot",
    token: "ghu_ok",
  });
  // The presence-only classifier (health facts) must agree with the parse --
  // for BOTH on-disk layouts (the reserved slot and the legacy top-level pair).
  for (const provider of [null, "bogus", "gh-cli", "copilot", "gh-token"]) {
    for (const token of [null, "tok"]) {
      const pair = { githubToken: token ?? undefined, authProvider: provider ?? undefined };
      for (const layout of [pair, { profiles: { default: pair } }]) {
        seedRawState(layout);
        expect(new CopilotEnvState().readCredential(null).kind).toBe(
          storedCredentialKind(provider, token !== null),
        );
      }
    }
  }
});

test("clearCredential clears even a parse-rejected stray token and reports what it removed", () => {
  tmpHome();
  const state = new CopilotEnvState();
  expect(state.clearCredential(null)).toBe(false);
  // Parses as none, but it IS on disk -- in either layout.
  seedRawState({ githubToken: "ghu_orphan" });
  expect(state.clearCredential(null)).toBe(true);
  expect(state.read().githubToken).toBeNull();
  seedRawState({ profiles: { default: { githubToken: "ghu_orphan" } } });
  expect(state.clearCredential(null)).toBe(true);
  expect(state.read().githubToken).toBeNull();
  expect(state.clearCredential(null)).toBe(false);

  // Named: de-auth clears the credential half (and the derived identity), keeps the mode.
  state.commitProfile(WORK, {
    credential: { kind: "stored", provider: "gh-token", token: "ghp_w" },
    mode: "proxy",
  });
  state.setProfileIntegrationIdentity(WORK, "copilot-developer-cli", {
    kind: "stored",
    provider: "gh-token",
    token: "ghp_w",
  });
  expect(state.clearCredential(WORK)).toBe(true);
  const slot = state.readProfileSlot(WORK);
  expect(slot.kind).toBe("partial");
  expect(slot.credential).toEqual({ kind: "none", provider: null });
  expect(slot.mode).toBe("proxy");
  expect(slot.integrationIdentity).toBeNull();
  expect(state.clearCredential(WORK)).toBe(false);
});

test("legacy ownership keys in the state file survive writes and stay out of read()", () => {
  tmpHome();
  // Pre-ledger installs recorded artifact ownership under these keys; the
  // ledger's tolerance still reads them (ownership.test.ts), so the state
  // store must neither surface them nor destroy them on its own writes.
  writeFileSync(
    join(dir, ".copilot-env-state.json"),
    `${JSON.stringify({ webSearchDenyOwnedPaths: ["/a/settings.json"] })}\n`,
  );
  const state = new CopilotEnvState();
  expect("webSearchDenyOwnedPaths" in state.read()).toBe(false);
  state.setCredential(null, { kind: "stored", provider: "gh-token", token: "ghu_x" });
  const raw = JSON.parse(readFileSync(join(dir, ".copilot-env-state.json"), "utf8"));
  expect(raw.webSearchDenyOwnedPaths).toEqual(["/a/settings.json"]);
});

test("profileNames skips a hand-edited invalid profile key so it can never reach a path join", () => {
  tmpHome();
  // The `profiles` map lives in the user-editable state file, so its keys are a
  // trust boundary: a corrupted key ("../escape" would traverse out of profiles/
  // if it ever reached profileHome; "con" cannot be a directory on Windows) is
  // dropped at the read boundary -- the same sweep semantic as profileHomeNames'
  // stray-directory filter -- while valid siblings still come back.
  writeFileSync(
    join(dir, ".copilot-env-state.json"),
    `${
      JSON.stringify({
        profiles: {
          "../escape": { mode: "proxy", authProvider: "gh-token", githubToken: "ghp_evil" },
          con: { mode: "direct" },
          work: { mode: "direct" },
        },
      })
    }\n`,
  );
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
    integrationIdentity: null,
  });
  expect(state.readCredential(name)).toEqual({ kind: "none", provider: null });
  expect(state.profileNames()).toEqual([]);
});
