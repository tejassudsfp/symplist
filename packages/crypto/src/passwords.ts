import { NotImplementedError } from "./errors.ts";

/** An Argon2id verifier stored as `{v, alg, m, t, p, salt, hash}` (§4.3). */
export interface Argon2idHash {
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
  /** base64url 32-byte output. */
  readonly hash: string;
}

/**
 * Hashes a Vault passphrase or share-link password with `crypto.argon2` through the process-wide
 * semaphore (2 concurrent, a queue of 16).
 */
export function hashArgon2id(_secret: string): Promise<Argon2idHash> {
  throw new NotImplementedError("crypto.hashArgon2id");
}

/** Verifies a secret against a stored Argon2id hash in constant time. */
export function verifyArgon2id(_secret: string, _stored: Argon2idHash): Promise<boolean> {
  throw new NotImplementedError("crypto.verifyArgon2id");
}

/** Derives the 32-byte Vault passphrase key with the stored salt and parameters (§11.1). */
export function deriveArgon2idKey(_secret: string, _stored: Argon2idHash): Promise<Uint8Array> {
  throw new NotImplementedError("crypto.deriveArgon2idKey");
}
