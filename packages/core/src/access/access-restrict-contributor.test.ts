import {
  applyMigrations,
  createLocalSqliteClient,
  int,
  type LocalSqliteClient,
  sql,
  uuidv7,
} from "@symplist/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { D1AccessService } from "./restrict.ts";
import { accessRestrictContributor } from "./restrict-contributors/access.ts";
import { restrictGuard } from "./sql.ts";

const now = 1_789_500_000_000;
let db: LocalSqliteClient;

async function user(state: "unlocked" | "relocked" = "unlocked"): Promise<string> {
  const id = uuidv7(now);
  await db.run(
    sql(
      `INSERT INTO users (id, email, email_verified_at, beta_state, created_at, updated_at, write_id)
       VALUES (:id, :email, :now, :state, :now, :now, 'w')`,
      { id, email: `${id}@example.test`, now: int(now), state },
    ),
  );
  return id;
}

async function grant(userId: string, campaignId: string | null, revoked = false): Promise<string> {
  const id = uuidv7(now);
  await db.run(
    sql(
      `INSERT INTO beta_access_grants (id, user_id, source, source_id, campaign_id, access_epoch, granted_at,
         actor_kind, actor_id, reason_enc, revoked_at, revoked_reason, write_id)
       VALUES (:id, :user, :source, :source_id, :campaign, 0, :now, 'system', NULL, NULL, :revoked, :reason, 'w')`,
      {
        id,
        user: userId,
        source: campaignId ? "invite" : "admin",
        source_id: uuidv7(now),
        campaign: campaignId,
        now: int(now),
        revoked: revoked ? int(now - 1) : null,
        reason: revoked ? "relocked" : null,
      },
    ),
  );
  return id;
}

const grantsOf = (userId: string) =>
  db.all(
    sql(
      `SELECT campaign_id, revoked_at, revoked_reason FROM beta_access_grants WHERE user_id = :user ORDER BY rowid`,
      { user: userId },
    ),
  );

beforeEach(async () => {
  db = createLocalSqliteClient({ path: ":memory:", env: { NODE_ENV: "test" } });
  await applyMigrations(db);
});

afterEach(() => db.close());

describe("the access restriction contributor (§5.5)", () => {
  const service = () =>
    new D1AccessService({
      db,
      policy: { betaAccessRequired: true },
      contributors: [accessRestrictContributor],
    });

  it("revokes the current grant in the relock batch, and leaves revoked grants untouched", async () => {
    const userId = await user();
    await grant(userId, null, true);
    await grant(userId, uuidv7(now));
    const outcome = await service().restrict({
      userId,
      reason: "relocked",
      writeId: uuidv7(now),
      now: now + 5,
    });
    expect(outcome.applied).toBe(true);
    expect(await grantsOf(userId)).toEqual([
      { campaign_id: null, revoked_at: now - 1, revoked_reason: "relocked" },
      { campaign_id: expect.any(String), revoked_at: now + 5, revoked_reason: "relocked" },
    ]);
  });

  it("revokes only the named campaign's grants for a campaign revocation", async () => {
    const campaign = uuidv7(now);
    const member = await user();
    const outsider = await user();
    await grant(member, campaign);
    await grant(outsider, uuidv7(now));
    await service().restrict({
      userId: member,
      reason: "campaign_revoked",
      campaignId: campaign,
      writeId: uuidv7(now),
      now,
    });
    await service().restrict({
      userId: outsider,
      reason: "campaign_revoked",
      campaignId: campaign,
      writeId: uuidv7(now),
      now,
    });
    expect(await grantsOf(member)).toMatchObject([{ revoked_reason: "campaign_revoked" }]);
    expect(await grantsOf(outsider)).toMatchObject([{ revoked_at: null }]);
  });

  it("revokes nothing when the deciding statement did not apply", async () => {
    const userId = await user("relocked");
    await grant(userId, uuidv7(now));
    expect(
      (await service().restrict({ userId, reason: "relocked", writeId: uuidv7(now), now })).applied,
    ).toBe(false);
    expect(await grantsOf(userId)).toMatchObject([{ revoked_at: null }]);
  });

  it("carries the write-id guard, so deletion's folded statements apply only with statement 1", async () => {
    const userId = await user();
    await grant(userId, null);
    const writeId = uuidv7(now);
    const statements = accessRestrictContributor.statements({
      userId,
      reason: "deleted",
      writeId,
      now,
    });
    expect(statements).toHaveLength(1);
    expect(statements[0]?.sql).toContain(
      "EXISTS (SELECT 1 FROM users WHERE id = ? AND write_id = ?)",
    );
    await db.batch(statements);
    expect(await grantsOf(userId)).toMatchObject([{ revoked_at: null }]);
    const guard = restrictGuard({ userId, writeId });
    await db.batch([
      sql(
        `UPDATE users SET deletion_state = 'deleting', deletion_requested_at = :now, write_id = :restrict_write_id
         WHERE id = :restrict_user`,
        { ...guard.params, now: int(now) },
      ),
      ...statements,
    ]);
    expect(await grantsOf(userId)).toMatchObject([{ revoked_reason: "deleted" }]);
  });
});
