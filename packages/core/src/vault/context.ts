import type { AccountDataKey, KeyProvider } from "@symplist/crypto";
import { decryptFieldText, encryptFieldText, zeroize } from "@symplist/crypto";
import type { DbClient, DbRow, Statement, StatementResult } from "@symplist/db";
import { int, sql, uuidv7, verifiedRow } from "@symplist/db";
import type { AccessPolicy } from "../access/evaluate.ts";
import { accessCondition } from "../access/sql.ts";
import { AccountKeyStore } from "../account/keys.ts";

export class VaultError extends Error {
  constructor(
    readonly code: string,
    readonly retryAfter?: number,
  ) {
    super(code);
    this.name = "VaultError";
  }
}
export interface VaultActor {
  readonly userId: string;
  readonly sessionId: string;
}
export interface VaultOptions {
  readonly db: DbClient;
  readonly keys: KeyProvider;
  readonly now: () => number;
  readonly policy: AccessPolicy;
  readonly idleMinutes?: number;
  readonly minimumKeyLength?: number;
  readonly locked?: (ownerId: string, reason: "manual" | "reset") => Promise<void>;
}
export interface VaultGuard {
  readonly exists: string;
  readonly params: Readonly<Record<string, string>>;
}
/** Structurally compatible with the API's folded claim; no HTTP dependency in core. */
export interface VaultFold {
  readonly claim: { readonly guard: VaultGuard };
  readonly statements: readonly Statement[];
  completionStatement(response: { status: number; body: unknown }, key: AccountDataKey): Statement;
  decide(
    results: readonly StatementResult[],
    key: AccountDataKey,
    offset?: number,
  ): { kind: "started" } | { kind: "replay"; body: unknown };
}
export interface VaultContext {
  readonly actor: VaultActor;
  readonly key: AccountDataKey;
  readonly row: DbRow | null;
  readonly guard: VaultGuard;
  readonly now: number;
  readonly replay: { body: unknown } | null;
}
export class VaultRepository {
  readonly accountKeys: AccountKeyStore;
  constructor(readonly options: VaultOptions) {
    this.accountKeys = new AccountKeyStore(options);
  }
  get minimumKeyLength() {
    return this.options.minimumKeyLength ?? 12;
  }
  get idleMs() {
    return (this.options.idleMinutes ?? 5) * 60_000;
  }
  guard(actor: VaultActor, now = this.options.now()): VaultGuard {
    return {
      exists: `${accessCondition({ level: "admitted", policy: this.options.policy, userParam: "vault_owner" })}
        AND EXISTS (SELECT 1 FROM auth_sessions WHERE id = :vault_auth AND user_id = :vault_owner
          AND revoked_at IS NULL AND expires_at > CAST(:vault_now AS INTEGER))
        AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :vault_owner)`,
      params: { vault_owner: actor.userId, vault_auth: actor.sessionId, vault_now: int(now) },
    };
  }
  async context(actor: VaultActor, fold?: VaultFold): Promise<VaultContext> {
    const now = this.options.now();
    const guard = this.guard(actor, now);
    const results = await this.options.db.batch([
      sql(
        `SELECT a.* FROM account_keys a WHERE a.owner_id = :vault_owner AND ${guard.exists}`,
        guard.params,
      ),
      sql(`SELECT * FROM vaults WHERE owner_id = :vault_owner AND ${guard.exists}`, guard.params),
      ...(fold?.statements[1] ? [fold.statements[1]] : []),
    ]);
    const row = results[0]?.results[0];
    if (!row) throw new VaultError("vault.locked");
    const key = this.accountKeys.unwrapRow(row);
    let replay: { body: unknown } | null = null;
    try {
      if (fold && results[2]?.results[0]) {
        const decision = fold.decide(results, key, 1);
        if (decision.kind === "replay") replay = { body: decision.body };
      }
    } catch (error) {
      zeroize(key.key);
      throw error;
    }
    return {
      actor,
      key,
      row: results[1]?.results[0] ?? null,
      guard,
      now,
      replay,
    };
  }
  seal(key: AccountDataKey, table: string, rowId: string, column: string, value: string): string {
    return encryptFieldText(
      key,
      { ownerId: key.ownerId, purpose: "vault_wrapper", table, rowId, column },
      value,
    );
  }
  open(key: AccountDataKey, table: string, rowId: string, column: string, value: string): string {
    return decryptFieldText(
      key,
      { ownerId: key.ownerId, purpose: "vault_wrapper", table, rowId, column },
      value,
    );
  }
  assertPassphrase(passphrase: string) {
    if (
      passphrase.normalize("NFKC").length < this.minimumKeyLength ||
      Buffer.byteLength(passphrase.normalize("NFKC")) > 4096
    )
      throw new VaultError("vault.key_weak");
  }
  /** Effect and response commit together; no access-condition miss can record a success. */
  async mutate<T>(input: {
    context: VaultContext;
    fold?: VaultFold;
    body: T;
    status?: number;
    plan: (claim: VaultGuard, writeId: string) => { statements: Statement[]; effect: VaultGuard };
    failure?: string;
  }): Promise<{ body: T; replay: boolean }> {
    const { context, fold } = input;
    const writeId = uuidv7(context.now);
    const claim = fold?.claim.guard ?? { exists: "1 = 1", params: {} };
    const plan = input.plan(claim, writeId);
    const statements = [...(fold?.statements ?? []), ...plan.statements];
    const index = statements.length;
    statements.push(sql(`SELECT 1 AS applied WHERE ${plan.effect.exists}`, plan.effect.params));
    if (fold) {
      statements.push(
        fold.completionStatement({ status: input.status ?? 200, body: input.body }, context.key),
      );
      statements.push(
        sql(
          `DELETE FROM idempotency_records WHERE scope=:idem_scope AND user_id=:idem_user AND key=:idem_key AND write_id=:idem_write_id AND NOT (${plan.effect.exists})`,
          { ...claim.params, ...plan.effect.params },
        ),
      );
    }
    const results = await this.options.db.batch(statements);
    if (fold) {
      const decision = fold.decide(results, context.key, 0);
      if (decision.kind === "replay") return { body: decision.body as T, replay: true };
    }
    if (!verifiedRow(results, index)) throw new VaultError(input.failure ?? "vault.conflict");
    return { body: input.body, replay: false };
  }
}
export const disposeVaultContext = (context: VaultContext) => zeroize(context.key.key);
