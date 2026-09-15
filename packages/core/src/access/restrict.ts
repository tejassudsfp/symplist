import type { DbClient, Statement, StatementResult } from "@symplist/db";
import { analyzeStatement, int, sql, verifiedRow } from "@symplist/db";
import { type AccessPolicy, satisfiesAccess } from "./evaluate.ts";
import { restrictContributors as defaultContributors } from "./restrict-contributors/index.ts";
import type { RestrictContributor } from "./restrict-contributors/types.ts";
import type { AccessService, RestrictInput, RestrictOutcome } from "./service.ts";
import { accessStateFromRow, loadAccessStateStatement, RESTRICT_GUARD_COMPILED } from "./sql.ts";
import type { AccessLevel, AccessState, RestrictionReason } from "./types.ts";

/** At most this many accounts share one restriction batch (campaign revocation, §5.5). */
export const MAX_RESTRICTIONS_PER_BATCH = 5;

/** Announced after a restriction committed, so the api can close sockets, cancel runs and evict caches (§5.5). */
export interface RestrictionCommitted {
  readonly userId: string;
  readonly reason: RestrictionReason;
  /** The generation the restriction produced. */
  readonly accessGeneration: number;
  readonly committedAt: number;
}

/**
 * A post-commit effect of a restriction (§5.5). Effects run in order after the batch committed; a
 * failing effect is reported and the next one still runs, because the commit already took access
 * away and the gateway's periodic generation check is the backstop.
 */
export interface RestrictionEffect {
  readonly name: string;
  afterCommit(event: RestrictionCommitted): Promise<void>;
}

/** A contributed restriction statement broke a structural rule of §5.5. */
export class RestrictContributorError extends Error {
  readonly code = "access.restrict_contributor_invalid";
  readonly domain: string;
  constructor(domain: string, rule: string) {
    super(`Restriction contributor ${domain} ${rule}`);
    this.name = "RestrictContributorError";
    this.domain = domain;
  }
}

export interface D1AccessServiceOptions {
  readonly db: DbClient;
  readonly policy: AccessPolicy;
  /** Defaults to every registered domain contributor (§2.3). */
  readonly contributors?: readonly RestrictContributor[];
  readonly effects?: readonly RestrictionEffect[];
  /** Receives failures of post-commit effects by effect name; never rethrown. */
  readonly onEffectError?: (effect: string, error: unknown) => void;
}

/**
 * The deciding `UPDATE users` of a restriction (§5.5), or null for account deletion, whose statement
 * 1 already changed the users row and set the write id (§5.6).
 */
export function restrictionDecidingStatement(input: RestrictInput): Statement | null {
  const params = {
    user: input.userId,
    w: input.writeId,
    now: int(input.now),
  };
  switch (input.reason) {
    case "relocked":
    case "campaign_revoked":
      return sql(
        `UPDATE users SET beta_state = 'relocked', access_generation = access_generation + 1,
           updated_at = :now, write_id = :w
         WHERE id = :user AND deletion_state = 'none' AND beta_state <> 'relocked'`,
        params,
      );
    case "suspended":
      return sql(
        `UPDATE users SET suspended_at = :now, access_generation = access_generation + 1,
           updated_at = :now, write_id = :w
         WHERE id = :user AND deletion_state = 'none' AND suspended_at IS NULL`,
        params,
      );
    case "deleted":
      return null;
  }
}

function verifyStatement(input: RestrictInput): Statement {
  return sql(`SELECT id, access_generation FROM users WHERE id = :user AND write_id = :w`, {
    user: input.userId,
    w: input.writeId,
  });
}

function checkContributed(domain: string, statement: Statement, input: RestrictInput): void {
  const analysis = analyzeStatement(statement.sql);
  if (analysis.writeTargets.length === 0) {
    throw new RestrictContributorError(domain, "contributed a statement that writes nothing");
  }
  if (analysis.writeTargets.some((target) => target.name === "users")) {
    throw new RestrictContributorError(domain, "contributed a statement that writes users");
  }
  if (!statement.sql.includes(RESTRICT_GUARD_COMPILED)) {
    throw new RestrictContributorError(
      domain,
      "contributed a statement without the write-id guard",
    );
  }
  if (!statement.params.includes(input.userId) || !statement.params.includes(input.writeId)) {
    throw new RestrictContributorError(domain, "bound the write-id guard to another user or write");
  }
}

function checkInput(input: RestrictInput): void {
  if (typeof input.userId !== "string" || input.userId.length === 0) {
    throw new TypeError("restrict needs a user id");
  }
  if (typeof input.writeId !== "string" || input.writeId.length === 0) {
    throw new TypeError("restrict needs a write id");
  }
  if (!Number.isSafeInteger(input.now) || input.now < 0) {
    throw new TypeError("restrict needs a timestamp");
  }
  if ((input.reason === "campaign_revoked") !== (input.campaignId !== undefined)) {
    throw new TypeError("campaignId is required exactly for campaign_revoked");
  }
}

/**
 * `core/access` over D1 (§5.4, §5.5): fresh access reads, level checks and the restriction routine,
 * which runs the state change and every domain's contributed statements in one batch guarded by the
 * users-row write id, then the post-commit effects.
 */
export class D1AccessService implements AccessService {
  private readonly db: DbClient;
  private readonly policy: AccessPolicy;
  private readonly contributors: readonly RestrictContributor[];
  private readonly effects: readonly RestrictionEffect[];
  private readonly onEffectError: (effect: string, error: unknown) => void;

  constructor(options: D1AccessServiceOptions) {
    this.db = options.db;
    this.policy = Object.freeze({ betaAccessRequired: options.policy.betaAccessRequired });
    this.contributors = options.contributors ?? defaultContributors;
    this.effects = options.effects ?? [];
    this.onEffectError = options.onEffectError ?? (() => undefined);
  }

  async load(userId: string): Promise<AccessState | null> {
    const row = await this.db.first(loadAccessStateStatement(userId));
    return row ? accessStateFromRow(row) : null;
  }

  satisfies(state: AccessState, level: AccessLevel): boolean {
    return satisfiesAccess(state, level, this.policy);
  }

  restrictStatements(input: RestrictInput): readonly Statement[] {
    checkInput(input);
    const statements: Statement[] = [];
    const deciding = restrictionDecidingStatement(input);
    if (deciding) statements.push(deciding);
    for (const contributor of this.contributors) {
      for (const statement of contributor.statements(input)) {
        checkContributed(contributor.domain, statement, input);
        statements.push(statement);
      }
    }
    return statements;
  }

  async restrict(input: RestrictInput): Promise<RestrictOutcome> {
    const [outcome] = await this.restrictMany([input]);
    if (!outcome) throw new Error("The restriction batch returned no outcome");
    return outcome;
  }

  /**
   * Restricts several accounts, at most {@link MAX_RESTRICTIONS_PER_BATCH} per D1 batch, each with
   * its own deciding statement, contributions and verification. The effects of a batch run as soon
   * as it committed, so a later failing batch never leaves committed restrictions without their
   * socket closing and run cancellation. Outcomes follow the input order.
   */
  async restrictMany(inputs: readonly RestrictInput[]): Promise<readonly RestrictOutcome[]> {
    for (const input of inputs) {
      if (input.reason === "deleted") {
        throw new TypeError(
          "Account deletion folds restrictStatements into its own batch (§5.6); it cannot run alone",
        );
      }
    }
    if (new Set(inputs.map((input) => input.userId)).size !== inputs.length) {
      throw new TypeError("restrictMany restricts each user once");
    }
    const outcomes: RestrictOutcome[] = [];
    for (let start = 0; start < inputs.length; start += MAX_RESTRICTIONS_PER_BATCH) {
      const chunk = inputs.slice(start, start + MAX_RESTRICTIONS_PER_BATCH);
      const statements: Statement[] = [];
      const verifyIndexes: number[] = [];
      for (const input of chunk) {
        statements.push(...this.restrictStatements(input), verifyStatement(input));
        verifyIndexes.push(statements.length - 1);
      }
      const results = await this.db.batch(statements);
      const committed = chunk.map((input, index) => ({
        input,
        outcome: this.outcome(input, results, verifyIndexes[index] ?? -1),
      }));
      for (const { input, outcome } of committed) {
        outcomes.push(outcome);
        if (outcome.applied && outcome.accessGeneration !== null) {
          await this.afterRestriction({
            userId: input.userId,
            reason: input.reason,
            accessGeneration: outcome.accessGeneration,
            committedAt: input.now,
          });
        }
      }
    }
    return outcomes;
  }

  /**
   * Runs the post-commit effects of a committed restriction. Account deletion calls this after its
   * own batch (§5.6); `restrict` calls it itself.
   */
  async afterRestriction(event: RestrictionCommitted): Promise<void> {
    for (const effect of this.effects) {
      try {
        await effect.afterCommit(event);
      } catch (error) {
        this.onEffectError(effect.name, error);
      }
    }
  }

  private outcome(
    input: RestrictInput,
    results: readonly StatementResult[],
    verifyIndex: number,
  ): RestrictOutcome {
    const row = verifiedRow(results, verifyIndex);
    const generation = row?.access_generation;
    if (row && (typeof generation !== "number" || !Number.isSafeInteger(generation))) {
      throw new Error("The restriction verification returned no access generation");
    }
    return Object.freeze({
      userId: input.userId,
      applied: row !== null,
      accessGeneration: row ? (generation as number) : null,
    });
  }
}
