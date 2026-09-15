/**
 * Generated secret families (§4.5). Each is configured as `<NAME>_<n>` plus `<NAME>_CURRENT=<n>`.
 * The per-runtime allow and reject rules are added with the configuration schemas.
 */
export const generatedSecretFamilies = [
  "CONTENT_KEK",
  "INTERNAL_EVENT_SECRET",
  "REMINDER_UNSUBSCRIBE_SECRET",
  "VAULT_RECOVERY_KEY",
  "SESSION_DIGEST_SECRET",
  "OTP_DIGEST_SECRET",
  "INVITE_DIGEST_SECRET",
  "SHARE_DIGEST_SECRET",
  "SHARE_SESSION_DIGEST_SECRET",
  "MCP_TOKEN_DIGEST_SECRET",
  "MCP_OAUTH_SIGNING_KEY",
  "IDEMPOTENCY_SECRET",
] as const;

export type GeneratedSecretFamily = (typeof generatedSecretFamilies)[number];
