import { Body, Controller, HttpCode, Inject, Post } from "@nestjs/common";
import { emailAddressSchema, otpPurposeSchema } from "@symplist/contracts";
import { z } from "zod";
import { ApiError } from "../../common/errors/api-error.ts";
import { RouteClass } from "../../common/route-classes.ts";
import { API_CONFIG, type ApiConfig } from "../../infra/config/api-config.ts";
import { OTP_TEST_OUTBOX } from "./access.tokens.ts";
import type { OtpTestOutbox } from "./otp-test-outbox.ts";

const testOtpRequestSchema = z.strictObject({
  email: emailAddressSchema,
  purpose: otpPurposeSchema,
});

/**
 * TEST ONLY. `POST /v1/auth/test/otp` returns the latest code this process delivered to an address
 * for a purpose, so the end-to-end suite can sign in without a mailbox. It answers `not_found` unless
 * the validated configuration says `NODE_ENV=test`, and outside that the outbox does not even exist
 * (the providers bind null), so no other runtime ever retains or returns a code. The body is parsed
 * only after that check, so the route looks like any unknown path elsewhere.
 */
@Controller("auth/test")
export class TestOtpController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(OTP_TEST_OUTBOX) private readonly outbox: OtpTestOutbox | null,
  ) {}

  @Post("otp")
  @RouteClass("pre_session")
  @HttpCode(200)
  latest(@Body() body: unknown): { challengeId: string; code: string; purpose: string } {
    if (this.config.NODE_ENV !== "test" || this.outbox === null) throw ApiError.notFound();
    const parsed = testOtpRequestSchema.safeParse(body);
    if (!parsed.success) throw ApiError.notFound();
    const delivery = this.outbox.find(parsed.data.email, parsed.data.purpose);
    if (!delivery) throw ApiError.notFound();
    return { challengeId: delivery.challengeId, code: delivery.code, purpose: delivery.purpose };
  }
}
