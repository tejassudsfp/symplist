import { Controller, Get, Inject, Query } from "@nestjs/common";
import {
  type SearchFreshness,
  type SearchRequestQuery,
  type SearchResponse,
  type SearchTitleQuery,
  type SearchTitleResponse,
  searchDeadlineFilterOf,
  searchRequestQuerySchema,
  searchTitleQuerySchema,
} from "@symplist/contracts";
import type { SessionContext } from "@symplist/core/access";
import {
  type SearchPrincipal,
  type SearchQueryService,
  SearchServiceError,
  type SearchServiceResult,
} from "@symplist/core/search";
import { Access, CurrentSession } from "../../common/access.decorator.ts";
import { ApiError } from "../../common/errors/api-error.ts";
import { RouteClass } from "../../common/route-classes.ts";
import { SEARCH_QUERY_SERVICE } from "./search.tokens.ts";
import { SearchIndexCoordinator } from "./search-index.coordinator.ts";

/** Search messages; they never name the query, the index or other users (§6). */
const messages: Readonly<Record<SearchServiceError["code"], string>> = {
  "search.cursor_stale": "The results changed; search again from the first page",
  "search.cursor_invalid": "The results cursor is not valid for this search",
  "search.filter_unavailable": "This filter is not available yet",
  "search.unavailable": "Search is temporarily unavailable; try again",
};

function principalOf(session: SessionContext): SearchPrincipal {
  return { userId: session.userId, accessGeneration: session.access.accessGeneration };
}

/**
 * Full search, the command palette's quick title search and index freshness (§10.1, note 14). Every
 * route needs an admitted session, so locked, relocked or suspended accounts retrieve nothing through
 * search or the palette; results are re-authorized against D1 when rendered. GET routes in the `app`
 * class need no CSRF token and have no side effects beyond asking the index writer to run.
 */
@Controller("search")
@RouteClass("app")
export class SearchController {
  constructor(
    @Inject(SEARCH_QUERY_SERVICE) private readonly queries: SearchQueryService,
    @Inject(SearchIndexCoordinator) private readonly coordinator: SearchIndexCoordinator,
  ) {}

  @Get()
  @Access("admitted")
  search(
    @CurrentSession() session: SessionContext,
    @Query({ schema: searchRequestQuerySchema }) query: SearchRequestQuery,
  ): Promise<SearchResponse> {
    return this.answer(session, () =>
      this.queries.search(principalOf(session), {
        q: query.q,
        ...(query.collections ? { collections: query.collections } : {}),
        ...(query.archive ? { archive: query.archive } : {}),
        ...(query.types ? { types: query.types } : {}),
        taskId: query.taskId ?? null,
        deadline: searchDeadlineFilterOf(query),
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(query.limit ? { limit: query.limit } : {}),
      }),
    );
  }

  @Get("titles")
  @Access("admitted")
  titles(
    @CurrentSession() session: SessionContext,
    @Query({ schema: searchTitleQuerySchema }) query: SearchTitleQuery,
  ): Promise<SearchTitleResponse> {
    return this.answer(session, () =>
      this.queries.titles(principalOf(session), {
        q: query.q,
        ...(query.archive ? { archive: query.archive } : {}),
        ...(query.limit ? { limit: query.limit } : {}),
      }),
    );
  }

  @Get("freshness")
  @Access("admitted")
  freshness(@CurrentSession() session: SessionContext): Promise<SearchFreshness> {
    return this.answer(session, () => this.queries.freshness(principalOf(session)));
  }

  private async answer<Response>(
    session: SessionContext,
    run: () => Promise<SearchServiceResult<Response>>,
  ): Promise<Response> {
    let result: SearchServiceResult<Response>;
    try {
      result = await run();
    } catch (error) {
      if (error instanceof SearchServiceError) {
        throw new ApiError(error.code, {
          message: messages[error.code],
          ...(error.details ? { details: { ...error.details } } : {}),
        });
      }
      throw error;
    }
    this.coordinator.noteActivity();
    if (result.indexing === "rebuild") this.coordinator.request(session.userId, "rebuild");
    else if (result.indexing === "stale") this.coordinator.request(session.userId, "stale");
    return result.response;
  }
}
