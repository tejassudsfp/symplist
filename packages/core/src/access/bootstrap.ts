import { normalizeEmail } from "@symplist/contracts";
import type { KeyProvider } from "@symplist/crypto";
import { zeroize } from "@symplist/crypto";
import type { DbClient, Statement } from "@symplist/db";
import { int, sql, uuidv7, verifiedRow } from "@symplist/db";
import { AccountKeyStore } from "../account/keys.ts";
import { adminEventInsertStatement, usersWriteGuard } from "./admin-events.ts";
import { adminReasonContext, encryptText, grantReasonContext } from "./fields.ts";
import { integerColumn, textColumn } from "./rows.ts";

export type AdminBootstrapOutcome =
  /** The account became the administrator in this call. */
  | { readonly status: "promoted"; readonly userId: string; readonly accessGeneration: number }
  /** Bootstrap was already consumed (an admin or a bootstrap event exists); nothing changed. */
  | { readonly status: "consumed" }
  /** No verified, non-suspended, non-relocked account uses the address yet. */
  | { readonly status: "not_eligible" };

export interface AdminBootstrapServiceOptions {
  readonly db: DbClient;
  readonly keys: KeyProvider;
  readonly now: () => number;
}

/**
 * Admin bootstrap (§5.7, decision R13): runs once. It promotes the account using the normalized
 * `ADMIN_BOOTSTRAP_EMAIL` only while no user has role `admin` and no `admin_bootstrap` event exists,
 * and only when that account is verified, not suspended, not relocked and not being deleted. One
 * conditional batch sets the role (and admits a locked account, since the administrator must pass
 * the `admin` level), inserts an idempotent admin access grant and the single `admin_bootstrap` event
 * (a partial unique index allows one), both guarded by the write id. It never clears suspension or
 * relock, and never promotes the first signup.
 */
export class AdminBootstrapService {
  constructor(private readonly options: AdminBootstrapServiceOptions) {}

  /** Whether bootstrap was consumed: an admin exists or the `admin_bootstrap` event was recorded. */
  async isConsumed(): Promise<boolean> {
    const row = await this.options.db.first(
      sql(
        `SELECT (EXISTS (SELECT 1 FROM users WHERE role = 'admin')
                 OR EXISTS (SELECT 1 FROM beta_admin_events WHERE action = 'admin_bootstrap')) AS consumed`,
      ),
    );
    return row?.consumed === 1;
  }

  /** The one-time bootstrap for `email`. */
  bootstrap(email: string): Promise<AdminBootstrapOutcome> {
    return this.run({ email, force: null });
  }

  /**
   * The explicit `--force-rebootstrap` path of the CLI: promotes the configured account even though
   * bootstrap was consumed, recording the operator-supplied actor and reason in an
   * `admin_rebootstrap` event. Eligibility (verified, not suspended, not relocked) still applies.
   */
  forceRebootstrap(input: {
    readonly email: string;
    readonly actorId: string;
    readonly reason: string;
  }): Promise<AdminBootstrapOutcome> {
    return this.run({
      email: input.email,
      force: { actorId: input.actorId, reason: input.reason },
    });
  }

  private async run(input: {
    readonly email: string;
    readonly force: { readonly actorId: string; readonly reason: string } | null;
  }): Promise<AdminBootstrapOutcome> {
    const { db, keys } = this.options;
    const email = normalizeEmail(input.email);
    const now = this.options.now();
    const target = await db.first(
      sql(
        `SELECT id FROM users WHERE email = :email AND email_verified_at IS NOT NULL
           AND suspended_at IS NULL AND beta_state <> 'relocked' AND deletion_state = 'none'`,
        { email },
      ),
    );
    if (!target)
      return (await this.isConsumed()) ? { status: "consumed" } : { status: "not_eligible" };
    const userId = textColumn(target, "id");
    const writeId = uuidv7(now);
    const eventId = uuidv7(now);
    const grantId = uuidv7(now);
    const guard = usersWriteGuard(userId, writeId);
    const key = input.force
      ? await new AccountKeyStore({ db, keys }).ensure({ userId, now })
      : null;
    try {
      const once = input.force
        ? "AND role <> 'admin'"
        : `AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')
           AND NOT EXISTS (SELECT 1 FROM beta_admin_events WHERE action = 'admin_bootstrap')`;
      const statements: Statement[] = [
        sql(
          `UPDATE users SET role = 'admin',
             beta_state = CASE WHEN beta_state = 'locked' THEN 'unlocked' ELSE beta_state END,
             access_generation = access_generation + 1, updated_at = :now, write_id = :w
           WHERE id = :user AND email = :email AND email_verified_at IS NOT NULL
             AND suspended_at IS NULL AND beta_state <> 'relocked' AND deletion_state = 'none' ${once}`,
          { now: int(now), w: writeId, user: userId, email },
        ),
        sql(
          `INSERT INTO beta_access_grants
             (id, user_id, source, source_id, campaign_id, access_epoch, granted_at, actor_kind, actor_id,
              reason_enc, revoked_at, revoked_reason, write_id)
           SELECT :grant, u.id, 'admin', :event, NULL, u.access_epoch, :now, :actor_kind, :actor,
                  :reason, NULL, NULL, :w
           FROM users u WHERE u.id = :guard_user AND u.write_id = :guard_write_id
             AND NOT EXISTS (SELECT 1 FROM beta_access_grants g WHERE g.user_id = u.id AND g.revoked_at IS NULL)
           ON CONFLICT DO NOTHING`,
          {
            ...guard.params,
            grant: grantId,
            event: eventId,
            now: int(now),
            actor_kind: input.force ? "admin" : "system",
            actor: input.force?.actorId ?? null,
            reason:
              input.force && key
                ? encryptText(key, grantReasonContext(userId, grantId), input.force.reason)
                : null,
            w: writeId,
          },
        ),
        adminEventInsertStatement(
          {
            id: eventId,
            actorKind: input.force ? "admin" : "system",
            actorId: input.force?.actorId ?? null,
            action: input.force ? "admin_rebootstrap" : "admin_bootstrap",
            targetKind: "user",
            targetId: userId,
            reasonEnc:
              input.force && key
                ? encryptText(key, adminReasonContext(userId, eventId), input.force.reason)
                : null,
            reasonOwnerId: input.force && key ? userId : null,
            before: { role: "member" },
            after: { role: "admin" },
            requestId: input.force ? `admin_rebootstrap:${eventId}` : "admin_bootstrap",
            createdAt: now,
          },
          guard,
        ),
        sql(`SELECT access_generation FROM users WHERE id = :user AND write_id = :w`, {
          user: userId,
          w: writeId,
        }),
      ];
      const results = await db.batch(statements);
      const row = verifiedRow(results);
      if (!row)
        return (await this.isConsumed()) ? { status: "consumed" } : { status: "not_eligible" };
      return {
        status: "promoted",
        userId,
        accessGeneration: integerColumn(row, "access_generation"),
      };
    } finally {
      if (key) zeroize(key.key);
    }
  }
}
