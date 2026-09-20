import {
  type SearchArchiveMode,
  type SearchCollection,
  type SearchContentType,
  type SearchDeadlineFilter,
  type SearchFreshness,
  type SearchIndexStatus,
  type SearchMessageHit,
  type SearchNotice,
  type SearchResponse,
  type SearchResultGroup,
  type SearchSectionHit,
  type SearchTaskSummary,
  type SearchTitleResponse,
  type SearchTitleResult,
  searchCollections,
  searchContentTypes,
  searchDefaultContentTypes,
  searchHitsPerExpandedGroup,
  searchHitsPerGroup,
  searchPageLimitDefault,
  searchTitleLimitDefault,
} from "@symplist/contracts";
import { type AccountDataKey, type KeyProvider, unwrapAccountKey, zeroize } from "@symplist/crypto";
import { type DbClient, DbRateLimitedError, type DbRow, type Statement, sql } from "@symplist/db";
import {
  buildSnippet,
  highlightText,
  INDEX_FORMAT_VERSION,
  openSearchIndex,
  type ParsedQuery,
  parseQuery,
  parseSearchIndexObjectKey,
  type RankedGroup,
  runSearch,
  SEARCH_LIMITS,
  type SearchIndex,
  SearchIndexFormatError,
  type SearchLimits,
  SearchOverlayBuilder,
  type SearchTaskRecord,
  SearchView,
  TOKENIZER_FINGERPRINT,
  textRules,
  titleRules,
} from "@symplist/search";
import type { ObjectStore } from "@symplist/storage";
import { applyIntents, loadAllRecords } from "./apply.ts";
import type { SearchIndexCache } from "./cache.ts";
import { decodeSearchCursor, encodeSearchCursor, searchDigest } from "./cursor.ts";
import { SearchServiceError } from "./errors.ts";
import {
  coalesceIntents,
  pendingIntentsStatement,
  pendingSummaryStatement,
  searchIntentFromRow,
} from "./intents.ts";
import { type SearchLog, searchErrorCode, silentSearchLog } from "./log.ts";
import type { SearchSources } from "./sources/types.ts";
import {
  type PendingSummary,
  pendingSummaryFromDb,
  type SearchIndexRow,
  searchIndexRowFromDb,
  searchIndexRowStatement,
} from "./state.ts";

/** Who is searching: the owner of the index, with the access generation of their session (§3.3). */
export interface SearchPrincipal {
  readonly userId: string;
  readonly accessGeneration: number;
  /** A task-scoped caller (an MCP grant, §14.6) sees only these tasks; null for the owner's own search. */
  readonly taskScope?: ReadonlySet<string> | null;
}

/** A full search request, already validated. */
export interface SearchRequest {
  readonly q: string;
  readonly collections?: readonly SearchCollection[];
  readonly archive?: SearchArchiveMode;
  readonly types?: readonly SearchContentType[];
  readonly taskId?: string | null;
  readonly deadline?: SearchDeadlineFilter | null;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface SearchTitleRequest {
  readonly q: string;
  readonly archive?: SearchArchiveMode;
  readonly limit?: number;
}

/**
 * Work the runtime should start for the owner after answering (§10.1): `rebuild` when the published
 * index is missing, unreadable or out of date with the chat opt-in, `stale` when intents have waited
 * longer than expected. The api enqueues the writer; it never writes the index itself in durable mode.
 */
export type SearchIndexingNeed = "rebuild" | "stale" | null;

export interface SearchServiceResult<Response> {
  readonly response: Response;
  readonly indexing: SearchIndexingNeed;
}

export interface SearchQueryTuning {
  /** How long the owner's index row and pending counts are reused. */
  readonly stateTtlMs: number;
  /** How long the chat opt-in is reused. */
  readonly chatOptInTtlMs: number;
  /** Pending intents older than this ask for the writer again. */
  readonly staleIntentMs: number;
  /** Pending intents applied in memory at most; beyond it results are `partial`. */
  readonly maxOverlayIntents: number;
  /** Changed documents re-read into the overlay at most. */
  readonly maxOverlayDocuments: number;
  /** Changed messages re-read into the overlay at most. */
  readonly maxOverlayMessages: number;
  /** Task titles served while the index is rebuilt. */
  readonly maxFallbackTasks: number;
  /** How long an unreadable published generation is not downloaded again. */
  readonly failureTtlMs: number;
}

export const DEFAULT_SEARCH_QUERY_TUNING: SearchQueryTuning = Object.freeze({
  stateTtlMs: 5_000,
  chatOptInTtlMs: 60_000,
  staleIntentMs: 2 * 60_000,
  maxOverlayIntents: 200,
  maxOverlayDocuments: 10,
  maxOverlayMessages: 200,
  maxFallbackTasks: 5_000,
  failureTtlMs: 60_000,
});

export interface SearchQueryServiceOptions {
  readonly db: DbClient;
  readonly objects: ObjectStore;
  readonly keys: KeyProvider;
  readonly sources: SearchSources;
  readonly cache: SearchIndexCache;
  readonly now: () => number;
  readonly log?: SearchLog;
  readonly limits?: Partial<SearchLimits>;
  readonly tuning?: Partial<SearchQueryTuning>;
}

interface OwnerState {
  readonly row: SearchIndexRow | null;
  readonly summary: PendingSummary;
  readonly keyRow: DbRow | null;
  readonly readAt: number;
}

interface ResolvedView {
  readonly view: SearchView;
  readonly generation: number;
  readonly pendingThrough: number;
  readonly complete: boolean;
  readonly rebuilding: boolean;
  readonly includesChat: boolean;
}

const MAX_TITLE_CHARS = 4096;

function orderedSubset<Value extends string>(
  all: readonly Value[],
  chosen: readonly Value[] | undefined,
  fallback: readonly Value[],
): Value[] {
  const set = new Set(chosen && chosen.length > 0 ? chosen : fallback);
  return all.filter((value) => set.has(value));
}

/**
 * Answers searches for the api (§10.1): loads the owner's published index generation into the bounded
 * cache (decrypting it once), overlays committed changes that are not published yet, ranks and groups
 * hits, then re-reads and re-authorizes the page's tasks and document heads from D1 before rendering
 * snippets. Freshness is reported beside the results; cursors pin the generation and pending changes
 * they were ranked over. It never writes the index.
 */
export class SearchQueryService {
  private readonly log: SearchLog;
  private readonly limits: SearchLimits;
  private readonly tuning: SearchQueryTuning;
  private readonly states = new Map<string, OwnerState>();
  private readonly chatOptIns = new Map<string, { readonly value: boolean; readonly at: number }>();
  private readonly failures = new Map<
    string,
    { readonly generation: number; readonly at: number }
  >();
  private readonly loads = new Map<string, Promise<SearchIndex | null>>();

  constructor(private readonly options: SearchQueryServiceOptions) {
    this.log = options.log ?? silentSearchLog;
    this.limits = { ...SEARCH_LIMITS, ...options.limits };
    this.tuning = { ...DEFAULT_SEARCH_QUERY_TUNING, ...options.tuning };
  }

  /* ---------------------------------------------------------------------------------------------
   * Public operations
   * ------------------------------------------------------------------------------------------- */

  /** Index freshness without running a query. */
  async freshness(principal: SearchPrincipal): Promise<SearchServiceResult<SearchFreshness>> {
    const state = await this.state(principal.userId);
    const optIn = await this.withKey(state, (key) => this.chatOptIn(principal.userId, key));
    const unreadable = this.unreadable(principal.userId, state.row);
    const rebuilding = state.row === null || unreadable;
    const partial =
      !rebuilding &&
      (state.summary.pending > this.tuning.maxOverlayIntents || state.row?.truncated === true);
    return {
      response: {
        status: rebuilding ? "rebuilding" : partial ? "partial" : "ready",
        indexGeneration: state.row?.generation ?? 0,
        pendingIntents: state.summary.pending,
      },
      indexing: this.indexingNeed(state, rebuilding, optIn),
    };
  }

  async search(
    principal: SearchPrincipal,
    request: SearchRequest,
  ): Promise<SearchServiceResult<SearchResponse>> {
    const started = this.options.now();
    const ownerId = principal.userId;
    const collections = orderedSubset(searchCollections, request.collections, searchCollections);
    const archive = request.archive ?? "exclude";
    const types = orderedSubset(searchContentTypes, request.types, searchDefaultContentTypes);
    const taskId = request.taskId ?? null;
    const deadline = request.deadline ?? null;
    const limit = request.limit ?? searchPageLimitDefault;
    const query = parseQuery(request.q);

    if (deadline && !this.options.sources.deadlines) {
      throw new SearchServiceError("search.filter_unavailable");
    }
    const cursor = request.cursor ? decodeSearchCursor(request.cursor) : null;

    const state = await this.state(ownerId);
    return this.withKey(state, async (key) => {
      const optIn = await this.chatOptIn(ownerId, key);
      let resolved = await this.resolveView(principal, state, key, optIn);
      const chat = types.includes("chat") && optIn && resolved.includesChat;
      const digest = searchDigest({ query, collections, archive, types, taskId, deadline, chat });
      if (cursor) {
        if (cursor.digest !== digest) throw new SearchServiceError("search.cursor_invalid");
        if (
          cursor.generation !== resolved.generation ||
          cursor.pendingThrough !== resolved.pendingThrough
        ) {
          const pinned = this.pinnedView(
            ownerId,
            principal,
            cursor.generation,
            cursor.pendingThrough,
          );
          if (!pinned) {
            throw new SearchServiceError("search.cursor_stale", {
              indexGeneration: resolved.generation,
            });
          }
          resolved = pinned;
        }
      }

      let taskIds: Set<string> | null = null;
      const narrow = (ids: Iterable<string>) => {
        const next = new Set(ids);
        taskIds = taskIds ? new Set([...taskIds].filter((id) => next.has(id))) : next;
      };
      if (taskId) narrow([taskId]);
      if (principal.taskScope) narrow(principal.taskScope);
      if (deadline && this.options.sources.deadlines) {
        narrow(
          await this.options.sources.deadlines.matchingTaskIds(
            ownerId,
            deadline,
            this.options.now(),
          ),
        );
      }

      const run = runSearch(resolved.view, query, {
        collections: new Set(collections),
        archive,
        types: new Set(types),
        taskIds,
        chat,
        limits: this.limits,
      });
      const offset = cursor?.offset ?? 0;
      const page = run.groups.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      const hitsPerGroup = taskId ? searchHitsPerExpandedGroup : searchHitsPerGroup;
      const items = await this.renderGroups(ownerId, key, query, page, {
        collections: new Set(collections),
        archive,
        taskScope: principal.taskScope ?? null,
        hitsPerGroup,
      });

      const notices: SearchNotice[] = [];
      if (types.includes("chat") && !optIn) notices.push("chat_opt_in_required");
      const chatIndexing = types.includes("chat") && optIn && !resolved.includesChat;
      if (chatIndexing) notices.push("chat_indexing");
      if (resolved.view.truncated) notices.push("index_truncated");
      if (!resolved.complete || resolved.rebuilding) notices.push("changes_pending");
      if (run.capped) notices.push("results_capped");
      if (run.partialTerms) notices.push("partial_terms");

      const status: SearchIndexStatus = resolved.rebuilding
        ? "rebuilding"
        : !resolved.complete || resolved.view.truncated || run.capped || chatIndexing
          ? "partial"
          : "ready";
      const response: SearchResponse = {
        status,
        indexGeneration: resolved.generation,
        pendingIntents: state.summary.pending,
        scope: {
          collections,
          archive,
          types,
          taskId: taskId as SearchResponse["scope"]["taskId"],
          deadline,
        },
        notices,
        items,
        nextCursor:
          nextOffset < run.groups.length
            ? encodeSearchCursor({
                generation: resolved.generation,
                pendingThrough: resolved.pendingThrough,
                offset: nextOffset,
                digest,
              })
            : null,
      };
      this.log.info("search.query_served", {
        ownerId,
        status,
        termCount: query.terms.length,
        groupCount: run.groups.length,
        itemCount: items.length,
        isNextPage: cursor !== null,
        durationMs: Math.max(0, this.options.now() - started),
      });
      return {
        response,
        indexing: this.indexingNeed(state, resolved.rebuilding, optIn),
      };
    });
  }

  /** The command palette's quick title search (note 13, note 14). */
  async titles(
    principal: SearchPrincipal,
    request: SearchTitleRequest,
  ): Promise<SearchServiceResult<SearchTitleResponse>> {
    const ownerId = principal.userId;
    const query = parseQuery(request.q);
    const limit = request.limit ?? searchTitleLimitDefault;
    const archive = request.archive ?? "exclude";
    const state = await this.state(ownerId);
    return this.withKey(state, async (key) => {
      const optIn = await this.chatOptIn(ownerId, key);
      const resolved = await this.resolveView(principal, state, key, optIn);
      const run = runSearch(resolved.view, query, {
        collections: new Set(searchCollections),
        archive,
        types: new Set(["tasks"]),
        taskIds: principal.taskScope ?? null,
        chat: false,
        limits: this.limits,
      });
      const page = run.groups.filter((group) => group.titleMatch !== null).slice(0, limit);
      const fresh = await this.readTasksForRender(ownerId, key, page, false);
      const items: SearchTitleResult[] = [];
      for (const group of page) {
        const summary = this.summary(group, fresh.tasks, query, {
          collections: new Set(searchCollections),
          archive,
          taskScope: principal.taskScope ?? null,
        });
        if (!summary) continue;
        items.push({
          task: summary.task,
          match: group.titleMatch as SearchTitleResult["match"],
          titleStale: summary.titleStale,
        });
      }
      return {
        response: {
          status: resolved.rebuilding ? "rebuilding" : resolved.complete ? "ready" : "partial",
          indexGeneration: resolved.generation,
          pendingIntents: state.summary.pending,
          items,
        },
        indexing: this.indexingNeed(state, resolved.rebuilding, optIn),
      };
    });
  }

  /**
   * Drops everything this process holds for an owner: the decrypted index, overlays and cached state.
   * Called after a restriction or account deletion committed (§5.5, §10.1).
   */
  evictOwner(ownerId: string, reason: "restricted" | "deleted"): void {
    this.options.cache.evictOwner(ownerId, reason);
    this.states.delete(ownerId);
    this.chatOptIns.delete(ownerId);
    this.failures.delete(ownerId);
  }

  /** Forgets the cached index row and pending counts, after a writer published or intents changed. */
  invalidateState(ownerId: string): void {
    this.states.delete(ownerId);
  }

  /** Forgets the cached chat opt-in, after the owner changed the privacy preference. */
  invalidateChatOptIn(ownerId: string): void {
    this.chatOptIns.delete(ownerId);
  }

  /** Drops idle decrypted indexes and expired state. */
  sweep(): void {
    this.options.cache.evictIdle();
    const now = this.options.now();
    for (const [owner, state] of this.states) {
      if (now - state.readAt >= this.tuning.stateTtlMs) this.states.delete(owner);
    }
    for (const [owner, optIn] of this.chatOptIns) {
      if (now - optIn.at >= this.tuning.chatOptInTtlMs) this.chatOptIns.delete(owner);
    }
    for (const [owner, failure] of this.failures) {
      if (now - failure.at >= this.tuning.failureTtlMs) this.failures.delete(owner);
    }
  }

  /* ---------------------------------------------------------------------------------------------
   * State and views
   * ------------------------------------------------------------------------------------------- */

  private async state(ownerId: string, fresh = false): Promise<OwnerState> {
    const now = this.options.now();
    const cached = this.states.get(ownerId);
    if (!fresh && cached && now - cached.readAt < this.tuning.stateTtlMs) return cached;
    const results = await this.options.db.batch([
      searchIndexRowStatement(ownerId),
      pendingSummaryStatement(ownerId),
      sql(`SELECT owner_id, kek_version, wrapped_key FROM account_keys WHERE owner_id = :owner`, {
        owner: ownerId,
      }),
    ]);
    const state: OwnerState = {
      row: searchIndexRowFromDb(results[0]?.results[0]),
      summary: pendingSummaryFromDb(results[1]?.results[0]),
      keyRow: results[2]?.results[0] ?? null,
      readAt: now,
    };
    this.states.set(ownerId, state);
    return state;
  }

  private async withKey<Result>(
    state: OwnerState,
    use: (key: AccountDataKey) => Promise<Result>,
  ): Promise<Result> {
    if (!state.keyRow) throw new SearchServiceError("search.unavailable");
    let key: AccountDataKey;
    try {
      key = unwrapAccountKey(this.options.keys, {
        ownerId: String(state.keyRow.owner_id),
        kekVersion: Number(state.keyRow.kek_version),
        wrapped: String(state.keyRow.wrapped_key),
      });
    } catch (error) {
      this.log.error("search.account_key_unavailable", { code: searchErrorCode(error) });
      throw new SearchServiceError("search.unavailable");
    }
    try {
      return await use(key);
    } finally {
      zeroize(key.key);
    }
  }

  private async chatOptIn(ownerId: string, key: AccountDataKey): Promise<boolean> {
    const source = this.options.sources.chatOptIn;
    if (!source) return false;
    const now = this.options.now();
    const cached = this.chatOptIns.get(ownerId);
    if (cached && now - cached.at < this.tuning.chatOptInTtlMs) return cached.value;
    const value = await source.includeChat(ownerId, key);
    this.chatOptIns.set(ownerId, { value, at: now });
    return value;
  }

  private unreadable(ownerId: string, row: SearchIndexRow | null): boolean {
    if (!row) return false;
    if (row.indexFormatVersion !== INDEX_FORMAT_VERSION) return true;
    if (row.tokenizerFingerprint !== TOKENIZER_FINGERPRINT) return true;
    const failure = this.failures.get(ownerId);
    return (
      failure !== undefined &&
      failure.generation === row.generation &&
      this.options.now() - failure.at < this.tuning.failureTtlMs
    );
  }

  private indexingNeed(state: OwnerState, rebuilding: boolean, optIn: boolean): SearchIndexingNeed {
    if (rebuilding) return "rebuild";
    if (state.row && state.row.includeChat !== optIn) return "rebuild";
    if (
      state.summary.pending > 0 &&
      state.summary.oldestAt !== null &&
      this.options.now() - state.summary.oldestAt >= this.tuning.staleIntentMs
    ) {
      return "stale";
    }
    return null;
  }

  private async resolveView(
    principal: SearchPrincipal,
    initial: OwnerState,
    key: AccountDataKey,
    optIn: boolean,
  ): Promise<ResolvedView> {
    const ownerId = principal.userId;
    let state = initial;
    let loaded = await this.loadBase(principal, state, key);
    if (loaded === "reload") {
      // The object of the cached row is gone: a newer generation was published. Read the row again once.
      state = await this.state(ownerId, true);
      loaded = await this.loadBase(principal, state, key);
      if (loaded === "reload") {
        this.failures.set(ownerId, {
          generation: state.row?.generation ?? 0,
          at: this.options.now(),
        });
        loaded = null;
      }
    }
    const base = loaded;
    const generation = state.row?.generation ?? 0;
    if (
      base === null &&
      !this.options.cache.base(ownerId, generation, principal.accessGeneration)
    ) {
      // Rebuilding: hold an entry without a published index, so title overlays are cached under the
      // requester's access generation like any other view.
      this.options.cache.setBase(ownerId, {
        accessGeneration: principal.accessGeneration,
        generation,
        base: null,
        bytes: 0,
      });
    }
    const pendingThrough = state.summary.maxId;
    const viewKey = `${generation}:${pendingThrough}`;
    const cached = this.options.cache.view(ownerId, viewKey);
    const includesChat = base ? base.includeChat : false;
    if (cached) {
      return {
        view: cached.view,
        generation,
        pendingThrough,
        complete: cached.complete,
        rebuilding: base === null,
        includesChat,
      };
    }

    let view: SearchView;
    let complete: boolean;
    let bytes = 0;
    if (base === null) {
      const builder = new SearchOverlayBuilder(null, {
        ownerId,
        includeChat: false,
        limits: this.limits,
      });
      const loaded = await loadAllRecords(builder, {
        ownerId,
        key,
        sources: this.options.sources,
        includeChat: false,
        titlesOnly: true,
        maxTasks: this.tuning.maxFallbackTasks,
      });
      view = builder.view();
      complete = false;
      bytes = builder.overlayChars * 2;
      this.log.info("search.fallback_titles", { ownerId, taskCount: loaded.tasks, generation });
    } else if (state.summary.pending === 0 || pendingThrough <= (state.row?.appliedThrough ?? 0)) {
      view = SearchView.of(base);
      complete = true;
    } else {
      const rows = await this.options.db.all(
        pendingIntentsStatement(ownerId, this.tuning.maxOverlayIntents, {
          after: state.row?.appliedThrough ?? 0,
          through: pendingThrough,
        }),
      );
      const intents = rows.map(searchIntentFromRow);
      const builder = new SearchOverlayBuilder(base, {
        ownerId,
        includeChat: base.includeChat,
        limits: this.limits,
      });
      let applied: Awaited<ReturnType<typeof applyIntents>>;
      try {
        applied = await applyIntents(builder, coalesceIntents(intents), {
          ownerId,
          key,
          sources: this.options.sources,
          includeChat: base.includeChat && optIn,
          maxDocuments: this.tuning.maxOverlayDocuments,
          maxMessages: this.tuning.maxOverlayMessages,
        });
      } catch (error) {
        // A source another feature owns (head snapshots, messages) failed: a temporary error with retry.
        if (error instanceof DbRateLimitedError) throw error;
        this.log.warn("search.overlay_failed", { ownerId, code: searchErrorCode(error) });
        throw new SearchServiceError("search.unavailable");
      }
      view = builder.view();
      complete = intents.length >= state.summary.pending && applied.deferred === 0;
      bytes = builder.overlayChars * 2;
    }
    this.options.cache.setView(ownerId, viewKey, { view, complete, bytes });
    return { view, generation, pendingThrough, complete, rebuilding: base === null, includesChat };
  }

  /** A cached view a cursor was issued for, while its generation is still held. */
  private pinnedView(
    ownerId: string,
    principal: SearchPrincipal,
    generation: number,
    pendingThrough: number,
  ): ResolvedView | null {
    const held = this.options.cache.base(ownerId, generation, principal.accessGeneration);
    if (!held) return null;
    const cached = this.options.cache.view(ownerId, `${generation}:${pendingThrough}`);
    if (!cached) return null;
    return {
      view: cached.view,
      generation,
      pendingThrough,
      complete: cached.complete,
      rebuilding: held.base === null,
      includesChat: held.base?.includeChat ?? false,
    };
  }

  /** The published index of the state's generation: from cache, or downloaded and decrypted once. */
  private async loadBase(
    principal: SearchPrincipal,
    state: OwnerState,
    key: AccountDataKey,
  ): Promise<SearchIndex | null | "reload"> {
    const ownerId = principal.userId;
    const row = state.row;
    if (!row || this.unreadable(ownerId, row)) return null;
    const held = this.options.cache.base(ownerId, row.generation, principal.accessGeneration);
    if (held?.base) return held.base;
    const flight = `${ownerId}:${row.generation}:${principal.accessGeneration}`;
    let loading = this.loads.get(flight);
    if (!loading) {
      loading = this.download(principal, row, key).finally(() => this.loads.delete(flight));
      this.loads.set(flight, loading);
    }
    const loaded = await loading;
    if (loaded === null && !this.unreadable(ownerId, row)) return "reload";
    return loaded;
  }

  private async download(
    principal: SearchPrincipal,
    row: SearchIndexRow,
    key: AccountDataKey,
  ): Promise<SearchIndex | null> {
    const ownerId = principal.userId;
    const started = this.options.now();
    const parsed = parseSearchIndexObjectKey(ownerId, row.objectKey);
    if (!parsed || parsed.generation !== row.generation) {
      this.failures.set(ownerId, { generation: row.generation, at: this.options.now() });
      return null;
    }
    let stored: Awaited<ReturnType<ObjectStore["get"]>>;
    try {
      stored = await this.options.objects.get(row.objectKey);
    } catch (error) {
      this.log.warn("search.index_download_failed", { ownerId, code: searchErrorCode(error) });
      throw new SearchServiceError("search.unavailable");
    }
    if (!stored) return null;
    try {
      const opened = openSearchIndex(
        key,
        stored.body,
        { ownerId, generation: row.generation, writeId: parsed.writeId },
        this.limits,
      );
      this.options.cache.setBase(ownerId, {
        accessGeneration: principal.accessGeneration,
        generation: row.generation,
        base: opened.index,
        bytes: opened.plaintextBytes,
      });
      this.log.info("search.index_loaded", {
        ownerId,
        generation: row.generation,
        byteCount: opened.plaintextBytes,
        durationMs: Math.max(0, this.options.now() - started),
      });
      return opened.index;
    } catch (error) {
      if (!(error instanceof SearchIndexFormatError)) throw error;
      this.failures.set(ownerId, { generation: row.generation, at: this.options.now() });
      this.log.warn("search.index_unreadable", {
        ownerId,
        generation: row.generation,
        reason: error.reason,
      });
      return null;
    }
  }

  /* ---------------------------------------------------------------------------------------------
   * Rendering with re-authorization
   * ------------------------------------------------------------------------------------------- */

  private async readTasksForRender(
    ownerId: string,
    key: AccountDataKey,
    groups: readonly RankedGroup[],
    withHeads: boolean,
  ): Promise<{
    readonly tasks: ReadonlyMap<string, SearchTaskRecord>;
    readonly heads: ReadonlyMap<string, string>;
  }> {
    if (groups.length === 0) return { tasks: new Map(), heads: new Map() };
    const taskIds = groups.map((group) => group.task.id);
    const statements: Statement[] = [
      ...this.options.sources.tasks.renderStatements(ownerId, taskIds),
    ];
    const taskStatementCount = statements.length;
    const headTaskIds = withHeads
      ? groups.filter((group) => group.sections.length > 0).map((group) => group.task.id)
      : [];
    if (headTaskIds.length > 0 && this.options.sources.documents) {
      statements.push(this.options.sources.documents.headRevisionsStatement(ownerId, headTaskIds));
    }
    const results = await this.options.db.batch(statements);
    const rows = results.slice(0, taskStatementCount).flatMap((result) => result.results);
    const tasks = this.options.sources.tasks.tasksFromRows(ownerId, rows, key);
    const heads = new Map<string, string>();
    for (const row of results[taskStatementCount]?.results ?? []) {
      if (typeof row.task_id === "string" && typeof row.revision === "string") {
        heads.set(row.task_id, row.revision);
      }
    }
    return { tasks, heads };
  }

  private summary(
    group: RankedGroup,
    fresh: ReadonlyMap<string, SearchTaskRecord>,
    query: ParsedQuery,
    filters: {
      readonly collections: ReadonlySet<SearchCollection>;
      readonly archive: SearchArchiveMode;
      readonly taskScope: ReadonlySet<string> | null;
    },
  ): { readonly task: SearchTaskSummary; readonly titleStale: boolean } | null {
    const task = fresh.get(group.task.id);
    // Index membership is not authorization: the task must still be the owner's and in scope now.
    if (!task) return null;
    if (filters.archive === "exclude" && task.archived) return null;
    if (filters.archive === "only" && !task.archived) return null;
    if (!filters.collections.has(task.collection)) return null;
    if (filters.taskScope && !filters.taskScope.has(task.id)) return null;
    const parent =
      task.parentId && (!filters.taskScope || filters.taskScope.has(task.parentId))
        ? fresh.get(task.parentId)
        : undefined;
    const title = task.title.slice(0, MAX_TITLE_CHARS);
    return {
      task: {
        id: task.id as SearchTaskSummary["id"],
        title,
        titleHighlights: highlightText(title, query, titleRules),
        collection: task.collection,
        archived: task.archived,
        parent: parent
          ? {
              id: parent.id as SearchTaskSummary["id"],
              title: parent.title.slice(0, MAX_TITLE_CHARS),
            }
          : null,
        updatedAt: task.updatedAt,
      },
      titleStale: task.version !== group.task.version || task.title !== group.task.title,
    };
  }

  private async renderGroups(
    ownerId: string,
    key: AccountDataKey,
    query: ParsedQuery,
    groups: readonly RankedGroup[],
    filters: {
      readonly collections: ReadonlySet<SearchCollection>;
      readonly archive: SearchArchiveMode;
      readonly taskScope: ReadonlySet<string> | null;
      readonly hitsPerGroup: number;
    },
  ): Promise<SearchResultGroup[]> {
    const fresh = await this.readTasksForRender(ownerId, key, groups, true);
    const items: SearchResultGroup[] = [];
    for (const group of groups) {
      const summary = this.summary(group, fresh.tasks, query, filters);
      if (!summary) continue;
      const currentRevision = fresh.heads.get(group.task.id) ?? null;
      const sections: SearchSectionHit[] = group.sections
        .slice(0, filters.hitsPerGroup)
        .map((hit) => {
          const heading =
            hit.entry.heading === null ? null : hit.entry.heading.slice(0, MAX_TITLE_CHARS);
          return {
            sectionId: hit.entry.sectionId as SearchSectionHit["sectionId"],
            ordinal: hit.entry.ordinal,
            heading,
            headingHighlights: heading === null ? [] : highlightText(heading, query, textRules),
            match: hit.match,
            snippet: buildSnippet(hit.entry.text, query, {
              rules: textRules,
              maxChars: this.limits.snippetChars,
              maxHighlights: this.limits.maxHighlights,
              precededByText: hit.entry.start > 0,
              followedByText: hit.entry.more,
            }),
            indexedRevision: hit.entry.revision,
            currentRevision,
            stale: currentRevision !== hit.entry.revision,
          };
        });
      const messages: SearchMessageHit[] = group.messages
        .slice(0, filters.hitsPerGroup)
        .map((hit) => ({
          messageId: hit.message.id as SearchMessageHit["messageId"],
          conversationId: hit.message.conversationId as SearchMessageHit["conversationId"],
          speaker: hit.message.speaker,
          createdAt: hit.message.createdAt,
          snippet: buildSnippet(hit.message.text, query, {
            rules: textRules,
            maxChars: this.limits.snippetChars,
            maxHighlights: this.limits.maxHighlights,
          }),
        }));
      items.push({
        task: summary.task,
        match: group.match,
        matchedAllTerms: group.matchedAllTerms,
        titleStale: summary.titleStale,
        sections,
        sectionCount: group.sections.length,
        messages,
        messageCount: group.messages.length,
      });
    }
    return items;
  }
}
