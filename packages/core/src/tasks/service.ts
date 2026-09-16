import type {
  ArchiveResponse,
  TaskCollection,
  TaskCompleteResponse,
  TaskCreateResponse,
  TaskDetailResponse,
  TaskMoveResponse,
  TaskPlacement,
  TaskRenameResponse,
  TaskRestoreResponse,
  TaskTreeResponse,
} from "@symplist/contracts";
import { TASK_TREE_PAGE_LIMIT } from "@symplist/contracts";
import type { AccountDataKey, KeyProvider, RandomOptions } from "@symplist/crypto";
import { zeroize } from "@symplist/crypto";
import type { DbClient, DbRow, SqlParams, Statement, StatementResult } from "@symplist/db";
import { int, sql, uuidv7 } from "@symplist/db";
import { type AccessPolicy, evaluateAccess } from "../access/evaluate.ts";
import { ACCESS_STATE_COLUMNS, accessCondition, accessStateFromRow } from "../access/sql.ts";
import { AccountKeyStore } from "../account/keys.ts";
import type { IdempotencyClaim } from "../idempotency/store.ts";
import {
  type ArchivePageInput,
  archivePageStatements,
  archiveWindow,
  buildArchivePage,
  canonicalTimeZone,
  decodeArchiveCursor,
  decodeTaskTreeCursor,
  encodeTaskTreeCursor,
} from "./archive.ts";
import { archiveContributors as defaultArchiveContributors } from "./archive-contributors/index.ts";
import type { ArchiveContributor } from "./archive-contributors/types.ts";
import { TaskOperationError } from "./errors.ts";
import { sourceKind, type TaskRecord, type TaskSource } from "./model.ts";
import {
  type PlanContext,
  type PlannedAnalytics,
  planComplete,
  planCreate,
  planMove,
  planRename,
  planRestore,
  toTaskNode,
  type WritePlan,
} from "./plans.ts";
import { announceTaskTreeCommitted } from "./signals.ts";
import {
  taskColumnsOf,
  taskRecordFromRow,
  taskTreeVersionFromRow,
  taskTreeVersionStatement,
} from "./sql.ts";
import { type OwnerTreeState, type TaskTreeCache, TaskTreeLoader } from "./state.ts";

/** Who performs a task write. */
export type TaskActor =
  | { readonly kind: "user" }
  | { readonly kind: "simon" }
  | { readonly kind: "mcp"; readonly grantId: string };

/** The stored `tasks.source` of an actor. */
export function taskSourceOf(actor: TaskActor): TaskSource {
  switch (actor.kind) {
    case "user":
      return "user";
    case "simon":
      return "simon";
    case "mcp":
      if (!/^[A-Za-z0-9-]{1,120}$/.test(actor.grantId)) throw new TypeError("Invalid grant id");
      return `mcp:${actor.grantId}`;
  }
}

/**
 * An `Idempotency-Key` claim folded into the write's deciding batch (§3.1, §6.1). The service puts
 * `statements` first, requires `claim.guard` in the deciding statement, deletes the pending claim in
 * the same batch when the write did not apply (so the request can be planned again or fail cleanly),
 * records the response with `completion` when it did, and reads the claim's outcome with `decide`.
 */
export interface TaskWriteFold {
  readonly claim: IdempotencyClaim;
  readonly statements: readonly Statement[];
  completion(
    response: { readonly status: number; readonly body: unknown },
    key: AccountDataKey,
  ): Statement;
  /** Throws for another input under the key or a record whose outcome is unknown. */
  decide(
    results: readonly StatementResult[],
    key: AccountDataKey,
    offset: number,
  ): { readonly kind: "started" } | { readonly kind: "replay"; readonly body: unknown };
}

/** The account's analytics consent read in the write's batch (§15), for the api's emitter. */
export interface TaskAnalyticsSubject {
  readonly consent: "unset" | "granted" | "denied";
  readonly analyticsId: string | null;
}

export type TaskWriteResult<Body> =
  | {
      readonly kind: "applied";
      readonly status: number;
      readonly body: Body;
      readonly taskTreeVersion: number;
      readonly changedTaskIds: readonly string[];
      readonly analytics: {
        readonly event: PlannedAnalytics;
        readonly subject: TaskAnalyticsSubject;
        /** A UUID for the confirmed action (the batch's write id). */
        readonly eventId: string;
      } | null;
    }
  /** An exact retry of an `Idempotency-Key`: nothing applied; `body` is the recorded response. */
  | { readonly kind: "replay"; readonly body: unknown };

export interface TaskServiceOptions {
  readonly db: DbClient;
  readonly keys: KeyProvider;
  readonly policy: AccessPolicy;
  readonly now: () => number;
  /** The api's tree cache (§3.3); the worker runs without one. */
  readonly cache?: TaskTreeCache;
  /** Defaults to every registered domain contributor (§2.3). */
  readonly archiveContributors?: readonly ArchiveContributor[];
  readonly random?: RandomOptions;
  /** Writes planned against a tree that changed meanwhile are planned again this many times. */
  readonly maxAttempts?: number;
}

interface WriteRequest<Body> {
  readonly ownerId: string;
  readonly fold?: TaskWriteFold;
  /** Task ids the plan reads, loaded even when archived. */
  readonly probe: readonly string[];
  plan(state: OwnerTreeState, ctx: PlanContext): WritePlan<Body>;
}

const analyticsConsents = new Set(["unset", "granted", "denied"]);

/**
 * `core/tasks` (§2.1): create, rename, move and reorder, complete and restore tasks, list the task
 * tree and the archive. Shared by the api, Simon and MCP tools.
 *
 * Every write is one D1 batch: the idempotency claim when folded, a deciding statement that moves the
 * owner's task tree version (a structural write requires it to be the version it planned against),
 * the task rows, search intents, the archive contributions, the recorded response, and the reads the
 * outcome needs. With a warm tree cache a write is one D1 request; a tree that changed meanwhile is
 * read again and the write planned again.
 */
export class TaskService {
  private readonly db: DbClient;
  private readonly policy: AccessPolicy;
  private readonly now: () => number;
  private readonly cache: TaskTreeCache | undefined;
  private readonly contributors: readonly ArchiveContributor[];
  private readonly random: RandomOptions | undefined;
  private readonly maxAttempts: number;
  private readonly loader: TaskTreeLoader;
  private readonly accountKeys: AccountKeyStore;

  constructor(options: TaskServiceOptions) {
    this.db = options.db;
    this.policy = Object.freeze({ betaAccessRequired: options.policy.betaAccessRequired });
    this.now = options.now;
    this.cache = options.cache;
    this.contributors = options.archiveContributors ?? defaultArchiveContributors;
    this.random = options.random;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.loader = new TaskTreeLoader({ db: options.db, keys: options.keys });
    this.accountKeys = new AccountKeyStore({ db: options.db, keys: options.keys });
  }

  /* ---------------------------------------------------------------------------------------------
   * Reads
   * ------------------------------------------------------------------------------------------- */

  /** The owner's tree state, from the cache when fresh, otherwise read (one D1 request). */
  async state(ownerId: string): Promise<OwnerTreeState> {
    const cached = this.cache?.get(ownerId);
    if (cached) return cached;
    const state = await this.loader.load(ownerId);
    this.remember(state);
    return state;
  }

  /** Forgets the cached tree of an owner, for example after an internal event. */
  invalidate(ownerId: string): void {
    this.cache?.delete(ownerId);
  }

  /**
   * A collection's active tasks in pre-order (`GET /v1/tasks?collection=`), one page at a time. The
   * owner's tree is read and cached whole, so every page after the first is served from that read;
   * the window exists so one response cannot grow with the size of the collection (§3 D1 budget).
   */
  async listCollection(
    ownerId: string,
    collection: TaskCollection,
    page: { readonly cursor?: string; readonly limit?: number } = {},
  ): Promise<TaskTreeResponse> {
    const state = await this.state(ownerId);
    const cursor = page.cursor === undefined ? null : decodeTaskTreeCursor(page.cursor);
    const limit = page.limit ?? TASK_TREE_PAGE_LIMIT;
    const flat = state.tree.flatten(collection);
    // A cursor taken against another version indexes a tree that has moved. The page is still
    // served, and the version it reports tells the client to start the collection again.
    const offset = cursor === null ? 0 : Math.min(cursor.offset, flat.length);
    const window = flat.slice(offset, offset + limit);
    const end = offset + window.length;
    return {
      collection,
      taskTreeVersion: state.version,
      tasks: window.map(({ task, depth }) => toTaskNode(state.tree, task, depth)),
      nextCursor:
        end < flat.length ? encodeTaskTreeCursor({ version: state.version, offset: end }) : null,
    };
  }

  /**
   * One task with its breadcrumb (`GET /v1/tasks/:id`). Active tasks come from the tree; archived
   * tasks are read with their ancestors in one request. Unknown and foreign tasks are `not_found`.
   */
  async getTask(ownerId: string, taskId: string): Promise<TaskDetailResponse> {
    const cached = this.cache?.get(ownerId);
    const active = cached?.tree.get(taskId);
    if (cached && active) return this.activeDetail(cached, active);

    const results = await this.db.batch([
      this.accountKeys.selectStatement(ownerId),
      sql(
        `WITH RECURSIVE chain (id, parent_id, depth) AS (
           SELECT id, parent_id, 0 FROM tasks WHERE id = :task AND owner_id = :owner
           UNION ALL
           SELECT t.id, t.parent_id, chain.depth + 1 FROM tasks t JOIN chain ON t.id = chain.parent_id
           WHERE t.owner_id = :owner AND chain.depth < 64
         )
         SELECT ${taskColumnsOf("t")}, chain.depth AS chain_depth,
           (SELECT COUNT(*) FROM tasks c WHERE c.parent_id = t.id AND c.owner_id = t.owner_id
              AND c.status = t.status) AS child_count
         FROM chain JOIN tasks t ON t.id = chain.id
         ORDER BY chain.depth DESC`,
        { task: taskId, owner: ownerId },
      ),
    ]);
    const keyRow = results[0]?.results[0];
    const rows = results[1]?.results ?? [];
    const own = rows.find((row) => row.id === taskId);
    if (!keyRow || !own) throw new TaskOperationError("not_found");
    const key = this.accountKeys.unwrapRow(keyRow);
    try {
      const records = rows.map((row) => ({
        record: taskRecordFromRow(row, key),
        childCount: typeof row.child_count === "number" ? row.child_count : 0,
      }));
      const target = records.find((entry) => entry.record.id === taskId) as {
        record: TaskRecord;
        childCount: number;
      };
      const { record } = target;
      return {
        task: {
          id: record.id,
          parentId: record.parentId,
          collection: record.collection,
          position: record.position,
          status: record.status,
          title: record.title,
          preview: record.preview,
          source: sourceKind(record.source),
          version: record.version,
          childCount: target.childCount,
          archivedAt: record.archivedAt,
          archivedWithRootId: record.archivedWithRootId,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        },
        ancestors: records
          .filter((entry) => entry.record.id !== taskId)
          .map((entry) => ({
            id: entry.record.id,
            title: entry.record.title,
            status: entry.record.status,
          })),
      } as TaskDetailResponse;
    } finally {
      zeroize(key.key);
    }
  }

  /**
   * The archive (`GET /v1/archive`): completed tasks newest first with the subtasks archived with
   * them, grouped by local completion date, optionally filtered by title. One D1 request.
   */
  async listArchive(input: ArchivePageInput): Promise<ArchiveResponse> {
    const timeZone = canonicalTimeZone(input.timeZone ?? "UTC");
    const cursor = input.cursor === undefined ? null : decodeArchiveCursor(input.cursor);
    const { limit, scan } = archiveWindow(input);
    const results = await this.db.batch([
      this.accountKeys.selectStatement(input.ownerId),
      taskTreeVersionStatement(input.ownerId),
      ...archivePageStatements(input.ownerId, cursor, scan),
    ]);
    const keyRow = results[0]?.results[0];
    const version = taskTreeVersionFromRow(results[1]?.results[0]);
    if (!keyRow || version === null) throw new TaskOperationError("not_found");
    const key = this.accountKeys.unwrapRow(keyRow);
    try {
      const roots = (results[2]?.results ?? []).map((row) => taskRecordFromRow(row, key));
      const members = (results[3]?.results ?? []).map((row) => taskRecordFromRow(row, key));
      const cached = this.cache?.get(input.ownerId);
      if (cached && cached.version === version) {
        // Rows read at the cached version are exact, so restores planned from them need no read.
        const archived = new Map(cached.archived);
        for (const record of [...roots, ...members]) archived.set(record.id, record);
        this.cache?.set({ ...cached, archived });
      } else if (cached) {
        // This read proved the entry stale (another api instance or the worker wrote), so the cache
        // must not keep serving it for the rest of its TTL (decision WS2).
        this.cache?.delete(input.ownerId);
      }
      return buildArchivePage({
        roots,
        members,
        limit,
        scan,
        q: input.q,
        timeZone,
        taskTreeVersion: version,
      });
    } finally {
      zeroize(key.key);
    }
  }

  private activeDetail(state: OwnerTreeState, task: TaskRecord): TaskDetailResponse {
    const ancestors: TaskRecord[] = [];
    let parentId = state.tree.effectiveParent(task);
    while (parentId !== null) {
      const parent = state.tree.get(parentId);
      if (!parent || ancestors.some((entry) => entry.id === parent.id)) break;
      ancestors.unshift(parent);
      parentId = state.tree.effectiveParent(parent);
    }
    return {
      task: {
        id: task.id,
        parentId: state.tree.effectiveParent(task),
        collection: task.collection,
        position: task.position,
        status: task.status,
        title: task.title,
        preview: task.preview,
        source: sourceKind(task.source),
        version: task.version,
        childCount: state.tree.childrenOf(task.id).length,
        archivedAt: null,
        archivedWithRootId: null,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      },
      ancestors: ancestors.map((entry) => ({
        id: entry.id,
        title: entry.title,
        status: entry.status,
      })),
    } as TaskDetailResponse;
  }

  /* ---------------------------------------------------------------------------------------------
   * Writes
   * ------------------------------------------------------------------------------------------- */

  /** Creates a task from a title (`POST /v1/tasks`, `task_create`). */
  create(input: {
    readonly ownerId: string;
    readonly actor: TaskActor;
    readonly title: string;
    readonly collection?: TaskCollection;
    readonly parentId?: string;
    readonly afterId?: string;
    readonly placement?: TaskPlacement;
    /** A caller-chosen UUIDv7, so a retried tool call creates the task once. */
    readonly taskId?: string;
    readonly fold?: TaskWriteFold;
  }): Promise<TaskWriteResult<TaskCreateResponse>> {
    const source = taskSourceOf(input.actor);
    const taskId = input.taskId ?? uuidv7(this.now());
    return this.write({
      ownerId: input.ownerId,
      ...(input.fold ? { fold: input.fold } : {}),
      // The new id is deliberately not probed. It is never in a cached tree (it does not exist
      // yet), so probing it forced a tree read before every create with a caller-chosen id and made
      // `task_create` cost two D1 requests. The insert's `requires` is the authority on the id being
      // free, and `planCreate` recognizes an id a *freshly read* state already holds (§3, WS18).
      probe: input.parentId === undefined ? [] : [input.parentId],
      plan: (state, ctx) =>
        planCreate(state, ctx, {
          taskId,
          title: input.title,
          source,
          ...(input.collection === undefined ? {} : { collection: input.collection }),
          ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
          ...(input.afterId === undefined ? {} : { afterId: input.afterId }),
          ...(input.placement === undefined ? {} : { placement: input.placement }),
        }),
    });
  }

  /** Renames an active task (`PATCH /v1/tasks/:id`). */
  rename(input: {
    readonly ownerId: string;
    readonly taskId: string;
    readonly title: string;
    readonly fold?: TaskWriteFold;
  }): Promise<TaskWriteResult<TaskRenameResponse>> {
    return this.write({
      ownerId: input.ownerId,
      ...(input.fold ? { fold: input.fold } : {}),
      probe: [input.taskId],
      plan: (state, ctx) => planRename(state, ctx, { taskId: input.taskId, title: input.title }),
    });
  }

  /** Moves or reorders a task with its subtasks (`POST /v1/tasks/:id/move`, `task_move`). */
  move(input: {
    readonly ownerId: string;
    readonly actor: TaskActor;
    readonly taskId: string;
    readonly collection?: TaskCollection;
    readonly parentId?: string | null;
    readonly afterId?: string;
    readonly beforeId?: string;
    readonly fold?: TaskWriteFold;
  }): Promise<TaskWriteResult<TaskMoveResponse>> {
    return this.write({
      ownerId: input.ownerId,
      ...(input.fold ? { fold: input.fold } : {}),
      probe: [input.taskId, input.parentId, input.afterId, input.beforeId].filter(
        (id): id is string => typeof id === "string",
      ),
      plan: (state, ctx) =>
        planMove(state, ctx, {
          taskId: input.taskId,
          actor: sourceKind(taskSourceOf(input.actor)),
          ...(input.collection === undefined ? {} : { collection: input.collection }),
          ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
          ...(input.afterId === undefined ? {} : { afterId: input.afterId }),
          ...(input.beforeId === undefined ? {} : { beforeId: input.beforeId }),
        }),
    });
  }

  /** Completes (archives) a task (`POST /v1/tasks/:id/complete`, §2.1). */
  complete(input: {
    readonly ownerId: string;
    readonly taskId: string;
    readonly mode: "all" | "parent_only";
    readonly stopRun: boolean;
    readonly fold?: TaskWriteFold;
  }): Promise<TaskWriteResult<TaskCompleteResponse>> {
    return this.write({
      ownerId: input.ownerId,
      ...(input.fold ? { fold: input.fold } : {}),
      probe: [input.taskId],
      plan: (state, ctx) =>
        planComplete(state, ctx, {
          taskId: input.taskId,
          mode: input.mode,
          stopRun: input.stopRun,
          contributors: this.contributors,
        }),
    });
  }

  /** Restores an archived task and its subtasks archived with it (`POST /v1/tasks/:id/restore`). */
  restore(input: {
    readonly ownerId: string;
    readonly taskId: string;
    readonly fold?: TaskWriteFold;
  }): Promise<TaskWriteResult<TaskRestoreResponse>> {
    return this.write({
      ownerId: input.ownerId,
      ...(input.fold ? { fold: input.fold } : {}),
      probe: [input.taskId],
      plan: (state, ctx) => planRestore(state, ctx, { taskId: input.taskId }),
    });
  }

  /* ---------------------------------------------------------------------------------------------
   * The write loop
   * ------------------------------------------------------------------------------------------- */

  private async write<Body>(request: WriteRequest<Body>): Promise<TaskWriteResult<Body>> {
    let state: OwnerTreeState | undefined = this.cache?.get(request.ownerId);
    let fromCache = state !== undefined && this.covers(state, request.probe);
    if (!fromCache) state = undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      if (!state) {
        state = await this.loader.load(request.ownerId, { probeTaskIds: request.probe });
        fromCache = false;
      }
      const now = this.now();
      const writeId = uuidv7(now);
      const key = this.loader.unwrapKey(state);
      try {
        const ctx: PlanContext = {
          ownerId: request.ownerId,
          now,
          writeId,
          key,
          ...(this.random ? { random: this.random } : {}),
          guard:
            "EXISTS (SELECT 1 FROM users WHERE id = :tree_owner AND task_tree_write_id = :tree_w)",
          guardParams: { tree_owner: request.ownerId, tree_w: writeId },
        };
        let plan: WritePlan<Body>;
        try {
          plan = request.plan(state, ctx);
        } catch (error) {
          if (!(error instanceof TaskOperationError)) throw error;
          if (fromCache) {
            // The cached tree may be behind another instance or the worker: read it and plan again.
            state = undefined;
            continue;
          }
          return await this.refuse(request, key, error);
        }
        const outcome = await this.run(request, state, ctx, plan);
        if (outcome.kind === "replay" || outcome.kind === "applied") return outcome;
        if (outcome.kind === "refused") throw outcome.error;
        this.cache?.delete(request.ownerId);
        state = undefined;
      } finally {
        zeroize(key.key);
      }
    }
    const current = await this.loader.load(request.ownerId).catch(() => null);
    throw new TaskOperationError("task.conflict", { taskTreeVersion: current?.version ?? 0 });
  }

  /** Whether a cached state holds every task a plan reads (active, or archived and loaded). */
  private covers(state: OwnerTreeState, probe: readonly string[]): boolean {
    return probe.every((id) => state.tree.get(id) !== undefined || state.archived.has(id));
  }

  private async run<Body>(
    request: WriteRequest<Body>,
    state: OwnerTreeState,
    ctx: PlanContext,
    plan: WritePlan<Body>,
  ): Promise<
    | TaskWriteResult<Body>
    | { readonly kind: "stale" }
    | { readonly kind: "refused"; readonly error: TaskOperationError }
  > {
    const { ownerId, writeId, now } = ctx;
    const fold = request.fold;
    if (plan.lock === "none" && !fold) {
      return {
        kind: "applied",
        status: plan.status,
        body: plan.body,
        taskTreeVersion: state.version,
        changedTaskIds: [],
        analytics: null,
      };
    }
    const statements: Statement[] = [...(fold?.statements ?? [])];
    const access = accessCondition({
      level: "admitted",
      policy: this.policy,
      userParam: "tree_owner",
    });
    const conditions: string[] = [
      access,
      "EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :tree_owner)",
    ];
    const conditionParams: Record<string, string | readonly string[] | null | undefined> = {};
    if (fold) {
      conditions.push(fold.claim.guard.exists);
      Object.assign(conditionParams, fold.claim.guard.params);
    }

    if (plan.lock === "tree") {
      if (plan.requires) {
        conditions.push(plan.requires.sql);
        Object.assign(conditionParams, plan.requires.params);
      }
      if (plan.blocking) {
        conditions.push(`NOT ${plan.blocking.sql}`);
        Object.assign(conditionParams, plan.blocking.params);
      }
      statements.push(
        sql(
          `UPDATE users SET task_tree_version = task_tree_version + 1, task_tree_write_id = :tree_w
           WHERE id = :tree_owner AND task_tree_version = CAST(:tree_expected AS INTEGER)
             AND ${conditions.join(" AND ")}`,
          {
            ...conditionParams,
            tree_w: writeId,
            tree_owner: ownerId,
            tree_expected: int(state.version),
          },
        ),
      );
    } else if (plan.lock === "none") {
      // Nothing changes (restoring an active task), but the batch records a response, so it still
      // decides on access, the account key and the claim exactly as a write does: a relock or
      // suspension that landed after the session was cached refuses it here (§5.4, §5.5). The write
      // marker moves without the tree version, so no cache entry is dropped and no client is woken.
      statements.push(
        sql(
          `UPDATE users SET task_tree_write_id = :tree_w
           WHERE id = :tree_owner AND ${conditions.join(" AND ")}`,
          { ...conditionParams, tree_w: writeId, tree_owner: ownerId },
        ),
      );
    } else if (plan.lock === "row" && plan.row) {
      statements.push(
        sql(
          `UPDATE tasks SET ${plan.row.set}, version = version + 1, updated_at = :row_now, write_id = :tree_w
           WHERE id = :row_task AND owner_id = :tree_owner AND status = 'active'
             AND version = CAST(:row_version AS INTEGER) AND ${conditions.join(" AND ")}`,
          {
            ...plan.row.params,
            ...conditionParams,
            row_now: int(now),
            tree_w: writeId,
            row_task: plan.row.taskId,
            tree_owner: ownerId,
            row_version: int(plan.row.expectedVersion),
          },
        ),
        sql(
          `UPDATE users SET task_tree_version = task_tree_version + 1, task_tree_write_id = :tree_w
           WHERE id = :tree_owner
             AND EXISTS (SELECT 1 FROM tasks WHERE id = :row_task AND write_id = :tree_w)`,
          { tree_w: writeId, tree_owner: ownerId, row_task: plan.row.taskId },
        ),
      );
    }
    statements.push(...plan.effects);

    const applied =
      "EXISTS (SELECT 1 FROM users WHERE id = :tree_owner AND task_tree_write_id = :tree_w)";
    if (fold) {
      // Releasing before the completion means a refused batch records nothing: the completion only
      // updates a record that is still pending.
      statements.push(this.releaseStatement(fold.claim, applied, ctx));
      statements.push(fold.completion({ status: plan.status, body: plan.body }, ctx.key));
    }
    const readsAt = statements.length;
    statements.push(
      this.accountKeys.selectStatement(ownerId),
      sql(
        `SELECT task_tree_version, analytics_consent, analytics_id, ${ACCESS_STATE_COLUMNS.join(", ")}
         FROM users WHERE id = :owner`,
        { owner: ownerId },
      ),
    );
    if (plan.blocking) {
      statements.push(sql(`SELECT ${plan.blocking.sql} AS blocked`, plan.blocking.params));
    }
    if (plan.lock === "row" && plan.row) {
      statements.push(
        sql(`SELECT status, version FROM tasks WHERE id = :task AND owner_id = :owner`, {
          task: plan.row.taskId,
          owner: ownerId,
        }),
      );
    }
    statements.push(
      sql(`SELECT task_tree_version FROM users WHERE id = :owner AND task_tree_write_id = :w`, {
        owner: ownerId,
        w: writeId,
      }),
    );

    const results = await this.db.batch(statements);
    const rows = (index: number): readonly DbRow[] => results[index]?.results ?? [];

    if (fold) {
      const decision = fold.decide(results, ctx.key, 0);
      if (decision.kind === "replay") return { kind: "replay", body: decision.body };
    }

    const usersRow = rows(readsAt + 1)[0];
    const keyRow = rows(readsAt)[0];
    const verification = rows(statements.length - 1)[0];
    const subject = usersRow ? analyticsSubjectOf(usersRow) : null;

    if (verification) {
      const version = numberOf(verification.task_tree_version);
      if (plan.lock === "none") {
        return {
          kind: "applied",
          status: plan.status,
          body: plan.body,
          taskTreeVersion: version,
          changedTaskIds: [],
          analytics: null,
        };
      }
      if (this.cache) {
        if (version === state.version + 1 && keyRow) {
          this.cache.set({ ...plan.apply(state, version), keyRow });
        } else {
          this.cache.delete(ownerId);
        }
      }
      announceTaskTreeCommitted(this.db, {
        ownerId,
        taskTreeVersion: version,
        taskIds: [...new Set(plan.changedTaskIds)],
      });
      return {
        kind: "applied",
        status: plan.status,
        body: plan.body,
        taskTreeVersion: version,
        changedTaskIds: [...new Set(plan.changedTaskIds)],
        analytics:
          plan.analytics && subject ? { event: plan.analytics, subject, eventId: writeId } : null,
      };
    }

    // Nothing applied: find out why.
    if (!usersRow || !keyRow) {
      return { kind: "refused", error: new TaskOperationError("not_found") };
    }
    const decision = evaluateAccess(accessStateFromRow(usersRow), "admitted", this.policy);
    if (!decision.allowed) return { kind: "refused", error: new TaskOperationError(decision.code) };
    const currentVersion = numberOf(usersRow.task_tree_version);
    if (plan.lock === "tree" && currentVersion !== state.version) return { kind: "stale" };
    if (plan.blocking) {
      const blockedRow = rows(readsAt + 2)[0];
      if (blockedRow && Number(blockedRow.blocked) === 1) {
        return { kind: "refused", error: plan.blocking.error };
      }
    }
    // A plan that changes nothing has no version to be stale against: only access, the account key
    // and the claim can refuse it, and those are already answered above.
    if (plan.lock === "none") {
      return { kind: "refused", error: new TaskOperationError("not_found") };
    }
    return { kind: "stale" };
  }

  /**
   * Answers a refused plan. With a folded idempotency claim the batch still checks the key: an exact
   * retry of a request that already succeeded replays its response (a completed task retried with the
   * same key returns the original result, not `task.archived`); otherwise the claim is removed in the
   * same batch and the refusal is returned.
   */
  private async refuse<Body>(
    request: WriteRequest<Body>,
    key: AccountDataKey,
    error: TaskOperationError,
  ): Promise<TaskWriteResult<Body>> {
    const fold = request.fold;
    if (!fold) throw error;
    const now = this.now();
    const ctx = { ownerId: request.ownerId, writeId: uuidv7(now) };
    const results = await this.db.batch([
      ...fold.statements,
      this.releaseStatement(fold.claim, null, ctx),
    ]);
    const decision = fold.decide(results, key, 0);
    if (decision.kind === "replay") return { kind: "replay", body: decision.body };
    throw error;
  }

  /** Deletes this request's pending claim, unless `applied` holds (the write took effect). */
  private releaseStatement(
    claim: IdempotencyClaim,
    applied: string | null,
    ctx: { readonly ownerId: string; readonly writeId: string },
  ): Statement {
    const params: SqlParams = {
      release_scope: claim.scope,
      release_user: claim.userId,
      release_key: claim.key,
      release_write_id: claim.writeId,
      ...(applied === null ? {} : { tree_owner: ctx.ownerId, tree_w: ctx.writeId }),
    };
    return sql(
      `DELETE FROM idempotency_records
       WHERE scope = :release_scope AND user_id = :release_user AND key = :release_key
         AND write_id = :release_write_id AND status = 'pending'
         ${applied === null ? "" : `AND NOT ${applied}`}`,
      params,
    );
  }

  private remember(state: OwnerTreeState): void {
    this.cache?.set(state);
  }
}

function numberOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Expected a non-negative integer column");
  }
  return value;
}

function analyticsSubjectOf(row: DbRow): TaskAnalyticsSubject | null {
  const consent = row.analytics_consent;
  const analyticsId = row.analytics_id;
  if (typeof consent !== "string" || !analyticsConsents.has(consent)) return null;
  return {
    consent: consent as TaskAnalyticsSubject["consent"],
    analyticsId: typeof analyticsId === "string" ? analyticsId : null,
  };
}
