/** Injection tokens of the access feature's services (§2.3). */
export const OTP_SERVICE = "symplist:access:OTP_SERVICE";
export const PROFILE_SERVICE = "symplist:access:PROFILE_SERVICE";
export const REDEMPTION_SERVICE = "symplist:access:REDEMPTION_SERVICE";
export const INVITE_ADMIN_SERVICE = "symplist:access:INVITE_ADMIN_SERVICE";
export const ACCOUNT_ADMIN_SERVICE = "symplist:access:ACCOUNT_ADMIN_SERVICE";
export const CAMPAIGN_REVOCATION_SERVICE = "symplist:access:CAMPAIGN_REVOCATION_SERVICE";
export const ACTIVITY_SERVICE = "symplist:access:ACTIVITY_SERVICE";
export const ADMIN_BOOTSTRAP_SERVICE = "symplist:access:ADMIN_BOOTSTRAP_SERVICE";
export const ACCOUNT_DELETION_REQUESTS = "symplist:access:ACCOUNT_DELETION_REQUESTS";
/** The test-only OTP outbox; bound to null unless `NODE_ENV=test`. */
export const OTP_TEST_OUTBOX = "symplist:access:OTP_TEST_OUTBOX";
