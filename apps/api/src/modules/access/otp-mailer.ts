import type { OtpDelivery, OtpMailer } from "@symplist/core/access";
import {
  EmailError,
  type EmailTransport,
  emailIdempotencyKeys,
  renderOtpEmail,
  toEmailMessage,
} from "@symplist/email";
import type { OtpTestOutbox } from "./otp-test-outbox.ts";

/**
 * OTP email over the api's transport (§5.1): the security sender, a template per purpose, the
 * `otp/<purpose>/<challengeId>` provider idempotency key, and one immediate retry of a retryable
 * failure (safe because the provider deduplicates by that key). In `NODE_ENV=test` only, delivered
 * codes are also recorded in the test outbox for the end-to-end suite.
 */
export class ApiOtpMailer implements OtpMailer {
  constructor(
    private readonly transport: EmailTransport,
    private readonly outbox: OtpTestOutbox | null,
  ) {}

  async send(delivery: OtpDelivery): Promise<void> {
    const rendered = await renderOtpEmail({
      purpose: delivery.purpose,
      code: delivery.code,
      expiresInMinutes: delivery.expiresInMinutes,
    });
    const message = toEmailMessage(rendered, {
      to: delivery.email,
      idempotencyKey: emailIdempotencyKeys.otp(delivery.purpose, delivery.challengeId),
    });
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.transport.send(message);
        break;
      } catch (error) {
        if (attempt >= 2 || !(error instanceof EmailError) || !error.retryable) throw error;
      }
    }
    this.outbox?.record(delivery);
  }
}
