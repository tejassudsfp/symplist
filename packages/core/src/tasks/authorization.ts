import { type Statement, sql } from "@symplist/db";
import type { AccessPolicy } from "../access/evaluate.ts";
import { accessCondition } from "../access/sql.ts";
import { TaskOperationError } from "./errors.ts";

/** Constructed by a trusted run/grant adapter, never by a tool or HTTP argument. */
export interface TaskAuthorization {
  readonly sql: string;
  readonly params: Readonly<Record<string, string>>;
}

export function validateTaskAuthorization(authorization?: TaskAuthorization): void {
  if (!authorization) return;
  if (
    Object.keys(authorization.params).some(
      (name) => !name.startsWith("task_auth_") || name === "task_auth_owner",
    )
  )
    throw new TaskOperationError("not_found");
  // Compile independently: a guard cannot borrow or shadow the operation identity's binds.
  sql(authorization.sql, authorization.params);
}

export function taskAuthority(
  ownerId: string,
  policy: AccessPolicy,
  authorization?: TaskAuthorization,
): Statement {
  validateTaskAuthorization(authorization);
  return sql(
    `${accessCondition({ level: "admitted", policy, userParam: "task_auth_owner" })}
      AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :task_auth_owner)
      ${authorization ? `AND (${authorization.sql})` : ""}`,
    { task_auth_owner: ownerId, ...authorization?.params },
  );
}
