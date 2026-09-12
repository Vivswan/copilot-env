// launchDaemon runs the proxy with `--verbose`, whose handler loggers dump every payload under
// <home>/logs (gigabytes a week). Loaded when the `proxy-logs` key is false
// (src/copilot_api/launch.ts decides), this swaps a discard sink into `fs.createWriteStream` for
// that directory so the files are never created.
//
// Discarding is safe because nothing reads these logs: the idle watchdog and `agent health` take
// activity from the in-daemon observer (daemon_runtime_preload.ts). Relies on copilot-api's
// lib/logger.ts opening its streams through `fs.createWriteStream` under `<APP_DIR>/logs`, with
// APP_DIR computed as CopilotApiPaths does.
import fs from "node:fs";
import { resolve, sep } from "node:path";
import { Writable } from "node:stream";
import { CopilotApiPaths } from "../copilot_api/paths.ts";

/** Case-normalize for the path-prefix check (Windows paths are case-insensitive). */
function normalizeCase(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

const LOGS_PREFIX = normalizeCase(resolve(new CopilotApiPaths().logsDir) + sep);

/** Buffer/URL/fd targets pass through: the proxy's logger only ever hands over path strings. */
function isUnderLogsDir(target: unknown): boolean {
  return typeof target === "string" && normalizeCase(resolve(target)).startsWith(LOGS_PREFIX);
}

const realCreateWriteStream = fs.createWriteStream;

/** A Writable rather than the OS null device: deno cannot open node's Windows `devNull` path, and
 *  the proxy's logger touches only the Writable surface (write/end/destroyed/on("error")). */
function muteSink(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

const mutedCreateWriteStream = (
  ...args: Parameters<typeof fs.createWriteStream>
): fs.WriteStream | Writable => {
  const [path] = args;
  return isUnderLogsDir(path) ? muteSink() : realCreateWriteStream(...args);
};
fs.createWriteStream = mutedCreateWriteStream as typeof fs.createWriteStream;
