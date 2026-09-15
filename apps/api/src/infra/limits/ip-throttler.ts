import { type ExecutionContext, Inject, Injectable, type Provider } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import {
  getOptionsToken,
  getStorageToken,
  ThrottlerGuard,
  type ThrottlerLimitDetail,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from "@nestjs/throttler";
import type { Request } from "express";
import { CLOCK, type Clock } from "../../common/clock.ts";
import { ApiError } from "../../common/errors/api-error.ts";
import { clientIp, ipBucketKey } from "./client-ip.ts";
import { FixedWindowCounters } from "./fixed-window.ts";
import { IP_LIMIT_METADATA, type IpRequestBucket, ipRequestBuckets } from "./ip-limits.ts";

type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage["increment"]>>;

/**
 * `@nestjs/throttler` storage over {@link FixedWindowCounters}, so the per-IP buckets use the
 * injected clock and bounded memory. The throttler reports seconds.
 */
@Injectable()
export class ClockThrottlerStorage implements ThrottlerStorage {
  private readonly counters: FixedWindowCounters;

  constructor(@Inject(CLOCK) clock: Clock) {
    this.counters = new FixedWindowCounters({ clock });
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    _throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const result = this.counters.hit(key, limit, ttl, blockDuration);
    return {
      totalHits: result.hits,
      timeToExpire: Math.ceil(result.windowRemainingMs / 1000),
      isBlocked: result.blocked,
      timeToBlockExpire: Math.ceil(result.blockRemainingMs / 1000),
    };
  }
}

function routeBuckets(reflector: Reflector, context: ExecutionContext): readonly IpRequestBucket[] {
  return (
    reflector.getAllAndOverride<readonly IpRequestBucket[] | undefined>(IP_LIMIT_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]) ?? []
  );
}

/**
 * The throttler options: one named throttler per §5.8 bucket, each skipped unless the route declared
 * it with `@IpLimit`. Keys are `<bucket>:<client network>`, so routes sharing a bucket share counts.
 */
export function ipThrottlerOptions(reflector: Reflector): ThrottlerModuleOptions {
  return {
    setHeaders: false,
    throttlers: Object.entries(ipRequestBuckets).map(([name, bucket]) => ({
      name,
      limit: bucket.limit,
      ttl: bucket.windowMs,
      blockDuration: bucket.windowMs,
      skipIf: (context: ExecutionContext) =>
        !routeBuckets(reflector, context).includes(name as IpRequestBucket),
    })),
    getTracker: (req: Record<string, unknown>) => ipBucketKey(clientIp(req as unknown as Request)),
    generateKey: (_context: ExecutionContext, tracker: string, throttlerName: string) =>
      `${throttlerName}:${tracker}`,
  };
}

/**
 * The global per-IP bucket guard (§5.8, §6). It runs before the route-class and access guards, so a
 * throttled request never reaches D1. WebSocket and other non-HTTP contexts are skipped: gateways
 * count frames themselves (§7).
 */
@Injectable()
export class IpThrottlerGuard extends ThrottlerGuard {
  protected override async shouldSkip(context: ExecutionContext): Promise<boolean> {
    return context.getType() !== "http";
  }

  protected override async throwThrottlingException(
    _context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    throw ApiError.rateLimited(Math.max(1, detail.timeToBlockExpire));
  }
}

/** Providers that stand in for `ThrottlerModule.forRoot` with the clock-aware storage. */
export const ipThrottlerProviders: Provider[] = [
  ClockThrottlerStorage,
  { provide: getStorageToken(), useExisting: ClockThrottlerStorage },
  { provide: getOptionsToken(), useFactory: ipThrottlerOptions, inject: [Reflector] },
];
