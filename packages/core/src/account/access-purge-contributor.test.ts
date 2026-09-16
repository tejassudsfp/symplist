import {
  applyMigrations,
  createLocalSqliteClient,
  int,
  type LocalSqliteClient,
  sql,
  uuidv7,
} from "@symplist/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accessPurgeContributor } from "./purge-contributors/access.ts";

const now = 1_789_500_000_000;
let db: LocalSqliteClient;

async function seed(): Promise<{ purged: string; kept: string; inviteId: string }> {
  const purged = uuidv7(now);
  const kept = uuidv7(now);
  const inviteId = uuidv7(now);
  const statements = [purged, kept].map((id) =>
    sql(
      `INSERT INTO users (id, email, email_verified_at, beta_state, deletion_state, deletion_requested_at,
         created_at, updated_at, write_id)
       VALUES (:id, :email, :now, 'unlocked', :deletion, :requested, :now, :now, 'w')`,
      {
        id,
        email: `${id}@example.test`,
        now: int(now),
        deletion: id === purged ? "deleting" : "none",
        requested: id === purged ? int(now) : null,
      },
    ),
  );
  statements.push(
    sql(
      `INSERT INTO beta_invites (id, campaign_id, mode, digest, digest_version, hint, label_enc, label_owner_id,
         bound_email, max_redemptions, expires_at, created_by, created_at, updated_at, write_id)
       VALUES (:id, :campaign, 'shared', :digest, 1, 'ABCD', 'sym1.label', :owner, NULL, 5, :expires, :owner, :now, :now, 'w')`,
      {
        id: inviteId,
        campaign: uuidv7(now),
        digest: "d".repeat(43),
        owner: purged,
        expires: int(now + 1000),
        now: int(now),
      },
    ),
  );
  for (const [seat, userId] of [purged, kept].entries()) {
    const redemption = uuidv7(now);
    statements.push(
      sql(
        `INSERT INTO beta_redemptions (id, invite_id, seat_no, user_id, access_epoch, request_id, redeemed_at)
         VALUES (:id, :invite, :seat, :user, 0, :req, :now)`,
        {
          id: redemption,
          invite: inviteId,
          seat: int(seat + 1),
          user: userId,
          req: redemption,
          now: int(now),
        },
      ),
    );
    for (const revoked of [true, false]) {
      statements.push(
        sql(
          `INSERT INTO beta_access_grants (id, user_id, source, source_id, campaign_id, access_epoch, granted_at,
             actor_kind, actor_id, reason_enc, revoked_at, revoked_reason, write_id)
           VALUES (:id, :user, 'admin', :source, NULL, 0, :now, 'system', NULL, NULL, :revoked, :reason, 'w')`,
          {
            id: uuidv7(now),
            user: userId,
            source: uuidv7(now),
            now: int(now),
            revoked: revoked ? int(now) : null,
            reason: revoked ? "relocked" : null,
          },
        ),
      );
    }
  }
  await db.batch(statements);
  return { purged, kept, inviteId };
}

beforeEach(async () => {
  db = createLocalSqliteClient({ path: ":memory:", env: { NODE_ENV: "test" } });
  await applyMigrations(db);
});

afterEach(() => db.close());

describe("the access purge contributor (§5.6 step 4)", () => {
  it("deletes the account's grants in bounded batches, clears its unreadable labels and keeps its seat", async () => {
    const { purged, kept, inviteId } = await seed();
    const input = { userId: purged, batchLimit: 1 };
    const remaining = async () => {
      const results = await db.batch(accessPurgeContributor.remaining?.(input) ?? []);
      return results[0]?.results[0]?.remaining;
    };
    expect(await remaining()).toBe(1);
    let rounds = 0;
    while ((await remaining()) === 1) {
      await db.batch(accessPurgeContributor.statements(input));
      rounds += 1;
      expect(rounds).toBeLessThan(5);
    }
    expect(rounds).toBe(2);

    expect(
      await db.all(sql(`SELECT id FROM beta_access_grants WHERE user_id = :u`, { u: purged })),
    ).toEqual([]);
    expect(
      await db.all(sql(`SELECT id FROM beta_access_grants WHERE user_id = :u`, { u: kept })),
    ).toHaveLength(2);
    expect(
      await db.first(
        sql(`SELECT label_enc, label_owner_id, created_by FROM beta_invites WHERE id = :i`, {
          i: inviteId,
        }),
      ),
    ).toEqual({
      label_enc: null,
      label_owner_id: null,
      created_by: purged,
    });
    expect(await db.all(sql(`SELECT seat_no FROM beta_redemptions ORDER BY seat_no`))).toEqual([
      { seat_no: 1 },
      { seat_no: 2 },
    ]);
    // Idempotent: running again changes nothing.
    await db.batch(accessPurgeContributor.statements(input));
    expect(await remaining()).toBe(0);
    // With the grants gone, the users row can be deleted despite the foreign key.
    await db.run(sql(`DELETE FROM users WHERE id = :u`, { u: purged }));
  });
});
