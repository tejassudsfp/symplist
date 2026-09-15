import type { OtpChallengeResponse, OtpPurpose } from "@symplist/contracts";
import { normalizeEmail } from "@symplist/contracts";
import type { KeyProvider, VersionedDigest } from "@symplist/crypto";
import {
  computeDigest,
  computeDigestCandidates,
  computeOtpDigest,
  generateOtp,
  verifyOtpDigest,
} from "@symplist/crypto";
import type { DbClient, RequestPriority, Statement, StatementResult } from "@symplist/db";
import { int, sql, uuidv7, verifiedRow } from "@symplist/db";
import { AccessFeatureError, retryAfterSeconds } from "./feature-error.ts";
import { integerColumn, nullableIntegerColumn, textColumn } from "./rows.ts";
import type { StatementGuard } from "./sessions.ts";

/** Durable OTP abuse limits (§5.1, §5.8). */
export const OTP_LIMITS = Object.freeze({
  /** Challenges per email and purpose per rolling hour window. */
  challengesPerHour: 5,
  /** Challenges per email and purpose per 24-hour window. */
  challengesPerDay: 10,
  /** Failed verifications per email and purpose per 24 hours, across all challenges. */
  failuresPerDay: 10,
  /** Verification is refused this long once the failure limit is reached. */
  lockoutMs: 60 * 60 * 1000,
  /** A new challenge for the same user and purpose waits this long. */
  resendCooldownMs: 60 * 1000,
  hourMs: 60 * 60 * 1000,
  dayMs: 24 * 60 * 60 * 1000,
});

/** Purposes bound to the auth session that requested them (§5.1). */
const sessionBoundPurposes: ReadonlySet<OtpPurpose> = new Set(["vault_reset", "account_delete"]);

/** One OTP email to hand to the provider. */
export interface OtpDelivery {
  /** The normalized address. */
  readonly email: string;
  readonly purpose: OtpPurpose;
  readonly challengeId: string;
  /** The code; it exists only in memory and in the email itself (§6.3). */
  readonly code: string;
  readonly expiresInMinutes: number;
}

/**
 * Sends OTP emails from the security sender (§5.1); reminder preferences never suppress them. The api
 * implements it over the email package and its transport. Throws when the email was not accepted.
 */
export interface OtpMailer {
  send(delivery: OtpDelivery): Promise<void>;
}

export interface OtpServiceOptions {
  readonly db: DbClient;
  readonly keys: KeyProvider;
  readonly mailer: OtpMailer;
  readonly now: () => number;
  /** `OTP_LENGTH`. */
  readonly codeLength: number;
  /** `OTP_TTL_MINUTES`. */
  readonly ttlMinutes: number;
  /** `OTP_MAX_ATTEMPTS`: attempts per challenge. */
  readonly maxAttempts: number;
}

/** What the successful verification folds into the consuming batch. */
export interface OtpSuccessContext {
  readonly userId: string;
  readonly email: string;
  readonly purpose: OtpPurpose;
  readonly challengeId: string;
  /** Holds only in the batch whose challenge consumption applied; guard every effect with it. */
  readonly guard: StatementGuard;
  readonly now: number;
}

export interface OtpSuccessPlan<T> {
  readonly statements: readonly Statement[];
  /** Reads the effect's results (`offset` is the index of `statements[0]` in the batch). */
  decide(results: readonly StatementResult[], offset: number): T;
}

export interface OtpVerifyInput<T> {
  readonly challengeId: string;
  readonly code: string;
  /** The purposes this endpoint verifies; any other challenge reads as expired. */
  readonly purposes: readonly OtpPurpose[];
  /** Session-bound purposes: the challenge must belong to this user and auth session. */
  readonly binding?: { readonly userId: string; readonly sessionId: string };
  readonly priority?: RequestPriority;
  readonly success: (context: OtpSuccessContext) => OtpSuccessPlan<T>;
}

export interface OtpVerified<T> {
  readonly userId: string;
  readonly email: string;
  readonly purpose: OtpPurpose;
  readonly value: T;
}

interface SendTarget {
  readonly purpose: OtpPurpose;
  readonly email: string;
  /** SQL condition over `users u` selecting the eligible user; uses only the named params below. */
  readonly userCondition: string;
  readonly userParams: Readonly<Record<string, string>>;
  readonly sessionId: string | null;
  /** Extra statements placed before the challenge statements (the signup's pending account). */
  readonly prelude: readonly Statement[];
  readonly priority: RequestPriority;
}

/**
 * Email OTP challenges (§5.1): 6-digit codes from `crypto.randomInt` stored as digests bound to the
 * challenge id and purpose, a 10-minute expiry, a per-challenge attempt budget reserved atomically
 * before a result counts, a 60-second resend cooldown, a resend that supersedes the live challenge,
 * and durable per-address limits in `otp_limits` that survive restarts: 5 challenges per hour and 10
 * per day, and 10 failed verifications per day across challenges, after which verification is
 * refused for an hour. A successful verification clears the failure count.
 */
export class OtpService {
  private readonly options: OtpServiceOptions;

  constructor(options: OtpServiceOptions) {
    if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
      throw new RangeError("maxAttempts must be a positive integer");
    }
    this.options = options;
  }

  get codeLength(): number {
    return this.options.codeLength;
  }

  /** The limit key digests of an address under every configured version (§4.3). */
  emailDigests(email: string): {
    readonly current: VersionedDigest;
    readonly candidates: readonly string[];
  } {
    const normalized = normalizeEmail(email);
    return {
      current: computeDigest(this.options.keys, "OTP_DIGEST_SECRET", "otp-limit-email", normalized),
      candidates: computeDigestCandidates(
        this.options.keys,
        "OTP_DIGEST_SECRET",
        "otp-limit-email",
        normalized,
      ).map((candidate) => candidate.digest),
    };
  }

  /**
   * `POST /v1/auth/lookup`: whether a verified account (or one being deleted) uses the address. A
   * pending registration reads as absent, so the person confirms signup again.
   */
  async lookup(email: string): Promise<boolean> {
    const row = await this.options.db.first(
      sql(`SELECT email_verified_at, deletion_state FROM users WHERE email = :email`, {
        email: normalizeEmail(email),
      }),
      { priority: "unauthenticated" },
    );
    if (!row) return false;
    return row.email_verified_at !== null || row.deletion_state !== "none";
  }

  /** `POST /v1/auth/otp`: a login code for a verified account that is not being deleted. */
  sendLogin(email: string): Promise<OtpChallengeResponse> {
    const normalized = normalizeEmail(email);
    return this.send({
      purpose: "login",
      email: normalized,
      userCondition:
        "u.email = :target_email AND u.email_verified_at IS NOT NULL AND u.deletion_state = 'none'",
      userParams: { target_email: normalized },
      sessionId: null,
      prelude: [],
      priority: "unauthenticated",
    });
  }

  /**
   * `POST /v1/auth/signup`: creates the pending account when the address is unused (idempotently)
   * and sends a signup code while the account is unverified.
   */
  signup(email: string): Promise<OtpChallengeResponse> {
    const normalized = normalizeEmail(email);
    const now = this.options.now();
    return this.send({
      purpose: "signup",
      email: normalized,
      userCondition:
        "u.email = :target_email AND u.email_verified_at IS NULL AND u.deletion_state = 'none'",
      userParams: { target_email: normalized },
      sessionId: null,
      prelude: [
        sql(
          `INSERT INTO users (id, email, created_at, updated_at, write_id)
           VALUES (:id, :email, :now, :now, :w)
           ON CONFLICT (email) DO NOTHING`,
          { id: uuidv7(now), email: normalized, now: int(now), w: uuidv7(now) },
        ),
      ],
      priority: "unauthenticated",
    });
  }

  /**
   * A code for a session-bound purpose (`account_delete`, `vault_reset`): the challenge records the
   * requesting auth session, and only that session can verify it.
   */
  async sendForSession(input: {
    readonly userId: string;
    readonly sessionId: string;
    readonly purpose: "account_delete" | "vault_reset";
  }): Promise<OtpChallengeResponse> {
    const row = await this.options.db.first(
      sql(`SELECT email FROM users WHERE id = :user AND deletion_state = 'none'`, {
        user: input.userId,
      }),
    );
    if (!row) throw new AccessFeatureError("auth.session_required");
    const email = normalizeEmail(textColumn(row, "email"));
    return this.send({
      purpose: input.purpose,
      email,
      userCondition: `u.id = :target_user AND u.deletion_state = 'none'
        AND EXISTS (SELECT 1 FROM auth_sessions s WHERE s.id = :target_session AND s.user_id = u.id
          AND s.revoked_at IS NULL AND s.expires_at > CAST(:target_now AS INTEGER))`,
      userParams: {
        target_user: input.userId,
        target_session: input.sessionId,
        target_now: int(this.options.now()),
      },
      sessionId: input.sessionId,
      prelude: [],
      priority: "authenticated",
    });
  }

  private async send(target: SendTarget): Promise<OtpChallengeResponse> {
    const { db, keys } = this.options;
    const now = this.options.now();
    const challengeId = uuidv7(now);
    const challengeWrite = uuidv7(now);
    const code = generateOtp(this.options.codeLength);
    const codeDigest = computeOtpDigest(keys, { challengeId, purpose: target.purpose, code });
    const limitKey = this.emailDigests(target.email);
    const expiresAt = now + this.options.ttlMinutes * 60_000;
    const userSelect = `SELECT u.id FROM users u WHERE ${target.userCondition}`;
    const allowed = `NOT EXISTS (
        SELECT 1 FROM otp_challenges c2 WHERE c2.user_id IN (${userSelect}) AND c2.purpose = :purpose
          AND c2.consumed_at IS NULL AND c2.created_at > CAST(:now AS INTEGER) - CAST(:cooldown AS INTEGER))
      AND NOT EXISTS (
        SELECT 1 FROM otp_limits l WHERE l.email_digest IN (:digests) AND l.purpose = :purpose
          AND (l.hour_challenges >= CAST(:per_hour AS INTEGER) OR l.day_challenges >= CAST(:per_day AS INTEGER)))`;
    const shared = {
      ...target.userParams,
      purpose: target.purpose,
      now: int(now),
      cooldown: int(OTP_LIMITS.resendCooldownMs),
      digests: limitKey.candidates,
      per_hour: int(OTP_LIMITS.challengesPerHour),
      per_day: int(OTP_LIMITS.challengesPerDay),
    };

    const statements: Statement[] = [
      ...target.prelude,
      this.windowResetStatement(limitKey.candidates, target.purpose, now),
      sql(
        `UPDATE otp_challenges SET superseded_at = :now, write_id = :supersede_write
         WHERE user_id IN (${userSelect}) AND purpose = :purpose
           AND consumed_at IS NULL AND superseded_at IS NULL AND ${allowed}`,
        { ...shared, supersede_write: uuidv7(now) },
      ),
      sql(
        `INSERT INTO otp_challenges
           (id, user_id, purpose, auth_session_id, code_digest, digest_version, attempts, created_at,
            expires_at, consumed_at, superseded_at, write_id)
         SELECT :challenge, u.id, :purpose, :session, :code_digest, :code_version, 0, :now, :expires,
                NULL, NULL, :challenge_write
         FROM users u WHERE ${target.userCondition} AND ${allowed}
         ON CONFLICT DO NOTHING`,
        {
          ...shared,
          challenge: challengeId,
          session: target.sessionId,
          code_digest: codeDigest.digest,
          code_version: int(codeDigest.version),
          expires: int(expiresAt),
          challenge_write: challengeWrite,
        },
      ),
      // Counted on the address's existing row under any configured digest version, so rotating
      // OTP_DIGEST_SECRET never resets a count; a row under the current version starts otherwise.
      sql(
        `UPDATE otp_limits SET hour_challenges = hour_challenges + 1, day_challenges = day_challenges + 1,
           updated_at = :now, write_id = :limit_write
         WHERE email_digest IN (:digests) AND purpose = :purpose
           AND EXISTS (SELECT 1 FROM otp_challenges WHERE id = :challenge AND write_id = :challenge_write)`,
        {
          digests: limitKey.candidates,
          purpose: target.purpose,
          now: int(now),
          limit_write: uuidv7(now),
          challenge: challengeId,
          challenge_write: challengeWrite,
        },
      ),
      sql(
        `INSERT INTO otp_limits
           (email_digest, digest_version, purpose, hour_window_start, hour_challenges, day_window_start,
            day_challenges, failure_window_start, failures, locked_until, updated_at, write_id)
         SELECT :digest, :digest_version, :purpose, :now, 1, :now, 1, NULL, 0, NULL, :now, :limit_write
         WHERE EXISTS (SELECT 1 FROM otp_challenges WHERE id = :challenge AND write_id = :challenge_write)
           AND NOT EXISTS (SELECT 1 FROM otp_limits WHERE email_digest IN (:digests) AND purpose = :purpose)
         ON CONFLICT DO NOTHING`,
        {
          digest: limitKey.current.digest,
          digest_version: int(limitKey.current.version),
          digests: limitKey.candidates,
          purpose: target.purpose,
          now: int(now),
          limit_write: uuidv7(now),
          challenge: challengeId,
          challenge_write: challengeWrite,
        },
      ),
      sql(`SELECT id FROM otp_challenges WHERE id = :challenge AND write_id = :challenge_write`, {
        challenge: challengeId,
        challenge_write: challengeWrite,
      }),
      sql(
        `SELECT u.id, u.email_verified_at, u.deletion_state FROM users u WHERE ${
          target.sessionId === null ? "u.email = :email" : "u.id = :user"
        }`,
        target.sessionId === null
          ? { email: target.email }
          : { user: target.userParams.target_user ?? "" },
      ),
      sql(
        `SELECT MAX(c.created_at) AS last_created FROM otp_challenges c
         JOIN users u ON u.id = c.user_id
         WHERE ${target.sessionId === null ? "u.email = :email" : "u.id = :user"}
           AND c.purpose = :purpose AND c.consumed_at IS NULL AND c.id <> :challenge`,
        target.sessionId === null
          ? { email: target.email, purpose: target.purpose, challenge: challengeId }
          : {
              user: target.userParams.target_user ?? "",
              purpose: target.purpose,
              challenge: challengeId,
            },
      ),
      sql(
        `SELECT hour_window_start, hour_challenges, day_window_start, day_challenges
         FROM otp_limits WHERE email_digest IN (:digests) AND purpose = :purpose`,
        { digests: limitKey.candidates, purpose: target.purpose },
      ),
      sql(
        `SELECT COUNT(*) AS live FROM auth_sessions WHERE id = :session AND user_id = :user
           AND revoked_at IS NULL AND expires_at > CAST(:now AS INTEGER)`,
        {
          session: target.sessionId ?? "",
          user: target.userParams.target_user ?? "",
          now: int(now),
        },
      ),
    ];
    const verifyIndex = statements.length - 5;
    const results = await db.batch(statements, { priority: target.priority });

    if (!verifiedRow(results, verifyIndex)) {
      throw this.sendRefusal(target, results.slice(verifyIndex + 1), now);
    }

    try {
      await this.deliver(target, challengeId, code);
    } catch (error) {
      // Nothing reached the person: remove the challenge so a retry is not held by the cooldown.
      // The hourly and daily counts keep this attempt, so forced failures cannot bypass them.
      await db
        .run(
          sql(`DELETE FROM otp_challenges WHERE id = :challenge AND consumed_at IS NULL`, {
            challenge: challengeId,
          }),
          { priority: target.priority },
        )
        .catch(() => undefined);
      throw error instanceof AccessFeatureError
        ? error
        : new AccessFeatureError("auth.delivery_failed");
    }
    return {
      challengeId,
      purpose: target.purpose,
      expiresAt,
      resendAvailableAt: now + OTP_LIMITS.resendCooldownMs,
      codeLength: this.options.codeLength,
    };
  }

  private async deliver(target: SendTarget, challengeId: string, code: string): Promise<void> {
    await this.options.mailer.send({
      email: target.email,
      purpose: target.purpose,
      challengeId,
      code,
      expiresInMinutes: this.options.ttlMinutes,
    });
  }

  private sendRefusal(
    target: SendTarget,
    reads: readonly StatementResult[],
    now: number,
  ): AccessFeatureError {
    const user = reads[0]?.results[0];
    if (!user) {
      return new AccessFeatureError(
        target.sessionId === null ? "auth.account_not_found" : "auth.session_required",
      );
    }
    if (user.deletion_state !== "none") return new AccessFeatureError("auth.account_unavailable");
    if (target.sessionId !== null && reads[3]?.results[0]?.live !== 1) {
      return new AccessFeatureError("auth.session_required");
    }
    if (target.purpose === "login" && user.email_verified_at === null) {
      return new AccessFeatureError("auth.account_not_found");
    }
    if (target.purpose === "signup" && user.email_verified_at !== null) {
      return new AccessFeatureError("auth.account_exists");
    }
    let limitedUntil = 0;
    for (const row of reads[2]?.results ?? []) {
      const hourStart = integerColumn(row, "hour_window_start");
      const dayStart = integerColumn(row, "day_window_start");
      if (
        integerColumn(row, "day_challenges") >= OTP_LIMITS.challengesPerDay &&
        dayStart + OTP_LIMITS.dayMs > now
      ) {
        limitedUntil = Math.max(limitedUntil, dayStart + OTP_LIMITS.dayMs);
      }
      if (
        integerColumn(row, "hour_challenges") >= OTP_LIMITS.challengesPerHour &&
        hourStart + OTP_LIMITS.hourMs > now
      ) {
        limitedUntil = Math.max(limitedUntil, hourStart + OTP_LIMITS.hourMs);
      }
    }
    if (limitedUntil > now) {
      return new AccessFeatureError("otp.send_limited", {
        retryAfter: retryAfterSeconds(limitedUntil, now),
      });
    }
    const last = reads[1]?.results[0];
    const lastCreated = last ? nullableIntegerColumn(last, "last_created") : null;
    if (lastCreated !== null && lastCreated + OTP_LIMITS.resendCooldownMs > now) {
      return new AccessFeatureError("otp.cooldown", {
        retryAfter: retryAfterSeconds(lastCreated + OTP_LIMITS.resendCooldownMs, now),
      });
    }
    // Every condition held when read: a concurrent send took the slot first.
    return new AccessFeatureError("otp.cooldown", { retryAfter: 1 });
  }

  /** Starts new hour, day and failure windows for rows whose windows ended (§5.1). */
  private windowResetStatement(
    digests: readonly string[],
    purpose: OtpPurpose,
    now: number,
  ): Statement {
    const hourEnded = "hour_window_start + CAST(:hour AS INTEGER) <= CAST(:now AS INTEGER)";
    const dayEnded = "day_window_start + CAST(:day AS INTEGER) <= CAST(:now AS INTEGER)";
    const failuresEnded = `failure_window_start IS NOT NULL
      AND failure_window_start + CAST(:day AS INTEGER) <= CAST(:now AS INTEGER)
      AND (locked_until IS NULL OR locked_until <= CAST(:now AS INTEGER))`;
    return sql(
      `UPDATE otp_limits SET
         hour_challenges = CASE WHEN ${hourEnded} THEN 0 ELSE hour_challenges END,
         hour_window_start = CASE WHEN ${hourEnded} THEN CAST(:now AS INTEGER) ELSE hour_window_start END,
         day_challenges = CASE WHEN ${dayEnded} THEN 0 ELSE day_challenges END,
         day_window_start = CASE WHEN ${dayEnded} THEN CAST(:now AS INTEGER) ELSE day_window_start END,
         failures = CASE WHEN ${failuresEnded} THEN 0 ELSE failures END,
         locked_until = CASE WHEN ${failuresEnded} THEN NULL ELSE locked_until END,
         failure_window_start = CASE WHEN ${failuresEnded} THEN NULL ELSE failure_window_start END,
         updated_at = CAST(:now AS INTEGER), write_id = :w
       WHERE email_digest IN (:digests) AND purpose = :purpose
         AND ((${hourEnded}) OR (${dayEnded}) OR (${failuresEnded}))`,
      {
        hour: int(OTP_LIMITS.hourMs),
        day: int(OTP_LIMITS.dayMs),
        now: int(now),
        w: uuidv7(now),
        digests: [...digests],
        purpose,
      },
    );
  }

  /**
   * Verifies a code (§5.1). The challenge is read first; a live one then gets one batch that reserves
   * an attempt only while the challenge is live, has attempts left and the address is not locked out,
   * and applies either the consumption with the caller's guarded effects (correct code) or the
   * durable failure count (wrong code). A result never counts without a reserved attempt, so
   * concurrent guesses cannot exceed the attempt budget, and a refused reservation never reveals
   * whether the code was right.
   */
  async verify<T>(input: OtpVerifyInput<T>): Promise<OtpVerified<T>> {
    const { db, keys } = this.options;
    const priority = input.priority ?? "authenticated";
    const now = this.options.now();
    const challenge = await db.first(
      sql(
        `SELECT c.id, c.user_id, c.purpose, c.auth_session_id, c.code_digest, c.digest_version,
                c.attempts, c.expires_at, c.consumed_at, c.superseded_at, u.email, u.deletion_state
         FROM otp_challenges c JOIN users u ON u.id = c.user_id WHERE c.id = :challenge`,
        { challenge: input.challengeId },
      ),
      { priority },
    );
    const purpose = challenge?.purpose as OtpPurpose | undefined;
    if (!challenge || !purpose || !input.purposes.includes(purpose)) {
      throw new AccessFeatureError("otp.expired");
    }
    const userId = textColumn(challenge, "user_id");
    if (sessionBoundPurposes.has(purpose)) {
      if (
        !input.binding ||
        input.binding.userId !== userId ||
        input.binding.sessionId !== challenge.auth_session_id
      ) {
        throw new AccessFeatureError("otp.expired");
      }
    }
    if (challenge.deletion_state !== "none") {
      throw new AccessFeatureError("auth.account_unavailable");
    }
    if (
      challenge.consumed_at !== null ||
      challenge.superseded_at !== null ||
      integerColumn(challenge, "expires_at") <= now
    ) {
      throw new AccessFeatureError("otp.expired");
    }
    if (integerColumn(challenge, "attempts") >= this.options.maxAttempts) {
      throw new AccessFeatureError("otp.attempts_exhausted");
    }

    const email = normalizeEmail(textColumn(challenge, "email"));
    const limitKey = this.emailDigests(email);
    const correct = verifyOtpDigest(
      keys,
      { challengeId: input.challengeId, purpose, code: input.code },
      {
        version: integerColumn(challenge, "digest_version"),
        digest: textColumn(challenge, "code_digest"),
      },
    );
    const writeId = uuidv7(now);
    const guard: StatementGuard = Object.freeze({
      exists:
        "EXISTS (SELECT 1 FROM otp_challenges WHERE id = :otp_challenge AND write_id = :otp_write)",
      params: Object.freeze({ otp_challenge: input.challengeId, otp_write: writeId }),
    });
    const reserve = sql(
      `UPDATE otp_challenges
       SET attempts = attempts + 1, consumed_at = ${correct ? "CAST(:now AS INTEGER)" : "NULL"}, write_id = :w
       WHERE id = :challenge AND consumed_at IS NULL AND superseded_at IS NULL
         AND expires_at > CAST(:now AS INTEGER) AND attempts < CAST(:max AS INTEGER)
         AND NOT EXISTS (
           SELECT 1 FROM otp_limits WHERE email_digest IN (:digests) AND purpose = :purpose
             AND locked_until IS NOT NULL AND locked_until > CAST(:now AS INTEGER))`,
      {
        now: int(now),
        w: writeId,
        challenge: input.challengeId,
        max: int(this.options.maxAttempts),
        digests: limitKey.candidates,
        purpose,
      },
    );

    const statements: Statement[] = [reserve];
    let plan: OtpSuccessPlan<T> | null = null;
    if (correct) {
      plan = input.success({
        userId,
        email,
        purpose,
        challengeId: input.challengeId,
        guard,
        now,
      });
      statements.push(
        ...plan.statements,
        sql(
          `UPDATE otp_limits SET failures = 0, failure_window_start = NULL, locked_until = NULL,
             updated_at = :now, write_id = :limit_write
           WHERE email_digest IN (:digests) AND purpose = :purpose AND ${guard.exists}`,
          {
            ...guard.params,
            now: int(now),
            limit_write: uuidv7(now),
            digests: limitKey.candidates,
            purpose,
          },
        ),
      );
    } else {
      statements.push(...this.failureStatements(limitKey, purpose, guard, now));
    }
    const verifyIndex = statements.length;
    statements.push(
      sql(
        `SELECT attempts FROM otp_challenges WHERE id = :otp_challenge AND write_id = :otp_write`,
        guard.params,
      ),
      sql(
        `SELECT locked_until FROM otp_limits WHERE email_digest IN (:digests) AND purpose = :purpose`,
        { digests: limitKey.candidates, purpose },
      ),
      sql(
        `SELECT attempts, expires_at, consumed_at, superseded_at FROM otp_challenges WHERE id = :challenge`,
        { challenge: input.challengeId },
      ),
    );
    const results = await db.batch(statements, { priority });
    const reserved = verifiedRow(results, verifyIndex);
    const lockedUntil = Math.max(
      0,
      ...(results[verifyIndex + 1]?.results ?? []).map(
        (row) => nullableIntegerColumn(row, "locked_until") ?? 0,
      ),
    );

    if (reserved && plan) {
      return { userId, email, purpose, value: plan.decide(results, 1) };
    }
    if (lockedUntil > now) {
      throw new AccessFeatureError("otp.locked", {
        retryAfter: retryAfterSeconds(lockedUntil, now),
      });
    }
    const after = results[verifyIndex + 2]?.results[0];
    if (reserved) {
      const attempts = integerColumn(reserved, "attempts");
      if (attempts >= this.options.maxAttempts) {
        throw new AccessFeatureError("otp.attempts_exhausted");
      }
      throw new AccessFeatureError("otp.incorrect", {
        attemptsRemaining: this.options.maxAttempts - attempts,
      });
    }
    if (
      after &&
      after.consumed_at === null &&
      after.superseded_at === null &&
      integerColumn(after, "expires_at") > now &&
      integerColumn(after, "attempts") >= this.options.maxAttempts
    ) {
      throw new AccessFeatureError("otp.attempts_exhausted");
    }
    throw new AccessFeatureError("otp.expired");
  }

  /**
   * Counts one failed verification for the address and purpose, locking out at the daily limit. Like
   * the send counts, it updates the existing row under any configured digest version and inserts a
   * row under the current version only when none exists.
   */
  private failureStatements(
    limitKey: { readonly current: VersionedDigest; readonly candidates: readonly string[] },
    purpose: OtpPurpose,
    guard: StatementGuard,
    now: number,
  ): Statement[] {
    const windowEnded = `failure_window_start IS NULL
      OR failure_window_start + CAST(:day AS INTEGER) <= CAST(:now AS INTEGER)`;
    const nextFailures = `CASE WHEN ${windowEnded} THEN 1 ELSE failures + 1 END`;
    const shared = {
      ...guard.params,
      digests: [...limitKey.candidates],
      purpose,
      now: int(now),
      max_failures: int(OTP_LIMITS.failuresPerDay),
      lockout: int(OTP_LIMITS.lockoutMs),
      limit_write: uuidv7(now),
    };
    return [
      sql(
        `UPDATE otp_limits SET
           failures = ${nextFailures},
           locked_until = CASE WHEN ${nextFailures} >= CAST(:max_failures AS INTEGER)
             THEN CAST(:now AS INTEGER) + CAST(:lockout AS INTEGER) ELSE locked_until END,
           failure_window_start = CASE WHEN ${windowEnded} THEN CAST(:now AS INTEGER)
             ELSE failure_window_start END,
           updated_at = CAST(:now AS INTEGER), write_id = :limit_write
         WHERE email_digest IN (:digests) AND purpose = :purpose AND ${guard.exists}`,
        { ...shared, day: int(OTP_LIMITS.dayMs) },
      ),
      sql(
        `INSERT INTO otp_limits
           (email_digest, digest_version, purpose, hour_window_start, hour_challenges, day_window_start,
            day_challenges, failure_window_start, failures, locked_until, updated_at, write_id)
         SELECT :digest, :digest_version, :purpose, :now, 0, :now, 0, :now, 1,
                CASE WHEN 1 >= CAST(:max_failures AS INTEGER)
                  THEN CAST(:now AS INTEGER) + CAST(:lockout AS INTEGER) ELSE NULL END,
                :now, :limit_write
         WHERE ${guard.exists}
           AND NOT EXISTS (SELECT 1 FROM otp_limits WHERE email_digest IN (:digests) AND purpose = :purpose)
         ON CONFLICT DO NOTHING`,
        {
          ...shared,
          digest: limitKey.current.digest,
          digest_version: int(limitKey.current.version),
        },
      ),
    ];
  }
}
