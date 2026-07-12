// Preloaded into the copilot-api daemon (via `bun --preload`) when the `proxy-logs` config
// key is false (`agent config --set proxy-logs false`). launchDaemon always starts the proxy
// with `--verbose`, so its handler loggers append full request/response payload dumps under
// <home>/logs -- gigabytes per week on a busy proxy. This shim intercepts
// `fs.createWriteStream` for paths inside that directory and swaps in a sink that DISCARDS
// the content but still touches the file's mtime on every flush.
//
// The mtime touch is load-bearing, not cosmetic: the idle watchdog (idle_watchdog.ts) and
// `agent health` read the INFERENCE handler logs' mtimes as the "last real model call"
// activity signal. Discarding writes without the touch would starve that signal and let the
// managed lifecycle auto-stop a proxy that is actively serving requests.
//
// This is a RUNTIME shim: it touches none of copilot-api's files, so it never pins the
// floated proxy version. It depends only on copilot-api opening its handler log streams via
// `fs.createWriteStream` under `<APP_DIR>/logs` (lib/logger.ts, long-stable) and computing
// APP_DIR the same way CopilotApiPaths does (COPILOT_API_HOME or the shared default). The
// load decision lives in start.ts; here we act unconditionally on load.
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

/** Best-effort: ensure the log file exists and bump its mtime (the activity signal). A
 *  persistent failure would starve the idle watchdog's inference signal, so it is worth one
 *  warning per file in the daemon log -- but never more (this runs on every flush). */
const warnedTouchFailures = new Set<string>();
function touchLogFile(path: string): void {
  try {
    fs.closeSync(fs.openSync(path, "a"));
    const now = new Date();
    fs.utimesSync(path, now, now);
  } catch (e) {
    // a failed touch only degrades the idle signal; never break the daemon over it
    if (!warnedTouchFailures.has(path)) {
      warnedTouchFailures.add(path);
      console.warn(`log mute: could not touch ${path} (the idle-activity signal degrades):`, e);
    }
  }
}

/** A Writable that discards every chunk, touching the log file instead of growing it. */
function muteSink(path: string): fs.WriteStream {
  const sink = new Writable({
    write(_chunk, _encoding, callback): void {
      touchLogFile(path);
      callback();
    },
  });
  // The proxy's logger only uses the surface Writable already provides (write/end/destroyed/
  // on("error")), so presenting the sink as a WriteStream is safe for its call sites.
  return sink as unknown as fs.WriteStream;
}

const realCreateWriteStream = fs.createWriteStream;
const mutedCreateWriteStream = (
  ...args: Parameters<typeof fs.createWriteStream>
): fs.WriteStream => {
  const [path] = args;
  return isUnderLogsDir(path) ? muteSink(String(path)) : realCreateWriteStream(...args);
};
fs.createWriteStream = mutedCreateWriteStream as typeof fs.createWriteStream;
