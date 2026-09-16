import type { Provider } from "@nestjs/common";
import type { OtpPurpose } from "@symplist/contracts";
import { type OtpDelivery, type OtpMailer, OtpService } from "@symplist/core/access";
import type { KeyProvider } from "@symplist/crypto";
import type { DbClient } from "@symplist/db";
import {
  EmailError,
  type EmailTransport,
  emailIdempotencyKeys,
  renderOtpEmail,
  toEmailMessage,
} from "@symplist/email";
import { CLOCK, type Clock } from "../../common/clock.ts";
import { API_CONFIG, type ApiConfig } from "../config/api-config.ts";
import { KEY_PROVIDER } from "../crypto/crypto.providers.ts";
import { DB_CLIENT } from "../db/db.providers.ts";
import { EMAIL_TRANSPORT } from "./email.providers.ts";

export const OTP_SERVICE = "symplist:access:OTP_SERVICE";
export const OTP_TEST_OUTBOX = "symplist:access:OTP_TEST_OUTBOX";
/** Shared security-email transport; purpose/session authority remains in core OtpService. */
export class OtpTestOutbox {
  private readonly latest = new Map<string, OtpDelivery>();
  record(delivery: OtpDelivery) {
    const key = `${delivery.purpose}:${delivery.email}`;
    this.latest.delete(key);
    this.latest.set(key, delivery);
    while (this.latest.size > 1000) {
      const oldest = this.latest.keys().next().value;
      if (oldest === undefined) break;
      this.latest.delete(oldest);
    }
  }
  find(email: string, purpose: OtpPurpose) {
    return this.latest.get(`${purpose}:${email}`);
  }
}
export class ApiOtpMailer implements OtpMailer {
  constructor(
    private readonly transport: EmailTransport,
    private readonly outbox: OtpTestOutbox | null,
  ) {}
  async send(delivery: OtpDelivery) {
    const rendered = await renderOtpEmail({
      purpose: delivery.purpose,
      code: delivery.code,
      expiresInMinutes: delivery.expiresInMinutes,
    });
    const message = toEmailMessage(rendered, {
      to: delivery.email,
      idempotencyKey: emailIdempotencyKeys.otp(delivery.purpose, delivery.challengeId),
    });
    for (let attempt = 1; ; attempt++) {
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
export const otpProviders: Provider[] = [
  {
    provide: OTP_TEST_OUTBOX,
    inject: [API_CONFIG],
    useFactory: (config: ApiConfig) => (config.NODE_ENV === "test" ? new OtpTestOutbox() : null),
  },
  {
    provide: OTP_SERVICE,
    inject: [DB_CLIENT, KEY_PROVIDER, EMAIL_TRANSPORT, API_CONFIG, CLOCK, OTP_TEST_OUTBOX],
    useFactory: (
      db: DbClient,
      keys: KeyProvider,
      email: EmailTransport,
      config: ApiConfig,
      clock: Clock,
      outbox: OtpTestOutbox | null,
    ) =>
      new OtpService({
        db,
        keys,
        mailer: new ApiOtpMailer(email, outbox),
        now: () => clock.now(),
        codeLength: config.OTP_LENGTH,
        ttlMinutes: config.OTP_TTL_MINUTES,
        maxAttempts: config.OTP_MAX_ATTEMPTS,
      }),
  },
];
