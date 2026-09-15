/** Generated secret families the crypto package reads through a key provider (§4.3, §4.5). */
export type KeyFamily =
  | "CONTENT_KEK"
  | "INTERNAL_EVENT_SECRET"
  | "REMINDER_UNSUBSCRIBE_SECRET"
  | "VAULT_RECOVERY_KEY"
  | "SESSION_DIGEST_SECRET"
  | "OTP_DIGEST_SECRET"
  | "INVITE_DIGEST_SECRET"
  | "SHARE_DIGEST_SECRET"
  | "SHARE_SESSION_DIGEST_SECRET"
  | "MCP_TOKEN_DIGEST_SECRET"
  | "MCP_OAUTH_SIGNING_KEY"
  | "IDEMPOTENCY_SECRET";

/** One version of a 32-byte key. */
export interface VersionedKey {
  readonly version: number;
  readonly key: Uint8Array;
}

/**
 * Supplies master keys and digest secrets (decision A4). The environment provider reads
 * `<NAME>_<n>` and `<NAME>_CURRENT`; a KMS provider can replace it without code changes.
 */
export interface KeyProvider {
  /** The version named by `<NAME>_CURRENT`. */
  current(family: KeyFamily): VersionedKey;
  /** A specific configured version, or undefined when it is not configured. */
  get(family: KeyFamily, version: number): VersionedKey | undefined;
  /** Every configured version, newest first, for digest lookups (§4.3). */
  all(family: KeyFamily): readonly VersionedKey[];
}

/** An account data key after unwrapping (§4.1). Deleting its wrapped row is the crypto-shred. */
export interface AccountDataKey {
  readonly ownerId: string;
  /** The `CONTENT_KEK` version that wraps this key. */
  readonly kekVersion: number;
  readonly key: Uint8Array;
}

/** An account data key wrapped under `HKDF(CONTENT_KEK_<n>, "symplist/account-key/v1")`. */
export interface WrappedAccountKey {
  readonly ownerId: string;
  readonly kekVersion: number;
  /** base64url AES-256-GCM ciphertext with IV and tag. */
  readonly wrapped: string;
}
