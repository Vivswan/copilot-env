import { parseUpdateAction, recheckVerdict } from "../src/commands/update.ts";
import {
  parseReleasesJson,
  pickAged,
  pickLatest,
  pickTag,
  type Release,
  resolveTarget,
} from "../src/install/resolve-release.ts";
import { CopilotEnvState } from "../src/copilot_api/env_state.ts";
import { envSnapshot, isolateProxyHome } from "./helpers.ts";
import { afterEach, beforeEach, describe, expect, removeDir, test } from "./helpers/testing.ts";

// resolve-release.ts is the single source of truth for which release `agent
// update` and the autoupdate preflight move to. The network side is thin; the
// logic worth testing is parsing + selection.

const secs = (iso: string): number => Math.floor(Date.parse(iso) / 1000);
// A release row shaped like the API, overridable per field.
const rel = (tag: string, date: string, over: Record<string, unknown> = {}): unknown => ({
  tag_name: tag,
  published_at: date,
  draft: false,
  prerelease: false,
  ...over,
});
const parsed = (tag: string, date: string): Release => ({ tag, dateSeconds: secs(date) });

// The flags parse ONCE into an UpdateAction, so a combination like `--auto-status --check` is
// a rejection instead of an if-order pick.
test("parseUpdateAction maps each flag set to one arm or one rejection", () => {
  const rows: {
    args: Parameters<typeof parseUpdateAction>[0];
    result: ReturnType<typeof parseUpdateAction> | { throws: string };
  }[] = [
    { args: {}, result: { kind: "apply", force: false, verify: undefined } },
    { args: { force: true }, result: { kind: "apply", force: true, verify: undefined } },
    { args: { verify: false }, result: { kind: "apply", force: false, verify: false } },
    { args: { verify: true, force: true }, result: { kind: "apply", force: true, verify: true } },
    { args: { check: true }, result: { kind: "check" } },
    { args: { autoStatus: true }, result: { kind: "auto-status" } },
    {
      args: { autoStatus: true, check: true },
      result: { throws: "--check and --auto-status are mutually exclusive" },
    },
    // --force and --verify/--no-verify live on the apply arm alone.
    {
      args: { check: true, force: true },
      result: { throws: "--force only applies to the manual update" },
    },
    {
      args: { autoStatus: true, force: true },
      result: { throws: "--force only applies to the manual update" },
    },
    {
      args: { check: true, verify: false },
      result: { throws: "--verify/--no-verify only apply to the manual update" },
    },
    {
      args: { autoStatus: true, verify: false },
      result: { throws: "--verify/--no-verify only apply to the manual update" },
    },
  ];
  for (const { args, result } of rows) {
    const why = JSON.stringify(args);
    if ("throws" in result) expect(() => parseUpdateAction(args), why).toThrow(result.throws);
    else expect(parseUpdateAction(args), why).toEqual(result);
  }
});

test("parseReleasesJson keeps published vX.Y.Z releases newest-first and drops the rest", () => {
  const rows: { name: string; json: string; prereleases?: boolean; releases: Release[] }[] = [
    {
      name: "sorted newest-first",
      json: JSON.stringify([
        rel("v1.9.0", "2026-05-27T00:00:00Z"),
        rel("v3.0.0", "2026-06-05T00:00:00Z"),
      ]),
      releases: [
        parsed("v3.0.0", "2026-06-05T00:00:00Z"),
        parsed("v1.9.0", "2026-05-27T00:00:00Z"),
      ],
    },
    {
      name: "drafts, prereleases, and non-vX.Y.Z tags are skipped",
      json: JSON.stringify([
        rel("v1.0.0", "2026-06-01T00:00:00Z"),
        rel("v1.1.0", "2026-06-02T00:00:00Z", { draft: true }),
        rel("v1.2.0", "2026-06-03T00:00:00Z", { prerelease: true }),
        rel("v1.3.0-rc1", "2026-06-04T00:00:00Z"),
        rel("nightly", "2026-06-05T00:00:00Z"),
      ]),
      releases: [parsed("v1.0.0", "2026-06-01T00:00:00Z")],
    },
    // An exact-tag resolve may opt prereleases in ...
    {
      name: "prereleases excluded by default",
      json: JSON.stringify([
        rel("v3.0.0", "2026-06-05T00:00:00Z", { prerelease: true }),
        rel("v1.9.0", "2026-05-27T00:00:00Z"),
      ]),
      releases: [parsed("v1.9.0", "2026-05-27T00:00:00Z")],
    },
    {
      name: "prereleases included on request",
      json: JSON.stringify([
        rel("v3.0.0", "2026-06-05T00:00:00Z", { prerelease: true }),
        rel("v1.9.0", "2026-05-27T00:00:00Z"),
      ]),
      prereleases: true,
      releases: [
        parsed("v3.0.0", "2026-06-05T00:00:00Z"),
        parsed("v1.9.0", "2026-05-27T00:00:00Z"),
      ],
    },
    // ... but a draft's assets are not publicly downloadable, so it is never a target however
    // it was asked for.
    {
      name: "a draft is skipped even when prereleases are included",
      json: JSON.stringify([rel("v3.0.0", "2026-06-05T00:00:00Z", { draft: true })]),
      prereleases: true,
      releases: [],
    },
    {
      name: "a draft is skipped by default",
      json: JSON.stringify([rel("v3.0.0", "2026-06-05T00:00:00Z", { draft: true })]),
      releases: [],
    },
    {
      name: "created_at stands in for a missing published_at",
      json: JSON.stringify([{ tag_name: "v1.0.0", created_at: "2026-06-01T00:00:00Z" }]),
      releases: [parsed("v1.0.0", "2026-06-01T00:00:00Z")],
    },
    { name: "invalid JSON", json: "not json", releases: [] },
    { name: "an API error object", json: '{"message":"Not Found"}', releases: [] },
    { name: "an empty array", json: "[]", releases: [] },
  ];
  for (const { name, json, prereleases, releases } of rows) {
    expect(parseReleasesJson(json, prereleases), name).toEqual(releases);
  }
});

test("pickLatest, pickAged, and pickTag select one release from the parsed list", () => {
  const now = secs("2026-06-06T00:00:00Z");
  const releases: Release[] = parseReleasesJson(
    JSON.stringify([
      rel("v3.0.0", "2026-06-05T00:00:00Z"), // 1 day old
      rel("v1.9.0", "2026-05-27T00:00:00Z"), // 10 days old
      rel("v1.8.0", "2026-05-07T00:00:00Z"), // 30 days old
    ]),
  );
  const fresh = parseReleasesJson(JSON.stringify([rel("v4.0.0", "2026-06-05T23:00:00Z")]));
  const rows: { name: string; pick: () => Release | null; tag: string | null }[] = [
    { name: "pickLatest is the newest", pick: () => pickLatest(releases), tag: "v3.0.0" },
    { name: "pickLatest of nothing", pick: () => pickLatest([]), tag: null },
    {
      name: "pickAged(7) skips the too-fresh release",
      pick: () => pickAged(releases, now, 7),
      tag: "v1.9.0",
    },
    { name: "pickAged(0) is the latest", pick: () => pickAged(releases, now, 0), tag: "v3.0.0" },
    {
      name: "pickAged falls back to the oldest when none is old enough",
      pick: () => pickAged(fresh, now, 7),
      tag: "v4.0.0",
    },
    { name: "pickTag with the leading v", pick: () => pickTag(releases, "v1.9.0"), tag: "v1.9.0" },
    {
      name: "pickTag without the leading v",
      pick: () => pickTag(releases, "1.9.0"),
      tag: "v1.9.0",
    },
    { name: "pickTag of an unknown tag", pick: () => pickTag(releases, "v9.9.9"), tag: null },
  ];
  for (const { name, pick, tag } of rows) {
    expect(pick()?.tag ?? null, name).toBe(tag);
  }
});

describe("resolveTarget retry (de-flakes the release lookup)", () => {
  const realFetch = globalThis.fetch;
  const realBase = process.env.COPILOT_ENV_RELEASE_RETRY_BASE_MS;
  beforeEach(() => {
    process.env.COPILOT_ENV_RELEASE_RETRY_BASE_MS = "0"; // no backoff delay in tests
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realBase === undefined) delete process.env.COPILOT_ENV_RELEASE_RETRY_BASE_MS;
    else process.env.COPILOT_ENV_RELEASE_RETRY_BASE_MS = realBase;
  });

  const releasesJson = JSON.stringify([rel("v1.0.0", "2026-06-01T00:00:00Z")]);

  test("retries transient failures, gives up at once on a 404, and stops after the last attempt", async () => {
    // Each row is the fetch outcome per attempt; "throw" is a network error, a number a status.
    const rows: {
      name: string;
      attempts: (number | "throw")[];
      tag: string | null;
      calls: number;
    }[] = [
      {
        name: "a thrown error, then a 503, then success",
        attempts: ["throw", 503, 200],
        tag: "v1.0.0",
        calls: 3,
      },
      { name: "a 404 is not retried", attempts: [404], tag: null, calls: 1 },
      {
        name: "a persistent 503 exhausts the attempts",
        attempts: [503, 503, 503, 503],
        tag: null,
        calls: 4,
      },
    ];
    for (const { name, attempts, tag, calls } of rows) {
      let seen = 0;
      globalThis.fetch = (() => {
        const outcome = attempts[seen] ?? 200;
        seen++;
        if (outcome === "throw") return Promise.reject(new Error("ECONNRESET"));
        return Promise.resolve(
          new Response(outcome === 200 ? releasesJson : "", { status: outcome }),
        );
      }) as unknown as typeof fetch;
      expect((await resolveTarget(null))?.tag ?? null, name).toBe(tag);
      expect(seen, name).toBe(calls);
    }
  });

  // The lookup is anonymous: a shell GH_TOKEN for another account or the stored Copilot
  // credential would otherwise turn `agent update --check` into that token's 401.
  test("sends no Authorization header with GH_TOKEN exported and a credential stored", async () => {
    const restoreEnv = envSnapshot();
    let home = "";
    let sent: Headers | null = null;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      sent = new Headers(init?.headers);
      return new Response(releasesJson, { status: 200 });
    }) as unknown as typeof fetch;
    try {
      home = isolateProxyHome("copilot-update-anon-");
      process.env.GH_TOKEN = "ghp_someone_elses";
      process.env.GITHUB_TOKEN = "ghp_someone_elses";
      new CopilotEnvState().setCredential(null, {
        kind: "stored",
        provider: "gh-token",
        token: "ghu_stored",
      });
      expect((await resolveTarget(null))?.tag).toBe("v1.0.0");
      expect(sent).not.toBeNull();
      expect(sent!.has("authorization")).toBe(false);
      expect(sent!.get("accept")).toBe("application/vnd.github+json");
    } finally {
      restoreEnv();
      removeDir(home);
    }
  });
});

// resolveTarget's null unions "no eligible release" with "the look FAILED" (the retry loop
// above swallows a persistent 503 or a 404 into null). The pre-lock resolve already proved an
// eligible release exists, so under the lock a null can only be a failed look; `unproven`
// keeps it off the green up-to-date line that would otherwise cover a SKIPPED update.
test("recheckVerdict (the under-lock re-validate): unproven, up-to-date, or apply", () => {
  const target = (tag: string): Release => ({ tag, dateSeconds: secs("2026-06-01T00:00:00Z") });
  const rows: {
    name: string;
    installed: string;
    target: Release | null;
    verdict: ReturnType<typeof recheckVerdict>;
  }[] = [
    {
      name: "a failed re-check is unproven, NOT up-to-date",
      installed: "v1.0.0",
      target: null,
      verdict: { kind: "unproven" },
    },
    {
      name: "same version",
      installed: "v1.2.3",
      target: target("v1.2.3"),
      verdict: { kind: "up-to-date" },
    },
    // A concurrent updater having moved us PAST the target is up-to-date too: the downgrade
    // guard this re-validate exists to be.
    {
      name: "already past the target",
      installed: "v2.0.0",
      target: target("v1.2.3"),
      verdict: { kind: "up-to-date" },
    },
    // The target applied is the one resolved UNDER the lock, not the pre-lock one.
    {
      name: "a newer release applies, carrying the re-resolved target",
      installed: "v1.0.0",
      target: target("v1.5.0"),
      verdict: { kind: "apply", target: target("v1.5.0") },
    },
  ];
  for (const row of rows) {
    expect(recheckVerdict(row.installed, row.target), row.name).toEqual(row.verdict);
  }
});
