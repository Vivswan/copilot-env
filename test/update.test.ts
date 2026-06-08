import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseReleasesJson,
  pickAged,
  pickLatest,
  pickTag,
  type Release,
} from "../src/install/resolve-release.ts";
import {
  parseSha256Checksum,
  sourceArchivePrefix,
  verifySourceArchiveEntry,
  verifySourceArchiveSha256,
} from "../src/install/verify-source-archive.ts";

// resolve-release.ts is the single source of truth for the release pick (imported by
// `agent update` and downloaded+run by the installers). The network side is thin; the
// logic worth testing is parsing + selection.

const secs = (iso: string): number => Math.floor(Date.parse(iso) / 1000);
const url = (tag: string): string =>
  `https://api.github.com/repos/Vivswan/copilot-env/tarball/${tag}`;
const sha = (n: string): string => n.padStart(40, "0");
// A release row shaped like the API, overridable per field.
const rel = (tag: string, date: string, over: Record<string, unknown> = {}): unknown => ({
  tag_name: tag,
  published_at: date,
  tarball_url: url(tag),
  target_commitish: sha(tag.replace(/\D/g, "")),
  draft: false,
  prerelease: false,
  ...over,
});
const archiveDigest = "d09b936d834dbd7b0cbe1b016146aab603e94d66f121ddfbcd271a653fc2f3de";
const sourceArchiveAsset = (tag: string, digest = `sha256:${archiveDigest}`): unknown => ({
  name: `copilot-env-${tag}.tar.gz`,
  url: `https://api.github.com/repos/Vivswan/copilot-env/releases/assets/${tag.replace(/\D/g, "")}1`,
  browser_download_url: `https://github.com/Vivswan/copilot-env/releases/download/${tag}/copilot-env-${tag}.tar.gz`,
  digest,
});

describe("parseReleasesJson", () => {
  test("parses published vX.Y.Z releases (tag/date/tarball), sorted newest-first", () => {
    const json = JSON.stringify([
      rel("v1.9.0", "2026-05-27T00:00:00Z"),
      rel("v3.0.0", "2026-06-05T00:00:00Z"),
    ]);
    const r = parseReleasesJson(json);
    expect(r.map((x) => x.tag)).toEqual(["v3.0.0", "v1.9.0"]);
    expect(r[0]?.dateSeconds).toBe(secs("2026-06-05T00:00:00Z"));
    expect(r[0]?.tarballUrl).toBe(url("v3.0.0"));
    expect(r[0]?.sourceSha).toBe(sha("300"));
    expect(r[0]?.sourceSha256).toBeNull();
  });

  test("prefers uploaded source archive assets and reads their GitHub digest", () => {
    const json = JSON.stringify([
      rel("v3.0.0", "2026-06-05T00:00:00Z", {
        assets: [sourceArchiveAsset("v3.0.0")],
      }),
    ]);
    const release = parseReleasesJson(json)[0];
    expect(release?.tarballUrl).toBe(
      "https://github.com/Vivswan/copilot-env/releases/download/v3.0.0/copilot-env-v3.0.0.tar.gz",
    );
    expect(release?.sourceSha256).toBe(archiveDigest);
  });

  test("does not invent a SHA256 for GitHub's generated tarball", () => {
    const json = JSON.stringify([
      rel("v3.0.0", "2026-06-05T00:00:00Z", {
        assets: [],
      }),
    ]);
    const release = parseReleasesJson(json)[0];
    expect(release?.tarballUrl).toBe(url("v3.0.0"));
    expect(release?.sourceSha256).toBeNull();
  });

  test("ignores malformed GitHub asset digests", () => {
    const json = JSON.stringify([
      rel("v3.0.0", "2026-06-05T00:00:00Z", {
        assets: [sourceArchiveAsset("v3.0.0", "md5:bad")],
      }),
    ]);
    const release = parseReleasesJson(json)[0];
    expect(release?.tarballUrl).toBe(
      "https://github.com/Vivswan/copilot-env/releases/download/v3.0.0/copilot-env-v3.0.0.tar.gz",
    );
    expect(release?.sourceSha256).toBeNull();
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

  test("can include prereleases for exact-tag installer resolution", () => {
    const json = JSON.stringify([
      rel("v3.0.0", "2026-06-05T00:00:00Z", { prerelease: true }),
      rel("v1.9.0", "2026-05-27T00:00:00Z"),
    ]);
    expect(parseReleasesJson(json).map((x) => x.tag)).toEqual(["v1.9.0"]);
    expect(parseReleasesJson(json, false, true).map((x) => x.tag)).toEqual(["v3.0.0", "v1.9.0"]);
  });

  test("can include draft releases for authenticated release smoke tests", () => {
    const json = JSON.stringify([
      rel("v3.0.0", "2026-06-05T00:00:00Z", { draft: true }),
      rel("v1.9.0", "2026-05-27T00:00:00Z"),
    ]);
    expect(parseReleasesJson(json).map((x) => x.tag)).toEqual(["v1.9.0"]);
    expect(parseReleasesJson(json, true).map((x) => x.tag)).toEqual(["v3.0.0", "v1.9.0"]);
  });

  test("can include draft releases with uploaded archive assets and no GitHub tarball URL", () => {
    const json = JSON.stringify([
      rel("v3.0.0", "2026-06-05T00:00:00Z", {
        draft: true,
        tarball_url: null,
        assets: [sourceArchiveAsset("v3.0.0")],
      }),
    ]);
    expect(parseReleasesJson(json)).toEqual([]);
    expect(parseReleasesJson(json, true)[0]).toMatchObject({
      tag: "v3.0.0",
      tarballUrl: "https://api.github.com/repos/Vivswan/copilot-env/releases/assets/3001",
      sourceSha256: archiveDigest,
    });
  });

  test("skips releases with no tarball_url", () => {
    const json = JSON.stringify([
      { tag_name: "v1.0.0", published_at: "2026-06-01T00:00:00Z", draft: false, prerelease: false },
    ]);
    expect(parseReleasesJson(json)).toEqual([]);
  });

  test("skips releases without a full target commit SHA", () => {
    const json = JSON.stringify([
      rel("v1.0.0", "2026-06-01T00:00:00Z", { target_commitish: "main" }),
      rel("v1.1.0", "2026-06-02T00:00:00Z", { target_commitish: "abc123" }),
    ]);
    expect(parseReleasesJson(json)).toEqual([]);
  });

  test("falls back to created_at when published_at is absent", () => {
    const json = JSON.stringify([
      {
        tag_name: "v1.0.0",
        created_at: "2026-06-01T00:00:00Z",
        tarball_url: url("v1.0.0"),
        target_commitish: sha("100"),
      },
    ]);
    expect(parseReleasesJson(json)).toEqual([
      {
        tag: "v1.0.0",
        dateSeconds: secs("2026-06-01T00:00:00Z"),
        tarballUrl: url("v1.0.0"),
        sourceSha: sha("100"),
        sourceSha256: null,
      },
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

describe("source archive checksum marker", () => {
  test("extracts GitHub source archive SHA prefixes", () => {
    expect(sourceArchivePrefix("Vivswan-copilot-env-6c5ae7f/")).toBe("6c5ae7f");
    expect(sourceArchivePrefix("Vivswan-copilot-env-6c5ae7fe77396713/file.txt")).toBe(
      "6c5ae7fe77396713",
    );
  });

  test("rejects archive roots without a SHA prefix", () => {
    expect(sourceArchivePrefix("Vivswan-copilot-env-main/")).toBeNull();
    expect(sourceArchivePrefix("")).toBeNull();
  });

  test("verifies archive prefixes against the expected full SHA", () => {
    const sha = "6c5ae7fe77396713000000000000000000000000";
    expect(verifySourceArchiveEntry("Vivswan-copilot-env-6c5ae7f/package.json", sha)).toBe(
      "6c5ae7f",
    );
    expect(() => verifySourceArchiveEntry("Vivswan-copilot-env-deadbee/package.json", sha)).toThrow(
      "checksum mismatch",
    );
  });
});

describe("source archive SHA256", () => {
  test("parses standard sha256sum output", () => {
    const hash = "a".repeat(64);
    expect(parseSha256Checksum(`${hash}  copilot-env-v3.0.0.tar.gz\n`)).toBe(hash);
  });

  test("verifies full archive SHA256 bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "copilot-env-sha256-"));
    try {
      const file = join(dir, "release.tgz");
      writeFileSync(file, "hello");
      expect(
        verifySourceArchiveSha256(
          file,
          "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        ),
      ).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
      expect(() =>
        verifySourceArchiveSha256(file, `${"0".repeat(64)}  copilot-env-v3.0.0.tar.gz`),
      ).toThrow("SHA256 mismatch");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
