import { Body, Controller, HttpCode, Inject, Post, Res, UseInterceptors } from "@nestjs/common";
import {
  type AccountDeletionAuthorizationResponse,
  type AccountDeletionRequest,
  type AccountDeletionResponse,
  accountDeletionRequestSchema,
  type OtpChallengeResponse,
  type OtpVerifyRequest,
  otpVerifyRequestSchema,
} from "@symplist/contracts";
import type { SessionContext } from "@symplist/core/access";
import type { AccountDeletionRequestService } from "@symplist/core/account";
import type { Response } from "express";
import { Access, CurrentSession } from "../../common/access.decorator.ts";
import { SessionService } from "../../common/auth/session.service.ts";
import { Idempotent } from "../../common/idempotent.decorator.ts";
import { RouteClass } from "../../common/route-classes.ts";
import { ACCOUNT_DELETION_REQUESTS } from "./access.tokens.ts";
import { AccessErrorsInterceptor } from "./access-errors.interceptor.ts";

/**
 * The account deletion request (§5.6), at identity level so locked, relocked and suspended accounts
 * can leave: an `account_delete` code bound to this session, its verification (a single-use
 * authorization valid for 10 minutes), and the deletion itself, which crypto-shreds the account in
 * one batch, ends every session, dispatches the purge and clears the cookies. All read D1 fresh.
 */
@Controller("account/deletion")
@RouteClass("app")
@UseInterceptors(AccessErrorsInterceptor)
export class AccountDeletionController {
  constructor(
    @Inject(ACCOUNT_DELETION_REQUESTS) private readonly deletions: AccountDeletionRequestService,
    private readonly sessions: SessionService,
  ) {}

  @Post("otp")
  @Access("identity", { fresh: true })
  @HttpCode(201)
  sendCode(@CurrentSession() session: SessionContext): Promise<OtpChallengeResponse> {
    return this.deletions.sendCode(session);
  }

  @Post("verify")
  @Access("identity", { fresh: true })
  @HttpCode(200)
  verifyCode(
    @CurrentSession() session: SessionContext,
    @Body({ schema: otpVerifyRequestSchema }) body: OtpVerifyRequest,
  ): Promise<AccountDeletionAuthorizationResponse> {
    return this.deletions.verifyCode(session, body);
  }

  @Post()
  @Access("identity", { fresh: true })
  @Idempotent()
  @HttpCode(202)
  async requestDeletion(
    @CurrentSession() session: SessionContext,
    @Body({ schema: accountDeletionRequestSchema }) body: AccountDeletionRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AccountDeletionResponse> {
    await this.deletions.requestDeletion(session, body.authorizationId);
    this.sessions.clearCookies(res);
    return { status: "deleting" };
  }
}
