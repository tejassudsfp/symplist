import { createHmac } from "node:crypto";
import { canonicalJson } from "./canonical-json.ts";
import {
  constantTimeEqual,
  decodeBase64Url,
  encodeBase64Url,
  requireRecord,
  utf8Bytes,
  zeroize,
} from "./encoding.ts";
import { InputTooLargeError, InvalidCryptoInputError, KeyUnavailableError } from "./errors.ts";
import { AES_KEY_BYTES } from "./gcm.ts";
import { deriveKey, HKDF_LABELS } from "./hkdf.ts";
import type { AccountDataKey, KeyFamily, KeyProvider } from "./keys.ts";

/** Digest purposes and the secret family each uses (§4.3). */
export type DigestPurpose =
  | "session"
  | "csrf"
  | "vault-session"
  | "otp"
  | "otp-limit-email"
  | "account-tombstone"
  | "invite"
  | "share-token"
  | "share-form"
  | "share-session"
  | "mcp-key"
  | "oauth-code"
  | "oauth-refresh"
  | "idem"
  | "reminder-unsubscribe";

/** A stored digest with the secret version that produced it. */
export interface VersionedDigest {
  readonly version: number;
  /** base64url HMAC-SHA256. */
  readonly digest: string;
}

/** The secret family of each digest purpose (§4.3). A purpose is only ever keyed by its family. */
export const DIGEST_PURPOSE_FAMILY: Readonly<Record<DigestPurpose, KeyFamily>> = Object.freeze({
  session: "SESSION_DIGEST_SECRET",
  csrf: "SESSION_DIGEST_SECRET",
  "vault-session": "SESSION_DIGEST_SECRET",
  otp: "OTP_DIGEST_SECRET",
  "otp-limit-email": "OTP_DIGEST_SECRET",
  "account-tombstone": "OTP_DIGEST_SECRET",
  invite: "INVITE_DIGEST_SECRET",
  "share-token": "SHARE_DIGEST_SECRET",
  "share-form": "SHARE_DIGEST_SECRET",
  "share-session": "SHARE_SESSION_DIGEST_SECRET",
  "mcp-key": "MCP_TOKEN_DIGEST_SECRET",
  "oauth-code": "MCP_TOKEN_DIGEST_SECRET",
  "oauth-refresh": "MCP_TOKEN_DIGEST_SECRET",
  idem: "IDEMPOTENCY_SECRET",
  "reminder-unsubscribe": "REMINDER_UNSUBSCRIBE_SECRET",
});

/** HMAC-SHA256 output length. */
export const DIGEST_BYTES = 32;
/** Largest digest input (16 MiB). */
export const MAX_DIGEST_INPUT_BYTES = 16 * 1024 * 1024;

/** Raw HMAC-SHA256 of a message, for callers that build their own framed message (for example §6.2). */
export function hmacSha256(key: Uint8Array, message: Uint8Array): Buffer {
  if (!(key instanceof Uint8Array) || key.byteLength !== AES_KEY_BYTES) {
    throw new InvalidCryptoInputError(`HMAC keys must be ${AES_KEY_BYTES} bytes`);
  }
  if (!(message instanceof Uint8Array)) {
    throw new InvalidCryptoInputError("HMAC messages must be bytes");
  }
  if (message.byteLength > MAX_DIGEST_INPUT_BYTES) {
    throw new InputTooLargeError("digest input", MAX_DIGEST_INPUT_BYTES);
  }
  return createHmac("sha256", key).update(message).digest();
}

function valueBytes(value: string | Uint8Array): Uint8Array {
  if (typeof value === "string") {
    if (value.length > MAX_DIGEST_INPUT_BYTES) {
      throw new InputTooLargeError("digest input", MAX_DIGEST_INPUT_BYTES);
    }
    return utf8Bytes(value, "Digest input");
  }
  if (!(value instanceof Uint8Array)) {
    throw new InvalidCryptoInputError("Digest input must be a string or bytes");
  }
  return value;
}

/** `HMAC-SHA256(key, purpose || 0x00 || value)` as base64url (§4.3). */
function framedDigest(key: Uint8Array, purpose: string, value: string | Uint8Array): string {
  const bytes = valueBytes(value);
  if (bytes.byteLength > MAX_DIGEST_INPUT_BYTES) {
    throw new InputTooLargeError("digest input", MAX_DIGEST_INPUT_BYTES);
  }
  const hmac = createHmac("sha256", key);
  hmac.update(purpose, "utf8");
  hmac.update(new Uint8Array([0]));
  hmac.update(bytes);
  return encodeBase64Url(hmac.digest());
}

function assertPurposeFamily(family: KeyFamily, purpose: DigestPurpose): void {
  if (!Object.hasOwn(DIGEST_PURPOSE_FAMILY, purpose)) {
    throw new InvalidCryptoInputError("Unknown digest purpose");
  }
  if (DIGEST_PURPOSE_FAMILY[purpose] !== family) {
    throw new InvalidCryptoInputError(`Digest purpose ${purpose} is not keyed by ${family}`);
  }
}

function parseStoredDigest(stored: VersionedDigest): Buffer {
  const bytes =
    typeof stored?.digest === "string" && Number.isSafeInteger(stored.version)
      ? decodeBase64Url(stored.digest, DIGEST_BYTES)
      : undefined;
  if (!bytes) {
    throw new InvalidCryptoInputError("Stored digests need a version and a 43-character digest");
  }
  return bytes;
}

/** `HMAC-SHA256(key, purpose || 0x00 || value)` under the family's current version. */
export function computeDigest(
  keys: KeyProvider,
  family: KeyFamily,
  purpose: DigestPurpose,
  value: string | Uint8Array,
): VersionedDigest {
  assertPurposeFamily(family, purpose);
  const current = keys.current(family);
  return Object.freeze({
    version: current.version,
    digest: framedDigest(current.key, purpose, value),
  });
}

/** Digests under every configured version, newest first, for lookups (§4.3). */
export function computeDigestCandidates(
  keys: KeyProvider,
  family: KeyFamily,
  purpose: DigestPurpose,
  value: string | Uint8Array,
): readonly VersionedDigest[] {
  assertPurposeFamily(family, purpose);
  const versions = keys.all(family);
  if (versions.length === 0) throw new KeyUnavailableError(family);
  return Object.freeze(
    versions.map((entry) =>
      Object.freeze({ version: entry.version, digest: framedDigest(entry.key, purpose, value) }),
    ),
  );
}

/**
 * Compares a value against a stored digest with `timingSafeEqual`. Returns false when the digest does
 * not match or its version is no longer configured (a retired secret can verify nothing).
 */
export function verifyDigest(
  keys: KeyProvider,
  family: KeyFamily,
  purpose: DigestPurpose,
  value: string | Uint8Array,
  stored: VersionedDigest,
): boolean {
  assertPurposeFamily(family, purpose);
  const expected = parseStoredDigest(stored);
  const entry = keys.get(family, stored.version);
  if (!entry) return false;
  const actual = decodeBase64Url(framedDigest(entry.key, purpose, value), DIGEST_BYTES);
  return actual !== undefined && constantTimeEqual(actual, expected);
}

/** True when a stored digest uses a secret version other than the current one and should be recomputed on next use. */
export function digestNeedsRotation(
  keys: KeyProvider,
  family: KeyFamily,
  stored: VersionedDigest,
): boolean {
  requireRecord(stored, "The stored digest");
  return stored.version !== keys.current(family).version;
}

/** OTP challenge purposes (§5.1). */
export type OtpPurpose = "login" | "signup" | "vault_reset" | "account_delete";

const otpPurposes: ReadonlySet<string> = new Set([
  "login",
  "signup",
  "vault_reset",
  "account_delete",
]);

/** The inputs an OTP digest binds (§5.1). */
export interface OtpDigestInput {
  readonly challengeId: string;
  readonly purpose: OtpPurpose;
  readonly code: string;
}

function otpValue(input: OtpDigestInput): string {
  requireRecord(input, "The OTP digest input");
  if (!otpPurposes.has(input.purpose)) throw new InvalidCryptoInputError("Unknown OTP purpose");
  if (typeof input.challengeId !== "string" || input.challengeId.length === 0) {
    throw new InvalidCryptoInputError("OTP challenge ids must be non-empty strings");
  }
  if (typeof input.code !== "string")
    throw new InvalidCryptoInputError("OTP codes must be strings");
  return canonicalJson([input.challengeId, input.purpose, input.code]);
}

/**
 * The `otp` digest of a code bound to its challenge id and purpose: the digest value is the canonical
 * JSON array `[challengeId, purpose, code]`.
 */
export function computeOtpDigest(keys: KeyProvider, input: OtpDigestInput): VersionedDigest {
  return computeDigest(keys, "OTP_DIGEST_SECRET", "otp", otpValue(input));
}

/** Verifies a submitted code against the stored `otp` digest of its challenge. */
export function verifyOtpDigest(
  keys: KeyProvider,
  input: OtpDigestInput,
  stored: VersionedDigest,
): boolean {
  return verifyDigest(keys, "OTP_DIGEST_SECRET", "otp", otpValue(input), stored);
}

/** `HMAC(IDEMPOTENCY_SECRET_<current>, 'idem' || 0x00 || canonical JSON of the validated input)` (§6.1). */
export function computeIdempotencyFingerprint(keys: KeyProvider, input: unknown): VersionedDigest {
  return computeDigest(keys, "IDEMPOTENCY_SECRET", "idem", canonicalJson(input));
}

/** The inputs an approval argument digest binds (§8.4). */
export interface ApprovalArgsDigestInput {
  readonly toolSlug: string;
  readonly connectedAccountId: string | null;
  readonly arguments: unknown;
}

function approvalArgsValue(input: ApprovalArgsDigestInput): string {
  requireRecord(input, "The approval digest input");
  if (typeof input.toolSlug !== "string" || input.toolSlug.length === 0) {
    throw new InvalidCryptoInputError("Approval digests need a tool slug");
  }
  if (input.connectedAccountId !== null && typeof input.connectedAccountId !== "string") {
    throw new InvalidCryptoInputError("Approval digests need a connected account id or null");
  }
  return canonicalJson({
    arguments: input.arguments,
    connectedAccountId: input.connectedAccountId,
    toolSlug: input.toolSlug,
  });
}

/**
 * The `approval-args` digest (§8.4): HMAC under `HKDF(account data key, "symplist/approval-args/v1")`
 * over `'approval-args' || 0x00 || canonical JSON {arguments, connectedAccountId, toolSlug}`. Worker and
 * api compute the same value.
 */
export function computeApprovalArgsDigest(
  key: AccountDataKey,
  input: ApprovalArgsDigestInput,
): string {
  if (!(key?.key instanceof Uint8Array) || key.key.byteLength !== AES_KEY_BYTES) {
    throw new InvalidCryptoInputError(`Account data keys must be ${AES_KEY_BYTES} bytes`);
  }
  const value = approvalArgsValue(input);
  const digestKey = deriveKey(key.key, HKDF_LABELS.approvalArgs);
  try {
    return framedDigest(digestKey, "approval-args", value);
  } finally {
    zeroize(digestKey);
  }
}

/** Verifies an approval argument digest in constant time. */
export function verifyApprovalArgsDigest(
  key: AccountDataKey,
  input: ApprovalArgsDigestInput,
  digest: string,
): boolean {
  const expected = typeof digest === "string" ? decodeBase64Url(digest, DIGEST_BYTES) : undefined;
  if (!expected) return false;
  const actual = decodeBase64Url(computeApprovalArgsDigest(key, input), DIGEST_BYTES);
  return actual !== undefined && constantTimeEqual(actual, expected);
}

function emailSuppressionDigest(kekKey: Uint8Array, email: string): string {
  if (typeof email !== "string" || email.length === 0) {
    throw new InvalidCryptoInputError("Email suppression digests need an email address");
  }
  const digestKey = deriveKey(kekKey, HKDF_LABELS.emailSuppression);
  try {
    return framedDigest(digestKey, "email-suppression", email);
  } finally {
    zeroize(digestKey);
  }
}

/**
 * The `email-suppression` digest (§4.3) under `HKDF(CONTENT_KEK_<current>, "symplist/email-suppression/v1")`.
 * The caller normalizes the address first.
 */
export function computeEmailSuppressionDigest(keys: KeyProvider, email: string): VersionedDigest {
  const kek = keys.current("CONTENT_KEK");
  return Object.freeze({ version: kek.version, digest: emailSuppressionDigest(kek.key, email) });
}

/** `email-suppression` digests under every configured `CONTENT_KEK` version, newest first. */
export function computeEmailSuppressionDigestCandidates(
  keys: KeyProvider,
  email: string,
): readonly VersionedDigest[] {
  const versions = keys.all("CONTENT_KEK");
  if (versions.length === 0) throw new KeyUnavailableError("CONTENT_KEK");
  return Object.freeze(
    versions.map((kek) =>
      Object.freeze({ version: kek.version, digest: emailSuppressionDigest(kek.key, email) }),
    ),
  );
}
