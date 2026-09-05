// Capture everything a body writes to stdout and stderr: consola routes through
// process.stdout/stderr.write, while deno's console.log/error write to the
// runtime's own streams, so both layers are intercepted. Plain functions only
// (this is not a test file).
import { consola } from "consola";

export interface CapturedOutput {
  stdout: string;
  stderr: string;
  /** Both channels interleaved in write order. */
  all: string;
}

/** Run `body` with stdout and stderr captured per channel; the consola level is
 *  raised so warnings are not self-silenced under the test runner. */
export async function captureChannels(body: () => Promise<void>): Promise<CapturedOutput> {
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
  try {
    consola.level = 3;
    await body();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    console.log = origLog;
    console.error = origError;
    consola.level = savedLevel;
  }
  return { stdout: out.join(""), stderr: err.join(""), all: all.join("") };
}

/** Both channels of `body`'s output as one string, in write order. */
export async function captureAllWrites(body: () => Promise<void>): Promise<string> {
  return (await captureChannels(body)).all;
}
