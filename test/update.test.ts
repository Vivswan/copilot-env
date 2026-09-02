import { parseUpdateAction } from "../src/commands/update.ts";
import {
  parseReleasesJson,
  pickAged,
  pickLatest,
  pickTag,
  type Release,
  resolveTarget,
} from "../src/install/resolve-release.ts";
import { afterEach, beforeEach, describe, expect, test } from "./helpers/testing.ts";

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

// The CLI boundary: `agent update`'s flags parse ONCE into an UpdateAction, so
// a combination the old if-chain would resolve by order (`--auto-status --check`
// ran the status and dropped --check) is a rejection instead.
describe("parseUpdateAction", () => {
  test("each single-intent invocation maps to its own arm", () => {
    expect(parseUpdateAction({})).toEqual({ kind: "apply", force: false });
    expect(parseUpdateAction({ force: true })).toEqual({ kind: "apply", force: true });
    expect(parseUpdateAction({ check: true })).toEqual({ kind: "check" });
    expect(parseUpdateAction({ auto: true })).toEqual({ kind: "enable-auto" });
    expect(parseUpdateAction({ noAuto: true })).toEqual({ kind: "disable-auto" });
    expect(parseUpdateAction({ autoStatus: true })).toEqual({ kind: "auto-status" });
  });

  test("two report/toggle flags together are a rejection, never an if-order pick", () => {
    for (
      const args of [
        { autoStatus: true, check: true },
        { auto: true, check: true },
        { noAuto: true, autoStatus: true },
      ]
    ) {
      expect(() => parseUpdateAction(args)).toThrow(
        "--check, --auto, --no-auto, and --auto-status are mutually exclusive",
      );
    }
  });

  test("--force lives on the apply arm alone", () => {
    for (
      const args of [
        { check: true, force: true },
        { auto: true, force: true },
        { autoStatus: true, force: true },
      ]
    ) {
      expect(() => parseUpdateAction(args)).toThrow("--force only applies to the manual update");
    }
  });
});

describe("parseReleasesJson", () => {
  test("parses published vX.Y.Z releases, sorted newest-first", () => {
    const json = JSON.stringify([
      rel("v1.9.0", "2026-05-27T00:00:00Z"),
      rel("v3.0.0", "2026-06-05T00:00:00Z"),
    ]);
    const r = parseReleasesJson(json);
    expect(r.map((x) => x.tag)).toEqual(["v3.0.0", "v1.9.0"]);
    expect(r[0]?.dateSeconds).toBe(secs("2026-06-05T00:00:00Z"));
  });

  test("skips drafts, prereleases, and non-vX.Y.Z tags", () => {
    const json = JSON.stringify([
      rel("v1.0.0", "2026-06-01T00:00:00Z"),
      rel("v1.1.0", "2026-06-02T00:00:00Z", { draft: true }),
      rel("v1.2.0", "2026-06-03T00:00:00Z", { prerelease: true }),
      rel("v1.3.0-rc1", "2026-06-04T00:00:00Z"),
      rel("nightly", "2026-06-05T00:00:00Z"),
    ]);
    expect(parseReleasesJson(json).map((x) => x.tag)).toEqual(["v1.0.0"]);
  });

  test("can include prereleases for an exact-tag resolve", () => {
    const json = JSON.stringify([
      rel("v3.0.0", "2026-06-05T00:00:00Z", { prerelease: true }),
      rel("v1.9.0", "2026-05-27T00:00:00Z"),
    ]);
    expect(parseReleasesJson(json).map((x) => x.tag)).toEqual(["v1.9.0"]);
    expect(parseReleasesJson(json, true).map((x) => x.tag)).toEqual(["v3.0.0", "v1.9.0"]);
  });

  test("a draft is never eligible, even for an exact tag", () => {
    // Draft assets are not publicly downloadable, so a draft can never be a
    // valid update target however it was asked for.
    const json = JSON.stringify([rel("v3.0.0", "2026-06-05T00:00:00Z", { draft: true })]);
    expect(parseReleasesJson(json)).toEqual([]);
    expect(parseReleasesJson(json, true)).toEqual([]);
  });

  test("falls back to created_at when published_at is absent", () => {
    const json = JSON.stringify([{ tag_name: "v1.0.0", created_at: "2026-06-01T00:00:00Z" }]);
    expect(parseReleasesJson(json)).toEqual([
      { tag: "v1.0.0", dateSeconds: secs("2026-06-01T00:00:00Z") },
    ]);
  });

  test("returns [] for invalid JSON or a non-array (e.g. an API error object)", () => {
    expect(parseReleasesJson("not json")).toEqual([]);
    expect(parseReleasesJson('{"message":"Not Found"}')).toEqual([]);
    expect(parseReleasesJson("[]")).toEqual([]);
  });
});

describe("pickLatest / pickAged", () => {
  const now = secs("2026-06-06T00:00:00Z");
  const releases: Release[] = parseReleasesJson(
    JSON.stringify([
      rel("v3.0.0", "2026-06-05T00:00:00Z"), // 1 day old
      rel("v1.9.0", "2026-05-27T00:00:00Z"), // 10 days old
      rel("v1.8.0", "2026-05-07T00:00:00Z"), // 30 days old
    ]),
  );

  test("pickLatest = newest release", () => expect(pickLatest(releases)?.tag).toBe("v3.0.0"));
  test("pickAged(7) skips the too-fresh release", () =>
    expect(pickAged(releases, now, 7)?.tag).toBe("v1.9.0"));
  test("pickAged(0) = latest", () => expect(pickAged(releases, now, 0)?.tag).toBe("v3.0.0"));
  test("pickAged falls back to the oldest when none is old enough", () => {
    const fresh = parseReleasesJson(JSON.stringify([rel("v4.0.0", "2026-06-05T23:00:00Z")]));
    expect(pickAged(fresh, now, 7)?.tag).toBe("v4.0.0");
  });
  test("pickTag resolves exact releases with or without a leading v", () => {
    expect(pickTag(releases, "v1.9.0")?.tag).toBe("v1.9.0");
    expect(pickTag(releases, "1.9.0")?.tag).toBe("v1.9.0");
    expect(pickTag(releases, "v9.9.9")).toBeNull();
  });
  test("pickLatest is null on empty", () => expect(pickLatest([])).toBeNull());
});

// runUpdate resolves the cooldown inline from the stored config `update-cooldown` (set via
// `agent config --set update-cooldown <days>`), else null (immediate) -- there is no flag and no
// wrapper. The config-key round-trip is covered in env_config.test.ts; the `?? null` is trivial.

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

  test("retries transient failures (a thrown error, then a 503) then succeeds", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) throw new Error("ECONNRESET");
      if (calls === 2) return new Response("", { status: 503 });
      return new Response(releasesJson, { status: 200 });
    }) as unknown as typeof fetch;
    const target = await resolveTarget(null);
    expect(target?.tag).toBe("v1.0.0");
    expect(calls).toBe(3);
  });

  test("gives up immediately on a non-retryable status (404)", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    expect(await resolveTarget(null)).toBeNull();
    expect(calls).toBe(1); // no retry on a 404
  });

  test("returns null after exhausting retries on a persistent 503", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("", { status: 503 });
    }) as unknown as typeof fetch;
    expect(await resolveTarget(null)).toBeNull();
    expect(calls).toBe(4); // MAX_FETCH_ATTEMPTS
  });
});
