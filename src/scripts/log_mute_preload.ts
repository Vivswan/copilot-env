// Preloaded into the copilot-api daemon (via `--preload`) when the `proxy-logs` config
// key is false (`agent config --set proxy-logs false`). launchDaemon always starts the proxy
// with `--verbose`, so its handler loggers append full request/response payload dumps under
// <home>/logs -- gigabytes per week on a busy proxy. This shim intercepts
// `fs.createWriteStream` for paths inside that directory and swaps in a sink that discards
// every chunk, so the files are never created and the directory stays empty.
//
// Pure discard is safe because activity detection does not read these logs: the idle
// watchdog and `agent health` get their inference-activity signal from the in-daemon
// inference observer (daemon_runtime_preload.ts, always loaded), which watches inbound
// requests directly.
//
// This is a RUNTIME shim: it touches none of copilot-api's files, so it never pins the
// floated proxy version. It depends only on copilot-api opening its handler log streams via
// `fs.createWriteStream` under `<APP_DIR>/logs` (lib/logger.ts, long-stable) and computing
// APP_DIR the same way CopilotApiPaths does (COPILOT_API_HOME or the shared default). The
// load decision lives in the daemon launch pipeline (src/copilot_api/launch.ts); here
// we act unconditionally on load.
import fs from "node:fs";
import { resolve, sep } from "node:path";
import { Writable } from "node:stream";
import { CopilotApiPaths } from "../copilot_api/paths.ts";

/** Case-normalize for the path-prefix check (Windows paths are case-insensitive). */
function normalizeCase(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

const LOGS_PREFIX = normalizeCase(resolve(new CopilotApiPaths().logsDir) + sep);

/** Whether a createWriteStream target lands inside the proxy's handler-logs directory.
 *  Non-string targets (Buffer/URL/fd) pass through untouched -- the proxy's logger only
 *  ever hands over plain path strings. */
function isUnderLogsDir(target: unknown): boolean {
  return typeof target === "string" && normalizeCase(resolve(target)).startsWith(LOGS_PREFIX);
}

const realCreateWriteStream = fs.createWriteStream;

/** Discard sink: a stream that swallows every chunk. The proxy's logger touches only the
 *  Writable surface of its log streams (write/end/destroyed/on("error")), and a sink over the
 *  OS null device is not portable -- deno cannot open node's Windows `devNull` device path. */
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
