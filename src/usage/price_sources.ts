// The two public price sources `agent cost` prices at, loaded together. A source read today
// (fetched, or served from a copy under 24 hours old) prices the run; when today's fetch fails,
// the last cached copy of that source prices the run instead, whatever its age, and a source with
// nothing cached prices nothing. No price is ever built in.

import type { ProbeFetch } from "../copilot_api/integration_identity.ts";
import { errMessage } from "../utils/error.ts";
import {
  type LoadedRateCard,
  loadGitHubRateCard,
  type RateCardSource,
} from "./github_rate_card.ts";
import { type LoadedPricing, loadPricing, type PricingTier, withGitHubRates } from "./pricing.ts";

export type SourceRead =
  | {
      /** Fetched today, or served from a copy under 24 hours old. */
      kind: "read";

      /** Set when today's fetched copy could not be kept for the day: the next run fetches again. */
      cacheWriteError?: string;
    }
  /** Today's fetch failed; the copy fetched at `fetchedAtMs` prices the run. */
  | { kind: "cached"; fetchedAtMs: number; problem: string }
  | { kind: "none"; problem: string };

export interface PriceSources {
  /** GitHub's card over OpenRouter's list when both price, either alone, or empty (tokens only). */
  pricing: Map<string, PricingTier>;

  /** The card `pricing` carries GitHub's rates from; absent when no card prices the run. */
  rateCard: RateCardSource | undefined;

  /** The list's read; `none` leaves every model to the card, or unpriced. */
  openRouter: SourceRead;

  /** The card's read; `none` prices from the list alone. */
  gitHub: SourceRead;
}

/** The list load with its failure folded in, so the two sources settle side by side. */
type LoadedList = ({ kind: "list" } & LoadedPricing) | { kind: "none"; problem: string };

function kept(cacheWriteError: string | undefined): { cacheWriteError?: string } {
  return cacheWriteError === undefined ? {} : { cacheWriteError };
}

function openRouterRead(list: LoadedList): SourceRead {
  if (list.kind === "none") {
    return { kind: "none", problem: list.problem };
  }
  if (list.source === "stale-cache") {
    return { kind: "cached", fetchedAtMs: list.fetchedAtMs, problem: list.fetchError };
  }
  if (list.source === "fetched") {
    return { kind: "read", ...kept(list.cacheWriteError) };
  }
  return { kind: "read" };
}

function gitHubRead(card: LoadedRateCard): SourceRead {
  if (card.kind === "none") {
    return { kind: "none", problem: card.problem };
  }
  if (card.problem !== undefined) {
    return { kind: "cached", fetchedAtMs: card.from.fetchedAtMs, problem: card.problem };
  }
  return { kind: "read", ...kept(card.cacheWriteError) };
}

/** Both fetches run side by side: each has its own timeout, and neither needs the other. */
export async function loadPriceSources(
  urls: { pricingUrl: string; rateCardUrl: string },
  fetchImpl: ProbeFetch | undefined,
): Promise<PriceSources> {
  const [list, card] = await Promise.all([
    loadPricing(urls.pricingUrl, { fetchImpl }).then(
      (loaded): LoadedList => ({ kind: "list", ...loaded }),
      (e: unknown): LoadedList => ({ kind: "none", problem: errMessage(e) }),
    ),
    loadGitHubRateCard(urls.rateCardUrl, { fetchImpl }),
  ]);
  const listed = list.kind === "list" ? list.pricing : new Map<string, PricingTier>();
  return {
    pricing: card.kind === "card" ? withGitHubRates(listed, card.card, card.from) : listed,
    rateCard: card.kind === "card" ? card.from : undefined,
    openRouter: openRouterRead(list),
    gitHub: gitHubRead(card),
  };
}
