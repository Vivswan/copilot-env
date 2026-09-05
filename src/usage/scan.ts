// Cut the needle-bearing lines out of a large JSONL log, with byte offsets. Each
// chunk is searched as latin1 (one byte per code unit, so a string index IS a
// byte offset); only matched lines are decoded as UTF-8.

import { closeSync, openSync, readSync } from "node:fs";
import { type ScanHit, type ScanResult, TAIL_PROBE_BYTES } from "./contribution.ts";

/** Chunk size for the shared read buffer. Single rollouts of several hundred
 *  MB exist, so a file is never read into one string. */
const DEFAULT_SCAN_BUFFER_BYTES = 64 * 1024 * 1024;

const CR = 0x0d;

// WHATWG "latin1" is windows-1252, which still maps every byte to one BMP code
// point; that one-to-one property is all the search needs.
const SEARCH_DECODER = new TextDecoder("latin1");
// Byte-faithful: a line that starts with a BOM keeps it (and fails JSON.parse,
// as it always did); the default decoder would silently eat it.
const LINE_DECODER = new TextDecoder("utf-8", { ignoreBOM: true });

export interface ScanOptions {
  /** Read chunk size; the default is DEFAULT_SCAN_BUFFER_BYTES. A line longer
   *  than the buffer grows it, so this is a floor, not a limit. Smaller values
   *  exist for tests that drive the chunk-boundary paths. */
  bufferBytes?: number;
}

/** Fill `target` from `position` of the source; return the bytes copied (a
 *  short read is fine), 0 at the end. Files and in-memory buffers (a
 *  decompressed archive) both fit. */
export type ReadAt = (target: Uint8Array, position: number) => number;

/** `ScanLines` over a file on disk (delivery rules: the contract). Filesystem
 *  errors propagate; the readers turn them into their `could not read` warning. */
export function scanLines(
  path: string,
  fromByte: number,
  needles: readonly string[],
  onLine: (hit: ScanHit) => void,
  options: ScanOptions = {},
): ScanResult {
  const fd = openSync(path, "r");
  try {
    return scanSource(
      (target, position) => readSync(fd, target, 0, target.length, position),
      fromByte,
      needles,
      onLine,
      options,
    );
  } finally {
    closeSync(fd);
  }
}

/** The same delivery rules over bytes already in memory (a decompressed
 *  `.jsonl.zst`), chunked like a file so a large archive never becomes one
 *  string. Offsets are relative to `bytes`. */
export function scanBytes(
  bytes: Uint8Array,
  needles: readonly string[],
  onLine: (hit: ScanHit) => void,
  options: ScanOptions = {},
): ScanResult {
  const readAt: ReadAt = (target, position) => {
    const n = Math.min(target.length, Math.max(0, bytes.length - position));
    target.set(bytes.subarray(position, position + n));
    return n;
  };
  return scanSource(readAt, 0, needles, onLine, options);
}

// ---------- internals ----------

// One 64 MiB buffer reused across scans (per-file allocation would dominate a
// run). The slot is empty while a scan holds it, so a nested scan gets its own.
let idleBuffer: Buffer | undefined;

function takeBuffer(bufferBytes: number | undefined): Buffer {
  if (bufferBytes !== undefined) {
    if (!(Number.isInteger(bufferBytes) && bufferBytes > 0)) {
      throw new Error(`scan buffer size must be a positive integer, got ${bufferBytes}`);
    }
    return Buffer.allocUnsafe(bufferBytes);
  }
  const taken = idleBuffer ?? Buffer.allocUnsafe(DEFAULT_SCAN_BUFFER_BYTES);
  idleBuffer = undefined;
  return taken;
}

/** Only a default-sized buffer (possibly grown) goes back to the slot; a
 *  test-sized one is dropped. */
function releaseBuffer(buffer: Buffer, bufferBytes: number | undefined): void {
  if (bufferBytes === undefined) {
    idleBuffer = buffer;
  }
}

/** A needle must match the same bytes in the latin1 search string and in the
 *  UTF-8 text (ASCII only), and lie within one line (no LF). */
function checkNeedles(needles: readonly string[]): void {
  for (const needle of needles) {
    let ascii = needle !== "";
    for (let i = 0; i < needle.length && ascii; i++) {
      const code = needle.charCodeAt(i);
      ascii = code < 0x80 && code !== 0x0a;
    }
    if (!ascii) {
      throw new Error(
        `scan needle must be non-empty ASCII without a line feed: ${JSON.stringify(needle)}`,
      );
    }
  }
}

/** The scan over any `ReadAt` source; `scanLines` and `scanBytes` are its two
 *  sources, and tests drive it with sources that read short. */
export function scanSource(
  readAt: ReadAt,
  fromByte: number,
  needles: readonly string[],
  onLine: (hit: ScanHit) => void,
  options: ScanOptions,
): ScanResult {
  checkNeedles(needles);
  let bytesRead = 0;
  // The bytes just before `parsedThrough`. A resume starts with the bytes before
  // `fromByte`, which only the source has.
  let probe: Uint8Array = new Uint8Array(0);
  if (fromByte > 0) {
    const want = Math.min(TAIL_PROBE_BYTES, fromByte);
    const seed = new Uint8Array(want);
    let got = 0;
    for (;;) {
      const n = readAt(seed.subarray(got), fromByte - want + got);
      if (n === 0) {
        break;
      }
      got += n;
      if (got === want) {
        break;
      }
    }
    bytesRead += got;
    probe = seed.subarray(0, got);
  }
  let buffer = takeBuffer(options.bufferBytes);
  let base = fromByte; // file offset of buffer[0]
  let filled = 0;
  try {
    for (;;) {
      if (filled === buffer.length) {
        // One line longer than the whole buffer: grow, keeping the partial line.
        const grown = Buffer.allocUnsafe(buffer.length * 2);
        grown.set(buffer.subarray(0, filled));
        buffer = grown;
      }
      const n = readAt(buffer.subarray(filled), base + filled);
      if (n === 0) {
        break;
      }
      bytesRead += n;
      filled += n;
      const completeEnd = cutLines(buffer.subarray(0, filled), base, needles, onLine);
      if (completeEnd === 0) {
        continue;
      }
      probe = tailOf(probe, buffer.subarray(0, completeEnd));
      buffer.copyWithin(0, completeEnd, filled);
      base += completeEnd;
      filled -= completeEnd;
    }
  } finally {
    releaseBuffer(buffer, options.bufferBytes);
  }
  return {
    bytesRead,
    parsedThrough: base,
    tailProbeHex: Buffer.from(probe).toString("hex"),
  };
}

/** The last TAIL_PROBE_BYTES of `previous ++ consumed`, copied out of the
 *  read buffer (which is about to be overwritten). */
function tailOf(previous: Uint8Array, consumed: Uint8Array): Uint8Array {
  if (consumed.length >= TAIL_PROBE_BYTES) {
    return Uint8Array.from(consumed.subarray(consumed.length - TAIL_PROBE_BYTES));
  }
  const joined = new Uint8Array(previous.length + consumed.length);
  joined.set(previous);
  joined.set(consumed, previous.length);
  return joined.subarray(Math.max(0, joined.length - TAIL_PROBE_BYTES));
}

/** Deliver each complete needle-bearing line of `bytes` (file offset `base`)
 *  once, in line order; return the index past the last LF (0 if none). */
function cutLines(
  bytes: Uint8Array,
  base: number,
  needles: readonly string[],
  onLine: (hit: ScanHit) => void,
): number {
  const text = SEARCH_DECODER.decode(bytes);
  const lastLf = text.lastIndexOf("\n");
  if (lastLf === -1) {
    return 0;
  }
  const completeEnd = lastLf + 1;
  // [lineStart, lfIndex] per hit. A needle holds no LF, so a match starting
  // before `completeEnd` lies wholly inside a complete line and its LF exists.
  const hits: [number, number][] = [];
  for (const needle of needles) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(needle, from);
      if (at === -1 || at >= completeEnd) {
        break;
      }
      const lineStart = text.lastIndexOf("\n", at) + 1;
      const lf = text.indexOf("\n", at);
      hits.push([lineStart, lf]);
      from = lf + 1;
    }
  }
  if (needles.length > 1) {
    hits.sort((a, b) => a[0] - b[0]);
  }
  let previousStart = -1;
  for (const [lineStart, lf] of hits) {
    if (lineStart === previousStart) {
      continue; // a second needle in the same line
    }
    previousStart = lineStart;
    const contentEnd = lf > lineStart && bytes[lf - 1] === CR ? lf - 1 : lf;
    onLine({
      line: LINE_DECODER.decode(bytes.subarray(lineStart, contentEnd)),
      byteStart: base + lineStart,
      byteEnd: base + lf + 1,
    });
  }
  return completeEnd;
}
