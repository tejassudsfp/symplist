import { randomBytes } from "node:crypto";
import { inviteBatchMax, normalizeInviteCode } from "@symplist/contracts";
import { createKeyProvider, keyFamilies, type ManagedKeyProvider } from "@symplist/crypto";
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
import { AccountKeyStore } from "../account/keys.ts";
import { AdminBootstrapService } from "./bootstrap.ts";
import { AccessFeatureError } from "./feature-error.ts";
import { encodeBase32, generateInviteCode, InviteAdminService, inviteStatus } from "./invites.ts";
import { type OtpDelivery, OtpService } from "./otp.ts";
import { accessDestination } from "./profile.ts";
import { RedemptionService } from "./redemption.ts";
import type { AccessState } from "./types.ts";

const start = 1_789_500_000_000;
let clock = start;
let db: LocalSqliteClient;
let keys: ManagedKeyProvider;

/** Key material by family and version, so a test can rotate a family and keep the old version. */
function keyProvider(
  material: Map<string, Map<number, Buffer>>,
  current: Record<string, number> = {},
) {
  return createKeyProvider(
    Object.fromEntries(
      keyFamilies.map((family) => [
        family,
        { current: current[family] ?? 1, versions: material.get(family) ?? new Map() },
      ]),
    ),
  );
}

function freshMaterial(): Map<string, Map<number, Buffer>> {
  return new Map(keyFamilies.map((family) => [family, new Map([[1, randomBytes(32)]])]));
}

async function createUser(
  client: DbClient,
  options: {
    email?: string;
    beta?: "locked" | "unlocked" | "relocked";
    verified?: boolean;
    suspended?: boolean;
    role?: "member" | "admin";
  } = {},
): Promise<{ id: string; email: string }> {
  const id = uuidv7(clock);
  const email = options.email ?? `${id}@example.test`;
  await client.batch([
    sql(
      `INSERT INTO users (id, email, email_verified_at, beta_state, suspended_at, role, created_at, updated_at, write_id)
       VALUES (:id, :email, :verified, :beta, :suspended, :role, :now, :now, 'w')`,
      {
        id,
        email,
        verified: options.verified === false ? null : int(clock),
        beta: options.beta ?? "locked",
        suspended: options.suspended ? int(clock) : null,
        role: options.role ?? "member",
        now: int(clock),
      },
    ),
    new AccountKeyStore({ db: client, keys }).provisionStatement({ userId: id, now: clock }),
  ]);
  return { id, email };
}

async function createInvite(
  service: InviteAdminService,
  admin: { id: string },
  overrides: Partial<Parameters<InviteAdminService["planGeneration"]>[0]["request"]> = {},
) {
  const adminKey = await new AccountKeyStore({ db, keys }).require(admin.id);
  const plan = service.planGeneration({
    adminId: admin.id,
    adminKey,
    request: {
      mode: "independent",
      count: 1,
      maxRedemptions: 1,
      expiresAt: clock + 86_400_000,
      ...overrides,
    },
    guard: { exists: "1", params: {} },
  });
  await db.batch(plan.statements);
  return plan.response;
}

beforeEach(async () => {
  clock = start;
  db = createLocalSqliteClient({ path: ":memory:", env: { NODE_ENV: "test" } });
  await applyMigrations(db);
  keys = keyProvider(freshMaterial());
});

afterEach(() => db.close());

describe("invite codes (note 04)", () => {
  it("encodes RFC 4648 Base32 test vectors", () => {
    const vectors: [string, string][] = [
      ["", ""],
      ["f", "MY"],
      ["fo", "MZXQ"],
      ["foo", "MZXW6"],
      ["foob", "MZXW6YQ"],
      ["fooba", "MZXW6YTB"],
      ["foobar", "MZXW6YTBOI"],
    ];
    for (const [input, output] of vectors) expect(encodeBase32(Buffer.from(input))).toBe(output);
  });

  it("draws 20 random bytes per code and wipes them", () => {
    let drawn: Uint8Array | undefined;
    const code = generateInviteCode((size) => {
      drawn = new Uint8Array(randomBytes(size));
      return drawn;
    });
    expect(code).toMatch(/^[A-Z2-7]{32}$/);
    expect(drawn?.byteLength).toBe(20);
    expect(drawn?.every((byte) => byte === 0)).toBe(true);
    expect(() => generateInviteCode(() => new Uint8Array(19))).toThrow();
  });

  it("derives statuses with revoked, expired and exhausted in that order", () => {
    const base = { revokedAt: null, expiresAt: start + 1, used: 0, maxRedemptions: 1 };
    expect(inviteStatus(base, start)).toBe("active");
    expect(inviteStatus({ ...base, used: 1 }, start)).toBe("exhausted");
    expect(inviteStatus({ ...base, used: 1 }, start + 1)).toBe("expired");
    expect(inviteStatus({ ...base, used: 1, revokedAt: start }, start + 1)).toBe("revoked");
  });
});

describe("redemption (§5.4)", () => {
  const policy = { betaAccessRequired: true };
  const services = () => ({
    invites: new InviteAdminService({ db, keys, policy, now: () => clock }),
    redemptions: new RedemptionService({ db, keys, policy, now: () => clock }),
  });

  it("finds codes digested under an earlier INVITE_DIGEST_SECRET version after rotation", async () => {
    const material = freshMaterial();
    keys = keyProvider(material);
    const admin = await createUser(db, { beta: "unlocked", role: "admin" });
    const { invites } = services();
    const minted = await createInvite(invites, admin);

    material.get("INVITE_DIGEST_SECRET")?.set(2, randomBytes(32));
    keys = keyProvider(material, { INVITE_DIGEST_SECRET: 2 });
    const user = await createUser(db);
    const result = await services().redemptions.redeem({
      userId: user.id,
      code: minted.codes[0] ?? "",
      requestId: "req-1",
    });
    expect(result.outcome).toBe("unlocked");

    // Once version 1 is retired the old digest matches nothing.
    const newer = await createInvite(services().invites, admin);
    material.get("INVITE_DIGEST_SECRET")?.delete(1);
    keys = keyProvider(material, { INVITE_DIGEST_SECRET: 2 });
    const other = await createUser(db);
    await expect(
      services().redemptions.redeem({
        userId: other.id,
        code: minted.codes[0] ?? "",
        requestId: "req-2",
      }),
    ).rejects.toMatchObject({ code: "invite.invalid" });
    expect(
      (
        await services().redemptions.redeem({
          userId: other.id,
          code: newer.codes[0] ?? "",
          requestId: "req-3",
        })
      ).outcome,
    ).toBe("unlocked");
  });

  it("keeps a seat claimed by an account relocked before its follow-up, and never unlocks it", async () => {
    const admin = await createUser(db, { beta: "unlocked", role: "admin" });
    const { invites, redemptions } = services();
    const minted = await createInvite(invites, admin, { mode: "shared", maxRedemptions: 3 });
    const user = await createUser(db);
    const canonical = normalizeInviteCode(minted.codes[0] ?? "") ?? "";
    // Claim the seat with the §5.4 statement alone, as if the follow-up never ran.
    const redemptionId = uuidv7(clock);
    await db.run(
      sql(
        `INSERT INTO beta_redemptions (id, invite_id, seat_no, user_id, access_epoch, request_id, redeemed_at)
         SELECT :id, i.id, 1, :user, 0, 'lost', :now FROM beta_invites i WHERE i.hint = :hint`,
        { id: redemptionId, user: user.id, now: int(clock), hint: canonical.slice(-4) },
      ),
    );
    await db.run(sql(`UPDATE users SET beta_state = 'relocked' WHERE id = :u`, { u: user.id }));
    expect(await redemptions.reconcile()).toEqual([]);
    const finalized = await redemptions.finalize({
      id: redemptionId,
      userId: user.id,
      accessEpoch: 0,
    });
    expect(finalized).toMatchObject({ granted: false, access: { betaState: "relocked" } });
    expect(await db.all(sql(`SELECT id FROM beta_access_grants`))).toEqual([]);
    expect(
      await db.all(sql(`SELECT id FROM beta_admin_events WHERE action = 'invite_redeemed'`)),
    ).toEqual([]);
  });

  it("reconciles lost follow-ups idempotently and records one event per seat", async () => {
    const admin = await createUser(db, { beta: "unlocked", role: "admin" });
    const { invites, redemptions } = services();
    const minted = await createInvite(invites, admin, { mode: "shared", maxRedemptions: 3 });
    const canonical = normalizeInviteCode(minted.codes[0] ?? "") ?? "";
    const users = [await createUser(db), await createUser(db)];
    for (const [index, user] of users.entries()) {
      await db.run(
        sql(
          `INSERT INTO beta_redemptions (id, invite_id, seat_no, user_id, access_epoch, request_id, redeemed_at)
           SELECT :id, i.id, :seat, :user, 0, :req, :now FROM beta_invites i WHERE i.hint = :hint`,
          {
            id: uuidv7(clock),
            seat: int(index + 1),
            user: user.id,
            req: `lost-${index}`,
            now: int(clock),
            hint: canonical.slice(-4),
          },
        ),
      );
    }
    const first = await redemptions.reconcile();
    expect(first.map((entry) => entry.granted)).toEqual([true, true]);
    expect(await redemptions.reconcile()).toEqual([]);
    expect(
      await db.all(sql(`SELECT id FROM beta_admin_events WHERE action = 'invite_redeemed'`)),
    ).toHaveLength(2);
    for (const user of users) {
      expect(
        await db.first(
          sql(`SELECT beta_state, access_generation FROM users WHERE id = :u`, { u: user.id }),
        ),
      ).toEqual({ beta_state: "unlocked", access_generation: 1 });
    }
  });

  it("refuses unverified accounts and never consumes a seat for them", async () => {
    const admin = await createUser(db, { beta: "unlocked", role: "admin" });
    const { invites, redemptions } = services();
    const minted = await createInvite(invites, admin);
    const pending = await createUser(db, { verified: false });
    await expect(
      redemptions.redeem({ userId: pending.id, code: minted.codes[0] ?? "", requestId: "r" }),
    ).rejects.toBeInstanceOf(AccessFeatureError);
    expect(await db.all(sql(`SELECT id FROM beta_redemptions`))).toEqual([]);
  });
});

describe("OTP challenges (§5.1)", () => {
  const deliveries: OtpDelivery[] = [];
  const service = () =>
    new OtpService({
      db,
      keys,
      mailer: { send: async (delivery) => void deliveries.push(delivery) },
      now: () => clock,
      codeLength: 6,
      ttlMinutes: 10,
      maxAttempts: 5,
    });

  beforeEach(() => {
    deliveries.length = 0;
  });

  const verifyLogin = (challengeId: string, code: string) =>
    service().verify({
      challengeId,
      code,
      purposes: ["login", "signup"],
      success: () => ({ statements: [], decide: () => "ok" }),
    });

  it("keeps the failure count across a rotation of OTP_DIGEST_SECRET", async () => {
    const material = freshMaterial();
    keys = keyProvider(material);
    const user = await createUser(db, { beta: "unlocked" });
    for (let failure = 0; failure < 9; failure += 1) {
      if (failure % 5 === 0) {
        if (failure > 0) clock += 60_000;
        await service().sendLogin(user.email);
      }
      const delivery = deliveries.at(-1);
      await verifyLogin(
        delivery?.challengeId ?? "",
        delivery?.code === "000000" ? "111111" : "000000",
      ).catch(() => undefined);
    }
    material.get("OTP_DIGEST_SECRET")?.set(2, randomBytes(32));
    keys = keyProvider(material, { OTP_DIGEST_SECRET: 2 });
    clock += 60_000;
    await service().sendLogin(user.email);
    const delivery = deliveries.at(-1);
    await expect(
      verifyLogin(delivery?.challengeId ?? "", delivery?.code === "000000" ? "111111" : "000000"),
    ).rejects.toMatchObject({
      code: "otp.locked",
    });
    await expect(
      verifyLogin(delivery?.challengeId ?? "", delivery?.code ?? ""),
    ).rejects.toMatchObject({
      code: "otp.locked",
    });
  });

  it("binds session purposes to the requesting auth session and rejects them on the login endpoint", async () => {
    const user = await createUser(db, { beta: "unlocked" });
    const sessionId = uuidv7(clock);
    await db.run(
      sql(
        `INSERT INTO auth_sessions (id, user_id, token_digest, digest_version, created_at, last_seen_at, expires_at, write_id)
         VALUES (:id, :user, :digest, 1, :now, :now, :expires, 'w')`,
        {
          id: sessionId,
          user: user.id,
          digest: "t".repeat(43),
          now: int(clock),
          expires: int(clock + 1_000_000),
        },
      ),
    );
    const challenge = await service().sendForSession({
      userId: user.id,
      sessionId,
      purpose: "account_delete",
    });
    const delivery = deliveries.at(-1);
    expect(delivery).toMatchObject({ purpose: "account_delete", email: user.email });
    await expect(verifyLogin(challenge.challengeId, delivery?.code ?? "")).rejects.toMatchObject({
      code: "otp.expired",
    });
    const verified = await service().verify({
      challengeId: challenge.challengeId,
      code: delivery?.code ?? "",
      purposes: ["account_delete"],
      binding: { userId: user.id, sessionId },
      success: () => ({ statements: [], decide: () => "authorized" }),
    });
    expect(verified.value).toBe("authorized");
    await expect(
      service().sendForSession({
        userId: user.id,
        sessionId: uuidv7(clock),
        purpose: "account_delete",
      }),
    ).rejects.toMatchObject({ code: "auth.session_required" });
  });

  it("starts new hour and day windows as they end", async () => {
    const user = await createUser(db, { beta: "unlocked" });
    for (let index = 0; index < 5; index += 1) {
      await service().sendLogin(user.email);
      clock += 60_000;
    }
    await expect(service().sendLogin(user.email)).rejects.toMatchObject({
      code: "otp.send_limited",
    });
    clock = start + 60 * 60_000;
    await service().sendLogin(user.email);
    const row = await db.first(sql(`SELECT hour_challenges, day_challenges FROM otp_limits`));
    expect(row).toEqual({ hour_challenges: 1, day_challenges: 6 });
  });

  it("removes a challenge whose delivery failed", async () => {
    const user = await createUser(db, { beta: "unlocked" });
    const failing = new OtpService({
      db,
      keys,
      mailer: { send: async () => Promise.reject(new Error("provider down")) },
      now: () => clock,
      codeLength: 8,
      ttlMinutes: 10,
      maxAttempts: 5,
    });
    await expect(failing.sendLogin(user.email)).rejects.toMatchObject({
      code: "auth.delivery_failed",
    });
    expect(await db.all(sql(`SELECT id FROM otp_challenges`))).toEqual([]);
    const challenge = await service().sendLogin(user.email);
    expect(challenge.codeLength).toBe(6);
  });
});

describe("admin bootstrap (§5.7)", () => {
  it("allows only one bootstrap event even when two eligible runs race", async () => {
    const owner = await createUser(db, { email: "owner@example.test", beta: "unlocked" });
    const service = new AdminBootstrapService({ db, keys, now: () => clock });
    const outcomes = await Promise.all([
      service.bootstrap("owner@example.test"),
      service.bootstrap(" OWNER@example.test "),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "promoted")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "consumed")).toHaveLength(1);
    expect(
      await db.all(sql(`SELECT target_id FROM beta_admin_events WHERE action = 'admin_bootstrap'`)),
    ).toEqual([{ target_id: owner.id }]);
    expect(await service.isConsumed()).toBe(true);
  });

  it("never clears suspension or relock", async () => {
    const service = new AdminBootstrapService({ db, keys, now: () => clock });
    await createUser(db, { email: "owner@example.test", beta: "relocked" });
    expect(await service.bootstrap("owner@example.test")).toEqual({ status: "not_eligible" });
    await db.run(
      sql(`UPDATE users SET beta_state = 'unlocked', suspended_at = :now`, { now: int(clock) }),
    );
    expect(await service.bootstrap("owner@example.test")).toEqual({ status: "not_eligible" });
    expect(await db.first(sql(`SELECT role, suspended_at FROM users`))).toEqual({
      role: "member",
      suspended_at: clock,
    });
  });
});

describe("access destinations (§5.4)", () => {
  const state = (overrides: Partial<AccessState>): AccessState => ({
    emailVerifiedAt: 1,
    betaState: "unlocked",
    suspendedAt: null,
    onboardingStep: "done",
    role: "member",
    accessGeneration: 0,
    accessEpoch: 0,
    deletionState: "none",
    ...overrides,
  });
  const required = { betaAccessRequired: true };

  it("sends each access state to one screen, honoring BETA_ACCESS_REQUIRED", () => {
    expect(accessDestination(state({}), required)).toBe("app");
    expect(accessDestination(state({ onboardingStep: "name" }), required)).toBe("onboarding");
    expect(accessDestination(state({ onboardingStep: "connections" }), required)).toBe(
      "onboarding",
    );
    expect(accessDestination(state({ betaState: "locked" }), required)).toBe("beta_gate");
    expect(accessDestination(state({ betaState: "locked" }), { betaAccessRequired: false })).toBe(
      "app",
    );
    expect(accessDestination(state({ betaState: "relocked" }), required)).toBe("paused");
    expect(accessDestination(state({ betaState: "relocked" }), { betaAccessRequired: false })).toBe(
      "paused",
    );
    expect(accessDestination(state({ suspendedAt: 5 }), required)).toBe("paused");
    expect(accessDestination(state({ suspendedAt: 5, betaState: "locked" }), required)).toBe(
      "paused",
    );
  });
});

describe("the admin invite list (§3.1)", () => {
  const policy = { betaAccessRequired: true };

  /** Mints `count` invites in batches of `inviteBatchMax`, newest last. */
  async function mint(
    service: InviteAdminService,
    admin: { id: string },
    count: number,
    label?: string,
  ) {
    for (let minted = 0; minted < count; minted += inviteBatchMax) {
      clock += 1;
      await createInvite(service, admin, {
        count: Math.min(inviteBatchMax, count - minted),
        ...(label === undefined ? {} : { label }),
      });
    }
  }

  it("costs a bounded number of D1 requests however many invites there are", async () => {
    const admin = await createUser(db, { beta: "unlocked", role: "admin" });
    const invites = new InviteAdminService({ db, keys, policy, now: () => clock });
    // Past two full scan pages, and every row carries an encrypted label, so the scan has to load
    // a key ring to decide whether it matches.
    await mint(invites, admin, 1_200, "September cohort");

    // `all` and `first` are one-statement batches, so batches are the D1 requests (§3.1).
    const batches = vi.spyOn(db, "batch");
    const requests = async (work: () => Promise<unknown>) => {
      batches.mockClear();
      await work();
      return batches.mock.calls.length;
    };

    // A search nothing matches is the worst case: the scan never fills a page and runs to its
    // budget. It reads the table in 500-row pages and loads one key ring for all of them; reading
    // 200 rows at a time and loading a ring per page cost about twenty requests for this table.
    expect(await requests(() => invites.list({ q: "nothing-matches-this" }))).toBeLessThanOrEqual(
      5,
    );
    // An unfiltered page reads once and loads one key ring for it.
    expect(await requests(() => invites.list({}))).toBeLessThanOrEqual(2);
    // A search that does match still costs the same bound: a label only matches once it has been
    // decrypted, so the scan cannot stop before it has read what its budget allows.
    const matching = await invites.list({ q: "september cohort" });
    expect(matching.items.length).toBeGreaterThan(0);
    expect(await requests(() => invites.list({ q: "september cohort" }))).toBeLessThanOrEqual(5);

    batches.mockRestore();
  });

  it("still reaches an invite past the first scan page, by hint and by encrypted label", async () => {
    const admin = await createUser(db, { beta: "unlocked", role: "admin" });
    const invites = new InviteAdminService({ db, keys, policy, now: () => clock });
    clock += 1;
    const oldest = await createInvite(invites, admin, { label: "The very first one" });
    const wanted = oldest.invites[0];
    await mint(invites, admin, 700);

    // The wanted invite is the oldest of 701, so it sits well past the first 500-row page.
    expect(
      (await invites.list({ q: wanted?.hint ?? "" })).items.map((invite) => invite.id),
    ).toEqual([wanted?.id]);
    // A label is encrypted, so it can only match after the scan has decrypted what it read.
    expect(
      (await invites.list({ q: "the very first one" })).items.map((invite) => invite.id),
    ).toEqual([wanted?.id]);
  });
});
