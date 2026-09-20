/** Injection tokens of the search feature (§10.1). Tests replace them with `overrides`. */

/** The `SearchSources` built from the core search source contributors. */
export const SEARCH_SOURCES = "symplist:search.sources";

/** The process-wide `SearchIndexCache` of decrypted indexes. */
export const SEARCH_INDEX_CACHE = "symplist:search.index_cache";

/** The `SearchQueryService`. */
export const SEARCH_QUERY_SERVICE = "symplist:search.query_service";

/** The `SearchIndexWriter`; the api uses it only when `DURABLE=false`. */
export const SEARCH_INDEX_WRITER = "symplist:search.index_writer";

/** {@link SearchApiTuning} overrides. */
export const SEARCH_API_TUNING = "symplist:search.api_tuning";

/** Timings of the api's index scheduling; production uses the defaults. */
export interface SearchApiTuning {
  /** Local mode: how long after a change the in-process writer runs (the producers' `delay: '30s'`). */
  readonly localDelayMs: number;
  /** Local mode: how often pending intents are swept (while the local scheduler runs). */
  readonly sweepIntervalMs: number;
  /** Local mode: intents older than this are picked up by the sweep. */
  readonly sweepAgeMs: number;
  /** Local mode: owners handled per sweep. */
  readonly sweepOwners: number;
  /** Local mode: writer batches per owner run before yielding to the next run. */
  readonly batchesPerRun: number;
  /** Local mode: the longest backoff after failing runs. */
  readonly maxRetryDelayMs: number;
  /** How often idle decrypted indexes are dropped. */
  readonly cacheSweepIntervalMs: number;
  /** The decrypted index cache bound. */
  readonly cacheMaxBytes: number;
}

export const DEFAULT_SEARCH_API_TUNING: SearchApiTuning = Object.freeze({
  localDelayMs: 30_000,
  sweepIntervalMs: 30_000,
  sweepAgeMs: 30_000,
  sweepOwners: 25,
  batchesPerRun: 10,
  maxRetryDelayMs: 10 * 60_000,
  cacheSweepIntervalMs: 60_000,
  cacheMaxBytes: 128 * 1024 * 1024,
});
