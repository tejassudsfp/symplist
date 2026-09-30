import type {
  LabelColour,
  LabelCreate,
  LabelList,
  LabelUpdate,
  LabelView,
  TaskLabels,
} from "@symplist/contracts";
import { LABEL_MAX_PER_OWNER, LABEL_MAX_PER_TASK, normalizeLabelName } from "@symplist/contracts";
import type { KeyProvider, RandomOptions } from "@symplist/crypto";
import { zeroize } from "@symplist/crypto";
import type { DbClient, Statement, StatementResult } from "@symplist/db";
import { int, sql, uuidv7, verifiedRow } from "@symplist/db";
import { type AccessPolicy, evaluateAccess } from "../access/evaluate.ts";
import { ACCESS_STATE_COLUMNS, accessCondition, accessStateFromRow } from "../access/sql.ts";
import { AccountKeyStore } from "../account/keys.ts";
import { TaskOperationError } from "./errors.ts";
import {
  encryptLabelName,
  LABEL_COLUMNS,
  labelRecordFromRow,
  labelView,
  labelViewsOf,
  sameLabelName,
} from "./labels.ts";
import { announceTaskTreeCommitted } from "./signals.ts";
import { taskTreeVersionFromRow, taskTreeVersionStatement } from "./sql.ts";

/**
 * Labels: create, rename, recolour, delete, and set the ones a task carries.
 *
 * It is a separate service from `TaskService` because it owns different rows and a different cache
 * story, but it shares two things with it deliberately. Every write is guarded by the same
 * `accessCondition`, so a suspended or relocked account cannot label anything; and every write bumps
 * the owner's task tree version and announces the commit on the same signal `TaskService` uses, because
 * the tree response carries labels. A rename that skipped either would leave the old name on screen
 * until a 60-second cache entry aged out, and would never reach a second device at all.
 *
 * **Uniqueness is enforced here rather than by an index**, and the reason is the encryption: envelopes
 * use a random IV, so the same word encrypts differently every time and `UNIQUE (owner_id, name_enc)`
 * would constrain nothing. The owner's labels are a few dozen rows, so the check reads them and
 * compares decrypted names — one query, and no new secret family to rotate or lose. See
 * `migrations/0203_task_labels.sql`.
 */
export interface LabelServiceOptions {
  readonly db: DbClient;
  readonly keys: KeyProvider;
  readonly policy: AccessPolicy;
  readonly now: () => number;
  readonly random?: RandomOptions;
}

export class LabelService {
  private readonly accountKeys: AccountKeyStore;
  private readonly db: DbClient;

  constructor(private readonly options: LabelServiceOptions) {
    this.db = options.db;
    this.accountKeys = new AccountKeyStore({ db: options.db, keys: options.keys });
  }

  /**
   * The owner's labels with their active task counts.
   *
   * `scope.taskIds` narrows both the counts and the list to those tasks, which is how a connected agent
   * granted particular tasks sees the labels on them and nothing else.
   */
  async list(
    ownerId: string,
    scope?: { readonly taskIds: readonly string[] | null },
  ): Promise<LabelList> {
    const loaded = await this.load(ownerId);
    try {
      return { labels: labelViewsOf(loaded.labels, loaded.taskLabels, scope?.taskIds ?? null) };
    } finally {
      zeroize(loaded.key.key);
    }
  }

  /** Creates a label. Refuses a name the owner already uses, and refuses past the per-owner cap. */
  async create(ownerId: string, input: LabelCreate): Promise<LabelView> {
    const loaded = await this.load(ownerId);
    try {
      if (loaded.labels.length >= LABEL_MAX_PER_OWNER) {
        throw new TaskOperationError("label.limit_reached", { limit: LABEL_MAX_PER_OWNER });
      }
      // Normalised here and not only in the schema: uniqueness is decided by comparing these strings.
      const name = normalizeLabelName(input.name);
      const clash = loaded.labels.find((label) => sameLabelName(label.name, name));
      if (clash) throw new TaskOperationError("label.duplicate_name", { labelId: clash.id });
      const now = this.options.now();
      const id = uuidv7(now);
      const writeId = uuidv7(now);
      const results = await this.db.batch([
        sql(
          `INSERT INTO labels (id, owner_id, name_enc, colour, created_at, updated_at, write_id)
           SELECT :id, :owner, :name, :colour, :now, :now, :w
           WHERE ${this.guard()}`,
          {
            id,
            owner: ownerId,
            name: encryptLabelName(loaded.key, ownerId, id, name, this.options.random),
            colour: input.colour,
            now: int(now),
            w: writeId,
          },
        ),
        sql("SELECT id FROM labels WHERE id = :id AND write_id = :w", { id, w: writeId }),
        ...this.bumpTreeVersion(ownerId, now),
      ]);
      if (!verifiedRow(results, 1)) throw new TaskOperationError("not_found");
      this.announce(ownerId, results, []);
      return labelView(
        { id, ownerId, name, colour: input.colour, createdAt: now, updatedAt: now },
        0,
      );
    } finally {
      zeroize(loaded.key.key);
    }
  }

  /** Renames or recolours a label. A rename to the name it already has is accepted and changes nothing. */
  async update(ownerId: string, labelId: string, patch: LabelUpdate): Promise<LabelView> {
    const loaded = await this.load(ownerId);
    try {
      const existing = loaded.labels.find((label) => label.id === labelId);
      if (!existing) throw new TaskOperationError("label.unknown");
      const name = patch.name === undefined ? existing.name : normalizeLabelName(patch.name);
      const colour: LabelColour = patch.colour ?? existing.colour;
      if (patch.name !== undefined) {
        const clash = loaded.labels.find(
          (label) => label.id !== labelId && sameLabelName(label.name, name),
        );
        if (clash) throw new TaskOperationError("label.duplicate_name", { labelId: clash.id });
      }
      const now = this.options.now();
      const writeId = uuidv7(now);
      const results = await this.db.batch([
        sql(
          `UPDATE labels SET name_enc = :name, colour = :colour, updated_at = :now, write_id = :w
           WHERE id = :id AND owner_id = :owner AND ${this.guard()}`,
          {
            id: labelId,
            owner: ownerId,
            name: encryptLabelName(loaded.key, ownerId, labelId, name, this.options.random),
            colour,
            now: int(now),
            w: writeId,
          },
        ),
        sql("SELECT id FROM labels WHERE id = :id AND write_id = :w", { id: labelId, w: writeId }),
        ...this.bumpTreeVersion(ownerId, now),
      ]);
      if (!verifiedRow(results, 1)) throw new TaskOperationError("label.unknown");
      this.announce(ownerId, results, []);
      const count = countOf(loaded.taskLabels, labelId);
      return labelView({ ...existing, name, colour, updatedAt: now }, count);
    } finally {
      zeroize(loaded.key.key);
    }
  }

  /**
   * Deletes a label, and with it every task's chip for it.
   *
   * The pairs go first and explicitly rather than by relying on `ON DELETE CASCADE`: D1 runs a batch as
   * one transaction, so the order is ours to state, and stating it means a reader of this code does not
   * have to go to the schema to learn whether the pairs survive.
   */
  async remove(ownerId: string, labelId: string): Promise<void> {
    const loaded = await this.load(ownerId);
    try {
      // Read first, like `update`, so a label that is not this owner's is refused as unknown rather
      // than as a delete that silently matched nothing.
      if (!loaded.labels.some((label) => label.id === labelId)) {
        throw new TaskOperationError("label.unknown");
      }
      const now = this.options.now();
      const results = await this.db.batch([
        sql(
          `DELETE FROM task_labels WHERE label_id = :id AND owner_id = :owner AND ${this.guard()}`,
          {
            id: labelId,
            owner: ownerId,
          },
        ),
        sql(`DELETE FROM labels WHERE id = :id AND owner_id = :owner AND ${this.guard()}`, {
          id: labelId,
          owner: ownerId,
        }),
        sql("SELECT id FROM labels WHERE id = :id AND owner_id = :owner", {
          id: labelId,
          owner: ownerId,
        }),
        ...this.bumpTreeVersion(ownerId, now),
      ]);
      // The verify reads *after* the delete, in the same transaction: a row still there means the
      // guard refused, which between the read above and now can only be a restriction landing.
      if ((results[2]?.results.length ?? 0) > 0) throw new TaskOperationError("access.relocked");
      this.announce(ownerId, results, []);
    } finally {
      zeroize(loaded.key.key);
    }
  }

  /**
   * Replaces the labels on a task.
   *
   * The whole set rather than a delta, which is what makes it idempotent and what makes two surfaces
   * editing at once — a task row and a connected agent — resolve to a state the person can see instead
   * of to the difference of two deltas neither of them sent.
   */
  async setTaskLabels(
    ownerId: string,
    taskId: string,
    labelIds: readonly string[],
  ): Promise<TaskLabels> {
    const unique = [...new Set(labelIds)];
    if (unique.length > LABEL_MAX_PER_TASK) {
      throw new TaskOperationError("label.limit_reached", { limit: LABEL_MAX_PER_TASK });
    }
    const loaded = await this.load(ownerId);
    try {
      const known = new Set(loaded.labels.map((label) => label.id));
      // Unknown and foreign read the same: `load` only ever returns this owner's labels, so an id from
      // another account is simply not in the set.
      for (const id of unique) if (!known.has(id)) throw new TaskOperationError("label.unknown");
      const now = this.options.now();
      const statements: Statement[] = [
        // The task has to be this owner's and active; an archived task's labels are frozen with it.
        sql(
          `SELECT id FROM tasks
           WHERE id = :task AND owner_id = :owner AND status = 'active' AND ${this.guard()}`,
          { task: taskId, owner: ownerId },
        ),
        sql("DELETE FROM task_labels WHERE task_id = :task AND owner_id = :owner", {
          task: taskId,
          owner: ownerId,
        }),
      ];
      for (const labelId of unique) {
        statements.push(
          sql(
            `INSERT INTO task_labels (task_id, label_id, owner_id, created_at, write_id)
             SELECT :task, :label, :owner, :now, :w
             WHERE EXISTS (
               SELECT 1 FROM tasks WHERE id = :task AND owner_id = :owner AND status = 'active'
             )`,
            {
              task: taskId,
              label: labelId,
              owner: ownerId,
              now: int(now),
              w: uuidv7(now),
            },
          ),
        );
      }
      statements.push(...this.bumpTreeVersion(ownerId, now));
      const results = await this.db.batch(statements);
      if ((results[0]?.results.length ?? 0) === 0) throw new TaskOperationError("not_found");
      this.announce(ownerId, results, [taskId]);
      // Returned in the owner's label order, which is the order the chips render in.
      const order = new Map(loaded.labels.map((label, index) => [label.id, index]));
      const ordered = [...unique].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
      return { taskId, labelIds: ordered } as TaskLabels;
    } finally {
      zeroize(loaded.key.key);
    }
  }

  /**
   * The access guard every write carries, so a suspended or relocked account changes nothing.
   *
   * It reads `:owner`, the parameter each of these statements already binds, rather than introducing a
   * second name for the same id.
   */
  private guard(): string {
    return accessCondition({ level: "admitted", policy: this.options.policy, userParam: "owner" });
  }

  /**
   * Bumps the owner's task tree version.
   *
   * Labels ride in the tree response, so a label write is a tree change as far as any client is
   * concerned: without this a rename would sit behind the cached version until its TTL expired, and a
   * second device would never be told to re-read.
   */
  private bumpTreeVersion(ownerId: string, now: number): Statement[] {
    return [
      sql(
        `UPDATE users SET task_tree_version = task_tree_version + 1, updated_at = :now, write_id = :w
         WHERE id = :owner`,
        { owner: ownerId, now: int(now), w: uuidv7(now) },
      ),
      // Read back in the same batch, so announcing costs no extra round trip (§3.2).
      taskTreeVersionStatement(ownerId),
    ];
  }

  /**
   * Announces the commit on the signal `TaskService` uses, so the api's tree cache is evicted and
   * `tasks.changed` reaches the owner's other devices without the label routes knowing either exists.
   *
   * `taskIds` names the task whose chips changed, and is empty for a label's own create, rename or
   * delete: that touches every row carrying it, and an empty list is how this signal says "re-read".
   */
  private announce(
    ownerId: string,
    results: readonly StatementResult[],
    taskIds: readonly string[],
  ): void {
    const version = taskTreeVersionFromRow(results.at(-1)?.results[0]);
    if (version === null) return;
    announceTaskTreeCommitted(this.db, { ownerId, taskTreeVersion: version, taskIds });
  }

  /** The owner's key, labels and pairs in one request. */
  private async load(ownerId: string) {
    const results = await this.db.batch([
      this.accountKeys.selectStatement(ownerId),
      sql(`SELECT ${ACCESS_STATE_COLUMNS} FROM users WHERE id = :owner`, { owner: ownerId }),
      sql(`SELECT ${LABEL_COLUMNS} FROM labels WHERE owner_id = :owner ORDER BY created_at, id`, {
        owner: ownerId,
      }),
      sql(
        `SELECT tl.task_id, tl.label_id FROM task_labels tl
         JOIN tasks t ON t.id = tl.task_id AND t.owner_id = tl.owner_id
         WHERE tl.owner_id = :owner AND t.status = 'active'`,
        { owner: ownerId },
      ),
    ]);
    const keyRow = results[0]?.results[0];
    const accessRow = results[1]?.results[0];
    if (!keyRow || !accessRow) throw new TaskOperationError("not_found");
    const decision = evaluateAccess(accessStateFromRow(accessRow), "admitted", this.options.policy);
    if (!decision.allowed) throw new TaskOperationError(decision.code);
    const key = this.accountKeys.unwrapRow(keyRow);
    const labels = (results[2]?.results ?? []).map((row) => labelRecordFromRow(row, key));
    const taskLabels = new Map<string, string[]>();
    for (const row of results[3]?.results ?? []) {
      const taskId = row.task_id;
      const labelId = row.label_id;
      if (typeof taskId !== "string" || typeof labelId !== "string") continue;
      const existing = taskLabels.get(taskId);
      if (existing) existing.push(labelId);
      else taskLabels.set(taskId, [labelId]);
    }
    return { key, labels, taskLabels };
  }
}

function countOf(taskLabels: ReadonlyMap<string, readonly string[]>, labelId: string): number {
  let count = 0;
  for (const ids of taskLabels.values()) if (ids.includes(labelId)) count += 1;
  return count;
}
