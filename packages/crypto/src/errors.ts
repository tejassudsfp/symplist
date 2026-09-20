/**
 * Typed crypto errors. Messages are fixed strings: no error ever carries plaintext, key material,
 * ciphertext, envelope text, secrets or the underlying OpenSSL error (§4.2, §6.3).
 */

/** Stable codes for every crypto failure. `rate.limited` matches the common contracts code (F8). */
export type CryptoErrorCode =
  | "crypto.key_configuration_invalid"
  | "crypto.key_unavailable"
  | "crypto.invalid_input"
  | "crypto.input_too_large"
  | "crypto.malformed_envelope"
  | "crypto.unsupported_key_version"
  | "crypto.decryption_failed"
  | "crypto.invalid_password_hash"
  | "crypto.argon2_unavailable"
  | "rate.limited";

/** Base class for every error thrown by `@symplist/crypto`. */
export abstract class CryptoError extends Error {
  abstract readonly code: CryptoErrorCode;
}

/** A key family in the environment or static configuration is invalid (§4.5). */
export class KeyConfigurationError extends CryptoError {
  readonly code = "crypto.key_configuration_invalid";
  constructor(message: string) {
    super(message);
    this.name = "KeyConfigurationError";
  }
}

/** A key family or a specific version of it is not configured. */
export class KeyUnavailableError extends CryptoError {
  readonly code = "crypto.key_unavailable";
  readonly family: string;
  readonly version: number | undefined;
  constructor(family: string, version?: number) {
    super(
      version === undefined
        ? `Key family ${family} is not configured`
        : `Key family ${family} has no configured version ${version}`,
    );
    this.name = "KeyUnavailableError";
    this.family = family;
    this.version = version;
  }
}

/** A caller passed an invalid argument (context, key length, purpose and family pairing, …). */
export class InvalidCryptoInputError extends CryptoError {
  readonly code = "crypto.invalid_input";
  constructor(message: string) {
    super(message);
    this.name = "InvalidCryptoInputError";
  }
}

/** Plaintext, envelope or digest input exceeds the documented size limit. */
export class InputTooLargeError extends CryptoError {
  readonly code = "crypto.input_too_large";
  readonly limitBytes: number;
  constructor(what: string, limitBytes: number) {
    super(`${what} exceeds the limit of ${limitBytes} bytes`);
    this.name = "InputTooLargeError";
    this.limitBytes = limitBytes;
  }
}

/** An envelope or wrapped key is structurally invalid or truncated. */
export class MalformedEnvelopeError extends CryptoError {
  readonly code = "crypto.malformed_envelope";
  constructor(what: string) {
    super(`Malformed ${what}`);
    this.name = "MalformedEnvelopeError";
  }
}

/** An envelope names a data key version this format generation does not support. */
export class UnsupportedKeyVersionError extends CryptoError {
  readonly code = "crypto.unsupported_key_version";
  constructor(what: string) {
    super(`Unsupported key version in ${what}`);
    this.name = "UnsupportedKeyVersionError";
  }
}

/**
 * Authentication failed: wrong key, wrong key version, modified ciphertext, IV, tag or header, or a
 * binding (AAD) mismatch. Never distinguishes between these causes.
 */
export class DecryptionFailedError extends CryptoError {
  readonly code = "crypto.decryption_failed";
  constructor(what: string) {
    super(`Could not decrypt ${what}`);
    this.name = "DecryptionFailedError";
  }
}

/** A stored Argon2id record is malformed or uses unsupported parameters. */
export class InvalidPasswordHashError extends CryptoError {
  readonly code = "crypto.invalid_password_hash";
  constructor(message: string) {
    super(message);
    this.name = "InvalidPasswordHashError";
  }
}

/** `crypto.argon2` is missing from this Node build (§4.3: startup fails). */
export class Argon2UnavailableError extends CryptoError {
  readonly code = "crypto.argon2_unavailable";
  constructor() {
    super("crypto.argon2 is not available in this Node.js runtime");
    this.name = "Argon2UnavailableError";
  }
}

/** The process-wide Argon2id semaphore and its queue are full (§4.3, §5.8). */
export class RateLimitedError extends CryptoError {
  readonly code = "rate.limited";
  /** Seconds the client should wait before retrying (the `retryAfter` detail). */
  readonly retryAfter: number;
  constructor(retryAfter: number) {
    super("Too many concurrent password operations");
    this.name = "RateLimitedError";
    this.retryAfter = retryAfter;
  }
}

/**
 * Thrown by interface stubs whose implementation lands in a later phase. Every `@symplist/crypto`
 * operation is implemented; the class stays exported so the foundation contract is unchanged.
 */
export class NotImplementedError extends Error {
  constructor(operation: string) {
    super(`${operation} is not implemented yet`);
    this.name = "NotImplementedError";
  }
}
