import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ScanHit, type ScanLines, TAIL_PROBE_BYTES } from "../src/usage/contribution.ts";
import { hasIdleScanBuffer, scanBytes, scanLines, scanSource } from "../src/usage/scan.ts";
import { expect, test } from "./helpers/testing.ts";

// The contract's function type and the implementation must stay assignable.
const asContract: ScanLines = scanLines;
void asContract;

function writeTemp(content: string | Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), "usage-scan-"));
  const path = join(dir, "log.jsonl");
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

test("scanLines delivers only the complete lines that contain a needle, with byte offsets", () => {
  const content =
    'plain line\n{"type":"assistant","n":1}\nanother plain\n{"type":"assistant","n":2}\n';
  const path = writeTemp(content);
  const { hits, result } = collect(path, ['"type":"assistant"']);
  expect(hits).toEqual([
    { line: '{"type":"assistant","n":1}', byteStart: 11, byteEnd: 38 },
    { line: '{"type":"assistant","n":2}', byteStart: 52, byteEnd: 79 },
  ]);
  expect(result).toEqual({
    bytesRead: Buffer.byteLength(content),
    parsedThrough: Buffer.byteLength(content),
    tailProbeHex: hexOfTail(content, Buffer.byteLength(content)),
  });
});

test("scanLines survives a chunk boundary that falls inside a needle and inside a line", () => {
  // 20-byte lines and an 8-byte buffer: every read ends mid-line, and lines
  // longer than the buffer force the growth path.
  const lines = Array.from({ length: 12 }, (_, i) => `x TOKEN ${String(i).padStart(11, "0")}`);
  const content = `${lines.join("\n")}\n`;
  const path = writeTemp(content);
  const whole = collect(path, ["TOKEN"]);
  const small = collect(path, ["TOKEN"], 0, 8);
  expect(small.hits).toEqual(whole.hits);
  expect(small.hits.map((h) => h.line)).toEqual(lines);
  expect(small.result).toEqual(whole.result);
  // A buffer of 25 puts the first boundary inside the second line's needle.
  const mid = collect(path, ["TOKEN"], 0, 25);
  expect(mid.hits).toEqual(whole.hits);
});

test("scanLines never delivers an unterminated final fragment and stops parsedThrough before it", () => {
  const content = "a TOKEN 1\nb TOKEN 2\nc TOKEN torn";
  const path = writeTemp(content);
  const { hits, result } = collect(path, ["TOKEN"], 0, 6);
  expect(hits.map((h) => h.line)).toEqual(["a TOKEN 1", "b TOKEN 2"]);
  expect(result.parsedThrough).toBe(20);
  expect(result.bytesRead).toBe(Buffer.byteLength(content));
  expect(result.tailProbeHex).toBe(hexOfTail(content, 20));
});

test("scanLines strips a CRLF terminator from the line and counts both bytes in byteEnd", () => {
  const content = "TOKEN one\r\nplain\r\nTOKEN two\r\n";
  const path = writeTemp(content);
  const { hits, result } = collect(path, ["TOKEN"]);
  expect(hits).toEqual([
    { line: "TOKEN one", byteStart: 0, byteEnd: 11 },
    { line: "TOKEN two", byteStart: 18, byteEnd: 29 },
  ]);
  expect(result.parsedThrough).toBe(29);
});

test("scanLines resumed from a byte offset reproduces the tail of a whole scan", () => {
  const lines = Array.from({ length: 40 }, (_, i) => (i % 3 === 0 ? `TOKEN ${i}` : `plain ${i}`));
  const content = `${lines.join("\n")}\n`;
  const path = writeTemp(content);
  const whole = collect(path, ["TOKEN"], 0, 16);
  // Resume from the end of the 10th line: exactly the hits at or after it.
  const fromByte = whole.hits[3]!.byteStart;
  const tail = collect(path, ["TOKEN"], fromByte, 16);
  expect(tail.hits).toEqual(whole.hits.filter((h) => h.byteStart >= fromByte));
  expect(tail.result.parsedThrough).toBe(whole.result.parsedThrough);
  expect(tail.result.tailProbeHex).toBe(whole.result.tailProbeHex);
  // The seed read for the probe is honest: bytes after fromByte plus the probe bytes.
  expect(tail.result.bytesRead).toBe(Buffer.byteLength(content) - fromByte + TAIL_PROBE_BYTES);
});

test("scanLines resumed where nothing new follows reports the probe of the bytes before fromByte", () => {
  const content = "TOKEN a\nTOKEN b\n";
  const path = writeTemp(content);
  const { hits, result } = collect(path, ["TOKEN"], Buffer.byteLength(content));
  expect(hits).toEqual([]);
  expect(result.parsedThrough).toBe(Buffer.byteLength(content));
  expect(result.tailProbeHex).toBe(hexOfTail(content, Buffer.byteLength(content)));
});

test("scanLines decodes multi-byte UTF-8 in a matched line and keeps byte offsets exact", () => {
  const first = "plain \u00e9\u00e8 \u{1F600}\n";
  const matched = '{"type":"assistant","text":"caf\u00e9 \u{1F680} \u4e2d\u6587"}\n';
  const content = `${first}${matched}TOKEN plain\n`;
  const path = writeTemp(content);
  // A tiny buffer so multi-byte sequences straddle chunk boundaries too.
  const { hits } = collect(path, ['"type":"assistant"'], 0, 5);
  expect(hits).toEqual([{
    line: matched.slice(0, -1),
    byteStart: Buffer.byteLength(first),
    byteEnd: Buffer.byteLength(first) + Buffer.byteLength(matched),
  }]);
});

test("scanLines delivers a needle found inside another line's content (the parser must reject it)", () => {
  // JSON escapes quotes inside strings, so the false positive is a NESTED
  // object carrying the same key and value, not quoted text.
  const nested = '{"type":"user","message":{"content":[{"type":"assistant","text":"x"}]}}';
  const path = writeTemp(`${nested}\n{"type":"assistant"}\n`);
  const { hits } = collect(path, ['"type":"assistant"']);
  expect(hits.map((h) => h.line)).toEqual([nested, '{"type":"assistant"}']);
});

test("scanLines delivers a line once when several needles hit it, in line order", () => {
  const content = "B only\nA and B\nA only\nneither\n";
  const path = writeTemp(content);
  const { hits } = collect(path, ["A", "B"]);
  expect(hits.map((h) => h.line)).toEqual(["B only", "A and B", "A only"]);
});

test("scanLines probe covers the whole file when it is shorter than the probe, and is empty at 0", () => {
  const short = "TOKEN\n";
  const { result: shortResult } = collect(writeTemp(short), ["TOKEN"]);
  expect(shortResult.tailProbeHex).toBe(Buffer.from(short).toString("hex"));
  expect(shortResult.tailProbeHex.length).toBe(short.length * 2);

  const { hits, result: emptyResult } = collect(writeTemp(""), ["TOKEN"]);
  expect(hits).toEqual([]);
  expect(emptyResult).toEqual({ bytesRead: 0, parsedThrough: 0, tailProbeHex: "" });

  // An unterminated only line: nothing complete, so parsedThrough stays 0.
  const { result: tornResult } = collect(writeTemp("TOKEN torn"), ["TOKEN"]);
  expect(tornResult).toEqual({ bytesRead: 10, parsedThrough: 0, tailProbeHex: "" });
});

test("scanLines carries the probe across a final chunk with fewer than TAIL_PROBE_BYTES of complete lines", () => {
  // A 60-byte line and a 64-byte buffer: the first read completes only that
  // line (probe = its last 32 bytes), the second completes the 6-byte line, so
  // the final probe must splice the two consumptions together.
  const content = `${"x".repeat(53)} TOKEN\nTOKEN\n`;
  const path = writeTemp(content);
  const { result } = collect(path, ["TOKEN"], 0, 64);
  expect(result.bytesRead).toBe(66);
  expect(result.tailProbeHex).toBe(hexOfTail(content, 66));
  expect(result.tailProbeHex.length).toBe(TAIL_PROBE_BYTES * 2);
});

test("scanLines resumed through a source that returns short reads still seeds the whole probe", () => {
  const content = `${"y".repeat(40)}\nTOKEN tail\n`;
  const bytes = Buffer.from(content);
  const fromByte = 41;
  // One byte per read: the probe seed and the body both have to loop.
  const hits: ScanHit[] = [];
  const result = scanBytesOneAtATime(bytes, fromByte, ["TOKEN"], (h) => hits.push(h));
  expect(hits.map((h) => h.line)).toEqual(["TOKEN tail"]);
  expect(result.tailProbeHex).toBe(hexOfTail(content, bytes.length));
  expect(result.bytesRead).toBe(bytes.length - fromByte + TAIL_PROBE_BYTES);
});

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

test("scanLines parks the shared buffer again after a throwing callback", () => {
  const path = writeTemp("TOKEN a\nTOKEN b\n");
  collect(path, ["TOKEN"]);
  expect(hasIdleScanBuffer()).toBe(true);
  expect(() =>
    scanLines(path, 0, ["TOKEN"], () => {
      expect(hasIdleScanBuffer()).toBe(false); // held by this scan
      throw new Error("boom");
    })
  ).toThrow("boom");
  expect(hasIdleScanBuffer()).toBe(true);
  const { hits } = collect(path, ["TOKEN"]);
  expect(hits.map((h) => h.line)).toEqual(["TOKEN a", "TOKEN b"]);
});

test("scanLines keeps a leading byte order mark in the delivered line", () => {
  const bom = "\ufeff";
  const content = `${bom}{"type":"assistant","n":1}\n{"type":"assistant","n":2}\n`;
  const path = writeTemp(content);
  const { hits } = collect(path, ['"type":"assistant"']);
  expect(hits.map((h) => h.line)).toEqual([
    `${bom}{"type":"assistant","n":1}`,
    '{"type":"assistant","n":2}',
  ]);
  // The BOM is the scanner's to deliver and the parser's to reject.
  expect(() => JSON.parse(hits[0]!.line)).toThrow();
  expect(hits[0]!.byteEnd).toBe(3 + 27);
});

test("scanLines rejects needles that cannot be searched byte-exactly", () => {
  const path = writeTemp("TOKEN\n");
  for (const needle of ["", "a\nb", "caf\u00e9"]) {
    expect(() => collect(path, [needle])).toThrow(/scan needle/);
  }
  expect(() => collect(path, ["TOKEN"], 0, 0)).toThrow(/buffer size/);
});

test("scanLines cuts on LF only: Unicode separators and a lone CR stay inside their line", () => {
  // node:readline (Deno's polyfill) split on U+2028/U+2029/NEL too, silently
  // dropping every JSONL line whose content carried one; JSON leaves those
  // characters unescaped, so they occur in real transcripts.
  const separators = [0x2028, 0x2029, 0x85, 0x0d].map((code) => String.fromCharCode(code));
  const line = `{"type":"assistant","text":"a${separators.join("b")}c"}`;
  const content = `${line}\nTOKEN\n`;
  const path = writeTemp(content);
  const { hits, result } = collect(path, ['"type":"assistant"'], 0, 7);
  expect(hits).toEqual([{ line, byteStart: 0, byteEnd: Buffer.byteLength(line) + 1 }]);
  expect(result.parsedThrough).toBe(Buffer.byteLength(content));
});

test("scanLines propagates filesystem errors: missing file, directory, failing source", () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-scan-"));
  expect(() => collect(join(dir, "missing.jsonl"), ["TOKEN"])).toThrow(/ENOENT/);
  expect(() => collect(dir, ["TOKEN"])).toThrow(/EISDIR|EBADF|EPERM/);
  // A read that fails mid-scan surfaces as-is and parks the shared buffer again.
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
  expect(hasIdleScanBuffer()).toBe(true);
});
