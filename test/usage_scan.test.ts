import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ScanHit, type ScanLines, TAIL_PROBE_BYTES } from "../src/usage/contribution.ts";
import { scanBytes, scanLines, scanSource } from "../src/usage/scan.ts";
import { afterEach, expect, tempDir, test } from "./helpers/testing.ts";

// The contract's function type and the implementation must stay assignable.
const asContract: ScanLines = scanLines;
void asContract;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function trackedDir(): string {
  const dir = tempDir("usage-scan-");
  dirs.push(dir);
  return dir;
}

function writeTemp(content: string | Uint8Array): string {
  const path = join(trackedDir(), "log.jsonl");
  writeFileSync(path, content);
  return path;
}

function collect(
  path: string,
  needles: readonly string[],
  fromByte = 0,
  bufferBytes?: number,
): { hits: ScanHit[]; result: ReturnType<typeof scanLines> } {
  const hits: ScanHit[] = [];
  const result = scanLines(path, fromByte, needles, (hit) => hits.push(hit), { bufferBytes });
  return { hits, result };
}

/** `scanSource` over an in-memory buffer whose reads hand out one byte at a time. */
function scanBytesOneAtATime(
  bytes: Uint8Array,
  fromByte: number,
  needles: readonly string[],
  onLine: (hit: ScanHit) => void,
): ReturnType<typeof scanLines> {
  return scanSource(
    (target, position) => {
      if (position >= bytes.length || target.length === 0) {
        return 0;
      }
      target[0] = bytes[position]!;
      return 1;
    },
    fromByte,
    needles,
    onLine,
    { bufferBytes: 4 },
  );
}

function hexOfTail(content: string, parsedThrough: number): string {
  const bytes = Buffer.from(content);
  return bytes.subarray(Math.max(0, parsedThrough - TAIL_PROBE_BYTES), parsedThrough).toString(
    "hex",
  );
}

/** Whole-file scans: what a line must contain to be delivered, and the bytes it spans. Every
 *  file here ends in a terminator, so the whole file is parsed and the probe is its tail. */
const LINE_CONTENT: {
  name: string;
  content: string;
  needles: string[];
  bufferBytes?: number;
  hits: ScanHit[];
}[] = (() => {
  const utf8First = "plain \u00e9\u00e8 \u{1F600}\n";
  const utf8Matched = '{"type":"assistant","text":"caf\u00e9 \u{1F680} \u4e2d\u6587"}\n';
  // JSON escapes quotes inside strings, so the false positive is a NESTED object carrying
  // the same key and value, not quoted text; the parser must reject it.
  const nested = '{"type":"user","message":{"content":[{"type":"assistant","text":"x"}]}}';
  const bom = "\ufeff";
  // node:readline (Deno's polyfill) split on U+2028/U+2029 too, silently dropping every JSONL
  // line whose content carried one; JSON leaves those characters unescaped, so they occur in
  // real transcripts. NEL and a lone CR ride along.
  const separators = [0x2028, 0x2029, 0x85, 0x0d].map((code) => String.fromCharCode(code));
  const separated = `{"type":"assistant","text":"a${separators.join("b")}c"}`;
  return [
    {
      name: "only the complete lines that contain a needle, with byte offsets",
      content:
        'plain line\n{"type":"assistant","n":1}\nanother plain\n{"type":"assistant","n":2}\n',
      needles: ['"type":"assistant"'],
      hits: [
        { line: '{"type":"assistant","n":1}', byteStart: 11, byteEnd: 38 },
        { line: '{"type":"assistant","n":2}', byteStart: 52, byteEnd: 79 },
      ],
    },
    {
      name: "a CRLF terminator is stripped from the line and both bytes count in byteEnd",
      content: "TOKEN one\r\nplain\r\nTOKEN two\r\n",
      needles: ["TOKEN"],
      hits: [
        { line: "TOKEN one", byteStart: 0, byteEnd: 11 },
        { line: "TOKEN two", byteStart: 18, byteEnd: 29 },
      ],
    },
    {
      // A tiny buffer so multi-byte sequences straddle chunk boundaries too.
      name: "multi-byte UTF-8 decodes in a matched line and byte offsets stay exact",
      content: `${utf8First}${utf8Matched}TOKEN plain\n`,
      needles: ['"type":"assistant"'],
      bufferBytes: 5,
      hits: [{
        line: utf8Matched.slice(0, -1),
        byteStart: Buffer.byteLength(utf8First),
        byteEnd: Buffer.byteLength(utf8First) + Buffer.byteLength(utf8Matched),
      }],
    },
    {
      name: "a needle found inside another line's content is delivered",
      content: `${nested}\n{"type":"assistant"}\n`,
      needles: ['"type":"assistant"'],
      hits: [
        { line: nested, byteStart: 0, byteEnd: Buffer.byteLength(nested) + 1 },
        {
          line: '{"type":"assistant"}',
          byteStart: Buffer.byteLength(nested) + 1,
          byteEnd: Buffer.byteLength(nested) + 1 + 21,
        },
      ],
    },
    {
      name: "a line several needles hit is delivered once, in line order",
      content: "B only\nA and B\nA only\nneither\n",
      needles: ["A", "B"],
      hits: [
        { line: "B only", byteStart: 0, byteEnd: 7 },
        { line: "A and B", byteStart: 7, byteEnd: 15 },
        { line: "A only", byteStart: 15, byteEnd: 22 },
      ],
    },
    {
      // The BOM is the scanner's to deliver and the parser's to reject.
      name: "a leading byte order mark stays in the delivered line",
      content: `${bom}{"type":"assistant","n":1}\n{"type":"assistant","n":2}\n`,
      needles: ['"type":"assistant"'],
      hits: [
        { line: `${bom}{"type":"assistant","n":1}`, byteStart: 0, byteEnd: 3 + 27 },
        { line: '{"type":"assistant","n":2}', byteStart: 30, byteEnd: 57 },
      ],
    },
    {
      name: "lines cut on LF only: Unicode separators and a lone CR stay inside their line",
      content: `${separated}\nTOKEN\n`,
      needles: ['"type":"assistant"'],
      bufferBytes: 7,
      hits: [{ line: separated, byteStart: 0, byteEnd: Buffer.byteLength(separated) + 1 }],
    },
  ];
})();

for (const { name, content, needles, bufferBytes, hits: expected } of LINE_CONTENT) {
  test(`scanLines delivers ${name}`, () => {
    const path = writeTemp(content);
    const { hits, result } = collect(path, needles, 0, bufferBytes);
    expect(hits).toEqual(expected);
    const length = Buffer.byteLength(content);
    expect(result).toEqual({
      bytesRead: length,
      parsedThrough: length,
      tailProbeHex: hexOfTail(content, length),
    });
  });
}

/** A partial scan (a small read buffer, a resume offset, one-byte reads) must reproduce the
 *  whole-file default-buffer scan from `fromByte` on, and seed the same probe. */
const PARTIAL_SCANS: {
  name: string;
  content: string;
  fromByte?: number;
  bufferBytes?: number;
  oneByteReads?: boolean;
  lines: string[];
}[] = (() => {
  // 20-byte lines: with an 8-byte buffer every read ends mid-line, and lines longer than the
  // buffer force the growth path; a buffer of 25 puts the first boundary inside the second
  // line's needle.
  const twenty = Array.from({ length: 12 }, (_, i) => `x TOKEN ${String(i).padStart(11, "0")}`);
  const forty = Array.from({ length: 40 }, (_, i) => (i % 3 === 0 ? `TOKEN ${i}` : `plain ${i}`));
  const fortyContent = `${forty.join("\n")}\n`;
  // Resume from the start of the 10th line (the fourth hit): exactly the hits at or after it.
  const tenthLineStart = Buffer.byteLength(forty.slice(0, 9).join("\n")) + 1;
  // A 60-byte line and a 64-byte buffer: the first read completes only that line (probe =
  // its last 32 bytes), the second completes the 6-byte line, so the final probe must splice
  // the two consumptions together.
  const spliced = `${"x".repeat(53)} TOKEN\nTOKEN\n`;
  return [
    {
      name: "a chunk boundary inside a line",
      content: `${twenty.join("\n")}\n`,
      bufferBytes: 8,
      lines: twenty,
    },
    {
      name: "a chunk boundary inside a needle",
      content: `${twenty.join("\n")}\n`,
      bufferBytes: 25,
      lines: twenty,
    },
    {
      name: "a resume from a byte offset",
      content: fortyContent,
      fromByte: tenthLineStart,
      bufferBytes: 16,
      lines: forty.slice(9).filter((l) => l.startsWith("TOKEN")),
    },
    {
      name: "a resume where nothing new follows",
      content: "TOKEN a\nTOKEN b\n",
      fromByte: Buffer.byteLength("TOKEN a\nTOKEN b\n"),
      lines: [],
    },
    {
      name: "a final chunk with fewer than TAIL_PROBE_BYTES of complete lines",
      content: spliced,
      bufferBytes: 64,
      lines: [`${"x".repeat(53)} TOKEN`, "TOKEN"],
    },
    {
      // One byte per read: the probe seed and the body both have to loop.
      name: "a source that returns short reads",
      content: `${"y".repeat(40)}\nTOKEN tail\n`,
      fromByte: 41,
      oneByteReads: true,
      lines: ["TOKEN tail"],
    },
  ];
})();

for (const { name, content, fromByte = 0, bufferBytes, oneByteReads, lines } of PARTIAL_SCANS) {
  test(`scanLines reproduces the whole scan through ${name}`, () => {
    const path = writeTemp(content);
    const whole = collect(path, ["TOKEN"]);
    let partial: { hits: ScanHit[]; result: ReturnType<typeof scanLines> };
    if (oneByteReads) {
      const hits: ScanHit[] = [];
      const result = scanBytesOneAtATime(
        Buffer.from(content),
        fromByte,
        ["TOKEN"],
        (h) => hits.push(h),
      );
      partial = { hits, result };
    } else {
      partial = collect(path, ["TOKEN"], fromByte, bufferBytes);
    }
    expect(partial.hits.map((h) => h.line)).toEqual(lines);
    expect(partial.hits).toEqual(whole.hits.filter((h) => h.byteStart >= fromByte));
    const length = Buffer.byteLength(content);
    // The seed read for the probe is honest: bytes after fromByte plus the probe bytes.
    expect(partial.result).toEqual({
      bytesRead: length - fromByte + Math.min(fromByte, TAIL_PROBE_BYTES),
      parsedThrough: length,
      tailProbeHex: hexOfTail(content, length),
    });
  });
}

/** Where parsedThrough and the probe land at the end of a file: an unterminated fragment is
 *  never delivered and parsedThrough stops before it; a complete or empty file is probed whole. */
const TAIL_BOUNDARIES: {
  name: string;
  content: string;
  bufferBytes?: number;
  lines: string[];
  parsedThrough: number;
}[] = [
  {
    name: "an unterminated final fragment is never delivered",
    content: "a TOKEN 1\nb TOKEN 2\nc TOKEN torn",
    bufferBytes: 6,
    lines: ["a TOKEN 1", "b TOKEN 2"],
    parsedThrough: 20,
  },
  {
    name: "a file shorter than the probe is probed whole",
    content: "TOKEN\n",
    lines: ["TOKEN"],
    parsedThrough: 6,
  },
  { name: "an empty file has an empty probe", content: "", lines: [], parsedThrough: 0 },
  {
    name: "an unterminated only line leaves parsedThrough at 0",
    content: "TOKEN torn",
    lines: [],
    parsedThrough: 0,
  },
];

for (const { name, content, bufferBytes, lines, parsedThrough } of TAIL_BOUNDARIES) {
  test(`scanLines: ${name}`, () => {
    const { hits, result } = collect(writeTemp(content), ["TOKEN"], 0, bufferBytes);
    expect(hits.map((h) => h.line)).toEqual(lines);
    expect(result).toEqual({
      bytesRead: Buffer.byteLength(content),
      parsedThrough,
      tailProbeHex: hexOfTail(content, parsedThrough),
    });
  });
}

test("scanBytes applies the same rules to an in-memory buffer", () => {
  const content = "TOKEN a\r\nplain\nTOKEN b\nTOKEN torn";
  const fromFile = collect(writeTemp(content), ["TOKEN"], 0, 4);
  const hits: ScanHit[] = [];
  const result = scanBytes(Buffer.from(content), ["TOKEN"], (h) => hits.push(h), {
    bufferBytes: 4,
  });
  expect(hits).toEqual(fromFile.hits);
  expect(result).toEqual(fromFile.result);
});

test("scanLines nested inside another scan's callback delivers both files correctly", () => {
  const outerPath = writeTemp("TOKEN o1\nplain\nTOKEN o2\n");
  const innerPath = writeTemp("TOKEN i1\nTOKEN i2\n");
  const outer: string[] = [];
  const inner: string[][] = [];
  // Default buffers on both levels: the inner scan must not borrow the outer's.
  const result = scanLines(outerPath, 0, ["TOKEN"], (hit) => {
    outer.push(hit.line);
    const lines: string[] = [];
    scanLines(innerPath, 0, ["TOKEN"], (h) => lines.push(h.line));
    inner.push(lines);
  });
  expect(outer).toEqual(["TOKEN o1", "TOKEN o2"]);
  expect(inner).toEqual([["TOKEN i1", "TOKEN i2"], ["TOKEN i1", "TOKEN i2"]]);
  expect(result.parsedThrough).toBe(24);
});

test("scanLines rejects needles that cannot be searched byte-exactly", () => {
  const path = writeTemp("TOKEN\n");
  for (const needle of ["", "a\nb", "caf\u00e9"]) {
    expect(() => collect(path, [needle])).toThrow(/scan needle/);
  }
  expect(() => collect(path, ["TOKEN"], 0, 0)).toThrow(/buffer size/);
});

test("scanLines propagates filesystem errors: missing file, directory, failing source", () => {
  const dir = trackedDir();
  expect(() => collect(join(dir, "missing.jsonl"), ["TOKEN"])).toThrow(/ENOENT/);
  expect(() => collect(dir, ["TOKEN"])).toThrow(/EISDIR|EBADF|EPERM/);
  // A read that fails mid-scan surfaces as-is.
  let reads = 0;
  expect(() =>
    scanSource(
      (target, position) => {
        if (++reads > 1) {
          throw new Error("disk gone");
        }
        const chunk = Buffer.from("TOKEN a\nTOKEN b\n");
        const n = Math.min(target.length, chunk.length - position);
        target.set(chunk.subarray(position, position + n));
        return n;
      },
      0,
      ["TOKEN"],
      () => {},
      {},
    )
  ).toThrow("disk gone");
});
