// The two public price sources `agent cost` prices at, loaded together. A source read today
// (fetched, or served from today's earlier read) prices the run; one that could not be fetched
// prices nothing, whatever an earlier run kept on disk. No price is ever built in.

import type { ProbeFetch } from "../copilot_api/integration_identity.ts";
import { errMessage } from "../utils/error.ts";
import { loadGitHubRateCard, type RateCardSource } from "./github_rate_card.ts";
import { loadPricing, type PricingTier, withGitHubRates } from "./pricing.ts";

type SourceRead =
  | {
      read: true;
      /** Set when today's fetched copy could not be kept for the day: the next run fetches again. */
      cacheWriteError?: string;
    }
  | { read: false; problem: string };

export interface PriceSources {
  /** What the run prices at: GitHub's card over OpenRouter's list when both were read, either one
   *  alone, or an empty map (tokens only). */
  pricing: Map<string, PricingTier>;
  /** The card `pricing` carries GitHub's rates from; absent when the card was not read. */
  rateCard: RateCardSource | undefined;
  openRouter: SourceRead;
  gitHub: SourceRead;
}

/** Both fetches run side by side: each has its own timeout, and neither needs the other. */
export async function loadPriceSources(
  urls: { pricingUrl: string; rateCardUrl: string },
  fetchImpl: ProbeFetch | undefined,
): Promise<PriceSources> {
  const [list, card] = await Promise.all([
    loadPricing(urls.pricingUrl, { fetchImpl }).then(
      (loaded) => ({ kind: "list" as const, ...loaded }),
      (e: unknown) => ({ kind: "none" as const, problem: errMessage(e) }),
    ),
    loadGitHubRateCard(urls.rateCardUrl, { fetchImpl }),
  ]);
  const listed = list.kind === "list" ? list.pricing : new Map<string, PricingTier>();
  return {
    pricing: card.kind === "card" ? withGitHubRates(listed, card.card, card.from) : listed,
    rateCard: card.kind === "card" ? card.from : undefined,
    openRouter:
      list.kind === "list"
        ? { read: true, ...(list.source === "fetched" ? kept(list.cacheWriteError) : {}) }
        : { read: false, problem: list.problem },
    gitHub:
      card.kind === "card"
        ? { read: true, ...kept(card.cacheWriteError) }
        : { read: false, problem: card.problem },
  };
}

function kept(cacheWriteError: string | undefined): { cacheWriteError?: string } {
  return cacheWriteError === undefined ? {} : { cacheWriteError };
}
