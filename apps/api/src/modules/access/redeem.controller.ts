import {
  Body,
  type CanActivate,
  Controller,
  type ExecutionContext,
  HttpCode,
  Inject,
  Injectable,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import {
  idempotencyKeyHeader,
  type RedeemInviteRequest,
  type RedeemInviteResponse,
  redeemInviteRequestSchema,
} from "@symplist/contracts";
import type { ProfileService, RedemptionService, SessionContext } from "@symplist/core/access";
import type { Request } from "express";
import { Access, CurrentSession } from "../../common/access.decorator.ts";
import { CLOCK, type Clock } from "../../common/clock.ts";
import { ApiError } from "../../common/errors/api-error.ts";
import { Idempotent } from "../../common/idempotent.decorator.ts";
import { requestStateOf } from "../../common/request-context.ts";
import { RouteClass } from "../../common/route-classes.ts";
import { FixedWindowCounters } from "../../infra/limits/fixed-window.ts";
import { IpLimit, ipRequestBuckets } from "../../infra/limits/ip-limits.ts";
import { PROFILE_SERVICE, REDEMPTION_SERVICE } from "./access.tokens.ts";
import { AccessErrorsInterceptor } from "./access-errors.interceptor.ts";
import { AccessRealtime } from "./access-realtime.ts";

/** Redemptions per account: 10 per 10 minutes, in addition to the per-IP bucket (§5.8). */
export const REDEEM_ACCOUNT_LIMIT = ipRequestBuckets.invite_redeem;

/**
 * The per-account redemption bucket. A guard, so it refuses before the idempotency interceptor claims
 * the key and before any D1 access beyond the session lookup.
 */
@Injectable()
export class RedeemAccountLimitGuard implements CanActivate {
  private readonly counters: FixedWindowCounters;

  constructor(@Inject(CLOCK) clock: Clock) {
    this.counters = new FixedWindowCounters({ clock });
  }

  canActivate(context: ExecutionContext): boolean {
    const session = requestStateOf(context.switchToHttp().getRequest<Request>())?.session;
    if (!session) throw ApiError.internal();
    const { limit, windowMs } = REDEEM_ACCOUNT_LIMIT;
    const result = this.counters.hit(
      `invite_redeem_account:${session.userId}`,
      limit,
      windowMs,
      windowMs,
    );
    if (result.blocked) {
      throw ApiError.rateLimited(Math.max(1, Math.ceil(result.blockRemainingMs / 1000)));
    }
    return true;
  }
}

/**
 * `POST /v1/access/redeem` (§5.4): identity level, `app` class, Idempotency-Key, throttled per account
 * and per IP. An already-admitted account gets its state back without consuming a seat.
 */
@Controller("access")
@RouteClass("app")
@UseInterceptors(AccessErrorsInterceptor)
export class RedeemController {
  constructor(
    @Inject(REDEMPTION_SERVICE) private readonly redemptions: RedemptionService,
    @Inject(PROFILE_SERVICE) private readonly profile: ProfileService,
    private readonly realtime: AccessRealtime,
  ) {}

  @Post("redeem")
  @Access("identity")
  @IpLimit("invite_redeem")
  @UseGuards(RedeemAccountLimitGuard)
  @Idempotent()
  @HttpCode(200)
  async redeem(
    @CurrentSession() session: SessionContext,
    @Body({ schema: redeemInviteRequestSchema }) body: RedeemInviteRequest,
    @Req() req: Request,
  ): Promise<RedeemInviteResponse> {
    const key = String(req.headers[idempotencyKeyHeader.toLowerCase()]);
    const result = await this.redemptions.redeem({
      userId: session.userId,
      code: body.code,
      requestId: `redeem:${session.userId}:${key}`,
    });
    if (result.outcome === "unlocked") {
      await this.realtime.accessChanged(session.userId, result.access, { generationMoved: true });
    }
    const { me } = await this.profile.me(session.userId);
    return { outcome: result.outcome, me };
  }
}
