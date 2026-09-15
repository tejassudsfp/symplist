import type { AccountDataKey, KeyProvider } from "@symplist/crypto";
import { zeroize } from "@symplist/crypto";
import type { DbClient, DbRow, Statement } from "@symplist/db";
import { sql } from "@symplist/db";
import { AccountKeyStore, AccountKeyUnavailableError } from "../account/keys.ts";
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

interface CacheEntry {
  readonly state: OwnerTreeState;
  readonly expiresAt: number;
}

/** A bounded {@link TaskTreeCache} with a hard TTL per entry. */
export class MemoryTaskTreeCache implements TaskTreeCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options: {
    readonly now: () => number;
    readonly ttlMs?: number;
    readonly maxEntries?: number;
  }) {
    this.now = options.now;
    this.ttlMs = options.ttlMs ?? TASK_TREE_CACHE_TTL_MS;
    this.maxEntries = options.maxEntries ?? 2_000;
    if (!(this.ttlMs > 0) || !Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new RangeError("The task tree cache needs a positive TTL and size");
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get(ownerId: string): OwnerTreeState | undefined {
    const entry = this.entries.get(ownerId);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(ownerId);
      return undefined;
    }
    return entry.state;
  }

  set(state: OwnerTreeState): void {
    this.entries.delete(state.ownerId);
    if (this.entries.size >= this.maxEntries) {
      const now = this.now();
      for (const [ownerId, entry] of this.entries) {
        if (entry.expiresAt <= now) this.entries.delete(ownerId);
      }
      while (this.entries.size >= this.maxEntries) {
        const oldest = this.entries.keys().next();
        if (oldest.done) break;
        this.entries.delete(oldest.value);
      }
    }
    this.entries.set(state.ownerId, { state, expiresAt: this.now() + this.ttlMs });
  }

  delete(ownerId: string): void {
    this.entries.delete(ownerId);
  }

  clear(): void {
    this.entries.clear();
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
      const archived = new Map<string, TaskRecord>();
      for (const row of rows[3] ?? []) {
        const record = taskRecordFromRow(row, key);
        archived.set(record.id, record);
      }
      return Object.freeze({
        ownerId,
        version,
        keyRow,
        tree: new ActiveTree(active),
        archived,
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
