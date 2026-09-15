import {
  vaultGrantAad,
  vaultItemAad,
  vaultPassphraseWrapAad,
  vaultRecoveryWrapAad,
  vaultSessionWrapAad,
} from "./aad.ts";
import {
  decodeBase64Url,
  drawRandom,
  type RandomOptions,
  requireRecord,
  zeroize,
} from "./encoding.ts";
import { InvalidCryptoInputError, KeyUnavailableError } from "./errors.ts";
import { AES_KEY_BYTES, unwrapKey, wrapKey } from "./gcm.ts";
import { deriveKey, HKDF_LABELS } from "./hkdf.ts";
import type { AccountDataKey, KeyProvider } from "./keys.ts";
import { openSym1, sealSym1 } from "./sym1.ts";

/** Vault data keys are 32 random bytes (§11.1). */
export const VAULT_KEY_BYTES = AES_KEY_BYTES;

function assertKeyBytes(key: Uint8Array, what: string): void {
  if (!(key instanceof Uint8Array) || key.byteLength !== AES_KEY_BYTES) {
    throw new InvalidCryptoInputError(`${what} must be ${AES_KEY_BYTES} bytes`);
  }
}

/** Generates a random Vault data key at setup. The caller owns and zeroises it. */
export function generateVaultKey(options?: RandomOptions): Buffer {
  return drawRandom(options, VAULT_KEY_BYTES);
}

/** Binding of the Vault passphrase wrap (§4.2). */
export interface VaultPassphraseWrapContext {
  readonly ownerId: string;
  readonly vaultVersion: number;
}

/**
 * Wraps the Vault data key under the Argon2id-derived passphrase key (from `deriveArgon2idKey`) with
 * AAD `vault-pass` (§11.1). Only the Argon2id salt and parameters are stored beside the wrap, never the
 * derived key.
 */
export function wrapVaultKeyWithPassphrase(
  passphraseKey: Uint8Array,
  context: VaultPassphraseWrapContext,
  vaultKey: Uint8Array,
  options?: RandomOptions,
): string {
  assertKeyBytes(passphraseKey, "The passphrase key");
  requireRecord(context, "The Vault passphrase wrap context");
  const aad = vaultPassphraseWrapAad(context.ownerId, context.vaultVersion);
  return wrapKey(passphraseKey, vaultKey, aad, options);
}

/** Unwraps the Vault data key with the passphrase key; a wrong passphrase fails authentication. */
export function unwrapVaultKeyWithPassphrase(
  passphraseKey: Uint8Array,
  context: VaultPassphraseWrapContext,
  wrapped: string,
): Buffer {
  assertKeyBytes(passphraseKey, "The passphrase key");
  requireRecord(context, "The Vault passphrase wrap context");
  const aad = vaultPassphraseWrapAad(context.ownerId, context.vaultVersion);
  return unwrapKey(passphraseKey, wrapped, aad, "Vault passphrase wrap");
}

/** A Vault recovery wrap with the `VAULT_RECOVERY_KEY` version stored beside it (§11.1). */
export interface VaultRecoveryWrap {
  readonly recoveryKeyVersion: number;
  /** base64url IV, encrypted key and tag (80 characters). */
  readonly wrapped: string;
}

/**
 * Wraps the Vault data key under `HKDF(VAULT_RECOVERY_KEY_<current>, "symplist/vault-recovery/v1")`
 * with AAD `vault-recovery` (§11.1).
 */
export function wrapVaultKeyForRecovery(
  keys: KeyProvider,
  ownerId: string,
  vaultKey: Uint8Array,
  options?: RandomOptions,
): VaultRecoveryWrap {
  const recovery = keys.current("VAULT_RECOVERY_KEY");
  const aad = vaultRecoveryWrapAad(ownerId, recovery.version);
  const wrappingKey = deriveKey(recovery.key, HKDF_LABELS.vaultRecovery);
  try {
    return Object.freeze({
      recoveryKeyVersion: recovery.version,
      wrapped: wrapKey(wrappingKey, vaultKey, aad, options),
    });
  } finally {
    zeroize(wrappingKey);
  }
}

/** Unwraps the Vault data key with the recovery key version recorded on the wrap (§11.2 reset). */
export function unwrapVaultKeyWithRecovery(
  keys: KeyProvider,
  ownerId: string,
  wrap: VaultRecoveryWrap,
): Buffer {
  requireRecord(wrap, "The Vault recovery wrap");
  const aad = vaultRecoveryWrapAad(ownerId, wrap.recoveryKeyVersion);
  const recovery = keys.get("VAULT_RECOVERY_KEY", wrap.recoveryKeyVersion);
  if (!recovery) throw new KeyUnavailableError("VAULT_RECOVERY_KEY", wrap.recoveryKeyVersion);
  const wrappingKey = deriveKey(recovery.key, HKDF_LABELS.vaultRecovery);
  try {
    return unwrapKey(wrappingKey, wrap.wrapped, aad, "Vault recovery wrap");
  } finally {
    zeroize(wrappingKey);
  }
}

/** True when the recovery wrap uses a `VAULT_RECOVERY_KEY` version other than the current one. */
export function vaultRecoveryWrapNeedsRewrap(keys: KeyProvider, wrap: VaultRecoveryWrap): boolean {
  requireRecord(wrap, "The Vault recovery wrap");
  return wrap.recoveryKeyVersion !== keys.current("VAULT_RECOVERY_KEY").version;
}

/**
 * Key rotation: unwraps with the recorded recovery key version and re-wraps the same Vault data key
 * under the current version.
 */
export function rewrapVaultRecoveryKey(
  keys: KeyProvider,
  ownerId: string,
  wrap: VaultRecoveryWrap,
  options?: RandomOptions,
): VaultRecoveryWrap {
  const vaultKey = unwrapVaultKeyWithRecovery(keys, ownerId, wrap);
  try {
    return wrapVaultKeyForRecovery(keys, ownerId, vaultKey, options);
  } finally {
    zeroize(vaultKey);
  }
}

/** Binding of the Vault session wrap (§4.2). */
export interface VaultSessionWrapContext {
  readonly ownerId: string;
  readonly vaultSessionId: string;
}

function sessionWrappingKey(sessionToken: string): Buffer {
  const tokenBytes =
    typeof sessionToken === "string" ? decodeBase64Url(sessionToken, AES_KEY_BYTES) : undefined;
  if (!tokenBytes) {
    throw new InvalidCryptoInputError("Vault session tokens must be 32 bytes of base64url");
  }
  try {
    return deriveKey(tokenBytes, HKDF_LABELS.vaultSession);
  } finally {
    zeroize(tokenBytes);
  }
}

/**
 * Re-wraps the Vault data key under `HKDF(token, "symplist/vault-session/v1")`, where `token` is the
 * 32 raw bytes of the base64url Vault session token from `generateToken()` (§11.1).
 */
export function wrapVaultKeyForSession(
  sessionToken: string,
  context: VaultSessionWrapContext,
  vaultKey: Uint8Array,
  options?: RandomOptions,
): string {
  requireRecord(context, "The Vault session wrap context");
  const aad = vaultSessionWrapAad(context.ownerId, context.vaultSessionId);
  const wrappingKey = sessionWrappingKey(sessionToken);
  try {
    return wrapKey(wrappingKey, vaultKey, aad, options);
  } finally {
    zeroize(wrappingKey);
  }
}

/** Unwraps the Vault data key for a request presenting the Vault session token. */
export function unwrapVaultKeyForSession(
  sessionToken: string,
  context: VaultSessionWrapContext,
  wrapped: string,
): Buffer {
  requireRecord(context, "The Vault session wrap context");
  const aad = vaultSessionWrapAad(context.ownerId, context.vaultSessionId);
  const wrappingKey = sessionWrappingKey(sessionToken);
  try {
    return unwrapKey(wrappingKey, wrapped, aad, "Vault session wrap");
  } finally {
    zeroize(wrappingKey);
  }
}

/** Binding of a Vault item (§4.2). */
export interface VaultItemContext {
  readonly ownerId: string;
  readonly itemId: string;
}

/** Encrypts a Vault item under the Vault data key as a `sym1` envelope with AAD `vault-item`. */
export function encryptVaultItem(
  vaultKey: Uint8Array,
  context: VaultItemContext,
  plaintext: Uint8Array,
  options?: RandomOptions,
): string {
  assertKeyBytes(vaultKey, "The Vault key");
  requireRecord(context, "The Vault item context");
  const aad = vaultItemAad(context.ownerId, context.itemId);
  return sealSym1(vaultKey, aad, plaintext, "Vault item", options);
}

/** Decrypts a Vault item. */
export function decryptVaultItem(
  vaultKey: Uint8Array,
  context: VaultItemContext,
  envelope: string,
): Buffer {
  assertKeyBytes(vaultKey, "The Vault key");
  requireRecord(context, "The Vault item context");
  const aad = vaultItemAad(context.ownerId, context.itemId);
  return openSym1(vaultKey, envelope, () => aad, "Vault item");
}

/** Binding of a Vault grant value (§4.2, §11.3). */
export interface VaultGrantContext {
  readonly ownerId: string;
  readonly grantId: string;
  readonly taskId: string;
}

function assertGrantKey(key: AccountDataKey, context: VaultGrantContext): void {
  assertKeyBytes(key?.key, "The account data key");
  requireRecord(context, "The Vault grant context");
  if (key.ownerId !== context.ownerId) {
    throw new InvalidCryptoInputError("The account data key belongs to a different owner");
  }
}

/**
 * Re-encrypts a Vault item value under the account data key as `vault_grants.value_enc` with AAD
 * `vault-grant` (grant id and task id, §11.3).
 */
export function encryptVaultGrantValue(
  key: AccountDataKey,
  context: VaultGrantContext,
  plaintext: Uint8Array,
  options?: RandomOptions,
): string {
  assertGrantKey(key, context);
  const aad = vaultGrantAad(context.ownerId, context.grantId, context.taskId);
  return sealSym1(key.key, aad, plaintext, "Vault grant value", options);
}

/** Decrypts a Vault grant value. */
export function decryptVaultGrantValue(
  key: AccountDataKey,
  context: VaultGrantContext,
  envelope: string,
): Buffer {
  assertGrantKey(key, context);
  const aad = vaultGrantAad(context.ownerId, context.grantId, context.taskId);
  return openSym1(key.key, envelope, () => aad, "Vault grant value");
}
