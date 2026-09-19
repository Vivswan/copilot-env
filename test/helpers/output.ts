// consola writes through process.stdout/stderr.write, while deno's console.log/error write to
// the runtime's own streams, so a capture must patch both layers.
import { consola } from "consola";
import { deferWriteReports, flushWriteReports } from "../../src/utils/report_write.ts";

interface CapturedOutput {
  stdout: string;
  stderr: string;
  /** Both channels interleaved in write order. */
  all: string;
}

interface CaptureOptions {
  /** Hold the seam's write reports (src/utils/report_write.ts) for the span and append them to
   *  stderr at the end, one per line: they bypass process.stderr, so a capture that wants them
   *  in the narration must ask. */
  writeReports?: boolean;
}

/** The consola level is raised for the span: under the test runner it self-silences warnings. */
function patchChannels(opts: CaptureOptions): () => CapturedOutput {
  const out: string[] = [];
  const err: string[] = [];
  const all: string[] = [];
  const savedLevel = consola.level;
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const origLog = console.log;
  const origError = console.error;
  const writer = (channel: string[]) => (chunk: string | Uint8Array): boolean => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    channel.push(text);
    all.push(text);
    return true;
  };
  const logger = (channel: string[]) => (...args: unknown[]): void => {
    writer(channel)(
      `${args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" ")}\n`,
    );
  };
  process.stdout.write = writer(out);
  process.stderr.write = writer(err);
  console.log = logger(out);
  console.error = logger(err);
  consola.level = 3;
  if (opts.writeReports) deferWriteReports();
  return () => {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    console.log = origLog;
    console.error = origError;
    consola.level = savedLevel;
    if (opts.writeReports) writer(err)(flushWriteReports().map((line) => `${line}\n`).join(""));
    return { stdout: out.join(""), stderr: err.join(""), all: all.join("") };
  };
}

export async function captureChannels(
  body: () => void | Promise<void>,
  opts: CaptureOptions = {},
): Promise<CapturedOutput> {
  const restore = patchChannels(opts);
  let captured: CapturedOutput;
  try {
    await body();
  } finally {
    captured = restore();
  }
  return captured;
}

/** For a body that must run synchronously (inside an `expect` argument, say). */
export function captureChannelsSync(body: () => void, opts: CaptureOptions = {}): CapturedOutput {
  const restore = patchChannels(opts);
  let captured: CapturedOutput;
  try {
    body();
  } finally {
    captured = restore();
  }
  return captured;
}

export async function captureAllWrites(
  body: () => void | Promise<void>,
  opts: CaptureOptions = {},
): Promise<string> {
  return (await captureChannels(body, opts)).all;
}
