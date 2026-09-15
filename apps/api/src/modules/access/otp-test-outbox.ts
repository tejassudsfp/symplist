import type { OtpPurpose } from "@symplist/contracts";
import type { OtpDelivery } from "@symplist/core/access";

/** Deliveries kept per address and purpose; older ones are dropped. */
const MAX_ENTRIES = 1_000;

/**
 * The OTP codes this api delivered, kept in memory for the end-to-end suite. It exists only when
 * `NODE_ENV=test` (the providers pass null otherwise), so no other runtime ever retains a code, and
 * `POST /v1/auth/test/otp` reads it under the same condition.
 */
export class OtpTestOutbox {
  private readonly latest = new Map<string, OtpDelivery>();

  record(delivery: OtpDelivery): void {
    const key = `${delivery.purpose}:${delivery.email}`;
    this.latest.delete(key);
    this.latest.set(key, delivery);
    while (this.latest.size > MAX_ENTRIES) {
      const oldest = this.latest.keys().next().value;
      if (oldest === undefined) break;
      this.latest.delete(oldest);
    }
  }

  /** The latest delivery to a normalized address for a purpose. */
  find(email: string, purpose: OtpPurpose): OtpDelivery | undefined {
    return this.latest.get(`${purpose}:${email}`);
  }
}
