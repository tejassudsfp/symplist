import type { SearchIndexStatus, SearchNotice } from "@symplist/contracts";
import type { SearchFailure } from "./api.ts";

/*
 * What search says when it cannot show results, in plain language that never names Nest, D1, the
 * index or another account (system_states.md, §6.3). No matches and a failure are different things,
 * and freshness is explained separately from the results (note 14).
 */

export interface FailureMessage {
  readonly title: string;
  readonly description: string;
  /** A retry is worth offering. */
  readonly retryable: boolean;
}

export function failureMessage(failure: SearchFailure): FailureMessage {
  switch (failure.kind) {
    case "offline":
      return {
        title: "You're offline",
        description: "Search needs a connection. It works again as soon as you're back online.",
        retryable: true,
      };
    case "unavailable":
      return {
        title: "Search is temporarily unavailable",
        description:
          failure.retryAfterSeconds === undefined
            ? "Your work is safe. Try again in a moment."
            : `Your work is safe. Try again in about ${Math.max(1, Math.round(failure.retryAfterSeconds))} seconds.`,
        retryable: true,
      };
    case "signed_out":
      return {
        title: "Your session ended",
        description: "Sign in again to search your tasks.",
        retryable: false,
      };
    case "no_access":
      return {
        title: "Search isn't available for this account",
        description: "Your account doesn't have access to the workspace right now.",
        retryable: false,
      };
    case "cursor_stale":
      return {
        title: "These results changed",
        description: "Something you searched moved or was updated. Search again for a fresh list.",
        retryable: true,
      };
    case "filter_unavailable":
      return {
        title: "Deadline filters aren't available yet",
        description: "Clear the deadline filter to search everything else.",
        retryable: false,
      };
    case "invalid":
      return {
        title: "That search can't run",
        description: "Check the filters and try a shorter search.",
        retryable: false,
      };
  }
}

/** The notices the api sends with results, each explaining one thing that is not in the results. */
export function noticeMessage(notice: SearchNotice): string {
  switch (notice) {
    case "chat_opt_in_required":
      return "Chat messages aren't searchable until you turn chat search on in Settings → Account.";
    case "chat_indexing":
      return "Chat messages are still being added to search.";
    case "index_truncated":
      return "This account is past the search size limit, so some document text isn't searchable.";
    case "changes_pending":
      return "Some recent changes aren't searchable yet.";
    case "results_capped":
      return "Many matches were found; narrow the search to see the best ones.";
    case "partial_terms":
      return "Nothing matched every word, so these results match some of them.";
  }
}

/** Index freshness, stated separately from the results (note 14). */
export function statusMessage(status: SearchIndexStatus): string | null {
  switch (status) {
    case "ready":
      return null;
    case "partial":
      return "Some changes aren't searchable yet.";
    case "rebuilding":
      return "Search is rebuilding its index, so only task titles are searched right now.";
  }
}
