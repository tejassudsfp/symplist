import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseInterceptors,
} from "@nestjs/common";
import {
  type CampaignRevocationConfirmRequest,
  type CampaignRevocationPreview,
  type CampaignRevocationResult,
  campaignRevocationConfirmRequestSchema,
  idSchema,
} from "@symplist/contracts";
import type { CampaignRevocationService, SessionContext } from "@symplist/core/access";
import type { Request } from "express";
import { Access, CurrentSession } from "../../common/access.decorator.ts";
import { Idempotent } from "../../common/idempotent.decorator.ts";
import { RouteClass } from "../../common/route-classes.ts";
import { CAMPAIGN_REVOCATION_SERVICE } from "./access.tokens.ts";
import { AccessErrorsInterceptor } from "./access-errors.interceptor.ts";
import { adminRequestId } from "./admin-request.ts";

/** Campaign revocation (§5.5): preview the affected accounts, then confirm with the preview digest. */
@Controller("admin/campaigns")
@RouteClass("app")
@UseInterceptors(AccessErrorsInterceptor)
export class AdminCampaignsController {
  constructor(
    @Inject(CAMPAIGN_REVOCATION_SERVICE) private readonly campaigns: CampaignRevocationService,
  ) {}

  @Post(":id/revocation/preview")
  @Access("admin", { fresh: true })
  @HttpCode(200)
  preview(
    @Param("id", { schema: idSchema }) campaignId: string,
  ): Promise<CampaignRevocationPreview> {
    return this.campaigns.preview(campaignId);
  }

  @Post(":id/revocation/confirm")
  @Access("admin", { fresh: true })
  @Idempotent()
  @HttpCode(200)
  confirm(
    @CurrentSession() session: SessionContext,
    @Param("id", { schema: idSchema }) campaignId: string,
    @Body({ schema: campaignRevocationConfirmRequestSchema })
    body: CampaignRevocationConfirmRequest,
    @Req() req: Request,
  ): Promise<CampaignRevocationResult> {
    return this.campaigns.confirm({
      adminId: session.userId,
      campaignId,
      previewDigest: body.previewDigest,
      reason: body.reason,
      requestId: adminRequestId(req, "campaign_revocation", session.userId, campaignId),
    });
  }
}
