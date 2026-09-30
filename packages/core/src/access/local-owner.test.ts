import { randomBytes } from "node:crypto";
import { createKeyProvider, keyFamilies, type ManagedKeyProvider } from "@symplist/crypto";
import {
  applyMigrations,
  createLocalSqliteClient,
  type DbRow,
  type LocalSqliteClient,
  sql,
} from "@symplist/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluateAccess } from "./evaluate.ts";
import { LOCAL_OWNER_EMAIL, LocalOwnerService } from "./local-owner.ts";
import { SessionStore } from "./sessions.ts";
import { accessStateFromRow } from "./sql.ts";

/**
 * The single owner of a local install.
 *
 * The claim worth testing is not that it works — it is that it works *through the ordinary rules*. A
 * local deployment has no OTP, no invite and no administrator, so the owner arrives verified and
 * onboarded; what must not happen is a special case inside `evaluateAccess`, the session store or any
 * guard, because that special case would be a cloud vulnerability one configuration mistake away.
 */
const now = 1_789_500_000_000;

let db: LocalSqliteClient;
let keys: ManagedKeyProvider;

beforeEach(async () => {
  const versions = new Map([[1, randomBytes(32)]]);
  keys = createKeyProvider(
    Object.fromEntries(keyFamilies.map((family) => [family, { current: 1, versions }])),
  );
  db = createLocalSqliteClient({ path: ":memory:" });
  await applyMigrations(db);
});

afterEach(() => {
  keys.destroy();
  db.close();
});

const service = () => new LocalOwnerService({ db, keys, now: () => now });

describe("the local owner (note 18)", () => {
  it("provisions one row that the ordinary access rules already admit", async () => {
    const userId = await service().ensure();
    const row = await db.first(
      sql(
        `SELECT email_verified_at, beta_state, suspended_at, onboarding_step, role, deletion_state,
           access_generation, access_epoch
         FROM users WHERE id = :id`,
        { id: userId },
      ),
    );
    expect(row).toMatchObject({
      beta_state: "unlocked",
      onboarding_step: "done",
      role: "admin",
      deletion_state: "none",
    });
    // The point: no bypass. The same function the cloud guards call says this account is admitted, and
    // an admin, with `BETA_ACCESS_REQUIRED` left on.
    const state = accessStateFromRow(row as DbRow);
    expect(evaluateAccess(state, "admitted", { betaAccessRequired: true }).allowed).toBe(true);
    expect(evaluateAccess(state, "admin", { betaAccessRequired: true }).allowed).toBe(true);
  });

  it("is idempotent, so it can run on every boot with no flag to get wrong", async () => {
    const first = await service().ensure();
    const second = await service().ensure();
    expect(second).toBe(first);
    const count = await db.first(sql("SELECT COUNT(*) AS n FROM users"));
    expect(Number(count?.n)).toBe(1);
  });

  it("provisions the account data key in the same call, not on the first write", async () => {
    // Every encrypted column depends on it. Creating it lazily would give the first task someone saves
    // a failure mode no other write has.
    const userId = await service().ensure();
    const key = await db.first(
      sql("SELECT owner_id FROM account_keys WHERE owner_id = :id", { id: userId }),
    );
    expect(key?.owner_id).toBe(userId);
  });

  it("gets an ordinary session from the ordinary session store", async () => {
    // No local-mode session type, no eternal token, no guard that knows which deployment it is in.
    const userId = await service().ensure();
    const sessions = new SessionStore({ db, keys });
    const created = await sessions.create({ userId, now });
    expect(created).not.toBeNull();
    const resolved = await sessions.resolve(created?.token ?? "", now);
    expect(resolved?.session.userId).toBe(userId);
  });

  it("uses an address that cannot resolve, so a misconfigured install cannot mail a real person", () => {
    expect(LOCAL_OWNER_EMAIL.endsWith(".invalid")).toBe(true);
  });

  it("answers null before it has run, so nothing mistakes an empty install for a provisioned one", async () => {
    expect(await service().userId()).toBeNull();
  });
});
