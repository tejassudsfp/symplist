import type {
  AdminAccount,
  AdminAccountDetail,
  AdminAccountFilter,
  AdminAccountPage,
  AdminAccountRedemption,
  AdminGrant,
  ListAccountsQuery,
} from "@symplist/contracts";
import { pageLimitDefault, restrictionReasons } from "@symplist/contracts";
import type { AccountDataKey, KeyProvider } from "@symplist/crypto";
import { zeroize } from "@symplist/crypto";
import type { DbClient, DbRow, SqlParams, Statement, StatementResult } from "@symplist/db";
import { int, sql, uuidv7, verifiedRow } from "@symplist/db";
import { AccountKeyStore } from "../account/keys.ts";
import { adminEventFromRow, adminEventSelect, withCampaignLabels } from "./activity.ts";
import { adminEventInsertStatement, usersWriteGuard } from "./admin-events.ts";
import type { AccessPolicy } from "./evaluate.ts";
import { AccessFeatureError } from "./feature-error.ts";
import {
  adminReasonContext,
  decryptTextOrNull,
  displayNameContext,
  encryptText,
  grantReasonContext,
  loadKeyRing,
} from "./fields.ts";
import type { RestrictionCommitted } from "./restrict.ts";
import {
  containsPattern,
  decodeCursor,
  encodeCursor,
  enumColumn,
  integerColumn,
  nullableIntegerColumn,
  nullableTextColumn,
  textColumn,
} from "./rows.ts";
import type { AccessService } from "./service.ts";
import { accessCondition, restrictGuard } from "./sql.ts";
import type { AccessState } from "./types.ts";

const accountColumns = `u.id, u.email, u.display_name_enc, u.email_verified_at, u.beta_state, u.suspended_at,
  u.onboarding_step, u.role, u.deletion_state, u.created_at, u.access_generation, u.access_epoch,
  (SELECT g.source FROM beta_access_grants g WHERE g.user_id = u.id AND g.revoked_at IS NULL) AS grant_source`;

const filterConditions: Readonly<Record<AdminAccountFilter, string>> = {
  pending: "u.email_verified_at IS NULL AND u.deletion_state = 'none'",
  locked:
    "u.email_verified_at IS NOT NULL AND u.beta_state = 'locked' AND u.suspended_at IS NULL AND u.deletion_state = 'none'",
  unlocked: "u.beta_state = 'unlocked' AND u.suspended_at IS NULL AND u.deletion_state = 'none'",
  paused: "(u.beta_state = 'relocked' OR u.suspended_at IS NOT NULL) AND u.deletion_state = 'none'",
};

/** The administrative account actions (§5.4). Relock runs through `core/access.restrict` (§5.5). */
export type AccountAction = "unlock" | "relock" | "restore_eligibility" | "restore_access";

export interface AccountActionInput {
  readonly adminId: string;
  readonly userId: string;
  readonly action: AccountAction;
  readonly reason: string;
  readonly expectedGeneration: number;
  /** Unique per logical request, so a retried request appends no second event. */
  readonly requestId: string;
}

export interface AccountActionResult {
  readonly account: AdminAccount;
  readonly access: AccessState;
  /** Set for relock: the restriction's post-commit effects already ran. */
  readonly restricted: boolean;
}

export interface AccountAdminServiceOptions {
  readonly db: DbClient;
  readonly keys: KeyProvider;
  readonly policy: AccessPolicy;
  readonly now: () => number;
  readonly access: Pick<AccessService, "restrictStatements"> & {
    afterRestriction(event: RestrictionCommitted): Promise<void>;
  };
}

function accessFromAccountRow(row: DbRow): AccessState {
  return Object.freeze({
    emailVerifiedAt: nullableIntegerColumn(row, "email_verified_at"),
    betaState: enumColumn(row, "beta_state", ["locked", "unlocked", "relocked"]),
    suspendedAt: nullableIntegerColumn(row, "suspended_at"),
    onboardingStep: enumColumn(row, "onboarding_step", ["name", "connections", "done"]),
    role: enumColumn(row, "role", ["member", "admin"]),
    accessGeneration: integerColumn(row, "access_generation"),
    accessEpoch: integerColumn(row, "access_epoch"),
    deletionState: enumColumn(row, "deletion_state", ["none", "deleting"]),
  });
}

/**
 * Beta account administration (§5.4, admin accounts brief): the account list and detail with
 * admission history, and Unlock, Relock, Restore eligibility and Restore access. Every action reads
 * fresh, requires a reason (encrypted under the account's key), refuses an account whose
 * `access_generation` moved since the administrator read it, and appends one audit event in its
 * batch. Nothing here verifies an email, promotes a role or refunds a seat.
 */
export class AccountAdminService {
  private readonly accountKeys: AccountKeyStore;

  constructor(private readonly options: AccountAdminServiceOptions) {
    this.accountKeys = new AccountKeyStore({ db: options.db, keys: options.keys });
  }

  async list(query: ListAccountsQuery): Promise<AdminAccountPage> {
    const limit = query.limit ?? pageLimitDefault;
    const conditions: string[] = [];
    const params: Record<string, string> = { page: int(limit + 1) };
    if (query.filter) conditions.push(filterConditions[query.filter]);
    if (query.q) {
      conditions.push(`(u.email LIKE :pattern ESCAPE '\\' OR u.id = :exact)`);
      params.pattern = containsPattern(query.q.toLowerCase());
      params.exact = query.q;
    }
    const cursor = decodeCursor(query.cursor);
    if (cursor) {
      conditions.push(
        "(u.created_at < CAST(:cursor_t AS INTEGER) OR (u.created_at = CAST(:cursor_t AS INTEGER) AND u.id < :cursor_i))",
      );
      params.cursor_t = int(cursor.t);
      params.cursor_i = cursor.i;
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = await this.options.db.all(
      sql(
        `SELECT ${accountColumns} FROM users u ${where}
         ORDER BY u.created_at DESC, u.id DESC LIMIT CAST(:page AS INTEGER)`,
        params as SqlParams,
      ),
    );
    const page = rows.slice(0, limit);
    const ring = await loadKeyRing(
      this.options.db,
      this.options.keys,
      page.map((row) => textColumn(row, "id")),
    );
    try {
      const items = page.map((row) => this.accountFromRow(row, (id) => ring.get(id)));
      const last = items.at(-1);
      return {
        items,
        nextCursor:
          rows.length > limit && last ? encodeCursor({ t: last.createdAt, i: last.id }) : null,
      };
    } finally {
      ring.dispose();
    }
  }

  async detail(userId: string): Promise<AdminAccountDetail> {
    const results = await this.options.db.batch([
      sql(`SELECT ${accountColumns} FROM users u WHERE u.id = :user`, { user: userId }),
      sql(
        `SELECT g.id, g.source, g.source_id, g.campaign_id, g.granted_at, g.actor_id, g.reason_enc,
                g.revoked_at, g.revoked_reason, r.invite_id, i.hint AS invite_hint
         FROM beta_access_grants g
           LEFT JOIN beta_redemptions r ON g.source = 'invite' AND r.id = g.source_id
           LEFT JOIN beta_invites i ON i.id = r.invite_id
         WHERE g.user_id = :user ORDER BY g.granted_at DESC, g.id DESC LIMIT 200`,
        { user: userId },
      ),
      sql(
        `SELECT r.id, r.invite_id, i.hint, i.campaign_id, r.seat_no, r.access_epoch, r.redeemed_at
         FROM beta_redemptions r JOIN beta_invites i ON i.id = r.invite_id
         WHERE r.user_id = :user ORDER BY r.redeemed_at DESC, r.id DESC LIMIT 200`,
        { user: userId },
      ),
      sql(
        `${adminEventSelect}
         WHERE (e.target_kind = 'user' AND e.target_id = :user) OR e.actor_id = :user
         ORDER BY e.created_at DESC, e.id DESC LIMIT 100`,
        { user: userId },
      ),
    ]);
    const row = results[0]?.results[0];
    if (!row) throw new AccessFeatureError("not_found");
    const ring = await loadKeyRing(this.options.db, this.options.keys, [userId]);
    try {
      const key = ring.get(userId);
      return {
        account: this.accountFromRow(row, (id) => ring.get(id)),
        grants: (results[1]?.results ?? []).map((grant): AdminGrant => {
          const grantId = textColumn(grant, "id");
          const revokedReason = nullableTextColumn(grant, "revoked_reason");
          return {
            id: grantId,
            source: enumColumn(grant, "source", ["invite", "admin"]),
            inviteId: nullableTextColumn(grant, "invite_id") as AdminGrant["inviteId"],
            inviteHint: nullableTextColumn(grant, "invite_hint"),
            campaignId: nullableTextColumn(grant, "campaign_id"),
            grantedAt: integerColumn(grant, "granted_at"),
            actorId: nullableTextColumn(grant, "actor_id"),
            reason: decryptTextOrNull(key, grantReasonContext(userId, grantId), grant.reason_enc),
            revokedAt: nullableIntegerColumn(grant, "revoked_at"),
            revokedReason:
              revokedReason !== null &&
              (restrictionReasons as readonly string[]).includes(revokedReason)
                ? (revokedReason as AdminGrant["revokedReason"])
                : null,
          };
        }),
        redemptions: (results[2]?.results ?? []).map(
          (redemption): AdminAccountRedemption => ({
            id: textColumn(redemption, "id"),
            inviteId: textColumn(redemption, "invite_id") as AdminAccountRedemption["inviteId"],
            inviteHint: textColumn(redemption, "hint"),
            campaignId: textColumn(redemption, "campaign_id"),
            seatNo: integerColumn(redemption, "seat_no"),
            accessEpoch: integerColumn(redemption, "access_epoch"),
            redeemedAt: integerColumn(redemption, "redeemed_at"),
          }),
        ),
        events: await withCampaignLabels(
          this.options.db,
          this.options.keys,
          (results[3]?.results ?? []).map(adminEventFromRow).filter((event) => event !== null),
        ),
      };
    } finally {
      ring.dispose();
    }
  }

  /** Runs one account action; see {@link AccountAdminService}. */
  async act(input: AccountActionInput): Promise<AccountActionResult> {
    const { db } = this.options;
    const current = await db.first(
      sql(`SELECT ${accountColumns} FROM users u WHERE u.id = :user`, { user: input.userId }),
    );
    if (!current) throw new AccessFeatureError("not_found");
    if (integerColumn(current, "access_generation") !== input.expectedGeneration) {
      throw new AccessFeatureError("admin.state_changed", {
        accessGeneration: integerColumn(current, "access_generation"),
      });
    }
    if (current.deletion_state !== "none") throw new AccessFeatureError("admin.action_unavailable");
    // An account that never verified has no key yet; its reason is encrypted under a new one.
    const key = await this.accountKeys.ensure({ userId: input.userId, now: this.options.now() });
    try {
      if (input.action === "relock") return await this.relock(input, current, key);
      return await this.changeState(input, key);
    } finally {
      zeroize(key.key);
    }
  }

  private async relock(
    input: AccountActionInput,
    current: DbRow,
    key: AccountDataKey,
  ): Promise<AccountActionResult> {
    if (current.beta_state === "relocked") throw new AccessFeatureError("admin.action_unavailable");
    const now = this.options.now();
    const writeId = uuidv7(now);
    const eventId = uuidv7(now);
    const statements: Statement[] = [
      ...this.options.access.restrictStatements({
        userId: input.userId,
        reason: "relocked",
        writeId,
        now,
      }),
      adminEventInsertStatement(
        {
          id: eventId,
          actorKind: "admin",
          actorId: input.adminId,
          action: "access_relocked",
          targetKind: "user",
          targetId: input.userId,
          reasonEnc: encryptText(key, adminReasonContext(input.userId, eventId), input.reason),
          reasonOwnerId: input.userId,
          before: { betaState: textColumn(current, "beta_state") },
          after: { betaState: "relocked" },
          requestId: input.requestId,
          createdAt: now,
        },
        restrictGuard({ userId: input.userId, writeId }),
      ),
      sql(`SELECT ${accountColumns} FROM users u WHERE u.id = :user AND u.write_id = :w`, {
        user: input.userId,
        w: writeId,
      }),
      sql(`SELECT ${accountColumns} FROM users u WHERE u.id = :user`, { user: input.userId }),
    ];
    const results = await this.options.db.batch(statements);
    const verifyIndex = statements.length - 2;
    const applied = verifiedRow(results, verifyIndex);
    if (!applied) throw this.refusal(input, results[verifyIndex + 1]?.results[0]);
    const access = accessFromAccountRow(applied);
    await this.options.access.afterRestriction({
      userId: input.userId,
      reason: "relocked",
      accessGeneration: access.accessGeneration,
      committedAt: now,
    });
    return { account: this.accountWithName(applied, key), access, restricted: true };
  }

  private async changeState(
    input: AccountActionInput,
    key: AccountDataKey,
  ): Promise<AccountActionResult> {
    const { db, policy } = this.options;
    const now = this.options.now();
    const writeId = uuidv7(now);
    const eventId = uuidv7(now);
    const grantId = uuidv7(now);
    const actor = accessCondition({ level: "admin", policy, userParam: "actor" });
    const base = {
      user: input.userId,
      expected: int(input.expectedGeneration),
      now: int(now),
      w: writeId,
      actor: input.adminId,
    };
    let update: Statement;
    let action: "account_unlocked" | "eligibility_restored" | "access_restored";
    let before: Record<string, unknown>;
    let after: Record<string, unknown>;
    const grants = input.action === "unlock" || input.action === "restore_access";
    switch (input.action) {
      case "unlock":
        update = sql(
          `UPDATE users SET beta_state = 'unlocked', access_generation = access_generation + 1,
             updated_at = :now, write_id = :w
           WHERE id = :user AND beta_state = 'locked' AND deletion_state = 'none'
             AND access_generation = CAST(:expected AS INTEGER) AND ${actor}`,
          base,
        );
        action = "account_unlocked";
        before = { betaState: "locked" };
        after = { betaState: "unlocked" };
        break;
      case "restore_access":
        update = sql(
          `UPDATE users SET beta_state = 'unlocked', access_generation = access_generation + 1,
             updated_at = :now, write_id = :w
           WHERE id = :user AND beta_state = 'relocked' AND deletion_state = 'none'
             AND access_generation = CAST(:expected AS INTEGER) AND ${actor}`,
          base,
        );
        action = "access_restored";
        before = { betaState: "relocked" };
        after = { betaState: "unlocked" };
        break;
      default:
        update = sql(
          `UPDATE users SET beta_state = 'locked', access_epoch = access_epoch + 1,
             access_generation = access_generation + 1, updated_at = :now, write_id = :w
           WHERE id = :user AND beta_state = 'relocked' AND deletion_state = 'none'
             AND access_generation = CAST(:expected AS INTEGER) AND ${actor}`,
          base,
        );
        action = "eligibility_restored";
        before = { betaState: "relocked" };
        after = { betaState: "locked" };
        break;
    }
    const guard = usersWriteGuard(input.userId, writeId);
    const statements: Statement[] = [update];
    if (grants) {
      statements.push(
        // A grant a campaign revocation left behind (another campaign's) never blocks the new one.
        sql(
          `UPDATE beta_access_grants SET revoked_at = :now, revoked_reason = 'relocked', write_id = :w
           WHERE user_id = :user AND revoked_at IS NULL AND ${guard.exists}`,
          { ...guard.params, now: int(now), w: writeId, user: input.userId },
        ),
        sql(
          `INSERT INTO beta_access_grants
             (id, user_id, source, source_id, campaign_id, access_epoch, granted_at, actor_kind, actor_id,
              reason_enc, revoked_at, revoked_reason, write_id)
           SELECT :grant, u.id, 'admin', :event, NULL, u.access_epoch, :now, 'admin', :actor, :reason,
                  NULL, NULL, :w
           FROM users u WHERE u.id = :guard_user AND u.write_id = :guard_write_id`,
          {
            ...guard.params,
            grant: grantId,
            event: eventId,
            now: int(now),
            actor: input.adminId,
            reason: encryptText(key, grantReasonContext(input.userId, grantId), input.reason),
            w: writeId,
          },
        ),
      );
    }
    statements.push(
      adminEventInsertStatement(
        {
          id: eventId,
          actorKind: "admin",
          actorId: input.adminId,
          action,
          targetKind: "user",
          targetId: input.userId,
          reasonEnc: encryptText(key, adminReasonContext(input.userId, eventId), input.reason),
          reasonOwnerId: input.userId,
          before,
          after,
          requestId: input.requestId,
          createdAt: now,
        },
        guard,
      ),
      sql(`SELECT ${accountColumns} FROM users u WHERE u.id = :user AND u.write_id = :w`, {
        user: input.userId,
        w: writeId,
      }),
      sql(`SELECT ${accountColumns} FROM users u WHERE u.id = :user`, { user: input.userId }),
    );
    const results: readonly StatementResult[] = await db.batch(statements);
    const verifyIndex = statements.length - 2;
    const applied = verifiedRow(results, verifyIndex);
    if (!applied) throw this.refusal(input, results[verifyIndex + 1]?.results[0]);
    return {
      account: this.accountWithName(applied, key),
      access: accessFromAccountRow(applied),
      restricted: false,
    };
  }

  private refusal(input: AccountActionInput, row: DbRow | undefined): AccessFeatureError {
    if (!row) return new AccessFeatureError("not_found");
    const generation = integerColumn(row, "access_generation");
    if (generation !== input.expectedGeneration) {
      return new AccessFeatureError("admin.state_changed", { accessGeneration: generation });
    }
    return new AccessFeatureError("admin.action_unavailable");
  }

  private accountWithName(row: DbRow, key: AccountDataKey): AdminAccount {
    return this.accountFromRow(row, () => key);
  }

  private accountFromRow(
    row: DbRow,
    keyOf: (userId: string) => AccountDataKey | undefined,
  ): AdminAccount {
    const userId = textColumn(row, "id");
    return {
      id: userId as AdminAccount["id"],
      email: textColumn(row, "email"),
      displayName: decryptTextOrNull(
        keyOf(userId),
        displayNameContext(userId),
        row.display_name_enc,
      ),
      emailVerifiedAt: nullableIntegerColumn(row, "email_verified_at"),
      betaState: enumColumn(row, "beta_state", ["locked", "unlocked", "relocked"]),
      suspendedAt: nullableIntegerColumn(row, "suspended_at"),
      onboardingStep: enumColumn(row, "onboarding_step", ["name", "connections", "done"]),
      role: enumColumn(row, "role", ["member", "admin"]),
      deletionState: enumColumn(row, "deletion_state", ["none", "deleting"]),
      grantSource:
        row.grant_source === null ? null : enumColumn(row, "grant_source", ["invite", "admin"]),
      createdAt: integerColumn(row, "created_at"),
      accessGeneration: integerColumn(row, "access_generation"),
      accessEpoch: integerColumn(row, "access_epoch"),
    };
  }
}
