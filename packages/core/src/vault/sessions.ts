import type { VaultStatus } from "@symplist/contracts";
import {
  computeDigest,
  computeDigestCandidates,
  createArgon2idParameters,
  deriveArgon2idKey,
  generateToken,
  generateVaultKey,
  parseArgon2idParameters,
  unwrapVaultKeyForSession,
  unwrapVaultKeyWithPassphrase,
  wrapVaultKeyForRecovery,
  wrapVaultKeyForSession,
  wrapVaultKeyWithPassphrase,
  zeroize,
} from "@symplist/crypto";
import { int, type Statement, sql, uuidv7 } from "@symplist/db";
import {
  disposeVaultContext,
  type VaultActor,
  type VaultContext,
  VaultError,
  type VaultFold,
  type VaultGuard,
  type VaultRepository,
} from "./context.ts";

export interface OpenVault {
  context: VaultContext;
  vaultKey: Uint8Array;
  sessionId: string;
  guard: VaultGuard;
  idleExpiresAt: number;
}
export function disposeOpenVault(open: OpenVault) {
  zeroize(open.vaultKey);
  disposeVaultContext(open.context);
}
export class VaultSessions {
  constructor(readonly repository: VaultRepository) {}
  async setup(actor: VaultActor, passphrase: string, fold?: VaultFold) {
    const repo = this.repository;
    repo.assertPassphrase(passphrase);
    const context = await repo.context(actor, fold);
    const vaultKey = generateVaultKey();
    let derived: Uint8Array | undefined;
    try {
      if (context.replay) return { status: "created", token: null };
      const parameters = createArgon2idParameters();
      derived = await deriveArgon2idKey(passphrase, parameters);
      const pass = wrapVaultKeyWithPassphrase(
        derived,
        { ownerId: actor.userId, vaultVersion: 1 },
        vaultKey,
      );
      const recovery = wrapVaultKeyForRecovery(repo.options.keys, actor.userId, vaultKey);
      const issued = this.session(context, vaultKey, 1);
      const result = await repo.mutate({
        context,
        ...(fold ? { fold } : {}),
        body: { status: "created" },
        failure: "vault.already_created",
        plan: (claim, writeId) => {
          const effect = {
            exists: "EXISTS (SELECT 1 FROM vaults WHERE owner_id = :owner AND write_id = :w)",
            params: { owner: actor.userId, w: writeId },
          };
          return {
            effect,
            statements: [
              sql(
                `INSERT INTO vaults (owner_id,version,parameters,pass_wrap_enc,recovery_wrap_enc,recovery_version,created_at,updated_at,write_id)
          SELECT :owner,1,:parameters,:pass,:recovery,:recovery_version,:now,:now,:w WHERE ${context.guard.exists} AND ${claim.exists} ON CONFLICT DO NOTHING`,
                {
                  ...context.guard.params,
                  ...claim.params,
                  ...effect.params,
                  parameters: JSON.stringify(parameters),
                  pass: repo.seal(context.key, "vaults", actor.userId, "pass_wrap_enc", pass),
                  recovery: repo.seal(
                    context.key,
                    "vaults",
                    actor.userId,
                    "recovery_wrap_enc",
                    recovery.wrapped,
                  ),
                  recovery_version: int(recovery.recoveryKeyVersion),
                  now: int(context.now),
                },
              ),
              issued.statement(effect),
            ],
          };
        },
      });
      return { ...result.body, token: result.replay ? null : issued.token };
    } finally {
      if (derived) zeroize(derived);
      zeroize(vaultKey);
      disposeVaultContext(context);
    }
  }
  private session(context: VaultContext, vaultKey: Uint8Array, version: number) {
    const { actor, now } = context;
    const repo = this.repository;
    const id = uuidv7(now);
    const token = generateToken();
    const digest = computeDigest(
      repo.options.keys,
      "SESSION_DIGEST_SECRET",
      "vault-session",
      token,
    );
    const wrapped = wrapVaultKeyForSession(
      token,
      { ownerId: actor.userId, vaultSessionId: id },
      vaultKey,
    );
    return {
      token,
      id,
      statement: (guard: VaultGuard): Statement =>
        sql(
          `INSERT INTO vault_sessions
      (id,owner_id,auth_session_id,token_digest,digest_version,key_wrap_enc,vault_version,created_at,last_used_at,expires_at,revoked_at,write_id)
      SELECT :id,:owner,:auth,:digest,:dv,:wrapped,:version,:now,:now,:expires,NULL,:session_write WHERE ${guard.exists}`,
          {
            ...guard.params,
            id,
            owner: actor.userId,
            auth: actor.sessionId,
            digest: digest.digest,
            dv: int(digest.version),
            wrapped: repo.seal(context.key, "vault_sessions", id, "key_wrap_enc", wrapped),
            version: int(version),
            now: int(now),
            expires: int(now + 3600000),
            session_write: uuidv7(now),
          },
        ),
    };
  }
  async unlock(actor: VaultActor, passphrase: string, fold?: VaultFold) {
    const repo = this.repository;
    const context = await repo.context(actor, fold);
    let derived: Uint8Array | undefined;
    let vaultKey: Uint8Array | undefined;
    try {
      if (context.replay) return { status: "unlocked", token: null };
      if (!context.row) throw new VaultError("vault.not_created");
      // Reserve a failure before expensive work. Success refunds only its own reservation; concurrent
      // guesses therefore cannot run beyond the durable limit, including across process restarts.
      const reservation = uuidv7(context.now);
      const params = {
        ...context.guard.params,
        owner: actor.userId,
        now: int(context.now),
        w: reservation,
      };
      const rows = await repo.options.db.batch([
        sql(
          `INSERT INTO vault_unlock_limits (owner_id,window_start,failures,day_start,day_failures,locked_until,write_id)
          SELECT :owner,:now,0,:now,0,0,:w WHERE ${context.guard.exists} ON CONFLICT DO NOTHING`,
          { ...params, w: uuidv7(context.now) },
        ),
        sql(
          `UPDATE vault_unlock_limits SET failures=CASE WHEN window_start+900000 <= CAST(:now AS INTEGER) THEN 0 ELSE failures END,
          window_start=CASE WHEN window_start+900000 <= CAST(:now AS INTEGER) THEN CAST(:now AS INTEGER) ELSE window_start END,
          day_failures=CASE WHEN day_start+86400000 <= CAST(:now AS INTEGER) THEN 0 ELSE day_failures END,
          day_start=CASE WHEN day_start+86400000 <= CAST(:now AS INTEGER) THEN CAST(:now AS INTEGER) ELSE day_start END, write_id=:w
          WHERE owner_id=:owner AND locked_until <= CAST(:now AS INTEGER) AND ${context.guard.exists}`,
          { ...params, w: uuidv7(context.now) },
        ),
        sql(
          `UPDATE vault_unlock_limits SET failures=failures+1,day_failures=day_failures+1,
          locked_until=CASE WHEN failures+1 >= 5 THEN CAST(:now AS INTEGER)+900000 ELSE locked_until END,write_id=:w
          WHERE owner_id=:owner AND failures<5 AND day_failures<20 AND locked_until <= CAST(:now AS INTEGER) AND ${context.guard.exists}`,
          params,
        ),
        sql(
          `SELECT failures,day_failures,locked_until FROM vault_unlock_limits WHERE owner_id=:owner AND write_id=:w AND failures>0`,
          { owner: actor.userId, w: reservation },
        ),
      ]);
      // The reset/insert use distinct write ids so this SELECT must prove the reservation update.
      const reserved = rows[2];
      if (!reserved || !rows[3]?.results[0]) throw new VaultError("vault.throttled", 900);
      derived = await deriveArgon2idKey(
        passphrase,
        parseArgon2idParameters(JSON.parse(String(context.row.parameters))),
      );
      try {
        vaultKey = unwrapVaultKeyWithPassphrase(
          derived,
          { ownerId: actor.userId, vaultVersion: Number(context.row.version) },
          repo.open(
            context.key,
            "vaults",
            actor.userId,
            "pass_wrap_enc",
            String(context.row.pass_wrap_enc),
          ),
        );
      } catch {
        throw new VaultError("vault.incorrect_key");
      }
      const issued = this.session(context, vaultKey, Number(context.row.version));
      const result = await repo.mutate({
        context,
        ...(fold ? { fold } : {}),
        body: { status: "unlocked" },
        failure: "vault.locked",
        plan: (claim, writeId) => {
          const effect = {
            exists: "EXISTS (SELECT 1 FROM vault_sessions WHERE id=:session AND write_id=:write)",
            params: { session: issued.id, write: writeId },
          };
          const guard = {
            exists: `${context.guard.exists} AND ${claim.exists} AND EXISTS (SELECT 1 FROM vaults WHERE owner_id=:owner AND version=CAST(:version AS INTEGER))`,
            params: {
              ...context.guard.params,
              ...claim.params,
              owner: actor.userId,
              version: int(Number(context.row?.version)),
            },
          };
          return {
            effect,
            statements: [
              issued.statement(guard),
              sql(`UPDATE vault_sessions SET write_id=:write WHERE id=:session`, effect.params),
              sql(
                `UPDATE vault_unlock_limits SET failures=MAX(0,failures-1),day_failures=MAX(0,day_failures-1),locked_until=CASE WHEN failures<=5 THEN 0 ELSE locked_until END,write_id=:w WHERE owner_id=:owner AND ${effect.exists}`,
                { ...effect.params, owner: actor.userId, w: uuidv7(context.now) },
              ),
            ],
          };
        },
      });
      return { ...result.body, token: result.replay ? null : issued.token };
    } finally {
      if (derived) zeroize(derived);
      if (vaultKey) zeroize(vaultKey);
      disposeVaultContext(context);
    }
  }
  async open(
    actor: VaultActor,
    token: string | undefined,
    touch = true,
    fold?: VaultFold,
  ): Promise<OpenVault> {
    const repo = this.repository;
    const context = await repo.context(actor, fold);
    try {
      if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new VaultError("vault.locked");
      const digests = computeDigestCandidates(
        repo.options.keys,
        "SESSION_DIGEST_SECRET",
        "vault-session",
        token,
      ).map((d) => d.digest);
      const guard = repo.guard(actor);
      const params = { ...guard.params, digests, idle: int(repo.idleMs) };
      const condition = `owner_id=:vault_owner AND auth_session_id=:vault_auth AND token_digest IN (:digests) AND revoked_at IS NULL
        AND expires_at>CAST(:vault_now AS INTEGER) AND last_used_at+CAST(:idle AS INTEGER)>CAST(:vault_now AS INTEGER)
        AND vault_version=(SELECT version FROM vaults WHERE owner_id=:vault_owner) AND ${guard.exists}`;
      const writeId = uuidv7(context.now);
      const statements = touch
        ? [
            sql(
              `UPDATE vault_sessions SET last_used_at=:vault_now,write_id=:w WHERE ${condition}`,
              { ...params, w: writeId },
            ),
          ]
        : [];
      statements.push(
        sql(`SELECT * FROM vault_sessions WHERE ${condition}${touch ? " AND write_id=:w" : ""}`, {
          ...params,
          ...(touch ? { w: writeId } : {}),
        }),
      );
      const row = (await repo.options.db.batch(statements)).at(-1)?.results[0];
      if (!row) throw new VaultError("vault.locked");
      const id = String(row.id);
      const wrapped = repo.open(
        context.key,
        "vault_sessions",
        id,
        "key_wrap_enc",
        String(row.key_wrap_enc),
      );
      const vaultKey = unwrapVaultKeyForSession(
        token,
        { ownerId: actor.userId, vaultSessionId: id },
        wrapped,
      );
      return {
        context,
        vaultKey,
        sessionId: id,
        idleExpiresAt: Math.min(Number(row.last_used_at) + repo.idleMs, Number(row.expires_at)),
        guard: {
          exists: `${guard.exists} AND EXISTS (SELECT 1 FROM vault_sessions WHERE id=:open_session AND owner_id=:vault_owner AND auth_session_id=:vault_auth AND revoked_at IS NULL AND expires_at>CAST(:vault_now AS INTEGER) AND last_used_at+CAST(:open_idle AS INTEGER)>CAST(:vault_now AS INTEGER) AND vault_version=(SELECT version FROM vaults WHERE owner_id=:vault_owner))`,
          params: { ...guard.params, open_session: id, open_idle: int(repo.idleMs) },
        },
      };
    } catch (error) {
      disposeVaultContext(context);
      throw error;
    }
  }
  async status(actor: VaultActor, token?: string): Promise<VaultStatus> {
    const context = await this.repository.context(actor);
    const exists = context.row !== null;
    disposeVaultContext(context);
    if (!exists)
      return {
        state: "not_created",
        minimumKeyLength: this.repository.minimumKeyLength,
        idleExpiresAt: null,
      };
    try {
      const open = await this.open(actor, token, false);
      try {
        return {
          state: "unlocked",
          minimumKeyLength: this.repository.minimumKeyLength,
          idleExpiresAt: open.idleExpiresAt,
        };
      } finally {
        disposeOpenVault(open);
      }
    } catch (error) {
      if (!(error instanceof VaultError) || error.code !== "vault.locked") throw error;
      return {
        state: "locked",
        minimumKeyLength: this.repository.minimumKeyLength,
        idleExpiresAt: null,
      };
    }
  }
  async lock(actor: VaultActor, token?: string) {
    if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) {
      const digests = computeDigestCandidates(
        this.repository.options.keys,
        "SESSION_DIGEST_SECRET",
        "vault-session",
        token,
      ).map((d) => d.digest);
      await this.repository.options.db.run(
        sql(
          `UPDATE vault_sessions SET revoked_at=:now,write_id=:w WHERE owner_id=:owner AND auth_session_id=:auth AND token_digest IN (:digests) AND revoked_at IS NULL`,
          {
            now: int(this.repository.options.now()),
            w: uuidv7(),
            owner: actor.userId,
            auth: actor.sessionId,
            digests,
          },
        ),
      );
    }
    await this.repository.options.locked?.(actor.userId, "manual");
    return { status: "locked" };
  }
}
