import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Put,
  UseInterceptors,
} from "@nestjs/common";
import {
  type MeResponse,
  type UpdateDisplayNameRequest,
  updateDisplayNameRequestSchema,
} from "@symplist/contracts";
import type { ProfileService, SessionContext } from "@symplist/core/access";
import { Access, CurrentSession } from "../../common/access.decorator.ts";
import { RouteClass } from "../../common/route-classes.ts";
import { PROFILE_SERVICE } from "./access.tokens.ts";
import { AccessErrorsInterceptor } from "./access-errors.interceptor.ts";
import { AccessRealtime } from "./access-realtime.ts";

/**
 * The signed-in identity (§5.1, §5.4): `GET /v1/me` at identity level (the beta gate and paused
 * screens need it), and the onboarding name and completion steps at the admitted level.
 */
@Controller("me")
@RouteClass("app")
@UseInterceptors(AccessErrorsInterceptor)
export class MeController {
  constructor(
    @Inject(PROFILE_SERVICE) private readonly profile: ProfileService,
    private readonly realtime: AccessRealtime,
  ) {}

  @Get()
  @Access("identity")
  async me(@CurrentSession() session: SessionContext): Promise<MeResponse> {
    const { me, finalized } = await this.profile.me(session.userId);
    // A claimed seat was finalized on this read: the account was just admitted.
    if (finalized?.granted) {
      await this.realtime.accessChanged(session.userId, me.access, { generationMoved: true });
    }
    return me;
  }

  /** Saves the encrypted display name; during onboarding it also advances to the connections step. */
  @Put("name")
  @Access("admitted")
  async updateName(
    @CurrentSession() session: SessionContext,
    @Body({ schema: updateDisplayNameRequestSchema }) body: UpdateDisplayNameRequest,
  ): Promise<MeResponse> {
    const me = await this.profile.updateDisplayName({
      userId: session.userId,
      displayName: body.displayName,
    });
    if (me.access.onboardingStep !== session.access.onboardingStep) {
      await this.realtime.accessChanged(session.userId, me.access, { generationMoved: false });
    }
    return me;
  }

  /** Finishes onboarding after the optional connections step (Continue or Skip for now). */
  @Post("onboarding/complete")
  @Access("admitted")
  @HttpCode(200)
  async completeOnboarding(@CurrentSession() session: SessionContext): Promise<MeResponse> {
    const me = await this.profile.completeOnboarding(session.userId);
    if (me.access.onboardingStep !== session.access.onboardingStep) {
      await this.realtime.accessChanged(session.userId, me.access, { generationMoved: false });
    }
    return me;
  }
}
