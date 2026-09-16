import {
  Controller,
  HttpCode,
  Inject,
  type OnModuleInit,
  Post,
  type RawBodyRequest,
  Req,
} from "@nestjs/common";
import { ResendDeliveryEvents } from "@symplist/core/scheduling";
import type { Request } from "express";
import { Resend } from "resend";
import { ApiError } from "../../common/errors/api-error.ts";
import { AppLogger } from "../../common/logging/logger.ts";
import { RouteClass } from "../../common/route-classes.ts";
import { API_CONFIG, type ApiConfig } from "../../infra/config/api-config.ts";

@Controller("webhooks/resend")
@RouteClass("signed")
export class ResendWebhookController implements OnModuleInit {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(ResendDeliveryEvents) private readonly events: ResendDeliveryEvents,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}
  onModuleInit() {
    if (!this.config.RESEND_WEBHOOK_SECRET)
      this.logger.warn("email.delivery_tracking_disabled", {});
  }
  @Post()
  @HttpCode(200)
  async receive(@Req() req: RawBodyRequest<Request>) {
    if (!this.config.RESEND_WEBHOOK_SECRET) throw ApiError.notFound();
    const id = req.get("svix-id");
    const timestamp = req.get("svix-timestamp");
    const signature = req.get("svix-signature");
    if (!req.rawBody || !id || !timestamp || !signature || req.rawBody.length > 256 * 1024)
      throw new ApiError("validation");
    let event: unknown;
    try {
      event = new Resend(this.config.RESEND_API_KEY ?? "unused").webhooks.verify({
        payload: req.rawBody.toString("utf8"),
        headers: { id, timestamp, signature },
        webhookSecret: this.config.RESEND_WEBHOOK_SECRET,
      });
    } catch {
      throw new ApiError("validation");
    }
    try {
      await this.events.apply(id, event);
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "ZodError" || error.message === "webhook.invalid")
      )
        throw new ApiError("validation");
      throw error;
    }
    return { ok: true };
  }
}
