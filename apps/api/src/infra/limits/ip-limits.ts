import { SetMetadata } from "@nestjs/common";

const minute = 60_000;

/**
 * The in-memory per-IP request buckets of §5.8. A route opts in with `@IpLimit(bucket)`; routes that
 * share a bucket (lookup and signup) share its count. They run before the session lookup and any
 * other D1 access.
 */
export const ipRequestBuckets = Object.freeze({
  /** `POST /v1/auth/lookup` and `/signup`: 10 per 10 minutes. */
  auth_lookup: { limit: 10, windowMs: 10 * minute },
  /** OTP send: 10 per 10 minutes. */
  otp_send: { limit: 10, windowMs: 10 * minute },
  /** OTP verify: 30 per 10 minutes. */
  otp_verify: { limit: 30, windowMs: 10 * minute },
  /** Invite redeem: 10 per 10 minutes (the per-account limit is the access feature's). */
  invite_redeem: { limit: 10, windowMs: 10 * minute },
  /** Share reads: 60 per minute. */
  share_read: { limit: 60, windowMs: minute },
  /** Share password posts: 10 per minute. */
  share_password: { limit: 10, windowMs: minute },
  /** Vault unlock: 20 per IP per 15 minutes. */
  vault_unlock: { limit: 20, windowMs: 15 * minute },
  /** `/oauth/register`: 5 per hour. */
  oauth_register: { limit: 5, windowMs: 60 * minute },
  /** `/oauth/authorize`: 30 per 10 minutes. */
  oauth_authorize: { limit: 30, windowMs: 10 * minute },
} as const);

export type IpRequestBucket = keyof typeof ipRequestBuckets;

/**
 * In-memory per-IP failure buckets of §5.8, counted only when a request fails (for example a wrong
 * share password or an invalid `/mcp` credential) and checked before the next attempt.
 */
export const ipFailureBuckets = Object.freeze({
  /** Share password failures: 20 per IP per 15 minutes. */
  share_password_failure: { limit: 20, windowMs: 15 * minute },
  /** Invalid `/mcp` credentials: 20 per minute. */
  mcp_invalid_credentials: { limit: 20, windowMs: minute },
} as const);

export type IpFailureBucket = keyof typeof ipFailureBuckets;

/** Metadata key of {@link IpLimit}. */
export const IP_LIMIT_METADATA = "symplist:ip-limit";

/** Applies one or more per-IP request buckets to a route (§5.8). */
export const IpLimit = (
  ...buckets: readonly [IpRequestBucket, ...IpRequestBucket[]]
): MethodDecorator & ClassDecorator => SetMetadata(IP_LIMIT_METADATA, Object.freeze([...buckets]));
