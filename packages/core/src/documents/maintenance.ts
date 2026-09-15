import { type DbClient, int, sql } from "@symplist/db";
import {
  DocumentOrphanCollector,
  type GitService,
  type OrphanCollectionOptions,
  type OrphanCollectionResult,
} from "@symplist/docs";
import type { ObjectStore } from "@symplist/storage";

/** Read receipts older than this are removed; no conversation keeps tool results that long. */
export const READ_RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface DocumentMaintenanceResult {
  readonly orphans: OrphanCollectionResult;
  readonly staleWorkspaces: number;
  readonly expiredRequests: number;
  readonly expiredReceipts: number;
  /** The owner the next pass continues after, or null when this pass reached the end. */
  readonly nextOwnerId: string | null;
}

/**
 * Hourly document maintenance (§8.8 cleanup, §9.1, §9.2): removes Git operation directories a crashed
 * process left behind, collects orphaned artifacts in bounded owner pages, and deletes expired
 * publication requests and old read receipts in bounded batches. Run by the api's local scheduler when
 * `DURABLE=false` and by the worker's documents maintenance schedule otherwise.
 */
export class DocumentMaintenance {
  private readonly collector: DocumentOrphanCollector;
  private cursor: string | null = null;

  constructor(
    private readonly options: {
      readonly db: DbClient;
      readonly objects: ObjectStore;
      readonly git: GitService;
      readonly orphans?: Omit<OrphanCollectionOptions, "db" | "objects">;
      readonly maxOwnersPerPass?: number;
      readonly deleteBatch?: number;
    },
  ) {
    this.collector = new DocumentOrphanCollector({
      db: options.db,
      objects: options.objects,
      ...options.orphans,
    });
  }

  async run(input: {
    readonly now: number;
    readonly afterOwnerId?: string | null;
  }): Promise<DocumentMaintenanceResult> {
    const staleWorkspaces = await this.options.git.sweepStaleWorkspaces(input.now);
    const orphans = await this.collector.sweep({
      now: input.now,
      afterOwnerId: input.afterOwnerId === undefined ? this.cursor : input.afterOwnerId,
      maxOwners: this.options.maxOwnersPerPass ?? 50,
    });
    this.cursor = orphans.nextOwnerId;
    const limit = int(this.options.deleteBatch ?? 500);
    const results = await this.options.db.batch([
      sql(
        `DELETE FROM doc_publish_requests WHERE rowid IN (
           SELECT rowid FROM doc_publish_requests WHERE expires_at <= :now LIMIT CAST(:limit AS INTEGER))`,
        { now: int(input.now), limit },
      ),
      sql(
        `DELETE FROM read_receipts WHERE rowid IN (
           SELECT rowid FROM read_receipts WHERE created_at <= :cutoff LIMIT CAST(:limit AS INTEGER))`,
        { cutoff: int(input.now - READ_RECEIPT_RETENTION_MS), limit },
      ),
    ]);
    return {
      orphans,
      staleWorkspaces,
      expiredRequests: results[0]?.meta.changes ?? 0,
      expiredReceipts: results[1]?.meta.changes ?? 0,
      nextOwnerId: orphans.nextOwnerId,
    };
  }
}
