import { describe } from "bun:test";
import {
  parseUpdateAction,
  recheckVerdict,
  updatePreviewMessage,
} from "../../src/commands/update.ts";
import { CopilotEnvState } from "../../src/copilot_api/env_state.ts";
import {
  parseReleasesJson,
  pickAged,
  type Release,
  resolveAged,
  resolveTarget,
} from "../../src/install/resolve-release.ts";
import { must } from "../../src/utils/assert.ts";
import { envSnapshot, isolateProxyHome } from "../helpers/env.ts";
import { expect, removeDir, test } from "../helpers/testing.ts";

// resolve-release.ts is the single source of truth for which release `agent
// update` and the autoupdate preflight move to. The network side is thin; the
// logic worth testing is parsing + selection.

// Seconds since the epoch, the unit Release.dateSeconds holds.
const secs = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

// A release row in the GitHub Releases API's shape.
const rel = (tag: string, date: string, over: Record<string, unknown> = {}): unknown => ({
  tag_name: tag,
  published_at: date,
  draft: false,
  prerelease: false,
  ...over,
});

// The Release the parser yields for rel(tag, date): the tag and its seconds.
const parsed = (tag: string, date: string): Release => ({ tag, dateSeconds: secs(date) });

// The flags parse ONCE into an UpdateAction, so a combination like `--auto-status --check` is
// a rejection instead of an if-order pick.
test("parseUpdateAction maps each flag set to one arm or one rejection", () => {
  const rows: {
    args: Parameters<typeof parseUpdateAction>[0];
    result: ReturnType<typeof parseUpdateAction> | { throws: string };
  }[] = [
    { args: {}, result: { kind: "apply", force: false, verify: undefined, dryRun: false } },
    {
      args: { force: true },
      result: { kind: "apply", force: true, verify: undefined, dryRun: false },
    },
    {
      args: { verify: false },
      result: { kind: "apply", force: false, verify: false, dryRun: false },
    },
    {
      args: { verify: true, force: true },
      result: { kind: "apply", force: true, verify: true, dryRun: false },
    },
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

test("updatePreviewMessage lists the steps one per line and names the migration preview", () => {
  const rows: Array<[boolean, string]> = [
    [true, "  verify its checksum and build provenance"],
    [false, "  verify its checksum"],
  ];
  for (const [provenance, verify] of rows) {
    expect(String(updatePreviewMessage("v1.0.0", "v1.2.3", provenance)), String(provenance)).toBe(
      [
        "Would download the v1.2.3 release for this platform.",
        verify,
        "  let the new binary lay down its runtime files",
        "  flip current to it",
        "  refresh the launcher shims",
        "  run the migrations v1.0.0 -> v1.2.3",
        "Then:",
        "  agent migrate 1.0.0 1.2.3 --dry-run  preview the migrations",
      ].join("\n"),
    );
  }
});

test("parseReleasesJson keeps published vX.Y.Z releases newest-first, drops the rest, and counts the page's rows", () => {
  const rows: { name: string; json: string; releases: Release[]; count: number }[] = [
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
      count: 2,
    },
    {
      name: "drafts, prereleases, and non-vX.Y.Z tags are skipped but still counted",
      json: JSON.stringify([
        rel("v1.0.0", "2026-06-01T00:00:00Z"),
        rel("v1.1.0", "2026-06-02T00:00:00Z", { draft: true }),
        rel("v1.2.0", "2026-06-03T00:00:00Z", { prerelease: true }),
        rel("v1.3.0-rc1", "2026-06-04T00:00:00Z"),
        rel("nightly", "2026-06-05T00:00:00Z"),
      ]),
      releases: [parsed("v1.0.0", "2026-06-01T00:00:00Z")],
      count: 5,
    },
    // A draft's assets are not publicly downloadable, so it is never a target.
    {
      name: "a draft alone leaves nothing",
      json: JSON.stringify([rel("v3.0.0", "2026-06-05T00:00:00Z", { draft: true })]),
      releases: [],
      count: 1,
    },
    {
      name: "created_at stands in for a missing published_at",
      json: JSON.stringify([{ tag_name: "v1.0.0", created_at: "2026-06-01T00:00:00Z" }]),
      releases: [parsed("v1.0.0", "2026-06-01T00:00:00Z")],
      count: 1,
    },
    { name: "invalid JSON", json: "not json", releases: [], count: 0 },
    { name: "an API error object", json: '{"message":"Not Found"}', releases: [], count: 0 },
    { name: "an empty array", json: "[]", releases: [], count: 0 },
  ];
  for (const { name, json, releases, count } of rows) {
    expect(parseReleasesJson(json), name).toEqual({ releases, rows: count });
  }
});

test("pickAged selects the newest release old enough, or nothing", () => {
  const now = secs("2026-06-06T00:00:00Z");
  const { releases } = parseReleasesJson(
    JSON.stringify([
      rel("v3.0.0", "2026-06-05T00:00:00Z"), // 1 day old
      rel("v1.9.0", "2026-05-27T00:00:00Z"), // 10 days old
      rel("v1.8.0", "2026-05-07T00:00:00Z"), // 30 days old
    ]),
  );
  const fresh = parseReleasesJson(JSON.stringify([rel("v4.0.0", "2026-06-05T23:00:00Z")]));
  const rows: { name: string; pick: () => Release | null; tag: string | null }[] = [
    {
      name: "pickAged(7) skips the too-fresh release",
      pick: () => pickAged(releases, now, 7),
      tag: "v1.9.0",
    },
    { name: "pickAged(0) is the latest", pick: () => pickAged(releases, now, 0), tag: "v3.0.0" },
    {
      name: "pickAged is null when none is old enough",
      pick: () => pickAged(fresh.releases, now, 7),
      tag: null,
    },
  ];
  for (const { name, pick, tag } of rows) {
    expect(pick()?.tag ?? null, name).toBe(tag);
  }
});

/** A fetch stub answering each `page=N` from `pages` (a short page is the last), or the status. */
function pagedFetch(pages: unknown[][], failPage?: number) {
  const seen: number[] = [];
  const fetchImpl = (input: string | URL | Request): Promise<Response> => {
    const page = Number(new URL(String(input)).searchParams.get("page"));
    seen.push(page);
    if (page === failPage) return Promise.resolve(new Response("", { status: 404 }));
    return Promise.resolve(Response.json(pages[page - 1] ?? []));
  };
  return { fetchImpl, seen };
}

/** The unit daysAgo counts in. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** A published_at this many days before now, in the API's ISO form. */
const daysAgo = (days: number): string => new Date(Date.now() - days * DAY_MS).toISOString();

/** A full page of too-fresh prereleases: what a vendor that publishes many alphas a day returns first. */
const FRESH_PAGE: unknown[] = Array.from({ length: 100 }, (_, i) =>
  rel(`v9.0.0-alpha.${i}`, daysAgo(0), { prerelease: true }),
);

/** The source resolveAged reads: a repo and the tag pattern its stable releases match. */
const COPILOT_ENV = { repo: "example/repo", tagPattern: /^v\d+\.\d+\.\d+$/ };

// The vendors' release lists are longer than one API page, and a page can be all prereleases;
// a one-page read called a week-old release absent and, before that, picked a fresher one.
test("resolveAged reads pages until one holds a release old enough, stops at a short page with the oldest it saw, and reports an unread page", async () => {
  const rows: {
    name: string;
    pages: unknown[][];
    failPage?: number;
    days: number;
    result: Awaited<ReturnType<typeof resolveAged>>;
    seen: number[];
  }[] = [
    {
      name: "the pick sits on page two",
      pages: [FRESH_PAGE, [rel("v2.0.0", daysAgo(2)), rel("v1.0.0", daysAgo(9))]],
      days: 7,
      result: { kind: "release", release: { tag: "v1.0.0", dateSeconds: expect.any(Number) } },
      seen: [1, 2],
    },
    {
      name: "a short page ends the read with the oldest stable release seen",
      pages: [[rel("v2.0.0", daysAgo(2)), rel("v1.0.0", daysAgo(3))]],
      days: 7,
      result: { kind: "none", oldest: { tag: "v1.0.0", dateSeconds: expect.any(Number) } },
      seen: [1],
    },
    {
      name: "five full pages with nothing old enough give up",
      pages: [
        FRESH_PAGE,
        FRESH_PAGE,
        FRESH_PAGE,
        FRESH_PAGE,
        FRESH_PAGE,
        [rel("v1.0.0", daysAgo(9))],
      ],
      days: 7,
      result: { kind: "none", oldest: null },
      seen: [1, 2, 3, 4, 5],
    },
    {
      name: "a page that cannot be read is unread, whatever the pages before it held",
      pages: [FRESH_PAGE],
      failPage: 2,
      days: 7,
      result: { kind: "unread" },
      seen: [1, 2],
    },
  ];
  for (const row of rows) {
    const { fetchImpl, seen } = pagedFetch(row.pages, row.failPage);
    const result = await resolveAged(COPILOT_ENV, row.days, { fetchImpl, retryBaseMs: 0 });
    expect(result, row.name).toEqual(row.result);
    expect(seen, row.name).toEqual(row.seen);
  }
});

// copilot-env's own update keeps installing something from a repository whose every release is
// fresh (the first weeks of a new repository), where a vendor install must not.
test("resolveTarget with a cooldown falls back to the oldest release when none is old enough", async () => {
  const { fetchImpl } = pagedFetch([[rel("v2.0.0", daysAgo(2)), rel("v1.0.0", daysAgo(3))]]);
  const target = await resolveTarget(7, { fetchImpl, retryBaseMs: 0 });
  expect(target?.tag).toBe("v1.0.0");
});

describe("resolveTarget retry (de-flakes the release lookup)", () => {
  const releasesJson = JSON.stringify([rel("v1.0.0", "2026-06-01T00:00:00Z")]);

  function resolveWith(answer: (init?: RequestInit) => Promise<Response>): Promise<Release | null> {
    return resolveTarget(null, {
      fetchImpl: (_input: string | URL | Request, init?: RequestInit) => answer(init),
      retryBaseMs: 0,
    });
  }

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
      const resolved = await resolveWith(() => {
        const outcome = attempts[seen] ?? 200;
        seen++;
        if (outcome === "throw") return Promise.reject(new Error("ECONNRESET"));
        return Promise.resolve(
          new Response(outcome === 200 ? releasesJson : "", { status: outcome }),
        );
      });
      expect(resolved?.tag ?? null, name).toBe(tag);
      expect(seen, name).toBe(calls);
    }
  });

  // The lookup is anonymous: a shell GH_TOKEN for another account or the stored Copilot
  // credential would otherwise turn `agent update --check` into that token's 401.
  test("sends no Authorization header with GH_TOKEN exported and a credential stored", async () => {
    const restoreEnv = envSnapshot();
    let home = "";
    const sent: Headers[] = [];
    try {
      home = isolateProxyHome("copilot-update-anon-");
      process.env.GH_TOKEN = "ghp_someone_elses";
      process.env.GITHUB_TOKEN = "ghp_someone_elses";
      new CopilotEnvState().setCredential(null, {
        kind: "stored",
        provider: "gh-token",
        token: "ghu_stored",
      });
      const resolved = await resolveWith((init) => {
        sent.push(new Headers(init?.headers));
        return Promise.resolve(new Response(releasesJson, { status: 200 }));
      });
      expect(resolved?.tag).toBe("v1.0.0");
      const headers = must(sent[0], "the fetch stub saw the one request");
      expect(headers.has("authorization")).toBe(false);
      expect(headers.get("accept")).toBe("application/vnd.github+json");
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
