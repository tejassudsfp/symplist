import { type AccountDataKey, type KeyProvider, unwrapAccountKey } from "@symplist/crypto";
import { type DbClient, sql } from "@symplist/db";

/**
 * Loads and unwraps an account data key from `account_keys` (§4.1). A missing row (a shredded or
 * unknown account) returns null. Callers zeroise `key.key` when they drop it.
 */
export class AccountKeyReader {
  constructor(
    private readonly db: DbClient,
    private readonly keys: KeyProvider,
  ) {}

  async load(ownerId: string): Promise<AccountDataKey | null> {
    const row = await this.db.first(
      sql("SELECT kek_version, wrapped_key FROM account_keys WHERE owner_id = :owner", {
        owner: ownerId,
      }),
    );
    if (!row) return null;
    return unwrapAccountKey(this.keys, {
      ownerId,
      kekVersion: Number(row.kek_version),
      wrapped: String(row.wrapped_key),
    });
  }
}
