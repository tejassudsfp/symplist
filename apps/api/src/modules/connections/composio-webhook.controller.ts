import { Controller, HttpCode, Inject, Post, Req } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import { type VerifiedConnectionWebhook, verifyConnectionWebhook } from "@symplist/integrations";
import type { Request } from "express";
import { ApiError } from "../../common/errors/api-error.ts";
import { RouteClass } from "../../common/route-classes.ts";
import { API_CONFIG, type ApiConfig } from "../../infra/config/api-config.ts";
import { CONNECTIONS_RUNTIME, type ConnectionsRuntime } from "./connections.runtime.ts";

@Controller("webhooks/composio")
@RouteClass("signed")
@SkipThrottle()
export class ComposioWebhookController {
  constructor(
    @Inject(CONNECTIONS_RUNTIME) private readonly runtime: ConnectionsRuntime | null,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Post()
  @HttpCode(200)
  async receive(@Req() request: Request & { rawBody?: Buffer }) {
    if (!this.runtime?.client || !this.config.COMPOSIO_WEBHOOK_SECRET) throw ApiError.notFound();
    if (!request.rawBody) throw new ApiError("validation");
    let event: VerifiedConnectionWebhook;
    try {
      event = await verifyConnectionWebhook(
        this.runtime.client,
        this.config.COMPOSIO_WEBHOOK_SECRET,
        request.rawBody,
        request.headers,
      );
    } catch {
      throw new ApiError("validation");
    }
    return this.runtime.webhooks.apply(event);
  }
}
