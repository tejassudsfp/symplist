"use client";

import type { SearchIndexStatus } from "@symplist/contracts";
import { useCallback, useEffect, useState } from "react";
import type { SearchApi } from "./api.ts";
import { searchFreshness, useSearchFreshnessSignal } from "./store.ts";

/*
 * Index freshness, reported honestly and separately from the results (note 14, §10.1). While the
 * shown page is behind the index, search asks `GET /v1/search/freshness` on a slow interval; the
 * `search.freshness` user-topic event feeds the same store when the app's socket is connected. A
 * newer generation never replaces what is on screen: it offers a refresh.
 */

/** How often freshness is polled while changes are still pending. */
export const FRESHNESS_POLL_MS = 15_000;

export interface FreshnessWatchInput {
  /** Polling runs only for an admitted viewer looking at results. */
  readonly active: boolean;
  readonly shownGeneration: number;
  readonly pending: number;
  readonly status: SearchIndexStatus;
  /**
   * A rebuild has been asked for and is still coming, so a new generation is expected even with no
   * pending change: the chat opt-in turned on before chat entered the index (`chat_indexing`).
   */
  readonly rebuildExpected?: boolean;
}

export interface FreshnessWatch {
  /** A newer published index exists, so the shown results may be out of date. */
  readonly newerAvailable: boolean;
  /** Hides the offer until the next generation (used when the refresh is under way). */
  readonly acknowledge: () => void;
}

export function useFreshnessWatch(api: SearchApi, input: FreshnessWatchInput): FreshnessWatch {
  const signal = useSearchFreshnessSignal();
  const [acknowledged, setAcknowledged] = useState(0);
  // Only what a later publication can actually change keeps the poll running. `partial` also covers
  // conditions no publication will ever clear — an account past the index size limit, a query with
  // more matches than one ranking pass keeps — so polling on the status alone would never stop.
  const behind =
    input.status === "rebuilding" || input.pending > 0 || input.rebuildExpected === true;
  const polling = input.active && behind;

  useEffect(() => {
    if (!polling) return;
    let stopped = false;
    const controller = new AbortController();
    const poll = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      api.freshness(controller.signal).then(
        (freshness) => {
          // The endpoint reports the DTO shape; the store speaks the `search.freshness` event (§7).
          if (!stopped) {
            searchFreshness.publish({
              generation: freshness.indexGeneration,
              pending: freshness.pendingIntents,
            });
          }
        },
        () => {
          // Freshness is a hint; a failed poll never disturbs the results on screen.
        },
      );
    };
    const timer = setInterval(poll, FRESHNESS_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
      controller.abort();
    };
  }, [api, polling]);

  const acknowledge = useCallback(() => {
    setAcknowledged(signal?.generation ?? 0);
  }, [signal?.generation]);

  const newerAvailable =
    input.active &&
    signal !== null &&
    signal.generation > input.shownGeneration &&
    signal.generation > acknowledged;

  return { newerAvailable, acknowledge };
}
