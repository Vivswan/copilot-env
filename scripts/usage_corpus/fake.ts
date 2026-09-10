// The fake inference backend's side of a run: the minute straddle its beforeReply hook runs,
// and the request trace it reports, checked against what the scripted turns must have made.
import { log, sleep } from "./cli.ts";
import { registry } from "./children.ts";
import type { Source } from "./transcripts.ts";

/** The second-of-minute the boundary turns start at; the fake holds their replies past :00. */
const BOUNDARY_START_SECOND = 55;
const MINUTE_POLL_MS = 200;
/** Inference requests the scripted turns make per CLI: 4 plain turns + a tool turn's 2. */
const EXPECTED_REQUESTS_PER_CLI = 6;

/** `arm()` waits until just before :00; while that minute is current, `hold()` (the fake's
 *  beforeReply hook) keeps every reply back until the minute changes, so a turn started before
 *  :00 logs its reply after it. Shared by both CLIs, so one wait serves both. */
export class MinuteStraddle {
  private armedMinute: number | null = null;

  /** Wait until just before :00, giving up as soon as the run is stopping. */
  async arm(): Promise<void> {
    if (registry.stopping) return;
    const second = new Date().getSeconds();
    const waitSeconds = second >= BOUNDARY_START_SECOND ? 0 : BOUNDARY_START_SECOND - second;
    if (waitSeconds > 0 && this.armedMinute === null) {
      log(`waiting ${waitSeconds}s so the next turns straddle a minute boundary`);
    }
    const until = Date.now() + waitSeconds * 1000;
    while (Date.now() < until && !registry.stopping) await sleep(MINUTE_POLL_MS);
    if (!registry.stopping) this.armedMinute = new Date().getMinutes();
  }

  async hold(): Promise<void> {
    const armed = this.armedMinute;
    if (armed === null) return;
    while (new Date().getMinutes() === armed) await sleep(MINUTE_POLL_MS);
    this.armedMinute = null;
  }
}

export interface TracedRequest {
  path: string;
  tool: string | null;
  usage: { input: number; cacheRead: number; cacheCreation: number; output: number };
}

/** The fake's token buckets summed per source, in the readers' own bucket shapes, so `agent cost`
 *  over the recorded home can be checked against what was actually served. */
export function fakeUsageBySource(trace: TracedRequest[]): Record<Source, Record<string, number>> {
  const sum = (path: string, pick: (u: TracedRequest["usage"]) => Record<string, number>) => {
    const out: Record<string, number> = {};
    for (const request of trace.filter((r) => r.path === path)) {
      for (const [key, value] of Object.entries(pick(request.usage))) {
        out[key] = (out[key] ?? 0) + value;
      }
    }
    return out;
  };
  return {
    // Claude's input_tokens excludes both cache buckets.
    claude: sum("/messages", (u) => ({
      input: u.input,
      cacheRead: u.cacheRead,
      cacheCreation: u.cacheCreation,
      output: u.output,
    })),
    // OpenAI has no cache-write bucket: the creation share is plain input; cached is split out.
    codex: sum("/responses", (u) => ({
      input: u.input + u.cacheCreation,
      cacheRead: u.cacheRead,
      cacheCreation: 0,
      output: u.output,
    })),
  };
}

/** What the fake saw, per source, against what the scripted turns must have made. */
export function requestTraceFailures(trace: TracedRequest[]): string[] {
  const failures: string[] = [];
  const byPath = (path: string) => trace.filter((r) => r.path === path);
  const checks: [Source, string][] = [["claude", "/messages"], ["codex", "/responses"]];
  for (const [source, path] of checks) {
    const requests = byPath(path);
    if (requests.length !== EXPECTED_REQUESTS_PER_CLI) {
      failures.push(
        `${source}: the fake saw ${requests.length} inference requests, expected ${EXPECTED_REQUESTS_PER_CLI}`,
      );
    }
    const toolCalls = requests.filter((r) => r.tool !== null).length;
    if (toolCalls !== 1) {
      failures.push(`${source}: the fake emitted ${toolCalls} tool calls, expected 1`);
    }
  }
  const other = trace.filter((r) => r.path !== "/messages" && r.path !== "/responses");
  if (other.length > 0) failures.push(`the fake saw ${other.length} requests on other routes`);
  return failures;
}
