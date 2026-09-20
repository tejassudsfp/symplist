import {
  Inject,
  Injectable,
  Module,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { onPreferenceCommitted } from "@symplist/core/preferences";
import {
  createSearchSources,
  DEFAULT_SEARCH_CACHE_IDLE_MS,
  onSearchIndexRequested,
  pendingSummaryFromDb,
  pendingSummaryStatement,
  SEARCH_INDEX_PUBLISHED_EVENT,
  SearchIndexCache,
  SearchIndexWriter,
  SearchQueryService,
  type SearchSources,
  searchIndexRowFromDb,
  searchIndexRowStatement,
} from "@symplist/core/search";
import type { KeyProvider } from "@symplist/crypto";
import type { DbClient } from "@symplist/db";
import type { ObjectStore } from "@symplist/storage";
import { RestrictionEffectRegistry } from "../../common/access/access.providers.ts";
import { CLOCK, type Clock } from "../../common/clock.ts";
import { AppLogger } from "../../common/logging/logger.ts";
import { appOperationalLog } from "../../common/logging/operational-log.ts";
import { KEY_PROVIDER } from "../../infra/crypto/crypto.providers.ts";
import { DB_CLIENT } from "../../infra/db/db.providers.ts";
import { OBJECT_STORE } from "../../infra/storage/storage.providers.ts";
import { InternalEventHandlerRegistry } from "../internal/internal-event-handlers.ts";
import { SearchController } from "./search.controller.ts";
import {
  DEFAULT_SEARCH_API_TUNING,
  SEARCH_API_TUNING,
  SEARCH_INDEX_CACHE,
  SEARCH_INDEX_WRITER,
  SEARCH_QUERY_SERVICE,
  SEARCH_SOURCES,
  type SearchApiTuning,
} from "./search.tokens.ts";
import { SearchIndexCoordinator } from "./search-index.coordinator.ts";

/**
 * Registers the search feature with the platform: the restriction effect that drops a user's decrypted
 * index and scheduled work after relock, suspension, campaign revocation or account deletion (§5.5,
 * §10.1), and the handler of the worker's `search.index_published` announcement (§6.2), which re-reads
 * the owner's generation from D1 before publishing `search.freshness`.
 */
@Injectable()
export class SearchRegistration implements OnModuleInit, OnModuleDestroy {
  private stopRequests: (() => void) | undefined;
  private stopPreferences: (() => void) | undefined;
  constructor(
    @Inject(DB_CLIENT) private readonly db: DbClient,
    @Inject(SEARCH_QUERY_SERVICE) private readonly queries: SearchQueryService,
    @Inject(SearchIndexCoordinator) private readonly coordinator: SearchIndexCoordinator,
    @Inject(RestrictionEffectRegistry)
    private readonly restrictionEffects: RestrictionEffectRegistry,
    @Inject(InternalEventHandlerRegistry)
    private readonly internalEvents: InternalEventHandlerRegistry,
    private readonly logger: AppLogger,
  ) {}

  onModuleInit(): void {
    this.stopRequests = onSearchIndexRequested(this.db, ({ ownerId, reason }) =>
      this.coordinator.request(ownerId, reason),
    );
    this.stopPreferences = onPreferenceCommitted(this.db, (event) => {
      if (event.group !== "privacy") return;
      // The next read must not reuse either the old opt-in or its index-state snapshot. Rebuilding
      // removes previously indexed chat immediately after an opt-out and adds it after an opt-in.
      this.queries.invalidateChatOptIn(event.ownerId);
      this.queries.invalidateState(event.ownerId);
      this.coordinator.request(event.ownerId, "rebuild");
    });
    this.restrictionEffects.register({
      name: "search_cache_eviction",
      afterCommit: async (event) => {
        this.queries.evictOwner(
          event.userId,
          event.reason === "deleted" ? "deleted" : "restricted",
        );
        this.coordinator.forget(event.userId);
      },
    });
    this.internalEvents.register({
      type: SEARCH_INDEX_PUBLISHED_EVENT,
      handle: async (event) => {
        // The payload is an untrusted hint (§6.2): the generation and pending count come from D1.
        const results = await this.db.batch([
          searchIndexRowStatement(event.ownerId),
          pendingSummaryStatement(event.ownerId),
        ]);
        const row = searchIndexRowFromDb(results[0]?.results[0]);
        if (!row) {
          this.logger.warn("search.published_event_without_index", { ownerId: event.ownerId });
          return;
        }
        const summary = pendingSummaryFromDb(results[1]?.results[0]);
        this.queries.invalidateState(event.ownerId);
        await this.coordinator.announceFreshness(event.ownerId, {
          generation: row.generation,
          pending: summary.pending,
        });
      },
    });
  }
  onModuleDestroy(): void {
    this.stopRequests?.();
    this.stopPreferences?.();
  }
}

/** The search feature (§10.1, §10.2): controllers, the query service, the index writer and its scheduling. */
@Module({
  controllers: [SearchController],
  providers: [
    { provide: SEARCH_API_TUNING, useValue: DEFAULT_SEARCH_API_TUNING },
    {
      provide: SEARCH_SOURCES,
      inject: [DB_CLIENT, OBJECT_STORE, KEY_PROVIDER, API_CONFIG, AppLogger],
      useFactory: (
        db: DbClient,
        objects: ObjectStore,
        keys: KeyProvider,
        config: ApiConfig,
        logger: AppLogger,
      ) =>
        createSearchSources({
          db,
          objects,
          keys,
          accessPolicy: { betaAccessRequired: config.BETA_ACCESS_REQUIRED },
          log: appOperationalLog(logger),
        }),
    },
    {
      provide: SEARCH_INDEX_CACHE,
      inject: [CLOCK, AppLogger, SEARCH_API_TUNING],
      useFactory: (clock: Clock, logger: AppLogger, tuning: SearchApiTuning) =>
        new SearchIndexCache({
          now: () => clock.now(),
          maxBytes: tuning.cacheMaxBytes,
          idleMs: DEFAULT_SEARCH_CACHE_IDLE_MS,
          log: appOperationalLog(logger),
        }),
    },
    {
      provide: SEARCH_QUERY_SERVICE,
      inject: [
        DB_CLIENT,
        OBJECT_STORE,
        KEY_PROVIDER,
        SEARCH_SOURCES,
        SEARCH_INDEX_CACHE,
        CLOCK,
        AppLogger,
      ],
      useFactory: (
        db: DbClient,
        objects: ObjectStore,
        keys: KeyProvider,
        sources: SearchSources,
        cache: SearchIndexCache,
        clock: Clock,
        logger: AppLogger,
      ) =>
        new SearchQueryService({
          db,
          objects,
          keys,
          sources,
          cache,
          now: () => clock.now(),
          log: appOperationalLog(logger),
        }),
    },
    {
      provide: SEARCH_INDEX_WRITER,
      inject: [DB_CLIENT, OBJECT_STORE, KEY_PROVIDER, SEARCH_SOURCES, CLOCK, AppLogger],
      useFactory: (
        db: DbClient,
        objects: ObjectStore,
        keys: KeyProvider,
        sources: SearchSources,
        clock: Clock,
        logger: AppLogger,
      ) =>
        new SearchIndexWriter({
          db,
          objects,
          keys,
          sources,
          now: () => clock.now(),
          log: appOperationalLog(logger),
        }),
    },
    SearchIndexCoordinator,
    SearchRegistration,
  ],
})
export class SearchModule {}
