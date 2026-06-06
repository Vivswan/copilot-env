import { describe, expect, test } from "bun:test";

import {
  parseReleasesJson,
  pickAged,
  pickLatest,
  type Release,
} from "../src/install/resolve-release.ts";

// resolve-release.ts is the single source of truth for the release pick (imported by
// `agent update` and downloaded+run by the installers). The network side is thin; the
// logic worth testing is parsing + selection.

const secs = (iso: string): number => Math.floor(Date.parse(iso) / 1000);
const url = (tag: string): string =>
  `https://api.github.com/repos/Vivswan/copilot-env/tarball/${tag}`;
// A release row shaped like the API, overridable per field.
const rel = (tag: string, date: string, over: Record<string, unknown> = {}): unknown => ({
  tag_name: tag,
  published_at: date,
  tarball_url: url(tag),
  draft: false,
  prerelease: false,
  ...over,
});

describe("parseReleasesJson", () => {
  test("parses published vX.Y.Z releases (tag/date/tarball), sorted newest-first", () => {
    const json = JSON.stringify([
      rel("v1.9.0", "2026-05-27T00:00:00Z"),
      rel("v2.0.0", "2026-06-05T00:00:00Z"),
    ]);
    const r = parseReleasesJson(json);
    expect(r.map((x) => x.tag)).toEqual(["v2.0.0", "v1.9.0"]);
    expect(r[0]?.dateSeconds).toBe(secs("2026-06-05T00:00:00Z"));
    expect(r[0]?.tarballUrl).toBe(url("v2.0.0"));
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

  test("skips releases with no tarball_url", () => {
    const json = JSON.stringify([
      { tag_name: "v1.0.0", published_at: "2026-06-01T00:00:00Z", draft: false, prerelease: false },
    ]);
    expect(parseReleasesJson(json)).toEqual([]);
  });

  test("falls back to created_at when published_at is absent", () => {
    const json = JSON.stringify([
      { tag_name: "v1.0.0", created_at: "2026-06-01T00:00:00Z", tarball_url: url("v1.0.0") },
    ]);
    expect(parseReleasesJson(json)).toEqual([
      { tag: "v1.0.0", dateSeconds: secs("2026-06-01T00:00:00Z"), tarballUrl: url("v1.0.0") },
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
      rel("v2.0.0", "2026-06-05T00:00:00Z"), // 1 day old
      rel("v1.9.0", "2026-05-27T00:00:00Z"), // 10 days old
      rel("v1.8.0", "2026-05-07T00:00:00Z"), // 30 days old
    ]),
  );

  test("pickLatest = newest release", () => expect(pickLatest(releases)?.tag).toBe("v2.0.0"));
  test("pickAged(7) skips the too-fresh release", () =>
    expect(pickAged(releases, now, 7)?.tag).toBe("v1.9.0"));
  test("pickAged(0) = latest", () => expect(pickAged(releases, now, 0)?.tag).toBe("v2.0.0"));
  test("pickAged falls back to the oldest when none is old enough", () => {
    const fresh = parseReleasesJson(JSON.stringify([rel("v3.0.0", "2026-06-05T23:00:00Z")]));
    expect(pickAged(fresh, now, 7)?.tag).toBe("v3.0.0");
  });
  test("pickLatest is null on empty", () => expect(pickLatest([])).toBeNull());
});
