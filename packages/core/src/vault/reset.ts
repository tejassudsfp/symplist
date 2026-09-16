import {
  createArgon2idParameters,
  deriveArgon2idKey,
  unwrapVaultKeyWithRecovery,
  wrapVaultKeyWithPassphrase,
  zeroize,
} from "@symplist/crypto";
import { int, sql, uuidv7, verifiedRow } from "@symplist/db";
import type { OtpService } from "../access/otp.ts";
import {
  disposeVaultContext,
  type VaultActor,
  VaultError,
  type VaultFold,
  type VaultRepository,
} from "./context.ts";

export class VaultReset {
  constructor(
    readonly repository: VaultRepository,
    readonly otp: Pick<OtpService, "sendForSession" | "verify">,
    readonly notify?: (ownerId: string, auditId: string) => Promise<void>,
  ) {}
  async sendCode(actor: VaultActor) {
    const context = await this.repository.context(actor);
    try {
      if (!context.row) throw new VaultError("vault.not_created");
      return await this.otp.sendForSession({ ...actor, purpose: "vault_reset" });
    } finally {
      disposeVaultContext(context);
    }
  }
  async verifyCode(actor: VaultActor, input: { challengeId: string; code: string }) {
    const context = await this.repository.context(actor);
    try {
      if (!context.row) throw new VaultError("vault.not_created");
      const version = Number(context.row.version);
      const result = await this.otp.verify({
        ...input,
        purposes: ["vault_reset"],
        binding: actor,
        success: ({ guard, now, challengeId }) => {
          const authorizationId = uuidv7(now);
          const w = uuidv7(now);
          const expiresAt = now + 600000;
          return {
            statements: [
              sql(
                `INSERT INTO vault_reset_authorizations (id,user_id,auth_session_id,challenge_id,vault_version,created_at,expires_at,consumed_at,write_id)
          SELECT :id,:user,:session,:challenge,:version,:now,:expires,NULL,:w WHERE ${guard.exists} AND ${context.guard.exists}
            AND EXISTS (SELECT 1 FROM vaults WHERE owner_id=:user AND version=CAST(:version AS INTEGER))`,
                {
                  ...guard.params,
                  ...context.guard.params,
                  id: authorizationId,
                  user: actor.userId,
                  session: actor.sessionId,
                  challenge: challengeId,
                  version: int(version),
                  now: int(now),
                  expires: int(expiresAt),
                  w,
                },
              ),
              sql("SELECT id FROM vault_reset_authorizations WHERE id=:id AND write_id=:w", {
                id: authorizationId,
                w,
              }),
            ],
            decide: (results, offset) => {
              if (!verifiedRow(results, offset + 1)) throw new VaultError("vault.reset_expired");
              return { authorizationId, expiresAt };
            },
          };
        },
      });
      return result.value;
    } finally {
      disposeVaultContext(context);
    }
  }
  async reset(
    actor: VaultActor,
    input: { authorizationId: string; passphrase: string },
    fold?: VaultFold,
  ) {
    const repo = this.repository;
    repo.assertPassphrase(input.passphrase);
    const context = await repo.context(actor, fold);
    let vaultKey: Uint8Array | undefined;
    let derived: Uint8Array | undefined;
    try {
      if (context.replay) return { status: "reset" };
      if (!context.row) throw new VaultError("vault.not_created");
      const version = Number(context.row.version);
      const nextVersion = version + 1;
      // Refuse before Argon2 or recovery unwrap; the final deciding update repeats this condition.
      const auth = `EXISTS (SELECT 1 FROM vault_reset_authorizations WHERE id=:authorization AND user_id=:owner AND auth_session_id=:auth AND vault_version=CAST(:version AS INTEGER) AND consumed_at IS NULL AND expires_at>CAST(:now AS INTEGER))`;
      const params = {
        owner: actor.userId,
        auth: actor.sessionId,
        authorization: input.authorizationId,
        version: int(version),
        now: int(context.now),
      };
      const valid = await repo.options.db.first(
        sql(`SELECT 1 AS valid WHERE ${auth} AND ${context.guard.exists}`, {
          ...params,
          ...context.guard.params,
        }),
      );
      if (!valid) throw new VaultError("vault.reset_expired");
      vaultKey = unwrapVaultKeyWithRecovery(repo.options.keys, actor.userId, {
        recoveryKeyVersion: Number(context.row.recovery_version),
        wrapped: repo.open(
          context.key,
          "vaults",
          actor.userId,
          "recovery_wrap_enc",
          String(context.row.recovery_wrap_enc),
        ),
      });
      const parameters = createArgon2idParameters();
      derived = await deriveArgon2idKey(input.passphrase, parameters);
      const wrapped = wrapVaultKeyWithPassphrase(
        derived,
        { ownerId: actor.userId, vaultVersion: nextVersion },
        vaultKey,
      );
      const auditId = uuidv7(context.now);
      const result = await repo.mutate({
        context,
        ...(fold ? { fold } : {}),
        body: { status: "reset" },
        failure: "vault.reset_expired",
        plan: (claim, w) => {
          const effect = {
            exists: "EXISTS (SELECT 1 FROM vaults WHERE owner_id=:owner AND write_id=:w)",
            params: { owner: actor.userId, w },
          };
          return {
            effect,
            statements: [
              sql(
                `UPDATE vaults SET version=version+1,parameters=:parameters,pass_wrap_enc=:wrap,updated_at=:now,write_id=:w WHERE owner_id=:owner AND version=CAST(:version AS INTEGER) AND ${auth} AND ${context.guard.exists} AND ${claim.exists}`,
                {
                  ...params,
                  now: int(repo.options.now()),
                  ...context.guard.params,
                  ...claim.params,
                  ...effect.params,
                  parameters: JSON.stringify(parameters),
                  wrap: repo.seal(context.key, "vaults", actor.userId, "pass_wrap_enc", wrapped),
                },
              ),
              sql(
                `UPDATE vault_reset_authorizations SET consumed_at=:now,write_id=:w WHERE id=:authorization AND ${effect.exists}`,
                { ...effect.params, authorization: input.authorizationId, now: int(context.now) },
              ),
              sql(
                `UPDATE vault_sessions SET revoked_at=:now,write_id=:w WHERE owner_id=:owner AND revoked_at IS NULL AND ${effect.exists}`,
                { ...effect.params, now: int(context.now) },
              ),
              sql(
                `UPDATE vault_grants SET status='revoked',value_enc=NULL,write_id=:w WHERE owner_id=:owner AND status='active' AND ${effect.exists}`,
                effect.params,
              ),
              sql(
                `INSERT INTO vault_audit (id,owner_id,action,vault_version,created_at,notification_sent_at) SELECT :id,:owner,'key_reset',:version,:now,NULL WHERE ${effect.exists}`,
                { ...effect.params, id: auditId, version: int(nextVersion), now: int(context.now) },
              ),
            ],
          };
        },
      });
      if (!result.replay) {
        await repo.options.locked?.(actor.userId, "reset");
        await this.notify?.(actor.userId, auditId).catch(() => undefined);
      }
      return result.body;
    } finally {
      if (vaultKey) zeroize(vaultKey);
      if (derived) zeroize(derived);
      disposeVaultContext(context);
    }
  }
}
