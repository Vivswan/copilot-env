// A request an agent sends THROUGH the local proxy is recorded twice: the daemon writes a
// token_usage_events row, and the agent writes its own session line. Neither side logs an id the
// other has (the proxy's trace_id and session_id are its own, and Anthropic's message.id never
// reaches the DB), so the two records are paired by content: the same canonical model, the same
// four token counts, and the daemon's clock within OVERLAP_WINDOW_MS of the client's lines. The
// client's record is the richer one (cache buckets, session attribution), so the proxy's row is the
// one dropped. The client side is what the session folds counted, reported by the folds themselves,
// so a run with and without the usage index pairs the same requests.

import type { CountedUsage, OnCounted, TokenBuckets, UsageRequest } from "./usage.ts";

/** Both sides stamp a request when its response completes, on the same machine, so the two clocks
 *  sit seconds apart; the minute absorbs a stalled write on either side. The token counts do the
 *  discriminating: two requests with identical counts in all four buckets within a minute of each
 *  other are not seen in practice. */
export const OVERLAP_WINDOW_MS = 60_000;

/** The client's clock over the lines that make up one request: a Codex token_count is one line, a
 *  Claude message streams over several, first to last, a final line that only repeats the counts
 *  included. */
interface Span {
  firstMs: number;
  lastMs: number;
}

/** One request as a client logged it. `span` is null while none of its lines carried a clock. */
export interface ClientRequest {
  model: string;
  buckets: TokenBuckets;
  span: Span | null;
}

/** Gathers the folds' counted increments into requests. An id groups the increments of one
 *  message; an id-less increment is a whole request. */
export class ClientRequests {
  readonly #requests: ClientRequest[] = [];
  readonly #byId = new Map<string, ClientRequest>();

  readonly onCounted: OnCounted = (usage: CountedUsage): void => {
    const request = usage.id === null ? undefined : this.#byId.get(usage.id);
    if (request === undefined) {
      const fresh: ClientRequest = {
        model: usage.model,
        buckets: { ...usage.buckets },
        span: usage.tsMs === null ? null : { firstMs: usage.tsMs, lastMs: usage.tsMs },
      };
      this.#requests.push(fresh);
      if (usage.id !== null) this.#byId.set(usage.id, fresh);
      return;
    }
    request.buckets.input += usage.buckets.input;
    request.buckets.output += usage.buckets.output;
    request.buckets.cacheRead += usage.buckets.cacheRead;
    request.buckets.cacheCreation += usage.buckets.cacheCreation;
    if (usage.tsMs !== null) {
      request.span = request.span === null ? { firstMs: usage.tsMs, lastMs: usage.tsMs } : {
        firstMs: Math.min(request.span.firstMs, usage.tsMs),
        lastMs: Math.max(request.span.lastMs, usage.tsMs),
      };
    }
  };

  all(): readonly ClientRequest[] {
    return this.#requests;
  }
}

function requestKey(model: string, b: TokenBuckets): string {
  return `${model}\n${b.input}\n${b.output}\n${b.cacheRead}\n${b.cacheCreation}`;
}

/** Splits the proxy's requests into those no client logged (`kept`, in the order given) and the
 *  count a client logged too (`paired`). Each client record pairs with at most one proxy row: a
 *  request the daemon saw once was sent once. Rows are placed oldest first, each against the
 *  candidate span that ends soonest, so the pairing is the largest possible whatever order the
 *  files or rows arrived in. A record without a clock on either side cannot be placed. */
export function dropRequestsLoggedByClients(
  proxy: readonly UsageRequest[],
  clients: readonly ClientRequest[],
): { kept: UsageRequest[]; paired: number } {
  const unpaired = new Map<string, Span[]>();
  for (const client of clients) {
    if (client.span === null) continue;
    const key = requestKey(client.model, client.buckets);
    const spans = unpaired.get(key);
    if (spans === undefined) unpaired.set(key, [client.span]);
    else spans.push(client.span);
  }
  for (const spans of unpaired.values()) spans.sort((a, b) => a.lastMs - b.lastMs);

  const dated = proxy.flatMap((request, index) =>
    request.tsMs === null ? [] : [{ index, tsMs: request.tsMs, request }]
  );
  dated.sort((a, b) => a.tsMs - b.tsMs);
  const pairedIndexes = new Set<number>();
  for (const { index, tsMs, request } of dated) {
    const spans = unpaired.get(requestKey(request.model, request.buckets));
    const at = spans?.findIndex((s) =>
      s.firstMs - OVERLAP_WINDOW_MS <= tsMs && tsMs <= s.lastMs + OVERLAP_WINDOW_MS
    ) ?? -1;
    if (at >= 0) {
      spans?.splice(at, 1);
      pairedIndexes.add(index);
    }
  }
  return {
    kept: proxy.filter((_, index) => !pairedIndexes.has(index)),
    paired: pairedIndexes.size,
  };
}
