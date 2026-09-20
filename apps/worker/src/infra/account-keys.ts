import { type AccountDataKey, type KeyProvider, unwrapAccountKey } from "@symplist/crypto";
import { type DbClient, sql } from "@symplist/db";
import { WorkerError, withMappedErrors } from "./errors.ts";

/**
 * Loads and unwraps an owner's account data key (§4.1). A missing row means the account was
 * crypto-shredded (§5.6): the run cannot continue and fails with `account.key_missing`.
 */
export async function loadAccountKey(
  db: DbClient,
  keys: KeyProvider,
  ownerId: string,
): Promise<AccountDataKey> {
  return withMappedErrors(async () => {
    const row = await db.first(
      sql("SELECT kek_version, wrapped_key FROM account_keys WHERE owner_id = :owner", {
        owner: ownerId,
      }),
    );
    if (!row) throw new WorkerError("account.key_missing");
    return unwrapAccountKey(keys, {
      ownerId,
      kekVersion: Number(row.kek_version),
      wrapped: String(row.wrapped_key),
    });
  });
}
