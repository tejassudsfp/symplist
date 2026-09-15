import { Inject, Injectable } from "@nestjs/common";
import type { Request } from "express";
import { CLOCK, type Clock } from "../../common/clock.ts";
import { ApiError } from "../../common/errors/api-error.ts";
import { clientIp, ipBucketKey } from "./client-ip.ts";
import { FixedWindowCounters } from "./fixed-window.ts";
import { type IpFailureBucket, ipFailureBuckets } from "./ip-limits.ts";

/**
 * In-memory per-IP failure buckets (§5.8): features record a failure after a wrong share password or
 * an invalid `/mcp` credential and check the bucket before the next attempt touches D1 or Argon2id.
 */
@Injectable()
export class IpFailureLimiter {
  private readonly counters: FixedWindowCounters;

  constructor(@Inject(CLOCK) clock: Clock) {
    this.counters = new FixedWindowCounters({ clock });
  }

  /** Throws `rate.limited` when the request's network is over the bucket. */
  assertAllowed(bucket: IpFailureBucket, req: Request): void {
    this.assertAllowedAddress(bucket, clientIp(req));
  }

  /** Records one failure for the request's network. */
  recordFailure(bucket: IpFailureBucket, req: Request): void {
    this.recordFailureAddress(bucket, clientIp(req));
  }

  /**
   * {@link assertAllowed} for a client address computed outside Express, such as a WebSocket upgrade
   * (`upgradeClientIp`). A null address counts under the shared `unknown` key.
   */
  assertAllowedAddress(bucket: IpFailureBucket, address: string | null): void {
    const state = this.counters.peek(this.key(bucket, address));
    const limit = ipFailureBuckets[bucket].limit;
    if (state && (state.blocked || state.hits >= limit)) {
      const waitMs = state.blocked ? state.blockRemainingMs : state.windowRemainingMs;
      throw ApiError.rateLimited(Math.max(1, Math.ceil(waitMs / 1000)));
    }
  }

  /** {@link recordFailure} for a client address computed outside Express. */
  recordFailureAddress(bucket: IpFailureBucket, address: string | null): void {
    const { limit, windowMs } = ipFailureBuckets[bucket];
    this.counters.hit(this.key(bucket, address), limit, windowMs, windowMs);
  }

  private key(bucket: IpFailureBucket, address: string | null): string {
    return `${bucket}:${ipBucketKey(address)}`;
  }
}
