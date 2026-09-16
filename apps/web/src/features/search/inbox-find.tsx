"use client";

import type { SearchResponse } from "@symplist/contracts";
import { useRouter } from "next/navigation";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useState,
} from "react";
import type { CollectionId } from "@/components/shell/routes";
import { Spinner } from "@/components/ui/spinner";
import { taskHref } from "./api.ts";
import { useSearchApi } from "./client.tsx";
import { collectionLabels, defaultSearchFilters } from "./filters.ts";
import { HighlightedText } from "./highlight.tsx";
import { failureMessage } from "./messages.ts";
import { focusAfterNavigation } from "./navigation.ts";
import { SEARCH_PATH } from "./routes.ts";
import { rememberSearchScreen } from "./store.ts";
import { SURFACE_FIND_ATTRIBUTE } from "./surface-find.ts";
import { reportSearchUsed, resultCountBucket } from "./telemetry.ts";
import { useAsyncSearch, useDebouncedValue } from "./use-async-search.ts";

/*
 * Find in the task list (note 14 entry point 3, the sample's quiet inbox search): the collection is
 * the filter, so a query here never reaches other collections, the archive or chat. With no query the
 * list below is shown untouched. The task list feature renders this around its tree.
 */

/** How long typing settles before the collection is filtered. */
export const INBOX_FIND_DEBOUNCE_MS = 180;
/** Matching tasks shown at once. */
export const INBOX_FIND_LIMIT = 50;

export interface InboxFindProps {
  readonly collection: CollectionId;
  /** The collection's task list, shown whenever the find field is empty. */
  readonly children?: ReactNode;
}

export function InboxFind({ collection, children }: InboxFindProps) {
  const api = useSearchApi();
  const router = useRouter();
  const baseId = useId();
  const [query, setQuery] = useState("");
  const trimmed = query.trim();
  const debounced = useDebouncedValue(
    trimmed,
    INBOX_FIND_DEBOUNCE_MS,
    (value) => value.length === 0,
  );
  const label = collectionLabels[collection];

  const results = useAsyncSearch<SearchResponse>({
    key: `inbox:${collection}:${debounced}`,
    enabled: debounced.length > 0,
    run: (signal) =>
      api.content(
        {
          q: debounced,
          collections: [collection],
          archive: "exclude",
          types: ["tasks"],
          deadline: null,
          limit: INBOX_FIND_LIMIT,
        },
        signal,
      ),
  });

  const filtering = trimmed.length > 0;
  const groups = results.data?.items ?? [];

  // One report per settled filter, with counts only (decision C5.3).
  useEffect(() => {
    if (!results.data) return;
    reportSearchUsed({
      surface: "collection",
      include_archive: false,
      include_chat: false,
      result_count: resultCountBucket(results.data.items.length),
    });
  }, [results.data]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && !event.defaultPrevented) {
      // Escape clears this surface's find without touching anything else (note 14).
      event.preventDefault();
      setQuery("");
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-slot="inbox-find">
      <div className="flex items-center gap-2 px-2 pt-2 pb-1">
        <label className="sr-only" htmlFor={`${baseId}-find`}>
          {`Find in ${label}`}
        </label>
        <input
          id={`${baseId}-find`}
          {...{ [SURFACE_FIND_ATTRIBUTE]: "inbox" }}
          type="search"
          className="h-8 min-w-0 flex-1 rounded-sym border border-sym-line-strong bg-sym-surface px-2.5 text-[13.5px] outline-none focus-visible:border-sym-accent"
          placeholder={`Find in ${label}…`}
          autoComplete="off"
          spellCheck={false}
          maxLength={200}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
        {results.status === "loading" ? <Spinner label={`Finding in ${label}`} /> : null}
      </div>

      {filtering ? (
        <div className="min-h-0 flex-1 overflow-auto px-1 pb-3" data-slot="inbox-find-results">
          <p className="sr-only" role="status" aria-live="polite">
            {results.failure
              ? failureMessage(results.failure).title
              : results.status === "loading"
                ? "Searching…"
                : `${groups.length} ${groups.length === 1 ? "task" : "tasks"} match`}
          </p>
          {results.failure ? (
            <div role="alert" className="px-2 py-3 text-[13px] text-sym-muted">
              <p className="m-0 font-medium text-sym-text">
                {failureMessage(results.failure).title}
              </p>
              <p className="m-0 mt-0.5">{failureMessage(results.failure).description}</p>
              {failureMessage(results.failure).retryable ? (
                <button
                  type="button"
                  className="sym-text-button mt-1.5 text-[13px]"
                  onClick={() => results.refresh()}
                >
                  Try again
                </button>
              ) : null}
            </div>
          ) : null}
          {!results.failure && results.status === "ready" && groups.length === 0 ? (
            <p className="px-3 py-4 text-[13.5px] text-sym-muted">
              {`No tasks in ${label} match “${debounced}”.`}
            </p>
          ) : null}
          <ul className="m-0 flex list-none flex-col p-0">
            {groups.map((group) => (
              <li key={group.task.id}>
                <a
                  href={taskHref(group.task)}
                  className="flex flex-col gap-0.5 rounded-sym px-2.5 py-1.5 text-sym-text no-underline hover:bg-sym-hover"
                  onClick={(event) => {
                    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)
                      return;
                    event.preventDefault();
                    const href = taskHref(group.task);
                    focusAfterNavigation(href);
                    router.push(href);
                  }}
                >
                  <span className="truncate text-[13.5px]">
                    <HighlightedText
                      text={group.task.title}
                      highlights={group.task.titleHighlights}
                    />
                  </span>
                  {group.task.parent ? (
                    <span className="truncate text-[12px] text-sym-muted">
                      {`in “${group.task.parent.title}”`}
                    </span>
                  ) : null}
                </a>
              </li>
            ))}
          </ul>
          {results.status === "ready" ? (
            <button
              type="button"
              className="sym-text-button mt-1 px-2.5 py-1.5 text-left text-[12.5px]"
              onClick={() => {
                // The same query, handed to the richer surface (note 14); touch users reach it here.
                rememberSearchScreen({
                  query: debounced,
                  filters: defaultSearchFilters,
                  returnHref: typeof window === "undefined" ? null : window.location.pathname,
                  activeKey: null,
                });
                router.push(SEARCH_PATH);
              }}
            >
              {`Search all content for “${debounced}”`}
            </button>
          ) : null}
        </div>
      ) : (
        children
      )}
    </div>
  );
}
