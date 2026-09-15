import type { AccountDataKey, KeyProvider, RandomOptions } from "@symplist/crypto";
import { createAccountKey, unwrapAccountKey, zeroize } from "@symplist/crypto";
import type { DbClient, DbRow, Statement } from "@symplist/db";
import { int, sql, uuidv7 } from "@symplist/db";

/** Thrown when an account has no key row: it was never provisioned or it was crypto-shredded (§5.6). */
export class AccountKeyUnavailableError extends Error {
  readonly code = "account.key_unavailable";
  constructor() {
    super("The account data key is unavailable");
    this.name = "AccountKeyUnavailableError";
  }
}

export interface AccountKeyStoreOptions {
  readonly db: DbClient;
  readonly keys: KeyProvider;
  readonly random?: RandomOptions;
}

function wrappedFromRow(row: DbRow) {
  const { owner_id: ownerId, kek_version: kekVersion, wrapped_key: wrapped } = row;
  if (typeof ownerId !== "string" || typeof wrapped !== "string") {
    throw new Error("Unexpected account_keys row");
  }
  if (typeof kekVersion !== "number" || !Number.isSafeInteger(kekVersion)) {
    throw new Error("Unexpected account_keys row");
  }
  return { ownerId, kekVersion, wrapped };
}

/**
 * Account data keys (§4.1): a random 32-byte key per account, wrapped under the current
 * `CONTENT_KEK` and stored in `account_keys`. Provisioning is idempotent: the first wrap for an
 * account wins and later provisioning attempts leave it untouched, so every envelope ever written for
 * the account stays decryptable until the deletion batch shreds the row.
 */
export class AccountKeyStore {
  private readonly db: DbClient;
  private readonly keys: KeyProvider;
  private readonly random: RandomOptions | undefined;

  constructor(options: AccountKeyStoreOptions) {
    this.db = options.db;
    this.keys = options.keys;
    this.random = options.random;
  }

  /**
   * The statement that provisions the account's key. Fold it into the batch that creates the users
   * row, after the insert: it only writes while the user exists, is not being deleted, and has no key
   * row yet. An account in `deletion_state = 'deleting'` never gets a new key, so nothing can be
   * encrypted for it after the crypto-shred (§5.6). The raw key is zeroized before this returns; only
   * the wrap is bound as a parameter.
   */
  provisionStatement(input: { readonly userId: string; readonly now: number }): Statement {
    const created = createAccountKey(this.keys, input.userId, this.random);
    try {
      return sql(
        `INSERT INTO account_keys (owner_id, kek_version, wrapped_key, created_at, updated_at, write_id)
         SELECT :owner, :kek, :wrapped, :now, :now, :w
         WHERE EXISTS (SELECT 1 FROM users WHERE id = :owner AND deletion_state = 'none')
         ON CONFLICT (owner_id) DO NOTHING`,
        {
          owner: input.userId,
          kek: int(created.wrapped.kekVersion),
          wrapped: created.wrapped.wrapped,
          now: int(input.now),
          w: uuidv7(input.now),
        },
      );
    } finally {
      zeroize(created.key.key);
    }
  }

  /** Reads the key row of an account. */
  selectStatement(userId: string): Statement {
    return sql(
      `SELECT owner_id, kek_version, wrapped_key FROM account_keys WHERE owner_id = :owner`,
      { owner: userId },
    );
  }

  /** Unwraps a row returned by {@link selectStatement}. The caller zeroizes `key` when done. */
  unwrapRow(row: DbRow): AccountDataKey {
    return unwrapAccountKey(this.keys, wrappedFromRow(row));
  }

  /**
   * Provisions the key if the account has none and returns it, in one batch. Throws
   * {@link AccountKeyUnavailableError} when the user does not exist or the key was shredded.
   */
  async ensure(input: { readonly userId: string; readonly now: number }): Promise<AccountDataKey> {
    const results = await this.db.batch([
      this.provisionStatement(input),
      this.selectStatement(input.userId),
    ]);
    const row = results[1]?.results[0];
    if (!row) throw new AccountKeyUnavailableError();
    return this.unwrapRow(row);
  }

  /** The account's data key, or null when the account has no key row (never provisioned or shredded). */
  async load(userId: string): Promise<AccountDataKey | null> {
    const row = await this.db.first(this.selectStatement(userId));
    return row ? this.unwrapRow(row) : null;
  }

  /** Like {@link load}, but throws {@link AccountKeyUnavailableError} when the key row is missing. */
  async require(userId: string): Promise<AccountDataKey> {
    const key = await this.load(userId);
    if (!key) throw new AccountKeyUnavailableError();
    return key;
  }
}
