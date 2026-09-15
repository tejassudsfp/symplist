import { NotImplementedError } from "./errors.ts";
import type { KeyFamily, KeyProvider } from "./keys.ts";

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

/** `HMAC-SHA256(key, purpose || 0x00 || value)` under the family's current version. */
export function computeDigest(
  _keys: KeyProvider,
  _family: KeyFamily,
  _purpose: DigestPurpose,
  _value: string | Uint8Array,
): VersionedDigest {
  throw new NotImplementedError("crypto.computeDigest");
}

/** Digests under every configured version, newest first, for lookups (§4.3). */
export function computeDigestCandidates(
  _keys: KeyProvider,
  _family: KeyFamily,
  _purpose: DigestPurpose,
  _value: string | Uint8Array,
): readonly VersionedDigest[] {
  throw new NotImplementedError("crypto.computeDigestCandidates");
}

/** Compares a value against a stored digest with `timingSafeEqual`. */
export function verifyDigest(
  _keys: KeyProvider,
  _family: KeyFamily,
  _purpose: DigestPurpose,
  _value: string | Uint8Array,
  _stored: VersionedDigest,
): boolean {
  throw new NotImplementedError("crypto.verifyDigest");
}
