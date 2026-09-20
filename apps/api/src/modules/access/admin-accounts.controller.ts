import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseInterceptors,
} from "@nestjs/common";
import {
  type AdminAccount,
  type AdminAccountActionRequest,
  type AdminAccountDetail,
  type AdminAccountPage,
  adminAccountActionRequestSchema,
  type ListAccountsQuery,
  listAccountsQuerySchema,
  userIdSchema,
} from "@symplist/contracts";
import type { AccountAction, AccountAdminService, SessionContext } from "@symplist/core/access";
import type { Request } from "express";
import { Access, CurrentSession } from "../../common/access.decorator.ts";
import { Idempotent } from "../../common/idempotent.decorator.ts";
import { RouteClass } from "../../common/route-classes.ts";
import { ACCOUNT_ADMIN_SERVICE } from "./access.tokens.ts";
import { AccessErrorsInterceptor } from "./access-errors.interceptor.ts";
import { AccessRealtime } from "./access-realtime.ts";
import { adminRequestId } from "./admin-request.ts";

/**
 * Beta account administration (§5.4, admin accounts brief): admin level with fresh reads. Unlock and
 * restores change only access fields and create an auditable admin grant; relock runs the restriction
 * routine (§5.5). Every action needs a reason and the `accessGeneration` the administrator saw.
 */
@Controller("admin/accounts")
@RouteClass("app")
@UseInterceptors(AccessErrorsInterceptor)
export class AdminAccountsController {
  constructor(
    @Inject(ACCOUNT_ADMIN_SERVICE) private readonly accounts: AccountAdminService,
    private readonly realtime: AccessRealtime,
  ) {}

  @Get()
  @Access("admin", { fresh: true })
  list(
    @Query({ schema: listAccountsQuerySchema }) query: ListAccountsQuery,
  ): Promise<AdminAccountPage> {
    return this.accounts.list(query);
  }

  @Get(":id")
  @Access("admin", { fresh: true })
  detail(@Param("id", { schema: userIdSchema }) userId: string): Promise<AdminAccountDetail> {
    return this.accounts.detail(userId);
  }

  @Post(":id/unlock")
  @Access("admin", { fresh: true })
  @Idempotent()
  @HttpCode(200)
  unlock(
    @CurrentSession() session: SessionContext,
    @Param("id", { schema: userIdSchema }) userId: string,
    @Body({ schema: adminAccountActionRequestSchema }) body: AdminAccountActionRequest,
    @Req() req: Request,
  ): Promise<AdminAccount> {
    return this.act(session, userId, "unlock", body, req);
  }

  @Post(":id/relock")
  @Access("admin", { fresh: true })
  @Idempotent()
  @HttpCode(200)
  relock(
    @CurrentSession() session: SessionContext,
    @Param("id", { schema: userIdSchema }) userId: string,
    @Body({ schema: adminAccountActionRequestSchema }) body: AdminAccountActionRequest,
    @Req() req: Request,
  ): Promise<AdminAccount> {
    return this.act(session, userId, "relock", body, req);
  }

  @Post(":id/restore-eligibility")
  @Access("admin", { fresh: true })
  @Idempotent()
  @HttpCode(200)
  restoreEligibility(
    @CurrentSession() session: SessionContext,
    @Param("id", { schema: userIdSchema }) userId: string,
    @Body({ schema: adminAccountActionRequestSchema }) body: AdminAccountActionRequest,
    @Req() req: Request,
  ): Promise<AdminAccount> {
    return this.act(session, userId, "restore_eligibility", body, req);
  }

  @Post(":id/restore-access")
  @Access("admin", { fresh: true })
  @Idempotent()
  @HttpCode(200)
  restoreAccess(
    @CurrentSession() session: SessionContext,
    @Param("id", { schema: userIdSchema }) userId: string,
    @Body({ schema: adminAccountActionRequestSchema }) body: AdminAccountActionRequest,
    @Req() req: Request,
  ): Promise<AdminAccount> {
    return this.act(session, userId, "restore_access", body, req);
  }

  private async act(
    session: SessionContext,
    userId: string,
    action: AccountAction,
    body: AdminAccountActionRequest,
    req: Request,
  ): Promise<AdminAccount> {
    const result = await this.accounts.act({
      adminId: session.userId,
      userId,
      action,
      reason: body.reason,
      expectedGeneration: body.expectedGeneration,
      requestId: adminRequestId(req, action, session.userId, userId),
    });
    await this.realtime.accessChanged(userId, result.access, { generationMoved: true });
    return result.account;
  }
}
