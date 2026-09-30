import type { AccountDataKey, KeyProvider } from "@symplist/crypto";
import { zeroize } from "@symplist/crypto";
import type { DbClient, DbRow, Statement } from "@symplist/db";
import { sql } from "@symplist/db";
import { AccountKeyStore, AccountKeyUnavailableError } from "../account/keys.ts";
import { LABEL_COLUMNS, type LabelRecord, labelRecordFromRow } from "./labels.ts";
import { ActiveTree, type TaskRecord } from "./model.ts";
import {
  TASK_COLUMNS,
  taskRecordFromRow,
  taskTreeVersionFromRow,
  taskTreeVersionStatement,
} from "./sql.ts";

/**
 * One owner's task tree as a write plans against it: every active task, the archived tasks the
 * operation needs, the wrapped account key row and the tree version they were read at. Because every
 * write to the owner's task rows moves the version in the same batch, this is exactly the state of
 * D1 at `version`.
 */
export interface OwnerTreeState {
  readonly ownerId: string;
  readonly version: number;
  /** The `account_keys` row: the KEK-wrapped account data key, never the key itself. */
  readonly keyRow: DbRow;
  readonly tree: ActiveTree;
  /** Archived tasks read for this state (not every archived task of the owner). */
  readonly archived: ReadonlyMap<string, TaskRecord>;
  /**
   * Every label the owner has, oldest first, and which labels each task carries.
   *
   * Part of the tree state rather than a separate read, because they are read together on every page:
   * folding both into the loader's one batch costs no extra D1 round trip, and on the worker lane a
   * round trip is about seven seconds. It also means a label rename invalidates the same cache entry a
   * task rename does, so the two can never disagree on screen.
   */
  readonly labels: readonly LabelRecord[];
  /** Task id to the label ids it carries, in the owner's label order. */
  readonly taskLabels: ReadonlyMap<string, readonly string[]>;
}

/**
 * The api's in-memory task tree cache (§3.3): 60-second TTL, invalidated on write and by internal
 * events. Implementations must never serve an entry past its TTL.
 */
export interface TaskTreeCache {
  get(ownerId: string): OwnerTreeState | undefined;
  set(state: OwnerTreeState): void;
  delete(ownerId: string): void;
}

/** The §3.3 TTL of the task tree and preferences caches. */
export const TASK_TREE_CACHE_TTL_MS = 60_000;

/**
 * Cached task rows across all owners, beyond which the least recently stored entries are dropped.
 * An entry holds one owner's whole active tree with its titles and previews decrypted, so a count of
 * entries alone does not bound the memory a busy instance holds (§3.3, as §10.1 bounds the search
 * LRU by decrypted bytes). One owner's tree is always kept, however large.
 */
export const TASK_TREE_CACHE_MAX_TASKS = 100_000;

interface CacheEntry {
  readonly state: OwnerTreeState;
  readonly expiresAt: number;
  readonly tasks: number;
}

/** A bounded {@link TaskTreeCache} with a hard TTL per entry. */
export class MemoryTaskTreeCache implements TaskTreeCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxTasks: number;
  private tasks = 0;

  constructor(options: {
    readonly now: () => number;
    readonly ttlMs?: number;
    readonly maxEntries?: number;
    /** Total cached task rows across owners; see {@link TASK_TREE_CACHE_MAX_TASKS}. */
    readonly maxTasks?: number;
  }) {
    this.now = options.now;
    this.ttlMs = options.ttlMs ?? TASK_TREE_CACHE_TTL_MS;
    this.maxEntries = options.maxEntries ?? 2_000;
    this.maxTasks = options.maxTasks ?? TASK_TREE_CACHE_MAX_TASKS;
    if (!(this.ttlMs > 0) || !Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new RangeError("The task tree cache needs a positive TTL and size");
    }
    if (!Number.isSafeInteger(this.maxTasks) || this.maxTasks < 1) {
      throw new RangeError("The task tree cache needs a positive task budget");
    }
  }

  get size(): number {
    return this.entries.size;
  }

  /** Task rows currently held across every cached owner. */
  get taskCount(): number {
    return this.tasks;
  }

  get(ownerId: string): OwnerTreeState | undefined {
    const entry = this.entries.get(ownerId);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.drop(ownerId);
      return undefined;
    }
    return entry.state;
  }

  set(state: OwnerTreeState): void {
    this.drop(state.ownerId);
    const tasks = state.tree.byId.size + state.archived.size;
    if (this.entries.size >= this.maxEntries || this.tasks + tasks > this.maxTasks) {
      const now = this.now();
      for (const [ownerId, entry] of this.entries) {
        if (entry.expiresAt <= now) this.drop(ownerId);
      }
      // Least recently stored first, until both budgets fit. The new entry is always kept, so one
      // owner whose tree is larger than the whole budget still gets its one-D1-request writes.
      while (
        this.entries.size > 0 &&
        (this.entries.size >= this.maxEntries || this.tasks + tasks > this.maxTasks)
      ) {
        const oldest = this.entries.keys().next();
        if (oldest.done) break;
        this.drop(oldest.value);
      }
    }
    this.entries.set(state.ownerId, { state, expiresAt: this.now() + this.ttlMs, tasks });
    this.tasks += tasks;
  }

  delete(ownerId: string): void {
    this.drop(ownerId);
  }

  clear(): void {
    this.entries.clear();
    this.tasks = 0;
  }

  private drop(ownerId: string): void {
    const entry = this.entries.get(ownerId);
    if (!entry) return;
    this.entries.delete(ownerId);
    this.tasks -= entry.tasks;
  }
}

export interface TreeLoadOptions {
  /**
   * Tasks to read even when archived, with every task archived together with them (their archived
   * group), for restores and for telling an archived task from an unknown one.
   */
  readonly probeTaskIds?: readonly string[];
}

/** Reads and decrypts owner tree states. */
export class TaskTreeLoader {
  private readonly db: DbClient;
  private readonly accountKeys: AccountKeyStore;

  constructor(options: { readonly db: DbClient; readonly keys: KeyProvider }) {
    this.db = options.db;
    this.accountKeys = new AccountKeyStore({ db: options.db, keys: options.keys });
  }

  /** The statements of one state read, in the order {@link parse} expects. */
  statements(ownerId: string, options: TreeLoadOptions = {}): Statement[] {
    const statements = [
      this.accountKeys.selectStatement(ownerId),
      taskTreeVersionStatement(ownerId),
      sql(`SELECT ${TASK_COLUMNS} FROM tasks WHERE owner_id = :owner AND status = 'active'`, {
        owner: ownerId,
      }),
      sql(`SELECT ${LABEL_COLUMNS} FROM labels WHERE owner_id = :owner ORDER BY created_at, id`, {
        owner: ownerId,
      }),
      // Only the pairs of active tasks: an archived task's chips are read with the task itself, and
      // carrying every historical pair here would grow this read with the size of the archive.
      sql(
        `SELECT tl.task_id, tl.label_id FROM task_labels tl
         JOIN tasks t ON t.id = tl.task_id AND t.owner_id = tl.owner_id
         WHERE tl.owner_id = :owner AND t.status = 'active'`,
        { owner: ownerId },
      ),
    ];
    const probe = [...new Set(options.probeTaskIds ?? [])];
    if (probe.length > 0) {
      statements.push(
        sql(
          `SELECT ${TASK_COLUMNS} FROM tasks
           WHERE owner_id = :owner AND status = 'archived'
             AND (id IN (:ids) OR archived_with_root_id IN (
               SELECT archived_with_root_id FROM tasks
               WHERE owner_id = :owner AND status = 'archived' AND id IN (:ids)))`,
          { owner: ownerId, ids: probe },
        ),
      );
    }
    return statements;
  }

  /** Reads a state in one D1 request. Throws when the account has no key (it is being deleted). */
  async load(ownerId: string, options: TreeLoadOptions = {}): Promise<OwnerTreeState> {
    const statements = this.statements(ownerId, options);
    const results = await this.db.batch(statements);
    return this.parse(
      ownerId,
      results.map((result) => result.results),
    );
  }

  /** Builds a state from the rows of {@link statements}. */
  parse(ownerId: string, rows: ReadonlyArray<readonly DbRow[]>): OwnerTreeState {
    const keyRow = rows[0]?.[0];
    const version = taskTreeVersionFromRow(rows[1]?.[0]);
    if (!keyRow || version === null) throw new AccountKeyUnavailableError();
    const key = this.accountKeys.unwrapRow(keyRow);
    try {
      const active = (rows[2] ?? []).map((row) => taskRecordFromRow(row, key));
      const labels = (rows[3] ?? []).map((row) => labelRecordFromRow(row, key));
      const order = new Map(labels.map((label, index) => [label.id, index]));
      const taskLabels = new Map<string, string[]>();
      for (const row of rows[4] ?? []) {
        const taskId = row.task_id;
        const labelId = row.label_id;
        // A pair naming a label that is not in the list above cannot happen — the foreign key forbids
        // it — but reading defensively keeps one odd row from throwing a whole page away.
        if (typeof taskId !== "string" || typeof labelId !== "string") continue;
        if (!order.has(labelId)) continue;
        const existing = taskLabels.get(taskId);
        if (existing) existing.push(labelId);
        else taskLabels.set(taskId, [labelId]);
      }
      // Sorted into the owner's label order, so chips appear in the same order on every task rather
      // than in whatever order the join happened to return.
      for (const ids of taskLabels.values()) {
        ids.sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));
      }
      const archived = new Map<string, TaskRecord>();
      for (const row of rows[5] ?? []) {
        const record = taskRecordFromRow(row, key);
        archived.set(record.id, record);
      }
      return Object.freeze({
        ownerId,
        version,
        keyRow,
        tree: new ActiveTree(active),
        archived,
        labels: Object.freeze(labels),
        taskLabels,
      });
    } finally {
      zeroize(key.key);
    }
  }

  /** Unwraps the state's account key; the caller zeroizes it. */
  unwrapKey(state: OwnerTreeState): AccountDataKey {
    return this.accountKeys.unwrapRow(state.keyRow);
  }
}
