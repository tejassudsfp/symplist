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
  type AdminInvite,
  type AdminInviteDetail,
  type AdminInvitePage,
  type ExtendInviteExpiryRequest,
  extendInviteExpiryRequestSchema,
  type GenerateInvitesRequest,
  type GenerateInvitesResponse,
  generateInvitesRequestSchema,
  inviteIdSchema,
  type ListInvitesQuery,
  listInvitesQuerySchema,
  type RevokeInviteRequest,
  revokeInviteRequestSchema,
  type UpdateInviteCapacityRequest,
  updateInviteCapacityRequestSchema,
} from "@symplist/contracts";
import type { InviteAdminService, SessionContext } from "@symplist/core/access";
import type { AccountKeyStore } from "@symplist/core/account";
import { zeroize } from "@symplist/crypto";
import { type DbClient, sql, verifiedRow } from "@symplist/db";
import type { Request } from "express";
import { ACCOUNT_KEYS } from "../../common/access/access.providers.ts";
import { Access, CurrentSession } from "../../common/access.decorator.ts";
import { ApiError } from "../../common/errors/api-error.ts";
import { foldedIdempotencyOf } from "../../common/idempotency/idempotency.interceptor.ts";
import { Idempotent, OneTimeSecret } from "../../common/idempotent.decorator.ts";
import { RouteClass } from "../../common/route-classes.ts";
import { DB_CLIENT } from "../../infra/db/db.providers.ts";
import { INVITE_ADMIN_SERVICE } from "./access.tokens.ts";
import { AccessErrorsInterceptor } from "./access-errors.interceptor.ts";
import { adminRequestId } from "./admin-request.ts";

/**
 * Beta invite administration (note 04, §5.4): admin level with fresh reads on every route. Generation
 * mints one-time codes exactly once (folded idempotency claim, redacted replay, decision R11).
 */
@Controller("admin/invites")
@RouteClass("app")
@UseInterceptors(AccessErrorsInterceptor)
export class AdminInvitesController {
  constructor(
    @Inject(INVITE_ADMIN_SERVICE) private readonly invites: InviteAdminService,
    @Inject(DB_CLIENT) private readonly db: DbClient,
    @Inject(ACCOUNT_KEYS) private readonly accountKeys: AccountKeyStore,
  ) {}

  /**
   * Generates independent codes or one shared campaign code. The claim, the invite inserts, the audit
   * event and the redacted response record commit in one batch; the raw codes exist only in this
   * response. An exact retry receives the invites with `secretUnavailable: true`, so an uncertain
   * request can be checked without minting another batch.
   */
  @Post()
  @Access("admin", { fresh: true })
  @OneTimeSecret(["codes"], { folded: true })
  async generate(
    @CurrentSession() session: SessionContext,
    @Body({ schema: generateInvitesRequestSchema }) body: GenerateInvitesRequest,
    @Req() req: Request,
  ): Promise<GenerateInvitesResponse> {
    const idempotency = foldedIdempotencyOf(req);
    const adminKey = await this.accountKeys.require(session.userId);
    try {
      const plan = this.invites.planGeneration({
        adminId: session.userId,
        adminKey,
        request: body,
        guard: idempotency.claim.guard,
      });
      const response = { status: 201, body: plan.response };
      const statements = [
        ...idempotency.statements,
        ...plan.statements,
        sql(`SELECT COUNT(*) AS inserted FROM beta_invites WHERE campaign_id = :campaign`, {
          campaign: plan.response.campaignId,
        }),
        idempotency.completionStatement(response, adminKey),
      ];
      const results = await this.db.batch(statements);
      const decision = idempotency.decide(results, adminKey);
      if (decision.kind === "replay") return decision.body as GenerateInvitesResponse;
      const inserted = verifiedRow(results, statements.length - 2)?.inserted;
      if (inserted !== plan.response.invites.length) throw ApiError.internal();
      return plan.response;
    } finally {
      zeroize(adminKey.key);
    }
  }

  @Get()
  @Access("admin", { fresh: true })
  list(
    @Query({ schema: listInvitesQuerySchema }) query: ListInvitesQuery,
  ): Promise<AdminInvitePage> {
    return this.invites.list(query);
  }

  @Get(":id")
  @Access("admin", { fresh: true })
  detail(@Param("id", { schema: inviteIdSchema }) inviteId: string): Promise<AdminInviteDetail> {
    return this.invites.detail(inviteId);
  }

  /** Changes the redemption cap; never below the seats already used. */
  @Post(":id/capacity")
  @Access("admin", { fresh: true })
  @Idempotent()
  @HttpCode(200)
  capacity(
    @CurrentSession() session: SessionContext,
    @Param("id", { schema: inviteIdSchema }) inviteId: string,
    @Body({ schema: updateInviteCapacityRequestSchema }) body: UpdateInviteCapacityRequest,
    @Req() req: Request,
  ): Promise<AdminInvite> {
    return this.invites.edit({
      adminId: session.userId,
      inviteId,
      expectedVersion: body.expectedVersion,
      edit: { kind: "capacity", maxRedemptions: body.maxRedemptions },
      requestId: adminRequestId(req, "invite_capacity", session.userId, inviteId),
    });
  }

  /** Moves the expiry later. */
  @Post(":id/expiry")
  @Access("admin", { fresh: true })
  @Idempotent()
  @HttpCode(200)
  expiry(
    @CurrentSession() session: SessionContext,
    @Param("id", { schema: inviteIdSchema }) inviteId: string,
    @Body({ schema: extendInviteExpiryRequestSchema }) body: ExtendInviteExpiryRequest,
    @Req() req: Request,
  ): Promise<AdminInvite> {
    return this.invites.edit({
      adminId: session.userId,
      inviteId,
      expectedVersion: body.expectedVersion,
      edit: { kind: "expiry", expiresAt: body.expiresAt },
      requestId: adminRequestId(req, "invite_expiry", session.userId, inviteId),
    });
  }

  /** Stops future redemption; accounts already admitted keep their access (§5.4). */
  @Post(":id/revoke")
  @Access("admin", { fresh: true })
  @Idempotent()
  @HttpCode(200)
  revoke(
    @CurrentSession() session: SessionContext,
    @Param("id", { schema: inviteIdSchema }) inviteId: string,
    @Body({ schema: revokeInviteRequestSchema }) body: RevokeInviteRequest,
    @Req() req: Request,
  ): Promise<AdminInvite> {
    return this.invites.edit({
      adminId: session.userId,
      inviteId,
      expectedVersion: body.expectedVersion,
      edit: { kind: "revoke" },
      requestId: adminRequestId(req, "invite_revoke", session.userId, inviteId),
    });
  }
}
