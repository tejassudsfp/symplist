import type { Statement } from "@symplist/db";
import { analyzeStatement } from "@symplist/db";
import type {
  ArchiveBlockInput,
  ArchiveContributor,
  ArchiveInput,
} from "./archive-contributors/types.ts";

/**
 * The write-id guard every contributed archive statement carries (§2.1): it holds only inside the
 * batch whose deciding statement moved the owner's task tree with `task_tree_write_id =
 * :archive_write_id`.
 */
export const ARCHIVE_GUARD_SQL =
  "EXISTS (SELECT 1 FROM users WHERE id = :archive_owner AND task_tree_write_id = :archive_write_id)";

/** The compiled text of {@link ARCHIVE_GUARD_SQL}, which the runner requires in each statement. */
export const ARCHIVE_GUARD_COMPILED =
  "EXISTS (SELECT 1 FROM users WHERE id = ? AND task_tree_write_id = ?)";

export interface ArchiveGuard {
  /** {@link ARCHIVE_GUARD_SQL}, for a contributed statement's `WHERE` clause. */
  readonly exists: string;
  readonly params: Readonly<{ archive_owner: string; archive_write_id: string }>;
}

/** The guard fragment and parameters of one completion. */
export function archiveGuard(input: Pick<ArchiveInput, "ownerId" | "writeId">): ArchiveGuard {
  return Object.freeze({
    exists: ARCHIVE_GUARD_SQL,
    params: Object.freeze({ archive_owner: input.ownerId, archive_write_id: input.writeId }),
  });
}

/** A contributor broke a structural rule of the archive seam. */
export class ArchiveContributorError extends Error {
  readonly code = "tasks.archive_contributor_invalid";
  readonly domain: string;
  constructor(domain: string, rule: string) {
    super(`Archive contributor ${domain} ${rule}`);
    this.name = "ArchiveContributorError";
    this.domain = domain;
  }
}

/** Tables only the tasks domain writes in the completion batch. */
const reservedTables = new Set(["tasks", "users"]);

function checkStatement(domain: string, statement: Statement, input: ArchiveInput): void {
  const analysis = analyzeStatement(statement.sql);
  if (analysis.statementCount !== 1) {
    throw new ArchiveContributorError(domain, "contributed a statement that is not one statement");
  }
  if (analysis.writeTargets.length === 0) {
    throw new ArchiveContributorError(domain, "contributed a statement that writes nothing");
  }
  if (analysis.writeTargets.some((target) => reservedTables.has(target.name))) {
    throw new ArchiveContributorError(domain, "contributed a statement that writes tasks or users");
  }
  if (!statement.sql.includes(ARCHIVE_GUARD_COMPILED)) {
    throw new ArchiveContributorError(domain, "contributed a statement without the archive guard");
  }
  if (!statement.params.includes(input.ownerId) || !statement.params.includes(input.writeId)) {
    throw new ArchiveContributorError(domain, "bound the archive guard to another owner or write");
  }
}

/**
 * Every contributed statement of a completion, in contributor order, each checked: one statement
 * that writes something other than `tasks` or `users` and carries the archive guard bound to this
 * owner and write id.
 */
export function archiveContributionStatements(
  contributors: readonly ArchiveContributor[],
  input: ArchiveInput,
): Statement[] {
  const statements: Statement[] = [];
  for (const contributor of contributors) {
    for (const statement of contributor.statements(input)) {
      checkStatement(contributor.domain, statement, input);
      statements.push(statement);
    }
  }
  return statements;
}

const namePattern = /^[a-z][a-z0-9_]*$/;

/**
 * The blocking conditions of a completion joined with `OR` (null when no contributor has one), with
 * their parameters. Parameter names must start with the domain name and an underscore and never
 * repeat, so the joined condition can be embedded in the deciding statement.
 */
export function archiveBlockingCondition(
  contributors: readonly ArchiveContributor[],
  input: ArchiveBlockInput,
): { readonly sql: string; readonly params: Record<string, string | readonly string[]> } | null {
  const parts: string[] = [];
  const params: Record<string, string | readonly string[]> = {};
  for (const contributor of contributors) {
    const condition = contributor.blockingCondition?.(input) ?? null;
    if (condition === null) continue;
    if (typeof condition.sql !== "string" || condition.sql.trim().length === 0) {
      throw new ArchiveContributorError(contributor.domain, "returned an empty blocking condition");
    }
    const analysis = analyzeStatement(`SELECT ${condition.sql}`);
    if (analysis.statementCount !== 1 || !analysis.readOnly) {
      throw new ArchiveContributorError(
        contributor.domain,
        "returned a blocking condition that writes",
      );
    }
    for (const [name, value] of Object.entries(condition.params)) {
      const shared = Object.hasOwn(input.taskIdsQuery.params, name);
      if (shared) {
        if (value !== input.taskIdsQuery.params[name]) {
          throw new ArchiveContributorError(contributor.domain, "rebound a shared parameter");
        }
        params[name] = value;
        continue;
      }
      if (!namePattern.test(name) || !name.startsWith(`${contributor.domain}_`)) {
        throw new ArchiveContributorError(
          contributor.domain,
          "named a blocking condition parameter outside its domain prefix",
        );
      }
      if (Object.hasOwn(params, name)) {
        throw new ArchiveContributorError(contributor.domain, "repeated a parameter name");
      }
      params[name] = value;
    }
    parts.push(`(${condition.sql})`);
  }
  if (parts.length === 0) return null;
  return { sql: `(${parts.join(" OR ")})`, params };
}
