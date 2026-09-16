import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKeyProvider, zeroize } from "@symplist/crypto";
import { applyMigrations, createLocalSqliteClient, int, sql, uuidv7 } from "@symplist/db";
import { type OtpDelivery, OtpService } from "../access/otp.ts";
import { AccountKeyStore } from "../account/keys.ts";
import { VaultRepository } from "./context.ts";
import { VaultGrants } from "./grants.ts";
import { VaultItems } from "./items.ts";
import { VaultReset } from "./reset.ts";
import { VaultSessions } from "./sessions.ts";

export async function vaultFixture() {
  const dir = mkdtempSync(join(tmpdir(), "symplist-vault-"));
  const db = createLocalSqliteClient({ path: join(dir, "db.sqlite"), env: {} });
  await applyMigrations(db);
  const family = () => ({ current: 1, versions: new Map([[1, randomBytes(32)]]) });
  const keys = createKeyProvider({
    CONTENT_KEK: family(),
    VAULT_RECOVERY_KEY: family(),
    SESSION_DIGEST_SECRET: family(),
    OTP_DIGEST_SECRET: family(),
    IDEMPOTENCY_SECRET: family(),
  });
  const time = { now: Date.UTC(2026, 8, 16, 10) };
  const repository = new VaultRepository({
    db,
    keys,
    now: () => time.now,
    policy: { betaAccessRequired: true },
  });
  const sessions = new VaultSessions(repository);
  const items = new VaultItems(sessions);
  const grants = new VaultGrants(sessions);
  const mail: OtpDelivery[] = [];
  const otp = new OtpService({
    db,
    keys,
    now: () => time.now,
    codeLength: 6,
    ttlMinutes: 10,
    maxAttempts: 5,
    mailer: {
      send: async (delivery) => {
        mail.push(delivery);
      },
    },
  });
  const notices: string[] = [];
  const reset = new VaultReset(repository, otp, async (owner) => {
    notices.push(owner);
  });
  async function actor() {
    const userId = uuidv7(time.now);
    const sessionId = uuidv7(time.now);
    await db.batch([
      sql(
        `INSERT INTO users (id,email,email_verified_at,beta_state,onboarding_step,created_at,updated_at,write_id) VALUES (:id,:email,:now,'unlocked','done',:now,:now,:w)`,
        { id: userId, email: `${userId}@example.test`, now: int(time.now), w: uuidv7(time.now) },
      ),
      new AccountKeyStore({ db, keys }).provisionStatement({ userId, now: time.now }),
      sql(
        `INSERT INTO auth_sessions (id,user_id,token_digest,digest_version,created_at,last_seen_at,expires_at,write_id) VALUES (:id,:user,:digest,1,:now,:now,:expires,:w)`,
        {
          id: sessionId,
          user: userId,
          digest: randomBytes(32).toString("hex"),
          now: int(time.now),
          expires: int(time.now + 86400000),
          w: uuidv7(time.now),
        },
      ),
    ]);
    return { userId, sessionId };
  }
  async function task(ownerId: string) {
    const taskId = uuidv7(time.now),
      conversationId = uuidv7(time.now);
    await db.batch([
      sql(
        `INSERT INTO tasks (id,owner_id,collection,position,source,write_id,title_enc,created_at,updated_at) VALUES (:id,:owner,'now','a0','user',:w,'sym1.1.x.y',:now,:now)`,
        { id: taskId, owner: ownerId, w: uuidv7(time.now), now: int(time.now) },
      ),
      sql(
        `INSERT INTO conversations (id,owner_id,kind,task_id,created_at,updated_at,write_id) VALUES (:id,:owner,'task',:task,:now,:now,:w)`,
        {
          id: conversationId,
          owner: ownerId,
          task: taskId,
          now: int(time.now),
          w: uuidv7(time.now),
        },
      ),
    ]);
    return { taskId, conversationId };
  }
  async function key(ownerId: string) {
    return repository.accountKeys.require(ownerId);
  }
  return {
    db,
    keys,
    time,
    repository,
    sessions,
    items,
    grants,
    reset,
    otp,
    mail,
    notices,
    actor,
    task,
    key,
    close() {
      db.close();
      keys.destroy();
      rmSync(dir, { recursive: true, force: true });
    },
    zeroize,
  };
}
