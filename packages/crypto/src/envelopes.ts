import { NotImplementedError } from "./errors.ts";
import type { AccountDataKey, KeyProvider, WrappedAccountKey } from "./keys.ts";

/** Binding for a field envelope (`sym1`); every field enters the frozen AAD (§4.2). */
export interface FieldEnvelopeContext {
  /** For example `title`, `run_chunk` or `idempotency_response`. */
  readonly purpose: string;
  readonly ownerId: string;
  readonly table: string;
  readonly rowId: string;
  readonly column: string;
}

/** Binding for an R2 object envelope (`symo1`, §4.1, §4.2). */
export interface ObjectEnvelopeContext {
  /** For example `bundle`, `doc_snapshot`, `search_index` or `artifact`. */
  readonly kind: string;
  readonly ownerId: string;
  readonly objectId: string;
  readonly formatVersion: number;
}

/** Canonical AAD bytes: UTF-8 JSON with sorted keys and no whitespace (§4.2). */
export function encodeAad(_fields: Readonly<Record<string, string | number>>): Uint8Array {
  throw new NotImplementedError("crypto.encodeAad");
}

/** Encrypts a `_enc` column value as `sym1.<keyVersion>.<iv>.<ciphertext+tag>`. */
export function encryptField(
  _key: AccountDataKey,
  _context: FieldEnvelopeContext,
  _plaintext: Uint8Array,
): string {
  throw new NotImplementedError("crypto.encryptField");
}

/** Decrypts a field envelope; fails without plaintext output on any binding mismatch. */
export function decryptField(
  _key: AccountDataKey,
  _context: FieldEnvelopeContext,
  _envelope: string,
): Uint8Array {
  throw new NotImplementedError("crypto.decryptField");
}

/** Encrypts an object as `SYMO` magic, version, header length, JSON header, ciphertext and tag. */
export function encryptObject(
  _key: AccountDataKey,
  _context: ObjectEnvelopeContext,
  _plaintext: Uint8Array,
): Uint8Array {
  throw new NotImplementedError("crypto.encryptObject");
}

/** Decrypts an object envelope; truncated or swapped objects fail without plaintext output. */
export function decryptObject(
  _key: AccountDataKey,
  _context: ObjectEnvelopeContext,
  _envelope: Uint8Array,
): Uint8Array {
  throw new NotImplementedError("crypto.decryptObject");
}

/** Creates and wraps a new random account data key under the current `CONTENT_KEK`. */
export function createAccountKey(
  _keys: KeyProvider,
  _ownerId: string,
): {
  key: AccountDataKey;
  wrapped: WrappedAccountKey;
} {
  throw new NotImplementedError("crypto.createAccountKey");
}

/** Unwraps an account data key with the `CONTENT_KEK` version recorded on the row. */
export function unwrapAccountKey(_keys: KeyProvider, _wrapped: WrappedAccountKey): AccountDataKey {
  throw new NotImplementedError("crypto.unwrapAccountKey");
}
