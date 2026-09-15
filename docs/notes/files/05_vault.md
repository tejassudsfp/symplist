# Vault setup, unlock, and recovery

Confirmed product requirements; implementation has not started.

An authenticated user sets a custom vault key on first access. Later visits ask for that key. A forgotten key can be reset using a fresh email OTP delivered by Resend.

## User flow

1. **First access:** enter and confirm a custom vault key. Create the encrypted vault once, with a concurrency check against duplicate setup.
2. **Unlock:** enter the vault key. Unlock locally for the current session; lock on logout or inactivity.
3. **Reset:** request a vault-reset OTP sent to the account's verified email, verify it, and enter/confirm a new vault key. Existing vault contents remain available.

Preserving contents during reset is the chosen design assumption. It requires managed recovery; ordinary account login alone does not authorize a reset.

## Key design

Use a random vault data-encryption key to encrypt entries with AES-256-GCM. Derive a wrapping key from the user's custom passphrase with Argon2id, a random salt, and versioned parameters. Encrypt (wrap) the data key with that derived key.

Keep a second encrypted copy of the data key under a service-controlled recovery key held separately from D1/R2. A deployment must configure recovery-key custody explicitly, ideally through a managed key service. Each self-hosted deployment controls its own recovery material; never ship a shared default key.

Store ciphertext, both wrapped data-key copies, salt, KDF parameters, unique nonces, authentication tags, and key/schema versions. Authenticate owner/item/version context with the ciphertext. The custom passphrase itself does not need reversible storage and must not be logged or persisted in plaintext. Regular vault decryption can remain in the browser.

This is a recoverable vault: the service has a recovery path to the data key. Do not describe it as a vault only the user can decrypt. Ordinary task/chat encryption uses separate keys. Agents never automatically receive the vault passphrase or its full contents.

## OTP reset contract

- A fresh challenge is bound to the user, verified email, purpose `vault_reset`, and expiry. Login/signup OTPs cannot be reused for reset.
- Nest generates a cryptographically random OTP; Resend sends it. Persist a keyed digest, expiry, attempt count, and consumption state. Bound attempts and resend rates; a resend invalidates the superseded challenge.
- Verification atomically consumes the OTP and issues a short-lived, single-use reset authorization bound to the current vault version. Verification alone does not change keys.
- The recovery operation unwraps the existing data key and creates a new user-key wrapper with fresh salt/nonce and the new passphrase-derived key. Use a reviewed cryptographic implementation; do not expose the recovery master key to the browser. The precise client/server reset exchange must be specified before coding.
- Commit the new wrapper and consumption of reset authorization atomically with an expected-version check. A failed reset must leave the old vault usable; replaying a completed reset must not change keys again.
- Revoke server-tracked vault grants/unlock sessions and require re-unlock. Send an email notification and record a redacted audit event. Material already decrypted or copied to another device cannot be recalled.
- Reset changes the key used for future unlocks; it is not full data-key rotation and cannot retroactively protect old ciphertext/key copies. Define full rotation separately if needed.

Recovery keys need their own backup and rotation plan. Losing both usable user-key access and the recovery key makes recovery impossible. OTP protects access to the recovery operation; it is not itself an encryption key.

## Verification required before release

Test first-use races, wrong-key failure, cross-user isolation, OTP expiry/replay/purpose separation, concurrent resets, interruption before commit, preserved contents after reset, failure of the old key against the new wrapper, and vault grant revocation. Check that logs and traces contain neither OTPs nor keys nor decrypted entries.

Cryptographic background: [OWASP cryptographic storage](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html), [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).
