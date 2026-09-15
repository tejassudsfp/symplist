import type { DbRow, Statement } from "@symplist/db";
import { assertIdentifier, sql } from "@symplist/db";
import type { AccessPolicy } from "./evaluate.ts";
import type {
  AccessLevel,
  AccessState,
  BetaState,
  DeletionState,
  OnboardingStep,
  UserRole,
} from "./types.ts";

/** The `users` columns that make up the access state (§5.4), in a fixed order. */
export const ACCESS_STATE_COLUMNS = Object.freeze([
  "email_verified_at",
  "beta_state",
  "suspended_at",
  "onboarding_step",
  "role",
  "access_generation",
  "access_epoch",
  "deletion_state",
] as const);

/** Thrown when a row read from D1 does not have the shape the schema guarantees. */
export class AccessRowError extends Error {
  readonly code = "access.row_invalid";
  constructor(column: string) {
    super(`Unexpected value in users.${column}`);
    this.name = "AccessRowError";
  }
}

function integerColumn(row: DbRow, column: string): number {
  const value = row[column];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new AccessRowError(column);
  }
  return value;
}

function nullableIntegerColumn(row: DbRow, column: string): number | null {
  return row[column] === null ? null : integerColumn(row, column);
}

function enumColumn<const Value extends string>(
  row: DbRow,
  column: string,
  values: readonly Value[],
): Value {
  const value = row[column];
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    throw new AccessRowError(column);
  }
  return value as Value;
}

/**
 * Maps the access columns of a row to an `AccessState`. `prefix` is prepended to each column name,
 * for joins that alias the columns (for example `u_beta_state`).
 */
export function accessStateFromRow(row: DbRow, prefix = ""): AccessState {
  const column = (name: string) => `${prefix}${name}`;
  return Object.freeze({
    emailVerifiedAt: nullableIntegerColumn(row, column("email_verified_at")),
    betaState: enumColumn<BetaState>(row, column("beta_state"), ["locked", "unlocked", "relocked"]),
    suspendedAt: nullableIntegerColumn(row, column("suspended_at")),
    onboardingStep: enumColumn<OnboardingStep>(row, column("onboarding_step"), [
      "name",
      "connections",
      "done",
    ]),
    role: enumColumn<UserRole>(row, column("role"), ["member", "admin"]),
    accessGeneration: integerColumn(row, column("access_generation")),
    accessEpoch: integerColumn(row, column("access_epoch")),
    deletionState: enumColumn<DeletionState>(row, column("deletion_state"), ["none", "deleting"]),
  });
}

/** The access-state select list for a `users` alias, with columns renamed by `prefix`. */
export function accessStateSelectList(alias: string, prefix = ""): string {
  const table = assertIdentifier(alias);
  return ACCESS_STATE_COLUMNS.map(
    (name) => `${table}.${name} AS ${assertIdentifier(`${prefix}${name}`)}`,
  ).join(", ");
}

/** A fresh read of one user's access fields (§3.3). */
export function loadAccessStateStatement(userId: string): Statement {
  return sql(`SELECT ${ACCESS_STATE_COLUMNS.join(", ")} FROM users WHERE id = :user`, {
    user: userId,
  });
}

export interface AccessConditionOptions {
  readonly level: AccessLevel;
  readonly policy: AccessPolicy;
  /** Name of the named parameter that holds the user id; defaults to `access_user`. */
  readonly userParam?: string;
  /**
   * Name of a named parameter holding the `access_generation` the caller authorized against. When
   * set, the condition also fails once any restriction or restore has changed the generation.
   */
  readonly generationParam?: string;
}

/**
 * An `EXISTS (…)` condition that holds only while the user satisfies `level` (§5.4), for folding the
 * access check into the deciding statement of a mutation or run step batch (§3.1, §5.4). The caller
 * supplies the named parameters.
 */
export function accessCondition(options: AccessConditionOptions): string {
  const user = assertIdentifier(options.userParam ?? "access_user");
  const clauses = [`id = :${user}`, "deletion_state = 'none'"];
  if (options.level !== "identity") {
    clauses.push("email_verified_at IS NOT NULL", "suspended_at IS NULL");
    clauses.push(
      options.policy.betaAccessRequired ? "beta_state = 'unlocked'" : "beta_state <> 'relocked'",
    );
  }
  if (options.level === "admin") clauses.push("role = 'admin'");
  if (options.generationParam !== undefined) {
    clauses.push(
      `access_generation = CAST(:${assertIdentifier(options.generationParam)} AS INTEGER)`,
    );
  }
  return `EXISTS (SELECT 1 FROM users WHERE ${clauses.join(" AND ")})`;
}

/**
 * The write-id guard every restriction statement carries (§5.5): the statement takes effect only in
 * the batch whose deciding `UPDATE users` set `write_id = :restrict_write_id`.
 */
export const RESTRICT_GUARD_SQL =
  "EXISTS (SELECT 1 FROM users WHERE id = :restrict_user AND write_id = :restrict_write_id)";

/** The compiled text of {@link RESTRICT_GUARD_SQL}, which the restriction runner requires. */
export const RESTRICT_GUARD_COMPILED = "EXISTS (SELECT 1 FROM users WHERE id = ? AND write_id = ?)";

export interface RestrictGuard {
  /** `RESTRICT_GUARD_SQL`, to append to a contributed statement's `WHERE` clause. */
  readonly exists: string;
  /** Named parameters referenced by `exists`. */
  readonly params: Readonly<{ restrict_user: string; restrict_write_id: string }>;
}

/** The guard fragment and its parameters for one restriction. */
export function restrictGuard(input: {
  readonly userId: string;
  readonly writeId: string;
}): RestrictGuard {
  return Object.freeze({
    exists: RESTRICT_GUARD_SQL,
    params: Object.freeze({ restrict_user: input.userId, restrict_write_id: input.writeId }),
  });
}
