import { Body, Controller, Get, HttpCode, Inject, Post, Put } from "@nestjs/common";
import {
  type AnalyticsConsentRequest,
  type AnalyticsTrackRequest,
  analyticsConsentRequestSchema,
  analyticsTrackRequestSchema,
} from "@symplist/contracts";
import { AccessFeatureError, type SessionContext } from "@symplist/core/access";
import { AnalyticsService } from "@symplist/core/analytics";
import { Access, CurrentSession } from "../../common/access.decorator.ts";
import { ApiError } from "../../common/errors/api-error.ts";
import { RouteClass } from "../../common/route-classes.ts";

@Controller("analytics")
@RouteClass("app")
export class AnalyticsController {
  constructor(@Inject(AnalyticsService) private readonly analytics: AnalyticsService) {}

  @Get("consent")
  @Access("admitted")
  get(@CurrentSession() session: SessionContext) {
    return this.call(() => this.analytics.get(session.userId));
  }

  @Put("consent")
  @Access("admitted", { fresh: true })
  set(
    @CurrentSession() session: SessionContext,
    @Body({ schema: analyticsConsentRequestSchema }) body: AnalyticsConsentRequest,
  ) {
    return this.call(() => this.analytics.set(session.userId, body));
  }

  @Post("events")
  @Access("admitted")
  @HttpCode(204)
  async track(
    @CurrentSession() session: SessionContext,
    @Body({ schema: analyticsTrackRequestSchema }) body: AnalyticsTrackRequest,
  ) {
    await this.analytics.track(session.userId, body);
  }

  private async call<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof AccessFeatureError) throw new ApiError(error.code);
      throw error;
    }
  }
}
