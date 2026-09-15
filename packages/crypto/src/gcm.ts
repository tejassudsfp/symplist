import { createCipheriv, createDecipheriv } from "node:crypto";
import {
  base64UrlLength,
  decodeBase64Url,
  drawRandom,
  encodeBase64Url,
  type RandomOptions,
  zeroize,
} from "./encoding.ts";
import {
  DecryptionFailedError,
  InvalidCryptoInputError,
  MalformedEnvelopeError,
} from "./errors.ts";

/** AES-256 key length. */
export const AES_KEY_BYTES = 32;
/** GCM IV length (96 bits, §4.1). */
export const GCM_IV_BYTES = 12;
/** GCM tag length (128 bits, §4.1). */
export const GCM_TAG_BYTES = 16;
/** A wrapped 32-byte key: IV, encrypted key and tag. */
export const WRAPPED_KEY_BYTES = GCM_IV_BYTES + AES_KEY_BYTES + GCM_TAG_BYTES;
/** base64url length of a wrapped key (80 characters). */
export const WRAPPED_KEY_LENGTH = base64UrlLength(WRAPPED_KEY_BYTES);

const algorithm = "aes-256-gcm";

function assertKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.byteLength !== AES_KEY_BYTES) {
    throw new InvalidCryptoInputError(`AES-256-GCM keys must be ${AES_KEY_BYTES} bytes`);
  }
}

/** AES-256-GCM encryption; returns ciphertext followed by the 16-byte tag. */
export function sealAesGcm(
  key: Uint8Array,
  iv: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Buffer {
  assertKey(key);
  if (iv.byteLength !== GCM_IV_BYTES) {
    throw new InvalidCryptoInputError(`GCM IVs must be ${GCM_IV_BYTES} bytes`);
  }
  const cipher = createCipheriv(algorithm, key, iv, { authTagLength: GCM_TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = cipher.update(plaintext);
  const final = cipher.final();
  return Buffer.concat([ciphertext, final, cipher.getAuthTag()]);
}

/**
 * AES-256-GCM decryption of `ciphertext || tag`. Authentication failure throws
 * `DecryptionFailedError` and zeroises the unauthenticated output, so no partial plaintext escapes.
 */
export function openAesGcm(
  key: Uint8Array,
  iv: Uint8Array,
  ciphertextAndTag: Uint8Array,
  aad: Uint8Array,
  what: string,
): Buffer {
  assertKey(key);
  if (iv.byteLength !== GCM_IV_BYTES || ciphertextAndTag.byteLength < GCM_TAG_BYTES) {
    throw new MalformedEnvelopeError(what);
  }
  const split = ciphertextAndTag.byteLength - GCM_TAG_BYTES;
  const decipher = createDecipheriv(algorithm, key, iv, { authTagLength: GCM_TAG_BYTES });
  decipher.setAAD(aad);
  decipher.setAuthTag(ciphertextAndTag.subarray(split));
  let plaintext: Buffer | undefined;
  try {
    plaintext = decipher.update(ciphertextAndTag.subarray(0, split));
    decipher.final();
    return plaintext;
  } catch {
    zeroize(plaintext);
    throw new DecryptionFailedError(what);
  }
}

/** Wraps a 32-byte key as base64url(IV || encrypted key || tag) with a fresh IV. */
export function wrapKey(
  wrappingKey: Uint8Array,
  keyToWrap: Uint8Array,
  aad: Uint8Array,
  options?: RandomOptions,
): string {
  assertKey(keyToWrap);
  const iv = drawRandom(options, GCM_IV_BYTES);
  return encodeBase64Url(Buffer.concat([iv, sealAesGcm(wrappingKey, iv, keyToWrap, aad)]));
}

/** Unwraps a key produced by {@link wrapKey}; any mismatch fails without output. */
export function unwrapKey(
  wrappingKey: Uint8Array,
  wrapped: string,
  aad: Uint8Array,
  what: string,
): Buffer {
  if (typeof wrapped !== "string" || wrapped.length !== WRAPPED_KEY_LENGTH) {
    throw new MalformedEnvelopeError(what);
  }
  const bytes = decodeBase64Url(wrapped, WRAPPED_KEY_BYTES);
  if (!bytes) throw new MalformedEnvelopeError(what);
  try {
    return openAesGcm(
      wrappingKey,
      bytes.subarray(0, GCM_IV_BYTES),
      bytes.subarray(GCM_IV_BYTES),
      aad,
      what,
    );
  } finally {
    zeroize(bytes);
  }
}
