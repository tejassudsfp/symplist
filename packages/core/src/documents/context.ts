import type { AccountDataKey } from "@symplist/crypto";
import type { StatementResult } from "@symplist/db";
import { sql } from "@symplist/db";
import { DocumentError, type SqlGuard } from "@symplist/docs";
import { type AccessDenialCode, type AccessPolicy, evaluateAccess } from "../access/evaluate.ts";
import { accessCondition, accessStateFromRow, accessStateSelectList } from "../access/sql.ts";
import type { AccountKeyStore } from "../account/keys.ts";

/** Access was denied for the task's owner (§5.4): the stable code the api returns. */
export class DocumentAccessDeniedError extends Error {
  readonly code: AccessDenialCode;
  constructor(code: AccessDenialCode) {
    super(code);
    this.name = "DocumentAccessDeniedError";
    this.code = code;
  }
}

/**
 * The task, access and key reads every document operation folds into its first D1 batch (§3.1), and
 * the guards every write folds into its deciding statement: the task is the owner's and active (§2.1)
 * and the owner is still admitted (§5.4).
 */
export class DocumentAccessContext {
  constructor(
    private readonly accountKeys: AccountKeyStore,
    private readonly policy: AccessPolicy,
  ) {}

  /** Two statements: the task with its owner's access fields, and the owner's key row. */
  statements(ownerId: string, taskId: string) {
    return [
      sql(
        `SELECT t.status AS task_status, ${accessStateSelectList("u", "u_")}
         FROM tasks t JOIN users u ON u.id = t.owner_id
         WHERE t.id = :task AND t.owner_id = :owner`,
        { task: taskId, owner: ownerId },
      ),
      this.accountKeys.selectStatement(ownerId),
    ];
  }

  /**
   * Interprets the two results: an unknown or foreign task is `not_found`; lost access is its access
   * code; a write to an archived task is `task.archived`. Returns the unwrapped account key, which
   * the caller zeroizes.
   */
  verify(
    results: readonly StatementResult[],
    options: { readonly write: boolean },
  ): AccountDataKey {
    const task = results[0]?.results[0];
    if (!task) throw new DocumentError("not_found");
    const decision = evaluateAccess(accessStateFromRow(task, "u_"), "admitted", this.policy);
    if (!decision.allowed) throw new DocumentAccessDeniedError(decision.code);
    if (options.write && task.task_status !== "active") throw new DocumentError("task.archived");
    const key = results[1]?.results[0];
    if (!key) throw new DocumentError("not_found");
    return this.accountKeys.unwrapRow(key);
  }

  /** The active-task and admitted-access guards for a write (§2.1, §5.4). */
  guards(ownerId: string, taskId: string): SqlGuard[] {
    return [
      {
        sql: "EXISTS (SELECT 1 FROM tasks WHERE id = :doc_task AND owner_id = :doc_owner AND status = 'active')",
        params: { doc_task: taskId, doc_owner: ownerId },
      },
      this.accessGuard(ownerId),
    ];
  }

  /** The admitted-access guard alone, for writes that do not need an active task (draft clean-up). */
  accessGuard(ownerId: string): SqlGuard {
    return {
      sql: accessCondition({
        level: "admitted",
        policy: this.policy,
        userParam: "doc_access_user",
      }),
      params: { doc_access_user: ownerId },
    };
  }
}
