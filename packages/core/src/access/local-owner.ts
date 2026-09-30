import type { KeyProvider } from "@symplist/crypto";
import type { DbClient } from "@symplist/db";
import { int, sql, uuidv7 } from "@symplist/db";
import { AccountKeyStore } from "../account/keys.ts";
import { textColumn } from "./rows.ts";

/**
 * The single owner of a local install (`DEPLOYMENT=local`, note 18).
 *
 * A local deployment is one person's own machine with no cloud behind it: no email to send an OTP to,
 * no invite to redeem, no administrator to unlock an account, and no second user to keep anything
 * apart from. So there is exactly one owner, it is provisioned on first boot, and it is the only
 * account that will ever exist in that database.
 *
 * **What this does not do is bypass authentication.** The owner is an ordinary `users` row and gets an
 * ordinary `auth_sessions` row through the ordinary `SessionStore`. Every guard, every `evaluateAccess`
 * call, every owner-scoped query and every encryption boundary behaves exactly as it does in the
 * cloud — the row simply arrives already verified and already onboarded, because the steps that would
 * have set those fields are steps a local install has no way to perform. Nothing downstream of here
 * knows which deployment it is in, which is the property worth protecting: a local-mode special case
 * inside a guard would be a cloud vulnerability waiting for a configuration mistake.
 *
 * The address is a reserved-TLD placeholder rather than anything the person types. It is never sent
 * to, never verified against, and never shown as an identity claim — it exists because `users.email`
 * is `NOT NULL UNIQUE` and every row needs one. `symplist.invalid` cannot resolve (RFC 2606), so a
 * misconfigured install cannot accidentally mail a real person.
 */
export const LOCAL_OWNER_EMAIL = "owner@symplist.invalid";

export interface LocalOwnerServiceOptions {
  readonly db: DbClient;
  readonly keys: KeyProvider;
  readonly now: () => number;
}

export class LocalOwnerService {
  private readonly accountKeys: AccountKeyStore;

  constructor(private readonly options: LocalOwnerServiceOptions) {
    this.accountKeys = new AccountKeyStore({ db: options.db, keys: options.keys });
  }

  /**
   * The owner's user id, provisioning the row and its account data key on first call.
   *
   * Idempotent by the unique address: a second call returns the same id, so it is safe to run on every
   * boot and there is no "has this been done" flag to get wrong. The row is inserted already verified,
   * already unlocked and already onboarded — see the note above for why those are given rather than
   * earned — and as `admin`, because a local owner administers their own install and nobody else can.
   *
   * The account data key is provisioned in the same call, not lazily: every encrypted column depends on
   * it, and a first write that had to create it would make the first task a person saves the one write
   * with a different failure mode from every other.
   */
  async ensure(): Promise<string> {
    const now = this.options.now();
    await this.options.db.batch([
      sql(
        `INSERT INTO users
           (id, email, email_verified_at, beta_state, onboarding_step, role, created_at, updated_at, write_id)
         VALUES (:id, :email, :now, 'unlocked', 'done', 'admin', :now, :now, :w)
         ON CONFLICT (email) DO NOTHING`,
        {
          id: uuidv7(now),
          email: LOCAL_OWNER_EMAIL,
          now: int(now),
          w: uuidv7(now),
        },
      ),
    ]);
    const userId = await this.userId();
    if (userId === null) throw new Error("symplist: the local owner could not be provisioned");
    await this.options.db.batch([this.accountKeys.provisionStatement({ userId, now })]);
    return userId;
  }

  /** The owner's id, or null before `ensure()` has run. */
  async userId(): Promise<string | null> {
    const row = await this.options.db.first(
      sql("SELECT id FROM users WHERE email = :email AND deletion_state = 'none'", {
        email: LOCAL_OWNER_EMAIL,
      }),
    );
    return row ? textColumn(row, "id") : null;
  }
}
