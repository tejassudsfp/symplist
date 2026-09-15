import { accountKeyWrapAad, fieldAad, objectAad } from "./aad.ts";
import { canonicalJson } from "./canonical-json.ts";
import {
  decodeBase64Url,
  decodeUtf8,
  drawRandom,
  encodeBase64Url,
  type RandomOptions,
  requireRecord,
  utf8Bytes,
  zeroize,
} from "./encoding.ts";
import {
  DecryptionFailedError,
  InputTooLargeError,
  InvalidCryptoInputError,
  KeyUnavailableError,
  MalformedEnvelopeError,
  UnsupportedKeyVersionError,
} from "./errors.ts";
import {
  AES_KEY_BYTES,
  GCM_IV_BYTES,
  GCM_TAG_BYTES,
  openAesGcm,
  sealAesGcm,
  unwrapKey,
  WRAPPED_KEY_LENGTH,
  wrapKey,
} from "./gcm.ts";
import { deriveKey, HKDF_LABELS } from "./hkdf.ts";
import type { AccountDataKey, KeyProvider, WrappedAccountKey } from "./keys.ts";
import { DATA_KEY_VERSION, MAX_FIELD_PLAINTEXT_BYTES, openSym1, sealSym1 } from "./sym1.ts";

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

/** Purpose of encrypted run output chunks (§4.1, §8.2). */
export const RUN_CHUNK_PURPOSE = "run_chunk";
/** Purpose of encrypted idempotency responses (§4.1, §6.1). */
export const IDEMPOTENCY_RESPONSE_PURPOSE = "idempotency_response";

/**
 * The field envelope binding for one run output chunk: purpose `run_chunk`, table `runs`, row id =
 * run id, column `seq:<seq>` (§4.1, §8.2).
 */
export function runChunkContext(ownerId: string, runId: string, seq: number): FieldEnvelopeContext {
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new InvalidCryptoInputError("Run chunk seq must be a non-negative integer");
  }
  return Object.freeze({
    purpose: RUN_CHUNK_PURPOSE,
    ownerId,
    table: "runs",
    rowId: runId,
    column: `seq:${seq}`,
  });
}

/**
 * The field envelope binding for `idempotency_records.response_enc` (§6.1): purpose
 * `idempotency_response`, owner = the record's user, row id = the canonical JSON array
 * `[scope, key]` (the record's identity within that user), column `response_enc`.
 */
export function idempotencyResponseContext(
  ownerId: string,
  scope: string,
  key: string,
): FieldEnvelopeContext {
  if (typeof scope !== "string" || scope.length === 0 || typeof key !== "string" || !key) {
    throw new InvalidCryptoInputError("Idempotency scope and key must be non-empty strings");
  }
  return Object.freeze({
    purpose: IDEMPOTENCY_RESPONSE_PURPOSE,
    ownerId,
    table: "idempotency_records",
    rowId: canonicalJson([scope, key]),
    column: "response_enc",
  });
}

function assertAccountKey(key: AccountDataKey, context: { readonly ownerId: string }): void {
  requireRecord(context, "The envelope context");
  if (
    typeof key !== "object" ||
    key === null ||
    !(key.key instanceof Uint8Array) ||
    key.key.byteLength !== AES_KEY_BYTES
  ) {
    throw new InvalidCryptoInputError(`Account data keys must be ${AES_KEY_BYTES} bytes`);
  }
  if (key.ownerId !== context.ownerId) {
    throw new InvalidCryptoInputError("The account data key belongs to a different owner");
  }
}

/** Encrypts a `_enc` column value as `sym1.<keyVersion>.<iv>.<ciphertext+tag>`. */
export function encryptField(
  key: AccountDataKey,
  context: FieldEnvelopeContext,
  plaintext: Uint8Array,
  options?: RandomOptions,
): string {
  assertAccountKey(key, context);
  return sealSym1(key.key, fieldAad(context, DATA_KEY_VERSION), plaintext, "field", options);
}

/** Decrypts a field envelope; fails without plaintext output on any binding mismatch. */
export function decryptField(
  key: AccountDataKey,
  context: FieldEnvelopeContext,
  envelope: string,
): Uint8Array {
  assertAccountKey(key, context);
  fieldAad(context, DATA_KEY_VERSION);
  return openSym1(key.key, envelope, (version) => fieldAad(context, version), "field envelope");
}

/** Encrypts UTF-8 text as a field envelope. */
export function encryptFieldText(
  key: AccountDataKey,
  context: FieldEnvelopeContext,
  text: string,
  options?: RandomOptions,
): string {
  if (typeof text !== "string") throw new InvalidCryptoInputError("Field text must be a string");
  if (text.length > MAX_FIELD_PLAINTEXT_BYTES) {
    throw new InputTooLargeError("field plaintext", MAX_FIELD_PLAINTEXT_BYTES);
  }
  const bytes = utf8Bytes(text, "Field text");
  try {
    return encryptField(key, context, bytes, options);
  } finally {
    zeroize(bytes);
  }
}

/** Decrypts a field envelope holding UTF-8 text. */
export function decryptFieldText(
  key: AccountDataKey,
  context: FieldEnvelopeContext,
  envelope: string,
): string {
  const bytes = decryptField(key, context, envelope);
  try {
    const text = decodeUtf8(bytes);
    if (text === undefined) throw new MalformedEnvelopeError("field text");
    return text;
  } finally {
    zeroize(bytes);
  }
}

/** The four ASCII bytes `SYMO` that start every object envelope. */
export const OBJECT_MAGIC = Object.freeze([0x53, 0x59, 0x4d, 0x4f] as const);
/** The container version byte after the magic. */
export const OBJECT_CONTAINER_VERSION = 1;
/** The only object header algorithm. */
export const OBJECT_ALGORITHM = "A256GCM";
/** Largest accepted JSON header. */
export const MAX_OBJECT_HEADER_BYTES = 1024;
/** Largest plaintext accepted in an object envelope (256 MiB). */
export const MAX_OBJECT_PLAINTEXT_BYTES = 256 * 1024 * 1024;

const prefixBytes = OBJECT_MAGIC.length + 1 + 4;

/** Largest object envelope accepted for decryption. */
export const MAX_OBJECT_ENVELOPE_BYTES =
  prefixBytes + MAX_OBJECT_HEADER_BYTES + MAX_OBJECT_PLAINTEXT_BYTES + GCM_TAG_BYTES;

/** The JSON header of an object envelope. */
export interface ObjectEnvelopeHeader {
  /** Object format version, bound through the AAD. */
  readonly v: number;
  readonly alg: typeof OBJECT_ALGORITHM;
  /** Data key version of the account data key that wraps `wk`. */
  readonly kv: number;
  /** base64url 12-byte IV of the body. */
  readonly iv: string;
  /** base64url 60-byte per-object key wrapped by the account data key (IV, key, tag). */
  readonly wk: string;
}

/** The plaintext metadata an object envelope exposes without decryption. */
export interface ObjectEnvelopeInfo {
  readonly formatVersion: number;
  readonly keyVersion: number;
}

interface ParsedObject {
  readonly header: ObjectEnvelopeHeader;
  readonly iv: Buffer;
  readonly body: Uint8Array;
}

const headerFields = ["alg", "iv", "kv", "v", "wk"];
const base64UrlText = /^[A-Za-z0-9_-]+$/;

function parseObject(envelope: Uint8Array): ParsedObject {
  const what = "object envelope";
  if (!(envelope instanceof Uint8Array)) throw new MalformedEnvelopeError(what);
  if (envelope.byteLength > MAX_OBJECT_ENVELOPE_BYTES) {
    throw new InputTooLargeError(what, MAX_OBJECT_ENVELOPE_BYTES);
  }
  if (envelope.byteLength < prefixBytes) throw new MalformedEnvelopeError(what);
  for (let index = 0; index < OBJECT_MAGIC.length; index += 1) {
    if (envelope[index] !== OBJECT_MAGIC[index]) throw new MalformedEnvelopeError(what);
  }
  if (envelope[OBJECT_MAGIC.length] !== OBJECT_CONTAINER_VERSION) {
    throw new MalformedEnvelopeError(what);
  }
  const view = new DataView(envelope.buffer, envelope.byteOffset, envelope.byteLength);
  const headerLength = view.getUint32(OBJECT_MAGIC.length + 1, false);
  if (
    headerLength === 0 ||
    headerLength > MAX_OBJECT_HEADER_BYTES ||
    prefixBytes + headerLength + GCM_TAG_BYTES > envelope.byteLength
  ) {
    throw new MalformedEnvelopeError(what);
  }
  const headerText = decodeUtf8(envelope.subarray(prefixBytes, prefixBytes + headerLength));
  let parsed: unknown;
  try {
    parsed = headerText === undefined ? undefined : JSON.parse(headerText);
  } catch {
    throw new MalformedEnvelopeError(what);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new MalformedEnvelopeError(what);
  }
  const header = parsed as Record<string, unknown>;
  const names = Object.keys(header).sort();
  if (
    names.length !== headerFields.length ||
    names.some((name, index) => name !== headerFields[index]) ||
    header.alg !== OBJECT_ALGORITHM ||
    typeof header.iv !== "string" ||
    !base64UrlText.test(header.iv) ||
    typeof header.wk !== "string" ||
    header.wk.length !== WRAPPED_KEY_LENGTH ||
    !base64UrlText.test(header.wk) ||
    !Number.isSafeInteger(header.v) ||
    (header.v as number) < 1 ||
    !Number.isSafeInteger(header.kv) ||
    (header.kv as number) < 1 ||
    canonicalJson(header) !== headerText
  ) {
    throw new MalformedEnvelopeError(what);
  }
  const iv = decodeBase64Url(header.iv, GCM_IV_BYTES);
  if (!iv) throw new MalformedEnvelopeError(what);
  return {
    header: header as unknown as ObjectEnvelopeHeader,
    iv,
    body: envelope.subarray(prefixBytes + headerLength),
  };
}

/**
 * Reads the plaintext header of an object envelope without decrypting it, for example to detect a
 * search index written in an older format and rebuild it instead of decrypting (§10.1).
 */
export function inspectObjectEnvelope(envelope: Uint8Array): ObjectEnvelopeInfo {
  const { header } = parseObject(envelope);
  return Object.freeze({ formatVersion: header.v, keyVersion: header.kv });
}

/**
 * Encrypts an object as `SYMO` magic, version, header length, JSON header, ciphertext and tag. A fresh
 * random 32-byte object key encrypts the body and is wrapped by the account data key; the wrap and the
 * body both use the object AAD. Random bytes are drawn in the order object key, wrap IV, body IV.
 */
export function encryptObject(
  key: AccountDataKey,
  context: ObjectEnvelopeContext,
  plaintext: Uint8Array,
  options?: RandomOptions,
): Uint8Array {
  assertAccountKey(key, context);
  const aad = objectAad(context, DATA_KEY_VERSION);
  if (!(plaintext instanceof Uint8Array)) {
    throw new InvalidCryptoInputError("Object plaintext must be bytes");
  }
  if (plaintext.byteLength > MAX_OBJECT_PLAINTEXT_BYTES) {
    throw new InputTooLargeError("object plaintext", MAX_OBJECT_PLAINTEXT_BYTES);
  }
  const objectKey = drawRandom(options, AES_KEY_BYTES);
  try {
    const wk = wrapKey(key.key, objectKey, aad, options);
    const iv = drawRandom(options, GCM_IV_BYTES);
    const header = Buffer.from(
      canonicalJson({
        v: context.formatVersion,
        alg: OBJECT_ALGORITHM,
        kv: DATA_KEY_VERSION,
        iv: encodeBase64Url(iv),
        wk,
      }),
      "utf8",
    );
    const prefix = Buffer.alloc(prefixBytes);
    prefix.set(OBJECT_MAGIC, 0);
    prefix[OBJECT_MAGIC.length] = OBJECT_CONTAINER_VERSION;
    prefix.writeUInt32BE(header.byteLength, OBJECT_MAGIC.length + 1);
    // The prefix and header go into the same allocation as the ciphertext, so a large object is not
    // copied once more after sealing.
    return sealAesGcm(objectKey, iv, plaintext, aad, [prefix, header]);
  } finally {
    zeroize(objectKey);
  }
}

/** Decrypts an object envelope; truncated or swapped objects fail without plaintext output. */
export function decryptObject(
  key: AccountDataKey,
  context: ObjectEnvelopeContext,
  envelope: Uint8Array,
): Uint8Array {
  const what = "object envelope";
  assertAccountKey(key, context);
  objectAad(context, DATA_KEY_VERSION);
  const { header, iv, body } = parseObject(envelope);
  if (header.kv !== DATA_KEY_VERSION) throw new UnsupportedKeyVersionError(what);
  if (header.v !== context.formatVersion) throw new DecryptionFailedError(what);
  const aad = objectAad(context, header.kv);
  const objectKey = unwrapKey(key.key, header.wk, aad, what);
  try {
    return openAesGcm(objectKey, iv, body, aad, what);
  } finally {
    zeroize(objectKey);
  }
}

function assertWrappedAccountKey(wrapped: WrappedAccountKey): void {
  if (
    typeof wrapped !== "object" ||
    wrapped === null ||
    typeof wrapped.ownerId !== "string" ||
    typeof wrapped.wrapped !== "string"
  ) {
    throw new InvalidCryptoInputError("Wrapped account keys need ownerId, kekVersion and wrapped");
  }
}

function wrapAccountKeyUnder(
  keys: KeyProvider,
  ownerId: string,
  dataKey: Uint8Array,
  options?: RandomOptions,
): WrappedAccountKey {
  const kek = keys.current("CONTENT_KEK");
  const aad = accountKeyWrapAad(ownerId, kek.version);
  const wrappingKey = deriveKey(kek.key, HKDF_LABELS.accountKey);
  try {
    return Object.freeze({
      ownerId,
      kekVersion: kek.version,
      wrapped: wrapKey(wrappingKey, dataKey, aad, options),
    });
  } finally {
    zeroize(wrappingKey);
  }
}

/**
 * Creates and wraps a new random account data key under the current `CONTENT_KEK`. Random bytes are
 * drawn in the order data key, wrap IV.
 */
export function createAccountKey(
  keys: KeyProvider,
  ownerId: string,
  options?: RandomOptions,
): {
  key: AccountDataKey;
  wrapped: WrappedAccountKey;
} {
  const dataKey = drawRandom(options, AES_KEY_BYTES);
  try {
    const wrapped = wrapAccountKeyUnder(keys, ownerId, dataKey, options);
    return {
      key: Object.freeze({ ownerId, kekVersion: wrapped.kekVersion, key: dataKey }),
      wrapped,
    };
  } catch (error) {
    zeroize(dataKey);
    throw error;
  }
}

/** Unwraps an account data key with the `CONTENT_KEK` version recorded on the row. */
export function unwrapAccountKey(keys: KeyProvider, wrapped: WrappedAccountKey): AccountDataKey {
  assertWrappedAccountKey(wrapped);
  const aad = accountKeyWrapAad(wrapped.ownerId, wrapped.kekVersion);
  const kek = keys.get("CONTENT_KEK", wrapped.kekVersion);
  if (!kek) throw new KeyUnavailableError("CONTENT_KEK", wrapped.kekVersion);
  const wrappingKey = deriveKey(kek.key, HKDF_LABELS.accountKey);
  try {
    const key = unwrapKey(wrappingKey, wrapped.wrapped, aad, "account key");
    return Object.freeze({ ownerId: wrapped.ownerId, kekVersion: wrapped.kekVersion, key });
  } finally {
    zeroize(wrappingKey);
  }
}

/** True when the account key row is wrapped under a `CONTENT_KEK` version other than the current one. */
export function accountKeyNeedsRewrap(keys: KeyProvider, wrapped: WrappedAccountKey): boolean {
  assertWrappedAccountKey(wrapped);
  return wrapped.kekVersion !== keys.current("CONTENT_KEK").version;
}

/**
 * Key rotation (§4.1): unwraps with the recorded `CONTENT_KEK` version and re-wraps the same data key
 * under the current version with a fresh IV. Envelopes are never re-encrypted.
 */
export function rewrapAccountKey(
  keys: KeyProvider,
  wrapped: WrappedAccountKey,
  options?: RandomOptions,
): WrappedAccountKey {
  const unwrapped = unwrapAccountKey(keys, wrapped);
  try {
    return wrapAccountKeyUnder(keys, wrapped.ownerId, unwrapped.key, options);
  } finally {
    zeroize(unwrapped.key);
  }
}
