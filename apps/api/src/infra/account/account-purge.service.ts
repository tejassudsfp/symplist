import type { AccountPurgeResult, AccountPurgeRunner } from "@symplist/core/account";
import { type DbClient, int, sql } from "@symplist/db";
import type { ExecutorStateReader } from "../executors/executor-state.ts";
import { errorCode, type OperationalLog } from "../scheduler/runtime.ts";

/** How one purge call ended. */
export type AccountPurgeOutcome =
  | AccountPurgeResult["status"]
  /** The purge of this account is already running in this process. */
  | "busy"
  /** `executor_state` no longer records local mode at the generation the work started under. */
  | "stale_generation"
  /** Shutdown or Stop aborted the work between invocations. */
  | "aborted";

export interface AccountPurgeServiceOptions {
  readonly runner: Pick<AccountPurgeRunner, "run">;
  readonly state: Pick<ExecutorStateReader, "readFresh">;
  readonly db: DbClient;
  readonly log: OperationalLog;
  /** Bounded runner invocations per call; each is itself bounded (§5.6). Defaults to 20. */
  readonly maxInvocations?: number;
  /** Pending deletions the background job resumes per firing. Defaults to 20. */
  readonly resumeLimit?: number;
}

/**
 * The account purge in the api when `DURABLE=false` (§5.6, §8.8): the local handler of the
 * `account_purge` intent and the hourly background job call the same `AccountPurgeRunner` the
 * `account-purge` Trigger task calls. Every invocation first confirms that `executor_state` still
 * records local mode at the job's generation, so a purge never continues after an executor switch;
 * an account purges in at most one call at a time in this process.
 */
export class AccountPurgeService {
  private readonly inFlight = new Set<string>();
  private readonly maxInvocations: number;
  private readonly resumeLimit: number;

  constructor(private readonly options: AccountPurgeServiceOptions) {
    this.maxInvocations = options.maxInvocations ?? 20;
    this.resumeLimit = options.resumeLimit ?? 20;
  }

  /** Runs one account's purge until it is done, the invocation budget ends or the job must stop. */
  async purge(
    userId: string,
    context: { readonly generation: number; readonly signal: AbortSignal },
  ): Promise<AccountPurgeOutcome> {
    if (this.inFlight.has(userId)) return "busy";
    this.inFlight.add(userId);
    try {
      for (let invocation = 0; invocation < this.maxInvocations; invocation += 1) {
        if (context.signal.aborted) return "aborted";
        const state = await this.options.state.readFresh();
        if (state.mode !== "local" || state.generation !== context.generation) {
          this.options.log.warn("account.purge_generation_moved", {
            userId,
            generation: context.generation,
          });
          return "stale_generation";
        }
        const result = await this.options.runner.run(userId);
        if (result.status !== "incomplete") {
          if (result.status === "done") {
            this.options.log.info("account.purge_done", {
              userId,
              invocationCount: invocation + 1,
            });
          }
          return result.status;
        }
      }
      this.options.log.info("account.purge_incomplete", {
        userId,
        invocationCount: this.maxInvocations,
      });
      return "incomplete";
    } finally {
      this.inFlight.delete(userId);
    }
  }

  /**
   * The background job: resumes purges still pending (an api restart or an exhausted budget left
   * them), oldest first. One account's failure is logged and the next one still runs.
   */
  async resumePending(context: {
    readonly generation: number;
    readonly signal: AbortSignal;
  }): Promise<{ readonly checked: number; readonly done: number }> {
    const rows = await this.options.db.all<{ user_id: string }>(
      sql(
        `SELECT user_id FROM account_deletions WHERE status = 'pending'
         ORDER BY requested_at, user_id LIMIT :limit`,
        { limit: int(this.resumeLimit) },
      ),
    );
    let checked = 0;
    let done = 0;
    for (const row of rows) {
      if (context.signal.aborted) break;
      checked += 1;
      let outcome: AccountPurgeOutcome;
      try {
        outcome = await this.purge(row.user_id, context);
      } catch (error) {
        this.options.log.warn("account.purge_failed", {
          userId: row.user_id,
          code: errorCode(error),
        });
        continue;
      }
      if (outcome === "done" || outcome === "not_found") done += 1;
      if (outcome === "stale_generation" || outcome === "aborted") break;
    }
    return { checked, done };
  }
}
