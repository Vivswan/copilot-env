import { describe, expect, test } from "bun:test";

import { pickAgedTag, pickLatestTag } from "../src/commands/update.ts";

// The git/network side of `agent update` is thin; the logic worth testing is the
// pure tag selection it feeds with `git ls-remote` / `git for-each-ref` output.

describe("pickLatestTag", () => {
  const lsRemote = [
    "aaa\trefs/tags/v1.2.0",
    "aaa\trefs/tags/v1.2.0^{}",
    "bbb\trefs/tags/v1.10.3",
    "bbb\trefs/tags/v1.10.3^{}",
    "ccc\trefs/tags/v1.9.0",
  ].join("\n");

  test("returns the first non-peeled release tag (caller pre-sorts desc)", () => {
    expect(pickLatestTag(lsRemote)).toBe("v1.2.0");
  });

  test("ignores peeled ^{} rows", () => {
    expect(pickLatestTag("aaa\trefs/tags/v2.0.0^{}\naaa\trefs/tags/v2.0.0")).toBe("v2.0.0");
  });

  test("returns null when there are no release tags", () => {
    expect(pickLatestTag("aaa\trefs/tags/not-a-version\n")).toBeNull();
    expect(pickLatestTag("")).toBeNull();
  });
});

describe("pickAgedTag", () => {
  const now = 1_000_000_000;
  const day = 24 * 60 * 60;
  // for-each-ref output, newest first: unix-timestamp <space> tag
  const refs = [
    `${now - 1 * day} v2.0.0`, // 1 day old  -> too fresh for a 7d cooldown
    `${now - 10 * day} v1.9.0`, // 10 days old -> first aged one
    `${now - 30 * day} v1.8.0`,
  ].join("\n");

  test("returns the newest tag at least N days old", () => {
    expect(pickAgedTag(refs, now, 7)).toBe("v1.9.0");
  });

  test("a smaller window lets the fresher tag through", () => {
    expect(pickAgedTag(refs, now, 0)).toBe("v2.0.0");
  });

  test("falls back to the oldest available release when nothing is old enough", () => {
    // Mirrors the installers' resolve_aged_release: newest-aged, else oldest tag.
    expect(pickAgedTag(`${now - day} v3.0.0\n${now - day} v2.9.0`, now, 7)).toBe("v2.9.0");
  });

  test("ignores malformed lines and non-version tags", () => {
    expect(
      pickAgedTag(`garbage\n${now - 30 * day} nightly\n${now - 30 * day} v1.0.0`, now, 7),
    ).toBe("v1.0.0");
  });
});
