import { normalizeInviteCode } from "@symplist/contracts";
import type { KeyProvider } from "@symplist/crypto";
import { computeDigestCandidates } from "@symplist/crypto";
import type { DbClient, Statement, StatementResult } from "@symplist/db";
import { int, sql, uuidv7, verifiedRow } from "@symplist/db";
import { type AccessPolicy, effectiveBetaState } from "./evaluate.ts";
import { AccessFeatureError } from "./feature-error.ts";
import { integerColumn, textColumn } from "./rows.ts";
import { ACCESS_STATE_COLUMNS, accessStateFromRow } from "./sql.ts";
import type { AccessState } from "./types.ts";

/** Pending redemptions one reconciler pass finalizes. */
export const REDEMPTION_RECONCILE_LIMIT = 50;

export interface RedemptionServiceOptions {
  readonly db: DbClient;
  readonly keys: KeyProvider;
  readonly policy: AccessPolicy;
  readonly now: () => number;
}

export type RedeemResult =
  | { readonly outcome: "unlocked"; readonly access: AccessState }
  | { readonly outcome: "already_unlocked"; readonly access: AccessState };

/** A seat claimed by a redemption that has no grant yet (the follow-up has not committed). */
export interface PendingRedemption {
  readonly id: string;
  readonly userId: string;
  readonly accessEpoch: number;
}

/** A redemption the follow-up finalized: the grant exists and the account is unlocked. */
export interface FinalizedRedemption {
  readonly userId: string;
  /** The account's access fields after the follow-up. */
  readonly access: AccessState | null;
  /** True when the grant for this redemption is current. */
  readonly granted: boolean;
}

/** The invite digests of a normalized code under every configured version, newest first (§5.4). */
export function inviteDigestCandidates(keys: KeyProvider, canonicalCode: string): string[] {
  return computeDigestCandidates(keys, "INVITE_DIGEST_SECRET", "invite", canonicalCode).map(
    (candidate) => candidate.digest,
  );
}

const pendingCondition = `u.beta_state = 'locked' AND u.access_epoch = r.access_epoch
  AND u.suspended_at IS NULL AND u.deletion_state = 'none'
  AND NOT EXISTS (SELECT 1 FROM beta_access_grants g WHERE g.source = 'invite' AND g.source_id = r.id)`;

/**
 * Beta invite redemption (§5.4). The seat is claimed by the architecture's single conditional
 * `INSERT … SELECT` with its verification `SELECT` by request id; the follow-up batch, idempotent by
 * the redemption id, inserts the invite grant, unlocks the account and appends the audit event. Every
 * later redemption request of the account, `GET /v1/me` and the reconciler finalize a claimed seat
 * whose follow-up never committed.
 */
export class RedemptionService {
  constructor(private readonly options: RedemptionServiceOptions) {}

  /**
   * Redeems `code` for the account. `requestId` is stable for one logical request (the api derives it
   * from the user and the Idempotency-Key), so a retry after an unknown outcome finds its own seat.
   */
  async redeem(input: {
    readonly userId: string;
    readonly code: string;
    readonly requestId: string;
  }): Promise<RedeemResult> {
    const { db, keys, policy } = this.options;
    const now = this.options.now();
    const canonical = normalizeInviteCode(input.code);
    const statements: Statement[] = [];
    let verifyIndex = -1;
    // With BETA_ACCESS_REQUIRED=false a locked account already counts as unlocked: no seat is taken.
    if (canonical !== null && policy.betaAccessRequired) {
      statements.push(
        sql(
          `INSERT INTO beta_redemptions (id, invite_id, seat_no, user_id, access_epoch, request_id, redeemed_at)
           SELECT :id, i.id,
                  (SELECT COUNT(*) FROM beta_redemptions r WHERE r.invite_id = i.id) + 1,
                  u.id, u.access_epoch, :req, :now
           FROM beta_invites i JOIN users u ON u.id = :user
           WHERE i.digest IN (:digests) AND i.revoked_at IS NULL AND i.expires_at > :now
             AND (i.bound_email IS NULL OR i.bound_email = u.email)
             AND (SELECT COUNT(*) FROM beta_redemptions r WHERE r.invite_id = i.id) < i.max_redemptions
             AND u.email_verified_at IS NOT NULL AND u.suspended_at IS NULL
             AND u.beta_state = 'locked' AND u.deletion_state = 'none'
           ON CONFLICT DO NOTHING`,
          {
            id: uuidv7(now),
            req: input.requestId,
            now: int(now),
            user: input.userId,
            digests: inviteDigestCandidates(keys, canonical),
          },
        ),
        sql(
          `SELECT id, user_id, access_epoch FROM beta_redemptions WHERE request_id = :req AND user_id = :user`,
          { req: input.requestId, user: input.userId },
        ),
      );
      verifyIndex = 1;
    }
    const stateIndex = statements.length;
    statements.push(this.stateStatement(input.userId), this.pendingForUserStatement(input.userId));
    const results = await db.batch(statements, { priority: "unauthenticated" });

    const claimed = verifyIndex >= 0 ? verifiedRow(results, verifyIndex) : null;
    if (claimed) {
      const finalized = await this.finalize({
        id: textColumn(claimed, "id"),
        userId: textColumn(claimed, "user_id"),
        accessEpoch: integerColumn(claimed, "access_epoch"),
      });
      return this.resultAfterFinalize(finalized, "unlocked");
    }

    const stateRow = results[stateIndex]?.results[0];
    if (!stateRow) throw new AccessFeatureError("auth.session_required");
    const access = accessStateFromRow(stateRow);
    if (access.deletionState !== "none") throw new AccessFeatureError("auth.session_required");
    // A suspension or relock wins over an unlocked beta state: the account is not admitted, and no
    // code (valid or not) is ever accepted for it (§5.4, note 04).
    if (access.betaState === "relocked" || access.suspendedAt !== null) {
      throw new AccessFeatureError("access.relocked");
    }
    if (effectiveBetaState(access, policy) === "unlocked") {
      return { outcome: "already_unlocked", access };
    }
    const pending = results[stateIndex + 1]?.results[0];
    if (pending) {
      // An earlier request of this account claimed a seat whose follow-up did not commit (or a
      // concurrent request with another code is finishing): finalize it, never consume a second seat.
      const finalized = await this.finalize({
        id: textColumn(pending, "id"),
        userId: input.userId,
        accessEpoch: integerColumn(pending, "access_epoch"),
      });
      return this.resultAfterFinalize(finalized, "unlocked");
    }
    throw new AccessFeatureError("invite.invalid");
  }

  private resultAfterFinalize(finalized: FinalizedRedemption, outcome: "unlocked"): RedeemResult {
    const access = finalized.access;
    if (access?.deletionState !== "none") {
      throw new AccessFeatureError("auth.session_required");
    }
    if (access.betaState === "unlocked") return { outcome, access };
    // A relock or suspension committed between the seat and the follow-up: the seat stays consumed.
    if (access.betaState === "relocked" || access.suspendedAt !== null) {
      throw new AccessFeatureError("access.relocked");
    }
    throw new AccessFeatureError("invite.invalid");
  }

  /** The user's access fields, for folding into a batch. */
  stateStatement(userId: string): Statement {
    return sql(`SELECT ${ACCESS_STATE_COLUMNS.join(", ")} FROM users WHERE id = :user`, {
      user: userId,
    });
  }

  /** The user's claimed seat at the current epoch that has no grant yet, if any. */
  pendingForUserStatement(userId: string): Statement {
    return sql(
      `SELECT r.id, r.access_epoch FROM beta_redemptions r JOIN users u ON u.id = r.user_id
       WHERE r.user_id = :user AND ${pendingCondition}`,
      { user: userId },
    );
  }

  /**
   * The follow-up batch (§5.4), idempotent by the redemption id: the invite grant (source id = the
   * redemption), the unlock `UPDATE users … WHERE beta_state = 'locked'` for the redemption's epoch,
   * and the `invite_redeemed` event keyed by the redemption. Nothing applies when the account was
   * relocked, suspended, moved to another epoch or is being deleted since the seat was claimed.
   */
  async finalize(redemption: PendingRedemption): Promise<FinalizedRedemption> {
    const now = this.options.now();
    const unlockWrite = uuidv7(now);
    const grantExists = `EXISTS (SELECT 1 FROM beta_access_grants
      WHERE source = 'invite' AND source_id = :redemption AND revoked_at IS NULL)`;
    const statements: Statement[] = [
      sql(
        `INSERT INTO beta_access_grants
           (id, user_id, source, source_id, campaign_id, access_epoch, granted_at, actor_kind, actor_id,
            reason_enc, revoked_at, revoked_reason, write_id)
         SELECT :grant, r.user_id, 'invite', r.id, i.campaign_id, r.access_epoch, :now, 'user', r.user_id,
                NULL, NULL, NULL, :w
         FROM beta_redemptions r
           JOIN beta_invites i ON i.id = r.invite_id
           JOIN users u ON u.id = r.user_id
         WHERE r.id = :redemption AND ${pendingCondition}
           AND NOT EXISTS (SELECT 1 FROM beta_access_grants c WHERE c.user_id = r.user_id AND c.revoked_at IS NULL)
         ON CONFLICT DO NOTHING`,
        { grant: uuidv7(now), now: int(now), w: uuidv7(now), redemption: redemption.id },
      ),
      sql(
        `UPDATE users SET beta_state = 'unlocked', access_generation = access_generation + 1,
           updated_at = :now, write_id = :w
         WHERE id = :user AND beta_state = 'locked' AND access_epoch = CAST(:epoch AS INTEGER)
           AND suspended_at IS NULL AND deletion_state = 'none' AND ${grantExists}`,
        {
          now: int(now),
          w: unlockWrite,
          user: redemption.userId,
          epoch: int(redemption.accessEpoch),
          redemption: redemption.id,
        },
      ),
      sql(
        `INSERT INTO beta_admin_events
           (id, actor_kind, actor_id, action, target_kind, target_id, reason_enc, reason_owner_id,
            before_json, after_json, request_id, created_at)
         SELECT :event, 'user', r.user_id, 'invite_redeemed', 'invite', r.invite_id, NULL, NULL,
                json_object('betaState', 'locked'),
                json_object('betaState', 'unlocked', 'campaignId', i.campaign_id, 'seatNo', r.seat_no,
                            'maxRedemptions', i.max_redemptions),
                'redemption:' || r.id, :now
         FROM beta_redemptions r JOIN beta_invites i ON i.id = r.invite_id
         WHERE r.id = :redemption AND ${grantExists}
         ON CONFLICT DO NOTHING`,
        { event: uuidv7(now), now: int(now), redemption: redemption.id },
      ),
      this.stateStatement(redemption.userId),
      sql(`SELECT 1 AS granted WHERE ${grantExists}`, { redemption: redemption.id }),
    ];
    const results: readonly StatementResult[] = await this.options.db.batch(statements, {
      priority: "unauthenticated",
    });
    const stateRow = results[3]?.results[0];
    return {
      userId: redemption.userId,
      access: stateRow ? accessStateFromRow(stateRow) : null,
      granted: (results[4]?.results.length ?? 0) > 0,
    };
  }

  /**
   * The reconciler (§5.4): finalizes claimed seats whose follow-up never committed, for accounts still
   * locked at the seat's epoch. Returns the finalized redemptions, whose accounts the caller notifies.
   */
  async reconcile(limit = REDEMPTION_RECONCILE_LIMIT): Promise<FinalizedRedemption[]> {
    const rows = await this.options.db.all(
      sql(
        `SELECT r.id, r.user_id, r.access_epoch FROM beta_redemptions r JOIN users u ON u.id = r.user_id
         WHERE ${pendingCondition}
         ORDER BY r.redeemed_at, r.id LIMIT CAST(:limit AS INTEGER)`,
        { limit: int(limit) },
      ),
    );
    const finalized: FinalizedRedemption[] = [];
    for (const row of rows) {
      finalized.push(
        await this.finalize({
          id: textColumn(row, "id"),
          userId: textColumn(row, "user_id"),
          accessEpoch: integerColumn(row, "access_epoch"),
        }),
      );
    }
    return finalized;
  }
}
