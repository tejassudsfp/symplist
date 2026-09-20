import type { DbClient, DbRow, Statement } from "@symplist/db";
import { int, sql, uuidv7, verifiedRow } from "@symplist/db";
import type { ObjectStore } from "@symplist/storage";
import { accountObjectPrefix } from "./deletion.ts";
import { purgeContributors as defaultContributors } from "./purge-contributors/index.ts";
import type { PurgeContributor, PurgeInput } from "./purge-contributors/types.ts";

/** The purge steps in order (§5.6). Each finished step is recorded in `account_deletions.steps_done`. */
export const ACCOUNT_PURGE_STEPS = Object.freeze([
  "runs",
  "composio",
  "r2",
  "d1",
  "users",
] as const);

export type AccountPurgeStep = (typeof ACCOUNT_PURGE_STEPS)[number];

/** Default bounds for one purge invocation, keeping it within the D1 lane budget (§3.1). */
export const ACCOUNT_PURGE_LIMITS = Object.freeze({
  /** Rows deleted per contributed statement. */
  batchLimit: 100,
  /** D1 batches the D1 step may send in one invocation. */
  maxBatches: 25,
  /** R2 objects deleted in one invocation (one `DeleteObject` each). */
  maxObjectDeletes: 500,
});

/**
 * A purge step that runs outside D1 and R2: stopping stragglers (Simon) and deleting connected
 * accounts and the Composio session (connections). It reads only plaintext ids, is idempotent, and
 * returns `incomplete` when it must be resumed later; throwing also leaves the step unrecorded.
 */
export interface AccountPurgeExternalStep {
  run(input: {
    readonly userId: string;
    readonly composioUserId: string;
  }): Promise<"done" | "incomplete">;
}

export interface AccountPurgeRunnerOptions {
  readonly db: DbClient;
  readonly store: ObjectStore;
  readonly now: () => number;
  /** Step 1: confirm no active runs remain and cancel stragglers. */
  readonly runs: AccountPurgeExternalStep;
  /** Step 2: delete connected accounts (`revoke_on_delete: true`) and the Composio session. */
  readonly composio: AccountPurgeExternalStep;
  /** Defaults to every registered domain contributor, children before parents (§2.3). */
  readonly contributors?: readonly PurgeContributor[];
  readonly batchLimit?: number;
  readonly maxBatches?: number;
  readonly maxObjectDeletes?: number;
}

export type AccountPurgeResult =
  | { readonly status: "done" }
  | { readonly status: "incomplete"; readonly stepsDone: readonly AccountPurgeStep[] }
  | { readonly status: "not_found" };

/** A purge contributor broke the purge contract. */
export class PurgeContributorError extends Error {
  readonly code = "account.purge_contributor_invalid";
  constructor(domain: string, rule: string) {
    super(`Purge contributor ${domain} ${rule}`);
    this.name = "PurgeContributorError";
  }
}

/** The `steps_done` entry recording that one domain's rows are purged, so a resumed run skips it. */
export function purgedDomainStep(domain: string): string {
  return `d1:${domain}`;
}

interface DeletionRow {
  readonly status: "pending" | "done";
  readonly stepsDone: readonly AccountPurgeStep[];
  readonly domainsDone: ReadonlySet<string>;
  readonly composioUserId: string;
  readonly r2Prefix: string;
}

function parseDeletion(row: DbRow): DeletionRow {
  const { status, steps_done: steps, composio_user_id: composio, r2_prefix: prefix } = row;
  if ((status !== "pending" && status !== "done") || typeof steps !== "string") {
    throw new Error("Unexpected account_deletions row");
  }
  if (typeof composio !== "string" || typeof prefix !== "string") {
    throw new Error("Unexpected account_deletions row");
  }
  const parsed: unknown = JSON.parse(steps);
  if (!Array.isArray(parsed)) throw new Error("Unexpected account_deletions.steps_done");
  const stepsDone = parsed.filter((step): step is AccountPurgeStep =>
    (ACCOUNT_PURGE_STEPS as readonly unknown[]).includes(step),
  );
  const domainsDone = new Set(
    parsed.filter((step): step is string => typeof step === "string" && step.startsWith("d1:")),
  );
  return { status, stepsDone, domainsDone, composioUserId: composio, r2Prefix: prefix };
}

function positive(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

/**
 * The account purge (§5.6), run by the `account-purge` Trigger task in durable mode and by an api
 * background job otherwise. It needs nothing the crypto-shred destroyed: it reads the
 * `account_deletions` row and plaintext owner-scoped ids, records each finished step, and is safe to
 * run again at any point. Each invocation is bounded; `incomplete` means run it again.
 */
export class AccountPurgeRunner {
  private readonly db: DbClient;
  private readonly store: ObjectStore;
  private readonly now: () => number;
  private readonly runs: AccountPurgeExternalStep;
  private readonly composio: AccountPurgeExternalStep;
  private readonly contributors: readonly PurgeContributor[];
  private readonly batchLimit: number;
  private readonly maxBatches: number;
  private readonly maxObjectDeletes: number;

  constructor(options: AccountPurgeRunnerOptions) {
    this.db = options.db;
    this.store = options.store;
    this.now = options.now;
    this.runs = options.runs;
    this.composio = options.composio;
    this.contributors = options.contributors ?? defaultContributors;
    this.batchLimit = positive("batchLimit", options.batchLimit ?? ACCOUNT_PURGE_LIMITS.batchLimit);
    this.maxBatches = positive("maxBatches", options.maxBatches ?? ACCOUNT_PURGE_LIMITS.maxBatches);
    this.maxObjectDeletes = positive(
      "maxObjectDeletes",
      options.maxObjectDeletes ?? ACCOUNT_PURGE_LIMITS.maxObjectDeletes,
    );
  }

  async run(userId: string): Promise<AccountPurgeResult> {
    const row = await this.db.first(
      sql(
        `SELECT status, steps_done, composio_user_id, r2_prefix FROM account_deletions
         WHERE user_id = :user`,
        { user: userId },
      ),
    );
    if (!row) return { status: "not_found" };
    const deletion = parseDeletion(row);
    if (deletion.status === "done") return { status: "done" };
    if (deletion.r2Prefix !== accountObjectPrefix(userId)) {
      throw new Error("account_deletions.r2_prefix does not match the account");
    }
    const done = new Set<AccountPurgeStep>(deletion.stepsDone);

    for (const step of ACCOUNT_PURGE_STEPS) {
      if (done.has(step)) continue;
      const finished = await this.runStep(step, userId, deletion);
      if (!finished) return { status: "incomplete", stepsDone: [...done] };
      done.add(step);
    }
    return { status: "done" };
  }

  private async runStep(
    step: AccountPurgeStep,
    userId: string,
    deletion: DeletionRow,
  ): Promise<boolean> {
    switch (step) {
      case "runs":
      case "composio": {
        const handler = step === "runs" ? this.runs : this.composio;
        const outcome = await handler.run({ userId, composioUserId: deletion.composioUserId });
        if (outcome !== "done") return false;
        await this.db.run(this.markStep(userId, step));
        return true;
      }
      case "r2":
        return this.purgeObjects(userId, deletion.r2Prefix);
      case "d1":
        return this.purgeRows(userId, deletion.domainsDone);
      case "users":
        return this.deleteUser(userId);
    }
  }

  private markStep(userId: string, step: string): Statement {
    const now = this.now();
    return sql(
      `UPDATE account_deletions
       SET steps_done = json_insert(steps_done, '$[#]', :step), updated_at = :now, write_id = :w
       WHERE user_id = :user
         AND NOT EXISTS (SELECT 1 FROM json_each(account_deletions.steps_done) WHERE value = :step)`,
      { step, now: int(now), w: uuidv7(now), user: userId },
    );
  }

  /** Step 3: lists `u/<userId>/` and deletes one object per request (§1, §5.6). */
  private async purgeObjects(userId: string, prefix: string): Promise<boolean> {
    let deleted = 0;
    for (;;) {
      const page = await this.store.list({ prefix, limit: 1000 });
      if (page.objects.length === 0) {
        await this.db.run(this.markStep(userId, "r2"));
        return true;
      }
      for (const object of page.objects) {
        if (deleted >= this.maxObjectDeletes) return false;
        if (!object.key.startsWith(prefix)) {
          throw new Error("The object store returned a key outside the account prefix");
        }
        await this.store.delete(object.key);
        deleted += 1;
      }
    }
  }

  /**
   * Step 4: each contributor in order, repeated until it reports no rows left (§2.3, §5.6). A domain
   * that finished is recorded, so a resumed invocation continues with the next one.
   */
  private async purgeRows(userId: string, domainsDone: ReadonlySet<string>): Promise<boolean> {
    const input: PurgeInput = { userId, batchLimit: this.batchLimit };
    let batches = 0;
    for (const contributor of this.contributors) {
      const marker = purgedDomainStep(contributor.domain);
      if (domainsDone.has(marker)) continue;
      let ran = false;
      for (;;) {
        const statements = contributor.statements(input);
        if (statements.length === 0) break;
        const remaining = contributor.remaining?.(input) ?? [];
        if (remaining.length === 0) {
          throw new PurgeContributorError(
            contributor.domain,
            "has statements but no remaining check",
          );
        }
        if (batches >= this.maxBatches) return false;
        const results = await this.db.batch([...statements, ...remaining]);
        batches += 1;
        ran = true;
        const left = results.slice(statements.length).some((result) => {
          const value = result.results[0]?.remaining;
          if (value !== 0 && value !== 1) {
            throw new PurgeContributorError(contributor.domain, "returned no remaining flag");
          }
          return value === 1;
        });
        if (!left) break;
      }
      if (ran) await this.db.run(this.markStep(userId, marker));
    }
    await this.db.run(this.markStep(userId, "d1"));
    return true;
  }

  /** Step 5 and 6: tombstone copied from the deletion row, the users row deleted, status `done`. */
  private async deleteUser(userId: string): Promise<boolean> {
    const now = this.now();
    const writeId = uuidv7(now);
    const params = { user: userId, now: int(now) };
    const results = await this.db.batch([
      sql(
        `INSERT INTO account_tombstones (user_id, email_digest, digest_version, deleted_at)
         SELECT user_id, email_digest, email_digest_version, :now FROM account_deletions
         WHERE user_id = :user
         ON CONFLICT (user_id) DO NOTHING`,
        params,
      ),
      sql(`DELETE FROM users WHERE id = :user AND deletion_state = 'deleting'`, { user: userId }),
      sql(
        `UPDATE account_deletions
         SET steps_done = json_insert(steps_done, '$[#]', 'users'), status = 'done',
             completed_at = :now, updated_at = :now, write_id = :w
         WHERE user_id = :user AND status = 'pending'
           AND NOT EXISTS (SELECT 1 FROM users WHERE id = :user)
           AND EXISTS (SELECT 1 FROM account_tombstones WHERE user_id = :user)`,
        { ...params, w: writeId },
      ),
      sql(`SELECT user_id FROM account_deletions WHERE user_id = :user AND write_id = :w`, {
        user: userId,
        w: writeId,
      }),
    ]);
    return verifiedRow(results) !== null;
  }
}
