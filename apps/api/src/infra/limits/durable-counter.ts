import { Inject, Injectable } from "@nestjs/common";
import type { DbClient, DbRow, Statement } from "@symplist/db";
import { int, sql, uuidv7 } from "@symplist/db";
import { DB_CLIENT } from "../db/db.providers.ts";

/** A durable counter policy: at most `limit` hits per window, then an optional lockout. */
export interface DurableCounterPolicy {
  readonly limit: number;
  readonly windowMs: number;
  /** When set, the hit that exceeds `limit` locks the subject for this long. */
  readonly lockoutMs?: number;
}

export interface DurableCounterKey {
  /** A lowercase dotted scope such as `vault.unlock_user`. */
  readonly scope: string;
  /** An opaque id or HMAC digest, never a raw email address, IP address or credential. */
  readonly subject: string;
}

export interface DurableCounterState {
  readonly count: number;
  readonly lockedUntil: number | null;
  /** Whether a further attempt is allowed now. */
  readonly allowed: boolean;
  /** Whole seconds until an attempt is allowed again; 0 when allowed. */
  readonly retryAfterSeconds: number;
}

const scopePattern = /^[a-z0-9_.]{1,64}$/;

function checkKey(key: DurableCounterKey): void {
  if (!scopePattern.test(key.scope))
    throw new TypeError("Counter scopes are lowercase dotted names");
  if (typeof key.subject !== "string" || key.subject.length < 1 || key.subject.length > 128) {
    throw new TypeError("Counter subjects are 1 to 128 characters");
  }
}

function checkPolicy(policy: DurableCounterPolicy): void {
  if (!Number.isSafeInteger(policy.limit) || policy.limit < 1) {
    throw new RangeError("Counter limits are positive integers");
  }
  if (!Number.isSafeInteger(policy.windowMs) || policy.windowMs < 1) {
    throw new RangeError("Counter windows are positive milliseconds");
  }
  if (
    policy.lockoutMs !== undefined &&
    (!Number.isSafeInteger(policy.lockoutMs) || policy.lockoutMs < 1)
  ) {
    throw new RangeError("Counter lockouts are positive milliseconds");
  }
}

function integerOrNull(row: DbRow, column: string): number | null {
  const value = row[column];
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`Unexpected abuse_counters.${column}`);
  }
  return value;
}

/**
 * Durable abuse counters in D1 (`abuse_counters`, §5.8) for limits that protect a secret and must
 * survive restarts and deploys. Each operation is available as statements, so the counter update
 * folds into the batch that performs the attempt, and as a method that runs its own batch.
 */
@Injectable()
export class DurableCounterService {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  /**
   * Counts an attempt: an expired window or an expired lockout starts a new window, a live lockout
   * is never extended or counted, and the hit that exceeds the limit starts the lockout. The last
   * statement reads the resulting row for {@link stateFrom}.
   */
  hitStatements(key: DurableCounterKey, policy: DurableCounterPolicy, now: number): Statement[] {
    checkKey(key);
    checkPolicy(policy);
    const params = { scope: key.scope, subject: key.subject, now: int(now) };
    const lockout = int(policy.lockoutMs ?? 0);
    return [
      sql(
        `UPDATE abuse_counters
         SET count = 0, window_start = :now, locked_until = NULL, updated_at = :now, write_id = :w
         WHERE scope = :scope AND subject = :subject
           AND ((locked_until IS NOT NULL AND locked_until <= :now)
             OR (locked_until IS NULL AND window_start + CAST(:window AS INTEGER) <= CAST(:now AS INTEGER)))`,
        { ...params, window: int(policy.windowMs), w: uuidv7(now) },
      ),
      sql(
        `INSERT INTO abuse_counters
           (scope, subject, window_start, count, locked_until, expires_at, updated_at, write_id)
         VALUES (:scope, :subject, :now, 1,
           CASE WHEN 1 > CAST(:limit AS INTEGER) AND CAST(:lockout AS INTEGER) > 0
             THEN CAST(:now AS INTEGER) + CAST(:lockout AS INTEGER) ELSE NULL END,
           CAST(:now AS INTEGER) + MAX(CAST(:window AS INTEGER), CAST(:lockout AS INTEGER)), :now, :w)
         ON CONFLICT (scope, subject) DO UPDATE SET
           count = abuse_counters.count + 1,
           locked_until = CASE
             WHEN abuse_counters.count + 1 > CAST(:limit AS INTEGER) AND CAST(:lockout AS INTEGER) > 0
             THEN CAST(:now AS INTEGER) + CAST(:lockout AS INTEGER)
             ELSE NULL END,
           expires_at = MAX(
             abuse_counters.window_start + CAST(:window AS INTEGER),
             CASE
               WHEN abuse_counters.count + 1 > CAST(:limit AS INTEGER) AND CAST(:lockout AS INTEGER) > 0
               THEN CAST(:now AS INTEGER) + CAST(:lockout AS INTEGER)
               ELSE 0 END),
           updated_at = excluded.updated_at,
           write_id = excluded.write_id
         WHERE abuse_counters.locked_until IS NULL OR abuse_counters.locked_until <= CAST(:now AS INTEGER)`,
        {
          ...params,
          limit: int(policy.limit),
          lockout,
          window: int(policy.windowMs),
          w: uuidv7(now),
        },
      ),
      this.selectStatement(key),
    ];
  }

  /** Reads a counter row; the result feeds {@link stateFrom}. */
  selectStatement(key: DurableCounterKey): Statement {
    checkKey(key);
    return sql(
      `SELECT count, window_start, locked_until FROM abuse_counters
       WHERE scope = :scope AND subject = :subject`,
      { scope: key.scope, subject: key.subject },
    );
  }

  /** Clears a counter, for example after a successful verification. */
  resetStatement(key: DurableCounterKey): Statement {
    checkKey(key);
    return sql(`DELETE FROM abuse_counters WHERE scope = :scope AND subject = :subject`, {
      scope: key.scope,
      subject: key.subject,
    });
  }

  /** Deletes up to `limit` rows that no longer carry state; for the hourly cleanup. */
  expiredDeletionStatement(now: number, limit: number): Statement {
    return sql(
      `DELETE FROM abuse_counters WHERE rowid IN (
         SELECT rowid FROM abuse_counters
         WHERE expires_at <= :now AND (locked_until IS NULL OR locked_until <= :now)
         LIMIT CAST(:limit AS INTEGER))`,
      { now: int(now), limit: int(limit) },
    );
  }

  /** Interprets a counter row (or its absence) under a policy. */
  stateFrom(
    row: DbRow | null | undefined,
    policy: DurableCounterPolicy,
    now: number,
  ): DurableCounterState {
    if (!row) return { count: 0, lockedUntil: null, allowed: true, retryAfterSeconds: 0 };
    const count = integerOrNull(row, "count") ?? 0;
    const windowStart = integerOrNull(row, "window_start") ?? now;
    const lockedUntil = integerOrNull(row, "locked_until");
    if (lockedUntil !== null && lockedUntil > now) {
      return {
        count,
        lockedUntil,
        allowed: false,
        retryAfterSeconds: Math.ceil((lockedUntil - now) / 1000),
      };
    }
    if (lockedUntil !== null || windowStart + policy.windowMs <= now) {
      return { count: 0, lockedUntil: null, allowed: true, retryAfterSeconds: 0 };
    }
    if (count > policy.limit) {
      const retryMs = windowStart + policy.windowMs - now;
      return {
        count,
        lockedUntil: null,
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(retryMs / 1000)),
      };
    }
    return { count, lockedUntil: null, allowed: true, retryAfterSeconds: 0 };
  }

  /** Counts an attempt in its own batch and returns whether it is within the policy. */
  async hit(
    key: DurableCounterKey,
    policy: DurableCounterPolicy,
    now: number,
  ): Promise<DurableCounterState> {
    const results = await this.db.batch(this.hitStatements(key, policy, now));
    return this.stateFrom(results.at(-1)?.results[0], policy, now);
  }

  /** Reads whether an attempt would be allowed, without counting it. */
  async peek(
    key: DurableCounterKey,
    policy: DurableCounterPolicy,
    now: number,
  ): Promise<DurableCounterState> {
    checkPolicy(policy);
    const row = await this.db.first(this.selectStatement(key));
    const state = this.stateFrom(row, policy, now);
    // A peek asks whether one more attempt fits, so a full window is already a refusal.
    if (state.allowed && state.count >= policy.limit) {
      const windowStart = integerOrNull(row ?? {}, "window_start") ?? now;
      return {
        ...state,
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((windowStart + policy.windowMs - now) / 1000)),
      };
    }
    return state;
  }

  async reset(key: DurableCounterKey): Promise<void> {
    await this.db.run(this.resetStatement(key));
  }
}
