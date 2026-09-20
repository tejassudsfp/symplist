import { defineErrorCodes } from "../common/errors.ts";

/** Stable error codes owned by the vault feature (§11, §6), mapped to HTTP statuses. */
export const vaultErrorCodes = defineErrorCodes({
  "vault.locked": 403,
  "vault.not_created": 409,
  "vault.already_created": 409,
  "vault.incorrect_key": 403,
  "vault.key_weak": 400,
  "vault.throttled": 429,
  "vault.conflict": 409,
  "vault.reset_expired": 403,
  "vault.grant_revoked": 403,
});
