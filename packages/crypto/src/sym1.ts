import { FIELD_FORMAT } from "./aad.ts";
import {
  base64UrlLength,
  decodeBase64Url,
  drawRandom,
  encodeBase64Url,
  type RandomOptions,
} from "./encoding.ts";
import {
  InputTooLargeError,
  InvalidCryptoInputError,
  MalformedEnvelopeError,
  UnsupportedKeyVersionError,
} from "./errors.ts";
import { GCM_IV_BYTES, GCM_TAG_BYTES, openAesGcm, sealAesGcm } from "./gcm.ts";

/**
 * The data key version written into envelopes (§4.1, §4.2). Each account has exactly one account data
 * key and each Vault one data key, so every envelope in this format generation carries version 1.
 * `CONTENT_KEK` rotation re-wraps the account data key and never changes this version; decryption
 * rejects any other version before touching the ciphertext.
 */
export const DATA_KEY_VERSION = 1;

/** Largest plaintext accepted in a `sym1` envelope (1 MiB), so envelopes stay under D1's 2 MB value limit. */
export const MAX_FIELD_PLAINTEXT_BYTES = 1024 * 1024;

const maxVersionDigits = 9;

/** Longest `sym1` envelope text accepted for decryption. */
export const MAX_FIELD_ENVELOPE_LENGTH =
  FIELD_FORMAT.length +
  1 +
  maxVersionDigits +
  1 +
  base64UrlLength(GCM_IV_BYTES) +
  1 +
  base64UrlLength(MAX_FIELD_PLAINTEXT_BYTES + GCM_TAG_BYTES);

const envelopePattern = /^sym1\.([1-9][0-9]{0,8})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22,})$/;

/** Encrypts into `sym1.<keyVersion>.<iv>.<ciphertext+tag>` with the given AAD. */
export function sealSym1(
  key: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
  what: string,
  options?: RandomOptions,
): string {
  if (!(plaintext instanceof Uint8Array)) {
    throw new InvalidCryptoInputError(`${what} plaintext must be bytes`);
  }
  if (plaintext.byteLength > MAX_FIELD_PLAINTEXT_BYTES) {
    throw new InputTooLargeError(`${what} plaintext`, MAX_FIELD_PLAINTEXT_BYTES);
  }
  const iv = drawRandom(options, GCM_IV_BYTES);
  const sealed = sealAesGcm(key, iv, plaintext, aad);
  return `${FIELD_FORMAT}.${DATA_KEY_VERSION}.${encodeBase64Url(iv)}.${encodeBase64Url(sealed)}`;
}

/** A parsed `sym1` envelope. */
export interface ParsedSym1 {
  readonly keyVersion: number;
  readonly iv: Buffer;
  readonly ciphertextAndTag: Buffer;
}

/** Parses and strictly validates `sym1` envelope text without decrypting it. */
export function parseSym1(envelope: string, what: string): ParsedSym1 {
  if (typeof envelope !== "string") throw new MalformedEnvelopeError(what);
  if (envelope.length > MAX_FIELD_ENVELOPE_LENGTH) {
    throw new InputTooLargeError(what, MAX_FIELD_ENVELOPE_LENGTH);
  }
  const match = envelopePattern.exec(envelope);
  const [, versionText, ivText, bodyText] = match ?? [];
  if (versionText === undefined || ivText === undefined || bodyText === undefined) {
    throw new MalformedEnvelopeError(what);
  }
  const keyVersion = Number(versionText);
  if (keyVersion !== DATA_KEY_VERSION) throw new UnsupportedKeyVersionError(what);
  const iv = decodeBase64Url(ivText, GCM_IV_BYTES);
  const ciphertextAndTag = decodeBase64Url(bodyText);
  if (!iv || !ciphertextAndTag || ciphertextAndTag.byteLength < GCM_TAG_BYTES) {
    throw new MalformedEnvelopeError(what);
  }
  return { keyVersion, iv, ciphertextAndTag };
}

/** Decrypts a `sym1` envelope; `aadFor` builds the AAD for the parsed key version. */
export function openSym1(
  key: Uint8Array,
  envelope: string,
  aadFor: (keyVersion: number) => Uint8Array,
  what: string,
): Buffer {
  const parsed = parseSym1(envelope, what);
  return openAesGcm(key, parsed.iv, parsed.ciphertextAndTag, aadFor(parsed.keyVersion), what);
}
