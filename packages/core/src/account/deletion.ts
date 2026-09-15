import { normalizeEmail } from "@symplist/contracts";
import type { KeyProvider } from "@symplist/crypto";
import { computeDigest } from "@symplist/crypto";
import type { DbClient, Statement } from "@symplist/db";
import { int, json, sql, uuidv7, verifiedRow } from "@symplist/db";
import type { RestrictionCommitted } from "../access/restrict.ts";
import type { AccessService } from "../access/service.ts";
import type { SessionStore } from "../access/sessions.ts";
import { restrictGuard } from "../access/sql.ts";

/** The dispatch intent kind that starts the account purge (§5.6 step 6). */
export const ACCOUNT_PURGE_INTENT_KIND = "account_purge";

/** The R2 prefix that holds every object of an account (§4.1). */
export function accountObjectPrefix(userId: string): string {
  return `u/${userId}/`;
}

export interface AccountDeletionInput {
  readonly userId: string;
  /** The unused `account_delete_authorizations` row issued by a verified OTP (§5.1). */
  readonly authorizationId: string;
  /** The auth session of the request; the authorization must be bound to it. */
  readonly authSessionId: string;
  /** The account's email from the fresh read; normalized before it is digested. */
  readonly email: string;
  readonly now: number;
  /** The write id of statement 1; defaults to a fresh UUIDv7. */
  readonly writeId?: string;
}

/** The eight statements of the deletion batch (§5.6) and the index of the verification `SELECT`. */
export interface AccountDeletionBatch {
  readonly writeId: string;
  readonly statements: readonly Statement[];
  readonly verifyIndex: number;
}

export interface AccountDeletionDependencies {
  readonly keys: KeyProvider;
  readonly access: Pick<AccessService, "restrictStatements">;
  readonly sessions: Pick<SessionStore, "revokeAllStatements">;
}

/**
 * Builds the account deletion batch (§5.6). Statement 1 alone decides: it moves the user to
 * `deleting` only while the authorization is unused, unexpired and bound to this user and auth
 * session. Every later statement is guarded by statement 1's write id, and the crypto-shred (deleting
 * the `account_keys` row) comes after the restriction, the session revocation and the purge intent,
 * immediately before the verification `SELECT`:
 *
 * 1. `users` → `deleting`, `access_generation + 1`;
 * 2. consume the authorization;
 * 3. insert `account_deletions` with the tombstone digest computed here;
 * 4. the `restrict(userId, 'deleted')` statements;
 * 5. revoke every auth session;
 * 6. insert the `account_purge` dispatch intent;
 * 7. delete `account_keys` (the crypto-shred);
 * 8. verification `SELECT`.
 */
export function buildAccountDeletionBatch(
  deps: AccountDeletionDependencies,
  input: AccountDeletionInput,
): AccountDeletionBatch {
  const writeId = input.writeId ?? uuidv7(input.now);
  const guard = restrictGuard({ userId: input.userId, writeId });
  const now = int(input.now);
  const tombstone = computeDigest(
    deps.keys,
    "OTP_DIGEST_SECRET",
    "account-tombstone",
    normalizeEmail(input.email),
  );

  const statements: Statement[] = [
    sql(
      `UPDATE users SET deletion_state = 'deleting', deletion_requested_at = :now,
         access_generation = access_generation + 1, updated_at = :now, write_id = :restrict_write_id
       WHERE id = :restrict_user AND deletion_state = 'none'
         AND EXISTS (
           SELECT 1 FROM account_delete_authorizations
           WHERE id = :auth AND user_id = :restrict_user AND auth_session_id = :session
             AND consumed_at IS NULL AND expires_at > :now
         )`,
      { ...guard.params, now, auth: input.authorizationId, session: input.authSessionId },
    ),
    sql(
      `UPDATE account_delete_authorizations SET consumed_at = :now, write_id = :restrict_write_id
       WHERE id = :auth AND user_id = :restrict_user AND consumed_at IS NULL AND ${guard.exists}`,
      { ...guard.params, now, auth: input.authorizationId },
    ),
    sql(
      `INSERT INTO account_deletions
         (user_id, analytics_id, email_digest, email_digest_version, composio_user_id, r2_prefix,
          requested_at, status, steps_done, updated_at, write_id)
       SELECT id, analytics_id, :digest, :digest_version, id, :prefix, :now, 'pending', :steps, :now,
              :restrict_write_id
       FROM users WHERE id = :restrict_user AND write_id = :restrict_write_id
       ON CONFLICT (user_id) DO NOTHING`,
      {
        ...guard.params,
        digest: tombstone.digest,
        digest_version: int(tombstone.version),
        prefix: accountObjectPrefix(input.userId),
        now,
        steps: json([]),
      },
    ),
    ...deps.access.restrictStatements({
      userId: input.userId,
      reason: "deleted",
      writeId,
      now: input.now,
    }),
    ...deps.sessions.revokeAllStatements({ userId: input.userId, now: input.now, guard }),
    sql(
      `INSERT INTO dispatch_intents
         (id, owner_id, kind, subject_id, status, executor, executor_generation, trigger_run_id,
          attempts, created_at, updated_at, dispatched_at, cancelled_at, write_id)
       SELECT :intent, :restrict_user, :kind, :restrict_user, 'pending', NULL, generation, NULL, 0,
              :now, :now, NULL, NULL, :restrict_write_id
       FROM executor_state WHERE id = 1 AND ${guard.exists}
       ON CONFLICT (kind, subject_id) DO NOTHING`,
      { ...guard.params, intent: uuidv7(input.now), kind: ACCOUNT_PURGE_INTENT_KIND, now },
    ),
    sql(
      `DELETE FROM account_keys WHERE owner_id = :restrict_user AND ${guard.exists}`,
      guard.params,
    ),
    sql(
      `SELECT u.id, u.access_generation, d.analytics_id
       FROM users u JOIN account_deletions d ON d.user_id = u.id
       WHERE u.id = :restrict_user AND u.write_id = :restrict_write_id
         AND NOT EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :restrict_user)`,
      guard.params,
    ),
  ];
  return Object.freeze({ writeId, statements, verifyIndex: statements.length - 1 });
}

/** Announced after the deletion batch committed (§5.6). */
export interface AccountDeletionCommitted {
  readonly userId: string;
  /** Copied from `users` into `account_deletions`; the PostHog deletion request uses it (§5.6). */
  readonly analyticsId: string | null;
  readonly committedAt: number;
}

/**
 * A post-commit effect of account deletion: requesting PostHog person deletion, dispatching the purge
 * intent. Cookie clearing belongs to the HTTP response; socket closing, run cancellation and cache
 * eviction run through the restriction effects.
 */
export interface AccountDeletionEffect {
  readonly name: string;
  afterCommit(event: AccountDeletionCommitted): Promise<void>;
}

export type AccountDeletionResult =
  | { readonly status: "deleted"; readonly analyticsId: string | null }
  /** The authorization was missing, used, expired or bound elsewhere, or the account is already deleting. */
  | { readonly status: "refused" }
  | { readonly status: "not_found" };

export interface AccountDeletionServiceOptions {
  readonly db: DbClient;
  readonly keys: KeyProvider;
  readonly access: Pick<AccessService, "restrictStatements"> & {
    afterRestriction(event: RestrictionCommitted): Promise<void>;
  };
  readonly sessions: Pick<SessionStore, "revokeAllStatements">;
  readonly effects?: readonly AccountDeletionEffect[];
  readonly onEffectError?: (effect: string, error: unknown) => void;
}

/**
 * Runs the account deletion batch with a fresh read (§3.3, §5.6), then the restriction effects and
 * the deletion effects. The HTTP endpoint (access feature) validates the request, clears cookies and
 * maps the result.
 */
export class AccountDeletionService {
  private readonly options: AccountDeletionServiceOptions;

  constructor(options: AccountDeletionServiceOptions) {
    this.options = options;
  }

  async delete(input: Omit<AccountDeletionInput, "email">): Promise<AccountDeletionResult> {
    const { db } = this.options;
    const user = await db.first(
      sql(`SELECT email FROM users WHERE id = :user AND deletion_state = 'none'`, {
        user: input.userId,
      }),
    );
    if (!user) return { status: "not_found" };
    if (typeof user.email !== "string") throw new Error("Unexpected users.email value");

    const batch = buildAccountDeletionBatch(this.options, { ...input, email: user.email });
    const results = await db.batch(batch.statements);
    const row = verifiedRow(results, batch.verifyIndex);
    if (!row) return { status: "refused" };

    const generation = row.access_generation;
    const analyticsId = typeof row.analytics_id === "string" ? row.analytics_id : null;
    if (typeof generation === "number") {
      await this.options.access.afterRestriction({
        userId: input.userId,
        reason: "deleted",
        accessGeneration: generation,
        committedAt: input.now,
      });
    }
    for (const effect of this.options.effects ?? []) {
      try {
        await effect.afterCommit({ userId: input.userId, analyticsId, committedAt: input.now });
      } catch (error) {
        this.options.onEffectError?.(effect.name, error);
      }
    }
    return { status: "deleted", analyticsId };
  }
}
