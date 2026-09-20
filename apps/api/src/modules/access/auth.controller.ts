import { Body, Controller, HttpCode, Inject, Post, Res, UseInterceptors } from "@nestjs/common";
import {
  type AuthLookupRequest,
  type AuthLookupResponse,
  type AuthSignupRequest,
  authLookupRequestSchema,
  authSignupRequestSchema,
  type LogoutResponse,
  type MeResponse,
  normalizeEmail,
  type OtpChallengeResponse,
  type OtpSendRequest,
  type OtpVerifyRequest,
  otpSendRequestSchema,
  otpVerifyRequestSchema,
} from "@symplist/contracts";
import {
  AccessFeatureError,
  type AdminBootstrapService,
  type OtpService,
  type PreparedSession,
  type ProfileService,
  type SessionContext,
} from "@symplist/core/access";
import { computeDigest, type KeyProvider } from "@symplist/crypto";
import { verifiedRow } from "@symplist/db";
import type { Response } from "express";
import { Access, CurrentSession } from "../../common/access.decorator.ts";
import { SessionService } from "../../common/auth/session.service.ts";
import { CLOCK, type Clock } from "../../common/clock.ts";
import { ApiError } from "../../common/errors/api-error.ts";
import { AppLogger } from "../../common/logging/logger.ts";
import { RouteClass } from "../../common/route-classes.ts";
import { API_CONFIG, type ApiConfig } from "../../infra/config/api-config.ts";
import { KEY_PROVIDER } from "../../infra/crypto/crypto.providers.ts";
import { FixedWindowCounters } from "../../infra/limits/fixed-window.ts";
import { IpLimit, ipRequestBuckets } from "../../infra/limits/ip-limits.ts";
import { ADMIN_BOOTSTRAP_SERVICE, OTP_SERVICE, PROFILE_SERVICE } from "./access.tokens.ts";
import { AccessErrorsInterceptor } from "./access-errors.interceptor.ts";

/**
 * Lookups and signups of one address, counted in memory in addition to the per-IP bucket (§5.1:
 * "throttled by IP and email"). The key is the address's `otp-limit-email` digest, never the address.
 */
export const EMAIL_LOOKUP_LIMIT = ipRequestBuckets.auth_lookup;

/**
 * Sign-in and signup (§5.1, `pre_session` class): account lookup, signup consent, login codes, code
 * verification that creates the session, and logout (`app` class, identity level).
 */
@Controller("auth")
@UseInterceptors(AccessErrorsInterceptor)
export class AuthController {
  private readonly emailBuckets: FixedWindowCounters;

  constructor(
    @Inject(OTP_SERVICE) private readonly otp: OtpService,
    @Inject(PROFILE_SERVICE) private readonly profile: ProfileService,
    @Inject(ADMIN_BOOTSTRAP_SERVICE) private readonly bootstrap: AdminBootstrapService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(KEY_PROVIDER) private readonly keys: KeyProvider,
    @Inject(CLOCK) clock: Clock,
    private readonly sessions: SessionService,
    private readonly logger: AppLogger,
  ) {
    this.emailBuckets = new FixedWindowCounters({ clock });
  }

  @Post("lookup")
  @RouteClass("pre_session")
  @IpLimit("auth_lookup")
  @HttpCode(200)
  async lookup(
    @Body({ schema: authLookupRequestSchema }) body: AuthLookupRequest,
  ): Promise<AuthLookupResponse> {
    this.countAddress(body.email);
    return { exists: await this.otp.lookup(body.email) };
  }

  @Post("signup")
  @RouteClass("pre_session")
  @IpLimit("auth_lookup")
  @HttpCode(201)
  signup(
    @Body({ schema: authSignupRequestSchema }) body: AuthSignupRequest,
  ): Promise<OtpChallengeResponse> {
    this.countAddress(body.email);
    return this.otp.signup(body.email);
  }

  @Post("otp")
  @RouteClass("pre_session")
  @IpLimit("otp_send")
  @HttpCode(201)
  sendCode(
    @Body({ schema: otpSendRequestSchema }) body: OtpSendRequest,
  ): Promise<OtpChallengeResponse> {
    return this.otp.sendLogin(body.email);
  }

  /**
   * Verifies a login or signup code and creates the session in the consuming batch: the email is
   * verified (signup), the account key is provisioned on first verification, the session row is
   * inserted under the challenge guard, and the cookies are set on the response. Verification never
   * unlocks beta access (note 03).
   */
  @Post("otp/verify")
  @RouteClass("pre_session")
  @IpLimit("otp_verify")
  @HttpCode(200)
  async verify(
    @Body({ schema: otpVerifyRequestSchema }) body: OtpVerifyRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MeResponse> {
    const verified = await this.otp.verify({
      challengeId: body.challengeId,
      code: body.code,
      purposes: ["login", "signup"],
      priority: "unauthenticated",
      success: ({ userId, purpose, guard, now }) => {
        const session: PreparedSession = this.sessions.prepare(userId, guard);
        const plan = this.profile.loginStatements({
          userId,
          purpose: purpose === "signup" ? "signup" : "login",
          guard,
          now,
          session,
        });
        return {
          statements: plan.statements,
          decide: (results, offset) => {
            if (!verifiedRow(results, offset + plan.sessionVerifyIndex)) {
              throw new AccessFeatureError("auth.account_unavailable");
            }
            const me = this.profile.fromResults(results, offset + plan.sessionVerifyIndex + 1);
            if (!me) throw new AccessFeatureError("auth.account_unavailable");
            return { me, session };
          },
        };
      },
    });
    this.sessions.setCookies(res, verified.value.session);
    const bootstrapEmail = this.config.ADMIN_BOOTSTRAP_EMAIL;
    if (bootstrapEmail !== undefined && normalizeEmail(bootstrapEmail) === verified.email) {
      try {
        const outcome = await this.bootstrap.bootstrap(verified.email);
        if (outcome.status === "promoted") {
          this.sessions.evictUser(outcome.userId, outcome.accessGeneration);
          this.logger.info("access.admin_bootstrapped", { userId: outcome.userId });
          return (await this.profile.me(verified.userId)).me;
        }
      } catch (error) {
        this.logger.error("access.admin_bootstrap_failed", { error });
      }
    }
    return verified.value.me;
  }

  /**
   * Ends this session (§5.1): revokes the session row and its Vault session through the session
   * revoke contributors, closes the session's sockets with 4401 and clears the cookies.
   */
  @Post("logout")
  @RouteClass("app")
  @Access("identity")
  @HttpCode(200)
  async logout(
    @CurrentSession() session: SessionContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LogoutResponse> {
    await this.sessions.revoke(session, "logout");
    this.sessions.clearCookies(res);
    return { signedOut: true };
  }

  private countAddress(email: string): void {
    const key = computeDigest(
      this.keys,
      "OTP_DIGEST_SECRET",
      "otp-limit-email",
      normalizeEmail(email),
    );
    const { limit, windowMs } = EMAIL_LOOKUP_LIMIT;
    const result = this.emailBuckets.hit(`auth_email:${key.digest}`, limit, windowMs, windowMs);
    if (result.blocked) {
      throw ApiError.rateLimited(Math.max(1, Math.ceil(result.blockRemainingMs / 1000)));
    }
  }
}
