"use client";

import type {
  SearchArchiveMode,
  SearchMessageHit,
  SearchResponse,
  SearchResultGroup,
  SearchSectionHit,
} from "@symplist/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/inline-error";
import { SkeletonLines } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useSession } from "@/features/access/session";
import { cn } from "@/lib/utils";
import {
  classifySearchError,
  SEARCH_JUMP_PARAMS,
  type SearchContentRequest,
  type SearchFailure,
  taskHref,
} from "./api.ts";
import { useSearchApi } from "./client.tsx";
import {
  archiveLabels,
  collectionLabels,
  collectionOrder,
  contentTypeLabels,
  contentTypeOrder,
  type DeadlineChoice,
  deadlineLabels,
  defaultSearchFilters,
  describeScope,
  type SearchFilters,
  toggleInList,
  validateDeadline,
  viewerTimeZone,
} from "./filters.ts";
import { HighlightedText, SnippetText } from "./highlight.tsx";
import { failureMessage, noticeMessage, statusMessage } from "./messages.ts";
import { focusAfterNavigation } from "./navigation.ts";
import { recallSearchScreen, rememberSearchScreen, setSearchJump } from "./store.ts";
import { SURFACE_FIND_ATTRIBUTE } from "./surface-find.ts";
import { reportSearchUsed, resultCountBucket } from "./telemetry.ts";
import { useAsyncSearch, useDebouncedValue } from "./use-async-search.ts";
import { useFreshnessWatch } from "./use-freshness.ts";

/*
 * The full search screen (search.md, note 14): one query, visible keyboard-accessible filters, the
 * scope always stated, results grouped per task with bounded snippets, and freshness explained apart
 * from the results. The query and filters live in memory only, so returning from a task restores them
 * while nothing writes a query history.
 */

/** How long typing settles before a search runs. */
export const SEARCH_DEBOUNCE_MS = 220;
/** Results per page; more pages load through the server cursor. */
export const SEARCH_PAGE_LIMIT = 20;

interface ExpandedGroup {
  readonly status: "loading" | "ready" | "error";
  readonly group?: SearchResultGroup;
  readonly failure?: SearchFailure;
}

interface PageState {
  readonly key: string;
  readonly groups: readonly SearchResultGroup[];
  readonly cursor: string | null;
  readonly loading: boolean;
  readonly failure: SearchFailure | null;
}

const emptyPages: PageState = { key: "", groups: [], cursor: null, loading: false, failure: null };

function requestOf(
  query: string,
  filters: SearchFilters,
  timeZone: string,
): SearchContentRequest | null {
  const deadline = validateDeadline(filters.deadline, timeZone);
  if (!deadline.ok) return null;
  return {
    q: query,
    collections: filters.collections,
    archive: filters.archive,
    types: filters.types,
    deadline: deadline.filter,
    limit: SEARCH_PAGE_LIMIT,
  };
}

function requestKey(request: SearchContentRequest | null): string {
  return request === null ? "" : JSON.stringify(request);
}

export function SearchScreen() {
  const api = useSearchApi();
  const router = useRouter();
  const session = useSession();
  const baseId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const restored = useRef(recallSearchScreen());
  const [query, setQuery] = useState(restored.current?.query ?? "");
  const [filters, setFilters] = useState<SearchFilters>(
    restored.current?.filters ?? defaultSearchFilters,
  );
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [expanded, setExpanded] = useState<Readonly<Record<string, ExpandedGroup>>>({});
  const [pages, setPages] = useState<PageState>(emptyPages);
  const [gone, setGone] = useState<readonly string[]>([]);
  const returnHref = restored.current?.returnHref ?? null;
  const timeZone = useMemo(() => viewerTimeZone(), []);

  const access = session.access;
  const admitted =
    session.status === "signed_in" && access
      ? access.emailVerifiedAt !== null &&
        access.suspendedAt === null &&
        access.betaState === "unlocked" &&
        access.deletionState === "none"
      : session.status !== "signed_out";

  const trimmed = query.trim();
  const debounced = useDebouncedValue(trimmed, SEARCH_DEBOUNCE_MS, (value) => value.length === 0);
  const deadline = validateDeadline(filters.deadline, timeZone);
  const request = requestOf(debounced, filters, timeZone);
  const key = requestKey(request);
  const canSearch = admitted && debounced.length > 0 && request !== null;

  const results = useAsyncSearch<SearchResponse>({
    key,
    enabled: canSearch,
    run: (signal) => api.content(request as SearchContentRequest, signal),
  });

  // Every new search starts a fresh list of pages, expansions and dropped tasks.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the request key is the trigger.
  useEffect(() => {
    setPages(emptyPages);
    setExpanded({});
    setGone([]);
  }, [key]);

  useEffect(() => {
    rememberSearchScreen({ query, filters, returnHref, activeKey: null });
  }, [query, filters, returnHref]);

  const data = results.data;
  const baseGroups = data?.items ?? [];
  const extraGroups = pages.key === key ? pages.groups : [];
  const groups = useMemo(
    () =>
      [...baseGroups, ...extraGroups]
        .filter((group) => !gone.includes(group.task.id))
        .map((group) => expanded[group.task.id]?.group ?? group),
    [baseGroups, extraGroups, expanded, gone],
  );
  const nextCursor = pages.key === key ? pages.cursor : (data?.nextCursor ?? null);

  const freshness = useFreshnessWatch(api, {
    active: Boolean(data) && admitted,
    shownGeneration: data?.indexGeneration ?? 0,
    pending: data?.pendingIntents ?? 0,
    status: data?.status ?? "ready",
    // The only `partial` result a later publication changes: chat was opted into but is not indexed.
    rebuildExpected: data?.notices.includes("chat_indexing") ?? false,
  });

  // One report per settled search, with counts only (decision C5.3).
  useEffect(() => {
    if (!data) return;
    reportSearchUsed({
      surface: "full_search",
      include_archive: data.scope.archive !== "exclude",
      include_chat: data.scope.types.includes("chat"),
      result_count: resultCountBucket(data.items.length),
    });
  }, [data]);

  const failure: SearchFailure | null =
    session.status === "signed_out"
      ? { kind: "signed_out" }
      : !admitted
        ? { kind: "no_access" }
        : results.failure;

  const loadMore = useCallback(() => {
    if (!request || !nextCursor || pages.loading) return;
    setPages((current) => ({
      key,
      groups: current.key === key ? current.groups : [],
      cursor: nextCursor,
      loading: true,
      failure: null,
    }));
    api.content({ ...request, cursor: nextCursor }).then(
      (response) => {
        setPages((current) => ({
          key,
          groups: [...(current.key === key ? current.groups : []), ...response.items],
          cursor: response.nextCursor,
          loading: false,
          failure: null,
        }));
      },
      (error: unknown) => {
        const classified = classifySearchError(error);
        if (!classified) return;
        setPages((current) => ({
          key,
          groups: current.key === key ? current.groups : [],
          cursor: nextCursor,
          loading: false,
          failure: classified,
        }));
      },
    );
  }, [api, key, nextCursor, pages.loading, request]);

  const toggleExpand = useCallback(
    (taskId: string) => {
      if (!request) return;
      setExpanded((current) => {
        if (current[taskId]) {
          const { [taskId]: _removed, ...rest } = current;
          return rest;
        }
        return { ...current, [taskId]: { status: "loading" } };
      });
      if (expanded[taskId]) return;
      api.content({ ...request, taskId, limit: 1 }).then(
        (response) => {
          const group = response.items[0];
          setExpanded((current) =>
            current[taskId]
              ? {
                  ...current,
                  [taskId]: group
                    ? { status: "ready", group }
                    : { status: "error", failure: { kind: "cursor_stale" } },
                }
              : current,
          );
        },
        (error: unknown) => {
          const classified = classifySearchError(error);
          if (!classified) return;
          setExpanded((current) =>
            current[taskId]
              ? { ...current, [taskId]: { status: "error", failure: classified } }
              : current,
          );
        },
      );
    },
    [api, expanded, request],
  );

  /** Opens a result: the task is read again first, so a moved or archived task still opens right. */
  const open = useCallback(
    async (
      group: SearchResultGroup,
      hit?: { readonly section?: SearchSectionHit; readonly message?: SearchMessageHit },
    ) => {
      let location: { collection: SearchResultGroup["task"]["collection"]; archived: boolean } = {
        collection: group.task.collection,
        archived: group.task.archived,
      };
      try {
        const latest = await api.locateTask(group.task.id);
        if (!latest) {
          setGone((current) => [...current, group.task.id]);
          return;
        }
        location = { collection: latest.collection, archived: latest.archived };
      } catch {
        // A lookup that fails (offline, temporary error) still opens the task where results said.
      }
      const base = taskHref({ id: group.task.id, ...location });
      const params = new URLSearchParams();
      if (hit?.section) params.set(SEARCH_JUMP_PARAMS.section, hit.section.sectionId);
      if (hit?.message) params.set(SEARCH_JUMP_PARAMS.message, hit.message.messageId);
      const href = params.size > 0 ? `${base}?${params.toString()}` : base;
      setSearchJump({
        taskId: group.task.id,
        query: debounced,
        ...(hit?.section
          ? {
              section: {
                sectionId: hit.section.sectionId,
                ordinal: hit.section.ordinal,
                heading: hit.section.heading,
                indexedRevision: hit.section.indexedRevision,
                currentRevision: hit.section.currentRevision,
                stale: hit.section.stale,
              },
            }
          : {}),
        ...(hit?.message
          ? {
              message: {
                messageId: hit.message.messageId,
                conversationId: hit.message.conversationId,
              },
            }
          : {}),
      });
      rememberSearchScreen({ query, filters, returnHref, activeKey: group.task.id });
      focusAfterNavigation(href);
      router.push(href);
    },
    [api, debounced, filters, query, returnHref, router],
  );

  /** Up and Down move through the results; Escape returns to the query (search.md). */
  const onResultsKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    const container = resultsRef.current;
    if (!container) return;
    const targets = [...container.querySelectorAll<HTMLElement>("[data-search-nav]")];
    const index = targets.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      (targets[Math.min(targets.length - 1, index + 1)] ?? targets[0])?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (index <= 0) inputRef.current?.focus();
      else targets[index - 1]?.focus();
    } else if (event.key === "Home" && index >= 0) {
      event.preventDefault();
      targets[0]?.focus();
    } else if (event.key === "End" && index >= 0) {
      event.preventDefault();
      targets.at(-1)?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      inputRef.current?.focus();
    }
  }, []);

  const onQueryKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.defaultPrevented || event.nativeEvent.isComposing) return;
      if (event.key === "ArrowDown") {
        const first = resultsRef.current?.querySelector<HTMLElement>("[data-search-nav]");
        if (first) {
          event.preventDefault();
          first.focus();
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        if (query.length > 0) setQuery("");
        else if (returnHref) router.push(returnHref);
      }
    },
    [query.length, returnHref, router],
  );

  const scope = data?.scope ?? {
    collections: filters.collections,
    archive: filters.archive,
    types: filters.types,
    deadline: deadline.ok ? deadline.filter : null,
  };
  const notices = data?.notices ?? [];
  const status = data ? statusMessage(data.status) : null;
  const resultCount = groups.length;
  const summary = failure
    ? failureMessage(failure).title
    : !canSearch
      ? ""
      : results.status === "loading"
        ? "Searching…"
        : resultCount === 0
          ? `No results for “${debounced}”`
          : `${resultCount} ${resultCount === 1 ? "task" : "tasks"} with matches`;

  return (
    <div className="mx-auto flex w-full max-w-[980px] flex-col gap-4 px-4 py-5 max-md:px-3">
      <div className="flex items-center gap-2">
        {returnHref ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Back"
            onClick={() => router.push(returnHref)}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="m15 18-6-6 6-6"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </Button>
        ) : null}
        <h1 className="m-0 font-heading font-semibold text-[19px] tracking-[-0.012em]">Search</h1>
      </div>

      <div className="flex items-center gap-2 rounded-sym border border-sym-line-strong bg-sym-surface px-3 focus-within:border-sym-accent">
        <span aria-hidden="true" className="flex text-sym-faint">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
            <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </span>
        <label className="sr-only" htmlFor={`${baseId}-query`}>
          Search tasks, documents and chat
        </label>
        <input
          id={`${baseId}-query`}
          ref={inputRef}
          {...{ [SURFACE_FIND_ATTRIBUTE]: "search" }}
          type="search"
          className="h-11 min-w-0 flex-1 border-0 bg-transparent text-[15px] outline-none"
          placeholder="Search tasks and documents…"
          autoComplete="off"
          spellCheck={false}
          maxLength={200}
          // The query is the reason the screen exists, so it takes focus on arrival (note 14).
          // biome-ignore lint/a11y/noAutofocus: search.md asks for the query to be focused on opening.
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onQueryKeyDown}
        />
        {results.status === "loading" ? <Spinner label="Searching" /> : null}
      </div>

      <div className="flex items-start gap-5 max-lg:flex-col max-lg:gap-3">
        <div className="flex w-[220px] flex-none flex-col gap-3 max-lg:w-full">
          <Button
            variant="secondary"
            size="sm"
            className="w-full justify-between lg:hidden"
            aria-expanded={filtersOpen}
            aria-controls={`${baseId}-filters`}
            onClick={() => setFiltersOpen((open) => !open)}
          >
            Filters
            <span aria-hidden="true">{filtersOpen ? "–" : "+"}</span>
          </Button>
          <section
            id={`${baseId}-filters`}
            aria-label="Search filters"
            className={cn(
              "flex flex-col gap-4 rounded-sym-lg border border-sym-line bg-sym-panel p-3",
              !filtersOpen && "max-lg:hidden",
            )}
          >
            <fieldset className="m-0 border-0 p-0">
              <legend className="mb-1.5 p-0 font-medium text-[12px] text-sym-muted uppercase tracking-[0.03em]">
                Collections
              </legend>
              <div className="flex flex-col gap-1.5">
                {collectionOrder.map((collection) => (
                  <label key={collection} className="flex items-center gap-2 text-[13.5px]">
                    <input
                      type="checkbox"
                      checked={filters.collections.includes(collection)}
                      onChange={() =>
                        setFilters((current) => ({
                          ...current,
                          collections: toggleInList(
                            collectionOrder,
                            current.collections,
                            collection,
                          ),
                        }))
                      }
                    />
                    {collectionLabels[collection]}
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset className="m-0 border-0 p-0">
              <legend className="mb-1.5 p-0 font-medium text-[12px] text-sym-muted uppercase tracking-[0.03em]">
                Archive
              </legend>
              <div className="flex flex-col gap-1.5">
                {(Object.keys(archiveLabels) as SearchArchiveMode[]).map((mode) => (
                  <label key={mode} className="flex items-center gap-2 text-[13.5px]">
                    <input
                      type="radio"
                      name={`${baseId}-archive`}
                      checked={filters.archive === mode}
                      onChange={() => setFilters((current) => ({ ...current, archive: mode }))}
                    />
                    {archiveLabels[mode]}
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset className="m-0 border-0 p-0">
              <legend className="mb-1.5 p-0 font-medium text-[12px] text-sym-muted uppercase tracking-[0.03em]">
                Content
              </legend>
              <div className="flex flex-col gap-1.5">
                {contentTypeOrder.map((type) => (
                  <label key={type} className="flex items-center gap-2 text-[13.5px]">
                    <input
                      type="checkbox"
                      checked={filters.types.includes(type)}
                      onChange={() =>
                        setFilters((current) => ({
                          ...current,
                          types: toggleInList(contentTypeOrder, current.types, type),
                        }))
                      }
                    />
                    {contentTypeLabels[type]}
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset className="m-0 border-0 p-0">
              <legend className="mb-1.5 p-0 font-medium text-[12px] text-sym-muted uppercase tracking-[0.03em]">
                Deadline
              </legend>
              <label className="sr-only" htmlFor={`${baseId}-deadline`}>
                Deadline filter
              </label>
              <select
                id={`${baseId}-deadline`}
                className="h-8 w-full rounded-sym border border-sym-line-strong bg-sym-surface px-2 text-[13.5px]"
                value={filters.deadline.choice}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    deadline: { ...current.deadline, choice: event.target.value as DeadlineChoice },
                  }))
                }
              >
                {(Object.keys(deadlineLabels) as DeadlineChoice[]).map((choice) => (
                  <option key={choice} value={choice}>
                    {deadlineLabels[choice]}
                  </option>
                ))}
              </select>
              {filters.deadline.choice === "range" ? (
                <div className="mt-2 flex flex-col gap-1.5">
                  <label className="flex flex-col gap-1 text-[12.5px] text-sym-muted">
                    From
                    <input
                      type="date"
                      className="h-8 rounded-sym border border-sym-line-strong bg-sym-surface px-2 text-[13.5px] text-sym-text"
                      value={filters.deadline.from}
                      onChange={(event) =>
                        setFilters((current) => ({
                          ...current,
                          deadline: { ...current.deadline, from: event.target.value },
                        }))
                      }
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-[12.5px] text-sym-muted">
                    To
                    <input
                      type="date"
                      className="h-8 rounded-sym border border-sym-line-strong bg-sym-surface px-2 text-[13.5px] text-sym-text"
                      value={filters.deadline.to}
                      onChange={(event) =>
                        setFilters((current) => ({
                          ...current,
                          deadline: { ...current.deadline, to: event.target.value },
                        }))
                      }
                    />
                  </label>
                </div>
              ) : null}
              {filters.deadline.choice !== "any" ? (
                <p className="mt-1.5 text-[12px] text-sym-muted">{`Compared in ${timeZone}`}</p>
              ) : null}
              {deadline.ok ? null : (
                <p role="alert" className="mt-1.5 text-[12px] text-sym-danger">
                  {deadline.message}
                </p>
              )}
            </fieldset>
          </section>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <p data-slot="scope" className="m-0 text-[12.5px] text-sym-muted">
            {describeScope(scope)}
          </p>

          {status || notices.length > 0 || freshness.newerAvailable ? (
            <div
              data-slot="search-notices"
              className="flex flex-col gap-1.5 rounded-sym border border-sym-line bg-sym-panel px-3 py-2 text-[12.5px] text-sym-muted"
            >
              {status ? <p className="m-0">{status}</p> : null}
              {notices.map((notice) => (
                <p key={notice} className="m-0">
                  {noticeMessage(notice)}
                  {notice === "chat_opt_in_required" ? (
                    <>
                      {" "}
                      <Link href="/settings/account" className="text-sym-link">
                        Open Settings
                      </Link>
                    </>
                  ) : null}
                </p>
              ))}
              {freshness.newerAvailable ? (
                <p className="m-0 flex items-center gap-2">
                  Newer results are available.
                  <button
                    type="button"
                    className="sym-text-button"
                    onClick={() => {
                      freshness.acknowledge();
                      results.refresh();
                    }}
                  >
                    Refresh
                  </button>
                </p>
              ) : null}
            </div>
          ) : null}

          <p className="sr-only" role="status" aria-live="polite">
            {summary}
          </p>

          {failure ? (
            <InlineError
              title={failureMessage(failure).title}
              description={failureMessage(failure).description}
              {...(failureMessage(failure).retryable
                ? { onRetry: () => results.refresh(), retryLabel: "Try again" }
                : {})}
            />
          ) : null}
          {failure?.kind === "filter_unavailable" ? (
            <div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  setFilters((current) => ({
                    ...current,
                    deadline: { choice: "any", from: "", to: "" },
                  }))
                }
              >
                Clear deadline filter
              </Button>
            </div>
          ) : null}

          {!failure && !canSearch ? (
            <div className="rounded-sym-lg border border-sym-line border-dashed px-4 py-6 text-[13.5px] text-sym-muted">
              <p className="m-0 font-medium text-sym-text">Search your work</p>
              <p className="m-0 mt-1">
                Task titles and current pages are searched by default. Put words in quotes for an
                exact phrase, and use the filters to include the archive or chat.
              </p>
            </div>
          ) : null}

          {!failure && canSearch && results.status === "loading" && groups.length === 0 ? (
            <SkeletonLines label="Searching" />
          ) : null}

          {!failure && canSearch && results.status === "ready" && groups.length === 0 ? (
            <div
              data-slot="no-matches"
              className="rounded-sym-lg border border-sym-line px-4 py-6 text-[13.5px] text-sym-muted"
            >
              <p className="m-0 font-medium text-sym-text">{`No results for “${debounced}”`}</p>
              <p className="m-0 mt-1">Try fewer words, or widen the scope.</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {filters.archive === "exclude" ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setFilters((current) => ({ ...current, archive: "include" }))}
                  >
                    Include archived
                  </Button>
                ) : null}
                {filters.types.includes("chat") ? null : (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      setFilters((current) => ({
                        ...current,
                        types: toggleInList(contentTypeOrder, current.types, "chat"),
                      }))
                    }
                  >
                    Search chat too
                  </Button>
                )}
              </div>
            </div>
          ) : null}

          {gone.length > 0 ? (
            <p role="status" className="m-0 text-[12.5px] text-sym-muted">
              A result was removed: that task is no longer available.
            </p>
          ) : null}

          {/* Arrow keys move through the results; every item inside is a link or a button, and each
              one is reachable with Tab as well (search.md). */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: roving focus over the result links. */}
          <div
            ref={resultsRef}
            data-slot="search-results"
            aria-busy={results.status === "loading" || undefined}
            className="flex flex-col gap-2"
            onKeyDown={onResultsKeyDown}
          >
            {groups.map((group) => (
              <ResultGroup
                key={group.task.id}
                group={group}
                expanded={expanded[group.task.id]}
                onOpen={open}
                onToggleExpand={toggleExpand}
              />
            ))}
          </div>

          {nextCursor && !failure ? (
            <div className="flex items-center gap-3">
              <Button
                variant="secondary"
                size="sm"
                data-search-nav
                disabled={pages.loading}
                aria-busy={pages.loading || undefined}
                onClick={loadMore}
              >
                {pages.loading ? "Loading…" : "Show more results"}
              </Button>
              {pages.failure ? (
                <span role="alert" className="text-[12.5px] text-sym-muted">
                  {pages.failure.kind === "cursor_stale"
                    ? "These results changed. Search again for a fresh list."
                    : failureMessage(pages.failure).title}
                </span>
              ) : null}
            </div>
          ) : null}
          {pages.failure?.kind === "cursor_stale" ? (
            <div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  // The pinned view is gone, so the whole list restarts at the first page (§10.1).
                  setPages(emptyPages);
                  setExpanded({});
                  results.refresh();
                }}
              >
                Search again
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ResultGroup({
  group,
  expanded,
  onOpen,
  onToggleExpand,
}: {
  readonly group: SearchResultGroup;
  readonly expanded: ExpandedGroup | undefined;
  readonly onOpen: (
    group: SearchResultGroup,
    hit?: { readonly section?: SearchSectionHit; readonly message?: SearchMessageHit },
  ) => void | Promise<void>;
  readonly onToggleExpand: (taskId: string) => void;
}): ReactNode {
  const titleId = `search-result-${group.task.id}`;
  const hiddenSections = Math.max(0, group.sectionCount - group.sections.length);
  const hiddenMessages = Math.max(0, group.messageCount - group.messages.length);
  const more = hiddenSections + hiddenMessages;
  return (
    <article
      aria-labelledby={titleId}
      data-slot="result-group"
      className="rounded-sym-lg border border-sym-line bg-sym-surface p-3"
    >
      <h2 id={titleId} className="m-0 font-heading font-semibold text-[15px] tracking-[-0.01em]">
        <a
          href={taskHref(group.task)}
          data-search-nav
          className="text-sym-text no-underline hover:underline"
          onClick={(event) => {
            event.preventDefault();
            void onOpen(group);
          }}
        >
          <HighlightedText text={group.task.title} highlights={group.task.titleHighlights} />
        </a>
      </h2>
      <p className="m-0 mt-0.5 flex flex-wrap items-center gap-1.5 text-[12px] text-sym-muted">
        <span>{collectionLabels[group.task.collection]}</span>
        {group.task.parent ? (
          <>
            <span aria-hidden="true">·</span>
            <span>{`in “${group.task.parent.title}”`}</span>
          </>
        ) : null}
        {group.task.archived ? (
          <>
            <span aria-hidden="true">·</span>
            <span
              data-slot="archived-label"
              className="rounded-full border border-sym-line px-1.5 py-px"
            >
              Archived
            </span>
          </>
        ) : null}
        {group.titleStale ? (
          <>
            <span aria-hidden="true">·</span>
            <span>Title changed since it was indexed</span>
          </>
        ) : null}
      </p>

      {group.sections.length > 0 || group.messages.length > 0 ? (
        <ul className="m-0 mt-2 flex list-none flex-col gap-1.5 p-0">
          {group.sections.map((section) => (
            <li key={section.sectionId}>
              <a
                href={`${taskHref(group.task)}?${SEARCH_JUMP_PARAMS.section}=${encodeURIComponent(section.sectionId)}`}
                data-search-nav
                data-slot="section-hit"
                className="flex flex-col gap-0.5 rounded-sym px-2 py-1.5 text-sym-text no-underline hover:bg-sym-hover"
                onClick={(event) => {
                  event.preventDefault();
                  void onOpen(group, { section });
                }}
              >
                <span className="text-[13px] text-sym-muted">
                  {section.heading ? (
                    <HighlightedText
                      text={section.heading}
                      highlights={section.headingHighlights}
                    />
                  ) : (
                    "Page"
                  )}
                  {section.stale ? (
                    <span data-slot="stale-hit" className="ml-2 text-sym-warn">
                      Changed since it was indexed; opens at the current version
                    </span>
                  ) : null}
                </span>
                <SnippetText snippet={section.snippet} className="line-clamp-3" />
              </a>
            </li>
          ))}
          {group.messages.map((message) => (
            <li key={message.messageId}>
              <a
                href={`${taskHref(group.task)}?${SEARCH_JUMP_PARAMS.message}=${encodeURIComponent(message.messageId)}`}
                data-search-nav
                data-slot="message-hit"
                className="flex flex-col gap-0.5 rounded-sym px-2 py-1.5 text-sym-text no-underline hover:bg-sym-hover"
                onClick={(event) => {
                  event.preventDefault();
                  void onOpen(group, { message });
                }}
              >
                <span className="text-[13px] text-sym-muted">
                  {`${message.speaker === "simon" ? "Simon" : "You"} · ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(message.createdAt))}`}
                </span>
                <SnippetText snippet={message.snippet} className="line-clamp-3" />
              </a>
            </li>
          ))}
        </ul>
      ) : null}

      {expanded?.status === "loading" ? (
        <p className="m-0 mt-2 text-[12.5px] text-sym-muted">Loading every match…</p>
      ) : null}
      {expanded?.status === "error" ? (
        <p role="alert" className="m-0 mt-2 text-[12.5px] text-sym-muted">
          Those matches could not be loaded. Try again.
        </p>
      ) : null}
      {more > 0 || expanded?.status === "ready" ? (
        <button
          type="button"
          data-search-nav
          className="sym-text-button mt-2 text-[12.5px]"
          aria-expanded={expanded?.status === "ready"}
          onClick={() => onToggleExpand(group.task.id)}
        >
          {expanded?.status === "ready"
            ? "Show fewer matches"
            : `Show all ${group.sectionCount + group.messageCount} matches in this task`}
        </button>
      ) : null}
    </article>
  );
}
