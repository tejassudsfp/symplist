import {
  applyMigrations,
  createLocalSqliteClient,
  DbStatementError,
  int,
  type LocalSqliteClient,
  type Statement,
  sql,
  uuidv7,
} from "@symplist/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const now = 1_789_500_000_000;
let db: LocalSqliteClient;

async function fails(statement: Statement): Promise<string> {
  try {
    await db.run(statement);
  } catch (error) {
    if (error instanceof DbStatementError && error.kind === "constraint") return "constraint";
    throw error;
  }
  throw new Error("expected the statement to fail");
}

async function user(email: string): Promise<string> {
  const id = uuidv7(now);
  await db.run(
    sql(
      `INSERT INTO users (id, email, email_verified_at, created_at, updated_at, write_id)
       VALUES (:id, :email, :now, :now, :now, 'w')`,
      { id, email, now: int(now) },
    ),
  );
  return id;
}

function invite(overrides: Record<string, string | null> = {}): Statement {
  const values: Record<string, string | null> = {
    id: uuidv7(now),
    campaign_id: uuidv7(now),
    mode: "independent",
    digest: "d".repeat(43),
    digest_version: "1",
    hint: "ABCD",
    label_enc: null,
    label_owner_id: null,
    bound_email: null,
    max_redemptions: "1",
    expires_at: int(now + 1000),
    created_by: uuidv7(now),
    created_at: int(now),
    updated_at: int(now),
    write_id: "w",
    ...overrides,
  };
  const columns = Object.keys(values);
  return sql(
    `INSERT INTO beta_invites (${columns.join(", ")}) VALUES (${columns.map((column) => `:${column}`).join(", ")})`,
    values,
  );
}

beforeEach(async () => {
  db = createLocalSqliteClient({ path: ":memory:", env: { NODE_ENV: "test" } });
  await applyMigrations(db);
});

afterEach(() => db.close());

describe("access migrations 0100-0102 (§5.4)", () => {
  it("creates STRICT beta tables", async () => {
    const tables = await db.all(
      sql(
        `SELECT name, strict FROM pragma_table_list WHERE name IN ('beta_invites', 'beta_redemptions', 'beta_access_grants') ORDER BY name`,
      ),
    );
    expect(tables).toEqual([
      { name: "beta_access_grants", strict: 1 },
      { name: "beta_invites", strict: 1 },
      { name: "beta_redemptions", strict: 1 },
    ]);
  });

  it("stores no redemption count and checks invite shapes", async () => {
    const columns = await db.all(sql(`SELECT name FROM pragma_table_info('beta_invites')`));
    expect(columns.map((column) => column.name)).not.toContain("redemption_count");
    await db.run(invite());
    const shapes: Record<string, string>[] = [
      { digest: "short" },
      { hint: "abcd" },
      { hint: "AB01" },
      { max_redemptions: "0" },
      { mode: "everyone" },
      { expires_at: int(now) },
      { label_enc: "sym1.x" },
      { bound_email: "no-at-sign" },
      { revoked_at: int(now) },
    ];
    for (const overrides of shapes) {
      expect(
        await fails(invite({ digest: "e".repeat(43), ...overrides })),
        JSON.stringify(overrides),
      ).toBe("constraint");
    }
    expect(await fails(invite())).toBe("constraint");
  });

  it("enforces one seat number per invite, one redemption per account epoch and unique request ids", async () => {
    const inviteId = uuidv7(now);
    await db.run(invite({ id: inviteId, max_redemptions: "5" }));
    const redemption = (overrides: Record<string, string>) =>
      sql(
        `INSERT INTO beta_redemptions (id, invite_id, seat_no, user_id, access_epoch, request_id, redeemed_at)
         VALUES (:id, :invite, :seat, :user, :epoch, :req, :now)`,
        {
          id: uuidv7(now),
          invite: inviteId,
          seat: "1",
          user: uuidv7(now),
          epoch: "0",
          req: uuidv7(now),
          now: int(now),
          ...overrides,
        },
      );
    const userId = uuidv7(now);
    await db.run(redemption({ user: userId, req: "r1" }));
    expect(await fails(redemption({}))).toBe("constraint");
    expect(await fails(redemption({ seat: "2", user: userId }))).toBe("constraint");
    expect(await fails(redemption({ seat: "2", req: "r1" }))).toBe("constraint");
    await db.run(redemption({ seat: "2", user: userId, epoch: "1" }));
    expect(await fails(redemption({ seat: "3", invite: uuidv7(now) }))).toBe("constraint");
  });

  it("allows one current grant per account and checks grant shapes", async () => {
    const userId = await user("maya@example.com");
    const grant = (overrides: Record<string, string | null>) =>
      sql(
        `INSERT INTO beta_access_grants (id, user_id, source, source_id, campaign_id, access_epoch, granted_at,
           actor_kind, actor_id, reason_enc, revoked_at, revoked_reason, write_id)
         VALUES (:id, :user, :source, :source_id, :campaign, 0, :now, :actor_kind, :actor, NULL, :revoked, :reason, 'w')`,
        {
          id: uuidv7(now),
          user: userId,
          source: "admin",
          source_id: uuidv7(now),
          campaign: null,
          now: int(now),
          actor_kind: "system",
          actor: null,
          revoked: null,
          reason: null,
          ...overrides,
        },
      );
    await db.run(grant({}));
    expect(await fails(grant({}))).toBe("constraint");
    await db.run(grant({ revoked: int(now), reason: "relocked" }));
    expect(await fails(grant({ revoked: int(now), reason: "because" }))).toBe("constraint");
    expect(await fails(grant({ revoked: int(now) }))).toBe("constraint");
    expect(await fails(grant({ source: "invite", revoked: int(now), reason: "relocked" }))).toBe(
      "constraint",
    );
    expect(await fails(grant({ actor_kind: "admin", revoked: int(now), reason: "relocked" }))).toBe(
      "constraint",
    );
    expect(await fails(grant({ user: uuidv7(now), revoked: int(now), reason: "relocked" }))).toBe(
      "constraint",
    );
  });
});
