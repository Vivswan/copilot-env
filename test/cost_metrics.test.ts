// The pure red-path pieces of .github/scripts/cost-metrics.ts: payload comparison, mismatch
// classification, rendered-output bounds, fence escaping, comment ownership, the window math,
// and the child-environment isolation.
import { Buffer } from "node:buffer";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
  assertWindowHasUsage,
  boundedBlock,
  boundExcerpt,
  canonical,
  childEnv,
  classifyPayloads,
  COMMENT_AUTHOR,
  COMMENT_MARKER,
  comparable,
  DIFF_SECTION_BYTES,
  DIFF_SECTION_LINES,
  diffSection,
  FAILURE_SUMMARY_BYTES,
  FAILURE_SUMMARY_LINES,
  failureSummary,
  fenced,
  localMidnightMs,
  ownedCommentIds,
  parseTreeSummary,
  run,
  RUNTIME_KEY,
  wholeTreeWindow,
} from "../.github/scripts/cost-metrics.ts";
import { describe, expect, test, testAbortSignal } from "./helpers/testing.ts";

/** Lines and bytes of a rendered text, the two quantities the bounds promise. */
function size(text: string): { lines: number; bytes: number } {
  return { lines: text.trimEnd().split("\n").length, bytes: Buffer.byteLength(text, "utf8") };
}

describe("comparable", () => {
  test("drops only the runtime key and sorts keys at every depth", () => {
    const a = {
      z: { b: 1, a: [{ d: 1, c: 2 }] },
      a: 0,
      [RUNTIME_KEY]: { index: { bytesRead: 5 } },
    };
    const b = { a: 0, z: { a: [{ c: 2, d: 1 }], b: 1 } };
    expect(comparable(a)).toBe(comparable(b));
  });

  test("keeps every other key, so a runtime-looking sibling still differs", () => {
    expect(comparable({ a: 1, stats: { x: 1 } })).not.toBe(comparable({ a: 1 }));
  });

  test("canonical leaves primitives and array order alone", () => {
    expect(canonical([3, 1, { b: null, a: "x" }])).toEqual([3, 1, { a: "x", b: null }]);
  });
});

describe("classifyPayloads", () => {
  const heads = (...texts: string[]) => texts.map((text, i) => ({ label: `h${i}`, text }));
  const noRecheck = () => Promise.reject(new Error("recheck must not run"));
  const noDiff = () => Promise.reject(new Error("diff must not run"));

  test("all heads equal to base: match, no recheck, no diff", async () => {
    expect(await classifyPayloads("A", heads("A", "A"), noRecheck, noDiff)).toEqual({
      outcome: { kind: "match" },
      rechecked: false,
    });
  });

  test("a difference the base re-run confirms is a differs with the first head's diff", async () => {
    const result = await classifyPayloads(
      "A",
      heads("A", "B", "C"),
      () => Promise.resolve("A"),
      (t) => Promise.resolve(`diff:${t}`),
    );
    expect(result).toEqual({
      outcome: { kind: "differs", labels: ["h1", "h2"], diff: "diff:B" },
      rechecked: true,
    });
  });

  test("a base that moved to where every head is: transient, never a diff", async () => {
    const result = await classifyPayloads("A", heads("B", "B"), () => Promise.resolve("B"), noDiff);
    expect(result).toEqual({
      outcome: { kind: "transient", labels: ["h0", "h1"] },
      rechecked: true,
    });
  });

  test("a base that moved somewhere the heads are not is unstable input", async () => {
    await expect(classifyPayloads("A", heads("B"), () => Promise.resolve("C"), noDiff)).rejects
      .toThrow(/unstable/);
  });
});

describe("assertWindowHasUsage", () => {
  const priced = { activeDays: 3, totalUsd: 1.5 };
  const unpriced = { activeDays: 3, totalUsd: 0 };

  test("passes when either source has priced usage", () => {
    expect(() => assertWindowHasUsage("w", { claudeSessions: priced })).not.toThrow();
    expect(() => assertWindowHasUsage("w", { codexSessions: { providers: { openai: priced } } }))
      .not.toThrow();
  });

  test("fails on no active days, and on active days priced to zero or below", () => {
    expect(() => assertWindowHasUsage("w", { claudeSessions: { activeDays: 0 } })).toThrow(
      /no Codex or Claude usage/,
    );
    expect(() =>
      assertWindowHasUsage("w", {
        claudeSessions: unpriced,
        codexSessions: { providers: { openai: unpriced } },
      })
    ).toThrow(/priced nothing/);
    expect(() => assertWindowHasUsage("w", { claudeSessions: { activeDays: 3, totalUsd: -0.5 } }))
      .toThrow(/priced nothing/);
  });
});

describe("boundExcerpt", () => {
  const fiveLines = Array.from({ length: 5 }, (_, i) => `l${i}`).join("\n");

  test("a line cap counts the note: two lines out for a cap of two", () => {
    const out = boundExcerpt(fiveLines, 2, 1000);
    expect(out).toBe("l0\n... 4 more lines");
    expect(size(out).lines).toBe(2);
  });

  test("a byte cap counts the note: at most 40 bytes out for a cap of 40", () => {
    const out = boundExcerpt("x".repeat(100), 10, 40);
    expect(size(out).bytes).toBeLessThanOrEqual(40);
    expect(out).toMatch(/^x+\n\.\.\. \d+ more bytes$/);
  });

  test("a byte cut on an uncut line count still keeps the line cap", () => {
    const out = boundExcerpt("aaaaaaaaaa\nbbbbbbbbbb\ncccccccccc", 3, 25);
    expect(size(out).lines).toBeLessThanOrEqual(3);
    expect(size(out).bytes).toBeLessThanOrEqual(25);
    expect(out).toContain("more bytes");
  });

  test("never splits a multibyte character", () => {
    const out = boundExcerpt("\u00e9".repeat(10), 10, 24);
    expect(size(out).bytes).toBeLessThanOrEqual(24);
    expect(out.startsWith("\u00e9")).toBe(true);
    expect(out).not.toContain("\uFFFD");
  });

  test("keeps a genuine trailing replacement character", () => {
    expect(boundExcerpt("ab\uFFFD", 10, 5)).toBe("ab\uFFFD");
  });

  test("a terminal newline is not a dropped line", () => {
    expect(boundExcerpt("a\nb\n", 2, 100)).toBe("a\nb");
  });

  test("returns text within both bounds untouched", () => {
    expect(boundExcerpt("a\nb", 10, 10)).toBe("a\nb");
  });

  test("a budget of zero lines or bytes yields nothing, and a cap of one line is one line", () => {
    expect(boundExcerpt("x", 0, 100)).toBe("");
    expect(boundExcerpt("x", 1, 0)).toBe("");
    expect(size(boundExcerpt(fiveLines, 1, 100)).lines).toBe(1);
    expect(size(boundExcerpt("x".repeat(100), 1, 30)).lines).toBe(1);
  });

  test("a note that alone exceeds the byte budget is itself cut to the budget", () => {
    const out = boundExcerpt(fiveLines, 2, 8);
    expect(size(out).bytes).toBeLessThanOrEqual(8);
    expect(size(out).lines).toBeLessThanOrEqual(2);
  });
});

describe("fenced and bounded blocks", () => {
  test("fenced uses a fence longer than any backtick run in the text", () => {
    const out = fenced("x\n````\ny", "diff");
    expect(out.startsWith("`````diff\n")).toBe(true);
    expect(out.endsWith("\n`````")).toBe(true);
  });

  test("fenced defaults to three backticks and refuses an info string that could break out", () => {
    expect(fenced("plain")).toBe("```\nplain\n```");
    expect(() => fenced("x", "di`ff")).toThrow(RangeError);
    expect(() => fenced("x", "diff\nmore")).toThrow(RangeError);
  });

  test("boundedBlock keeps the RENDERED block within both bounds, fences included", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i} ${"`".repeat(i % 5)}`).join("\n");
    const out = boundedBlock(text, "diff", 10, 200);
    expect(size(out).lines).toBeLessThanOrEqual(10);
    expect(size(out).bytes).toBeLessThanOrEqual(200);
    expect(out.startsWith("`````diff\n")).toBe(true);
  });

  test("boundedBlock refuses a budget too small for an empty block", () => {
    expect(() => boundedBlock("x", "", 2, 100)).toThrow(RangeError);
    expect(() => boundedBlock("x", "diff", 3, 7)).toThrow(RangeError);
    expect(size(boundedBlock("", "", 3, 8)).lines).toBe(3);
  });

  test("one long CONSECUTIVE backtick run never inflates the fence past the budget", () => {
    const run = "`".repeat(5000);
    expect(boundedBlock(run, "", 3, 8)).toBe("```\n\n```");
    const out = boundedBlock(`${run}\nx`, "diff", 5, 60);
    expect(size(out).lines).toBeLessThanOrEqual(5);
    expect(size(out).bytes).toBeLessThanOrEqual(60);
    const fence = out.split("\n")[0]?.replace("diff", "") ?? "";
    expect(out.split("\n").slice(1, -1).every((line) => !line.includes(fence))).toBe(true);
  });

  test("a message made of many separate backtick runs still renders", () => {
    const out = failureSummary("`x ".repeat(125_000));
    expect(size(out).lines).toBeLessThanOrEqual(FAILURE_SUMMARY_LINES);
    expect(size(out).bytes).toBeLessThanOrEqual(FAILURE_SUMMARY_BYTES);
  });

  test("failureSummary stays within its bounds for a huge message", () => {
    const out = failureSummary("e".repeat(100_000) + "\n".repeat(1000) + "```");
    expect(out.startsWith(`${COMMENT_MARKER}\n## Cost metrics: measurement failed\n`)).toBe(true);
    expect(size(out).lines).toBeLessThanOrEqual(FAILURE_SUMMARY_LINES);
    expect(size(out).bytes).toBeLessThanOrEqual(FAILURE_SUMMARY_BYTES);
  });

  test("diffSection stays within its bounds for a huge diff", () => {
    const diff = Array.from({ length: 5000 }, (_, i) => `-${"v".repeat(200)} ${i}`).join("\n");
    const out = diffSection("whole tree", "head cold", diff);
    expect(size(out).lines).toBeLessThanOrEqual(DIFF_SECTION_LINES);
    expect(size(out).bytes).toBeLessThanOrEqual(DIFF_SECTION_BYTES);
    expect(out).toContain("### whole tree: head cold vs base (excerpt)");
    expect(out).toContain("more lines");
  });

  test("diffSection bounds an oversized, multi-line heading too", () => {
    const out = diffSection("w\n".repeat(400), "l".repeat(1000), "-a\n+b");
    expect(size(out).lines).toBeLessThanOrEqual(DIFF_SECTION_LINES);
    expect(size(out).bytes).toBeLessThanOrEqual(DIFF_SECTION_BYTES);
    expect(out.split("\n").filter((line) => line.startsWith("### ")).length).toBe(1);
  });
});

describe("child environment", () => {
  test("childEnv passes only the allowlist plus the extras", () => {
    process.env.COST_METRICS_LEAK = "1";
    try {
      const env = childEnv({ COST_METRICS_PROBE: "1" });
      expect(env.COST_METRICS_PROBE).toBe("1");
      expect(env.COST_METRICS_LEAK).toBeUndefined();
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      delete process.env.COST_METRICS_LEAK;
    }
  });

  test("run hands a child NOTHING beyond the env it is given (deno's polyfill would merge)", async () => {
    process.env.COST_METRICS_LEAK = "1";
    try {
      const result = await run("deno", [
        "eval",
        "console.log(JSON.stringify(Object.keys(Deno.env.toObject()).sort()))",
      ], {
        env: childEnv({ COST_METRICS_PROBE: "1" }),
        timeoutMs: 15_000,
        signal: testAbortSignal(),
      });
      expect(result.status).toBe(0);
      const keys: unknown = JSON.parse(result.stdout);
      expect(keys).toContain("COST_METRICS_PROBE");
      expect(keys).not.toContain("COST_METRICS_LEAK");
    } finally {
      delete process.env.COST_METRICS_LEAK;
    }
  });

  test("run rejects a missing executable at the spawn", async () => {
    await expect(
      run("/nonexistent/cost-metrics-binary", [], { env: childEnv({}), timeoutMs: 15_000 }),
    ).rejects.toThrow(Deno.errors.NotFound);
  });

  test("run kills a child that outlives its timeout", async () => {
    await expect(
      run("deno", ["eval", "await new Promise((r) => setTimeout(r, 60_000))"], {
        env: childEnv({}),
        timeoutMs: 500,
        signal: testAbortSignal(),
      }),
    ).rejects.toThrow(/was killed/);
  });

  // Deno.addSignalListener is unsupported on Windows, where the child would exit at once.
  if (Deno.build.os !== "windows") {
    test("the kill is SIGKILL: a child ignoring SIGTERM still dies", async () => {
      // The abort is the caller's and fires only after the child reports its handler installed,
      // so a SIGTERM-only kill could not pass by racing the handler.
      const dir = mkdtempSync(join(tmpdir(), "cost-metrics-test-"));
      const ready = join(dir, "ready");
      const abort = new AbortController();
      const suite = testAbortSignal();
      // The child's outcome is captured at once, so a failed handshake below can never leave
      // its rejection unhandled, and teardown waits for the child before removing the dir.
      const outcome: Promise<unknown> = run("deno", [
        "eval",
        "Deno.addSignalListener('SIGTERM', () => {}); " +
        `Deno.writeTextFileSync(${JSON.stringify(ready)}, ""); ` +
        "await new Promise((r) => setTimeout(r, 60_000))",
      ], {
        env: childEnv({}),
        timeoutMs: 15_000,
        signal: suite === undefined ? abort.signal : AbortSignal.any([abort.signal, suite]),
      }).then(() => undefined, (error: unknown) => error);
      try {
        const deadline = Date.now() + 10_000;
        while (!existsSync(ready) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 20));
        }
        expect(existsSync(ready)).toBe(true);
        abort.abort(new Error("test abort"));
        const error = await outcome;
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/was killed: Error: test abort/);
      } finally {
        abort.abort(new Error("test teardown"));
        await outcome;
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe("ownedCommentIds", () => {
  const own = (id: number, body: string, login = COMMENT_AUTHOR) => ({ id, body, user: { login } });

  test("selects only the bot's comments that start with the marker, in order", () => {
    const listing = [
      own(1, `quoting ${COMMENT_MARKER} in the middle`),
      own(2, `${COMMENT_MARKER}\nours`),
      own(3, `${COMMENT_MARKER}\nours`, "someone"),
      own(4, `${COMMENT_MARKER}\nours too`),
      { id: 5, body: null, user: { login: COMMENT_AUTHOR } },
    ];
    expect(ownedCommentIds(listing)).toEqual([2, 4]);
  });

  test("rejects a listing that is not an array", () => {
    expect(() => ownedCommentIds({})).toThrow(/not an array/);
  });
});

describe("tree summary and window", () => {
  const summary = { files: 3, bytes: 10, firstDay: "2026-07-22", lastDay: "2026-09-02" };

  test("parses the validated fields and ignores extras", () => {
    expect(parseTreeSummary(JSON.stringify({ ...summary, mb: 30, note: "x" }))).toEqual(summary);
  });

  test("rejects a missing field, a non-integer, and a non-calendar day", () => {
    expect(() => parseTreeSummary(JSON.stringify({ ...summary, files: undefined }))).toThrow(
      /"files"/,
    );
    expect(() => parseTreeSummary(JSON.stringify({ ...summary, bytes: 1.5 }))).toThrow(/"bytes"/);
    expect(() => parseTreeSummary(JSON.stringify({ ...summary, firstDay: "2026-02-30" }))).toThrow(
      /calendar/,
    );
    expect(() => parseTreeSummary("")).toThrow(/JSON object/);
  });

  test("the window reaches back to the first day with one day of slack", () => {
    const today = localMidnightMs("2026-09-04", "today");
    expect(wholeTreeWindow(summary, today)).toEqual({
      label: "whole tree (43 days, 46-day window)",
      args: ["--days", "46"],
    });
  });

  test("a tree that starts today still gets a two-day window", () => {
    const today = localMidnightMs("2026-09-04", "today");
    const oneDay = { ...summary, firstDay: "2026-09-04", lastDay: "2026-09-04" };
    expect(wholeTreeWindow(oneDay, today).args).toEqual(["--days", "2"]);
  });

  test("a future start or a reversed span is rejected", () => {
    const today = localMidnightMs("2026-09-01", "today");
    expect(() => wholeTreeWindow(summary, today)).not.toThrow();
    expect(() => wholeTreeWindow(summary, localMidnightMs("2026-07-21", "today"))).toThrow(
      /future/,
    );
    expect(() => wholeTreeWindow({ ...summary, lastDay: "2026-07-01" }, today)).toThrow(/before/);
  });

  test("localMidnightMs does not roll invalid days over and keeps two-digit years literal", () => {
    expect(() => localMidnightMs("2026-02-30", "d")).toThrow(/calendar/);
    expect(() => localMidnightMs("2026-13-01", "d")).toThrow(/calendar/);
    expect(new Date(localMidnightMs("0050-03-01", "d")).getFullYear()).toBe(50);
  });
});
