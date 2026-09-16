import type { KeyProvider } from "@symplist/crypto";
import { unwrapAccountKey, zeroize } from "@symplist/crypto";
import {
  type DbClient,
  DbUnknownOutcomeError,
  int,
  type Statement,
  sql,
  uuidv7,
  verifiedRow,
} from "@symplist/db";
import {
  INDEX_FORMAT_VERSION,
  openSearchIndex,
  parseSearchIndexObjectKey,
  SEARCH_LIMITS,
  SearchIndex,
  SearchIndexFormatError,
  type SearchLimits,
  sealSearchIndex,
  searchIndexObjectPrefix,
  TOKENIZER_FINGERPRINT,
} from "@symplist/search";
import type { ObjectStore } from "@symplist/storage";
import { WRITE_ID_METADATA_KEY } from "@symplist/storage";
import { applyIntents, loadAllRecords } from "./apply.ts";
import {
  coalesceIntents,
  pendingIntentsStatement,
  pendingSummaryStatement,
  searchIntentFromRow,
} from "./intents.ts";
import { type SearchLog, searchErrorCode, silentSearchLog } from "./log.ts";
import type { SearchSources } from "./sources/types.ts";
import {
  pendingSummaryFromDb,
  type SearchIndexRow,
  searchIndexRowFromDb,
  searchIndexRowStatement,
} from "./state.ts";

/** Which runtime writes the index: the api when `DURABLE=false`, the worker when true (§10.1). */
export type SearchWriterMode = "local" | "durable";

export interface SearchIndexWriterOptions {
  readonly db: DbClient;
  readonly objects: ObjectStore;
  readonly keys: KeyProvider;
  readonly sources: SearchSources;
  readonly now: () => number;
  readonly log?: SearchLog;
  /** Intents applied per run; the rest stay pending for the next run. Defaults to 200. */
  readonly batchLimit?: number;
  /** Stale index objects deleted per successful run. Defaults to 20. */
  readonly sweepLimit?: number;
  readonly limits?: Partial<SearchLimits>;
}

export interface SearchIndexRunInput {
  readonly mode: SearchWriterMode;
  /**
   * The executor generation the caller was started under (the local scheduler's firing). When given, a
   * different current generation skips the run; the publication is always guarded by the generation
   * read in the run's first batch.
   */
  readonly executorGeneration?: number;
  readonly signal?: AbortSignal;
}

export type SearchIndexRunOutcome =
  | {
      readonly status: "published";
      readonly generation: number;
      readonly appliedThrough: number;
      /** Unapplied intents left after this publication. */
      readonly pending: number;
      readonly rebuilt: boolean;
      readonly intentCount: number;
      readonly byteSize: number;
    }
  | { readonly status: "up_to_date"; readonly generation: number }
  /** Another writer published first; nothing of this run remains. Run again. */
  | { readonly status: "conflict" }
  | {
      readonly status: "skipped";
      readonly reason: "executor_mode" | "executor_generation" | "account_unavailable";
    };

type RebuildReason =
  | "missing"
  | "object_missing"
  | "format_version"
  | "fingerprint"
  | "owner"
  | "generation"
  | "decryption"
  | "malformed"
  | "chat_opt_in";

/**
 * The single index writer of a mode (§10.1): loads the published generation g, applies a bounded batch
 * of pending intents (or rebuilds from authoritative records when the index is missing, corrupt, from
 * another format or tokenizer, or the chat opt-in changed), uploads `u/<ownerId>/search/<g+1>-<writeId>.idx`
 * with `If-None-Match: *`, and advances `search_indexes` with a generation compare-and-set guarded by
 * the executor mode and generation and by the account still existing. Applied intents are deleted in
 * the same batch. A writer that loses the race deletes its own object and reports `conflict`.
 */
export class SearchIndexWriter {
  private readonly log: SearchLog;
  private readonly batchLimit: number;
  private readonly sweepLimit: number;
  private readonly limits: SearchLimits;

  constructor(private readonly options: SearchIndexWriterOptions) {
    this.log = options.log ?? silentSearchLog;
    this.batchLimit = options.batchLimit ?? 200;
    this.sweepLimit = options.sweepLimit ?? 20;
    this.limits = { ...SEARCH_LIMITS, ...options.limits };
    if (!Number.isSafeInteger(this.batchLimit) || this.batchLimit < 1) {
      throw new RangeError("batchLimit must be a positive integer");
    }
  }

  async run(ownerId: string, input: SearchIndexRunInput): Promise<SearchIndexRunOutcome> {
    const { db, keys, sources } = this.options;
    const started = this.options.now();
    const results = await db.batch([
      sql(`SELECT mode, generation FROM executor_state WHERE id = 1`),
      searchIndexRowStatement(ownerId),
      pendingIntentsStatement(ownerId, this.batchLimit),
      pendingSummaryStatement(ownerId),
      sql(`SELECT owner_id, kek_version, wrapped_key FROM account_keys WHERE owner_id = :owner`, {
        owner: ownerId,
      }),
      sql(`SELECT deletion_state FROM users WHERE id = :owner`, { owner: ownerId }),
    ]);
    const executor = results[0]?.results[0];
    const expectedMode = input.mode;
    if (executor?.mode !== expectedMode) return { status: "skipped", reason: "executor_mode" };
    const executorGeneration = Number(executor.generation);
    if (input.executorGeneration !== undefined && input.executorGeneration !== executorGeneration) {
      return { status: "skipped", reason: "executor_generation" };
    }
    const keyRow = results[4]?.results[0];
    const user = results[5]?.results[0];
    if (!keyRow || user?.deletion_state !== "none") {
      return { status: "skipped", reason: "account_unavailable" };
    }
    const row = searchIndexRowFromDb(results[1]?.results[0]);
    const intents = (results[2]?.results ?? []).map(searchIntentFromRow);
    const summary = pendingSummaryFromDb(results[3]?.results[0]);

    const key = unwrapAccountKey(keys, {
      ownerId,
      kekVersion: Number(keyRow.kek_version),
      wrapped: String(keyRow.wrapped_key),
    });
    try {
      input.signal?.throwIfAborted();
      const includeChat = sources.chatOptIn
        ? await sources.chatOptIn.includeChat(ownerId, key)
        : false;
      const loaded = await this.load(ownerId, row, key, includeChat);
      if ("index" in loaded && intents.length === 0) {
        return { status: "up_to_date", generation: (row as SearchIndexRow).generation };
      }

      let index: SearchIndex;
      let appliedThrough: number;
      let rebuilt: boolean;
      if ("index" in loaded) {
        index = loaded.index;
        appliedThrough = (intents[intents.length - 1] as { id: number }).id;
        rebuilt = false;
        await applyIntents(index, coalesceIntents(intents), {
          ownerId,
          key,
          sources,
          includeChat,
        });
      } else {
        this.log.info("search.index_rebuild", {
          ownerId,
          reason: loaded.rebuild,
          generation: row?.generation ?? 0,
        });
        index = SearchIndex.create({ ownerId, includeChat, limits: this.limits });
        // Everything committed up to the highest intent read in the first batch is covered: the
        // records below are read afterwards, and later intents are applied by the next run.
        appliedThrough = Math.max(summary.maxId, row?.appliedThrough ?? 0);
        rebuilt = true;
        await loadAllRecords(index, {
          ownerId,
          key,
          sources,
          includeChat,
          ...(input.signal ? { signal: input.signal } : {}),
        });
      }
      input.signal?.throwIfAborted();
      return await this.publish(ownerId, {
        index,
        key,
        row,
        appliedThrough,
        rebuilt,
        intentCount: rebuilt ? summary.pending : intents.length,
        executorGeneration,
        mode: expectedMode,
        started,
      });
    } finally {
      zeroize(key.key);
    }
  }

  private async load(
    ownerId: string,
    row: SearchIndexRow | null,
    key: Parameters<typeof openSearchIndex>[0],
    includeChat: boolean,
  ): Promise<{ readonly index: SearchIndex } | { readonly rebuild: RebuildReason }> {
    if (!row) return { rebuild: "missing" };
    if (row.indexFormatVersion !== INDEX_FORMAT_VERSION) return { rebuild: "format_version" };
    if (row.tokenizerFingerprint !== TOKENIZER_FINGERPRINT) return { rebuild: "fingerprint" };
    if (row.includeChat !== includeChat) return { rebuild: "chat_opt_in" };
    const parsed = parseSearchIndexObjectKey(ownerId, row.objectKey);
    if (!parsed || parsed.generation !== row.generation) return { rebuild: "malformed" };
    const stored = await this.options.objects.get(row.objectKey);
    if (!stored) return { rebuild: "object_missing" };
    try {
      const opened = openSearchIndex(
        key,
        stored.body,
        { ownerId, generation: row.generation, writeId: parsed.writeId },
        this.limits,
      );
      return { index: opened.index };
    } catch (error) {
      if (error instanceof SearchIndexFormatError) {
        this.log.warn("search.index_unreadable", {
          ownerId,
          generation: row.generation,
          reason: error.reason,
        });
        return { rebuild: error.reason };
      }
      throw error;
    }
  }

  private async publish(
    ownerId: string,
    input: {
      readonly index: SearchIndex;
      readonly key: Parameters<typeof sealSearchIndex>[0];
      readonly row: SearchIndexRow | null;
      readonly appliedThrough: number;
      readonly rebuilt: boolean;
      readonly intentCount: number;
      readonly executorGeneration: number;
      readonly mode: SearchWriterMode;
      readonly started: number;
    },
  ): Promise<SearchIndexRunOutcome> {
    const { db, objects } = this.options;
    const now = this.options.now();
    const generation = (input.row?.generation ?? 0) + 1;
    const writeId = uuidv7(now);
    const sealed = await sealSearchIndex(input.key, input.index, {
      generation,
      appliedThrough: input.appliedThrough,
      writeId,
    });
    const put = await objects.put({
      key: sealed.key,
      body: sealed.body,
      contentType: "application/octet-stream",
      ifNoneMatch: "*",
      metadata: { [WRITE_ID_METADATA_KEY]: writeId },
    });
    if (put.status !== "created") {
      // A key with a fresh write id cannot exist; treat it as a lost race and leave it alone.
      this.log.warn("search.index_object_exists", { ownerId, generation });
      return { status: "conflict" };
    }

    const truncated = input.index.truncated;
    const guards = `EXISTS (SELECT 1 FROM executor_state WHERE id = 1 AND mode = :mode AND generation = :executor_generation)
       AND EXISTS (SELECT 1 FROM users WHERE id = :owner AND deletion_state = 'none')`;
    const params = {
      owner: ownerId,
      generation: int(generation),
      applied: int(input.appliedThrough),
      format: int(INDEX_FORMAT_VERSION),
      fingerprint: TOKENIZER_FINGERPRINT,
      object_key: sealed.key,
      include_chat: int(input.index.includeChat ? 1 : 0),
      truncated: int(truncated ? 1 : 0),
      bytes: int(sealed.plaintextBytes),
      mode: input.mode,
      executor_generation: int(input.executorGeneration),
      now: int(now),
      w: writeId,
    };
    const deciding: Statement = input.row
      ? sql(
          `UPDATE search_indexes
           SET generation = :generation, applied_through = :applied, index_format_version = :format,
               tokenizer_fingerprint = :fingerprint, object_key = :object_key,
               include_chat = :include_chat, truncated = :truncated, byte_size = :bytes,
               executor_generation = :executor_generation, updated_at = :now, write_id = :w
           WHERE owner_id = :owner AND generation = :previous AND ${guards}`,
          { ...params, previous: int(input.row.generation) },
        )
      : sql(
          `INSERT INTO search_indexes (owner_id, generation, applied_through, index_format_version,
             tokenizer_fingerprint, object_key, include_chat, truncated, byte_size,
             executor_generation, created_at, updated_at, write_id)
           SELECT :owner, :generation, :applied, :format, :fingerprint, :object_key, :include_chat,
                  :truncated, :bytes, :executor_generation, :now, :now, :w
           WHERE NOT EXISTS (SELECT 1 FROM search_indexes WHERE owner_id = :owner) AND ${guards}
           ON CONFLICT (owner_id) DO NOTHING`,
          params,
        );
    const statements: Statement[] = [
      deciding,
      sql(
        `DELETE FROM search_intents WHERE owner_id = :owner AND id <= :applied
           AND EXISTS (SELECT 1 FROM search_indexes WHERE owner_id = :owner AND write_id = :w)`,
        { owner: ownerId, applied: int(input.appliedThrough), w: writeId },
      ),
      sql(
        `SELECT COUNT(*) AS pending FROM search_intents
         WHERE owner_id = :owner AND id > :applied`,
        { owner: ownerId, applied: int(input.appliedThrough) },
      ),
      sql(`SELECT generation FROM search_indexes WHERE owner_id = :owner AND write_id = :w`, {
        owner: ownerId,
        w: writeId,
      }),
    ];

    let committed: boolean;
    let pending = 0;
    try {
      const results = await db.batch(statements);
      committed = verifiedRow(results) !== null;
      pending = Number(results[2]?.results[0]?.pending ?? 0);
    } catch (error) {
      if (!(error instanceof DbUnknownOutcomeError)) {
        await this.deleteObject(sealed.key, ownerId);
        throw error;
      }
      // Writes are never retried (§3.1): the outcome is reconciled by reading the write id back.
      const reread = await db.batch([
        sql(`SELECT write_id FROM search_indexes WHERE owner_id = :owner`, { owner: ownerId }),
        sql(
          `SELECT COUNT(*) AS pending FROM search_intents WHERE owner_id = :owner AND id > :applied`,
          {
            owner: ownerId,
            applied: int(input.appliedThrough),
          },
        ),
      ]);
      committed = reread[0]?.results[0]?.write_id === writeId;
      pending = Number(reread[1]?.results[0]?.pending ?? 0);
    }

    if (!committed) {
      await this.deleteObject(sealed.key, ownerId);
      this.log.info("search.index_conflict", { ownerId, generation });
      return { status: "conflict" };
    }
    await this.sweep(ownerId, generation, sealed.key);
    this.log.info("search.index_published", {
      ownerId,
      generation,
      isRebuild: input.rebuilt,
      intentCount: input.intentCount,
      pendingCount: pending,
      byteCount: sealed.plaintextBytes,
      isTruncated: truncated,
      durationMs: Math.max(0, this.options.now() - input.started),
    });
    return {
      status: "published",
      generation,
      appliedThrough: input.appliedThrough,
      pending,
      rebuilt: input.rebuilt,
      intentCount: input.intentCount,
      byteSize: sealed.plaintextBytes,
    };
  }

  private async deleteObject(key: string, ownerId: string): Promise<void> {
    try {
      await this.options.objects.delete(key);
    } catch (error) {
      // The orphan sweep of a later publication removes it.
      this.log.warn("search.index_object_delete_failed", { ownerId, code: searchErrorCode(error) });
    }
  }

  /**
   * Deletes index objects of this owner up to the published generation other than the published one:
   * the previous generation and objects left by writers that crashed or lost a race. Objects of later
   * generations may belong to a writer still running and are never touched.
   */
  private async sweep(ownerId: string, generation: number, keep: string): Promise<void> {
    try {
      const listed = await this.options.objects.list({
        prefix: searchIndexObjectPrefix(ownerId),
        limit: 1000,
      });
      let deleted = 0;
      for (const object of listed.objects) {
        if (deleted >= this.sweepLimit) break;
        if (object.key === keep) continue;
        const parsed = parseSearchIndexObjectKey(ownerId, object.key);
        if (!parsed || parsed.generation > generation) continue;
        await this.options.objects.delete(object.key);
        deleted += 1;
      }
      if (deleted > 0) this.log.info("search.index_objects_swept", { ownerId, count: deleted });
    } catch (error) {
      this.log.warn("search.index_sweep_failed", { ownerId, code: searchErrorCode(error) });
    }
  }
}
