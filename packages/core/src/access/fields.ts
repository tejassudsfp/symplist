import type { AccountDataKey, FieldEnvelopeContext, KeyProvider } from "@symplist/crypto";
import { decryptFieldText, encryptFieldText, zeroize } from "@symplist/crypto";
import type { DbClient, DbRow, RequestPriority } from "@symplist/db";
import { sql } from "@symplist/db";
import { AccountKeyStore } from "../account/keys.ts";

/**
 * Encrypted access fields (§4.2, §4.4): display names under the account's own key, admin reasons and
 * grant reasons under the target account's key (unreadable once that account is deleted, §5.6), and
 * invite labels under the creating administrator's key.
 */

export function displayNameContext(userId: string): FieldEnvelopeContext {
  return Object.freeze({
    purpose: "display_name",
    ownerId: userId,
    table: "users",
    rowId: userId,
    column: "display_name_enc",
  });
}

export function inviteLabelContext(ownerId: string, inviteId: string): FieldEnvelopeContext {
  return Object.freeze({
    purpose: "invite_label",
    ownerId,
    table: "beta_invites",
    rowId: inviteId,
    column: "label_enc",
  });
}

export function adminReasonContext(ownerId: string, eventId: string): FieldEnvelopeContext {
  return Object.freeze({
    purpose: "admin_reason",
    ownerId,
    table: "beta_admin_events",
    rowId: eventId,
    column: "reason_enc",
  });
}

export function grantReasonContext(userId: string, grantId: string): FieldEnvelopeContext {
  return Object.freeze({
    purpose: "grant_reason",
    ownerId: userId,
    table: "beta_access_grants",
    rowId: grantId,
    column: "reason_enc",
  });
}

export function encryptText(key: AccountDataKey, context: FieldEnvelopeContext, text: string) {
  return encryptFieldText(key, context, text);
}

/** Decrypts a field or returns null when there is no key, no value, or the envelope does not open. */
export function decryptTextOrNull(
  key: AccountDataKey | undefined,
  context: FieldEnvelopeContext,
  envelope: unknown,
): string | null {
  if (!key || typeof envelope !== "string" || envelope.length === 0) return null;
  try {
    return decryptFieldText(key, context, envelope);
  } catch {
    return null;
  }
}

/**
 * Unwrapped account keys for several owners, read in one statement. Call {@link dispose} when done so
 * every key buffer is zeroised.
 */
export class KeyRing {
  private readonly keys = new Map<string, AccountDataKey>();

  get(ownerId: string | null | undefined): AccountDataKey | undefined {
    return ownerId ? this.keys.get(ownerId) : undefined;
  }

  add(key: AccountDataKey): void {
    const previous = this.keys.get(key.ownerId);
    if (previous) zeroize(previous.key);
    this.keys.set(key.ownerId, key);
  }

  dispose(): void {
    for (const key of this.keys.values()) zeroize(key.key);
    this.keys.clear();
  }
}

/** The statement that reads the key rows of up to 90 owners (D1's parameter limit, §3.2). */
export function keyRowsStatement(ownerIds: readonly string[]) {
  return sql(
    `SELECT owner_id, kek_version, wrapped_key FROM account_keys WHERE owner_id IN (:owners)`,
    { owners: [...ownerIds] },
  );
}

/** Unwraps key rows into a ring; rows that fail to unwrap are skipped (their fields read as null). */
export function keyRingFromRows(keys: KeyProvider, db: DbClient, rows: readonly DbRow[]): KeyRing {
  const store = new AccountKeyStore({ db, keys });
  const ring = new KeyRing();
  for (const row of rows) {
    try {
      ring.add(store.unwrapRow(row));
    } catch {
      // A key under a retired KEK version cannot be read; its fields show as unavailable.
    }
  }
  return ring;
}

/** Loads the keys of every distinct owner, 90 per statement, in one batch. */
export async function loadKeyRing(
  db: DbClient,
  keys: KeyProvider,
  ownerIds: Iterable<string | null | undefined>,
  priority?: RequestPriority,
): Promise<KeyRing> {
  const distinct = [...new Set([...ownerIds].filter((id): id is string => Boolean(id)))];
  if (distinct.length === 0) return new KeyRing();
  const statements = [];
  for (let offset = 0; offset < distinct.length; offset += 90) {
    statements.push(keyRowsStatement(distinct.slice(offset, offset + 90)));
  }
  const results = await db.batch(statements, priority ? { priority } : undefined);
  return keyRingFromRows(
    keys,
    db,
    results.flatMap((result) => result.results),
  );
}
