import {
  applyMigrations,
  createLocalSqliteClient,
  type DbClient,
  int,
  type LocalSqliteClient,
  sql,
  uuidv7,
} from "@symplist/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  D1AccessService,
  MAX_RESTRICTIONS_PER_BATCH,
  RestrictContributorError,
  type RestrictionCommitted,
  restrictionDecidingStatement,
} from "./restrict.ts";
import { restrictContributors } from "./restrict-contributors/index.ts";
import type { RestrictContributor } from "./restrict-contributors/types.ts";
import type { RestrictInput } from "./service.ts";
import { accessCondition, RESTRICT_GUARD_SQL, restrictGuard } from "./sql.ts";

const now = 1_789_500_000_000;
const policy = { betaAccessRequired: true };
let db: LocalSqliteClient;

async function createUser(
  client: DbClient,
  overrides: { beta?: string; suspended?: boolean; role?: string; deleting?: boolean } = {},
): Promise<string> {
  const id = uuidv7(now);
  await client.run(
    sql(
      `INSERT INTO users (id, email, email_verified_at, beta_state, suspended_at, role, deletion_state,
         deletion_requested_at, created_at, updated_at, write_id)
       VALUES (:id, :email, :now, :beta, :suspended, :role, :deletion, :requested, :now, :now, :w)`,
      {
        id,
        email: `${id}@example.test`,
        now: int(now),
        beta: overrides.beta ?? "unlocked",
        suspended: overrides.suspended ? int(now) : null,
        role: overrides.role ?? "member",
        deletion: overrides.deleting ? "deleting" : "none",
        requested: overrides.deleting ? int(now) : null,
        w: uuidv7(now),
      },
    ),
  );
  return id;
}

/** A probe domain table the contributors below write, one row per restricted user. */
const probeContributor = (domain: RestrictContributor["domain"]): RestrictContributor => ({
  domain,
  statements: (input) => {
    const guard = restrictGuard(input);
    return [
      sql(
        `INSERT INTO probe_revocations (domain, user_id, reason)
         SELECT :domain, :restrict_user, :reason WHERE ${guard.exists}`,
        { ...guard.params, domain, reason: input.reason },
      ),
    ];
  },
});

const input = (userId: string, overrides: Partial<RestrictInput> = {}): RestrictInput => ({
  userId,
  reason: "relocked",
  writeId: uuidv7(now),
  now: now + 1,
  ...overrides,
});

beforeEach(async () => {
  db = createLocalSqliteClient({ path: ":memory:", env: { NODE_ENV: "test" } });
  await applyMigrations(db);
  await db.executeScript(
    `CREATE TABLE probe_revocations (domain TEXT NOT NULL, user_id TEXT NOT NULL, reason TEXT NOT NULL) STRICT;`,
  );
});

afterEach(() => db.close());

describe("the restriction routine (§5.5)", () => {
  it("relocks, bumps access_generation and runs every contribution in one batch", async () => {
    const effects: RestrictionCommitted[] = [];
    const service = new D1AccessService({
      db,
      policy,
      contributors: [probeContributor("vault"), probeContributor("simon")],
      effects: [{ name: "record", afterCommit: async (event) => void effects.push(event) }],
    });
    const userId = await createUser(db);
    const batch = vi.spyOn(db, "batch");

    const outcome = await service.restrict(input(userId));
    expect(batch).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ userId, applied: true, accessGeneration: 1 });
    expect(await service.load(userId)).toMatchObject({
      betaState: "relocked",
      accessGeneration: 1,
    });
    expect(
      await db.all(sql(`SELECT domain, reason FROM probe_revocations ORDER BY rowid`)),
    ).toEqual([
      { domain: "vault", reason: "relocked" },
      { domain: "simon", reason: "relocked" },
    ]);
    expect(effects).toEqual([
      { userId, reason: "relocked", accessGeneration: 1, committedAt: now + 1 },
    ]);
  });

  it("suspends without touching the beta state", async () => {
    const service = new D1AccessService({ db, policy, contributors: [] });
    const userId = await createUser(db);
    expect((await service.restrict(input(userId, { reason: "suspended" }))).applied).toBe(true);
    expect(await service.load(userId)).toMatchObject({
      betaState: "unlocked",
      suspendedAt: now + 1,
      accessGeneration: 1,
    });
    expect(service.satisfies((await service.load(userId)) ?? fail(), "admitted")).toBe(false);
  });

  it("applies nothing, contributions included, when the deciding statement does not match", async () => {
    const effect = vi.fn(async () => undefined);
    const service = new D1AccessService({
      db,
      policy,
      contributors: [probeContributor("vault")],
      effects: [{ name: "spy", afterCommit: effect }],
    });
    const relocked = await createUser(db, { beta: "relocked" });
    const deleting = await createUser(db, { deleting: true });
    const suspended = await createUser(db, { suspended: true });

    expect(await service.restrict(input(relocked))).toMatchObject({
      applied: false,
      accessGeneration: null,
    });
    expect(await service.restrict(input(deleting))).toMatchObject({ applied: false });
    expect(await service.restrict(input(suspended, { reason: "suspended" }))).toMatchObject({
      applied: false,
    });
    expect(await service.restrict(input(uuidv7(now)))).toMatchObject({ applied: false });
    expect(await db.all(sql(`SELECT * FROM probe_revocations`))).toEqual([]);
    expect(effect).not.toHaveBeenCalled();
  });

  it("revokes campaign access with the campaign id available to contributors", async () => {
    const seen: (string | undefined)[] = [];
    const service = new D1AccessService({
      db,
      policy,
      contributors: [
        {
          domain: "access",
          statements: (restriction) => {
            seen.push(restriction.campaignId);
            return probeContributor("access").statements(restriction);
          },
        },
      ],
    });
    const userId = await createUser(db);
    const campaignId = uuidv7(now);
    await service.restrict(input(userId, { reason: "campaign_revoked", campaignId }));
    expect(seen).toEqual([campaignId]);
    expect(await service.load(userId)).toMatchObject({ betaState: "relocked" });
    expect(() => service.restrictStatements(input(userId, { reason: "campaign_revoked" }))).toThrow(
      /campaignId/,
    );
    expect(() => service.restrictStatements(input(userId, { campaignId }))).toThrow(/campaignId/);
  });

  it("contributes no users statement for account deletion and refuses to run it alone", async () => {
    const service = new D1AccessService({ db, policy, contributors: [probeContributor("vault")] });
    const userId = await createUser(db);
    const statements = service.restrictStatements(input(userId, { reason: "deleted" }));
    expect(statements).toHaveLength(1);
    expect(restrictionDecidingStatement(input(userId, { reason: "deleted" }))).toBeNull();
    await expect(service.restrict(input(userId, { reason: "deleted" }))).rejects.toThrow(/folds/);
  });

  it("rejects contributions that write users, skip the guard, bind another write or write nothing", () => {
    const userId = uuidv7(now);
    const cases: [string, RestrictContributor][] = [
      [
        "writes users",
        {
          domain: "vault",
          statements: (restriction) => {
            const guard = restrictGuard(restriction);
            return [
              sql(
                `UPDATE users SET role = 'member' WHERE id = :restrict_user AND ${guard.exists}`,
                guard.params,
              ),
            ];
          },
        },
      ],
      [
        "without the write-id guard",
        {
          domain: "vault",
          statements: () => [
            sql(`DELETE FROM probe_revocations WHERE user_id = :u`, { u: userId }),
          ],
        },
      ],
      [
        "another user or write",
        {
          domain: "vault",
          statements: () => {
            const guard = restrictGuard({ userId, writeId: uuidv7(now) });
            return [sql(`DELETE FROM probe_revocations WHERE ${guard.exists}`, guard.params)];
          },
        },
      ],
      [
        "writes nothing",
        {
          domain: "vault",
          statements: (restriction) => {
            const guard = restrictGuard(restriction);
            return [sql(`SELECT 1 WHERE ${guard.exists}`, guard.params)];
          },
        },
      ],
    ];
    for (const [label, contributor] of cases) {
      const service = new D1AccessService({ db, policy, contributors: [contributor] });
      expect(() => service.restrictStatements(input(userId)), label).toThrow(
        RestrictContributorError,
      );
    }
  });

  it("restricts many accounts in batches of at most five with per-account outcomes", async () => {
    const service = new D1AccessService({
      db,
      policy,
      contributors: [probeContributor("sharing")],
    });
    const users: string[] = [];
    for (let index = 0; index < 7; index += 1) users.push(await createUser(db));
    const already = await createUser(db, { beta: "relocked" });
    const batch = vi.spyOn(db, "batch");
    const outcomes = await service.restrictMany(
      [...users, already].map((userId) =>
        input(userId, { reason: "campaign_revoked", campaignId: "c1" }),
      ),
    );
    expect(MAX_RESTRICTIONS_PER_BATCH).toBe(5);
    expect(batch).toHaveBeenCalledTimes(2);
    expect(outcomes.map((outcome) => outcome.applied)).toEqual([...users.map(() => true), false]);
    expect(await db.first(sql(`SELECT COUNT(*) AS n FROM probe_revocations`))).toEqual({ n: 7 });
    await expect(
      service.restrictMany([input(users[0] ?? ""), input(users[0] ?? "")]),
    ).rejects.toThrow(/once/);
  });

  it("reports failing effects and still runs the remaining ones", async () => {
    const errors: string[] = [];
    const later = vi.fn(async () => undefined);
    const service = new D1AccessService({
      db,
      policy,
      contributors: [],
      effects: [
        { name: "sockets", afterCommit: async () => Promise.reject(new Error("gateway down")) },
        { name: "runs", afterCommit: later },
      ],
      onEffectError: (name) => errors.push(name),
    });
    const userId = await createUser(db);
    expect((await service.restrict(input(userId))).applied).toBe(true);
    expect(errors).toEqual(["sockets"]);
    expect(later).toHaveBeenCalledTimes(1);
  });

  it("runs the effects of committed batches even when a later batch fails", async () => {
    const users: string[] = [];
    for (let index = 0; index < 6; index += 1) users.push(await createUser(db));
    const failing = users[5];
    const committed: string[] = [];
    const service = new D1AccessService({
      db,
      policy,
      contributors: [
        {
          domain: "vault",
          statements: (restriction) => {
            const guard = restrictGuard(restriction);
            const table = restriction.userId === failing ? "missing_table" : "probe_revocations";
            return [
              sql(
                `INSERT INTO ${table} (domain, user_id, reason)
                 SELECT 'vault', :restrict_user, :reason WHERE ${guard.exists}`,
                { ...guard.params, reason: restriction.reason },
              ),
            ];
          },
        },
      ],
      effects: [
        { name: "record", afterCommit: async (event) => void committed.push(event.userId) },
      ],
    });
    await expect(service.restrictMany(users.map((userId) => input(userId)))).rejects.toThrow();
    expect(committed).toEqual(users.slice(0, 5));
    expect(await service.load(failing ?? "")).toMatchObject({ betaState: "unlocked" });
  });

  it("registers the foundation seam contributors, which contribute nothing yet", () => {
    const service = new D1AccessService({ db, policy });
    expect(restrictContributors.map((contributor) => contributor.domain)).toEqual([
      "access",
      "vault",
      "simon",
      "scheduling",
      "sharing",
      "mcp",
      "connections",
    ]);
    expect(service.restrictStatements(input(uuidv7(now)))).toHaveLength(1);
  });
});

describe("access conditions for folded checks (§3.1, §5.4)", () => {
  async function holds(
    userId: string,
    level: "identity" | "admitted" | "admin",
    betaAccessRequired = true,
  ) {
    const row = await db.first(
      sql(`SELECT ${accessCondition({ level, policy: { betaAccessRequired } })} AS ok`, {
        access_user: userId,
      }),
    );
    return row?.ok === 1;
  }

  it("matches the evaluation rules for every level", async () => {
    const member = await createUser(db);
    const admin = await createUser(db, { role: "admin" });
    const locked = await createUser(db, { beta: "locked" });
    const relocked = await createUser(db, { beta: "relocked" });
    const suspended = await createUser(db, { suspended: true });
    const deleting = await createUser(db, { deleting: true });

    expect(await holds(member, "admitted")).toBe(true);
    expect(await holds(member, "admin")).toBe(false);
    expect(await holds(admin, "admin")).toBe(true);
    expect(await holds(locked, "identity")).toBe(true);
    expect(await holds(locked, "admitted")).toBe(false);
    expect(await holds(locked, "admitted", false)).toBe(true);
    expect(await holds(relocked, "admitted", false)).toBe(false);
    expect(await holds(suspended, "admitted")).toBe(false);
    expect(await holds(deleting, "identity")).toBe(false);
    expect(await holds(uuidv7(now), "identity")).toBe(false);
  });

  it("pins the access generation when asked, so a restriction between check and write fails it", async () => {
    const userId = await createUser(db);
    const condition = accessCondition({ level: "admitted", policy, generationParam: "gen" });
    const check = async () =>
      (await db.first(sql(`SELECT ${condition} AS ok`, { access_user: userId, gen: int(0) })))?.ok;
    expect(await check()).toBe(1);
    await new D1AccessService({ db, policy, contributors: [] }).restrict(
      input(userId, { reason: "suspended" }),
    );
    expect(await check()).toBe(0);
    expect(RESTRICT_GUARD_SQL).toContain(":restrict_write_id");
  });
});

function fail(): never {
  throw new Error("expected a value");
}
