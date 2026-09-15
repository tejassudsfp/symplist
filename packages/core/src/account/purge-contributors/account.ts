import type { PurgeContributor } from "./types.ts";

/** Account purge statements (§5.6). Auth sessions, OTP challenges and account deletion authorizations. */
export const accountPurgeContributor: PurgeContributor = {
  domain: "account",
  statements: () => [],
};
