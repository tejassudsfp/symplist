import { hkdfSync } from "node:crypto";
import { InvalidCryptoInputError } from "./errors.ts";

/**
 * The fixed HKDF-SHA256 info labels (§4.1, §4.3, §11.1). No other label can be derived, so each
 * derived key has exactly one purpose.
 */
export const HKDF_LABELS = Object.freeze({
  /** Account data key wrapping key from `CONTENT_KEK_<n>` (§4.1). */
  accountKey: "symplist/account-key/v1",
  /** Approval argument digest key from the account data key (§4.3, §8.4). */
  approvalArgs: "symplist/approval-args/v1",
  /** `email_suppressions` lookup key from `CONTENT_KEK_<n>` (§4.3). */
  emailSuppression: "symplist/email-suppression/v1",
  /** Vault recovery wrapping key from `VAULT_RECOVERY_KEY_<n>` (§11.1). */
  vaultRecovery: "symplist/vault-recovery/v1",
  /** Vault session wrapping key from the 32-byte Vault session token (§11.1). */
  vaultSession: "symplist/vault-session/v1",
} as const);

/** One of the fixed HKDF info labels. */
export type HkdfLabel = (typeof HKDF_LABELS)[keyof typeof HKDF_LABELS];

/** Derived keys are 32 bytes (AES-256 and HMAC-SHA256 keys). */
export const DERIVED_KEY_BYTES = 32;

const allowedLabels: ReadonlySet<string> = new Set(Object.values(HKDF_LABELS));

/**
 * `HKDF-SHA256(ikm, salt = empty, info = label, L = 32)`. The input must be a 32-byte key. The caller
 * owns the returned buffer and should zeroise it after use.
 */
export function deriveKey(ikm: Uint8Array, label: HkdfLabel): Buffer {
  if (!allowedLabels.has(label)) {
    throw new InvalidCryptoInputError("Unknown HKDF label");
  }
  if (!(ikm instanceof Uint8Array) || ikm.byteLength !== DERIVED_KEY_BYTES) {
    throw new InvalidCryptoInputError(`HKDF input keys must be ${DERIVED_KEY_BYTES} bytes`);
  }
  return Buffer.from(hkdfSync("sha256", ikm, new Uint8Array(0), label, DERIVED_KEY_BYTES));
}
