import { type DbClient, int, sql } from "@symplist/db";
import type { ObjectHead, ObjectStore } from "@symplist/storage";
import {
  bundlePrefix,
  parseBundleObjectKey,
  parseSnapshotObjectKey,
  snapshotPrefix,
} from "../artifacts/keys.ts";

/** Bounds and retention of orphan collection (§9.2, note 11 step 7). */
export interface OrphanCollectionOptions {
  readonly db: DbClient;
  readonly objects: ObjectStore;
  /**
   * Objects younger than this are never touched: a publication uploads, then publishes within its
   * time limit (minutes), and refuses to publish uploads older than half of this.
   */
  readonly graceMs?: number;
  /** Published bundles kept besides the head, for recovery from a damaged head bundle. */
  readonly keepBundles?: number;
  /** Object deletions per invocation. */
  readonly maxDeletes?: number;
  /** List pages read per prefix per owner. */
  readonly maxListPages?: number;
  /** Job objects (`u/<ownerId>/jobs/…`) older than this are removed (§8.3). */
  readonly jobRetentionMs?: number;
}

export const ORPHAN_COLLECTION_DEFAULTS = Object.freeze({
  graceMs: 60 * 60 * 1000,
  keepBundles: 3,
  maxDeletes: 200,
  maxListPages: 10,
  jobRetentionMs: 24 * 60 * 60 * 1000,
});

export interface OrphanCollectionResult {
  readonly deletedBundles: number;
  readonly deletedSnapshots: number;
  readonly deletedJobs: number;
  /** False when a bound stopped the pass before every candidate was examined. */
  readonly complete: boolean;
}

const zero: OrphanCollectionResult = Object.freeze({
  deletedBundles: 0,
  deletedSnapshots: 0,
  deletedJobs: 0,
  complete: true,
});

/**
 * Collects unreferenced document artifacts only after a grace period and an authoritative
 * reachability check in D1 (§9.2, note 11 step 7):
 *
 * - a snapshot is kept while any `doc_commits` row names it (reads at older revisions need it);
 * - a bundle is kept while it is the head bundle or one of the last `keepBundles` published bundles,
 *   or while the publication that superseded it is younger than the grace period; every bundle holds
 *   the complete history, so collecting a superseded one never loses history;
 * - objects never published (a crash after upload, a lost race) are deleted once older than the grace.
 *
 * D1 is read after the listing, so an object published between listing and reading is seen as
 * referenced. Deletes use one `DeleteObject` per key (§1).
 */
export class DocumentOrphanCollector {
  private readonly db: DbClient;
  private readonly objects: ObjectStore;
  private readonly graceMs: number;
  private readonly keepBundles: number;
  private readonly maxDeletes: number;
  private readonly maxListPages: number;
  private readonly jobRetentionMs: number;

  constructor(options: OrphanCollectionOptions) {
    this.db = options.db;
    this.objects = options.objects;
    this.graceMs = options.graceMs ?? ORPHAN_COLLECTION_DEFAULTS.graceMs;
    this.keepBundles = options.keepBundles ?? ORPHAN_COLLECTION_DEFAULTS.keepBundles;
    this.maxDeletes = options.maxDeletes ?? ORPHAN_COLLECTION_DEFAULTS.maxDeletes;
    this.maxListPages = options.maxListPages ?? ORPHAN_COLLECTION_DEFAULTS.maxListPages;
    this.jobRetentionMs = options.jobRetentionMs ?? ORPHAN_COLLECTION_DEFAULTS.jobRetentionMs;
  }

  /** How long a publication may hold uploads before publishing them (half the grace period). */
  get maxUploadAgeMs(): number {
    return Math.floor(this.graceMs / 2);
  }

  private async listAll(
    prefix: string,
  ): Promise<{ readonly objects: ObjectHead[]; readonly complete: boolean }> {
    const objects: ObjectHead[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < this.maxListPages; page += 1) {
      const result = await this.objects.list({
        prefix,
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      });
      objects.push(...result.objects);
      if (!result.cursor) return { objects, complete: true };
      cursor = result.cursor;
    }
    return { objects, complete: false };
  }

  /** Collects one owner's orphaned bundles, snapshots and expired job objects. */
  async collectOwner(ownerId: string, now: number): Promise<OrphanCollectionResult> {
    const cutoff = now - this.graceMs;
    const bundles = await this.listAll(`u/${ownerId}/bundles/`);
    const snapshots = await this.listAll(`u/${ownerId}/docs/`);
    const jobs = await this.listAll(`u/${ownerId}/jobs/`);
    let complete = bundles.complete && snapshots.complete && jobs.complete;
    const old = (object: ObjectHead, before: number) =>
      typeof object.uploadedAt === "number" && object.uploadedAt < before;

    const tasks = new Map<string, { bundles: ObjectHead[]; snapshots: ObjectHead[] }>();
    const entry = (taskId: string) => {
      let value = tasks.get(taskId);
      if (!value) {
        value = { bundles: [], snapshots: [] };
        tasks.set(taskId, value);
      }
      return value;
    };
    for (const object of bundles.objects) {
      const ref = parseBundleObjectKey(object.key);
      if (ref && ref.ownerId === ownerId && old(object, cutoff))
        entry(ref.taskId).bundles.push(object);
    }
    for (const object of snapshots.objects) {
      const ref = parseSnapshotObjectKey(object.key);
      if (ref && ref.ownerId === ownerId && old(object, cutoff))
        entry(ref.taskId).snapshots.push(object);
    }

    let deletedBundles = 0;
    let deletedSnapshots = 0;
    let deletedJobs = 0;
    const budget = () => deletedBundles + deletedSnapshots + deletedJobs < this.maxDeletes;
    for (const [taskId, candidates] of tasks) {
      if (!budget()) {
        complete = false;
        break;
      }
      const referenced = await this.referencedKeys(ownerId, taskId, now, candidates);
      for (const object of [...candidates.bundles, ...candidates.snapshots]) {
        if (referenced.has(object.key)) continue;
        if (!budget()) {
          complete = false;
          break;
        }
        if (
          !object.key.startsWith(bundlePrefix(ownerId, taskId)) &&
          !object.key.startsWith(snapshotPrefix(ownerId, taskId))
        ) {
          continue;
        }
        await this.objects.delete(object.key);
        if (object.key.includes("/bundles/")) deletedBundles += 1;
        else deletedSnapshots += 1;
      }
    }
    for (const object of jobs.objects) {
      if (!old(object, now - this.jobRetentionMs)) continue;
      if (!budget()) {
        complete = false;
        break;
      }
      await this.objects.delete(object.key);
      deletedJobs += 1;
    }
    return { deletedBundles, deletedSnapshots, deletedJobs, complete };
  }

  /** The candidate keys D1 still references for one task, read in one batch after listing. */
  private async referencedKeys(
    ownerId: string,
    taskId: string,
    now: number,
    candidates: {
      readonly bundles: readonly ObjectHead[];
      readonly snapshots: readonly ObjectHead[];
    },
  ): Promise<Set<string>> {
    const statements = [
      sql(
        `SELECT bundle_key, generation FROM doc_repos WHERE task_id = :task AND owner_id = :owner`,
        {
          task: taskId,
          owner: ownerId,
        },
      ),
    ];
    const chunks = (keys: readonly string[]) => {
      const out: string[][] = [];
      for (let index = 0; index < keys.length; index += 80) out.push(keys.slice(index, index + 80));
      return out;
    };
    const bundleChunks = chunks(candidates.bundles.map((object) => object.key));
    const snapshotChunks = chunks(candidates.snapshots.map((object) => object.key));
    for (const keys of bundleChunks) {
      statements.push(
        sql(
          `SELECT c.bundle_key AS key, c.generation AS generation,
             (SELECT n.published_at FROM doc_commits n
               WHERE n.task_id = c.task_id AND n.generation = c.generation + CAST(:keep AS INTEGER) + 1) AS superseded_at
           FROM doc_commits c
           WHERE c.task_id = :task AND c.owner_id = :owner AND c.bundle_key IN (:keys)`,
          { task: taskId, owner: ownerId, keep: int(this.keepBundles), keys },
        ),
      );
    }
    for (const keys of snapshotChunks) {
      statements.push(
        sql(
          `SELECT snapshot_key AS key FROM doc_commits
           WHERE task_id = :task AND owner_id = :owner AND snapshot_key IN (:keys)`,
          { task: taskId, owner: ownerId, keys },
        ),
      );
    }
    const results = await this.db.batch(statements);
    const referenced = new Set<string>();
    const head = results[0]?.results[0];
    if (head) referenced.add(head.bundle_key as string);
    const headGeneration = typeof head?.generation === "number" ? head.generation : 0;
    results.slice(1, 1 + bundleChunks.length).forEach((result) => {
      for (const row of result.results) {
        const generation = row.generation as number;
        const supersededAt = row.superseded_at as number | null;
        const recent = generation >= headGeneration - this.keepBundles;
        const supersededRecently = supersededAt === null || supersededAt >= now - this.graceMs;
        if (recent || supersededRecently) referenced.add(row.key as string);
      }
    });
    results.slice(1 + bundleChunks.length).forEach((result) => {
      for (const row of result.results) referenced.add(row.key as string);
    });
    return referenced;
  }

  /**
   * One bounded pass over owners in id order, starting after `afterOwnerId`. Returns the last owner
   * examined, or null when the pass reached the end.
   */
  async sweep(input: {
    readonly now: number;
    readonly afterOwnerId?: string | null;
    readonly maxOwners?: number;
  }): Promise<OrphanCollectionResult & { readonly nextOwnerId: string | null }> {
    const limit = input.maxOwners ?? 50;
    const owners = await this.db.all<{ id: string }>(
      sql(`SELECT id FROM users WHERE id > :after ORDER BY id LIMIT CAST(:limit AS INTEGER)`, {
        after: input.afterOwnerId ?? "",
        limit: int(limit),
      }),
    );
    let total = { ...zero };
    for (const { id } of owners) {
      const result = await this.collectOwner(id, input.now);
      total = {
        deletedBundles: total.deletedBundles + result.deletedBundles,
        deletedSnapshots: total.deletedSnapshots + result.deletedSnapshots,
        deletedJobs: total.deletedJobs + result.deletedJobs,
        complete: total.complete && result.complete,
      };
    }
    return { ...total, nextOwnerId: owners.length === limit ? (owners.at(-1)?.id ?? null) : null };
  }
}
