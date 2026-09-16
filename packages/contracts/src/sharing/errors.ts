import { defineErrorCodes } from "../common/errors.ts";

/** Stable error codes owned by the sharing feature (§13, §6), mapped to HTTP statuses. */
export const sharingErrorCodes = defineErrorCodes({
  "sharing.stale": 409,
  "sharing.expiry_invalid": 422,
  "sharing.unavailable": 404,
  "sharing.password_invalid": 403,
});
