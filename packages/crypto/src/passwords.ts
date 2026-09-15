import * as nodeCrypto from "node:crypto";
import {
  constantTimeEqual,
  decodeBase64Url,
  drawRandom,
  encodeBase64Url,
  type RandomOptions,
  utf8Bytes,
  zeroize,
} from "./encoding.ts";
import {
  Argon2UnavailableError,
  InputTooLargeError,
  InvalidCryptoInputError,
  InvalidPasswordHashError,
} from "./errors.ts";
import { type Argon2Semaphore, argon2Semaphore } from "./semaphore.ts";

/** Argon2id salt and parameters, stored without any hash for key derivation (§4.3, §11.1). */
export interface Argon2idParameters {
  readonly v: 1;
  readonly alg: "argon2id";
  /** Memory in KiB (19456). */
  readonly m: number;
  /** Iterations (2). */
  readonly t: number;
  /** Parallelism (1). */
  readonly p: number;
  /** base64url 16-byte salt. */
  readonly salt: string;
}

/** An Argon2id verifier stored as `{v, alg, m, t, p, salt, hash}` (§4.3). */
export interface Argon2idHash extends Argon2idParameters {
  /** base64url 32-byte output. */
  readonly hash: string;
}

/**
 * Parameters accepted for key derivation. A record with a `hash` is a type error: a stored hash of a
 * key-derivation secret would be the wrapping key itself.
 */
export type Argon2idKeyParameters = Argon2idParameters & { readonly hash?: never };

/** The only supported parameter set (§4.3): OWASP m=19456 KiB, t=2, p=1, 16-byte salt, 32-byte output. */
export const ARGON2ID_PARAMETERS = Object.freeze({
  v: 1,
  alg: "argon2id",
  m: 19456,
  t: 2,
  p: 1,
  saltBytes: 16,
  hashBytes: 32,
} as const);

/** Largest secret accepted after NFKC normalization (4 KiB of UTF-8). */
export const MAX_ARGON2_SECRET_BYTES = 4096;

/** Options for Argon2id operations. */
export interface Argon2Options extends RandomOptions {
  /** Defaults to the process-wide semaphore; inject only in tests. */
  readonly semaphore?: Argon2Semaphore;
}

type Argon2Function = typeof nodeCrypto.argon2;

function argon2Function(runtime: { readonly argon2?: unknown }): Argon2Function | undefined {
  return typeof runtime.argon2 === "function" ? (runtime.argon2 as Argon2Function) : undefined;
}

/** Fails startup when `crypto.argon2` is missing (§4.3; Node ≥ 24.7 with OpenSSL ≥ 3.2). */
export function assertArgon2Available(runtime: { readonly argon2?: unknown } = nodeCrypto): void {
  if (!argon2Function(runtime)) throw new Argon2UnavailableError();
}

const hashFields = ["alg", "hash", "m", "p", "salt", "t", "v"];
const parameterFields = ["alg", "m", "p", "salt", "t", "v"];

function validatedParameters(value: unknown, fields: readonly string[]): Argon2idParameters {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidPasswordHashError("Argon2id records must be objects");
  }
  const record = value as Record<string, unknown>;
  const names = Object.keys(record).sort();
  if (names.length !== fields.length || names.some((name, index) => name !== fields[index])) {
    throw new InvalidPasswordHashError("Argon2id records must have exactly the stored fields");
  }
  if (
    record.v !== ARGON2ID_PARAMETERS.v ||
    record.alg !== ARGON2ID_PARAMETERS.alg ||
    record.m !== ARGON2ID_PARAMETERS.m ||
    record.t !== ARGON2ID_PARAMETERS.t ||
    record.p !== ARGON2ID_PARAMETERS.p
  ) {
    throw new InvalidPasswordHashError("Argon2id records must use the supported parameters");
  }
  if (
    typeof record.salt !== "string" ||
    !decodeBase64Url(record.salt, ARGON2ID_PARAMETERS.saltBytes)
  ) {
    throw new InvalidPasswordHashError("Argon2id salts must be 16 bytes of base64url");
  }
  return Object.freeze({
    v: ARGON2ID_PARAMETERS.v,
    alg: ARGON2ID_PARAMETERS.alg,
    m: ARGON2ID_PARAMETERS.m,
    t: ARGON2ID_PARAMETERS.t,
    p: ARGON2ID_PARAMETERS.p,
    salt: record.salt,
  });
}

/**
 * Validates a stored Argon2id salt and parameter record (for example parsed from D1) for key
 * derivation. Unknown versions, algorithms and parameter sets are rejected so stored data cannot
 * weaken or inflate the work factor, and a record carrying a `hash` is rejected because a stored hash
 * of a key-derivation secret would be the wrapping key itself.
 */
export function parseArgon2idParameters(value: unknown): Argon2idParameters {
  return validatedParameters(value, parameterFields);
}

/** Validates a stored Argon2id verifier record `{v, alg, m, t, p, salt, hash}`. */
export function parseArgon2idHash(value: unknown): Argon2idHash {
  const parameters = validatedParameters(value, hashFields);
  const hash = (value as Record<string, unknown>).hash;
  if (typeof hash !== "string" || !decodeBase64Url(hash, ARGON2ID_PARAMETERS.hashBytes)) {
    throw new InvalidPasswordHashError("Argon2id hashes must be 32 bytes of base64url");
  }
  return Object.freeze({ ...parameters, hash });
}

function secretBytes(secret: string): Buffer {
  if (typeof secret !== "string") throw new InvalidCryptoInputError("Secrets must be strings");
  if (secret.length > MAX_ARGON2_SECRET_BYTES) {
    throw new InputTooLargeError("secret", MAX_ARGON2_SECRET_BYTES);
  }
  const bytes = utf8Bytes(secret.normalize("NFKC"), "Secret");
  if (bytes.byteLength > MAX_ARGON2_SECRET_BYTES) {
    zeroize(bytes);
    throw new InputTooLargeError("secret", MAX_ARGON2_SECRET_BYTES);
  }
  return bytes;
}

function runArgon2(secret: Uint8Array, salt: Uint8Array): Promise<Buffer> {
  const argon2 = argon2Function(nodeCrypto);
  if (!argon2) return Promise.reject(new Argon2UnavailableError());
  return new Promise((resolve, reject) => {
    argon2(
      "argon2id",
      {
        message: secret,
        nonce: salt,
        memory: ARGON2ID_PARAMETERS.m,
        passes: ARGON2ID_PARAMETERS.t,
        parallelism: ARGON2ID_PARAMETERS.p,
        tagLength: ARGON2ID_PARAMETERS.hashBytes,
      },
      (error, derived) => {
        if (error) {
          reject(new InvalidCryptoInputError("Argon2id derivation failed"));
        } else {
          resolve(derived);
        }
      },
    );
  });
}

async function derive(
  secret: string,
  salt: Uint8Array,
  options: Argon2Options | undefined,
): Promise<Buffer> {
  const message = secretBytes(secret);
  try {
    return await (options?.semaphore ?? argon2Semaphore).run(() => runArgon2(message, salt));
  } finally {
    zeroize(message);
  }
}

/** Fresh Argon2id parameters with a random 16-byte salt, for Vault setup and reset (§11.1). */
export function createArgon2idParameters(options?: RandomOptions): Argon2idParameters {
  const salt = drawRandom(options, ARGON2ID_PARAMETERS.saltBytes);
  return Object.freeze({
    v: ARGON2ID_PARAMETERS.v,
    alg: ARGON2ID_PARAMETERS.alg,
    m: ARGON2ID_PARAMETERS.m,
    t: ARGON2ID_PARAMETERS.t,
    p: ARGON2ID_PARAMETERS.p,
    salt: encodeBase64Url(salt),
  });
}

/**
 * Hashes a Vault passphrase or share-link password with `crypto.argon2` through the process-wide
 * semaphore (2 concurrent, a queue of 16). The secret is NFKC-normalized before hashing.
 */
export async function hashArgon2id(secret: string, options?: Argon2Options): Promise<Argon2idHash> {
  const salt = drawRandom(options, ARGON2ID_PARAMETERS.saltBytes);
  const derived = await derive(secret, salt, options);
  try {
    return Object.freeze({
      v: ARGON2ID_PARAMETERS.v,
      alg: ARGON2ID_PARAMETERS.alg,
      m: ARGON2ID_PARAMETERS.m,
      t: ARGON2ID_PARAMETERS.t,
      p: ARGON2ID_PARAMETERS.p,
      salt: encodeBase64Url(salt),
      hash: encodeBase64Url(derived),
    });
  } finally {
    zeroize(derived);
  }
}

/** Verifies a secret against a stored Argon2id hash in constant time. */
export async function verifyArgon2id(
  secret: string,
  stored: Argon2idHash,
  options?: Argon2Options,
): Promise<boolean> {
  const record = parseArgon2idHash(stored);
  const salt = decodeBase64Url(record.salt, ARGON2ID_PARAMETERS.saltBytes);
  const expected = decodeBase64Url(record.hash, ARGON2ID_PARAMETERS.hashBytes);
  if (!salt || !expected) throw new InvalidPasswordHashError("Malformed Argon2id record");
  const derived = await derive(secret, salt, options);
  try {
    return constantTimeEqual(derived, expected);
  } finally {
    zeroize(derived, expected);
  }
}

/**
 * Derives the 32-byte Vault passphrase key with the stored salt and parameters (§11.1). Store only the
 * parameters beside the wrap: the derived key is the wrapping key and must never be persisted. The
 * caller owns the returned buffer and zeroises it after use.
 */
export async function deriveArgon2idKey(
  secret: string,
  stored: Argon2idKeyParameters,
  options?: Argon2Options,
): Promise<Uint8Array> {
  const parameters = parseArgon2idParameters(stored);
  const salt = decodeBase64Url(parameters.salt, ARGON2ID_PARAMETERS.saltBytes);
  if (!salt) throw new InvalidPasswordHashError("Argon2id salts must be 16 bytes of base64url");
  return derive(secret, salt, options);
}
